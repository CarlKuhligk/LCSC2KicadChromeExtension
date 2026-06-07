"""Paired tests for the Python Category Path normalization mirror.

The canonical implementation is
``chrome_extension/shared/categoryPath.mjs::normalizeCategoryPath`` (JS).
This test file exercises the Python mirrors
``easyeda2kicad.helpers.normalize_category_path``,
``easyeda2kicad.helpers.canonical_category_key``,
``easyeda2kicad.helpers.merge_category_config`` and
``easyeda2kicad.helpers.dedupe_category_settings`` against the same input
corpus as ``chrome_extension/shared/categoryPath.test.mjs``. When one side
drifts in the future, this test fails.
"""

import unittest

from easyeda2kicad.helpers import (
    canonical_category_key,
    dedupe_category_settings,
    merge_category_config,
    normalize_category_path,
)


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


class TestCanonicalCategoryKey(unittest.TestCase):
    def test_lowercases_normalized_path(self) -> None:
        self.assertEqual(
            canonical_category_key("Passives/Resistors/SMD"),
            "passives/resistors/smd",
        )
        self.assertEqual(
            canonical_category_key("/Passives//Resistors/"),
            "passives/resistors",
        )

    def test_empty_for_empty_normalized(self) -> None:
        self.assertEqual(canonical_category_key("///"), "")
        self.assertEqual(canonical_category_key(None), "")


class TestMergeCategoryConfig(unittest.TestCase):
    """Cross-language parity for the persistence helper that combines two
    category-rule configs (e.g. case-collision rows during dedupe).

    Expected outputs are the JS ``mergeCategoryConfig`` results for the same
    inputs — if the Python rule diverges, the test catches it.
    """

    def test_ors_pin_visibility_flags(self) -> None:
        self.assertEqual(
            merge_category_config(
                {"hidePinNumbers": True, "hidePinNames": False, "valueParam": None},
                {"hidePinNumbers": False, "hidePinNames": True, "valueParam": None},
            ),
            {"hidePinNumbers": True, "hidePinNames": True, "valueParam": None},
        )

    def test_prefers_a_value_param(self) -> None:
        self.assertEqual(
            merge_category_config(
                {"valueParam": "Resistance"},
                {"valueParam": "Capacitance"},
            ),
            {
                "hidePinNumbers": False,
                "hidePinNames": False,
                "valueParam": "Resistance",
            },
        )

    def test_null_inputs_produce_default_shape(self) -> None:
        self.assertEqual(
            merge_category_config(None, None),
            {"hidePinNumbers": False, "hidePinNames": False, "valueParam": None},
        )

    def test_preserves_symbol_source_when_only_a(self) -> None:
        out = merge_category_config(
            {"symbolSource": {"source": "easyeda"}},
            {"hidePinNumbers": True},
        )
        self.assertEqual(out["symbolSource"], {"source": "easyeda"})

    def test_falls_back_to_b_symbol_source(self) -> None:
        out = merge_category_config(
            {"hidePinNumbers": True},
            {
                "symbolSource": {
                    "source": "template",
                    "libPath": "/libs/R.kicad_sym",
                    "name": "R_SMD",
                }
            },
        )
        self.assertEqual(
            out["symbolSource"],
            {"source": "template", "libPath": "/libs/R.kicad_sym", "name": "R_SMD"},
        )

    def test_prefers_a_symbol_source(self) -> None:
        out = merge_category_config(
            {"symbolSource": {"source": "easyeda"}},
            {
                "symbolSource": {
                    "source": "template",
                    "libPath": "/libs/R.kicad_sym",
                    "name": "R_SMD",
                }
            },
        )
        self.assertEqual(out["symbolSource"], {"source": "easyeda"})

    def test_unions_label_mapping_with_a_winning(self) -> None:
        out = merge_category_config(
            {"labelMapping": {"Resistance": "Value", "Tolerance": "Tol_A"}},
            {"labelMapping": {"Tolerance": "Tol_B", "Power": "Power"}},
        )
        self.assertEqual(
            out["labelMapping"],
            {"Tolerance": "Tol_A", "Power": "Power", "Resistance": "Value"},
        )

    def test_silently_drops_removed_fields(self) -> None:
        """ADR-0006: autoApply / autoConfirm / action must never appear in
        the merged output, no matter how a caller smuggles them in."""
        out = merge_category_config(
            {"autoApply": "auto", "autoConfirm": True, "action": "skip"},
            {"valueParam": "Resistance"},
        )
        self.assertNotIn("autoApply", out)
        self.assertNotIn("autoConfirm", out)
        self.assertNotIn("action", out)
        self.assertEqual(out["valueParam"], "Resistance")

    def test_drops_malformed_source_layer(self) -> None:
        out = merge_category_config(
            {"symbolSource": {"source": "template", "libPath": "/lib.kicad_sym"}},
            {"symbolSource": {"source": "bogus"}},
        )
        self.assertNotIn("symbolSource", out)


