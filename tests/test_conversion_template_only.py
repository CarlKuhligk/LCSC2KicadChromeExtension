"""Template-only import path (no EasyEDA CAD data) — Issue #9 follow-up.

A part EasyEDA does not carry (``get_cad_data`` returns nothing) must still be
importable when BOTH the symbol and the footprint come from templates: the
properties come from the scraped page params, the pins from the template itself,
and the footprint is copied from the template ``.pretty``. Before this fix the
conversion always fetched EasyEDA and died with "No CAD data received".

All tests here are offline — the EasyEDA fetch is monkeypatched to BLOW UP if it
is ever reached on a template-only conversion (proving it is not needed).
"""

from __future__ import annotations

from pathlib import Path

import pytest

import easyeda2kicad.service.conversion as conv
from easyeda2kicad.service.conversion import (
    ConversionRequest,
    _export_symbol_from_template,
    run_conversion,
)

# Tab-indented like real KiCad-saved .kicad_sym files (the merger appends extra
# LCSC fields before the tab-indented closing "\t)" — space indentation misses it).
_TEMPLATE_SYM = (
    "(kicad_symbol_lib (version 20240618) (generator test)\n"
    '\t(symbol "TplR"\n'
    '\t\t(property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27))))\n'
    '\t\t(property "Value" "R" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))\n'
    '\t\t(property "Footprint" "" (at 0 -5.08 0) (effects (font (size 1.27 1.27))))\n'
    '\t\t(symbol "TplR_0_1"\n'
    "\t\t\t(rectangle (start -2.54 1.27) (end 2.54 -1.27) (stroke (width 0.254)) (fill (type none)))\n"
    "\t\t\t(pin passive line (at -5.08 0 0) (length 2.54)\n"
    '\t\t\t\t(name "1" (effects (font (size 1.27 1.27))))\n'
    '\t\t\t\t(number "1" (effects (font (size 1.27 1.27)))))\n'
    "\t\t\t(pin passive line (at 5.08 0 180) (length 2.54)\n"
    '\t\t\t\t(name "2" (effects (font (size 1.27 1.27))))\n'
    '\t\t\t\t(number "2" (effects (font (size 1.27 1.27)))))\n'
    "\t\t)\n"
    "\t)\n"
    ")\n"
)

_TEMPLATE_MOD = """(footprint "R0603" (layer "F.Cu")
  (pad "1" smd roundrect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "2" smd roundrect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask"))
  (model "${KIPRJMOD}/3d/R0603.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
)
"""


def _make_template_lib(tmp_path: Path) -> Path:
    """Write Templates.kicad_sym + sibling Templates.pretty/R0603.kicad_mod; return the .kicad_sym path."""
    sym = tmp_path / "Templates.kicad_sym"
    sym.write_text(_TEMPLATE_SYM, encoding="utf-8")
    pretty = tmp_path / "Templates.pretty"
    pretty.mkdir()
    (pretty / "R0603.kicad_mod").write_text(_TEMPLATE_MOD, encoding="utf-8")
    return sym


# ---------------------------------------------------------------------------
# _export_symbol_from_template with primary_symbol=None (no EasyEDA)
# ---------------------------------------------------------------------------


def test_template_only_symbol_built_without_cad_data(tmp_path: Path) -> None:
    sym = _make_template_lib(tmp_path)
    request = ConversionRequest(
        lcsc_id="C7464890",
        output_prefix=str(tmp_path / "TestImport"),
        overwrite=True,
        generate_symbol=True,
        use_template=True,
        template_name="TplR",
        template_lib_path=str(sym),
        force_template=True,
        use_footprint_template=True,
        footprint_template_name="R0603",
        footprint_template_lib_path=str(sym),
        force_footprint_template=True,
        symbol_value_override="10k",
        symbol_value_param_key="Resistance",
        symbol_params={"Tolerance": "1%"},
    )

    out = _export_symbol_from_template(request, None, library_name="TestImport")

    assert out  # non-empty merged symbol
    assert "10k" in out  # value_override → Value field
    assert "C7464890" in out  # LCSC Part property from the request
    assert "TestImport:R0603" in out  # Footprint property points at the template FP
    assert "Tolerance" in out and "1%" in out  # page param upserted
    # Template's OWN pins are kept (source_pins=None → no pin-table rewrite).
    assert '(number "1"' in out and '(number "2"' in out


# ---------------------------------------------------------------------------
# run_conversion end-to-end, template-only, EasyEDA fetch must NOT be called
# ---------------------------------------------------------------------------


def test_run_conversion_template_only_skips_easyeda(tmp_path: Path, monkeypatch) -> None:
    sym = _make_template_lib(tmp_path)

    def _boom(*_args, **_kwargs):
        raise AssertionError("EasyEDA fetch must not run for a template-only import")

    # Any attempt to reach EasyEDA blows up — proving template-only needs none.
    monkeypatch.setattr(conv, "_cad_fetch_with_pulsing_progress", _boom)

    request = ConversionRequest(
        lcsc_id="C7464890",
        output_prefix=str(tmp_path / "TestImport"),
        overwrite=True,
        generate_symbol=True,
        generate_footprint=True,
        generate_model=False,
        use_template=True,
        template_name="TplR",
        template_lib_path=str(sym),
        force_template=True,
        use_footprint_template=True,
        footprint_template_name="R0603",
        footprint_template_lib_path=str(sym),
        force_footprint_template=True,
        symbol_value_override="10k",
    )

    result = run_conversion(request)

    # Symbol written into the target library with the template + value baked in.
    symbol_file = tmp_path / "TestImport.kicad_sym"
    assert symbol_file.is_file()
    sym_text = symbol_file.read_text(encoding="utf-8")
    assert "10k" in sym_text
    assert "TestImport:R0603" in sym_text

    # Footprint copied from the template .pretty into the target .pretty.
    fp_file = tmp_path / "TestImport.pretty" / "R0603.kicad_mod"
    assert fp_file.is_file()
    assert "${KIPRJMOD}/3d/R0603.step" in fp_file.read_text(encoding="utf-8")

    assert result.symbol_path and result.footprint_path


def test_run_conversion_easyeda_footprint_still_needs_cad_data(tmp_path: Path, monkeypatch) -> None:
    """Symbol=template but footprint=EasyEDA STILL needs the fetch — the skip is
    only for a fully-template import. Here the (boom) fetch must be reached."""
    sym = _make_template_lib(tmp_path)

    def _boom(*_args, **_kwargs):
        raise RuntimeError("fetch-was-called")

    monkeypatch.setattr(conv, "_cad_fetch_with_pulsing_progress", _boom)

    request = ConversionRequest(
        lcsc_id="C7464890",
        output_prefix=str(tmp_path / "TestImport"),
        overwrite=True,
        generate_symbol=True,
        generate_footprint=True,
        generate_model=False,
        use_template=True,
        template_name="TplR",
        template_lib_path=str(sym),
        force_template=True,
        # footprint stays EasyEDA → fetch required
        use_footprint_template=False,
    )

    with pytest.raises(conv.ConversionError, match="Failed to fetch data"):
        run_conversion(request)
