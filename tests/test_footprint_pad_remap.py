"""Tests for template pin→pad footprint renaming."""

from easyeda2kicad.easyeda.parameters_easyeda import (
    Ee3dModel,
    Ee3dModelBase,
    EeFootprint,
    EeFootprintBbox,
    EeFootprintInfo,
    EeFootprintPad,
)
from easyeda2kicad.kicad.footprint_pad_remap import (
    apply_template_pin_map_to_footprint,
    normalize_easyeda_pad_number,
)


def _pad(num: str) -> EeFootprintPad:
    return EeFootprintPad(
        shape="RECT",
        center_x=0.0,
        center_y=0.0,
        width=1.0,
        height=1.0,
        layer_id=1,
        net="",
        number=num,
        hole_radius=0.0,
        points="",
        rotation=0.0,
        id="x",
        hole_length=0.0,
        hole_point="",
        is_plated=True,
        is_locked=False,
    )


def _minimal_fp(pads: list[EeFootprintPad]) -> EeFootprint:
    return EeFootprint(
        info=EeFootprintInfo(name="T", fp_type="smd", model_3d_name=""),
        bbox=EeFootprintBbox(x=0.0, y=0.0),
        model_3d=Ee3dModel(
            name="",
            uuid="",
            translation=Ee3dModelBase(),
            rotation=Ee3dModelBase(),
        ),
        pads=pads,
    )


def test_remap_single_pad() -> None:
    fp = _minimal_fp([_pad("16"), _pad("2")])
    apply_template_pin_map_to_footprint(fp, {"1": "16"})
    assert fp.pads[0].number == "1"
    assert fp.pads[1].number == "2"


def test_remap_swap_two_pads() -> None:
    fp = _minimal_fp([_pad("1"), _pad("2")])
    apply_template_pin_map_to_footprint(fp, {"1": "2", "2": "1"})
    nums = {p.number for p in fp.pads}
    assert nums == {"1", "2"}


def test_empty_map_noop() -> None:
    fp = _minimal_fp([_pad("3")])
    apply_template_pin_map_to_footprint(fp, {})
    assert fp.pads[0].number == "3"


def test_normalize_easyeda_pad_number_plain() -> None:
    assert normalize_easyeda_pad_number("1") == "1"
    assert normalize_easyeda_pad_number("  EP ") == "EP"
    assert normalize_easyeda_pad_number("A1") == "A1"


def test_normalize_easyeda_pad_number_wrapped() -> None:
    assert normalize_easyeda_pad_number("$PAD(1)") == "1"
    assert normalize_easyeda_pad_number("$pad(EP)$") == "EP"
    assert normalize_easyeda_pad_number("$3$") == "3"
    assert normalize_easyeda_pad_number("wrap(7)") == "7"
