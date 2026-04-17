#!/usr/bin/env python3
"""Build a multi-size Windows .ico from img/store_images/icon.png for PyInstaller."""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageFilter
    from PIL._binary import o8, o16le as o16, o32le as o32
except ImportError as exc:  # pragma: no cover - build-time only
    raise SystemExit("Install Pillow: pip install pillow") from exc


def write_ico_png_frames(path: Path, frames: list[Image.Image]) -> None:
    """
    Write a multi-resolution ICO with PNG-compressed images.

    Pillow's ICO saver skips entries larger than 256×256, so 512×512 never appears
    (see IcoImagePlugin._save). Windows accepts PNG payloads with 0×0 directory
    entries for 256+; actual dimensions come from the PNG data.
    """
    from io import BytesIO

    with path.open("wb") as fp:
        fp.write(b"\0\0\1\0")
        fp.write(o16(len(frames)))
        offset = fp.tell() + len(frames) * 16
        for frame in frames:
            width, height = frame.size
            fp.write(o8(width if width < 256 else 0))
            fp.write(o8(height if height < 256 else 0))
            fp.write(o8(0))
            fp.write(b"\0")
            fp.write(b"\0\0")
            fp.write(o16(32))
            image_io = BytesIO()
            frame.save(image_io, "png")
            image_io.seek(0)
            image_bytes = image_io.read()
            bytes_len = len(image_bytes)
            fp.write(o32(bytes_len))
            fp.write(o32(offset))
            current = fp.tell()
            fp.seek(offset)
            fp.write(image_bytes)
            offset += bytes_len
            fp.seek(current)


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
    # Multi-size ICO for Explorer / taskbar; 512×512 for large icon views (Windows 10+).
    sizes = [
        (16, 16),
        (24, 24),
        (32, 32),
        (48, 48),
        (64, 64),
        (128, 128),
        (256, 256),
        (512, 512),
    ]
    images = [resize_sharp_for_ico(img, s) for s in sizes]
    write_ico_png_frames(out, images)
    # Standalone 512×512 asset (installers, docs, or tools that want a flat PNG)
    images[-1].save(out_dir / "app_icon_512.png", format="PNG")
    print(f"Wrote {out} and {out_dir / 'app_icon_512.png'}")


if __name__ == "__main__":
    main()
