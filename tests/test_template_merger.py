"""Unit tests for template_merger pin table merge."""
import unittest

from easyeda2kicad.kicad.parameters_kicad_symbol import (
    KiPinStyle,
    KiPinType,
    KiSymbolInfo,
    KiSymbolPin,
)
from easyeda2kicad.kicad.kicad_text_normalize import (
    normalize_for_kicad_text,
    normalize_property_key_for_match,
)
from easyeda2kicad.kicad.template_merger import (
    TemplateMerger,
    _find_pin_blocks,
    _find_primary_unit_pins_region,
)


def _make_pin(number: str, name: str = "", x: float = 0, y: float = 0) -> KiSymbolPin:
    return KiSymbolPin(
        name=name or number,
        number=number,
        style=KiPinStyle.line,
        length=2.54,
        type=KiPinType.passive,
        orientation=0,
        pos_x=x,
        pos_y=y,
    )


class TestKicadTextNormalize(unittest.TestCase):
    def test_celsius_aliases_match(self) -> None:
        """℃ (U+2103) vs °C (U+00B0 + C) must compare equal for template merge."""
        tpl = "B Constant (25\u2103/50\u2103)"
        lcsc = "B Constant (25\u00b0C/50\u00b0C)"
        self.assertEqual(
            normalize_property_key_for_match(tpl),
            normalize_property_key_for_match(lcsc),
        )

    def test_celsius_normalized_for_kicad(self) -> None:
        self.assertEqual(normalize_for_kicad_text("25\u2103"), "25\u00b0C")


class TestMergePropertyFuzzyKeys(unittest.TestCase):
    def test_lcsc_degree_c_matches_template_single_char_celsius(self) -> None:
        """LCSC uses °C; KiCad template field was saved with ℃ — value still merges."""
        # Template field label uses compatibility single-point ℃ (often tofu in KiCad).
        b_label = "B Constant (25\u2103/50\u2103)"
        tpl = f'''
(symbol "TplMerge"
  (property "{b_label}" "—"
    (at 0 0 0)
    (effects (font (size 1.27 1.27))))
  (symbol "TplMerge_0_1"
    (pin passive line (at 0 0 0) (length 1.27) (name "1" (effects)) (number "1" (effects)))
  )
)
'''
        info = KiSymbolInfo(
            name="NTC_10k",
            prefix="R",
            package="Lib:R_0402",
            manufacturer="X",
            datasheet="https://example.com/d.pdf",
            lcsc_id="C52155382",
            jlc_id="",
            symbol_params={"B Constant (25\u00b0C/50\u00b0C)": "4250K"},
        )
        merger = TemplateMerger()
        out = merger.merge(tpl, "TplMerge", info, source_pins=[_make_pin("1")])
        self.assertIn('"4250K"', out)
        self.assertNotIn("—", out)
        # Property name rewritten to °C spelling for font coverage
        self.assertIn('property "B Constant (25\u00b0C/50\u00b0C)"', out)
        self.assertNotIn("\u2103", out)

    def test_merge_fills_named_field_matching_value_param_key(self) -> None:
        """Second property named like the Value source param gets the same text as Value."""
        tpl = '''
(symbol "TplDup"
  (property "Value" "PLACE_V"
    (at 0 0 0)
    (effects (font (size 1.27 1.27))))
  (property "Resistance" "PLACE_R"
    (at 0 0 0)
    (effects (font (size 1.27 1.27))))
  (symbol "TplDup_0_1"
    (pin passive line (at 0 0 0) (length 1.27) (name "1" (effects)) (number "1" (effects)))
  )
)
'''
        info = KiSymbolInfo(
            name="R_10k",
            prefix="R",
            package="Lib:R_0402",
            manufacturer="X",
            datasheet="https://example.com/d.pdf",
            lcsc_id="C1",
            jlc_id="",
            value_override="10k",
            value_param_key="Resistance",
            symbol_params={},
        )
        merger = TemplateMerger()
        out = merger.merge(tpl, "TplDup", info, source_pins=[_make_pin("1")])
        self.assertIn('(property "Value" "10k"', out)
        self.assertIn('(property "Resistance" "10k"', out)
        self.assertNotIn("PLACE_", out)


