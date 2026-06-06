"""Paired tests for the Python Package-Form detection mirror.

The canonical implementation is
``chrome_extension/shared/packageForm.mjs::detectPackageForm`` (JS).
This test file exercises the Python mirror
``easyeda2kicad.package_form.detect_package_form`` against the same input
corpus as ``chrome_extension/shared/packageForm.test.mjs``. When one side
drifts, this test fails.
"""

import json
import subprocess
import unittest
from pathlib import Path

from easyeda2kicad.package_form import DEFAULT_TAXONOMY, detect_package_form


REPO_ROOT = Path(__file__).resolve().parent.parent
TAXONOMY_PATH = (
    REPO_ROOT / "chrome_extension" / "shared" / "packageTaxonomy.json"
)


class TestDetectPackageForm(unittest.TestCase):
    """Behavior assertions — mirror of packageForm.test.mjs."""

    def test_bare_imperial_chip(self) -> None:
        out = detect_package_form("0603")
        self.assertEqual(out["canonical"], "0603")
        self.assertEqual(out["family"], "0603")
        self.assertEqual(out["sizeImperial"], "0603")
        self.assertEqual(out["sizeMetric"], "1608")
        self.assertEqual(out["confidence"], 1.0)

    def test_imperial_metric_in_parens(self) -> None:
        out = detect_package_form("0603(1608 Metric)")
        self.assertEqual(out["canonical"], "0603")
        self.assertEqual(out["family"], "0603")
        self.assertEqual(out["sizeMetric"], "1608")
        self.assertEqual(out["confidence"], 1.0)

    def test_bare_metric_maps_to_imperial(self) -> None:
        out = detect_package_form("1608")
        self.assertEqual(out["canonical"], "0603")
        self.assertEqual(out["sizeImperial"], "0603")
        self.assertEqual(out["sizeMetric"], "1608")
        self.assertEqual(out["confidence"], 1.0)

    def test_sot_with_explicit_pin_suffix(self) -> None:
        out = detect_package_form("SOT-23-3")
        self.assertEqual(out["canonical"], "SOT-23-3")
        self.assertEqual(out["family"], "SOT-23")
        self.assertEqual(out["pinSuffix"], 3)
        self.assertEqual(out["confidence"], 1.0)

    def test_sot_derives_pin_from_pin_count(self) -> None:
        out = detect_package_form("SOT-23", pin_count=3)
        self.assertEqual(out["canonical"], "SOT-23-3")
        self.assertEqual(out["pinSuffix"], 3)
        self.assertEqual(out["confidence"], 0.8)

    def test_bare_sot_without_pin_count(self) -> None:
        out = detect_package_form("SOT-23")
        self.assertEqual(out["canonical"], "SOT-23")
        self.assertEqual(out["family"], "SOT-23")
        self.assertIsNone(out["pinSuffix"])
        self.assertEqual(out["confidence"], 1.0)

    def test_sop_falls_back_to_trim(self) -> None:
        out = detect_package_form("SOP-8_3.9x4.9x1.27P")
        self.assertEqual(out["canonical"], "SOP-8_3.9x4.9x1.27P")
        self.assertIsNone(out["family"])
        self.assertEqual(out["confidence"], 0.4)

    def test_soic_pin_match(self) -> None:
        out = detect_package_form("SOIC-8")
        self.assertEqual(out["canonical"], "SOIC-8")
        self.assertEqual(out["family"], "SOIC")
        self.assertEqual(out["pinSuffix"], 8)
        self.assertEqual(out["confidence"], 1.0)

    def test_qfn_pin_match(self) -> None:
        out = detect_package_form("QFN-32")
        self.assertEqual(out["canonical"], "QFN-32")
        self.assertEqual(out["family"], "QFN")
        self.assertEqual(out["pinSuffix"], 32)
        self.assertEqual(out["confidence"], 1.0)

    def test_empty_or_non_string_input(self) -> None:
        for raw in (None, 42, "", "   ", b"x"):
            out = detect_package_form(raw)
            self.assertEqual(out["canonical"], "")
            self.assertIsNone(out["family"])
            self.assertEqual(out["confidence"], 0)

    def test_unrecognized_falls_back(self) -> None:
        out = detect_package_form("DPAK-3")
        self.assertEqual(out["canonical"], "DPAK-3")
        self.assertIsNone(out["family"])
        self.assertEqual(out["confidence"], 0.4)

    def test_footprint_name_secondary(self) -> None:
        out = detect_package_form("", footprint_name="R_0603_1608Metric")
        self.assertEqual(out["canonical"], "0603")
        self.assertEqual(out["family"], "0603")

    def test_loaded_taxonomy_matches_json_on_disk(self) -> None:
        with TAXONOMY_PATH.open(encoding="utf-8") as f:
            on_disk = json.load(f)
        self.assertEqual(DEFAULT_TAXONOMY, on_disk)
        self.assertEqual(on_disk["version"], 1)
        self.assertIn("0603", on_disk["chipImperial"])
        self.assertEqual(on_disk["metricToImperial"]["1608"], "0603")
        self.assertIn("SOT-23", on_disk["families"])
        self.assertIn("SOIC", on_disk["families"])
        self.assertIn("QFN", on_disk["families"])
        # UQ-4: SOP / BGA / DPAK explicitly excluded — they trim-fallback.
        self.assertNotIn("SOP", on_disk["families"])
        self.assertNotIn("BGA", on_disk["families"])
        self.assertNotIn("DPAK", on_disk["families"])


