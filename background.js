// Simple Screenshot service worker. Runs the three capture modes and hands the
// finished PNG to shot.html through IndexedDB (store.js).
importScripts('store.js');

// Chrome allows captureVisibleTab twice a second per extension.
const CAPTURE_GAP_MS = 550;
// After a scroll the page has painted, but the screen Chrome grabs from can
// lag a frame or two behind, more so at high pixel density.
const SETTLE_MS = 150;
// Tallest image Chrome will reliably draw and encode, in device pixels.
const MAX_CANVAS_PX = 32000;

const COMMAND_MODES = {
  'capture-visible': 'visible',
  'capture-full': 'full',
  'capture-area': 'area',
};

let lastCaptureAt = 0;
let busy = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'capture') {
    chrome.tabs.get(msg.tabId)
      .then((tab) => startCapture(msg.mode, tab))
      .then(() => reply({ ok: true }), (err) => reply({ ok: false, error: explain(err) }));
    return true;
  }
  if (msg.type === 'area-picked' && sender.tab) {
    exclusive(() => captureArea(sender.tab, msg)).catch((err) => flagError(sender.tab, err));
  }
  return false;
});

chrome.commands.onCommand.addListener((command, tab) => {
  const mode = COMMAND_MODES[command];
  if (mode && tab) startCapture(mode, tab).catch((err) => flagError(tab, err));
});

async function startCapture(mode, tab) {
  await setBadge(tab, '');
  if (mode === 'area') {
    // select.js reports back with an 'area-picked' message.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['select.js'] });
    return;
  }
  await exclusive(() => (mode === 'full' ? captureFull(tab) : captureVisible(tab)));
}

async function exclusive(job) {
  if (busy) throw new Error('A screenshot is already being taken.');
  busy = true;
  try {
    await job();
  } finally {
    busy = false;
  }
}

async function captureVisible(tab) {
  const page = await inPage(tab, 'viewport');
  const frame = await grab(tab);
  const scale = frame.width / page.innerWidth;
  const canvas = copyRegion(frame, 0, 0, page.viewW * scale, page.viewH * scale);
  frame.close();
  await finish(tab, page, canvas);
}

async function captureArea(tab, msg) {
  const frame = await grab(tab);
  const scale = frame.width / msg.innerWidth;
  const r = msg.rect;
  const canvas = copyRegion(frame, r.x * scale, r.y * scale, r.w * scale, r.h * scale);
  frame.close();
  await finish(tab, msg, canvas);
}

async function captureFull(tab) {
  const page = await inPage(tab, 'prepare');
  let result;
  try {
    result = await stitch(tab, page);
  } finally {
    await inPage(tab, 'restore').catch(() => {});
    await setBadge(tab, '');
  }
  await finish(tab, page, result.canvas, result.note);
}

// Scrolls the page one screen at a time and draws each frame into one tall
// canvas. For a page that scrolls an inner box, only that box's slice of each
// frame is used; what sits above it comes from the first frame and what sits
// below it from the last.
async function stitch(tab, page) {
  const { region: r, viewW, viewH } = page;
  const first = await scrollAndGrab(tab, 0);
  const scale = first.bitmap.width / page.innerWidth;
  const px = (v) => Math.round(v * scale);

  let maxScroll = page.maxScroll;
  let note = '';
  const room = Math.floor(MAX_CANVAS_PX / scale) - viewH;
  if (maxScroll > room) {
    maxScroll = Math.max(0, room);
    note = `This page is too long for one image, so the screenshot stops ${(viewH + maxScroll).toLocaleString()} px down.`;
  }

  const canvas = new OffscreenCanvas(px(viewW), px(viewH + maxScroll));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(first.bitmap, 0, 0, px(viewW), px(viewH), 0, 0, px(viewW), px(viewH));

  let at = 0;
  let last = first.bitmap;
  if (maxScroll > 0) await inPage(tab, 'freezeFixed');
  while (at < maxScroll) {
    const frame = await scrollAndGrab(tab, Math.min(at + r.h, maxScroll));
    if (frame.at <= at) {
      // The page stopped scrolling, for example because it got shorter.
      frame.bitmap.close();
      break;
    }
    at = frame.at;
    const top = px(r.y + at);
    const height = Math.min(px(r.y + r.h + at) - top, frame.bitmap.height - px(r.y));
    ctx.drawImage(frame.bitmap, px(r.x), px(r.y), px(r.w), height, px(r.x), top, px(r.w), height);
    last.close();
    last = frame.bitmap;
    await setBadge(tab, `${Math.min(99, Math.round((at / maxScroll) * 100))}%`);
  }

  const below = viewH - (r.y + r.h);
  if (at > 0 && below > 0) {
    ctx.drawImage(last, 0, px(r.y + r.h), px(viewW), px(below), 0, px(r.y + r.h + at), px(viewW), px(below));
  }
  last.close();

  const height = px(viewH + at);
  if (height < canvas.height) return { canvas: copyRegion(canvas, 0, 0, canvas.width, height), note };
  return { canvas, note };
}

