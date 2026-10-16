"""End-to-end tests for Simple Screenshot.

Loads the extension into Playwright's Chromium, opens the local pages in
tests/pages (served on 127.0.0.1 only), runs every capture mode and checks the
pixels of the result against the page layout. Runs at device scale 1 and 2.

    xvfb-run -a python3 tests/run_tests.py

The test copy of the extension gets <all_urls> and clipboardRead so the
service worker can be driven without a toolbar click. The shipped manifest
only has activeTab and scripting.
"""
import base64
import functools
import http.server
import io
import json
import re
import shutil
import sys
import tempfile
import threading
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PAGES = ROOT / "tests" / "pages"
OUT = Path(tempfile.mkdtemp(prefix="simple-screenshot-out-"))
SHIPPED = ["manifest.json", "background.js", "store.js", "page.js", "select.js",
           "popup.html", "popup.css", "popup.js", "shot.html", "shot.css", "shot.js", "icons"]

failures = []
passes = 0


def check(cond, label):
    global passes
    if cond:
        passes += 1
    else:
        failures.append(label)
        print(f"  FAIL {label}")


def rgb(css):
    return tuple(int(v) for v in re.findall(r"\d+", css)[:3])


def near(a, b, tol=3):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def run_count(img, x, color):
    """Rows in column x whose pixel matches color."""
    px = img.load()
    return sum(1 for y in range(img.height) if near(px[x, y], color))


# ---------------------------------------------------------------- static checks

def static_checks():
    print("static checks")
    manifest = json.loads((ROOT / "manifest.json").read_text())
    check(sorted(manifest["permissions"]) == ["activeTab", "scripting"], "manifest asks only for activeTab + scripting")
    check("host_permissions" not in manifest, "manifest has no host permissions")
    for name in SHIPPED:
        path = ROOT / name
        if path.is_dir():
            continue
        text = path.read_text()
        check(not re.search(r"https?://", text), f"{name}: no remote URLs")
        check("innerHTML" not in text and "eval(" not in text, f"{name}: no innerHTML or eval")
    for path in list(ROOT.glob("*")) + list((ROOT / "tests").rglob("*.*")) + list((ROOT / "tools").glob("*.py")):
        if not path.is_file() or path.suffix not in {".js", ".html", ".css", ".json", ".py", ".md", ""}:
            continue
        text = path.read_text()
        check(chr(0x2014) not in text and chr(0x2013) not in text, f"{path.name}: no em or en dashes")


# ------------------------------------------------------------------- browser run

def build_test_copy():
    dest = Path(tempfile.mkdtemp(prefix="simple-screenshot-ext-"))
    for name in SHIPPED:
        src = ROOT / name
        (shutil.copytree if src.is_dir() else shutil.copy)(src, dest / name)
    manifest = json.loads((dest / "manifest.json").read_text())
    manifest["host_permissions"] = ["<all_urls>"]
    manifest["permissions"].append("clipboardRead")
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return dest


def serve_pages():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(PAGES))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


READ_SHOT = """async () => {
  const s = await ShotStore.get(decodeURIComponent(location.hash.slice(1)));
  const bytes = new Uint8Array(await s.blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { b64: btoa(bin), note: s.note, width: s.width, height: s.height, title: s.title };
}"""

SHOT_READY = """() => { const i = document.getElementById('img');
  return i && !i.hidden && i.complete && i.naturalWidth > 0; }"""

MEASURE = """() => {
  const de = document.documentElement;
  const band = (b) => { const r = b.getBoundingClientRect();
    return { top: r.top + scrollY, vtop: r.top, h: r.height, color: getComputedStyle(b).backgroundColor }; };
  const sticky = document.getElementById('sticky');
  return { viewW: de.clientWidth, viewH: de.clientHeight, scrollH: de.scrollHeight, scrollY,
    bands: [...document.querySelectorAll('.band')].map(band),
    sticky: sticky ? band(sticky) : null };
}"""


