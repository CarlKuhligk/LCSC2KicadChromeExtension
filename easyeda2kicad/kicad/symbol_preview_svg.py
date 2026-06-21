"""
Render a modern KiCad symbol unit (e.g. ``Name_0_1`` in ``.kicad_sym``) as a compact SVG preview.

Targets **KiCad 9+** symbol libraries (e.g. 9.x, 10); coordinates follow KiCad symbol space (Y up) and the
SVG output uses Y down via the bbox transform.
"""
from __future__ import annotations

import html
import math
import re
from dataclasses import dataclass
from typing import Literal

from easyeda2kicad.kicad.template_merger import _collect_sexpr_block

_MAX_SYMBOL_CHARS = 512_000
# Body graphics vs pins: old single cap could skip pins on busy symbols.
_MAX_BODY_ITEMS = 800
_MAX_PIN_ITEMS = 512


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

    def add_rect(self, x0: float, y0: float, x1: float, y1: float) -> None:
        self.add_point(x0, y0)
        self.add_point(x1, y1)

    def pad(self, p: float) -> None:
        if self.min_x is math.inf:
            return
        self.min_x -= p
        self.max_x += p
        self.min_y -= p
        self.max_y += p

    def valid(self) -> bool:
        return self.min_x is not math.inf


def _iter_tag_blocks(body: str, tag: str, max_blocks: int):
    """Yield each balanced ``(tag …)`` s-expression at this nesting level (scan linearly)."""
    pat = re.compile(rf"\(\s*{re.escape(tag)}\s+", re.IGNORECASE)
    i = 0
    n = 0
    while n < max_blocks:
        m = pat.search(body, i)
        if not m:
            break
        block, end = _collect_sexpr_block(body, m.start())
        yield block
        i = end
        n += 1


@dataclass
class _SvgMapper:
    """Maps KiCad symbol coords (Y up) to SVG user units (Y down), with symmetric margin."""

    min_x: float
    max_y: float
    margin: float

    def xy(self, x: float, y: float) -> tuple[float, float]:
        sx = x - self.min_x + self.margin
        sy = self.max_y - y + self.margin
        return sx, sy


@dataclass
class _DrawBounds:
    """SVG user-space bounds of drawn ink (for a tight, origin-normalized viewBox)."""

    min_x: float = math.inf
    max_x: float = -math.inf
    min_y: float = math.inf
    max_y: float = -math.inf

    def add_point(self, x: float, y: float, r: float = 0.0) -> None:
        self.min_x = min(self.min_x, x - r)
        self.max_x = max(self.max_x, x + r)
        self.min_y = min(self.min_y, y - r)
        self.max_y = max(self.max_y, y + r)

    def add_rect_xy(self, xa: float, ya: float, xb: float, yb: float, pad: float = 0.0) -> None:
        self.add_point(xa, ya, pad)
        self.add_point(xb, yb, pad)

    def add_polyline(self, pts: list[tuple[float, float]], r: float) -> None:
        for px, py in pts:
            self.add_point(px, py, r)

    def add_text_middle(self, x: float, y: float, font_mm: float, text: str) -> None:
        n = max(1, min(len(text), 8))
        hw = font_mm * 0.52 * min(n, 6)
        hh = font_mm * 0.65
        self.add_rect_xy(x - hw, y - hh, x + hw, y + hh, 0.0)

    def valid(self) -> bool:
        return self.min_x is not math.inf

    def width(self) -> float:
        return max(0.0, self.max_x - self.min_x)

    def height(self) -> float:
        return max(0.0, self.max_y - self.min_y)


def _pin_endpoint(
    x: float, y: float, angle_deg: float, length: float
) -> tuple[float, float]:
    """
    Inner (symbol-body) end of the pin shaft, in KiCad symbol coords (Y up).

    ``(at x y angle)`` is the **schematic wire attachment** (outside). The pin runs from
    that point **into** the symbol for ``length`` mm along ``angle`` (degrees, 0 = +X).
    """
    rad = math.radians(angle_deg)
    return x + length * math.cos(rad), y + length * math.sin(rad)


# Modern KiCad symbol pin (6–10+): (pin <electrical> <graphic> (at x y [angle]) (length L) (name …) (number …))
_PIN_NAME_RE = re.compile(r"\(\s*name\s+\"([^\"]*)\"", re.IGNORECASE)
_PIN_NUMBER_RE = re.compile(r"\(\s*number\s+\"([^\"]*)\"", re.IGNORECASE)


def _pin_name_and_number(pin_block: str) -> tuple[str, str]:
    """Extract visible pin name and number strings from a (pin …) s-expression."""
    nm = _PIN_NAME_RE.search(pin_block)
    num = _PIN_NUMBER_RE.search(pin_block)
    name = (nm.group(1) if nm else "").strip()
    number = (num.group(1) if num else "").strip()
    return name, number


def _pin_label_hide_flags(pin_block: str) -> tuple[bool, bool]:
    """
    KiCad stores per-label visibility as ``(name \"…\" (effects … (hide yes)))`` /
    ``(number …)``. When set, that label is not shown on the schematic — preview should
    match (pin shaft graphics are still drawn).
    """
    hide_name = False
    hide_num = False
    m = re.search(r"\(\s*name\s+\"", pin_block, re.IGNORECASE)
    if m:
        sub, _ = _collect_sexpr_block(pin_block, m.start())
        hide_name = bool(re.search(r"\(\s*hide\s+yes\s*\)", sub, re.IGNORECASE))
    m = re.search(r"\(\s*number\s+\"", pin_block, re.IGNORECASE)
    if m:
        sub, _ = _collect_sexpr_block(pin_block, m.start())
        hide_num = bool(re.search(r"\(\s*hide\s+yes\s*\)", sub, re.IGNORECASE))
    return hide_name, hide_num


