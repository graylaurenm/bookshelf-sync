import { SHELVES, parseRss, feedUrl, extractFeedKey } from './lib/rss.js';
import { chooseMatch, authorsFromLabel, isbn10to13, normalizeIsbn, sameIsbn } from './lib/match.js';
import { planSteps, describePlan } from './lib/plan.js';
import { getSettings, saveSettings, getState, putState, logEntry } from './lib/store.js';

const ALARM = 'poll';
const SG_ORIGIN = 'https://app.thestorygraph.com';
const MAX_ITEMS_PER_RUN = 40;   // keeps each run short and polite; the rest waits for the next run
const MAX_FEED_PAGES = 30;      // 100 items/page
const SG_GAP_MS = 1200;         // minimum spacing between StoryGraph requests

// Item states: pending → (matched) → dry-run | synced(mapped) ; review ; error ; skipped

// ---------- scheduling ----------

async function schedule() {
  const { intervalMinutes } = await getSettings();
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.create(ALARM, { periodInMinutes: intervalMinutes, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await schedule();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) runSync({ openTab: false }); });

// ---------- StoryGraph tab bridge ----------

let lastSgCall = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findSgTab(open) {
  const [tab] = await chrome.tabs.query({ url: `${SG_ORIGIN}/*` });
  if (tab || !open) return tab ?? null;
  const created = await chrome.tabs.create({ url: `${SG_ORIGIN}/`, active: false });
  for (let i = 0; i < 40; i++) {
    const t = await chrome.tabs.get(created.id);
    if (t.status === 'complete') return t;
    await sleep(250);
  }
  return created;
}

async function sg(tabId, op, ...args) {
  const wait = lastSgCall + SG_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const msg = { target: 'storygraph', op, args };
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // Tab was open before the extension loaded: inject the content script, then retry once.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/storygraph.js'] });
    res = await chrome.tabs.sendMessage(tabId, msg);
  } finally {
    lastSgCall = Date.now();
  }
  if (!res?.ok) throw new Error(res?.error || 'No response from StoryGraph tab');
  return res.result;
}

class FatalRunError extends Error {}

// ---------- Goodreads ----------

async function detectFeedKey(userId) {
  const res = await fetch(`https://www.goodreads.com/review/list/${encodeURIComponent(userId)}?shelf=read`, { credentials: 'include' });
  if (!res.ok) return null;
  return extractFeedKey(await res.text(), userId);
}

