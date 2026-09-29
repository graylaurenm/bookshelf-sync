import { getSettings, saveSettings } from '../lib/store.js';

const $ = id => document.getElementById(id);
const shelfBoxes = [...document.querySelectorAll('[data-shelf]')];

async function call(op, args) {
  const res = await chrome.runtime.sendMessage({ target: 'background', op, args });
  if (!res?.ok) throw new Error(res?.error || 'No response');
  return res.result;
}

async function load() {
  const s = await getSettings();
  $('grUserId').value = s.grUserId;
  $('feedKey').value = s.feedKey;
  $('interval').value = s.intervalMinutes;
  $('dryRun').checked = s.dryRun;
  for (const b of shelfBoxes) b.checked = !!s.shelves[b.dataset.shelf];
}

function userIdFromInput() {
  // Accept a bare ID or a pasted profile URL.
  return $('grUserId').value.trim().match(/(\d{3,})/)?.[1] ?? '';
}

$('detect').onclick = async () => {
  $('err').textContent = '';
  const id = userIdFromInput();
  if (!id) { $('err').textContent = 'Enter your Goodreads user ID first.'; return; }
  const key = await call('detectKey', { userId: id }).catch(() => null);
  if (key) $('feedKey').value = key;
  else $('err').textContent = 'No key found — sign in to Goodreads in this Chrome profile, then try again.';
};

$('save').onclick = async () => {
  $('err').textContent = '';
  const s = await getSettings();
  const turningLive = s.dryRun && !$('dryRun').checked;
  if (turningLive && !confirm('Turn off dry run? The next sync will write to your StoryGraph account.')) return;
  await saveSettings({
    grUserId: userIdFromInput(),
    feedKey: $('feedKey').value.trim(),
    intervalMinutes: Number($('interval').value),
    dryRun: $('dryRun').checked,
    shelves: Object.fromEntries(shelfBoxes.map(b => [b.dataset.shelf, b.checked])),
  });
  await call('settingsChanged');
  await load();
  $('saved').hidden = false;
  setTimeout(() => { $('saved').hidden = true; }, 1500);
};

load();
