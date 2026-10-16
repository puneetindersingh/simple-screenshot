# Simple Screenshot

A small, open source screenshot extension for Chrome. Click the icon, pick what to capture, then copy or save the image. That is the whole tool.

- **Visible part**: what you can see in the tab right now.
- **Full page**: the whole page, top to bottom. The page scrolls itself while it captures.
- **Selected area**: drag a box over the part you want.

The screenshot opens in a new tab with two buttons: **Copy** (paste it anywhere with Ctrl+V) and **Save** (downloads a PNG).

No account, no cloud, no uploads, no analytics. The extension makes no network requests at all. Screenshots exist only in your browser until you copy or save them.

## Install

Simple Screenshot isn't on the Chrome Web Store. Load it from this folder:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the icon from the puzzle-piece menu so it stays in the toolbar.

To update after pulling new code, click the reload arrow on the extension's card in `chrome://extensions`.

Needs Chrome 121 or newer. Tested in Chromium only; Edge and Brave are untested but it uses nothing Chrome-only.

## Keyboard shortcuts

| Shortcut | Captures |
|---|---|
| Alt+Shift+V | Visible part |
| Alt+Shift+F | Full page |
| Alt+Shift+S | Selected area |

Change them at `chrome://extensions/shortcuts`. In the result tab, Ctrl+C copies and Ctrl+S saves.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Lets the extension see the tab you are on, only after you click the icon or press a shortcut. It gets no access to any other tab or site. |
| `scripting` | Runs the small helper that scrolls the page for a full-page capture and draws the selection box. |

Chrome shows no install warning for either one.

## How full page capture works

Chrome can only photograph what is on screen, so the extension scrolls one screen at a time, takes a picture of each, and joins them into one image. A few details make the result look like the page:

- Headers, cookie bars and other fixed elements show once at the top instead of on every screen.
- Sticky elements (a menu that follows you down the page) stay in their normal place.
- Pages that scroll an inner box instead of the whole window, as many web apps do, are detected and that box is captured.
- Your scroll position and the page's look are put back exactly when it finishes.

Limits worth knowing:

- Chrome allows two screen grabs per second, so a long page takes a few seconds. Stay on the tab until the result opens.
- Images are capped at 32,000 pixels tall (Chrome's canvas limit). On very long pages, or at 2x screen density, the screenshot stops there and says so.
- Pages that load more content as you scroll (endless feeds) are captured up to the height they had when you started.
- Chrome blocks extensions on its own pages (`chrome://`, the Web Store, other extensions), so those can't be captured.

## Files

| File | What it does |
|---|---|
| `manifest.json` | Extension setup, permissions and shortcuts. |
| `background.js` | Runs the captures, joins full-page frames, opens the result tab. |
| `page.js` | Helper injected into the page: measures it, scrolls it, hides fixed elements, puts everything back. |
| `select.js` | The drag-to-select overlay. |
| `popup.*` | The menu under the toolbar icon. |
| `shot.*` | The result tab with Copy and Save. |
| `store.js` | Hands the finished image from the background to the result tab (IndexedDB, last 10 kept). |
| `tools/make_icons.py` | Redraws the icons (needs Pillow). |
| `tests/run_tests.py` | End-to-end tests. |

## Tests

The tests load the extension into Playwright's Chromium, open the local pages in `tests/pages` (served on 127.0.0.1 only), run every capture mode at 1x and 2x pixel density, and check the pixels of each result against the page layout. They also cover Copy, Save, the popup and the error on blocked pages.

```bash
pip install playwright pillow
python3 -m playwright install chromium
xvfb-run -a python3 tests/run_tests.py
```

Drop `xvfb-run -a` on a desktop session if you don't mind a browser window opening.

## License

MIT. See [LICENSE](LICENSE).