async function fetchShelf(settings, shelf) {
  const all = [];
  for (let page = 1; page <= MAX_FEED_PAGES; page++) {
    const res = await fetch(feedUrl({ userId: settings.grUserId, shelf, page, key: settings.feedKey }), { credentials: 'omit' });
    if (!res.ok) throw new Error(`Goodreads ${shelf} feed → ${res.status}`);
    const items = parseRss(await res.text(), shelf);
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

function ingest(feedItems, map, items) {
  let added = 0;
  for (const f of feedItems) {
    if (map[f.grId]) continue;                 // already synced: never touch again
    const existing = items[f.grId];
    if (!existing) {
      items[f.grId] = { ...f, state: 'pending', updatedAt: Date.now() };
      added++;
    } else {
      // Keep match/review state; refresh Goodreads data (shelf may have moved, rating added…).
      Object.assign(existing, f);
    }
  }
  return added;
}

// ---------- matching ----------

async function match(tabId, item) {
  const isbn = normalizeIsbn(item.isbn);
  if (isbn) {
    for (const term of [...new Set([isbn10to13(isbn), isbn])]) {
      const results = await sg(tabId, 'search', term);
      if (results.length) {
        const state = await sg(tabId, 'bookState', results[0].sgId);
        if (state.isbn && sameIsbn(state.isbn, isbn)) {
          return { decision: 'auto', sgId: results[0].sgId, confidence: 1, how: 'isbn', state };
        }
      }
    }
  }
  const author = (item.author || '').split(',')[0];
  const cleanTitle = item.title.replace(/\s*\([^)]*\)\s*$/, '');
  const results = await sg(tabId, 'search', `${cleanTitle} ${author}`.trim());
  const candidates = results.slice(0, 6).map(r => ({ sgId: r.sgId, title: r.title, authors: authorsFromLabel(r.label, r.title) }));
  const m = chooseMatch(item, candidates);
  return {
    decision: m.decision,
    sgId: m.decision === 'auto' ? m.best.sgId : null,
    confidence: m.best?.score ?? 0,
    how: 'title-author',
    candidates: m.ranked.slice(0, 5).map(c => ({ sgId: c.sgId, title: c.title, authors: c.authors, score: c.score })),
  };
}

// ---------- writing ----------

async function writeItem(tabId, item, map, log) {
  const before = await sg(tabId, 'bookState', item.sgId);
  if (before.shelved) {
    map[item.grId] = { sgId: item.sgId, shelf: item.shelf, how: 'already-on-storygraph', at: new Date().toISOString() };
    logEntry(log, item, 'skipped', 'already on your StoryGraph lists — mapped, nothing written');
    return;
  }
  const steps = planSteps(item);
  await sg(tabId, 'setStatus', item.sgId, steps[0].status);
  // Map immediately: from here on, a retry must never re-mark this book.
  map[item.grId] = { sgId: item.sgId, shelf: item.shelf, how: item.how || 'auto', at: new Date().toISOString() };
  const done = [`marked ${steps[0].status}`];
  const problems = [];
  if (steps.length > 1) {
    const after = await sg(tabId, 'bookState', item.sgId);
    for (const s of steps.slice(1)) {
      try {
        if (s.op === 'setFinishDate') {
          if (after.readInstanceIds.length !== 1) { problems.push(`expected 1 read instance, found ${after.readInstanceIds.length}; date not set`); continue; }
          await sg(tabId, 'setFinishDate', item.sgId, after.readInstanceIds[0], s.date);
          done.push(`finished ${s.date}`);
        } else if (s.op === 'createRating') {
          if (after.reviewId) { problems.push('a review already exists; rating not changed'); continue; }
          await sg(tabId, 'createRating', item.sgId, s.stars);
          done.push(`${s.stars}★`);
        }
      } catch (e) {
        problems.push(`${s.op} failed: ${e.message}`);
      }
    }
  }
  logEntry(log, item, problems.length ? 'partial' : 'synced', [...done, ...problems].join('; '));
}

// ---------- the run ----------

let running = null;

export function runSync(opts) {
  if (!running) running = doRun(opts).finally(() => { running = null; });
  return running;
}

async function setStatus(message, extra = {}) {
  await putState({ status: { message, at: new Date().toISOString(), ...extra } });
}

async function doRun({ openTab }) {
  const settings = await getSettings();
  const { map, items, log } = await getState();
  await setStatus('Running…', { running: true });
  try {
    if (!settings.grUserId) throw new FatalRunError('Set your Goodreads user ID in Options.');

    if (!settings.feedKey) {
      const key = await detectFeedKey(settings.grUserId).catch(() => null);
      if (key) { settings.feedKey = key; await saveSettings({ feedKey: key }); }
    }

    let added = 0, fetched = 0;
    for (const shelf of SHELVES.filter(s => settings.shelves[s])) {
      const feed = await fetchShelf(settings, shelf);
      fetched += feed.length;
      added += ingest(feed, map, items);
    }
    if (fetched === 0 && !settings.feedKey) {
      throw new FatalRunError('Goodreads feeds came back empty. Sign in to Goodreads in this Chrome profile, or paste your feed key in Options.');
    }
    await putState({ items });

    const todo = Object.values(items)
      .filter(i => i.state === 'pending' || (i.state === 'dry-run' && !settings.dryRun))
      .sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''))
      .slice(0, MAX_ITEMS_PER_RUN);

    if (!todo.length) {
      await setStatus(`Up to date. ${fetched} feed items checked, ${added} new.`, { running: false, lastRun: new Date().toISOString() });
      return;
    }

    const tab = await findSgTab(openTab);
    if (!tab) throw new FatalRunError(`${todo.length}+ books waiting. Open an app.thestorygraph.com tab or press “Sync now”.`);
    const who = await sg(tab.id, 'ping');
    if (!who.signedIn) throw new FatalRunError('Not signed in to StoryGraph in this Chrome profile.');

    let processed = 0;
    for (const item of todo) {
      try {
        if (!item.sgId) {
          const m = await match(tab.id, item);
          item.confidence = m.confidence;
          item.how = m.how;
          if (m.decision !== 'auto') {
            item.state = 'review';
            item.candidates = m.candidates;
            logEntry(log, item, 'needs-review', m.candidates?.length ? `best ${Math.round(m.confidence * 100)}%` : 'no StoryGraph results');
            continue;
          }
          item.sgId = m.sgId;
        }
        if (settings.dryRun) {
          // Reads are fine in dry-run; a book already on StoryGraph can be mapped without writing.
          const st = await sg(tab.id, 'bookState', item.sgId);
          if (st.shelved) {
            map[item.grId] = { sgId: item.sgId, shelf: item.shelf, how: 'already-on-storygraph', at: new Date().toISOString() };
            delete items[item.grId];
            logEntry(log, item, 'skipped', 'already on your StoryGraph lists — mapped, nothing written');
          } else {
            item.state = 'dry-run';
            item.plan = describePlan(item);
            logEntry(log, item, 'dry-run', `would ${item.plan}`);
          }
        } else {
          await writeItem(tab.id, item, map, log);
          delete items[item.grId];
        }
      } catch (e) {
        if (/Not signed in/.test(e.message)) throw new FatalRunError(e.message);
        if (map[item.grId]) {
          // Status was written before the failure: the book is mapped and must not be retried.
          delete items[item.grId];
          logEntry(log, item, 'partial', `status written, then: ${e.message}`);
          continue;
        }
        item.state = 'error';
        item.error = e.message;
        logEntry(log, item, 'error', e.message);
      } finally {
        item.updatedAt = Date.now();
        processed++;
        await putState({ map, items, log });   // persist after every book
      }
    }
    const left = Object.values(items).filter(i => i.state === 'pending').length;
    await setStatus(`Processed ${processed}${settings.dryRun ? ' (dry run)' : ''}. ${left} still pending.`, { running: false, lastRun: new Date().toISOString() });
  } catch (e) {
    await putState({ map, items, log });
    await setStatus(e instanceof FatalRunError ? e.message : `Error: ${e.message}`, { running: false, lastRun: new Date().toISOString(), failed: true });
  }
}

