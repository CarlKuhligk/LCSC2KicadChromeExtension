"""Unit tests for template_merger pin table merge."""
import unittest

from easyeda2kicad.kicad.parameters_kicad_symbol import (
    KiPinStyle,
    KiPinType,
    KiSymbolPin,
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