class TestBuildValueMap(unittest.TestCase):
    def test_value_param_key_duplicates_value_for_second_template_field(self) -> None:
        """Extension omits valueParam from symbol_params; template fields named like that param still merge."""
        info = KiSymbolInfo(
            name="NTC_10k",
            prefix="R",
            package="Lib:R_0402",
            manufacturer="X",
            datasheet="https://example.com/d.pdf",
            lcsc_id="C52155382",
            jlc_id="",
            value_override="10k",
            value_param_key="Resistance",
            symbol_params={"B Constant (25°C/50°C)": "4250K"},
        )
        vmap = TemplateMerger._build_value_map(info)
        self.assertEqual(vmap["Value"], "10k")
        self.assertEqual(vmap["Resistance"], "10k")
        self.assertEqual(vmap["B Constant (25°C/50°C)"], "4250K")

    def test_symbol_params_do_not_overwrite_datasheet_url(self) -> None:
        """LCSC param table 'Datasheet' is filename text; KiCad field must stay the real URL."""
        info = KiSymbolInfo(
            name="R_10k",
            prefix="R",
            package="MyLib:R_0603",
            manufacturer="Vishay",
            datasheet="https://datasheet.lcsc.com/lcsc/2304141530_Vishay-RC0603.pdf",
            lcsc_id="C8733",
            jlc_id="",
            symbol_params={"Datasheet": "RC0603.pdf", "Tolerance": "1%"},
        )
        vmap = TemplateMerger._build_value_map(info)
        self.assertEqual(
            vmap["Datasheet"],
            "https://datasheet.lcsc.com/lcsc/2304141530_Vishay-RC0603.pdf",
        )
        self.assertEqual(vmap["Tolerance"], "1%")


class TestFindPinBlocks(unittest.TestCase):
    def test_finds_pins_and_numbers(self) -> None:
        sym = '''
(symbol "R_0_1"
  (pin passive line
    (at 0 2.54 0)
    (length 1.27)
    (name "1" (effects (font (size 1.27 1.27))))
    (number "1" (effects (font (size 1.27 1.27))))
  )
  (pin passive line
    (at 0 -2.54 180)
    (length 1.27)
    (name "2" (effects (font (size 1.27 1.27))))
    (number "2" (effects (font (size 1.27 1.27))))
  )
)
'''
        blocks = _find_pin_blocks(sym)
        self.assertEqual(len(blocks), 2)
        nums = [b[1] for b in blocks]
        self.assertEqual(nums, ["1", "2"])

    def test_find_primary_unit_region(self) -> None:
        sym = '''(symbol "Lib"
  (symbol "Lib_0_1"
    (pin passive line (at 0 0 0) (length 1) (name "1" (effects)) (number "1" (effects)))
  )
)
'''
        region = _find_primary_unit_pins_region(sym)
        self.assertIsNotNone(region)
        start, end = region
        self.assertIn("Lib_0_1", sym[start:end])
        self.assertIn("(pin ", sym[start:end])


