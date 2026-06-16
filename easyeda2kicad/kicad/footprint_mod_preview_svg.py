"""
Render an existing KiCad ``.kicad_mod`` footprint file as a compact SVG preview.

The symbol-side analogue is ``symbol_preview_svg.py``. Unlike
``footprint_preview_svg.ki_footprint_to_preview_svg`` (which renders the
EasyEDA-built ``KiFootprint`` dataclass), this parses a real KiCad footprint
S-expression directly, so a **template** ``.kicad_mod`` can be previewed without
a lossy round-trip through the EasyEDA-oriented exporter model.

Scope: pads (rect / roundrect / oval / circle, SMD + through-hole drills) and
silk / fab outline graphics (``fp_line`` / ``fp_circle``). Coordinates are KiCad
mm (Y up); the SVG flips Y for screen and uses a mm-space ``viewBox`` so the
caller's px box scales it via ``preserveAspectRatio``.
"""
from __future__ import annotations

import html
import math
import re

_MAX_MOD_CHARS = 512_000
_MAX_PADS = 2048
_MAX_OUTLINE = 4096

_NUM = r"[-+]?\d*\.?\d+"
_AT_RE = re.compile(rf"\(\s*at\s+({_NUM})\s+({_NUM})(?:\s+({_NUM}))?", re.IGNORECASE)
_SIZE_RE = re.compile(rf"\(\s*size\s+({_NUM})\s+({_NUM})", re.IGNORECASE)
_RRATIO_RE = re.compile(rf"\(\s*roundrect_rratio\s+({_NUM})", re.IGNORECASE)
_DRILL_OVAL_RE = re.compile(rf"\(\s*drill\s+oval\s+({_NUM})\s+({_NUM})", re.IGNORECASE)
_DRILL_RE = re.compile(rf"\(\s*drill\s+({_NUM})", re.IGNORECASE)
_PAD_HEAD_RE = re.compile(
    r'\(\s*pad\s+(?:"([^"]*)"|(\S+))\s+(\w+)\s+(\w+)', re.IGNORECASE
)
_START_RE = re.compile(rf"\(\s*start\s+({_NUM})\s+({_NUM})", re.IGNORECASE)
_END_RE = re.compile(rf"\(\s*end\s+({_NUM})\s+({_NUM})", re.IGNORECASE)
_CENTER_RE = re.compile(rf"\(\s*center\s+({_NUM})\s+({_NUM})", re.IGNORECASE)
_LAYER_RE = re.compile(r'\(\s*layers?\s+([^)]*)\)', re.IGNORECASE)

_PAD_FILL = "#dc2626"
_PAD_NUM_FILL = "#ffffff"
_DRILL_FILL = "#1e293b"
_SILK_STROKE = "#64748b"
_FAB_STROKE = "#94a3b8"


class _BBox:
    def __init__(self) -> None:
        self.min_x = math.inf
        self.max_x = -math.inf
        self.min_y = math.inf
        self.max_y = -math.inf

    def add(self, x: float, y: float) -> None:
        self.min_x = min(self.min_x, x)
        self.max_x = max(self.max_x, x)
        self.min_y = min(self.min_y, y)
        self.max_y = max(self.max_y, y)

    def pad(self, p: float) -> None:
        if self.min_x is math.inf:
            return
        self.min_x -= p
        self.max_x += p
        self.min_y -= p
        self.max_y += p

    def valid(self) -> bool:
        return self.min_x is not math.inf


def _iter_blocks(text: str, tag: str):
    """Yield each balanced ``(tag …)`` block (string-aware paren matching)."""
    pat = re.compile(rf"\(\s*{re.escape(tag)}[\s)]", re.IGNORECASE)
    i = 0
    n = len(text)
    while True:
        m = pat.search(text, i)
        if not m:
            return
        start = m.start()
        depth = 0
        in_str = False
        j = start
        while j < n:
            c = text[j]
            if in_str:
                if c == '"' and text[j - 1] != "\\":
                    in_str = False
            elif c == '"':
                in_str = True
            elif c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    yield text[start : j + 1]
                    break
            j += 1
        i = j + 1 if j < n else n


