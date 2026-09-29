# Bookshelf Sync

A Chrome extension (Manifest V3) that copies your Goodreads shelves to [StoryGraph](https://app.thestorygraph.com).

Neither site has a public API. The extension reads Goodreads' shelf RSS feeds and writes to StoryGraph from a
content script on an `app.thestorygraph.com` tab, using the session you're already signed in with. It never
asks for or stores a password.

> **Unofficial.** This drives StoryGraph's own web forms (documented in [docs/RECON.md](docs/RECON.md)). If
> StoryGraph changes its pages, syncing will stop working (it fails with an error; it doesn't guess).

## What it syncs

| Goodreads shelf | StoryGraph result |
|---|---|
| `read` | Marked read, with the Goodreads finish date and star rating (when present) |
| `currently-reading` | Marked currently reading |
| `to-read` | Marked to read |

Each book is written **once**. After that it's recorded in a Goodreads → StoryGraph map and never touched
again. StoryGraph creates a duplicate read every time a book is re-marked, so this is deliberate.

## Install (unpacked)

1. Clone or download this repo.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the repo folder (the one containing `manifest.json`).
4. Pin **Bookshelf Sync** from the puzzle-piece menu so the popup is one click away.

Use the Chrome profile where you're signed in to StoryGraph (and ideally Goodreads).

## First-run setup

The Options page opens on install (or right-click the icon → **Options**).

1. **Goodreads user ID**: the number in your profile URL, `goodreads.com/user/show/<ID>-name`. Pasting the
   whole URL works too.
2. **Feed key** (optional): click **Detect** while signed in to Goodreads in the same profile. The key lets
   the extension read your shelves even if your Goodreads profile is private. It's stored only in this browser.
   If you leave it empty, the extension tries to detect it on each sync and otherwise uses the public feed.
3. **Shelves to sync**: all three are on by default.
4. **Check every**: 60 minutes by default (15–1440). Checks only run while Chrome is open; a missed check runs
   soon after Chrome starts.
5. **Dry run**: on by default. Leave it on for now.

Click **Save**.

## How a sync works

1. The worker fetches your selected shelves' RSS (100 books per page) and queues any book not already mapped.
2. It needs a StoryGraph tab. Scheduled checks use an open `app.thestorygraph.com` tab if there is one. **Sync
   now** opens a background tab if needed.
3. Up to 40 queued books are handled per run, **one request at a time** with a short pause between requests.
   A big first import takes several runs; press **Sync now** to go faster.
4. For each book:
   - **Match.** Search StoryGraph by ISBN and confirm it against the book page's ISBN. If there's no ISBN
     match, search by title and author and score each result. Only a clear winner scoring ≥ 90% is accepted
     automatically. Anything else goes to **Needs review**.
   - **Check.** Load the StoryGraph book page. If the book is already on any of your StoryGraph lists, it's
     mapped and **nothing is written**.
   - **Write** (only with dry run off). Set the status. Map the book immediately. For read books, edit the read
     entry StoryGraph just created to add the finish date, then add the rating.

## The popup

- **Pending**: queued or planned (in dry run, books that *would* be written).
- **Synced**: books in the map (written, or already on StoryGraph).
- **Needs review**: low-confidence or no-result matches. For each book you can:
  - **Approve** one of the listed candidates (each links to its StoryGraph page so you can check it).
  - Paste a StoryGraph book URL and press **Use**.
  - **Skip** the book.
- **Errors**: failed books, with **Retry** / **Skip**.
- **Dry run — would write**: exactly what each planned book would get, e.g. `mark read, finished 2026-09-25, 4★`.
- **Recent activity**: the sync log.

Approve, skip and retry are disabled while a sync is running.

## Testing safely

Work through these in order. Nothing is written to StoryGraph until step 5.

1. **Dry run first.** With dry run on, press **Sync now**. Books you've already got on StoryGraph show up as
   *Synced* ("already on your StoryGraph lists — mapped, nothing written"). Everything else lands in
   *Dry run — would write* or *Needs review*.
2. **Check the plans.** Open a few "would write" books via their StoryGraph links and confirm the match, date
   and rating are right.
3. **Clear the review queue.** Approve or skip each one. Approved books move back to pending and get planned
   on the next run.
4. **Start small.** In Options, untick every shelf except one short one (for example `currently-reading`).
5. **Go live briefly.** Turn dry run off (you'll be asked to confirm), press **Sync now**, then turn dry run
   back on. Check those books on StoryGraph: status, one read entry with the right finish date, rating.
6. When you're happy, enable the other shelves and leave dry run off.

To start over, remove and reinstall the extension. That clears the map, queue and log. StoryGraph itself isn't
changed by uninstalling.

## Limitations

- **One-way, one-time.** A book moved on Goodreads after it has synced (e.g. currently-reading → read) is
  *not* updated on StoryGraph, because re-marking creates duplicates. Update those on StoryGraph by hand.
- **Ratings are whole stars.** Goodreads has no quarter stars.
- **No start dates or reviews.** The Goodreads feed doesn't include start dates, and review text isn't copied.
- **Chrome must be open**, signed in to StoryGraph, with a StoryGraph tab available for scheduled runs.
- About a third of Goodreads books have no ISBN in the feed, so expect some title/author reviews.

## Privacy

All data stays in `chrome.storage.local` in your browser. The extension only talks to `www.goodreads.com`
(to read your feeds) and `app.thestorygraph.com` (to search and write, as you). No analytics, no other hosts.

## Development

No build step and no dependencies. Tests use Node's built-in runner (Node 20+):

```bash
npm test
```

- `src/lib/rss.js`: Goodreads RSS parsing and feed URLs (no DOM; runs in the service worker)
- `src/lib/match.js`: ISBN handling and title/author scoring
- `src/lib/plan.js`: which StoryGraph steps a book needs
- `src/background.js`: alarm, queue, matching and write orchestration
- `src/content/storygraph.js`: every StoryGraph request (search, book state, writes)
- `src/popup/`, `src/options/`: UI
- `tests/`: unit tests with fixtures in `tests/fixtures/`
- `docs/RECON.md`: how the StoryGraph endpoints were worked out
