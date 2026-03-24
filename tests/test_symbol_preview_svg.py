"""Tests for KiCad symbol → SVG preview."""

import re

from easyeda2kicad.kicad.symbol_preview_svg import symbol_block_to_svg

_MINIMAL_SYMBOL = """
(symbol "T"
  (symbol "T_0_1"
    (rectangle (start -2.54 -2.54) (end 2.54 2.54) (stroke (width 0)) (fill (type none)))
    (pin power line (at 0 -5.08 90) (length 2.54)
      (name "GND" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27)))))
  )
)
"""


def test_preview_theme_dark_no_canvas_rect_light_ink():
    svg_light, _ = symbol_block_to_svg(_MINIMAL_SYMBOL.strip())
    svg_dark, _ = symbol_block_to_svg(_MINIMAL_SYMBOL.strip(), preview_theme="dark")
    assert svg_light and svg_dark
    assert "#252a32" not in svg_dark
    assert "#ffffff" in svg_dark
    assert "#86efac" not in svg_dark
    assert "#000000" in svg_light
    assert "#86efac" in svg_light


def test_symbol_block_to_svg_emits_svg():
    svg, meta = symbol_block_to_svg(_MINIMAL_SYMBOL.strip())
    assert svg is not None
    assert "<svg" in svg
    assert "rect" in svg
    assert "line" in svg
    assert "circle" in svg  # pin connection + outer endpoint markers
    assert "preserveAspectRatio" in svg
    assert "viewBox" in svg
    assert "view_w_mm" in meta
    # Pin (number) / (name) from KiCad library are always annotated
    assert ">1<" in svg or ">GND<" in svg or "GND" in svg
    # Gallery: per-pin groups (non-interactive in preview; pointer-events none)
    assert 'class="k2c-sym-pin"' in svg
    assert 'data-k2c-pin="1"' in svg
    assert 'class="k2c-sym-pin-num"' in svg


def test_label_pins_includes_text():
    svg, _ = symbol_block_to_svg(_MINIMAL_SYMBOL.strip(), label_pins=True)
    assert svg is not None
    assert "GND" in svg
    assert "1" in svg
    assert 'class="k2c-sym-pin-name"' in svg


def test_body_stroke_width_from_library():
    """Preview must honor ``(stroke (width W))`` on body graphics (not only a fixed baseline)."""
    thin = """(symbol "X" (symbol "X_0_1"
      (rectangle (start 0 0) (end 2.54 2.54) (stroke (width 0.127) (type default)) (fill (type none)))
    ))"""
    thick = """(symbol "X" (symbol "X_0_1"
      (rectangle (start 0 0) (end 2.54 2.54) (stroke (width 0.762) (type default)) (fill (type none)))
    ))"""
    svg_thin, _ = symbol_block_to_svg(thin.strip())
    svg_thick, _ = symbol_block_to_svg(thick.strip())
    assert svg_thin and svg_thick
    assert 'stroke-width="0.127"' in svg_thin
    assert 'stroke-width="0.762"' in svg_thick


def test_draw_pin_names_false_omits_name_text():
    svg, _ = symbol_block_to_svg(
        _MINIMAL_SYMBOL.strip(), label_pins=True, draw_pin_names=False
    )
    assert svg is not None
    assert "GND" not in svg
    assert ">1<" in svg or svg.count("1") >= 1


def test_extends_rejected():
    bad = '(symbol "X" (extends "Y") (symbol "X_0_1" (circle (center 0 0) (radius 1) (stroke (width 0.1)) (fill (type none)))))'
    svg, err = symbol_block_to_svg(bad)
    assert svg is None
    assert err.get("error") == "extends_not_supported"


def test_merges_body_and_pins_when_split_across_body_style_units():
    """
    KiCad may put the rectangle in one ``_*_*`` unit and pins in another; preview
    aggregates all nested graphical units so both appear.
    """
    sym = """
(symbol "U"
  (symbol "U_0_1"
    (rectangle (start -2.54 -2.54) (end 2.54 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
  )
  (symbol "U_0_0"
    (rectangle (start -2.54 -2.54) (end 2.54 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
    (pin passive line (at -5.08 0 0) (length 2.54)
      (name "A" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27)))))
  )
)
"""
    svg, _ = symbol_block_to_svg(sym.strip())
    assert svg is not None
    assert svg.count("<line") >= 1
    assert "A" in svg or ">1<" in svg
    assert "<rect" in svg


def test_merges_body_and_pins_when_pins_listed_before_body_in_file():
    sym = """
(symbol "U"
  (symbol "U_0_0"
    (pin passive line (at -5.08 0 0) (length 2.54)
      (name "A" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27)))))
  )
  (symbol "U_0_1"
    (rectangle (start -2.54 -2.54) (end 2.54 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
  )
)
"""
    svg, _ = symbol_block_to_svg(sym.strip())
    assert svg is not None
    assert "<line" in svg
    assert "<rect" in svg


def test_kicad_9_style_unit_0_0_renders():
    """KiCad 9 often places graphics in ``SymbolName_0_0``, not ``_0_1``."""
    sym = """
(symbol "R"
  (symbol "R_0_0"
    (rectangle (start -3.81 -1.905) (end 3.81 1.905) (stroke (width 0.254) (type default)) (fill (type none)))
    (pin passive line (at -5.08 0 0) (length 1.27)
      (name "~" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27)))))
    (pin passive line (at 5.08 0 180) (length 1.27)
      (name "~" (effects (font (size 1.27 1.27))))
      (number "2" (effects (font (size 1.27 1.27)))))
  )
)
"""
    svg, meta = symbol_block_to_svg(sym.strip())
    assert svg is not None
    assert meta.get("view_w_mm", 0) > 0
    assert svg.count("<line") >= 2
    assert "rotate(" in svg


