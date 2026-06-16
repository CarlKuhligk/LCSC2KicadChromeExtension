"""Tests for the .kicad_mod → SVG footprint preview renderer (Footprint-Slice Etappe 1)."""

from easyeda2kicad.kicad.footprint_mod_preview_svg import kicad_mod_to_preview_svg

_SMD_0603 = """
(footprint "R_0603"
  (layer "F.Cu")
  (pad "1" smd roundrect (at -0.8 0) (size 0.8 0.95)
    (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
  (pad "2" smd roundrect (at 0.8 0) (size 0.8 0.95)
    (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
  (fp_line (start -1.5 0.7) (end 1.5 0.7) (layer "F.SilkS") (width 0.12))
  (fp_circle (center 0 0) (end 0.3 0) (layer "F.Fab") (width 0.1))
)
"""

_THRU_HOLE = """
(footprint "TH1"
  (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask"))
  (pad "2" thru_hole oval (at 2.54 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask"))
)
"""


def test_renders_smd_pads_and_silk():
    svg, meta = kicad_mod_to_preview_svg(_SMD_0603)
    assert svg is not None
    assert "<svg" in svg and "viewBox" in svg
    # Two copper pads.
    assert svg.count('fill="#dc2626"') == 2
    # Pad numbers are labelled.
    assert ">1<" in svg and ">2<" in svg
    # Silk outline line + fab circle rendered.
    assert "<line" in svg
    assert "<circle" in svg
    assert meta["pad_count"] == 2
    assert meta["outline_count"] == 2


def test_through_hole_pads_draw_drill():
    svg, meta = kicad_mod_to_preview_svg(_THRU_HOLE)
    assert svg is not None
    assert meta["pad_count"] == 2
    # Each through-hole pad draws a dark drill hole on top of the copper.
    assert svg.count('fill="#1e293b"') == 2


def test_circle_pad_uses_circle_element():
    svg, _ = kicad_mod_to_preview_svg(_THRU_HOLE)
    # The circle pad "1" renders as a <circle> copper shape.
    assert '<circle cx=' in svg


def test_empty_footprint_is_error():
    svg, err = kicad_mod_to_preview_svg("(footprint \"X\" (layer \"F.Cu\"))")
    assert svg is None
    assert err["error"] == "empty_footprint"


def test_blank_input_is_error():
    svg, err = kicad_mod_to_preview_svg("")
    assert svg is None
    assert err["error"] == "footprint_too_large"


def test_too_large_is_error():
    svg, err = kicad_mod_to_preview_svg("(" * 600_000)
    assert svg is None
    assert err["error"] == "footprint_too_large"


def test_rotated_pad_emits_transform():
    mod = """
    (footprint "ROT"
      (pad "1" smd rect (at 0 0 90) (size 1.0 0.5) (layers "F.Cu"))
    )
    """
    svg, _ = kicad_mod_to_preview_svg(mod)
    assert svg is not None
    assert "rotate(-90" in svg
