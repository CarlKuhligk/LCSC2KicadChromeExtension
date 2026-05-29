"""Paired tests for the Python Category Path normalization mirror.

The canonical implementation is
``chrome_extension/shared/categoryPath.mjs::normalizeCategoryPath`` (JS).
This test file exercises the Python mirror
``easyeda2kicad.helpers.normalize_category_path`` against the same input corpus
as ``chrome_extension/shared/categoryPath.test.mjs``. When one side drifts in
the future, this test fails.
"""

import unittest

from easyeda2kicad.helpers import normalize_category_path


class TestNormalizeCategoryPath(unittest.TestCase):
    # ----- Behavior assertions (mirror of categoryPath.test.mjs) -------------

    def test_non_string_input_returns_empty(self) -> None:
        self.assertEqual(normalize_category_path(None), "")
        self.assertEqual(normalize_category_path(42), "")
        self.assertEqual(normalize_category_path({}), "")
        self.assertEqual(normalize_category_path([]), "")

    def test_strips_leading_and_trailing_slashes(self) -> None:
        self.assertEqual(normalize_category_path("/A/B/C/"), "A/B/C")
        self.assertEqual(normalize_category_path("///A///"), "A")

    def test_collapses_repeated_slashes(self) -> None:
        self.assertEqual(
            normalize_category_path("Passives///Resistors//SMD"),
            "Passives/Resistors/SMD",
        )

    def test_trims_segments_and_drops_empties(self) -> None:
        self.assertEqual(
            normalize_category_path("  Passives  /  Resistors  /  SMD  "),
            "Passives/Resistors/SMD",
        )
        self.assertEqual(normalize_category_path("A/  /B"), "A/B")

    def test_converts_backslashes(self) -> None:
        self.assertEqual(normalize_category_path("A\\B\\C"), "A/B/C")
        self.assertEqual(
            normalize_category_path("Mixed\\And/Slashes"), "Mixed/And/Slashes"
        )

    def test_unicode_nfc(self) -> None:
        # U+0065 U+0301 (e + combining acute) → U+00E9 (precomposed é).
        decomposed = "Café/Sub"
        precomposed = "Café/Sub"
        self.assertEqual(normalize_category_path(decomposed), precomposed)
        self.assertEqual(
            normalize_category_path(decomposed),
            normalize_category_path(precomposed),
        )

    def test_empty_and_slashes_only(self) -> None:
        self.assertEqual(normalize_category_path(""), "")
        self.assertEqual(normalize_category_path("   "), "")
        self.assertEqual(normalize_category_path("///"), "")

    def test_preserves_casing_and_inner_punctuation(self) -> None:
        self.assertEqual(
            normalize_category_path("Resistors/SMD 0805/±1%"),
            "Resistors/SMD 0805/±1%",
        )

    # ----- Cross-language parity corpus --------------------------------------

    def test_shared_corpus_parity(self) -> None:
        """Expected outputs come from running the JS ESM implementation on the
        same inputs. If the Python rule diverges, this test catches it."""
        cases = [
            (None, ""),
            (42, ""),
            ({}, ""),
            ("", ""),
            ("   ", ""),
            ("///", ""),
            ("/A/B/C/", "A/B/C"),
            ("Passives///Resistors//SMD", "Passives/Resistors/SMD"),
            ("  Passives  /  Resistors  /  SMD  ", "Passives/Resistors/SMD"),
            ("A\\B\\C", "A/B/C"),
            ("Café/Sub", "Café/Sub"),
            ("Resistors/SMD 0805/±1%", "Resistors/SMD 0805/±1%"),
        ]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_category_path(raw), expected)


if __name__ == "__main__":
    unittest.main()
