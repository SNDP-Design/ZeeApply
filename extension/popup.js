// Popup logic — load saved profile, save edits, send "fill" message to the
// content script on the active tab.

const FIELDS = [
  'firstName', 'lastName', 'email', 'phone', 'location',
  'linkedin', 'portfolio', 'github', 'referral', 'workAuth', 'pronouns',
];

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = '') {
  const s = $('status');
  s.textContent = msg;
  s.className = 'status ' + kind;
}

async function loadProfile() {
  const data = await chrome.storage.sync.get(['profile']);
  const profile = data.profile || {};
  for (const f of FIELDS) {
    const inp = $(f);
    if (inp) inp.value = profile[f] || '';
  }
}

async function saveProfile() {
  const profile = {};
  for (const f of FIELDS) {
    const inp = $(f);
    if (inp) profile[f] = inp.value.trim();
  }
  await chrome.storage.sync.set({ profile });
  setStatus('✓ Profile saved.', 'ok');
}

async function fillCurrentTab() {
  // Save profile first so any unsaved edits are picked up
  await saveProfile();

  const coverLetter = $('coverLetter').value.trim();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('No active tab.', 'err');
    return;
  }

  // Check the tab URL is on a supported ATS — if not, give a helpful error.
  const u = tab.url || '';
  const supported = /(greenhouse\.io|lever\.co|ashbyhq\.com)/i.test(u);
  if (!supported) {
    setStatus(`This page isn't a supported ATS (Greenhouse / Lever / Ashby).`, 'err');
    return;
  }

  setStatus('Filling…');
  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'zeeapply:fill',
      profile: Object.fromEntries(FIELDS.map(f => [f, $(f).value.trim()])),
      coverLetter,
    });
    if (!result) {
      setStatus('No response from content script. Try refreshing the page.', 'err');
      return;
    }
    setStatus(`✓ Filled ${result.filled} / ${result.attempted} fields.`, 'ok');
    // Clear the cover letter so the user remembers to paste a fresh one next time.
    if (coverLetter) $('coverLetter').value = '';
  } catch (e) {
    setStatus(`Error: ${e.message}. Try refreshing the page.`, 'err');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadProfile();
  $('saveBtn').addEventListener('click', saveProfile);
  $('fillBtn').addEventListener('click', fillCurrentTab);
});
