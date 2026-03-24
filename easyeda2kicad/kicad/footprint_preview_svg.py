"""Render KiFootprint pads and fab/silk lines as a compact SVG (Y-flipped for screen)."""

from __future__ import annotations

import html
import math
import re
from dataclasses import dataclass

from easyeda2kicad.kicad.parameters_kicad_footprint import (
    KiFootprint,
    KiFootprintHole,
    KiFootprintPad,
)

_XY_RE = re.compile(r"\(\s*xy\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s*\)", re.IGNORECASE)

# Footprint preview: solid copper (extension hover/focus/map-fill via CSS `fill` overrides).
PAD_PREVIEW_FILL = "#dc2626"
PAD_PREVIEW_NUM_FILL = "#ffffff"
_DRILL_OVAL_RE = re.compile(
    r"\(\s*drill\s+oval\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s*\)",
    re.IGNORECASE,
)
_DRILL_CIRCLE_RE = re.compile(
    r"\(\s*drill\s+([-+]?\d*\.?\d+)\s*\)",
    re.IGNORECASE,
)


@dataclass
class _BBox:
    min_x: float = math.inf
    max_x: float = -math.inf
    min_y: float = math.inf
    max_y: float = -math.inf

    def add_point(self, x: float, y: float) -> None:
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


def _to_svg(x: float, y: float, bbox: _BBox) -> tuple[float, float]:
    """Map KiCad mm to SVG user units. *bbox* must already include desired margin via `bbox.pad()`."""
    sx = x - bbox.min_x
    sy = bbox.max_y - y
    return sx, sy


def _pad_orientation_deg(p: KiFootprintPad) -> float:
    o = p.orientation
    if o is None or o == "":
        return 0.0
    try:
        return float(o)
    except (TypeError, ValueError):
        return 0.0


def _parse_pad_drill(
    drill: str,
) -> tuple[str, float, float] | None:
    """
    Parse KiCad ``(drill …)`` fragment from ``KiFootprintPad.drill``.
    Returns (kind, a, b): kind ``circle`` → a is diameter; kind ``oval`` → a,b are oval sizes (mm).
    """
    d = (drill or "").strip()
    if not d:
        return None
    mo = _DRILL_OVAL_RE.search(d)
    if mo:
        return ("oval", float(mo.group(1)), float(mo.group(2)))
    mc = _DRILL_CIRCLE_RE.search(d)
    if mc:
        dia = float(mc.group(1))
        return ("circle", dia, dia)
    return None


def _custom_pad_polygon_points(p: KiFootprintPad) -> list[tuple[float, float]] | None:
    """Absolute footprint coords (mm) for a custom (gr_poly) pad, or None."""
    poly = p.polygon or ""
    if not poly.strip():
        return None
    rel: list[tuple[float, float]] = []
    for m in _XY_RE.finditer(poly):
        rel.append((float(m.group(1)), float(m.group(2))))
    if len(rel) < 3:
        return None
    cx, cy = p.pos_x, p.pos_y
    return [(cx + rx, cy + ry) for rx, ry in rel]


def _kicad_roundrect_radius_mm(w: float, h: float, rratio: float) -> float:
    """Physical corner radius from KiCad ``roundrect_rratio`` (same rule as KiCad)."""
    cap = min(w, h) / 2.0
    if cap <= 0:
        return 0.0
    r = max(0.0, min(1.0, rratio)) * cap
    return min(r, cap * 0.9999)


