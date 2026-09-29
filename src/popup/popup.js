const SG = 'https://app.thestorygraph.com';
const GR = 'https://www.goodreads.com';
const $ = id => document.getElementById(id);

async function call(op, args) {
  const res = await chrome.runtime.sendMessage({ target: 'background', op, args });
  if (!res?.ok) throw new Error(res?.error || 'No response');
  return res.result;
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter(k => k != null));
  return e;
}

function bookHead(item) {
  return el('div', {},
    el('a', { className: 't', href: `${GR}/book/show/${item.grId}`, target: '_blank', textContent: item.title }),
    el('div', { className: 'muted', textContent: `${item.author} · Goodreads ${item.shelf}${item.isbn ? ` · ISBN ${item.isbn}` : ''}` }));
}

async function act(op, args) {
  try { await call(op, args); } catch (e) { $('status').textContent = e.message; }
  await render();
}

function reviewCard(item, busy) {
  const card = el('div', { className: 'item' }, bookHead(item));
  for (const c of item.candidates || []) {
    card.append(el('div', { className: 'cand' },
      el('a', { href: `${SG}/books/${c.sgId}`, target: '_blank', textContent: `${c.title} — ${c.authors.join(', ')}` }),
      el('span', { className: 'muted', textContent: `${Math.round(c.score * 100)}%` }),
      el('button', { textContent: 'Approve', disabled: busy, onclick: () => act('approve', { grId: item.grId, sgId: c.sgId }) })));
  }
  if (!item.candidates?.length) card.append(el('div', { className: 'empty', textContent: 'No StoryGraph results.' }));
  const input = el('input', { type: 'text', placeholder: 'Or paste a StoryGraph book URL' });
  card.append(el('div', { className: 'row' }, input,
    el('button', {
      textContent: 'Use', disabled: busy, onclick: () => {
        const id = input.value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
        if (id) act('approve', { grId: item.grId, sgId: id }); else input.focus();
      },
    }),
    el('button', { textContent: 'Skip', disabled: busy, onclick: () => act('skip', { grId: item.grId }) })));
  return card;
}

function errorCard(item, busy) {
  return el('div', { className: 'item' }, bookHead(item),
    el('div', { style: 'color: var(--bad)', textContent: item.error }),
    el('div', { className: 'row' },
      el('button', { textContent: 'Retry', disabled: busy, onclick: () => act('retry', { grId: item.grId }) }),
      el('button', { textContent: 'Skip', disabled: busy, onclick: () => act('skip', { grId: item.grId }) })));
}

function fill(id, nodes, emptyText) {
  $(id).replaceChildren(...(nodes.length ? nodes : [el('div', { className: 'empty', textContent: emptyText })]));
}

async function render() {
  const o = await call('overview');
  for (const k of ['pending', 'synced', 'review', 'errors']) $(`c-${k}`).textContent = o.counts[k];
  $('mode').textContent = o.settings.dryRun ? 'DRY RUN' : 'LIVE';
  $('mode').className = `badge ${o.settings.dryRun ? 'dry' : 'live'}`;
  const last = o.status.lastRun ? ` · ${new Date(o.status.lastRun).toLocaleString()}` : '';
  $('status').textContent = o.running ? 'Syncing…' : `${o.status.message || 'Not run yet.'}${last}`;
  $('sync').disabled = o.running;

  fill('review', o.review.map(i => reviewCard(i, o.running)), 'Nothing to review.');
  fill('errors', o.errors.map(i => errorCard(i, o.running)), 'No errors.');
  $('dry-h').hidden = !o.dryRun.length;
  fill('dry', o.dryRun.map(i => el('div', { className: 'item' }, bookHead(i),
    el('div', {}, 'Would ', el('b', { textContent: i.plan }), ' on ',
      el('a', { href: `${SG}/books/${i.sgId}`, target: '_blank', textContent: 'this StoryGraph book' })))), '');
  $('log').replaceChildren(...o.log.map(l => el('li', {},
    el('span', { className: 'a', textContent: `${l.action} ` }),
    l.title ? `${l.title} — ` : '', el('span', { className: 'muted', textContent: l.detail }))));
}

$('sync').onclick = async () => { await act('syncNow'); };
$('options').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
chrome.storage.onChanged.addListener(() => render());
render();
