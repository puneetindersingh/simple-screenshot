const $ = (id) => document.getElementById(id);

let shot = null;
let objectUrl = '';
let toastTimer = 0;

load();

async function load() {
  const id = decodeURIComponent(location.hash.slice(1));
  shot = id ? await ShotStore.get(id).catch(() => null) : null;
  if (!shot) {
    $('title').textContent = 'Screenshot not found';
    $('sub').textContent = 'Only the last 10 screenshots are kept here. Take a new one from the toolbar icon.';
    document.title = 'Screenshot not found';
    return;
  }

  const host = hostOf(shot.url);
  $('title').textContent = shot.title || host || 'Screenshot';
  $('sub').textContent = [host, `${shot.width} × ${shot.height} px`].filter(Boolean).join(' · ');
  document.title = `Screenshot · ${shot.title || host || 'page'}`;
  if (shot.note) {
    $('note').textContent = shot.note;
    $('note').hidden = false;
  }

  objectUrl = URL.createObjectURL(shot.blob);
  const img = $('img');
  img.src = objectUrl;
  img.alt = `Screenshot of ${shot.title || host || 'the page'}`;
  img.hidden = false;
  img.addEventListener('click', toggleSize);

  $('copy').disabled = false;
  $('save').disabled = false;
  $('copy').addEventListener('click', copy);
  $('save').addEventListener('click', save);
}

async function copy() {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': shot.blob })]);
    toast('Copied. Paste it anywhere with Ctrl+V.');
  } catch (err) {
    toast(`Copy didn't work: ${err.message}`, true);
  }
}

function save() {
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = fileName();
  a.click();
  toast('Saving as PNG.');
}

// Fit to the window by default; a click shows it at its real size.
function toggleSize() {
  const img = $('img');
  const actual = img.classList.toggle('actual');
  img.style.width = actual ? `${shot.width / window.devicePixelRatio}px` : '';
}

function fileName() {
  const d = new Date(shot.createdAt);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
  const host = hostOf(shot.url);
  return `Screenshot ${stamp}${host ? ` ${host}` : ''}.png`.replace(/[\\/:*?"<>|]/g, '');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

document.addEventListener('keydown', (e) => {
  if (!shot || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const key = e.key.toLowerCase();
  if (key === 'c' && !String(window.getSelection())) {
    e.preventDefault();
    copy();
  } else if (key === 's') {
    e.preventDefault();
    save();
  }
});

window.addEventListener('pagehide', () => objectUrl && URL.revokeObjectURL(objectUrl));