# Floats in pin blocks (allows scientific notation; skips unrelated ``(at …)`` in nested effects).
_PIN_FLOAT = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
_RE_PIN_AT_3 = re.compile(
    rf"\(\s*at\s+({_PIN_FLOAT})\s+({_PIN_FLOAT})\s+({_PIN_FLOAT})\s*\)",
    re.IGNORECASE | re.DOTALL,
)
_RE_PIN_AT_2 = re.compile(
    rf"\(\s*at\s+({_PIN_FLOAT})\s+({_PIN_FLOAT})\s*\)",
    re.IGNORECASE | re.DOTALL,
)
_RE_PIN_LENGTH = re.compile(rf"\(\s*length\s+({_PIN_FLOAT})\s*\)", re.IGNORECASE | re.DOTALL)


def _pin_geometry_head(pin_block: str) -> str:
    """
    KiCad pins are ``(at …) (length …) (name …)``. Nested ``(at`` inside ``(name`` / ``(effects``
    must not be used for shaft geometry — only the segment before ``(length`` is safe.
    """
    lm = _RE_PIN_LENGTH.search(pin_block)
    if lm:
        return pin_block[: lm.start()]
    return pin_block[: min(600, len(pin_block))]


def _rectangle_start_end_mm(block: str) -> tuple[float, float, float, float] | None:
    f = _PIN_FLOAT
    sm = re.search(rf"\(\s*start\s+({f})\s+({f})\s*\)", block, re.IGNORECASE | re.DOTALL)
    em = re.search(rf"\(\s*end\s+({f})\s+({f})\s*\)", block, re.IGNORECASE | re.DOTALL)
    if not sm or not em:
        return None
    return float(sm.group(1)), float(sm.group(2)), float(em.group(1)), float(em.group(2))


def _circle_center_radius_mm(block: str) -> tuple[float, float, float] | None:
    f = _PIN_FLOAT
    cm = re.search(rf"\(\s*center\s+({f})\s+({f})\s*\)", block, re.IGNORECASE | re.DOTALL)
    rm = re.search(rf"\(\s*radius\s+({f})\s*\)", block, re.IGNORECASE | re.DOTALL)
    if not cm or not rm:
        return None
    return float(cm.group(1)), float(cm.group(2)), float(rm.group(1))


# Match ``(fill (type NAME`` only; KiCad may add ``(color …)`` etc. before the fill group closes.
_FILL_TYPE_RE = re.compile(
    r"\(\s*fill\s*\(\s*type\s+(\w+)", re.IGNORECASE | re.DOTALL
)

# Match footprint preview pad labels (`footprint_preview_svg`); extension may reinforce via CSS.
_SYM_PIN_FONT_FAMILY = "Segoe UI,Roboto,Helvetica,Arial,sans-serif"


@dataclass(frozen=True)
class _PreviewPalette:
    """
    Ink colors for symbol SVG (light page vs dark page / Dark Reader).

    KiCad has three fill semantics on body graphics:
    - ``(fill (type none))``       → no fill (stroke only).
    - ``(fill (type outline))``    → fill with the **outline / line color**.
    - ``(fill (type background))`` → fill with KiCad's **device body background**
      (pale yellow ``~#FFFFC2`` on the light theme, a subtle translucent tint on dark).
    A missing fill clause is treated as ``none`` (modern ``.kicad_sym`` always emits one).
    """

    body_fill_background: tuple[str, float]
    body_fill_outline: tuple[str, float]
    body_stroke: str
    pin_shaft: str
    pin_accent: str
    pin_square_fill: str
    pin_square_stroke: str
    pin_dot_fill: str
    pin_dot_stroke: str
    text_num_fill: str
    text_name_fill: str
    is_dark: bool
    #: Optional solid panel painted behind everything (dark theme only). ``None``
    #: leaves the SVG transparent (light theme sits on the white preview pane).
    bg_panel: str | None = None


def _preview_palette(theme: Literal["light", "dark"]) -> _PreviewPalette:
    if theme == "dark":
        # Dark theme: its OWN slate panel so the preview is self-contained and reads
        # as "dark" regardless of the host surface. Soft light-slate ink (NOT harsh
        # pure white), a teal accent for pin names, and a green connection hotspot.
        return _PreviewPalette(
            bg_panel="#0f172a",                       # slate-900 panel
            body_fill_background=("#cbd5e1", 0.08),   # very subtle body tint
            body_fill_outline=("#cbd5e1", 0.92),      # outline-fill = line color
            body_stroke="#cbd5e1",                    # slate-300 lines
            pin_shaft="#cbd5e1",
            pin_accent="#cbd5e1",
            pin_square_fill="#166534",                # green-800 hotspot
            pin_square_stroke="#4ade80",              # green-400 ring
            pin_dot_fill="#cbd5e1",
            pin_dot_stroke="#0f172a",
            text_num_fill="#e2e8f0",                  # slate-200 numbers
            text_name_fill="#67e8f9",                 # cyan-300 names (accent)
            is_dark=True,
        )
    # Light theme (white preview pane): refined slate ink (softer than pure black),
    # soft KiCad body-yellow fill, a green connection hotspot, teal pin names.
    return _PreviewPalette(
        bg_panel=None,
        body_fill_background=("#fef9c3", 0.92),       # yellow-100 body tint
        body_fill_outline=("#334155", 0.92),          # outline-fill = line color
        body_stroke="#334155",                        # slate-700 lines
        pin_shaft="#334155",
        pin_accent="#334155",
        pin_square_fill="#bbf7d0",                     # green-200 hotspot
        pin_square_stroke="#15803d",                   # green-700 ring
        pin_dot_fill="#334155",
        pin_dot_stroke="#ffffff",
        text_num_fill="#334155",                       # slate-700 numbers
        text_name_fill="#0e7490",                      # cyan-700 names (accent)
        is_dark=False,
    )


