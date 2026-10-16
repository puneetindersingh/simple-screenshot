// Area picker for Simple Screenshot. Covers the window with an overlay, lets
// the user drag a box, then removes itself and sends the box to the service
// worker, which captures the screen and crops it.
(() => {
  if (window.__simpleShotPicking) return;
  window.__simpleShotPicking = true;

  const SHADE = 'rgba(15, 23, 42, 0.38)';

  const host = document.createElement('div');
  host.style.cssText =
    'all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;user-select:none;';
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .shade { position: fixed; inset: 0; background: ${SHADE}; }
    .box { position: fixed; display: none; outline: 1px solid #fff;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), 0 0 0 100vmax ${SHADE}; }
    .size { position: absolute; left: 0; top: -27px; padding: 5px 7px; border-radius: 4px;
      font: 12px/1 system-ui, sans-serif; color: #fff; background: rgba(0, 0, 0, 0.78);
      white-space: nowrap; }
    .size.inside { top: 6px; left: 6px; }
    .hint { position: fixed; left: 50%; top: 16px; transform: translateX(-50%);
      padding: 9px 13px; border-radius: 6px; font: 13px/1.2 system-ui, sans-serif;
      color: #fff; background: rgba(0, 0, 0, 0.78); pointer-events: none; }
  `;
  const shade = make('div', 'shade');
  const box = make('div', 'box');
  const size = make('span', 'size');
  const hint = make('div', 'hint', 'Drag to select an area. Press Esc to cancel.');
  box.append(size);
  root.append(style, shade, box, hint);
  document.documentElement.append(host);

  let start = null;

  host.addEventListener('mousedown', (e) => e.preventDefault());
  host.addEventListener('contextmenu', (e) => e.preventDefault());
  host.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    host.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY };
    hint.style.display = 'none';
    draw(rectTo(e));
  });
  host.addEventListener('pointermove', (e) => {
    if (!start) return;
    e.preventDefault();
    draw(rectTo(e));
  });
  host.addEventListener('pointerup', (e) => {
    if (!start) return;
    e.preventDefault();
    const rect = rectTo(e);
    start = null;
    if (rect.w < 4 || rect.h < 4) {
      // A click, not a drag: start over.
      box.style.display = 'none';
      shade.style.display = '';
      hint.style.display = '';
      return;
    }
    done(rect);
  });
  // Scrolling to the right spot is fine before the drag, not during it.
  host.addEventListener('wheel', (e) => start && e.preventDefault(), { passive: false });
  window.addEventListener('keydown', onKey, true);

  function make(tag, className, text = '') {
    const el = document.createElement(tag);
    el.className = className;
    el.textContent = text;
    return el;
  }

  function rectTo(e) {
    const maxX = document.documentElement.clientWidth || window.innerWidth;
    const maxY = document.documentElement.clientHeight || window.innerHeight;
    const clampX = (v) => Math.max(0, Math.min(v, maxX));
    const clampY = (v) => Math.max(0, Math.min(v, maxY));
    const x1 = clampX(Math.min(start.x, e.clientX));
    const y1 = clampY(Math.min(start.y, e.clientY));
    const x2 = clampX(Math.max(start.x, e.clientX));
    const y2 = clampY(Math.max(start.y, e.clientY));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function draw(r) {
    shade.style.display = 'none';
    box.style.display = 'block';
    box.style.left = `${r.x}px`;
    box.style.top = `${r.y}px`;
    box.style.width = `${r.w}px`;
    box.style.height = `${r.h}px`;
    size.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    size.classList.toggle('inside', r.y < 32);
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cleanup();
  }

  function cleanup() {
    host.remove();
    window.removeEventListener('keydown', onKey, true);
    window.__simpleShotPicking = false;
  }

  function done(rect) {
    cleanup();
    // Wait until the overlay is off the screen before Chrome grabs it.
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'area-picked',
        rect,
        innerWidth: window.innerWidth,
        title: document.title,
        url: location.href,
      }).catch(() => {});
    }, 120)));
  }
})();
