import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeIsbn, isbn10to13, sameIsbn, normalizeTitle, titleSimilarity, authorSimilarity,
  scoreCandidate, chooseMatch, authorsFromLabel, AUTO_THRESHOLD,
} from '../src/lib/match.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/storygraph-search.json', import.meta.url), 'utf8'));
const toCandidates = results => results.map(r => ({ sgId: r.sgId, title: r.title, authors: authorsFromLabel(r.label, r.title) }));

test('ISBN normalisation and 10→13 conversion', () => {
  assert.equal(normalizeIsbn('0-306-40615-2'), '0306406152');
  assert.equal(normalizeIsbn('080442957x'), '080442957X');
  assert.equal(normalizeIsbn('12345'), null);
  assert.equal(normalizeIsbn(''), null);
  assert.equal(isbn10to13('0306406152'), '9780306406157');
  assert.equal(isbn10to13('0593135202'), '9780593135204');
  assert.equal(isbn10to13('9780593135204'), '9780593135204');
  assert.ok(sameIsbn('0593135202', '9780593135204'));
  assert.ok(!sameIsbn('0593135202', '9780306406157'));
  assert.ok(!sameIsbn(null, null));
});

test('title normalisation drops series, subtitles and leading articles', () => {
  assert.deepEqual(normalizeTitle('The Fellowship of the Ring (The Lord of the Rings, #1)'),
    { full: 'fellowship of the ring', short: 'fellowship of the ring' });
  assert.deepEqual(normalizeTitle('Sapiens: A Brief History of Humankind'),
    { full: 'sapiens a brief history of humankind', short: 'sapiens' });
  assert.equal(titleSimilarity('Pride & Prejudice', 'Pride and Prejudice'), 1);
  assert.equal(titleSimilarity('Sapiens', 'Sapiens: A Brief History of Humankind'), 0.95);
});

test('author similarity tolerates initials and punctuation', () => {
  assert.ok(authorSimilarity('J.R.R. Tolkien', ['J. R. R. Tolkien']) >= 0.9);
  assert.ok(authorSimilarity('Andy Weir', ['Andrew Weir']) >= 0.9, 'same surname');
  assert.ok(authorSimilarity('Andy Weir', ['Zara Library']) < 0.3);
  assert.equal(authorSimilarity('', ['Andy Weir']), 0);
});

test('authorsFromLabel splits "Title by A, B" even when the title contains "by"', () => {
  assert.deepEqual(authorsFromLabel('The Elements of Style by William Strunk Jr., E.B. White', 'The Elements of Style'),
    ['William Strunk Jr.', 'E.B. White']);
  assert.deepEqual(authorsFromLabel('Summary: Project Hail Mary: by Andy Weir by Zara Library', 'Summary: Project Hail Mary: by Andy Weir'),
    ['Zara Library']);
  assert.deepEqual(authorsFromLabel('Good Omens by Terry Pratchett and Neil Gaiman', 'Good Omens'),
    ['Terry Pratchett', 'Neil Gaiman']);
});

test('real search results: the right book auto-matches over summaries and box sets', () => {
  const item = { title: 'Project Hail Mary', author: 'Andy Weir', isbn: null };
  const m = chooseMatch(item, toCandidates(fx.projectHailMary));
  assert.equal(m.decision, 'auto');
  assert.equal(m.best.sgId, 'ac3ea915-993d-4f30-8632-0f91e4ad0704');
  assert.ok(m.best.score >= AUTO_THRESHOLD);
  assert.ok(m.ranked[1].score < m.best.score - 0.05);
});

test('multiple authors and a Goodreads title with series suffix', () => {
  const item = { title: 'The Elements of Style (Classic Edition)', author: 'William Strunk Jr.', isbn: null };
  const m = chooseMatch(item, toCandidates(fx.elementsOfStyle));
  assert.equal(m.decision, 'auto');
});

test('an ISBN match wins outright', () => {
  const item = { title: 'Totally different title', author: 'Nobody', isbn: '0593135202' };
  const s = scoreCandidate(item, { sgId: 'x', title: 'Project Hail Mary', authors: ['Andy Weir'], isbn: '9780593135204' });
  assert.deepEqual(s, { score: 1, titleSim: 1, authorSim: 1, isbnMatch: true });
});

test('two near-identical candidates go to review instead of being guessed', () => {
  const item = { title: 'Dune', author: 'Frank Herbert', isbn: null };
  const m = chooseMatch(item, [
    { sgId: 'a', title: 'Dune', authors: ['Frank Herbert'] },
    { sgId: 'b', title: 'Dune', authors: ['Frank Herbert'] },
  ]);
  assert.equal(m.decision, 'review');
  assert.equal(m.ranked.length, 2);
});

test('a weak match goes to review; no results is "none"', () => {
  const item = { title: 'The Thorn-Marked Witch', author: 'Some Author', isbn: null };
  const m = chooseMatch(item, [{ sgId: 'a', title: 'The Witch of Thorns', authors: ['Other Person'] }]);
  assert.equal(m.decision, 'review');
  assert.ok(m.best.score < AUTO_THRESHOLD);
  assert.equal(chooseMatch(item, []).decision, 'none');
});

test('same title by a different author is not auto-matched', () => {
  const item = { title: 'Project Hail Mary', author: 'Someone Else', isbn: null };
  const m = chooseMatch(item, [{ sgId: 'a', title: 'Project Hail Mary', authors: ['Andy Weir'] }]);
  assert.equal(m.decision, 'review');
});