async function scrollAndGrab(tab, y) {
  const at = await inPage(tab, 'scrollTo', y);
  await sleep(SETTLE_MS);
  const bitmap = await grab(tab);
  return { at, bitmap };
}

async function grab(tab) {
  const current = await chrome.tabs.get(tab.id);
  if (!current.active) {
    throw new Error('The tab changed during the capture. Stay on the page until the screenshot opens.');
  }
  const wait = lastCaptureAt + CAPTURE_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(current.windowId, { format: 'png' });
  } catch (err) {
    if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(err && err.message))) throw err;
    await sleep(1000);
    dataUrl = await chrome.tabs.captureVisibleTab(current.windowId, { format: 'png' });
  } finally {
    lastCaptureAt = Date.now();
  }
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

// Runs one of the page.js helpers inside the tab and returns its result.
async function inPage(tab, name, ...args) {
  const target = { tabId: tab.id };
  await chrome.scripting.executeScript({ target, files: ['page.js'] });
  const [res] = await chrome.scripting.executeScript({
    target,
    func: (fn, fnArgs) => window.__simpleShotPage[fn](...fnArgs),
    args: [name, args],
  });
  const result = res.result;
  if (result && result.innerWidth === 0) {
    throw new Error('The page has not finished opening. Try again in a moment.');
  }
  return result;
}

function copyRegion(source, x, y, w, h) {
  const sx = Math.round(x);
  const sy = Math.round(y);
  const sw = Math.max(1, Math.min(Math.round(w), source.width - sx));
  const sh = Math.max(1, Math.min(Math.round(h), source.height - sy));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

async function finish(tab, page, canvas, note = '') {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const id = await ShotStore.put({
    blob,
    width: canvas.width,
    height: canvas.height,
    title: page.title || '',
    url: page.url || '',
    note,
  });
  const fresh = await chrome.tabs.get(tab.id).catch(() => tab);
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`shot.html#${id}`),
    windowId: fresh.windowId,
    index: fresh.index + 1,
    openerTabId: fresh.id,
  });
}

function explain(err) {
  const msg = String((err && err.message) || err);
  if (/Cannot access|cannot be scripted|chrome:\/\/|chrome-extension:\/\/|extensions gallery|Missing host permission/i.test(msg)) {
    return "Chrome doesn't let extensions capture this page. Browser pages, the Chrome Web Store and other extensions are off limits.";
  }
  if (/activeTab|all_urls/.test(msg)) {
    return 'Chrome needs a fresh click on the toolbar icon for this tab. Open the menu and try again.';
  }
  return msg;
}

async function setBadge(tab, text) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#4f46e5' });
    await chrome.action.setBadgeText({ tabId: tab.id, text });
    if (!text) await chrome.action.setTitle({ tabId: tab.id, title: 'Simple Screenshot' });
  } catch {
    // The tab was closed.
  }
}

// Errors from keyboard shortcuts have no popup to show them, so they go on the
// toolbar icon. The popup reads them back the next time it opens.
async function flagError(tab, err) {
  const msg = explain(err);
  console.warn('Simple Screenshot:', msg);
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#c5221f' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setTitle({ tabId: tab.id, title: `Simple Screenshot: ${msg}` });
  } catch {
    // The tab was closed.
  }
}