class Session:
    def __init__(self, ctx, base):
        self.ctx = ctx
        self.base = base
        self.sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        self.ext_id = self.sw.url.split("/")[2]

    def tab_id(self, page):
        return self.sw.evaluate("async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id", page.url)

    def open(self, name):
        # Tabs from ctx.new_page() get a 0x0 size with no_viewport, so open a
        # real tab through the tabs API instead.
        with self.ctx.expect_page() as info:
            self.sw.evaluate("(u) => { chrome.tabs.create({ url: u }); }", f"{self.base}/{name}")
        page = info.value
        page.wait_for_load_state()
        page.bring_to_front()
        page.wait_for_function("innerWidth > 0")
        return page

    def read_shot(self, shot):
        shot.wait_for_load_state()
        shot.wait_for_function(SHOT_READY)
        data = shot.evaluate(READ_SHOT)
        img = Image.open(io.BytesIO(base64.b64decode(data["b64"]))).convert("RGB")
        return img, data

    def capture(self, page, mode):
        page.bring_to_front()
        tid = self.tab_id(page)
        with self.ctx.expect_page(timeout=90_000) as info:
            self.sw.evaluate("async ([m, id]) => { await startCapture(m, await chrome.tabs.get(id)); }", [mode, tid])
        shot = info.value
        img, data = self.read_shot(shot)
        return shot, img, data


def test_full_long(s, d, tag):
    print(f"[{tag}] full page, document scroll, fixed + sticky elements")
    page = s.open("long.html")
    m0 = page.evaluate(MEASURE)  # sticky measured at scroll 0, in its own place
    page.evaluate("window.scrollTo(0, 500)")
    shot, img, data = s.capture(page, "full")
    img.save(OUT / f"{tag}-full-long.png")
    m = page.evaluate(MEASURE)
    px = img.load()
    check(img.size == (round(m["viewW"] * d), round(m["scrollH"] * d)), f"[{tag}] full size {img.size} vs page {m['viewW']}x{m['scrollH']} @{d}")
    check(not data["note"], f"[{tag}] no length note on a normal page")
    x = round((m["viewW"] - 20) * d)
    check(near(px[x, round(30 * d)], (208, 0, 0)), f"[{tag}] fixed header at the top")
    check(abs(run_count(img, x, (208, 0, 0)) - 60 * d) <= d, f"[{tag}] fixed header appears once")
    check(abs(run_count(img, round(20 * d), (0, 208, 0)) - 30 * d) <= d, f"[{tag}] fixed cookie bar appears once")
    st = m0["sticky"]
    check(abs(run_count(img, x, (17, 17, 17)) - st["h"] * d) <= d, f"[{tag}] sticky bar appears once")
    check(near(px[x, round((st["top"] + st["h"] / 2) * d)], (17, 17, 17)), f"[{tag}] sticky bar in its own place")
    bad = [i for i, b in enumerate(m0["bands"])
           if not near(px[x, round((b["top"] + b["h"] / 2) * d)], rgb(b["color"]))]
    check(not bad, f"[{tag}] every band lines up (off: {bad[:6]})")
    after = page.evaluate("""() => ({ y: scrollY,
      fixed: getComputedStyle(document.querySelector('.fixed')).visibility,
      sticky: getComputedStyle(document.getElementById('sticky')).position,
      leftover: [...document.querySelectorAll('style')].some((st) => st.textContent.includes('scroll-behavior:auto')) })""")
    check(after == {"y": 500, "fixed": "visible", "sticky": "sticky", "leftover": False}, f"[{tag}] page restored after capture: {after}")
    shot.close()
    return page