def _pad_number_font_size_mm(width: float, height: float, label: str) -> float:
    """
    Font size in mm (SVG user units = footprint mm) so pad numbers fit inside the pad.

    Driven by the shorter in-pad dimension (vertical fit) and the longer side divided by
    character count (horizontal fit). Clamped so tiny pads stay legible at typical preview scales.
    """
    w0 = max(float(width), 0.04)
    h0 = max(float(height), 0.04)
    short = min(w0, h0)
    long_side = max(w0, h0)
    raw = (label or "").strip() or "?"
    n = len(raw)
    # Cap height ~0.74em for typical tabular digits; keep within ~88% of short side.
    cap_ratio = 0.74
    margin_short = 0.88
    fs_from_height = (short * margin_short) / cap_ratio
    # Average glyph width ~0.52em; small padding term so single-digit pads use long side a bit.
    em_w = 0.52
    pad_w = 0.22
    fs_from_width = long_side / max(n * em_w + pad_w, 0.75)
    fs = min(fs_from_height, fs_from_width)
    return max(0.075, min(fs, 1.05))


def _chamfrect_cut(
    half_short: float, chamfer_ratio: float, half_w: float, half_h: float
) -> float:
    raw = max(0.0, min(1.0, chamfer_ratio)) * half_short
    cap = max(1e-6, min(half_w, half_h) - 1e-6)
    return min(raw, cap)


def _chamfrect_mm_outline(
    cx: float,
    cy: float,
    w: float,
    h: float,
    ctl: float,
    ctr: float,
    cbr: float,
    cbl: float,
) -> list[tuple[float, float]]:
    """Closed CCW outline in footprint mm (Y-up), before rotation."""
    half_w, half_h = w / 2.0, h / 2.0
    hs = min(w, h) / 2.0
    dtl = _chamfrect_cut(hs, ctl, half_w, half_h)
    dtr = _chamfrect_cut(hs, ctr, half_w, half_h)
    dbr = _chamfrect_cut(hs, cbr, half_w, half_h)
    dbl = _chamfrect_cut(hs, cbl, half_w, half_h)
    x0, x1 = cx - half_w, cx + half_w
    y0, y1 = cy - half_h, cy + half_h
    return [
        (x0 + dbl, y0),
        (x1 - dbr, y0),
        (x1, y0 + dbr),
        (x1, y1 - dtr),
        (x1 - dtr, y1),
        (x0 + dtl, y1),
        (x0, y1 - dtl),
        (x0, y0 + dbl),
    ]


def _rotate_pts_about(
    pts: list[tuple[float, float]], cx: float, cy: float, deg: float
) -> list[tuple[float, float]]:
    if not deg:
        return pts
    rad = math.radians(deg)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    out: list[tuple[float, float]] = []
    for x, y in pts:
        dx, dy = x - cx, y - cy
        out.append((dx * cos_a - dy * sin_a + cx, dx * sin_a + dy * cos_a + cy))
    return out


def _footprint_poly_path_svg(pts: list[tuple[float, float]], bbox: _BBox, fill: str) -> str:
    d_parts: list[str] = []
    for i, (x, y) in enumerate(pts):
        sx, sy = _to_svg(x, y, bbox)
        d_parts.append(f"{'M' if i == 0 else 'L'}{sx:.3f} {sy:.3f}")
    d_parts.append("Z")
    return (
        f'<path d="{" ".join(d_parts)}" fill="{fill}" stroke="none" '
        f'shape-rendering="geometricPrecision" pointer-events="fill"/>'
    )


def _rotated_rect_corners(
    cx: float, cy: float, w: float, h: float, deg: float
) -> list[tuple[float, float]]:
    rad = math.radians(deg)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    corners = [
        (-w / 2, -h / 2),
        (w / 2, -h / 2),
        (w / 2, h / 2),
        (-w / 2, h / 2),
    ]
    out: list[tuple[float, float]] = []
    for dx, dy in corners:
        rx = dx * cos_a - dy * sin_a + cx
        ry = dx * sin_a + dy * cos_a + cy
        out.append((rx, ry))
    return out


def _hole_svg(h: KiFootprintHole, bbox: _BBox) -> str:
    r = max(h.size / 2, 0.02)
    cx, cy = _to_svg(h.pos_x, h.pos_y, bbox)
    # NPTH / mounting hole — distinct from copper
    return (
        f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{r:.3f}" fill="#cbd5e1" '
        f'stroke="#475569" stroke-width="0.1" class="k2c-fp-npth" pointer-events="none"/>'
    )


