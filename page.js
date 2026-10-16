// In-page helpers for Simple Screenshot. The service worker injects this file
// into the tab's isolated world and then calls the helpers by name.
(() => {
  if (window.__simpleShotPage) return;

  let state = null;

  // Viewport size without scrollbars, in CSS pixels.
  function viewport() {
    const de = document.documentElement;
    const box = document.compatMode === 'BackCompat' && document.body ? document.body : de;
    return {
      innerWidth: window.innerWidth,
      viewW: Math.min(box.clientWidth || window.innerWidth, window.innerWidth),
      viewH: Math.min(box.clientHeight || window.innerHeight, window.innerHeight),
      title: document.title,
      url: location.href,
    };
  }

  function allElements() {
    return document.body ? document.body.getElementsByTagName('*') : [];
  }

  // Most pages scroll the document. Web apps often pin the body and scroll one
  // big inner box instead, so fall back to the largest visible scrolling box.
  function findScroller(v) {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight - v.viewH > 1) return null;
    let best = null;
    let bestArea = v.viewW * v.viewH * 0.25; // ignore small scrolling widgets
    for (const el of allElements()) {
      if (el.scrollHeight - el.clientHeight < 2) continue;
      const overflow = getComputedStyle(el).overflowY;
      if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') continue;
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, v.viewW) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, v.viewH) - Math.max(r.top, 0);
      if (w > 0 && h > 0 && w * h > bestArea) {
        best = el;
        bestArea = w * h;
      }
    }
    return best;
  }

  function prepare() {
    restore();
    const v = viewport();
    const scroller = findScroller(v);
    const style = document.createElement('style');
    style.textContent = '*{scroll-behavior:auto!important}';
    document.documentElement.appendChild(style);
    state = {
      scroller,
      style,
      saved: [],
      x: window.scrollX,
      y: window.scrollY,
      top: scroller ? scroller.scrollTop : 0,
    };

    if (!scroller) {
      const doc = document.scrollingElement || document.documentElement;
      return {
        ...v,
        region: { x: 0, y: 0, w: v.viewW, h: v.viewH },
        maxScroll: Math.max(0, doc.scrollHeight - v.viewH),
      };
    }
    // Hide the box's own scrollbar so it does not leave a strip down the side.
    setInline(scroller, 'scrollbar-width', 'none');
    // The visible inside of the box, without its border.
    const r = scroller.getBoundingClientRect();
    const x = Math.max(0, r.left + scroller.clientLeft);
    const y = Math.max(0, r.top + scroller.clientTop);
    return {
      ...v,
      region: {
        x,
        y,
        w: Math.min(scroller.clientWidth, v.viewW - x),
        h: Math.min(scroller.clientHeight, v.viewH - y),
      },
      maxScroll: scroller.scrollHeight - scroller.clientHeight,
    };
  }

  async function scrollTo(y) {
    if (state.scroller) state.scroller.scrollTop = y;
    else window.scrollTo(0, y);
    // Let the page paint the new position before the capture.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return state.scroller ? state.scroller.scrollTop : window.scrollY;
  }

  function setInline(el, prop, value) {
    state.saved.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
    el.style.setProperty(prop, value, 'important');
  }

  // Called after the first frame, so headers and cookie bars show once at the
  // top instead of on every slice. Sticky elements go back to their place in
  // the flow, which leaves the layout unchanged.
  function freezeFixed() {
    for (const el of allElements()) {
      const position = getComputedStyle(el).position;
      if (position !== 'fixed' && position !== 'sticky') continue;
      if (state.scroller && el.contains(state.scroller)) continue;
      setInline(el, 'transition', 'none');
      if (position === 'fixed') setInline(el, 'visibility', 'hidden');
      else setInline(el, 'position', 'static');
    }
  }

  function restore() {
    if (!state) return;
    for (const [el, prop, value, priority] of state.saved.reverse()) {
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
    if (state.scroller) state.scroller.scrollTop = state.top;
    window.scrollTo(state.x, state.y);
    state.style.remove();
    state = null;
  }

  window.__simpleShotPage = { viewport, prepare, scrollTo, freezeFixed, restore };
})();
