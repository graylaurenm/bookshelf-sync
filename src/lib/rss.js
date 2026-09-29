// Goodreads shelf RSS parsing. MV3 service workers have no DOMParser, so this is a small,
// dependency-free parser for the flat, well-known shape of Goodreads' list_rss feed.

export const SHELVES = ['read', 'currently-reading', 'to-read'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>|<${tag}(?:\\s[^>]*)?/>`));
  if (!m || m[1] === undefined) return '';
  let v = m[1];
  const cdata = v.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  v = cdata ? cdata[1] : decodeEntities(v);
  return v.trim();
}

// "Fri, 25 Sep 2026 00:00:00 +0000" -> "2026-09-25". Goodreads stores read dates as
// midnight UTC, so the UTC calendar date is the one the user picked.
export function parseRssDate(s) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function parseRss(xml, shelf) {
  const items = [];
  for (const [, body] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const grId = tagText(body, 'book_id');
    if (!grId) continue;
    const rating = parseInt(tagText(body, 'user_rating'), 10);
    const bookBlock = body.match(/<book[\s>][\s\S]*?<\/book>/)?.[0] ?? '';
    const pages = parseInt(tagText(bookBlock, 'num_pages'), 10);
    items.push({
      grId,
      shelf,
      title: tagText(body, 'title'),
      author: tagText(body, 'author_name'),
      isbn: tagText(body, 'isbn') || null,
      rating: Number.isFinite(rating) && rating > 0 ? rating : 0,
      readAt: parseRssDate(tagText(body, 'user_read_at')),
      addedAt: parseRssDate(tagText(body, 'user_date_added')),
      pages: Number.isFinite(pages) ? pages : null,
    });
  }
  return items;
}

export function feedUrl({ userId, shelf, page = 1, key }) {
  const u = new URL(`https://www.goodreads.com/review/list_rss/${encodeURIComponent(userId)}`);
  if (key) u.searchParams.set('key', key);
  u.searchParams.set('shelf', shelf);
  if (page > 1) u.searchParams.set('page', String(page));
  return u.toString();
}

// The owner's (logged-in) shelf page links to a keyed RSS URL that works for private profiles.
export function extractFeedKey(html, userId) {
  const re = new RegExp(`list_rss/${userId}\\?(?:[^"'\\s>]*?&(?:amp;)?)?key=([^&"'\\s>]+)`);
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}
