"""Regression: preview viewBox must match padded ink bounds (no double-applied margin)."""

import re

from easyeda2kicad.easyeda.parameters_easyeda import EeFootprintPad
from easyeda2kicad.kicad.export_kicad_footprint import (
    easyeda_ki_shape_for_footprint_pad,
    easyeda_pad_has_through_hole,
    easyeda_pad_shape_to_kicad,
)
from easyeda2kicad.kicad.footprint_preview_svg import (
    _pad_number_font_size_mm,
    ki_footprint_to_preview_svg,
)
from easyeda2kicad.kicad.parameters_kicad_footprint import (
    Ki3dModel,
    Ki3dModelBase,
    KiFootprint,
    KiFootprintHole,
    KiFootprintInfo,
    KiFootprintPad,
)


def _single_rect_pad_fp() -> KiFootprint:
    return KiFootprint(
        info=KiFootprintInfo(name="t", fp_type="smd"),
        model_3d=Ki3dModel(
            name="",
            translation=Ki3dModelBase(),
            rotation=Ki3dModelBase(),
            raw_wrl=None,
        ),
        pads=[
            KiFootprintPad(
                type="smd",
                shape="rect",
                pos_x=0.0,
                pos_y=0.0,
                width=1.0,
                height=1.0,
                layers="F.Cu",
                number="1",
                drill="",
                orientation=0.0,
                polygon="",
            )
        ],
        tracks=[],
    )


def _empty_fp() -> KiFootprint:
    return KiFootprint(
        info=KiFootprintInfo(name="t", fp_type="tht"),
        model_3d=Ki3dModel(
            name="",
            translation=Ki3dModelBase(),
            rotation=Ki3dModelBase(),
            raw_wrl=None,
        ),
        pads=[],
        tracks=[],
    )


def test_footprint_preview_thru_hole_drill_circle() -> None:
    fp = _empty_fp()
    fp.pads.append(
        KiFootprintPad(
            type="thru_hole",
            shape="circle",
            pos_x=2.0,
            pos_y=2.0,
            width=1.6,
            height=1.6,
            layers="*.Cu *.Mask",
            number="1",
            drill="(drill 0.8)",
            orientation=0.0,
            polygon="",
        )
    )
    svg, meta = ki_footprint_to_preview_svg(fp, pad_mm=0.5)
    assert svg is not None
    assert "k2c-fp-drill" in svg
    assert '<ellipse' in svg
    assert float(meta["view_w_mm"]) > 0


def _ee_pad(shape: str, w: float, h: float, points: str = "") -> EeFootprintPad:
    return EeFootprintPad(
        shape=shape,
        center_x=0.0,
        center_y=0.0,
        width=w,
        height=h,
        layer_id=1,
        net="",
        number="1",
        hole_radius=0.0,
        points=points,
        rotation=0.0,
        id="t",
        hole_length=0.0,
        hole_point="",
        is_plated=True,
        is_locked=False,
    )


def test_easyeda_pad_shape_aliases() -> None:
    assert easyeda_pad_shape_to_kicad("ellipse") == "circle"
    assert easyeda_pad_shape_to_kicad("ELLIPSE") == "circle"
    assert easyeda_pad_shape_to_kicad("round") == "circle"
    assert easyeda_pad_shape_to_kicad("RECT") == "rect"
    assert easyeda_pad_shape_to_kicad("oval") == "oval"
    assert easyeda_pad_shape_to_kicad("ROUNDRECT") == "roundrect"
    assert easyeda_pad_shape_to_kicad("RRECT") == "roundrect"
    assert easyeda_pad_shape_to_kicad("CHAMFER_RECT") == "chamfrect"


def test_easyeda_round_vs_roundrect_by_aspect() -> None:
    assert easyeda_ki_shape_for_footprint_pad(_ee_pad("ROUND", 1.0, 1.0)) == "circle"
    assert easyeda_ki_shape_for_footprint_pad(_ee_pad("ROUND", 2.5, 0.6)) == "roundrect"


def test_easyeda_oval_pill_vs_ellipse() -> None:
    assert easyeda_ki_shape_for_footprint_pad(_ee_pad("OVAL", 4.0, 0.8)) == "roundrect"
    assert easyeda_ki_shape_for_footprint_pad(_ee_pad("OVAL", 1.0, 0.95)) == "oval"


def test_easyeda_through_hole_slot_by_length() -> None:
    p = EeFootprintPad(
        shape="OVAL",
        center_x=0.0,
        center_y=0.0,
        width=3.0,
        height=1.0,
        layer_id=1,
        net="",
        number="1",
        hole_radius=0.0,
        points="",
        rotation=0.0,
        id="x",
        hole_length=2.0,
        hole_point="",
        is_plated=True,
        is_locked=False,
    )
    assert easyeda_pad_has_through_hole(p)


def test_footprint_preview_chamfrect_svg_path() -> None:
    fp = _empty_fp()
    fp.pads.append(
        KiFootprintPad(
            type="smd",
            shape="chamfrect",
            pos_x=0.0,
            pos_y=0.0,
            width=3.0,
            height=2.0,
            layers="F.Cu",
            number="1",
            drill="",
            orientation=0.0,
            polygon="",
            chamfer_tl=0.25,
            chamfer_tr=0.25,
            chamfer_br=0.25,
            chamfer_bl=0.25,
        )
    )
    svg, _meta = ki_footprint_to_preview_svg(fp, pad_mm=0.5)
    assert svg is not None
    assert "<path " in svg
    assert 'd="M' in svg