def _palette_resolve_fill(
    fill_type: str | None, pal: _PreviewPalette
) -> tuple[str, float] | None:
    """
    Resolve KiCad ``(fill (type …))`` to preview ``(color, opacity)``.

    - ``None``       (no ``(fill …)`` clause)         → no fill (treat as ``none``).
    - ``"none"``                                      → no fill.
    - ``"background"``                                → pale body background (theme tint).
    - ``"outline"``                                   → outline / line color.
    - unknown                                         → outline color (safe fallback —
      never collapse to an opaque black box).
    """
    if fill_type is None or fill_type == "none":
        return None
    if fill_type == "background":
        return pal.body_fill_background
    return pal.body_fill_outline


# ``(stroke (width W) …)`` — width is first in modern KiCad; rarely ``(type …)`` precedes ``width``.
_STROKE_WIDTH_AFTER_STROKE = re.compile(
    rf"\(\s*stroke\s+\(\s*width\s+({_PIN_FLOAT})\s*\)",
    re.IGNORECASE | re.DOTALL,
)
_STROKE_WIDTH_TYPE_FIRST = re.compile(
    rf"\(\s*stroke\s+\(\s*type\s+\w+\s*\)\s*\(\s*width\s+({_PIN_FLOAT})\s*\)",
    re.IGNORECASE | re.DOTALL,
)


def _stroke_width_mm(block: str, default: float) -> float:
    """
    Read stroke width from a graphic or pin s-expression.

    KiCad uses ``(stroke (width 0) …)`` for “default” line weight in the theme — we keep ``default``
    (preview baseline derived from view size). Positive widths are in **mm** (symbol editor units).
    """
    m = _STROKE_WIDTH_AFTER_STROKE.search(block) or _STROKE_WIDTH_TYPE_FIRST.search(block)
    if not m:
        return default
    try:
        w = float(m.group(1))
    except ValueError:
        return default
    if w <= 0 or not math.isfinite(w):
        return default
    return max(0.05, min(w, 5.0))


def _kicad_shape_fill_type(block: str) -> str | None:
    """
    Read the KiCad ``(fill (type …))`` keyword on a graphic block.

    Returns the lowercased type (``"none"``, ``"outline"``, ``"background"``, or any
    other token the library carried) or ``None`` when no ``(fill …)`` clause is present —
    modern ``.kicad_sym`` always emits one and a missing clause is treated like ``"none"``
    by the renderer (was historically "implicit body fill", which over-painted bodies).
    """
    m = _FILL_TYPE_RE.search(block)
    if not m:
        return None
    return (m.group(1) or "").lower()


def _arc_start_mid_end_kicad_mm(block: str) -> tuple[float, float, float, float, float, float] | None:
    """Modern KiCad ``(arc (start x y) (mid x y) (end x y) …)`` in symbol space (mm)."""
    f = _PIN_FLOAT
    sm = re.search(rf"\(\s*start\s+({f})\s+({f})\s*\)", block, re.IGNORECASE | re.DOTALL)
    mm = re.search(rf"\(\s*mid\s+({f})\s+({f})\s*\)", block, re.IGNORECASE | re.DOTALL)
    em = re.search(rf"\(\s*end\s+({f})\s+({f})\s*\)", block, re.IGNORECASE | re.DOTALL)
    if not sm or not mm or not em:
        return None
    return (
        float(sm.group(1)),
        float(sm.group(2)),
        float(mm.group(1)),
        float(mm.group(2)),
        float(em.group(1)),
        float(em.group(2)),
    )


def _circumcircle_xy(
    ax: float, ay: float, bx: float, by: float, cx: float, cy: float
) -> tuple[float, float, float] | None:
    d = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-14:
        return None
    ax2ay2 = ax * ax + ay * ay
    bx2by2 = bx * bx + by * by
    cx2cy2 = cx * cx + cy * cy
    ux = (ax2ay2 * (by - cy) + bx2by2 * (cy - ay) + cx2cy2 * (ay - by)) / d
    uy = (ax2ay2 * (cx - bx) + bx2by2 * (ax - cx) + cx2cy2 * (bx - ax)) / d
    r = math.hypot(ax - ux, ay - uy)
    if not math.isfinite(ux) or not math.isfinite(r) or r < 1e-9:
        return None
    return ux, uy, r


def _angle_wrap_pi(a: float) -> float:
    return (a + math.pi) % (2 * math.pi) - math.pi


def _arc_sweep_through_mid(ts: float, tm: float, te: float) -> float:
    """Signed angle (rad) from ``ts`` to ``te`` along the circle that passes through ``tm``."""

    def shortest(ts_: float, te_: float) -> float:
        return _angle_wrap_pi(te_ - ts_)

    d_short = shortest(ts, te)
    d_long = d_short - 2 * math.pi * (1.0 if d_short > 0 else -1.0)

    def mid_on_sweep(sweep: float, samples: int = 40) -> bool:
        if abs(sweep) < 1e-9:
            return abs(_angle_wrap_pi(tm - ts)) < 0.08
        for i in range(1, samples):
            ang = ts + sweep * (i / samples)
            if abs(_angle_wrap_pi(tm - ang)) < (2 * math.pi / samples * 2.0):
                return True
        return False

    candidates = [d_short, d_long]
    candidates.sort(key=lambda x: abs(x))
    for d in candidates:
        if mid_on_sweep(d):
            return d
    return d_short


