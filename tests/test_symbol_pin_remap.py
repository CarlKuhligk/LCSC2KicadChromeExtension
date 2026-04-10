"""Tests for schematic pin number remapping."""

from easyeda2kicad.kicad.symbol_pin_remap import (
    apply_pin_number_map,
    list_pins_from_symbol_block,
)

_PIN_SYM = """
(symbol "T"
  (symbol "T_0_1"
    (pin passive line (at 0 0 0) (length 2.54)
      (name "A" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27)))))
    (pin passive line (at 5 0 0) (length 2.54)
      (name "B" (effects (font (size 1.27 1.27))))
      (number "2" (effects (font (size 1.27 1.27)))))
  )
)
"""


def test_list_pins_from_symbol_block():
    pins = list_pins_from_symbol_block(_PIN_SYM)
    assert len(pins) == 2
    assert pins[0]["number"] == "1" and pins[0]["name"] == "A"
    assert pins[1]["number"] == "2" and pins[1]["name"] == "B"


def test_apply_pin_number_map_swaps():
    out = apply_pin_number_map(_PIN_SYM.strip(), {"1": "2", "2": "1"})
    assert '(number "2"' in out.split("(pin")[1]
    assert '(number "1"' in out.split("(pin")[2]


def test_duplicate_targets_skips_remap():
    out = apply_pin_number_map(_PIN_SYM.strip(), {"1": "3", "2": "3"})
    assert out == _PIN_SYM.strip()


def test_apply_pin_number_map_renames_all_instances_same_number():
    """Multi-unit (or duplicate) pins share one logical number — all must be updated."""
    sym = """
(symbol "U"
  (symbol "U_0_1"
    (pin passive line (at 0 0 0) (length 2.54)
      (name "A" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27)))))
  )
  (symbol "U_1_1"
    (pin passive line (at 0 0 0) (length 2.54)
      (name "A" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27)))))
  )
)
"""
    out = apply_pin_number_map(sym.strip(), {"1": "PAD_A"})
    assert out.count('(number "PAD_A"') == 2
    assert '(number "1"' not in out


def test_apply_pin_number_map_asymmetric_length():
    """Two-phase rename must not corrupt offsets when new numbers differ in length."""
    out = apply_pin_number_map(_PIN_SYM.strip(), {"1": "THERMAL", "2": "IO"})
    pins = list_pins_from_symbol_block(out)
    nums = {p["number"] for p in pins}
    assert nums == {"THERMAL", "IO"}


def test_apply_pin_number_map_leading_zero_key_matches_symbol():
    """Gallery / JSON may use "01"; merged symbol uses "1" — still one logical pin."""
    sym = _PIN_SYM.strip().replace('(number "1"', '(number "01"', 1)
    out = apply_pin_number_map(sym, {"1": "P1", "2": "P2"})
    pins = list_pins_from_symbol_block(out)
    nums = {p["number"] for p in pins}
    assert nums == {"P1", "P2"}


def test_apply_pin_number_map_skips_unknown_keys_still_renames_rest():
    """Stale or extra map keys must not cancel the whole remap."""
    out = apply_pin_number_map(_PIN_SYM.strip(), {"1": "A", "2": "B", "99": "Z", "ghost": "X"})
    pins = list_pins_from_symbol_block(out)
    nums = {p["number"] for p in pins}
    assert nums == {"A", "B"}
