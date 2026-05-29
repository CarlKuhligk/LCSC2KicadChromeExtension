"use strict";

/**
 * Canonical implementation of LCSC Category Path normalization (CONTEXT.md →
 * "Category Path"). Single source of truth for all extension surfaces and the
 * mirrored Python rule in `easyeda2kicad/helpers.py`.
 *
 * Three consumer surfaces import from this module (directly or via shim):
 *   - LCSC content script — `chrome_extension/src/content/categoryNormalize.js`
 *     re-exports `normalizeCategoryPath` from here.
 *   - Service worker + popup — `chrome_extension/categoryPath.js` is a
 *     classic-script transcription that defines the same functions as globals
 *     (MV3 `importScripts` and popup `<script>` cannot import an ES module).
 *     Behavioral parity between the two files is pinned by
 *     `categoryPath.test.mjs`.
 *   - Tests (Vitest + Node).
 *
 * The Python mirror `easyeda2kicad.helpers.normalize_category_path` is exercised
 * against the same inputs by `tests/test_category_path_mirror.py`; when one side
 * drifts, that test fails.
 */

/**
 * LCSC category breadcrumb → canonical `A/B/C`.
 *
 * Rule (in order):
 *   1. Non-string or null/undefined input → "".
 *   2. Convert backslashes to forward slashes (`\` → `/`).
 *   3. Collapse runs of slashes (`//+` → `/`), then trim leading/trailing
 *      whitespace.
 *   4. Apply Unicode NFC normalization when available.
 *   5. Split on `/`, trim each segment, drop empty segments, rejoin with `/`.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeCategoryPath(raw) {
  if (raw == null || typeof raw !== "string") return "";
  let s = String(raw).replace(/\\/g, "/");
  s = s.replace(/\/+/g, "/").trim();
  if (typeof s.normalize === "function") {
    s = s.normalize("NFC");
  }
  return s
    .split("/")
    .map((seg) => seg.trim())
    .filter(Boolean)
    .join("/");
}

/**
 * Stable key for de-duplicating paths that differ only by letter case (or
 * spacing already normalized). Used as object-key identity for
 * `categorySettings`.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function canonicalCategoryKey(raw) {
  const n = normalizeCategoryPath(raw);
  return n ? n.toLowerCase() : "";
}

/**
 * Combine two category-rule configs into a single config. Pin-visibility flags
 * are OR'd (either side hiding wins); valueParam preserves the first
 * non-empty trimmed string (a's preference wins over b's).
 *
 * @param {{ hidePinNumbers?: boolean, hidePinNames?: boolean, valueParam?: string|null } | null | undefined} a
 * @param {{ hidePinNumbers?: boolean, hidePinNames?: boolean, valueParam?: string|null } | null | undefined} b
 * @returns {{ hidePinNumbers: boolean, hidePinNames: boolean, valueParam: string|null }}
 */
export function mergeCategoryConfig(a, b) {
  const vp = (x) =>
    x && typeof x.valueParam === "string" && x.valueParam.trim() ? x.valueParam.trim() : "";
  return {
    hidePinNumbers: Boolean(a && a.hidePinNumbers) || Boolean(b && b.hidePinNumbers),
    hidePinNames: Boolean(a && a.hidePinNames) || Boolean(b && b.hidePinNames),
    valueParam: vp(a) || vp(b) || null,
  };
}

/**
 * Collapse duplicate LCSC paths (e.g. same trail with different casing, or
 * merged from DOM rows). Picks the longest display path as the stored key when
 * duplicates differ only by case.
 *
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {Record<string, { hidePinNumbers: boolean, hidePinNames: boolean, valueParam: string|null }>}
 */
export function dedupeCategorySettings(raw) {
  if (!raw || typeof raw !== "object") return {};
  /** @type {Map<string, { displayKey: string, cfg: object }>} */
  const map = new Map();
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const displayKey = normalizeCategoryPath(k);
    const canon = canonicalCategoryKey(k);
    if (!canon) continue;
    const cfg = {
      hidePinNumbers: Boolean(v.hidePinNumbers),
      hidePinNames: Boolean(v.hidePinNames),
      valueParam:
        typeof v.valueParam === "string" && v.valueParam.trim() ? v.valueParam.trim() : null,
    };
    const prev = map.get(canon);
    if (!prev) {
      map.set(canon, { displayKey, cfg });
    } else {
      prev.cfg = mergeCategoryConfig(prev.cfg, cfg);
      if (displayKey.length > prev.displayKey.length) {
        prev.displayKey = displayKey;
      }
    }
  }
  const out = {};
  for (const { displayKey, cfg } of map.values()) {
    out[displayKey] = cfg;
  }
  return out;
}
