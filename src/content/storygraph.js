// Runs on app.thestorygraph.com. Every StoryGraph request goes through here so it carries the
// user's session cookies and the page's CSRF token. The background worker sends one command at a
// time and awaits it, so requests are never parallel. See docs/RECON.md for the endpoints.
(() => {
  if (window.__bookshelfSyncLoaded) return;
  window.__bookshelfSyncLoaded = true;

  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

  function csrfToken() {
    const t = document.querySelector('meta[name="csrf-token"]')?.content;
    if (!t) throw new Error('No CSRF token on this page — reload the StoryGraph tab.');
    return t;
  }

  function assertSignedIn(res) {
    if (new URL(res.url).pathname.startsWith('/users/sign_in')) {
      throw new Error('Not signed in to StoryGraph in this Chrome profile.');
    }
  }

  async function getDoc(path) {
    const res = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
    assertSignedIn(res);
    if (!res.ok) throw new Error(`GET ${path.split('?')[0]} → ${res.status}`);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  async function post(path, fields, accept) {
    const body = new URLSearchParams();
    body.append('authenticity_token', csrfToken());
    for (const [k, v] of fields) body.append(k, v);
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      body,
      headers: { Accept: accept, 'X-CSRF-Token': csrfToken() },
    });
    assertSignedIn(res);
    if (!res.ok) throw new Error(`POST ${path.split('?')[0]} → ${res.status}`);
    return res;
  }

  function ping() {
    const signedIn = !!document.querySelector('form[action="/users/sign_out"]');
    const user = document.querySelector('a[href^="/to-read/"]')?.getAttribute('href')?.split('/')[2] ?? null;
    return { signedIn, user };
  }

  async function search(term) {
    const doc = await getDoc(`/search?search_term=${encodeURIComponent(term)}`);
    const seen = new Set();
    const out = [];
    for (const a of doc.querySelectorAll('a[id^="search_result_book_"]')) {
      const sgId = a.getAttribute('href')?.match(UUID)?.[0];
      if (!sgId || seen.has(sgId)) continue;
      seen.add(sgId);
      const li = a.closest('li');
      const title = a.querySelector('.list-option-text')?.textContent.trim() ?? '';
      const label = li?.querySelector('h1.sr-only')?.textContent.trim() ?? a.querySelector('img')?.alt ?? '';
      out.push({ sgId, title, label });
    }
    return out;
  }

  // Current state of a book on the user's lists. `shelved` is true when the book is on any list
  // (the "remove book" control only renders then) — the signal used to avoid duplicate writes.
  async function bookState(sgId) {
    const doc = await getDoc(`/books/${sgId}`);
    const text = doc.body.textContent.replace(/\s+/g, ' ');
    const isbn = text.match(/ISBN\/UID:\s*([0-9X-]{10,17})/i)?.[1]?.replace(/-/g, '') ?? null;
    const readInstanceIds = [...new Set(
      [...doc.querySelectorAll('a[href*="edit-read-instance-from-book"]')]
        .map(a => new URL(a.getAttribute('href'), location.origin).searchParams.get('read_instance_id'))
        .filter(Boolean),
    )];
    const reviewId = [...doc.querySelectorAll('a[href^="/reviews/"]')]
      .map(a => a.getAttribute('href').match(new RegExp(`^/reviews/(${UUID.source})$`))?.[1])
      .find(Boolean) ?? null;
    const shelved = !!doc.querySelector('[data-action*="remove-book#checkAndRemove"]') || readInstanceIds.length > 0;
    return { sgId, isbn, shelved, readInstanceIds, reviewId };
  }

  async function setStatus(sgId, status) {
    if (!['to-read', 'currently-reading', 'read'].includes(status)) throw new Error(`Bad status ${status}`);
    await post(`/update-status.js?book_id=${sgId}&status=${status}`, [], 'text/javascript, application/javascript');
  }

  // Edit the read instance StoryGraph auto-creates on status=read. Never POST /read_instances:
  // that creates a second read.
  async function setFinishDate(sgId, readInstanceId, isoDate) {
    const [y, m, d] = isoDate.split('-').map(n => String(Number(n)));
    await post(`/read_instances/${encodeURIComponent(readInstanceId)}`, [
      ['_method', 'patch'],
      ['read_instance[start_day]', ''], ['read_instance[start_month]', ''], ['read_instance[start_year]', ''],
      ['read_instance[day]', d], ['read_instance[month]', m], ['read_instance[year]', y],
      ['book_id', sgId], ['read_instance_id', readInstanceId], ['commit', 'Update'],
    ], 'text/vnd.turbo-stream.html, text/html');
  }

  async function createRating(sgId, stars) {
    const n = Math.round(Number(stars));
    if (!(n >= 1 && n <= 5)) throw new Error(`Bad rating ${stars}`);
    await post('/reviews', [
      ['stars_integer', String(n)], ['stars_decimal', ''],
      ['review[explanation]', ''], ['review[mood_ids][]', ''], ['review[pace]', ''],
      ['review[themes]', ''], ['review[content_warning_description]', ''],
      ['review[book_id]', sgId], ['return_to', `/books/${sgId}`],
    ], 'text/vnd.turbo-stream.html, text/html');
  }

  const handlers = { ping, search, bookState, setStatus, setFinishDate, createRating };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'storygraph') return false;
    const fn = handlers[msg.op];
    if (!fn) return false;
    Promise.resolve()
      .then(() => fn(...(msg.args || [])))
      .then(result => sendResponse({ ok: true, result }), err => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  });
})();