def _f(v: str | None, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _parse_pads(text: str) -> list[dict]:
    pads: list[dict] = []
    for block in _iter_blocks(text, "pad"):
        if len(pads) >= _MAX_PADS:
            break
        head = _PAD_HEAD_RE.search(block)
        if not head:
            continue
        number = head.group(1) if head.group(1) is not None else head.group(2)
        ptype = head.group(3).lower()
        shape = head.group(4).lower()
        at = _AT_RE.search(block)
        if not at:
            continue
        x, y = _f(at.group(1)), _f(at.group(2))
        rot = _f(at.group(3))
        size = _SIZE_RE.search(block)
        w = _f(size.group(1), 0.5) if size else 0.5
        h = _f(size.group(2), 0.5) if size else 0.5
        rratio_m = _RRATIO_RE.search(block)
        rratio = _f(rratio_m.group(1)) if rratio_m else (0.25 if shape == "roundrect" else 0.0)
        drill = 0.0
        drill_oval = _DRILL_OVAL_RE.search(block)
        if drill_oval:
            drill = min(_f(drill_oval.group(1)), _f(drill_oval.group(2)))
        else:
            drill_m = _DRILL_RE.search(block)
            if drill_m:
                drill = _f(drill_m.group(1))
        pads.append(
            {
                "number": number or "",
                "type": ptype,
                "shape": shape,
                "x": x,
                "y": y,
                "rot": rot,
                "w": max(w, 0.05),
                "h": max(h, 0.05),
                "rratio": rratio,
                "drill": drill,
            }
        )
    return pads


def _block_on_outline_layer(block: str) -> str | None:
    """Return 'silk' / 'fab' if the graphic sits on a silk or fab layer, else None."""
    m = _LAYER_RE.search(block)
    layers = m.group(1) if m else block
    up = layers
    if "SilkS" in up:
        return "silk"
    if "Fab" in up:
        return "fab"
    return None


def _parse_outline(text: str) -> list[dict]:
    out: list[dict] = []
    for block in _iter_blocks(text, "fp_line"):
        if len(out) >= _MAX_OUTLINE:
            break
        kind = _block_on_outline_layer(block)
        if not kind:
            continue
        s = _START_RE.search(block)
        e = _END_RE.search(block)
        if not s or not e:
            continue
        out.append(
            {
                "type": "line",
                "layer": kind,
                "x1": _f(s.group(1)),
                "y1": _f(s.group(2)),
                "x2": _f(e.group(1)),
                "y2": _f(e.group(2)),
            }
        )
    for block in _iter_blocks(text, "fp_circle"):
        if len(out) >= _MAX_OUTLINE:
            break
        kind = _block_on_outline_layer(block)
        if not kind:
            continue
        c = _CENTER_RE.search(block)
        e = _END_RE.search(block)
        if not c or not e:
            continue
        cx, cy = _f(c.group(1)), _f(c.group(2))
        ex, ey = _f(e.group(1)), _f(e.group(2))
        out.append(
            {
                "type": "circle",
                "layer": kind,
                "cx": cx,
                "cy": cy,
                "r": math.hypot(ex - cx, ey - cy),
            }
        )
    return out


def _to_svg(x: float, y: float, bbox: _BBox) -> tuple[float, float]:
    return x - bbox.min_x, bbox.max_y - y


def kicad_mod_to_preview_svg(
    mod_text: str,
    *,
    width_px: int = 220,
    height_px: int = 220,
) -> tuple[str, dict] | tuple[None, dict]:
    """Convert a KiCad ``.kicad_mod`` footprint string to an SVG preview string.

    Returns ``(svg, meta)`` with view metrics, or ``(None, {"error": "..."})``
    when the footprint is empty / too large / unparseable.
    """
    if not mod_text or len(mod_text) > _MAX_MOD_CHARS:
        return None, {"error": "footprint_too_large"}

    pads = _parse_pads(mod_text)
    outline = _parse_outline(mod_text)
    if not pads and not outline:
        return None, {"error": "empty_footprint"}

    bbox = _BBox()
    for p in pads:
        hw = p["w"] / 2
        hh = p["h"] / 2
        # Rotation-aware extent so rotated pads do not clip.
        rad = math.radians(p["rot"])
        ex = abs(hw * math.cos(rad)) + abs(hh * math.sin(rad))
        ey = abs(hw * math.sin(rad)) + abs(hh * math.cos(rad))
        bbox.add(p["x"] - ex, p["y"] - ey)
        bbox.add(p["x"] + ex, p["y"] + ey)
    for o in outline:
        if o["type"] == "line":
            bbox.add(o["x1"], o["y1"])
            bbox.add(o["x2"], o["y2"])
        else:
            bbox.add(o["cx"] - o["r"], o["cy"] - o["r"])
            bbox.add(o["cx"] + o["r"], o["cy"] + o["r"])

    if not bbox.valid():
        return None, {"error": "empty_footprint"}

    bbox.pad(0.4)
    w_mm = max(bbox.max_x - bbox.min_x, 0.1)
    h_mm = max(bbox.max_y - bbox.min_y, 0.1)

    parts: list[str] = []

    for o in outline:
        stroke = _SILK_STROKE if o["layer"] == "silk" else _FAB_STROKE
        if o["type"] == "line":
            x1, y1 = _to_svg(o["x1"], o["y1"], bbox)
            x2, y2 = _to_svg(o["x2"], o["y2"], bbox)
            parts.append(
                f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}" '
                f'stroke="{stroke}" stroke-width="0.08" stroke-linecap="round"/>'
            )
        else:
            cx, cy = _to_svg(o["cx"], o["cy"], bbox)
            parts.append(
                f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{o["r"]:.3f}" '
                f'fill="none" stroke="{stroke}" stroke-width="0.08"/>'
            )

    for p in pads:
        cx, cy = _to_svg(p["x"], p["y"], bbox)
        w, h = p["w"], p["h"]
        shape = p["shape"]
        # KiCad rotation is CCW in Y-up space; SVG is Y-down → negate.
        rot_attr = (
            f' transform="rotate({-p["rot"]:.3f} {cx:.3f} {cy:.3f})"'
            if p["rot"]
            else ""
        )
        if shape == "circle":
            parts.append(
                f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{w / 2:.3f}" fill="{_PAD_FILL}"/>'
            )
        else:
            if shape == "oval":
                rr = min(w, h) / 2
            elif shape == "roundrect":
                rr = max(p["rratio"], 0.0) * min(w, h)
            else:
                rr = 0.0
            parts.append(
                f'<rect x="{cx - w / 2:.3f}" y="{cy - h / 2:.3f}" '
                f'width="{w:.3f}" height="{h:.3f}" rx="{rr:.3f}" ry="{rr:.3f}" '
                f'fill="{_PAD_FILL}"{rot_attr}/>'
            )
        if p["drill"] > 0:
            parts.append(
                f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{p["drill"] / 2:.3f}" '
                f'fill="{_DRILL_FILL}"/>'
            )
        num = html.escape(str(p["number"]))[:8]
        if num:
            fs = max(min(w, h) * 0.5, 0.3)
            parts.append(
                f'<text x="{cx:.3f}" y="{cy:.3f}" font-size="{fs:.3f}" '
                f'fill="{_PAD_NUM_FILL}" text-anchor="middle" '
                f'dominant-baseline="central">{num}</text>'
            )

    inner = "\n  ".join(parts)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{int(width_px)}" '
        f'height="{int(height_px)}" viewBox="0 0 {w_mm:.3f} {h_mm:.3f}" '
        f'preserveAspectRatio="xMidYMid meet">\n  {inner}\n</svg>'
    )
    return svg, {
        "view_w_mm": w_mm,
        "view_h_mm": h_mm,
        "pad_count": len(pads),
        "outline_count": len(outline),
    }
