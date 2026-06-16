"""Whitespace hygiene for KiCad symbol properties.

KiCad warns ("Some symbols contain leading/trailing spaces") on fields padded
with leading/trailing whitespace. ``strip_property_whitespace`` is the single
routine that guards both the import write path
(``helpers.add_component_in_symbol_lib_file``) and the library-cleanup verb.
"""
from pathlib import Path

from easyeda2kicad.helpers import add_component_in_symbol_lib_file
from easyeda2kicad.kicad.kicad_text_normalize import strip_property_whitespace


def test_trims_leading_and_trailing_on_value():
    assert (
        strip_property_whitespace('(property "Tolerance" " 1% ")')
        == '(property "Tolerance" "1%")'
    )


def test_trims_key_too():
    assert (
        strip_property_whitespace('(property " Power " "0.1W")')
        == '(property "Power" "0.1W")'
    )


def test_multiple_properties_in_one_string():
    src = '(property "A" " x ")\n(property " B" "y ")'
    assert strip_property_whitespace(src) == '(property "A" "x")\n(property "B" "y")'


def test_preserves_internal_spacing():
    # Only the edges are trimmed; "100 nF" must stay intact.
    assert (
        strip_property_whitespace('(property "Capacitance" " 100 nF ")')
        == '(property "Capacitance" "100 nF")'
    )


def test_noop_when_already_clean():
    src = '(property "Value" "10k" (at 0 0 0))'
    assert strip_property_whitespace(src) == src


def test_keeps_trailing_sexpr_attributes():
    src = '(property "Reference" " R " (at 0 5 0) (effects))'
    assert (
        strip_property_whitespace(src)
        == '(property "Reference" "R" (at 0 5 0) (effects))'
    )


def test_does_not_touch_pin_name_or_number():
    # Pin (name "...") / (number "...") are not (property ...) — leave them alone.
    src = '(pin (name " A ") (number " 1 "))'
    assert strip_property_whitespace(src) == src


def test_empty_value_stays_empty():
    assert (
        strip_property_whitespace('(property "Footprint" "")')
        == '(property "Footprint" "")'
    )


def test_handles_newline_between_key_and_value():
    src = '(property "Mfr"\n  " ACME ")'
    assert strip_property_whitespace(src) == '(property "Mfr"\n  "ACME")'


def test_empty_input():
    assert strip_property_whitespace("") == ""


def _write_empty_lib(path: Path) -> None:
    path.write_text(
        "(kicad_symbol_lib\n"
        "  (version 20211014)\n"
        "  (generator kicad_symbol_editor)\n"
        ")\n",
        encoding="utf-8",
    )


def test_add_component_strips_property_whitespace(tmp_path):
    """The convergence writer trims padded fields before they hit the file —
    this is the guarantee that covers template-inherited fields too."""
    lib = tmp_path / "Test.kicad_sym"
    _write_empty_lib(lib)

    component = (
        '(symbol "R_test"\n'
        '  (property "Reference" "R" (at 0 0 0))\n'
        '  (property "Value" " 10k " (at 0 0 0))\n'
        '  (property " Tolerance " " 1% " (at 0 0 0))\n'
        ")"
    )
    add_component_in_symbol_lib_file(lib_path=str(lib), component_content=component)

    written = lib.read_text(encoding="utf-8")
    assert '(property "Value" "10k"' in written
    assert '(property "Tolerance" "1%"' in written
    assert '" 10k "' not in written
    assert '" 1% "' not in written
    assert '" Tolerance "' not in written