def _pad_svg(p: KiFootprintPad, bbox: _BBox) -> str:
    w = max(p.width, 0.05)
    h = max(p.height, 0.05)
    cx, cy = p.pos_x, p.pos_y
    deg = _pad_orientation_deg(p)
    fill = PAD_PREVIEW_FILL
    num_raw = str(p.number).strip()[:32] or "?"
    num_txt = html.escape(num_raw, quote=False)
    num_attr = html.escape(num_raw, quote=True)
    tcx, tcy = _to_svg(cx, cy, bbox)
    num_fs = _pad_number_font_size_mm(w, h, num_raw)
    fw = "700" if num_fs >= 0.32 else "600"

    shape = (p.shape or "rect").lower()
    is_th = (p.type or "").lower() == "thru_hole"
    drill_parsed = _parse_pad_drill(p.drill) if is_th else None
    if is_th and drill_parsed is None:
        # Plated hole without a parseable drill string — show a plausible inner opening
        approx = max(0.25, min(w, h) * 0.42)
        drill_parsed = ("circle", approx, approx)

    parts: list[str] = []

    custom_pts = _custom_pad_polygon_points(p) if shape == "custom" else None
    if custom_pts:
        svg_pts = " ".join(
            f"{_to_svg(px, py, bbox)[0]:.3f},{_to_svg(px, py, bbox)[1]:.3f}"
            for px, py in custom_pts
        )
        parts.append(
            f'<polygon points="{svg_pts}" fill="{fill}" stroke="none" '
            f'pointer-events="fill"/>'
        )
    elif shape in ("circle", "oval", "ellipse"):
        rx, ry = w / 2, h / 2
        tr = f' transform="rotate({deg:.2f} {tcx:.3f} {tcy:.3f})"' if deg else ""
        parts.append(
            f'<ellipse cx="{tcx:.3f}" cy="{tcy:.3f}" rx="{rx:.3f}" ry="{ry:.3f}"{tr} '
            f'fill="{fill}" stroke="none" shape-rendering="geometricPrecision" '
            f'pointer-events="fill"/>'
        )
    elif shape == "roundrect":
        rratio = float(getattr(p, "roundrect_rratio", 0) or 0)
        r_mm = _kicad_roundrect_radius_mm(w, h, rratio)
        corners_ki = [
            (cx - w / 2, cy - h / 2),
            (cx + w / 2, cy - h / 2),
            (cx + w / 2, cy + h / 2),
            (cx - w / 2, cy + h / 2),
        ]
        sxys = [_to_svg(px, py, bbox) for px, py in corners_ki]
        min_x = min(t[0] for t in sxys)
        max_x = max(t[0] for t in sxys)
        min_y = min(t[1] for t in sxys)
        max_y = max(t[1] for t in sxys)
        rw = max_x - min_x
        rh = max_y - min_y
        rx = min(max(r_mm, 0), rw / 2, rh / 2)
        tr = f' transform="rotate({deg:.2f} {tcx:.3f} {tcy:.3f})"' if deg else ""
        parts.append(
            f'<rect x="{min_x:.3f}" y="{min_y:.3f}" width="{rw:.3f}" height="{rh:.3f}" '
            f'rx="{rx:.3f}" ry="{rx:.3f}"{tr} fill="{fill}" stroke="none" '
            f'shape-rendering="geometricPrecision" pointer-events="fill"/>'
        )
    elif shape == "chamfrect":
        ctl = float(getattr(p, "chamfer_tl", 0) or 0)
        ctr = float(getattr(p, "chamfer_tr", 0) or 0)
        cbr = float(getattr(p, "chamfer_br", 0) or 0)
        cbl = float(getattr(p, "chamfer_bl", 0) or 0)
        outline = _chamfrect_mm_outline(cx, cy, w, h, ctl, ctr, cbr, cbl)
        outline = _rotate_pts_about(outline, cx, cy, deg)
        parts.append(_footprint_poly_path_svg(outline, bbox, fill))
    else:
        corners = _rotated_rect_corners(cx, cy, w, h, deg)
        svg_pts = " ".join(
            f"{_to_svg(px, py, bbox)[0]:.3f},{_to_svg(px, py, bbox)[1]:.3f}"
            for px, py in corners
        )
        parts.append(
            f'<polygon points="{svg_pts}" fill="{fill}" stroke="none" pointer-events="fill"/>'
        )

    if is_th and drill_parsed:
        kind, a, b = drill_parsed
        hole_fill = "#f8fafc"
        hole_stroke = "#475569"
        if kind == "circle":
            dia = max(a, 0.05)
            rr = dia / 2
            parts.append(
                f'<circle cx="{tcx:.3f}" cy="{tcy:.3f}" r="{rr:.3f}" fill="{hole_fill}" '
                f'stroke="{hole_stroke}" stroke-width="0.1" class="k2c-fp-drill" '
                f'pointer-events="none"/>'
            )
        else:
            rx, ry = max(a, 0.05) / 2, max(b, 0.05) / 2
            tr = f' transform="rotate({deg:.2f} {tcx:.3f} {tcy:.3f})"' if deg else ""
            parts.append(
                f'<ellipse cx="{tcx:.3f}" cy="{tcy:.3f}" rx="{rx:.3f}" ry="{ry:.3f}"{tr} '
                f'fill="{hole_fill}" stroke="{hole_stroke}" stroke-width="0.1" '
                f'class="k2c-fp-drill" pointer-events="none"/>'
            )

    inner = "".join(parts)
    return (
        f'<g class="k2c-fp-pad" data-pad="{num_attr}" role="graphics-symbol" '
        f'aria-label="Pad {num_txt}">'
        f"{inner}"
        f'<text class="k2c-fp-pad-num" x="{tcx:.3f}" y="{tcy:.3f}" '
        f'font-size="{num_fs:.3f}" font-weight="{fw}" fill="{PAD_PREVIEW_NUM_FILL}" '
        f'font-family="Segoe UI,Roboto,Helvetica,Arial,sans-serif" pointer-events="none" '
        f'text-anchor="middle" dominant-baseline="middle" '
        f'text-rendering="geometricPrecision">{num_txt}</text>'
        f"</g>"
    )


