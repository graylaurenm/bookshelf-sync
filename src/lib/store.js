// chrome.storage.local schema:
//   settings: see DEFAULT_SETTINGS
//   map:      { [goodreadsBookId]: { sgId, shelf, how, at } }   — never re-written once present
//   items:    { [goodreadsBookId]: Item }                        — work not yet mapped
//   log:      [{ at, grId, title, action, detail }]              — newest first, capped
//   status:   { lastRun, message, running }

export const DEFAULT_SETTINGS = {
  grUserId: '',
  feedKey: '',
  shelves: { read: true, 'currently-reading': true, 'to-read': true },
  intervalMinutes: 60,
  dryRun: true,
};

export const MIN_INTERVAL = 15;
export const MAX_INTERVAL = 1440;
const LOG_CAP = 500;

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings, shelves: { ...DEFAULT_SETTINGS.shelves, ...settings?.shelves } };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  next.intervalMinutes = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Number(next.intervalMinutes) || 60));
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getState() {
  const { map = {}, items = {}, log = [], status = {} } = await chrome.storage.local.get(['map', 'items', 'log', 'status']);
  return { map, items, log, status };
}

export async function putState(partial) {
  if (partial.log) partial.log = partial.log.slice(0, LOG_CAP);
  await chrome.storage.local.set(partial);
}

export function logEntry(log, item, action, detail = '') {
  log.unshift({ at: new Date().toISOString(), grId: item?.grId ?? null, title: item?.title ?? '', action, detail });
}