class TestMergePinTable(unittest.TestCase):
    def test_add_missing_pins_at_origin(self) -> None:
        """Template has 2 pins; EasyEDA has 3. Third pin added at (0,0)."""
        template = '''
(symbol "T_0_1"
  (pin passive line
    (at 0 2.54 0)
    (length 1.27)
    (name "1" (effects (font (size 1.27 1.27))))
    (number "1" (effects (font (size 1.27 1.27))))
  )
  (pin passive line
    (at 0 -2.54 180)
    (length 1.27)
    (name "2" (effects (font (size 1.27 1.27))))
    (number "2" (effects (font (size 1.27 1.27))))
  )
)
'''
        source = [_make_pin("1", x=0, y=2.54), _make_pin("2", x=0, y=-2.54), _make_pin("3", x=5, y=0)]
        merger = TemplateMerger()
        result, kept, added, removed = merger._merge_pin_table(template, source)
        self.assertEqual(kept, 2)
        self.assertEqual(added, 1)
        self.assertEqual(removed, 0)
        blocks = _find_pin_blocks(result)
        self.assertEqual(len(blocks), 3)
        numbers = sorted(b[1] for b in blocks)
        self.assertEqual(numbers, ["1", "2", "3"])
        # New pin should be at 0,0
        self.assertIn("(at 0.00 0.00", result)

    def test_remove_template_only_pins(self) -> None:
        """Template has 3 pins; EasyEDA has 2. One pin removed."""
        template = '''
(symbol "T_0_1"
  (pin passive line (at 0 2.54 0) (length 1.27) (name "1" (effects)) (number "1" (effects)))
  (pin passive line (at 0 0 90) (length 1.27) (name "2" (effects)) (number "2" (effects)))
  (pin passive line (at 0 -2.54 180) (length 1.27) (name "3" (effects)) (number "3" (effects)))
)
'''
        source = [_make_pin("1"), _make_pin("2")]
        merger = TemplateMerger()
        result, kept, added, removed = merger._merge_pin_table(template, source)
        self.assertEqual(kept, 2)
        self.assertEqual(added, 0)
        self.assertEqual(removed, 1)
        blocks = _find_pin_blocks(result)
        self.assertEqual(len(blocks), 2)
        numbers = sorted(b[1] for b in blocks)
        self.assertEqual(numbers, ["1", "2"])

    def test_disjoint_pin_sets_keep_template_numbers(self) -> None:
        """Template G,D,S at fixed positions; LCSC 1,2,3 — keep template numbers, no (0,0) pins."""
        template = '''
(symbol "T_0_1"
  (pin passive line
    (at 10.16 0 180)
    (length 1.27)
    (name "G" (effects (font (size 1.27 1.27))))
    (number "G" (effects (font (size 1.27 1.27))))
  )
  (pin passive line
    (at -10.16 -5.08 0)
    (length 1.27)
    (name "D" (effects (font (size 1.27 1.27))))
    (number "D" (effects (font (size 1.27 1.27))))
  )
  (pin passive line
    (at -10.16 5.08 0)
    (length 1.27)
    (name "S" (effects (font (size 1.27 1.27))))
    (number "S" (effects (font (size 1.27 1.27))))
  )
)
'''
        source = [
            _make_pin("1", name="GATE", x=0, y=0),
            _make_pin("2", name="DRAIN", x=0, y=0),
            _make_pin("3", name="SOURCE", x=0, y=0),
        ]
        merger = TemplateMerger()
        result, kept, added, removed = merger._merge_pin_table(template, source)
        self.assertEqual(kept, 3)
        self.assertEqual(added, 0)
        self.assertEqual(removed, 0)
        blocks = _find_pin_blocks(result)
        self.assertEqual(len(blocks), 3)
        numbers = sorted(b[1] for b in blocks)
        self.assertEqual(numbers, ["D", "G", "S"])
        self.assertIn("(at 10.16 0 180)", result)
        self.assertIn("(at -10.16 -5.08 0)", result)
        self.assertIn("(at -10.16 5.08 0)", result)
        self.assertNotIn("(at 0.00 0.00", result)

    def test_mixed_add_and_remove(self) -> None:
        """Template has pins 1,3,5; EasyEDA has 2,3,4. Keep 3, add 2 and 4, remove 1 and 5."""
        template = '''
(symbol "T_0_1"
  (pin passive line (at 1 0 0) (length 1.27) (name "1" (effects)) (number "1" (effects)))
  (pin passive line (at 2 0 0) (length 1.27) (name "3" (effects)) (number "3" (effects)))
  (pin passive line (at 3 0 0) (length 1.27) (name "5" (effects)) (number "5" (effects)))
)
'''
        source = [_make_pin("2"), _make_pin("3"), _make_pin("4")]
        merger = TemplateMerger()
        result, kept, added, removed = merger._merge_pin_table(template, source)
        self.assertEqual(kept, 1)
        self.assertEqual(added, 2)
        self.assertEqual(removed, 2)
        blocks = _find_pin_blocks(result)
        self.assertEqual(len(blocks), 3)
        numbers = sorted(b[1] for b in blocks)
        self.assertEqual(numbers, ["2", "3", "4"])