def _pad_ink_bounds(p: KiFootprintPad) -> list[tuple[float, float]]:
    """Corner points in footprint mm for viewBox padding."""
    w = max(p.width, 0.05)
    h = max(p.height, 0.05)
    cx, cy = p.pos_x, p.pos_y
    deg = _pad_orientation_deg(p)
    shape = (p.shape or "rect").lower()
    custom_pts = _custom_pad_polygon_points(p) if shape == "custom" else None
    if custom_pts:
        return custom_pts
    if shape in ("circle", "oval", "ellipse"):
        rx, ry = w / 2, h / 2
        # Axis-aligned bbox of rotated ellipse
        rad = math.radians(deg)
        c, s = abs(math.cos(rad)), abs(math.sin(rad))
        bw = rx * c + ry * s
        bh = rx * s + ry * c
        return [
            (cx - bw, cy - bh),
            (cx + bw, cy - bh),
            (cx + bw, cy + bh),
            (cx - bw, cy + bh),
        ]
    if shape == "chamfrect":
        ctl = float(getattr(p, "chamfer_tl", 0) or 0)
        ctr = float(getattr(p, "chamfer_tr", 0) or 0)
        cbr = float(getattr(p, "chamfer_br", 0) or 0)
        cbl = float(getattr(p, "chamfer_bl", 0) or 0)
        outline = _chamfrect_mm_outline(cx, cy, w, h, ctl, ctr, cbr, cbl)
        outline = _rotate_pts_about(outline, cx, cy, deg)
        return outline
    return _rotated_rect_corners(cx, cy, w, h, deg)


