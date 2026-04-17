#!/usr/bin/env python3
"""Build a multi-size Windows .ico from img/store_images/icon.png for PyInstaller."""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageFilter
except ImportError as exc:  # pragma: no cover - build-time only
    raise SystemExit("Install Pillow: pip install pillow") from exc


def resize_sharp_for_ico(src: Image.Image, size: tuple[int, int]) -> Image.Image:
    """
    Downscale without the mushy look of a single LANCZOS jump from e.g. 1024→16.

    Uses repeated ~2× reductions, then a final resize. Adds a light unsharp mask only
    for small sizes (where blur is most visible in Explorer / taskbar).
    """
    tw, th = size
    if src.width < tw or src.height < th:
        return src.resize((tw, th), Image.Resampling.LANCZOS)

    im = src
    while (im.width > tw * 2 or im.height > th * 2) and im.width > tw and im.height > th:
        nw = max(tw, im.width // 2)
        nh = max(th, im.height // 2)
        im = im.resize((nw, nh), Image.Resampling.LANCZOS)

    out = im.resize((tw, th), Image.Resampling.LANCZOS)

    # Subtle sharpening for tiny previews (large flat areas stay smooth due to threshold)
    if max(tw, th) <= 64:
        out = out.filter(
            ImageFilter.UnsharpMask(radius=0.35, percent=90, threshold=4)
        )
    return out


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    src = root / "img" / "store_images" / "icon.png"
    if not src.is_file():
        print(f"Missing icon source: {src}", file=sys.stderr)
        sys.exit(1)

    out_dir = root / "build" / "pyinstaller"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "app.ico"

    img = Image.open(src).convert("RGBA")
    # Order: Windows often picks 16/32/48/256; include common DPI steps
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    images = [resize_sharp_for_ico(img, s) for s in sizes]
    images[0].save(
        out,
        format="ICO",
        sizes=[(im.width, im.height) for im in images],
        append_images=images[1:],
    )
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
