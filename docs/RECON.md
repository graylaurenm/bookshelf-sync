# Phase 1 recon — 2026-09-28

Observed read-only in a logged-in Chrome profile (StoryGraph user `<sg-user>`,
Goodreads user `<gr-user-id>`). Every finding below comes from reading form definitions in the
logged-in HTML, then confirmed by one live write test (see "Live write test" below, which
supersedes the UNVERIFIED notes).

## StoryGraph (app.thestorygraph.com)

Rails + Hotwire (Turbo + Stimulus). Session is cookie-based.

### CSRF
- `<meta name="csrf-param" content="authenticity_token">`
- `<meta name="csrf-token" content="…">` — read from the live page; send as form field
  `authenticity_token` (and/or header `X-CSRF-Token`).

### Search
- `GET /search?search_term=<q>` → HTML (no login required).
- Result: `a#search_result_book_<uuid>[href="/books/<uuid>"]`, inside `li.book-list-item`, with
  `<h1 class="sr-only">Title by Author</h1>`.
- ISBN search works: `search_term=9780593135204` returned exactly one book.
- Book page `/books/<uuid>` shows `ISBN/UID: <isbn>` text — usable to confirm a match.

### Set status (to-read / currently-reading / read / DNF)
- `POST /update-status.js?book_id=<uuid>&status=<to-read|currently-reading|read|did-not-finish>`
- Body: `authenticity_token` only. Optional `&private=true` variant.
- Response is `.js` (Turbo/UJS JavaScript), not JSON. UNVERIFIED: response body, and whether
  `status=read` auto-creates a read instance dated today.

### Read dates (finish date)
- New: `GET /read_instances/new?book_id=<uuid>` renders the form →
  `POST /read_instances` with fields
  `new_read_instance[start_day|start_month|start_year]`,
  `new_read_instance[day|month|year]` (finish), `book_id`, `authenticity_token`.
  Day `1–31`, month `1–12` (numeric), year e.g. `2026`; blank allowed.
- Edit: `/edit-read-instance-from-book?book_id=<uuid>&read_instance_id=<id>` (form is loaded
  in a Turbo frame; fields not yet captured).
- UNVERIFIED: whether marking `read` + posting a read instance creates **two** read instances
  (the duplication risk). Safer order to test: status=read, then edit the auto-created instance.

### Rating
- Existing review: `GET /reviews/<uuid>/edit` → `PATCH /reviews/<uuid>` (`_method=patch`) with
  `stars_integer` (`0–5`) and `stars_decimal` (`''|25|5|75` = .25/.5/.75), plus many optional
  review fields (pace, moods, content warnings…) that must be preserved/left blank.
- `/reviews/new?book_id=` for an unread book shows no review form → a rating likely requires
  the book to be marked read first. UNVERIFIED: how the review record is created for a newly
  read book (possibly on the status=read response).

### Detecting current shelf state
- Book page status button label reflects state (`read`, `to read`, `currently reading`).
  Read books also show `/reviews/<uuid>` and `edit-read-instance-from-book` links.
- Shelf pages: `/books-read/<sg-user>`, `/to-read/<user>`, `/currently-reading/<user>`.

## Goodreads RSS

`GET https://www.goodreads.com/review/list_rss/<userId>?shelf=<shelf>&page=<n>` — public, no
cookies needed. 100 items per page; empty page ends pagination.

Per-item fields:

| Field | Notes |
|---|---|
| `book_id` | Goodreads book ID (stable key for the mapping) |
| `title`, `author_name` | For fuzzy match |
| `isbn` | ISBN-10 only; **no `isbn13`**. Present on ~65–80% of items |
| `user_rating` | `0` = unrated, else 1–5 (integers only) |
| `user_read_at` | Finish date (RFC 822), blank on some read items (~10–30%) |
| `user_date_added`, `user_date_created` | Shelf/add dates |
| `user_shelves` | Custom shelves; blank for `read` |
| `book > num_pages` | Page count |
| `guid`/`link` | Review URL (contains review ID) |
| `pubDate`, `average_rating`, `book_published`, images, descriptions | Informational |

No start-date field is exposed. A large read shelf spans several pages;
budget the first sync accordingly.

## Live write test — 2026-09-28 (resolved)

Test book: *The Elements of Style* (`182b572c-…`), marked with `private=true`, then removed.

1. `POST /update-status.js?book_id=<uuid>&status=read&private=true` (body: `authenticity_token`)
   → 200 `text/javascript` (~100 KB of UJS). **Auto-creates exactly one read instance with no
   dates.** A "new review" link (`/reviews/new?book_id=&return_to=`) appears.
2. Finish date: **edit the auto-created instance**, never POST a new one.
   - Find `read_instance_id` (integer) in `a[href*="edit-read-instance-from-book"]` on the book page.
   - `POST /read_instances/<id>` with `_method=patch`, `read_instance[start_day|start_month|start_year]`,
     `read_instance[day|month|year]` (finish; numeric, blanks allowed), `book_id`,
     `read_instance_id`, `commit=Update`, `authenticity_token`.
   - → 200 `text/vnd.turbo-stream.html` (`update` → `reading-summary`). Book page shows
     "Finished Sep 25, 2026"; read-instance count stays 1.
3. Rating on a book with no review: `POST /reviews` with `stars_integer`, `stars_decimal` (`''`),
   `review[book_id]`, `return_to=/books/<uuid>`, blank `review[explanation]`, `review[mood_ids][]`,
   `review[pace]`, `review[themes]`, `review[content_warning_description]`, `authenticity_token`
   → 302 to `/books/<uuid>`. Stored `stars_integer=4` verified via `/reviews/<uuid>/edit`.
   Afterwards `/reviews/new?book_id=` redirects, so a second review can't be created that way.
   Existing review: `PATCH /reviews/<uuid>` (same star fields).
4. Removal (cleanup only; the extension never removes): the page's `remove-book` Stimulus
   controller calls `/remove-book/<uuid>` after an in-page confirm modal. Removes the status,
   the read instance and the review.

### Duplicate-safety rules derived
- Before any write, fetch `/books/<uuid>` and read state: if an `edit-read-instance-from-book`
  link or a status other than none exists, treat as already shelved → skip (map it, don't write).
- For `read`: status → then PATCH the single auto instance → then rating. Never `POST /read_instances`.

## Goodreads RSS without a public profile

The owner's shelf page (`/review/list/<id>?shelf=read`, logged in) contains an RSS link
`/review/list_rss/<id>?key=<secret>&shelf=<shelf>`. The keyed URL returned all items with
**no cookies**. This is Goodreads' feed mechanism for private profiles, so the extension can scrape
the key once from the logged-in shelf page (or accept it pasted in Options) and never require a
public profile. Not tested against an actually-private profile (would require changing account
privacy).