def ki_footprint_to_preview_svg(
    ki: KiFootprint,
    *,
    width_px: int = 220,
    height_px: int = 220,
    pad_mm: float = 0.5,
) -> tuple[str | None, dict]:
    """Build SVG preview; pads labeled with number. Returns (svg, meta or error dict)."""
    bbox = _BBox()
    for p in ki.pads:
        for px, py in _pad_ink_bounds(p):
            bbox.add_point(px, py)
        if (p.type or "").lower() == "thru_hole":
            dp = _parse_pad_drill(p.drill)
            if dp:
                kind, a, b = dp
                if kind == "circle":
                    r = max(a, 0.05) / 2
                    bbox.add_point(p.pos_x - r, p.pos_y - r)
                    bbox.add_point(p.pos_x + r, p.pos_y + r)
                else:
                    rx, ry = max(a, 0.05) / 2, max(b, 0.05) / 2
                    rad = math.radians(_pad_orientation_deg(p))
                    c, s = abs(math.cos(rad)), abs(math.sin(rad))
                    bw = rx * c + ry * s
                    bh = rx * s + ry * c
                    bbox.add_point(p.pos_x - bw, p.pos_y - bh)
                    bbox.add_point(p.pos_x + bw, p.pos_y + bh)

    for h in ki.holes:
        r = max(h.size / 2, 0.02)
        bbox.add_point(h.pos_x - r, h.pos_y - r)
        bbox.add_point(h.pos_x + r, h.pos_y + r)

    for tr in ki.tracks:
        if "Fab" not in tr.layers and "SilkS" not in tr.layers:
            continue
        for i in range(len(tr.points_start_x)):
            bbox.add_point(tr.points_start_x[i], tr.points_start_y[i])
            bbox.add_point(tr.points_end_x[i], tr.points_end_y[i])

    if not bbox.valid():
        return None, {"error": "empty_footprint"}

    bbox.pad(pad_mm)
    w_mm = bbox.max_x - bbox.min_x
    h_mm = bbox.max_y - bbox.min_y
    parts: list[str] = []

    for tr in ki.tracks:
        if "Fab" not in tr.layers and "SilkS" not in tr.layers:
            continue
        stroke = "#64748b" if "SilkS" in tr.layers else "#94a3b8"
        for i in range(len(tr.points_start_x)):
            x1, y1 = _to_svg(tr.points_start_x[i], tr.points_start_y[i], bbox)
            x2, y2 = _to_svg(tr.points_end_x[i], tr.points_end_y[i], bbox)
            parts.append(
                f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}" '
                f'stroke="{stroke}" stroke-width="0.08"/>'
            )

    for h in ki.holes:
        parts.append(_hole_svg(h, bbox))

    for p in ki.pads:
        svg = _pad_svg(p, bbox)
        if svg:
            parts.append(svg)

    inner = "\n  ".join(parts)
    # Intrinsic width/height must match viewBox aspect ratio. A fixed square (e.g. 220×220) with a
    # non-square viewBox confuses CSS sizing (flex + max-height), so painted geometry and pointer
    # hits diverge in the extension’s inline SVG.
    max_dim = max(int(width_px), int(height_px))
    ar_vb = (w_mm / h_mm) if h_mm > 1e-9 else 1.0
    if ar_vb >= 1.0:
        out_w = max_dim
        out_h = max(1, int(round(max_dim / ar_vb)))
    else:
        out_h = max_dim
        out_w = max(1, int(round(max_dim * ar_vb)))
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w_mm:.3f} {h_mm:.3f}" '
        f'preserveAspectRatio="xMidYMid meet" '
        f'width="{out_w}" height="{out_h}" role="img" aria-label="Footprint preview">\n'
        f"  {inner}\n</svg>"
    )
    return svg, {"view_w_mm": w_mm, "view_h_mm": h_mm}