def _arc_polyline_points_svg(
    mapper: _SvgMapper,
    sx_k: float,
    sy_k: float,
    mx_k: float,
    my_k: float,
    ex_k: float,
    ey_k: float,
    segments: int = 30,
) -> list[tuple[float, float]]:
    sx, sy = mapper.xy(sx_k, sy_k)
    mx, my = mapper.xy(mx_k, my_k)
    ex, ey = mapper.xy(ex_k, ey_k)
    cc = _circumcircle_xy(sx, sy, mx, my, ex, ey)
    if cc is None:
        return [(sx, sy), (mx, my), (ex, ey)]
    ux, uy, r = cc
    ts = math.atan2(sy - uy, sx - ux)
    tm = math.atan2(my - uy, mx - ux)
    te = math.atan2(ey - uy, ex - ux)
    sweep = _arc_sweep_through_mid(ts, tm, te)
    pts: list[tuple[float, float]] = []
    n = max(8, segments)
    for i in range(n + 1):
        ang = ts + sweep * (i / n)
        pts.append((ux + r * math.cos(ang), uy + r * math.sin(ang)))
    return pts


def _arc_polyline_svg_from_points(
    pts: list[tuple[float, float]], stroke_w: float, stroke_color: str
) -> str:
    coord = " ".join(f"{px:.3f},{py:.3f}" for px, py in pts)
    sw = stroke_w
    esc = html.escape(stroke_color, quote=True)
    return (
        f'<polyline points="{coord}" fill="none" stroke="{esc}" '
        f'stroke-width="{sw:.3f}" stroke-linejoin="round" stroke-linecap="round"/>'
    )


def _arc_polyline_svg_element(
    mapper: _SvgMapper,
    sx_k: float,
    sy_k: float,
    mx_k: float,
    my_k: float,
    ex_k: float,
    ey_k: float,
    stroke_w: float,
    stroke_color: str,
    segments: int = 30,
) -> str:
    pts = _arc_polyline_points_svg(
        mapper, sx_k, sy_k, mx_k, my_k, ex_k, ey_k, segments=segments
    )
    return _arc_polyline_svg_from_points(pts, stroke_w, stroke_color)


def _pin_display_labels(raw_name: str, raw_number: str, pin_index1: int) -> tuple[str, str]:
    """
    Text shown for a pin in preview. KiCad uses ``~`` for "no name"; empty (name)/(number)
    still get a fallback so every pin is identifiable.
    """
    num = (raw_number or "").strip()
    name = (raw_name or "").strip()
    if name == "~":
        name = ""
    if not num and not name:
        num = str(pin_index1)
    return num, name


def _parse_pin_geometry(pin_block: str) -> tuple[float, float, float, float, float, float] | None:
    """
    Parse modern KiCad ``(pin …)`` (same shape in KiCad 9+ ``.kicad_sym``):

    - ``(at x y [angle])`` — schematic **wire connection** (electrical hookup).
    - ``(length L)`` — shaft from that point **into** the symbol along ``angle``.

    Returns ``(x_hot, y_hot, angle_deg, length, x_inner, y_inner)`` or None.
    """
    head = _pin_geometry_head(pin_block)
    m3 = _RE_PIN_AT_3.search(head)
    if m3:
        x_hot = float(m3.group(1))
        y_hot = float(m3.group(2))
        ang = float(m3.group(3))
    else:
        m2 = _RE_PIN_AT_2.search(head)
        if not m2:
            return None
        x_hot = float(m2.group(1))
        y_hot = float(m2.group(2))
        ang = 0.0
    lm = _RE_PIN_LENGTH.search(pin_block)
    length = float(lm.group(1)) if lm else 2.54
    if length <= 0:
        length = 2.54
    x_in, y_in = _pin_endpoint(x_hot, y_hot, ang, length)
    return x_hot, y_hot, ang, length, x_in, y_in


def _pin_axis_unit(
    x_hot: float,
    y_hot: float,
    x_inner: float,
    y_inner: float,
    ang: float,
) -> tuple[float, float, float]:
    """Unit vector from wire connection **into** the symbol (body direction), length 1."""
    dx, dy = x_inner - x_hot, y_inner - y_hot
    nlen = math.hypot(dx, dy)
    if nlen < 1e-9:
        dx, dy = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        nlen = math.hypot(dx, dy) or 1.0
    return dx / nlen, dy / nlen, nlen


def _label_anchor_outside_kicad(
    x_hot: float,
    y_hot: float,
    x_inner: float,
    y_inner: float,
    ang: float,
    offset_mm: float,
) -> tuple[float, float]:
    """From the wire connection, step **outward** — schematic side, away from the body (pin number)."""
    ux, uy, _ = _pin_axis_unit(x_hot, y_hot, x_inner, y_inner, ang)
    return x_hot - ux * offset_mm, y_hot - uy * offset_mm


def _pin_label_offsets_mm(
    pin_len: float,
    side: float,
    *,
    label_pins: bool,
    pin_dot_r: float,
    font_mm: float,
    font_pin_num_mm: float,
) -> tuple[float, float]:
    """
    Return ``(off_out_number, off_out_name)`` — distances from the wire attachment **outward**
    along the pin axis (mm, schematic / wire side, away from the symbol body).

    The pin **number** sits closer to the connection point; the **name** is placed further out
    on the same ray so names never sit inside the symbol graphic and do not overlap the number.
    """
    off_out_num = max(2.0, side * 0.78 + font_pin_num_mm * 0.72 + 1.05)
    stack_gap = max(0.5, 0.45 * font_mm)
    radial_name = (
        font_pin_num_mm * (1.05 if label_pins else 0.94)
        + stack_gap
        + font_mm * (0.78 if label_pins else 0.65)
    )
    off_out_name = off_out_num + radial_name
    if label_pins:
        off_out_name = max(
            off_out_name,
            off_out_num + pin_dot_r * 0.4 + font_mm * 1.12,
        )
    # Short pin shafts: still bias name outward a little using library length.
    off_out_name = max(off_out_name, off_out_num + 0.1 * min(pin_len, 4.0))
    return off_out_num, off_out_name


