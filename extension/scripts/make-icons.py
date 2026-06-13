#!/usr/bin/env python3
"""
Render the Echo icon at 16/32/48/128 px PNG into ../public/icons/.

Concept: a sound-ripple — a filled center dot with concentric rings radiating
outward, on a deep-indigo rounded-square background. Rings get thinner and
more transparent toward the edge. At 16px the third ring drops out so the
icon stays legible in Chrome's toolbar.

Run:  python3 scripts/make-icons.py
"""

from pathlib import Path
from PIL import Image, ImageDraw

SIZES = [16, 32, 48, 128]
SUPERSAMPLE = 4

# Brand colors. The blue matches the editor / popup accent (#1464dc).
BG_TOP = (20, 100, 220, 255)        # #1464dc
BG_BOTTOM = (45, 70, 195, 255)      # subtle vertical shade for depth
WHITE = (255, 255, 255, 255)

# Geometry as fractions of icon size.
CORNER = 0.22
DOT_R = 0.085
RING_1 = (0.165, 0.205, 255)        # inner_r, outer_r, alpha
RING_2 = (0.285, 0.325, 190)
RING_3 = (0.405, 0.445, 120)


def vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    """Solid-fill image with a top→bottom gradient between two RGBA tuples."""
    img = Image.new("RGBA", (size, size), top)
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = round(top[0] + (bottom[0] - top[0]) * t)
        g = round(top[1] + (bottom[1] - top[1]) * t)
        b = round(top[2] + (bottom[2] - top[2]) * t)
        a = round(top[3] + (bottom[3] - top[3]) * t)
        for x in range(size):
            px[x, y] = (r, g, b, a)
    return img


def rounded_mask(size: int, radius: int) -> Image.Image:
    """Alpha mask shaped like a rounded square."""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=radius, fill=255)
    return mask


def draw_ring(canvas: Image.Image, cx: int, cy: int, inner: int, outer: int, alpha: int) -> None:
    """Stroke a ring by compositing a fully-drawn outer disc + transparent inner disc."""
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([(cx - outer, cy - outer), (cx + outer, cy + outer)], fill=(255, 255, 255, alpha))
    # Punch the inner — paste fully-transparent pixels.
    d.ellipse([(cx - inner, cy - inner), (cx + inner, cy + inner)], fill=(0, 0, 0, 0))
    canvas.alpha_composite(layer)


def render(size: int) -> Image.Image:
    s = size * SUPERSAMPLE

    # 1. Gradient + rounded-square mask.
    bg = vertical_gradient(s, BG_TOP, BG_BOTTOM)
    mask = rounded_mask(s, int(s * CORNER))
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.paste(bg, (0, 0), mask)

    cx, cy = s // 2, s // 2

    # 2. Center dot (always visible).
    dot_r = int(s * DOT_R)
    dot_layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(dot_layer).ellipse(
        [(cx - dot_r, cy - dot_r), (cx + dot_r, cy + dot_r)], fill=WHITE
    )
    canvas.alpha_composite(dot_layer)

    # 3. Rings — stagger detail by output size to keep small icons legible.
    rings = [RING_1]
    if size >= 32:
        rings.append(RING_2)
    if size >= 48:
        rings.append(RING_3)
    for inner_f, outer_f, alpha in rings:
        draw_ring(canvas, cx, cy, int(s * inner_f), int(s * outer_f), alpha)

    # 4. Downsample to target.
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    out_dir = Path(__file__).resolve().parent.parent / "public" / "icons"
    out_dir.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = out_dir / f"icon-{size}.png"
        render(size).save(path, optimize=True)
        print(f"  wrote {path.relative_to(out_dir.parent.parent)}")


if __name__ == "__main__":
    main()