class TestDedupeCategorySettings(unittest.TestCase):
    """Cross-language parity for the load-time persistence sanitizer.

    Expected outputs are the JS ``dedupeCategorySettings`` results for the
    same inputs — if the Python rule diverges, the test catches it.
    """

    def test_non_object_input_returns_empty(self) -> None:
        self.assertEqual(dedupe_category_settings(None), {})
        self.assertEqual(dedupe_category_settings("nope"), {})

    def test_preserves_component_rule_fields(self) -> None:
        """V3 ``ComponentRule`` fields must survive dedupe verbatim."""
        rule = {
            "hidePinNumbers": False,
            "hidePinNames": False,
            "valueParam": None,
            "symbolSource": {
                "source": "template",
                "libPath": "/libs/R.kicad_sym",
                "name": "R_SMD",
            },
            "footprintSource": {
                "source": "template",
                "libPath": "/libs/R.pretty",
                "name": "R_0805",
            },
            "labelMapping": {"Resistance": "Value", "Tolerance": "Tol"},
        }
        out = dedupe_category_settings({"Passives/Resistors": rule})
        self.assertEqual(
            out["Passives/Resistors"],
            {
                "hidePinNumbers": False,
                "hidePinNames": False,
                "valueParam": None,
                "symbolSource": rule["symbolSource"],
                "footprintSource": rule["footprintSource"],
                "labelMapping": rule["labelMapping"],
            },
        )

    def test_strips_legacy_removed_fields(self) -> None:
        """ADR-0006: loading a legacy V2 row must silently drop autoApply /
        autoConfirm / action without disturbing the rest of the rule."""
        out = dedupe_category_settings(
            {
                "Passives/Resistors": {
                    "hidePinNumbers": False,
                    "hidePinNames": False,
                    "valueParam": "Resistance",
                    "autoApply": "auto",
                    "autoConfirm": True,
                    "action": "skip",
                    "symbolSource": {"source": "easyeda"},
                }
            }
        )
        entry = out["Passives/Resistors"]
        self.assertNotIn("autoApply", entry)
        self.assertNotIn("autoConfirm", entry)
        self.assertNotIn("action", entry)
        self.assertEqual(entry["valueParam"], "Resistance")
        self.assertEqual(entry["symbolSource"], {"source": "easyeda"})

    def test_collapses_case_collision_and_merges_new_fields(self) -> None:
        out = dedupe_category_settings(
            {
                "Passives/Resistors": {
                    "symbolSource": {"source": "easyeda"},
                    "labelMapping": {"Resistance": "Value"},
                },
                "passives/resistors": {
                    "footprintSource": {
                        "source": "template",
                        "libPath": "/libs/R.pretty",
                        "name": "R_0805",
                    },
                    "labelMapping": {"Power": "Power"},
                },
            }
        )
        self.assertEqual(len(out), 1)
        (key,) = out.keys()
        merged = out[key]
        self.assertEqual(merged["symbolSource"], {"source": "easyeda"})
        self.assertEqual(
            merged["footprintSource"],
            {"source": "template", "libPath": "/libs/R.pretty", "name": "R_0805"},
        )
        self.assertEqual(
            merged["labelMapping"], {"Power": "Power", "Resistance": "Value"}
        )

    def test_drops_blank_label_mapping_entries(self) -> None:
        out = dedupe_category_settings(
            {
                "Passives/Resistors": {
                    "labelMapping": {
                        "Resistance": "Value",
                        "": "Skipped",
                        "Tolerance": "  ",
                    }
                }
            }
        )
        self.assertEqual(
            out["Passives/Resistors"]["labelMapping"], {"Resistance": "Value"}
        )


class TestJsPythonPersistenceParity(unittest.TestCase):
    """Frozen JS outputs for the V3 ``ComponentRule`` corpus.

    These expected values are the outputs of the JS ``mergeCategoryConfig`` /
    ``dedupeCategorySettings`` for the same inputs. The corresponding JS-side
    cases live in ``chrome_extension/shared/categoryPath.test.mjs`` (in the
    classic-script parity block); if either side drifts, this test or the
    classic-script parity test trips.
    """

    def test_legacy_v2_row_loses_removed_fields(self) -> None:
        self.assertEqual(
            dedupe_category_settings(
                {
                    "Passives/Resistors": {
                        "hidePinNumbers": True,
                        "hidePinNames": False,
                        "valueParam": "Resistance",
                        "autoApply": "auto",
                        "autoConfirm": True,
                        "action": "skip",
                    }
                }
            ),
            {
                "Passives/Resistors": {
                    "hidePinNumbers": True,
                    "hidePinNames": False,
                    "valueParam": "Resistance",
                }
            },
        )

    def test_case_collision_with_v3_fields(self) -> None:
        self.assertEqual(
            dedupe_category_settings(
                {
                    "Passives/Resistors": {
                        "hidePinNumbers": False,
                        "hidePinNames": False,
                        "valueParam": None,
                        "symbolSource": {"source": "easyeda"},
                        "labelMapping": {"Resistance": "Value"},
                    },
                    "passives/resistors": {
                        "hidePinNumbers": False,
                        "hidePinNames": False,
                        "valueParam": None,
                        "footprintSource": {
                            "source": "template",
                            "libPath": "/libs/R.pretty",
                            "name": "R_0805",
                        },
                        "labelMapping": {"Power": "Power"},
                    },
                }
            ),
            {
                "Passives/Resistors": {
                    "hidePinNumbers": False,
                    "hidePinNames": False,
                    "valueParam": None,
                    "symbolSource": {"source": "easyeda"},
                    "footprintSource": {
                        "source": "template",
                        "libPath": "/libs/R.pretty",
                        "name": "R_0805",
                    },
                    "labelMapping": {"Power": "Power", "Resistance": "Value"},
                }
            },
        )


if __name__ == "__main__":
    unittest.main()
