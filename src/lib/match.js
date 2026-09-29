// Matching Goodreads items to StoryGraph search results.

export const AUTO_THRESHOLD = 0.9;
const MIN_MARGIN = 0.05;

export function normalizeIsbn(s) {
  if (!s) return null;
  const v = String(s).toUpperCase().replace(/[^0-9X]/g, '');
  if (/^\d{9}[\dX]$/.test(v) || /^\d{13}$/.test(v)) return v;
  return null;
}

export function isbn10to13(isbn10) {
  const v = normalizeIsbn(isbn10);
  if (!v || v.length !== 10) return v;
  const core = '978' + v.slice(0, 9);
  const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  return core + ((10 - (sum % 10)) % 10);
}

export function sameIsbn(a, b) {
  const x = isbn10to13(a), y = isbn10to13(b);
  return !!x && x === y;
}

function fold(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Freedom and Fire (Elemental Viria #2)" -> { full: "freedom and fire", short: "freedom and fire" }
// "Sapiens: A Brief History of Humankind" -> { full: "sapiens a brief history of humankind", short: "sapiens" }
export function normalizeTitle(t) {
  const noSeries = String(t || '').replace(/\s*\([^)]*\)\s*$/, '');
  const strip = s => fold(s).replace(/^(the|a|an) /, '');
  return { full: strip(noSeries), short: strip(noSeries.split(/[:—–]| - /)[0]) };
}

export function normalizeAuthor(a) {
  return fold(String(a || '').replace(/\./g, ' '));
}

function bigrams(s) {
  const v = s.replace(/ /g, '');
  const out = new Map();
  for (let i = 0; i < v.length - 1; i++) {
    const g = v.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

// Sørensen–Dice coefficient on character bigrams: 1 = identical, 0 = nothing shared.
export function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, total = 0;
  for (const n of A.values()) total += n;
  for (const n of B.values()) total += n;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
  return total ? (2 * inter) / total : 0;
}

export function titleSimilarity(a, b) {
  const x = normalizeTitle(a), y = normalizeTitle(b);
  return Math.max(dice(x.full, y.full), dice(x.short, y.short) * 0.95);
}

export function authorSimilarity(grAuthor, sgAuthors) {
  const g = normalizeAuthor(grAuthor);
  if (!g) return 0;
  const gLast = g.split(' ').pop();
  let best = 0;
  for (const raw of sgAuthors || []) {
    const s = normalizeAuthor(raw);
    if (!s) continue;
    let sim = dice(g, s);
    if (s.split(' ').pop() === gLast) sim = Math.max(sim, 0.9);
    best = Math.max(best, sim);
  }
  return best;
}

// candidate: { sgId, title, authors: string[], isbn? }
export function scoreCandidate(item, cand) {
  if (item.isbn && cand.isbn && sameIsbn(item.isbn, cand.isbn)) {
    return { score: 1, titleSim: 1, authorSim: 1, isbnMatch: true };
  }
  const titleSim = titleSimilarity(item.title, cand.title);
  const authorSim = authorSimilarity(item.author, cand.authors);
  const score = Math.round((0.6 * titleSim + 0.4 * authorSim) * 1000) / 1000;
  return { score, titleSim, authorSim, isbnMatch: false };
}

// Returns { decision: 'auto' | 'review' | 'none', best, ranked }.
// 'auto' only when the best candidate clears the threshold AND clearly beats the runner-up,
// so two near-identical editions go to review instead of being guessed.
export function chooseMatch(item, candidates, threshold = AUTO_THRESHOLD) {
  const ranked = (candidates || [])
    .map(c => ({ ...c, ...scoreCandidate(item, c) }))
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return { decision: 'none', best: null, ranked };
  const [best, second] = ranked;
  if (best.isbnMatch) return { decision: 'auto', best, ranked };
  const clear = !second || best.score - second.score >= MIN_MARGIN || second.sgId === best.sgId;
  return { decision: best.score >= threshold && clear ? 'auto' : 'review', best, ranked };
}

// StoryGraph search results carry an accessible label "Title by Author A, Author B".
export function authorsFromLabel(label, title) {
  let rest = label;
  if (title && label.startsWith(title + ' by ')) rest = label.slice(title.length + 4);
  else {
    const i = label.lastIndexOf(' by ');
    rest = i >= 0 ? label.slice(i + 4) : '';
  }
  return rest.split(/,\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean);
}