def test_pad_number_font_size_scales_with_pad_and_label() -> None:
    assert _pad_number_font_size_mm(0.2, 0.25, "1") < _pad_number_font_size_mm(2.0, 2.5, "1")
    assert _pad_number_font_size_mm(1.0, 1.0, "1") > _pad_number_font_size_mm(1.0, 1.0, "999")
    tiny = _pad_number_font_size_mm(0.08, 0.1, "12")
    assert 0.075 <= tiny <= 0.5


def test_footprint_preview_two_pads_smaller_font_for_smaller_pad() -> None:
    fp = _empty_fp()
    for px, py, ww, hh, n in (
        (0.0, 0.0, 0.22, 0.28, "1"),
        (4.0, 0.0, 2.8, 2.2, "2"),
    ):
        fp.pads.append(
            KiFootprintPad(
                type="smd",
                shape="rect",
                pos_x=px,
                pos_y=py,
                width=ww,
                height=hh,
                layers="F.Cu",
                number=n,
                drill="",
                orientation=0.0,
                polygon="",
            )
        )
    svg, _meta = ki_footprint_to_preview_svg(fp, pad_mm=0.5)
    assert svg is not None
    sizes = [
        float(m.group(1))
        for m in re.finditer(
            r'<text class="k2c-fp-pad-num"[^>]*font-size="([0-9.]+)"',
            svg,
        )
    ]
    assert len(sizes) == 2
    assert sizes[0] < sizes[1]


def test_footprint_preview_roundrect_svg_rect() -> None:
    fp = _empty_fp()
    fp.pads.append(
        KiFootprintPad(
            type="smd",
            shape="roundrect",
            pos_x=1.0,
            pos_y=1.0,
            width=2.0,
            height=1.0,
            layers="F.Cu",
            number="1",
            drill="",
            orientation=0.0,
            polygon="",
            roundrect_rratio=0.25,
        )
    )
    svg, _meta = ki_footprint_to_preview_svg(fp, pad_mm=0.5)
    assert svg is not None
    assert "<rect " in svg
    assert 'rx="' in svg


def test_footprint_preview_npth_hole() -> None:
    fp = _empty_fp()
    fp.holes.append(KiFootprintHole(pos_x=1.0, pos_y=1.0, size=1.2))
    svg, _meta = ki_footprint_to_preview_svg(fp, pad_mm=0.5)
    assert svg is not None
    assert "k2c-fp-npth" in svg


def test_footprint_preview_symmetric_padding_in_viewbox() -> None:
    """Ink should sit centered in viewBox; previously +pad in _to_svg doubled one side."""
    pad_mm = 0.5
    svg, meta = ki_footprint_to_preview_svg(_single_rect_pad_fp(), pad_mm=pad_mm)
    assert svg is not None
    w = float(meta["view_w_mm"])
    h = float(meta["view_h_mm"])
    m = re.search(r'viewBox="0 0 ([0-9.]+) ([0-9.]+)"', svg)
    assert m is not None
    assert abs(float(m.group(1)) - w) < 1e-6
    assert abs(float(m.group(2)) - h) < 1e-6

    poly_m = re.search(r'points="([^"]+)"', svg)
    assert poly_m is not None
    pairs = []
    for part in poly_m.group(1).split():
        ax, ay = part.split(",")
        pairs.append((float(ax), float(ay)))
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]
    margin_x0 = min(xs)
    margin_x1 = w - max(xs)
    margin_y0 = min(ys)
    margin_y1 = h - max(ys)
    assert abs(margin_x0 - pad_mm) < 0.02, (margin_x0, pad_mm)
    assert abs(margin_x1 - pad_mm) < 0.02, (margin_x1, pad_mm)
    assert abs(margin_y0 - pad_mm) < 0.02, (margin_y0, pad_mm)
    assert abs(margin_y1 - pad_mm) < 0.02, (margin_y1, pad_mm)


def test_footprint_preview_root_dimensions_match_viewbox_aspect() -> None:
    """Root width/height aspect must match viewBox so CSS sizing aligns with paint and hit targets."""
    fp = _empty_fp()
    fp.pads.append(
        KiFootprintPad(
            type="smd",
            shape="rect",
            pos_x=0.0,
            pos_y=0.0,
            width=8.0,
            height=1.0,
            layers="F.Cu",
            number="1",
            drill="",
            orientation=0.0,
            polygon="",
        )
    )
    svg, _meta = ki_footprint_to_preview_svg(fp, width_px=220, height_px=220, pad_mm=0.5)
    assert svg is not None
    vb = re.search(r'viewBox="0 0 ([0-9.]+) ([0-9.]+)"', svg)
    wh = re.search(r'width="(\d+)" height="(\d+)"', svg)
    assert vb is not None and wh is not None
    vw, vh = float(vb.group(1)), float(vb.group(2))
    ow, oh = int(wh.group(1)), int(wh.group(2))
    assert vw > vh * 1.5
    assert abs((ow / oh) - (vw / vh)) < 0.02
    assert max(ow, oh) == 220