def test_visible_and_area(s, d, tag, page):
    print(f"[{tag}] visible part and selected area")
    page.evaluate("window.scrollTo(0, 1000)")
    page.wait_for_timeout(100)
    m = page.evaluate(MEASURE)
    shot, img, _ = s.capture(page, "visible")
    img.save(OUT / f"{tag}-visible.png")
    check(img.size == (round(m["viewW"] * d), round(m["viewH"] * d)), f"[{tag}] visible size {img.size}")
    px = img.load()
    x = round((m["viewW"] - 20) * d)
    st = m["sticky"]
    bad = []
    for i, b in enumerate(m["bands"]):
        mid = b["vtop"] + b["h"] / 2
        if 70 < mid < m["viewH"] - 10 and not (st["vtop"] - 2 <= mid <= st["vtop"] + st["h"] + 2):
            if not near(px[x, round(mid * d)], rgb(b["color"])):
                bad.append(i)
    check(not bad, f"[{tag}] visible bands match (off: {bad})")
    shot.close()

    page.bring_to_front()
    tid = s.tab_id(page)
    s.sw.evaluate("async (id) => { await startCapture('area', await chrome.tabs.get(id)); }", tid)
    page.wait_for_timeout(300)
    with s.ctx.expect_page(timeout=30_000) as info:
        page.mouse.move(100, 200)
        page.mouse.down()
        page.mouse.move(250, 280, steps=4)
        page.mouse.move(400, 350, steps=4)
        page.mouse.up()
    shot = info.value
    img, _ = s.read_shot(shot)
    img.save(OUT / f"{tag}-area.png")
    check(abs(img.width - 300 * d) <= 1 and abs(img.height - 150 * d) <= 1, f"[{tag}] area size {img.size} vs 300x150 @{d}")
    doc_y = m["scrollY"] + 275
    band = next(b for b in m["bands"] if b["top"] <= doc_y < b["top"] + b["h"])
    check(near(img.getpixel((img.width // 2, img.height // 2)), rgb(band["color"])), f"[{tag}] area shows the right part of the page")
    overlay_left = page.evaluate("[...document.documentElement.children].some((el) => el.shadowRoot === null && el.style.zIndex === '2147483647')")
    check(not overlay_left, f"[{tag}] selection overlay removed")
    shot.close()

    # Esc cancels without a capture.
    s.sw.evaluate("async (id) => { await startCapture('area', await chrome.tabs.get(id)); }", tid)
    page.wait_for_timeout(200)
    picking = page.evaluate("document.documentElement.lastElementChild.style.zIndex")
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    gone = page.evaluate("document.documentElement.lastElementChild.style.zIndex")
    check(picking == "2147483647" and gone != "2147483647", f"[{tag}] Esc removes the overlay")
    page.close()


def test_inner(s, d, tag):
    print(f"[{tag}] full page, inner scrolling box")
    page = s.open("inner.html")
    page.evaluate("document.getElementById('main').scrollTop = 200")
    m = page.evaluate("""() => { const el = document.getElementById('main'); const r = el.getBoundingClientRect();
      return { viewW: document.documentElement.clientWidth, viewH: document.documentElement.clientHeight,
        top: r.top, max: el.scrollHeight - el.clientHeight,
        bands: [...el.querySelectorAll('.band')].map((b) => ({ off: b.getBoundingClientRect().top - r.top + el.scrollTop,
          h: b.offsetHeight, color: getComputedStyle(b).backgroundColor })) }; }""")
    shot, img, _ = s.capture(page, "full")
    img.save(OUT / f"{tag}-full-inner.png")
    total = m["viewH"] + m["max"]
    check(img.size == (round(m["viewW"] * d), round(total * d)), f"[{tag}] inner size {img.size} vs {m['viewW']}x{total}")
    px = img.load()
    check(near(px[20, round(25 * d)], (10, 125, 0)), f"[{tag}] header above the box")
    check(near(px[20, img.height - round(15 * d)], (51, 51, 51)), f"[{tag}] footer below the box")
    bad = [i for i, b in enumerate(m["bands"])
           if not near(px[20, round((m["top"] + b["off"] + b["h"] / 2) * d)], rgb(b["color"]))]
    check(not bad, f"[{tag}] inner bands line up (off: {bad})")
    edge = [i for i, b in enumerate(m["bands"])
            if not near(px[img.width - 3, round((m["top"] + b["off"] + b["h"] / 2) * d)], rgb(b["color"]))]
    check(not edge, f"[{tag}] no scrollbar strip down the right edge (off: {edge})")
    check(page.evaluate("getComputedStyle(document.getElementById('main')).scrollbarWidth") == "auto", f"[{tag}] inner scrollbar restored")
    check(page.evaluate("document.getElementById('main').scrollTop") == 200, f"[{tag}] inner box scroll restored")
    shot.close()
    page.close()


def test_short_and_tall(s, d, tag):
    print(f"[{tag}] short page and very tall page")
    page = s.open("short.html")
    m = page.evaluate(MEASURE)
    shot, img, _ = s.capture(page, "full")
    check(img.size == (round(m["viewW"] * d), round(m["viewH"] * d)), f"[{tag}] short page is one screen {img.size}")
    shot.close()
    page.close()

    page = s.open("tall.html")
    m = page.evaluate(MEASURE)
    shot, img, data = s.capture(page, "full")
    capped = m["scrollH"] * d > 32000
    want_h = 32000 if capped else round(m["scrollH"] * d)
    check(img.size == (round(m["viewW"] * d), want_h), f"[{tag}] tall size {img.size}, want height {want_h}")
    check(bool(data["note"]) == capped, f"[{tag}] length note only when capped ({data['note']!r})")
    px = img.load()
    bad = [i for i, b in enumerate(m["bands"])
           if (b["top"] + b["h"]) * d <= img.height and not near(px[20, round((b["top"] + b["h"] / 2) * d)], rgb(b["color"]))]
    check(not bad, f"[{tag}] tall bands line up (off: {bad[:6]})")
    shot.close()
    page.close()


def test_ui(s, tag):
    print(f"[{tag}] result page buttons, popup, errors")
    page = s.open("long.html")
    shot, img, data = s.capture(page, "visible")
    shot.bring_to_front()
    shot.wait_for_timeout(300)
    shot.screenshot(path=str(OUT / f"{tag}-shot-page.png"))
    check(shot.locator("#title").inner_text() == "Long test page", f"[{tag}] title shown")
    check(shot.locator("#copy").is_enabled() and shot.locator("#save").is_enabled(), f"[{tag}] buttons enabled")

    with shot.expect_download() as dl:
        shot.click("#save")
    download = dl.value
    name = download.suggested_filename
    check(re.fullmatch(r"Screenshot \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d 127\.0\.0\.1\.png", name) is not None, f"[{tag}] file name {name!r}")
    saved = OUT / f"{tag}-saved.png"
    download.save_as(str(saved))
    check(saved.read_bytes() == base64.b64decode(data["b64"]), f"[{tag}] saved file is the screenshot")

    shot.click("#copy")
    shot.wait_for_function("() => document.getElementById('toast').textContent.startsWith('Copied')", timeout=5000)
    types = shot.evaluate("async () => (await navigator.clipboard.read()).flatMap((i) => i.types)")
    check("image/png" in types, f"[{tag}] clipboard holds a PNG ({types})")
    shot.keyboard.press("Control+s")
    check(True, "ctrl+s does not throw")

    with s.ctx.expect_page() as info:
        s.sw.evaluate("() => { chrome.tabs.create({ url: chrome.runtime.getURL('shot.html#nope') }); }")
    missing = info.value
    missing.wait_for_function("() => document.getElementById('title').textContent !== 'Loading…'")
    check(missing.locator("#title").inner_text() == "Screenshot not found", f"[{tag}] unknown id shows not found")
    missing.close()
    shot.close()

    # The popup's own message path, from a separate window so the page tab stays active.
    with s.ctx.expect_page() as info:
        s.sw.evaluate("() => chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 280, height: 260 })")
    popup = info.value
    popup.wait_for_load_state()
    popup.wait_for_function("() => document.querySelector('kbd').textContent !== ''")
    popup.screenshot(path=str(OUT / f"{tag}-popup.png"))
    kbds = popup.eval_on_selector_all("kbd", "(els) => els.map((e) => e.textContent)")
    check(kbds == ["Alt+Shift+V", "Alt+Shift+F", "Alt+Shift+S"], f"[{tag}] popup shows shortcuts {kbds}")
    tid = s.tab_id(page)
    with s.ctx.expect_page(timeout=30_000) as info:
        reply = popup.evaluate("(id) => chrome.runtime.sendMessage({ type: 'capture', mode: 'visible', tabId: id })", tid)
    check(reply == {"ok": True}, f"[{tag}] popup capture reply {reply}")
    info.value.close()

    page.goto("chrome://version")
    reply = popup.evaluate("(id) => chrome.runtime.sendMessage({ type: 'capture', mode: 'visible', tabId: id })", tid)
    check(reply.get("ok") is False and "doesn't let extensions capture" in reply.get("error", ""), f"[{tag}] restricted page error {reply}")
    popup.close()
    page.close()


def main():
    static_checks()
    ext = build_test_copy()
    server, base = serve_pages()
    try:
        with sync_playwright() as p:
            for d in (1, 2):
                tag = f"dpr{d}"
                profile = tempfile.mkdtemp(prefix="simple-screenshot-profile-")
                ctx = p.chromium.launch_persistent_context(
                    profile,
                    channel="chromium",
                    headless=False,
                    no_viewport=True,
                    accept_downloads=True,
                    args=[
                        f"--disable-extensions-except={ext}",
                        f"--load-extension={ext}",
                        "--window-size=1280,900",
                        f"--force-device-scale-factor={d}",
                    ],
                )
                try:
                    s = Session(ctx, base)
                    page = test_full_long(s, d, tag)
                    test_visible_and_area(s, d, tag, page)
                    test_inner(s, d, tag)
                    test_short_and_tall(s, d, tag)
                    if d == 1:
                        test_ui(s, tag)
                finally:
                    ctx.close()
                    shutil.rmtree(profile, ignore_errors=True)
    finally:
        server.shutdown()
        shutil.rmtree(ext, ignore_errors=True)

    print(f"\n{passes} passed, {len(failures)} failed. Images in {OUT}")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