def test_pin_shaft_drawn_even_without_name_number():
    """Pins are point+length+angle; graphics must show even if (name)/(number) are empty."""
    sym = """
(symbol "T"
  (symbol "T_0_1"
    (rectangle (start -2.54 -2.54) (end 2.54 2.54) (stroke (width 0)) (fill (type none)))
    (pin passive line (at 0 -5.08 90) (length 2.54)
      (name "" (effects (font (size 1.27 1.27))))
      (number "" (effects (font (size 1.27 1.27)))))
  )
)
"""
    svg, _ = symbol_block_to_svg(sym.strip())
    assert svg is not None
    assert "<line" in svg
    assert "<g transform=" in svg and "rotate(" in svg
    assert "<text" in svg and ">1<" in svg


def test_kicad_arc_rendered_as_polyline():
    """KiCad circle outlines are often stored as two ``(arc (start) (mid) (end))`` items."""
    sym = """
(symbol "LED"
  (symbol "LED_0_0"
    (arc (start -2.54 0) (mid 0 -2.54) (end 2.54 0) (stroke (width 0.254) (type default)) (fill (type none)))
    (arc (start 2.54 0) (mid 0 2.54) (end -2.54 0) (stroke (width 0.254) (type default)) (fill (type none)))
    (pin passive line (at -5.08 0 0) (length 2.54)
      (name "K" (effects (font (size 1.27 1.27))))
      (number "2" (effects (font (size 1.27 1.27)))))
    (pin passive line (at 5.08 0 180) (length 2.54)
      (name "A" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27)))))
  )
)
"""
    svg, _ = symbol_block_to_svg(sym.strip())
    assert svg is not None
    assert svg.count("<polyline") >= 2
    assert "K" in svg and "A" in svg


def test_circle_fill_type_background():
    sym = """
(symbol "C"
  (symbol "C_0_0"
    (circle (center 0 0) (radius 2.54) (stroke (width 0.254) (type default)) (fill (type background)))
  )
)
"""
    svg, _ = symbol_block_to_svg(sym.strip())
    assert svg is not None
    assert "fill-opacity=" in svg
    assert "#000000" in svg


def test_rectangle_fill_type_background():
    sym = """
(symbol "B"
  (symbol "B_0_0"
    (rectangle (start -2.54 -1.27) (end 2.54 1.27) (stroke (width 0.254) (type default)) (fill (type background)))
  )
)
"""
    svg, _ = symbol_block_to_svg(sym.strip())
    assert svg is not None
    assert "<rect" in svg
    assert 'fill="#000000"' in svg
    assert "fill-opacity=" in svg


def test_polyline_closed_fill_type_background_emits_polygon():
    sym = """
(symbol "P"
  (symbol "P_0_0"
    (polyline
      (pts (xy 0 0) (xy 2.54 0) (xy 2.54 2.54) (xy 0 2.54))
      (stroke (width 0.254) (type default))
      (fill (type background)))
  )
)
"""
    svg, _ = symbol_block_to_svg(sym.strip())
    assert svg is not None
    assert "<polygon" in svg
    assert 'fill="#000000"' in svg


def test_rectangle_fill_type_outline_renders_interior():
    """KiCad ``outline`` fill is a filled interior (outline color), not hollow."""
    sym = """
(symbol "O"
  (symbol "O_0_0"
    (rectangle (start -1 -1) (end 1 1) (stroke (width 0.254) (type default))
      (fill (type outline) (color 0 0 0 0)))
  )
)
"""
    svg, _ = symbol_block_to_svg(sym.strip())
    assert svg is not None
    assert "<rect" in svg
    assert 'fill="#000000"' in svg
    assert "fill-opacity=" in svg


def test_rectangle_without_fill_clause_defaults_to_body_fill():
    """Some libraries omit ``(fill …)``; KiCad still shows a filled body."""
    sym = """
(symbol "N"
  (symbol "N_0_0"
    (rectangle (start -2.54 -2.54) (end 2.54 2.54) (stroke (width 0.254) (type default)))
  )
)
"""
    svg, _ = symbol_block_to_svg(sym.strip())
    assert svg is not None
    assert "<rect" in svg
    assert 'fill="#000000"' in svg


def test_default_svg_pixel_size_increased():
    svg, meta = symbol_block_to_svg("(symbol \"X\" (symbol \"X_0_0\" (circle (center 0 0) (radius 1) (stroke (width 0.1)) (fill (type none)))))")
    assert svg is not None
    assert 'width="300"' in svg
    assert 'height="225"' in svg
    assert meta.get("width_px") == 300


def test_viewbox_aspect_matches_viewport_for_tall_symbol():
    """
    Narrow/tall ink + 4:3 pixel box used to letterbox with ``meet``; viewBox should pad
    to the same aspect as width_px:height_px so the schematic fills the viewer.
    """
    sym = """
(symbol "U"
  (symbol "U_0_1"
    (rectangle (start -1.27 -10) (end 1.27 10) (stroke (width 0.2) (type default)) (fill (type none)))
    (pin passive line (at -5.08 0 0) (length 2.54)
      (name "A" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27)))))
  )
)
"""
    svg, _ = symbol_block_to_svg(sym.strip(), width_px=400, height_px=300)
    assert svg
    m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg)
    assert m
    bw, bh = float(m.group(1)), float(m.group(2))
    assert abs((bw / bh) - (400.0 / 300.0)) < 0.02
