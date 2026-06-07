"use strict";

/**
 * Canonical implementation of LCSC Package-Form detection (KONZEPT §2, ADR-0006
 * Confidence inputs). Single source of truth for all extension surfaces; the
 * Python mirror `easyeda2kicad/package_form.py` is pinned to identical output
 * by `tests/test_package_form_mirror.py`.
 *
 * Per UQ-4 (docs/ENTSCHEIDUNGEN.md Runde 2), the taxonomy is intentionally
 * scoped to common SMD chip + SOT / SOIC / QFN families. Anything outside that
 * list falls back to a trimmed-original canonical with `confidence = 0.4` and
 * `family = null` — telling the matcher "no Package-Form match, treat as
 * opaque label".
 */

import DEFAULT_TAXONOMY from "./packageTaxonomy.json" with { type: "json" };

export { DEFAULT_TAXONOMY };

const CHIP_IMPERIAL_RE = /(?<![0-9])(\d{4})(?![0-9])/g;
const METRIC_PAREN_RE = /\((\d{3,4})\s*metric\)/i;
const BARE_METRIC_RE = /^(\d{3,4})$/;
const SOT_FAMILY_RE = /\bSOT[-\s]?(\d{1,3})(?:[-\s]?(\d{1,2}))?\b/i;
const PIN_FAMILY_RE = /\b(SOIC|QFN)[-\s]?(\d{1,3})?\b/i;

function _normalizeRaw(raw) {
  if (raw == null) return "";
  if (typeof raw !== "string") return "";
  return raw.trim();
}

function _matchChipImperial(candidate, taxonomy) {
  CHIP_IMPERIAL_RE.lastIndex = 0;
  let m;
  while ((m = CHIP_IMPERIAL_RE.exec(candidate)) !== null) {
    const code = m[1];
    if (taxonomy.chipImperial && taxonomy.chipImperial.includes(code)) {
      return code;
    }
  }
  return null;
}

function _matchMetricParen(candidate, taxonomy) {
  const m = METRIC_PAREN_RE.exec(candidate);
  if (!m) return null;
  const metric = m[1];
  const imp = taxonomy.metricToImperial && taxonomy.metricToImperial[metric];
  if (imp) return { imperial: imp, metric };
  return null;
}

function _matchBareMetric(candidate, taxonomy) {
  // Only fires when the candidate is JUST a 3-4 digit metric code that has no
  // imperial-chip interpretation (caller is expected to try chip first).
  const m = BARE_METRIC_RE.exec(candidate);
  if (!m) return null;
  const metric = m[1];
  const imp = taxonomy.metricToImperial && taxonomy.metricToImperial[metric];
  if (imp) return { imperial: imp, metric };
  return null;
}

function _imperialMetric(imperial, taxonomy) {
  if (!taxonomy.metricToImperial) return null;
  for (const [metric, imp] of Object.entries(taxonomy.metricToImperial)) {
    if (imp === imperial) return metric;
  }
  return null;
}

function _matchSotFamily(candidate, pinCount, taxonomy) {
  const m = SOT_FAMILY_RE.exec(candidate);
  if (!m) return null;
  const size = m[1];
  const familyKey = `SOT-${size}`;
  const familyDef =
    taxonomy.families && taxonomy.families[familyKey] ? taxonomy.families[familyKey] : null;
  if (!familyDef) return null;
  // Pin suffix already present in raw, e.g. "SOT-23-3".
  if (m[2]) {
    const pin = Number(m[2]);
    if (Number.isFinite(pin) && familyDef.pins.includes(pin)) {
      return {
        canonical: `${familyKey}-${pin}`,
        family: familyKey,
        pinSuffix: pin,
        confidence: 1.0,
      };
    }
    return {
      canonical: `${familyKey}-${pin}`,
      family: familyKey,
      pinSuffix: pin,
      confidence: 0.4,
    };
  }
  // No pin suffix in raw — try to derive from pinCount (only when the value is
  // a known whitelist pin for that family).
  if (Number.isFinite(pinCount) && pinCount > 0 && familyDef.pins.includes(pinCount)) {
    return {
      canonical: `${familyKey}-${pinCount}`,
      family: familyKey,
      pinSuffix: pinCount,
      confidence: 0.8,
    };
  }
  // No usable pin info — emit the bare family form.
  return {
    canonical: familyKey,
    family: familyKey,
    pinSuffix: null,
    confidence: 1.0,
  };
}

