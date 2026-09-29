import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRss, parseRssDate, feedUrl, extractFeedKey, decodeEntities } from '../src/lib/rss.js';

const xml = readFileSync(new URL('./fixtures/read-feed.xml', import.meta.url), 'utf8');
const items = parseRss(xml, 'read');

test('parses every item and ignores channel-level tags', () => {
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(i => i.grId), ['54493401', '1885', '34']);
  assert.ok(items.every(i => i.shelf === 'read'));
});

test('extracts the fields sync depends on', () => {
  assert.deepEqual(items[0], {
    grId: '54493401',
    shelf: 'read',
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    isbn: '0593135202',
    rating: 5,
    readAt: '2026-09-25',
    addedAt: '2026-09-25',
    pages: 476,
  });
});

test('missing ISBN, rating, read date and page count become null / 0', () => {
  const p = items[1];
  assert.equal(p.isbn, null);
  assert.equal(p.rating, 0);
  assert.equal(p.readAt, null);
  assert.equal(p.pages, null);
});

test('decodes entities and CDATA titles', () => {
  assert.equal(items[1].title, 'Pride & Prejudice (Penguin Classics)');
  assert.equal(items[2].title, 'The Fellowship of the Ring (The Lord of the Rings, #1)');
  assert.equal(decodeEntities('&#39;&#x2019;&quot;&unknown;'), '\'’"&unknown;');
});

test('read dates use the UTC calendar day Goodreads stored', () => {
  assert.equal(items[2].readAt, '2025-12-31');
  assert.equal(parseRssDate('Wed, 31 Dec 2025 00:00:00 +0000'), '2025-12-31');
  assert.equal(parseRssDate(''), null);
  assert.equal(parseRssDate('not a date'), null);
});

test('empty feed parses to no items', () => {
  assert.deepEqual(parseRss('<rss><channel><title>x</title></channel></rss>', 'to-read'), []);
});

test('feedUrl builds public, keyed and paged URLs', () => {
  assert.equal(feedUrl({ userId: '1234567', shelf: 'read' }),
    'https://www.goodreads.com/review/list_rss/1234567?shelf=read');
  assert.equal(feedUrl({ userId: '1234567', shelf: 'to-read', page: 3, key: 'abc-DEF_123' }),
    'https://www.goodreads.com/review/list_rss/1234567?key=abc-DEF_123&shelf=to-read&page=3');
});

test('extractFeedKey finds the keyed RSS link on the owner shelf page', () => {
  const html = `<a class="inter" href="https://www.goodreads.com/review/list_rss/1234567?key=Zq9-kX_1&amp;shelf=read">RSS</a>`;
  assert.equal(extractFeedKey(html, '1234567'), 'Zq9-kX_1');
  const reordered = `<a href="/review/list_rss/1234567?shelf=read&amp;key=Zq9-kX_1">RSS</a>`;
  assert.equal(extractFeedKey(reordered, '1234567'), 'Zq9-kX_1');
  assert.equal(extractFeedKey(html, '7654321'), null, 'ignores other users’ feeds');
  assert.equal(extractFeedKey('<a href="/review/list_rss/1234567?shelf=read">RSS</a>', '1234567'), null);
});