class TestPythonJsParity(unittest.TestCase):
    """Drift test: run the JS canonical via Node on the same corpus and assert
    every result equals the Python mirror (canonical, family, confidence)."""

    CORPUS = [
        {"raw": "0603"},
        {"raw": "0402"},
        {"raw": "0603(1608 Metric)"},
        {"raw": "1608"},
        {"raw": "SOT-23-3"},
        {"raw": "SOT-23"},
        {"raw": "SOT-23", "pinCount": 3},
        {"raw": "SOT-23", "pinCount": 5},
        {"raw": "SOIC-8"},
        {"raw": "SOIC"},
        {"raw": "SOIC", "pinCount": 14},
        {"raw": "QFN-32"},
        {"raw": "QFN-128"},  # outside whitelist → confidence 0.4
        {"raw": "SOP-8_3.9x4.9x1.27P"},
        {"raw": "DPAK-3"},
        {"raw": ""},
        {"raw": "   "},
        {"raw": "", "footprintName": "R_0603_1608Metric"},
        {"raw": "0402", "footprintName": "ignored"},
    ]

    SHIM = r"""
        import { detectPackageForm } from "%s";
        import { readFileSync } from "node:fs";
        const raw = readFileSync(0, "utf-8");
        const cases = JSON.parse(raw);
        const out = cases.map((c) => detectPackageForm(c.raw, {
            footprintName: c.footprintName,
            pinCount: c.pinCount,
        }));
        process.stdout.write(JSON.stringify(out));
    """ % (
        (REPO_ROOT / "chrome_extension" / "shared" / "packageForm.mjs")
        .as_posix()
    )

    def _run_js(self) -> list:
        proc = subprocess.run(
            ["node", "--input-type=module", "-e", self.SHIM],
            input=json.dumps(self.CORPUS),
            capture_output=True,
            text=True,
            cwd=str(REPO_ROOT),
            timeout=20,
        )
        if proc.returncode != 0:
            self.fail(
                "Node failed to run packageForm.mjs:\n"
                f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
            )
        return json.loads(proc.stdout)

    def test_js_python_parity(self) -> None:
        try:
            js_results = self._run_js()
        except FileNotFoundError:
            self.skipTest("node executable not available in test environment")
        for case, js_out in zip(self.CORPUS, js_results):
            py_out = detect_package_form(
                case["raw"],
                footprint_name=case.get("footprintName"),
                pin_count=case.get("pinCount"),
            )
            with self.subTest(case=case):
                self.assertEqual(js_out["canonical"], py_out["canonical"])
                self.assertEqual(js_out["family"], py_out["family"])
                self.assertEqual(js_out["confidence"], py_out["confidence"])
                self.assertEqual(
                    js_out.get("sizeImperial"), py_out.get("sizeImperial")
                )
                self.assertEqual(
                    js_out.get("sizeMetric"), py_out.get("sizeMetric")
                )
                self.assertEqual(
                    js_out.get("pinSuffix"), py_out.get("pinSuffix")
                )


if __name__ == "__main__":
    unittest.main()