function _matchPinFamily(candidate, pinCount, taxonomy) {
  const m = PIN_FAMILY_RE.exec(candidate);
  if (!m) return null;
  const family = m[1].toUpperCase();
  const familyDef =
    taxonomy.families && taxonomy.families[family] ? taxonomy.families[family] : null;
  if (!familyDef) return null;
  if (m[2]) {
    const pin = Number(m[2]);
    if (Number.isFinite(pin) && familyDef.pins.includes(pin)) {
      return {
        canonical: `${family}-${pin}`,
        family,
        pinSuffix: pin,
        confidence: 1.0,
      };
    }
    return {
      canonical: `${family}-${pin}`,
      family,
      pinSuffix: pin,
      confidence: 0.4,
    };
  }
  if (Number.isFinite(pinCount) && pinCount > 0 && familyDef.pins.includes(pinCount)) {
    return {
      canonical: `${family}-${pinCount}`,
      family,
      pinSuffix: pinCount,
      confidence: 0.8,
    };
  }
  return {
    canonical: family,
    family,
    pinSuffix: null,
    confidence: 1.0,
  };
}

/**
 * Detect the canonical Package-Form of an LCSC `Package` string.
 *
 * @param {unknown} rawPackage  LCSC `Package` cell value, e.g. `"0603(1608 Metric)"`.
 * @param {{ footprintName?: string|null, pinCount?: number|null, taxonomy?: object }} [options]
 * @returns {{
 *   canonical: string,
 *   family: string | null,
 *   sizeImperial?: string,
 *   sizeMetric?: string,
 *   pinSuffix?: number | null,
 *   raw: string,
 *   confidence: number,
 * }}
 */
export function detectPackageForm(rawPackage, options = {}) {
  const taxonomy =
    options && typeof options.taxonomy === "object" && options.taxonomy
      ? options.taxonomy
      : DEFAULT_TAXONOMY;
  const footprintName =
    options && typeof options.footprintName === "string" ? options.footprintName.trim() : "";
  const pinCount =
    options && Number.isFinite(options.pinCount) ? Number(options.pinCount) : null;

  const raw = _normalizeRaw(rawPackage);
  if (!raw && !footprintName) {
    return { canonical: "", family: null, raw: "", confidence: 0 };
  }

  const candidates = [];
  if (raw) candidates.push(raw);
  if (footprintName && footprintName !== raw) candidates.push(footprintName);

  for (const candidate of candidates) {
    const chip = _matchChipImperial(candidate, taxonomy);
    if (chip) {
      // Prefer an explicit "(NNNN Metric)" annotation if present; otherwise
      // reverse-lookup the canonical metric for this imperial. Crucially we
      // do NOT trust a bare metric match here — a string like "0603" is BOTH
      // an imperial chip and a metric size, and imperial wins (KONZEPT §2.3).
      const paren = _matchMetricParen(candidate, taxonomy);
      const sizeMetric = paren ? paren.metric : _imperialMetric(chip, taxonomy);
      const out = {
        canonical: chip,
        family: chip,
        sizeImperial: chip,
        raw,
        confidence: 1.0,
      };
      if (sizeMetric) out.sizeMetric = sizeMetric;
      return out;
    }
    const paren = _matchMetricParen(candidate, taxonomy);
    const bare = paren ? null : _matchBareMetric(candidate, taxonomy);
    const metric = paren || bare;
    if (metric) {
      return {
        canonical: metric.imperial,
        family: metric.imperial,
        sizeImperial: metric.imperial,
        sizeMetric: metric.metric,
        raw,
        confidence: 1.0,
      };
    }
    const sot = _matchSotFamily(candidate, pinCount, taxonomy);
    if (sot) return { ...sot, raw };
    const pin = _matchPinFamily(candidate, pinCount, taxonomy);
    if (pin) return { ...pin, raw };
  }

  const fallback = raw.replace(/\s+/g, " ").trim();
  return {
    canonical: fallback,
    family: null,
    raw,
    confidence: 0.4,
  };
}