// ---------- popup / options API ----------

function assertIdle() {
  if (running) throw new Error('A sync is running — try again when it finishes.');
}

const api = {
  async overview() {
    const settings = await getSettings();
    const { map, items, log, status } = await getState();
    const list = Object.values(items);
    const by = s => list.filter(i => i.state === s);
    return {
      settings,
      status,
      counts: {
        pending: by('pending').length + by('dry-run').length,
        synced: Object.keys(map).length,
        review: by('review').length,
        errors: by('error').length,
      },
      review: by('review'),
      errors: by('error'),
      dryRun: by('dry-run').slice(0, 50).map(i => ({ ...i, plan: describePlan(i) })),
      log: log.slice(0, 30),
      running: !!running,
    };
  },
  async syncNow() { runSync({ openTab: true }); return true; },
  async approve({ grId, sgId }) {
    assertIdle();
    const { items, log } = await getState();
    const item = items[grId];
    if (!item || !/^[0-9a-f-]{36}$/.test(sgId)) throw new Error('Unknown item or bad StoryGraph ID');
    Object.assign(item, { sgId, how: 'manual', confidence: 1, state: 'pending', candidates: undefined, error: undefined });
    logEntry(log, item, 'approved', sgId);
    await putState({ items, log });
    return true;
  },
  async skip({ grId }) {
    assertIdle();
    const { items, log } = await getState();
    if (!items[grId]) return false;
    items[grId].state = 'skipped';
    logEntry(log, items[grId], 'skipped', 'by you');
    await putState({ items, log });
    return true;
  },
  async retry({ grId }) {
    assertIdle();
    const { items } = await getState();
    if (!items[grId]) return false;
    Object.assign(items[grId], { state: 'pending', error: undefined });
    await putState({ items });
    return true;
  },
  async detectKey({ userId }) { return detectFeedKey(userId); },
  async settingsChanged() { await schedule(); return true; },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background' || !api[msg.op]) return false;
  api[msg.op](msg.args || {}).then(
    result => sendResponse({ ok: true, result }),
    err => sendResponse({ ok: false, error: String(err?.message || err) }),
  );
  return true;
});
