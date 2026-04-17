#!/usr/bin/env python3
"""Build a multi-size Windows .ico from img/store_images/icon.png for PyInstaller."""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover - build-time only
    raise SystemExit("Install Pillow: pip install pillow") from exc


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
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    images = [img.resize(s, Image.Resampling.LANCZOS) for s in sizes]
    images[0].save(
        out,
        format="ICO",
        sizes=[(im.width, im.height) for im in images],
        append_images=images[1:],
    )
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