def extract_all_symbol_graphical_units(symbol_block: str) -> list[str]:
    """
    Return every nested ``(symbol \"Name_N_M\" …)`` unit under one library symbol.

    KiCad may split **body** and **pins** across body-style units (e.g. ``_0_1`` vs ``_0_0``),
    or duplicate pins on alternates. Preview merges graphics from **all** these units so
    nothing is dropped when a single ``_*_*`` block is incomplete.
    """
    units: list[str] = []
    seen_starts: set[int] = set()
    for m in re.finditer(r'\(\s*symbol\s+"[^"]+_\d+_\d+"', symbol_block):
        start = m.start()
        if start in seen_starts:
            continue
        block, _ = _collect_sexpr_block(symbol_block, start)
        if block and len(block) >= 12:
            seen_starts.add(start)
            units.append(block)
    return units


def _collect_tag_across_units(
    units: list[str], tag: str, max_total: int
) -> list[str]:
    """Gather balanced ``(tag …)`` blocks from each unit until ``max_total`` is reached."""
    out: list[str] = []
    for unit in units:
        need = max_total - len(out)
        if need <= 0:
            break
        for block in _iter_tag_blocks(unit, tag, need):
            out.append(block)
            if len(out) >= max_total:
                return out
    return out


def symbol_block_to_svg(
    symbol_block: str,
    *,
    label_pins: bool = False,
    draw_pin_names: bool = True,
    width_px: int = 300,
    height_px: int = 225,
    preview_theme: Literal["light", "dark"] = "light",
) -> tuple[str, dict[str, float]] | tuple[None, dict[str, str]]:
    """
    Convert a full top-level KiCad (symbol \"Name\" ...) block to SVG string.

    KiCad library pins are not ordinary graphics: ``(at x y [angle])`` is the **schematic wire
    connection**, and ``(length L)`` extends **from that point into the symbol** along
    ``angle`` (degrees, 0° = +X).     Optional ``(name …)`` / ``(number …)`` are drawn on the **schematic (wire) side** of the pin,
    outward from the body: number nearer the hotspot, name beyond it so neither sits inside the
    symbol body nor overlaps the other. Labels with ``(effects … (hide yes))`` are omitted so the
    preview matches KiCad visibility (pin shaft and connection graphics are still drawn).

    ``label_pins`` selects **larger** fonts and spacing (assignment dialog); when False, labels
    are **compact** (e.g. template list hover).

    ``draw_pin_names`` — when False, only pin **numbers** are drawn.

    ``preview_theme`` — ``dark`` uses white monochrome ink on a transparent background.
    ``light`` uses black monochrome ink; the pin hotspot (wire connection) stays green.

    Returns (svg, meta) where meta has view metrics, or (None, {"error": "..."}).
    """
    if not symbol_block or len(symbol_block) > _MAX_SYMBOL_CHARS:
        return None, {"error": "symbol_too_large"}

    if re.search(r"\(\s*extends\s+\"", symbol_block):
        return None, {"error": "extends_not_supported"}

    units = extract_all_symbol_graphical_units(symbol_block)
    if not units:
        return None, {"error": "no_graphical_unit"}

    pal = _preview_palette("dark" if preview_theme == "dark" else "light")

    rect_blocks = _collect_tag_across_units(units, "rectangle", _MAX_BODY_ITEMS)
    circle_blocks = _collect_tag_across_units(units, "circle", _MAX_BODY_ITEMS)
    arc_blocks = _collect_tag_across_units(units, "arc", _MAX_BODY_ITEMS)
    poly_blocks = _collect_tag_across_units(units, "polyline", _MAX_BODY_ITEMS)
    pin_blocks = _collect_tag_across_units(units, "pin", _MAX_PIN_ITEMS)

    # Geometry-only framing for the coordinate map (body + pin shafts). Pin *labels* are excluded
    # so library origins / far-away text anchors do not inflate the scale; a second pass crops to ink.
    geom = _BBox()
    for block in rect_blocks:
        pts = _rectangle_start_end_mm(block)
        if pts:
            x0, y0, x1, y1 = pts
            geom.add_rect(x0, y0, x1, y1)
    for block in circle_blocks:
        c = _circle_center_radius_mm(block)
        if c:
            cx, cy, r = c
            geom.add_point(cx - r, cy - r)
            geom.add_point(cx + r, cy + r)
    for block in arc_blocks:
        arc_pts = _arc_start_mid_end_kicad_mm(block)
        if arc_pts:
            sx, sy, mx, my, ex, ey = arc_pts
            geom.add_point(sx, sy)
            geom.add_point(mx, my)
            geom.add_point(ex, ey)
            cc_k = _circumcircle_xy(sx, sy, mx, my, ex, ey)
            if cc_k:
                ux, uy, rk = cc_k
                geom.add_point(ux - rk, uy - rk)
                geom.add_point(ux + rk, uy + rk)
    f_xy = _PIN_FLOAT
    for block in poly_blocks:
        for xy in re.finditer(rf"\(\s*xy\s+({f_xy})\s+({f_xy})\s*\)", block, re.IGNORECASE | re.DOTALL):
            geom.add_point(float(xy.group(1)), float(xy.group(2)))
    for block in pin_blocks:
        pg = _parse_pin_geometry(block)
        if not pg:
            continue
        x_hot, y_hot, _ang, _pin_len, x_in, y_in = pg
        geom.add_point(x_hot, y_hot)
        geom.add_point(x_in, y_in)

    if not geom.valid():
        return None, {"error": "empty_graphics"}

    min_x, max_x, min_y, max_y = geom.min_x, geom.max_x, geom.min_y, geom.max_y
    w = max_x - min_x
    h = max_y - min_y
    if w <= 0 or h <= 0:
        w = h = 2.54
        cx = (min_x + max_x) * 0.5
        cy = (min_y + max_y) * 0.5
        min_x, max_x = cx - 1.27, cx + 1.27
        min_y, max_y = cy - 1.27, cy + 1.27

    base_margin = max(0.42, 0.052 * max(w, h))
    label_margin_boost = 1.0 if label_pins else 0.48
    margin = base_margin + label_margin_boost
    vb_w = w + 2 * margin
    vb_h = h + 2 * margin
    mapper = _SvgMapper(min_x, max_y, margin)

    vb_diag = math.hypot(vb_w, vb_h)
    stroke_body = max(0.1, min(vb_diag * 0.004, 0.38))
    # Pins are only a point + length + angle in the library — draw the shaft thick enough to read.
    stroke_pin = max(0.36, min(vb_diag * 0.014, 0.95))
    pin_dot_r = max(0.32, min(vb_diag * 0.01, 0.65))
    # Pin **name** (body side) — base text size.
    font_mm = max(0.74, min(vb_diag * 0.048, 1.92)) if label_pins else max(
        0.64, min(vb_diag * 0.041, 1.55)
    )
    # Pin **number** on the wire side — larger than the name.
    font_pin_num_mm = min(
        max(font_mm * 1.62, font_mm + 0.42),
        2.35 if label_pins else 1.95,
    )

    # Paint order: body-background fills first (BEHIND), then outline-filled / stroked
    # graphics, then pins. A KiCad `(fill (type background))` rectangle on an IC body must
    # never paint OVER internal graphics, pin shafts, or labels.
    bg_fill_parts: list[str] = []
    body_parts: list[str] = []
    pin_parts: list[str] = []
    ink = _DrawBounds()

    for block in rect_blocks:
        pts = _rectangle_start_end_mm(block)
        if not pts:
            continue
        x0, y0, x1, y1 = pts
        sx0, sy0 = mapper.xy(x0, y0)
        sx1, sy1 = mapper.xy(x1, y1)
        xa, xb = min(sx0, sx1), max(sx0, sx1)
        ya, yb = min(sy0, sy1), max(sy0, sy1)
        sw = _stroke_width_mm(block, stroke_body)
        ink.add_rect_xy(xa, ya, xb, yb, sw * 0.55)
        fill_type = _kicad_shape_fill_type(block)
        fill = _palette_resolve_fill(fill_type, pal)
        bs = html.escape(pal.body_stroke, quote=True)
        if fill:
            fc, fo = fill
            fce = html.escape(fc, quote=True)
            elem = (
                f'<rect x="{xa:.3f}" y="{ya:.3f}" width="{xb - xa:.3f}" height="{yb - ya:.3f}" '
                f'fill="{fce}" fill-opacity="{fo:.2f}" stroke="{bs}" stroke-width="{sw:.3f}" '
                f'stroke-linejoin="round"/>'
            )
        else:
            elem = (
                f'<rect x="{xa:.3f}" y="{ya:.3f}" width="{xb - xa:.3f}" height="{yb - ya:.3f}" '
                f'fill="none" stroke="{bs}" stroke-width="{sw:.3f}" stroke-linejoin="round"/>'
            )
        (bg_fill_parts if fill_type == "background" else body_parts).append(elem)

    for block in circle_blocks:
        c = _circle_center_radius_mm(block)
        if not c:
            continue
        cx, cy, r = c
        sw = _stroke_width_mm(block, stroke_body)
        r_draw = max(r, sw * 1.25)
        sx, sy = mapper.xy(cx, cy)
        ink.add_point(sx, sy, r_draw + sw * 0.55)
        fill_type = _kicad_shape_fill_type(block)
        fill = _palette_resolve_fill(fill_type, pal)
        bs = html.escape(pal.body_stroke, quote=True)
        if fill:
            fc, fo = fill
            fce = html.escape(fc, quote=True)
            elem = (
                f'<circle cx="{sx:.3f}" cy="{sy:.3f}" r="{r_draw:.3f}" fill="{fce}" '
                f'fill-opacity="{fo:.2f}" stroke="{bs}" stroke-width="{sw:.3f}"/>'
            )
        else:
            elem = (
                f'<circle cx="{sx:.3f}" cy="{sy:.3f}" r="{r_draw:.3f}" fill="none" '
                f'stroke="{bs}" stroke-width="{sw:.3f}"/>'
            )
        (bg_fill_parts if fill_type == "background" else body_parts).append(elem)

    for block in arc_blocks:
        arc_pts = _arc_start_mid_end_kicad_mm(block)
        if not arc_pts:
            continue
        sx_k, sy_k, mx_k, my_k, ex_k, ey_k = arc_pts
        arc_pts_svg = _arc_polyline_points_svg(
            mapper, sx_k, sy_k, mx_k, my_k, ex_k, ey_k
        )
        sw = _stroke_width_mm(block, stroke_body)
        ink.add_polyline(arc_pts_svg, sw * 0.55)
        body_parts.append(
            _arc_polyline_svg_from_points(arc_pts_svg, sw, pal.body_stroke)
        )

    for block in poly_blocks:
        xys = re.findall(rf"\(\s*xy\s+({_PIN_FLOAT})\s+({_PIN_FLOAT})\s*\)", block, re.IGNORECASE | re.DOTALL)
        if len(xys) < 2:
            continue
        pts_xy: list[tuple[float, float]] = []
        for xs, ys in xys:
            pts_xy.append(mapper.xy(float(xs), float(ys)))
        sw = _stroke_width_mm(block, stroke_body)
        ink.add_polyline(pts_xy, sw * 0.55)
        coord = " ".join(f"{px:.3f},{py:.3f}" for px, py in pts_xy)
        fill_type = _kicad_shape_fill_type(block)
        fill = _palette_resolve_fill(fill_type, pal)
        bs = html.escape(pal.body_stroke, quote=True)
        if fill:
            fc, fo = fill
            fce = html.escape(fc, quote=True)
            elem = (
                f'<polygon points="{coord}" fill="{fce}" fill-opacity="{fo:.2f}" stroke="{bs}" '
                f'stroke-width="{sw:.3f}" stroke-linejoin="round" stroke-linecap="round"/>'
            )
        else:
            elem = (
                f'<polyline points="{coord}" fill="none" stroke="{bs}" '
                f'stroke-width="{sw:.3f}" stroke-linejoin="round" stroke-linecap="round"/>'
            )
        (bg_fill_parts if fill_type == "background" else body_parts).append(elem)

    for pin_index, block in enumerate(pin_blocks, start=1):
        geom = _parse_pin_geometry(block)
        if not geom:
            continue
        x_hot, y_hot, ang, pin_len, x_in, y_in = geom
        s_hot, t_hot = mapper.xy(x_hot, y_hot)
        s_in, t_in = mapper.xy(x_in, y_in)
        sw = _stroke_width_mm(block, stroke_pin)
        ln_r = max(sw * 0.55, 0.16)
        ink.add_point(s_hot, t_hot, ln_r)
        ink.add_point(s_in, t_in, ln_r)
        pin_slice: list[str] = []
        pshaft = html.escape(pal.pin_shaft, quote=True)
        paccent = html.escape(pal.pin_accent, quote=True)
        pin_slice.append(
            f'<line x1="{s_hot:.3f}" y1="{t_hot:.3f}" x2="{s_in:.3f}" y2="{t_in:.3f}" '
            f'stroke="{pshaft}" stroke-width="{sw:.3f}" stroke-linecap="round" '
            'stroke-linejoin="round"/>'
        )
        pin_slice.append(
            f'<line x1="{s_hot:.3f}" y1="{t_hot:.3f}" x2="{s_in:.3f}" y2="{t_in:.3f}" '
            f'stroke="{paccent}" stroke-width="{max(sw * 0.5, 0.14):.3f}" stroke-linecap="round" '
            'stroke-opacity="1"/>'
        )
        dx_s = s_in - s_hot
        dt_s = t_in - t_hot
        rot_deg = math.degrees(math.atan2(dt_s, dx_s))
        side = max(0.65, min(pin_len * 0.45, vb_diag * 0.016, 1.15))
        ink.add_point(s_hot, t_hot, side * 0.72 + max(sw * 0.35, 0.1))
        psqf = html.escape(pal.pin_square_fill, quote=True)
        psqs = html.escape(pal.pin_square_stroke, quote=True)
        pin_slice.append(
            f'<g transform="translate({s_hot:.3f},{t_hot:.3f}) rotate({rot_deg:.2f})">'
            f'<rect x="{(-side / 2):.3f}" y="{(-side / 2):.3f}" width="{side:.3f}" height="{side:.3f}" '
            f'fill="{psqf}" stroke="{psqs}" stroke-width="{max(sw * 0.3, 0.1):.3f}" '
            'rx="0.1" ry="0.1"/></g>'
        )
        dot_rr = max(pin_dot_r * 0.55, 0.16)
        ink.add_point(s_in, t_in, dot_rr + max(sw * 0.22, 0.08) * 0.45)
        pdf = html.escape(pal.pin_dot_fill, quote=True)
        pds = html.escape(pal.pin_dot_stroke, quote=True)
        pin_slice.append(
            f'<circle cx="{s_in:.3f}" cy="{t_in:.3f}" r="{dot_rr:.3f}" '
            f'fill="{pdf}" stroke="{pds}" '
            f'stroke-width="{max(sw * 0.22, 0.08):.3f}"/>'
        )
        raw_name, raw_number = _pin_name_and_number(block)
        hide_label_name, hide_label_num = _pin_label_hide_flags(block)
        number, name = _pin_display_labels(raw_name, raw_number, pin_index)
        if hide_label_num:
            number = ""
        if hide_label_name:
            name = ""
        name = name[:48]
        number = number[:24]
        off_out_num, off_out_name = _pin_label_offsets_mm(
            pin_len,
            side,
            label_pins=label_pins,
            pin_dot_r=pin_dot_r,
            font_mm=font_mm,
            font_pin_num_mm=font_pin_num_mm,
        )
        oxn, oyn = _label_anchor_outside_kicad(
            x_hot, y_hot, x_in, y_in, ang, off_out_num
        )
        oxm, oym = _label_anchor_outside_kicad(
            x_hot, y_hot, x_in, y_in, ang, off_out_name
        )
        tx_num, ty_num = mapper.xy(oxn, oyn)
        tx_name, ty_name = mapper.xy(oxm, oym)
        esc_num = html.escape(number) if number else ""
        esc_name = html.escape(name) if name else ""
        ff = html.escape(_SYM_PIN_FONT_FAMILY, quote=True)
        tnf = html.escape(pal.text_num_fill, quote=True)
        tnmf = html.escape(pal.text_name_fill, quote=True)

        if number and name:
            if draw_pin_names:
                pin_slice.append(
                    f'<text class="k2c-sym-pin-num" x="{tx_num:.3f}" y="{ty_num:.3f}" '
                    f'font-size="{font_pin_num_mm:.3f}" font-weight="700" fill="{tnf}" '
                    f'font-family="{ff}" text-anchor="middle" dominant-baseline="middle" '
                    f'pointer-events="none">{esc_num}</text>'
                    f'<text class="k2c-sym-pin-name" x="{tx_name:.3f}" y="{ty_name:.3f}" '
                    f'font-size="{font_mm * 1.02:.3f}" font-weight="600" fill="{tnmf}" '
                    f'font-family="{ff}" text-anchor="middle" dominant-baseline="middle" '
                    f'pointer-events="none">{esc_name}</text>'
                )
                ink.add_text_middle(tx_num, ty_num, font_pin_num_mm, number)
                ink.add_text_middle(tx_name, ty_name, font_mm * 1.02, name)
            else:
                pin_slice.append(
                    f'<text class="k2c-sym-pin-num" x="{tx_num:.3f}" y="{ty_num:.3f}" '
                    f'font-size="{font_pin_num_mm:.3f}" font-weight="700" fill="{tnf}" '
                    f'font-family="{ff}" text-anchor="middle" dominant-baseline="middle" '
                    f'pointer-events="none">{esc_num}</text>'
                )
                ink.add_text_middle(tx_num, ty_num, font_pin_num_mm, number)
        elif number:
            pin_slice.append(
                f'<text class="k2c-sym-pin-num" x="{tx_num:.3f}" y="{ty_num:.3f}" '
                f'font-size="{font_pin_num_mm:.3f}" font-weight="700" fill="{tnf}" '
                f'font-family="{ff}" text-anchor="middle" dominant-baseline="central" '
                f'pointer-events="none">{esc_num}</text>'
            )
            ink.add_text_middle(tx_num, ty_num, font_pin_num_mm, number)
        elif draw_pin_names and name:
            pin_slice.append(
                f'<text class="k2c-sym-pin-name" x="{tx_name:.3f}" y="{ty_name:.3f}" '
                f'font-size="{font_mm * 1.04:.3f}" font-weight="600" fill="{tnmf}" '
                f'font-family="{ff}" text-anchor="middle" dominant-baseline="central" '
                f'pointer-events="none">{esc_name}</text>'
            )
            ink.add_text_middle(tx_name, ty_name, font_mm * 1.04, name)

        pin_drag_id = number if number else str(pin_index)
        pin_attr = html.escape(pin_drag_id, quote=True)
        pin_parts.append(
            '<g class="k2c-sym-pin" data-k2c-pin="'
            + pin_attr
            + '" pointer-events="none">'
            + "".join(pin_slice)
            + "</g>"
        )

    if not bg_fill_parts and not body_parts and not pin_parts:
        return None, {"error": "nothing_drawn"}

    inner = "\n  ".join(bg_fill_parts + body_parts + pin_parts)
    w_mm = vb_w
    h_mm = vb_h
    if (
        ink.valid()
        and ink.width() > 1e-6
        and ink.height() > 1e-6
        and math.isfinite(ink.min_x)
        and math.isfinite(ink.max_x)
    ):
        crop_pad = max(0.2, 0.02 * max(ink.width(), ink.height()))
        dx = crop_pad - ink.min_x
        dy = crop_pad - ink.min_y
        w_mm = ink.width() + 2 * crop_pad
        h_mm = ink.height() + 2 * crop_pad
        if math.isfinite(w_mm) and math.isfinite(h_mm) and w_mm > 0 and h_mm > 0:
            inner = f'<g transform="translate({dx:.3f},{dy:.3f})">\n  {inner}\n</g>'

    if not math.isfinite(w_mm) or not math.isfinite(h_mm) or w_mm <= 0 or h_mm <= 0:
        return None, {"error": "invalid_viewbox"}

    # Match viewBox aspect ratio to width_px:height_px so preserveAspectRatio="meet" fills
    # the viewer instead of letterboxing a tall/narrow symbol in a 4:3 (or other) panel.
    vw = float(width_px)
    vh = float(height_px)
    if vw > 0 and vh > 0:
        target_ar = vw / vh
        content_ar = w_mm / h_mm
        if content_ar < target_ar - 1e-9:
            new_w = h_mm * target_ar
            new_h = h_mm
        elif content_ar > target_ar + 1e-9:
            new_w = w_mm
            new_h = w_mm / target_ar
        else:
            new_w = w_mm
            new_h = h_mm
        pad_x = (new_w - w_mm) * 0.5
        pad_y = (new_h - h_mm) * 0.5
        if pad_x > 1e-6 or pad_y > 1e-6:
            inner = f'<g transform="translate({pad_x:.3f},{pad_y:.3f})">\n  {inner}\n</g>'
            w_mm, h_mm = new_w, new_h

    if not math.isfinite(w_mm) or not math.isfinite(h_mm) or w_mm <= 0 or h_mm <= 0:
        return None, {"error": "invalid_viewbox"}
    # Dark theme paints its own rounded slate panel behind everything so the preview
    # is self-contained on any host surface; light theme stays transparent (it sits
    # on the white preview pane).
    bg_panel_rect = ""
    if pal.bg_panel:
        rr = min(w_mm, h_mm) * 0.04
        panel = html.escape(pal.bg_panel, quote=True)
        bg_panel_rect = (
            f'<rect x="0" y="0" width="{w_mm:.3f}" height="{h_mm:.3f}" '
            f'rx="{rr:.3f}" ry="{rr:.3f}" fill="{panel}"/>\n  '
        )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w_mm:.3f} {h_mm:.3f}" '
        f'width="{width_px}" height="{height_px}" preserveAspectRatio="xMidYMid meet" '
        'role="img" aria-label="Symbol preview">\n'
        f"  {bg_panel_rect}{inner}\n"
        "</svg>"
    )
    meta: dict[str, float] = {
        "view_w_mm": float(w_mm),
        "view_h_mm": float(h_mm),
        "width_px": float(width_px),
        "height_px": float(height_px),
    }
    return svg, meta


def template_symbol_to_preview_svg(
    lib_path: str,
    symbol_name: str,
    *,
    label_pins: bool = False,
    draw_pin_names: bool = True,
    width_px: int = 300,
    height_px: int = 225,
) -> tuple[str, dict] | tuple[None, dict[str, str]]:
    """Load symbol from library file and render preview SVG."""
    from easyeda2kicad.helpers import extract_symbol_from_lib

    raw = extract_symbol_from_lib(lib_path, symbol_name)
    if not raw:
        return None, {"error": "symbol_not_found"}
    return symbol_block_to_svg(
        raw,
        label_pins=label_pins,
        draw_pin_names=draw_pin_names,
        width_px=width_px,
        height_px=height_px,
    )
