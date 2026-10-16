"""Draws the toolbar icons (a viewfinder on a rounded square) into icons/.

Run from the repo root: python3 tools/make_icons.py
Needs Pillow. Each size is drawn at 8x and scaled down for clean edges.
"""
from pathlib import Path

from PIL import Image, ImageDraw

BG = (79, 70, 229, 255)  # #4f46e5
FG = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "icons"


def icon(size: int) -> Image.Image:
    s = size * 8
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG)

    # Four viewfinder corners.
    pad, arm = s * 0.22, s * 0.2
    w = max(int(s * (0.085 if size <= 16 else 0.07)), 1)
    lo, hi = pad, s - pad
    for x, y, dx, dy in ((lo, lo, 1, 1), (hi, lo, -1, 1), (lo, hi, 1, -1), (hi, hi, -1, -1)):
        d.line([(x, y), (x + dx * arm, y)], fill=FG, width=w)
        d.line([(x, y), (x, y + dy * arm)], fill=FG, width=w)
        r = w / 2
        d.ellipse([x - r, y - r, x + r, y + r], fill=FG)

    # Centre dot.
    c, r = s / 2, s * (0.09 if size <= 16 else 0.075)
    d.ellipse([c - r, c - r, c + r, c + r], fill=FG)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        icon(size).save(OUT / f"icon{size}.png")
        print(f"icons/icon{size}.png")
