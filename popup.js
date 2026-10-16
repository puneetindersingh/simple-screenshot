const statusEl = document.getElementById('status');
const buttons = [...document.querySelectorAll('.mode')];

const WORKING = {
  visible: 'Capturing…',
  full: 'Capturing the full page. Stay on this tab while it scrolls.',
  area: 'Drag on the page to pick an area.',
};

// Show the shortcuts the user actually has, which may differ from the defaults.
chrome.commands.getAll().then((commands) => {
  for (const kbd of document.querySelectorAll('kbd[data-command]')) {
    const command = commands.find((c) => c.name === kbd.dataset.command);
    kbd.textContent = (command && command.shortcut) || '';
  }
});

for (const button of buttons) {
  button.addEventListener('click', () => capture(button.dataset.mode));
}

showLastError();

async function capture(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  buttons.forEach((b) => { b.disabled = true; });
  show(WORKING[mode]);
  const res = await chrome.runtime.sendMessage({ type: 'capture', mode, tabId: tab.id });
  if (res && res.ok) {
    // The screenshot opens in a new tab, which closes this popup anyway.
    window.close();
    return;
  }
  buttons.forEach((b) => { b.disabled = false; });
  show((res && res.error) || 'Something went wrong. Try again.', true);
}

// A keyboard shortcut that failed leaves a "!" on the toolbar icon and the
// reason in its tooltip.
async function showLastError() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const badge = await chrome.action.getBadgeText({ tabId: tab.id });
  if (badge !== '!') return;
  const title = await chrome.action.getTitle({ tabId: tab.id });
  show(title.replace(/^Simple Screenshot: /, ''), true);
  await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
  await chrome.action.setTitle({ tabId: tab.id, title: 'Simple Screenshot' });
}

function show(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
  statusEl.hidden = false;
}
