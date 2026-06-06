"""Python mirror of the LCSC Package-Form detection rule.

Canonical implementation:
``chrome_extension/shared/packageForm.mjs::detectPackageForm``.

Per UQ-4 (docs/ENTSCHEIDUNGEN.md Runde 2), the taxonomy is intentionally
scoped to common SMD chip + SOT / SOIC / QFN families. Anything outside
that list falls back to a trimmed-original canonical with
``confidence = 0.4`` and ``family = None`` — telling the matcher
"no Package-Form match, treat as opaque label".

Drift between this file and the JS canonical is detected by
``tests/test_package_form_mirror.py``, which exercises the same input
corpus as ``chrome_extension/shared/packageForm.test.mjs``.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, Optional


_TAXONOMY_PATH = (
    Path(__file__).resolve().parent.parent
    / "chrome_extension"
    / "shared"
    / "packageTaxonomy.json"
)


def _load_default_taxonomy() -> Dict[str, Any]:
    with _TAXONOMY_PATH.open(encoding="utf-8") as f:
        return json.load(f)


DEFAULT_TAXONOMY: Dict[str, Any] = _load_default_taxonomy()

_CHIP_IMPERIAL_RE = re.compile(r"(?<![0-9])(\d{4})(?![0-9])")
_METRIC_PAREN_RE = re.compile(r"\((\d{3,4})\s*metric\)", re.IGNORECASE)
_BARE_METRIC_RE = re.compile(r"^(\d{3,4})$")
_SOT_FAMILY_RE = re.compile(
    r"\bSOT[-\s]?(\d{1,3})(?:[-\s]?(\d{1,2}))?\b", re.IGNORECASE
)
_PIN_FAMILY_RE = re.compile(r"\b(SOIC|QFN)[-\s]?(\d{1,3})?\b", re.IGNORECASE)


def _normalize_raw(raw: Any) -> str:
    if raw is None or not isinstance(raw, str):
        return ""
    return raw.strip()


def _match_chip_imperial(candidate: str, taxonomy: Dict[str, Any]) -> Optional[str]:
    chip_list = taxonomy.get("chipImperial") or []
    for match in _CHIP_IMPERIAL_RE.finditer(candidate):
        code = match.group(1)
        if code in chip_list:
            return code
    return None


def _match_metric_paren(
    candidate: str, taxonomy: Dict[str, Any]
) -> Optional[Dict[str, str]]:
    metric_map = taxonomy.get("metricToImperial") or {}
    m = _METRIC_PAREN_RE.search(candidate)
    if not m:
        return None
    metric = m.group(1)
    imp = metric_map.get(metric)
    if imp:
        return {"imperial": imp, "metric": metric}
    return None


def _match_bare_metric(
    candidate: str, taxonomy: Dict[str, Any]
) -> Optional[Dict[str, str]]:
    metric_map = taxonomy.get("metricToImperial") or {}
    m = _BARE_METRIC_RE.match(candidate)
    if not m:
        return None
    metric = m.group(1)
    imp = metric_map.get(metric)
    if imp:
        return {"imperial": imp, "metric": metric}
    return None


def _imperial_metric(imperial: str, taxonomy: Dict[str, Any]) -> Optional[str]:
    metric_map = taxonomy.get("metricToImperial") or {}
    for metric, imp in metric_map.items():
        if imp == imperial:
            return metric
    return None


def _match_sot_family(
    candidate: str, pin_count: Optional[int], taxonomy: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    m = _SOT_FAMILY_RE.search(candidate)
    if not m:
        return None
    size = m.group(1)
    family_key = f"SOT-{size}"
    families = taxonomy.get("families") or {}
    family_def = families.get(family_key)
    if not family_def:
        return None
    pins_list = family_def.get("pins") or []
    if m.group(2):
        try:
            pin = int(m.group(2))
        except ValueError:
            pin = None
        if pin is not None and pin in pins_list:
            return {
                "canonical": f"{family_key}-{pin}",
                "family": family_key,
                "pinSuffix": pin,
                "confidence": 1.0,
            }
        if pin is not None:
            return {
                "canonical": f"{family_key}-{pin}",
                "family": family_key,
                "pinSuffix": pin,
                "confidence": 0.4,
            }
    if (
        pin_count is not None
        and isinstance(pin_count, int)
        and pin_count > 0
        and pin_count in pins_list
    ):
        return {
            "canonical": f"{family_key}-{pin_count}",
            "family": family_key,
            "pinSuffix": pin_count,
            "confidence": 0.8,
        }
    return {
        "canonical": family_key,
        "family": family_key,
        "pinSuffix": None,
        "confidence": 1.0,
    }


def _match_pin_family(
    candidate: str, pin_count: Optional[int], taxonomy: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    m = _PIN_FAMILY_RE.search(candidate)
    if not m:
        return None
    family = m.group(1).upper()
    families = taxonomy.get("families") or {}
    family_def = families.get(family)
    if not family_def:
        return None
    pins_list = family_def.get("pins") or []
    if m.group(2):
        try:
            pin = int(m.group(2))
        except ValueError:
            pin = None
        if pin is not None and pin in pins_list:
            return {
                "canonical": f"{family}-{pin}",
                "family": family,
                "pinSuffix": pin,
                "confidence": 1.0,
            }
        if pin is not None:
            return {
                "canonical": f"{family}-{pin}",
                "family": family,
                "pinSuffix": pin,
                "confidence": 0.4,
            }
    if (
        pin_count is not None
        and isinstance(pin_count, int)
        and pin_count > 0
        and pin_count in pins_list
    ):
        return {
            "canonical": f"{family}-{pin_count}",
            "family": family,
            "pinSuffix": pin_count,
            "confidence": 0.8,
        }
    return {
        "canonical": family,
        "family": family,
        "pinSuffix": None,
        "confidence": 1.0,
    }


def detect_package_form(
    raw_package: Any,
    *,
    footprint_name: Optional[str] = None,
    pin_count: Optional[int] = None,
    taxonomy: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Detect the canonical Package-Form of an LCSC ``Package`` string.

    Mirrors ``detectPackageForm`` in
    ``chrome_extension/shared/packageForm.mjs``. Returns a dict with the
    canonical name, family, optional size aliases, raw original, and
    confidence (``0..1``).
    """
    tax = taxonomy if isinstance(taxonomy, dict) and taxonomy else DEFAULT_TAXONOMY
    fp_name = footprint_name.strip() if isinstance(footprint_name, str) else ""
    pc: Optional[int] = None
    if isinstance(pin_count, bool):
        pc = None
    elif isinstance(pin_count, int):
        pc = pin_count
    elif isinstance(pin_count, float) and pin_count.is_integer():
        pc = int(pin_count)
    raw = _normalize_raw(raw_package)
    if not raw and not fp_name:
        return {"canonical": "", "family": None, "raw": "", "confidence": 0}

    candidates = []
    if raw:
        candidates.append(raw)
    if fp_name and fp_name != raw:
        candidates.append(fp_name)

    for candidate in candidates:
        chip = _match_chip_imperial(candidate, tax)
        if chip:
            paren = _match_metric_paren(candidate, tax)
            size_metric = paren["metric"] if paren else _imperial_metric(chip, tax)
            out: Dict[str, Any] = {
                "canonical": chip,
                "family": chip,
                "sizeImperial": chip,
                "raw": raw,
                "confidence": 1.0,
            }
            if size_metric:
                out["sizeMetric"] = size_metric
            return out
        paren = _match_metric_paren(candidate, tax)
        bare = _match_bare_metric(candidate, tax) if not paren else None
        metric = paren or bare
        if metric:
            return {
                "canonical": metric["imperial"],
                "family": metric["imperial"],
                "sizeImperial": metric["imperial"],
                "sizeMetric": metric["metric"],
                "raw": raw,
                "confidence": 1.0,
            }
        sot = _match_sot_family(candidate, pc, tax)
        if sot:
            sot["raw"] = raw
            return sot
        pin = _match_pin_family(candidate, pc, tax)
        if pin:
            pin["raw"] = raw
            return pin

    fallback = re.sub(r"\s+", " ", raw).strip()
    return {
        "canonical": fallback,
        "family": None,
        "raw": raw,
        "confidence": 0.4,
    }
