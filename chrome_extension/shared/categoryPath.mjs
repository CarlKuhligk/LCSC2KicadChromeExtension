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
 * Coerce a ComponentRule source-layer entry (``symbolSource`` /
 * ``footprintSource``) into the ADR-0006 shape, or ``null`` when the input is
 * not a recognised layer descriptor. Permissive mirror of
 * ``native_host/rules.py::_normalize_source_layer`` — the persistence helpers
 * **drop** malformed layers instead of throwing so a single bad row in
 * storage can never crash the popup or the SW.
 *
 * @param {unknown} raw
 * @returns {{ source: "easyeda" } | { source: "template", libPath: string, name: string } | null}
 */
function cleanSourceLayer(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.source === "easyeda") return { source: "easyeda" };
  if (raw.source !== "template") return null;
  const libPath = typeof raw.libPath === "string" ? raw.libPath.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!libPath || !name) return null;
  return { source: "template", libPath, name };
}

/**
 * Normalize a ``labelMapping`` map (LCSC-label → KiCad-property). Drops blank
 * or non-string entries; same permissive contract as ``cleanSourceLayer``.
 *
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function cleanLabelMapping(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== "string" || typeof v !== "string") continue;
    const kk = k.trim();
    const vv = v.trim();
    if (!kk || !vv) continue;
    out[kk] = vv;
  }
  return out;
}

/**
 * Combine two category-rule configs into a single config. Pin-visibility flags
 * are OR'd (either side hiding wins); valueParam preserves the first
 * non-empty trimmed string (a's preference wins over b's).
 *
 * The V3 ``ComponentRule`` fields (``symbolSource``, ``footprintSource``,
 * ``labelMapping``) are preserved during merge: source layers prefer ``a``
 * when both are set; ``labelMapping`` is unioned with ``a``'s keys overriding
 * ``b``'s on conflict. Fields removed by ADR-0006 (``autoApply``,
 * ``autoConfirm``, ``action``) are silently dropped — V2 callers cannot
 * smuggle them through dedupe.
 *
 * New fields are only emitted when at least one side carries a usable value,
 * so a pure-V2 entry retains the V2-only shape and the existing JSON
 * change-detector in the popup does not redraw on a no-op merge.
 *
 * @param {object | null | undefined} a
 * @param {object | null | undefined} b
 * @returns {object}
 */
export function mergeCategoryConfig(a, b) {
  const vp = (x) =>
    x && typeof x.valueParam === "string" && x.valueParam.trim() ? x.valueParam.trim() : "";
  const out = {
    hidePinNumbers: Boolean(a && a.hidePinNumbers) || Boolean(b && b.hidePinNumbers),
    hidePinNames: Boolean(a && a.hidePinNames) || Boolean(b && b.hidePinNames),
    valueParam: vp(a) || vp(b) || null,
  };
  const symA = cleanSourceLayer(a && a.symbolSource);
  const symB = cleanSourceLayer(b && b.symbolSource);
  if (symA || symB) out.symbolSource = symA || symB;
  const fpA = cleanSourceLayer(a && a.footprintSource);
  const fpB = cleanSourceLayer(b && b.footprintSource);
  if (fpA || fpB) out.footprintSource = fpA || fpB;
  const labelB = cleanLabelMapping(b && b.labelMapping);
  const labelA = cleanLabelMapping(a && a.labelMapping);
  if (Object.keys(labelA).length || Object.keys(labelB).length) {
    out.labelMapping = { ...labelB, ...labelA };
  }
  return out;
}

/**
 * Project a raw storage value onto the surviving rule shape. Pin-visibility
 * + valueParam are the V2 carry-over; ``symbolSource``/``footprintSource``/
 * ``labelMapping`` are the V3 ``ComponentRule`` additions. Fields removed by
 * ADR-0006 (``autoApply``, ``autoConfirm``, ``action``) are silently dropped.
 *
 * Unlike ``cleanSourceLayer`` and ``cleanLabelMapping``, the V2 keys are
 * always emitted (with defaults) to keep the legacy JSON shape stable. The
 * V3 keys are only emitted when present so a pure-V2 entry is not bloated
 * with empty layer/mapping slots.
 *
 * @param {unknown} v
 * @returns {object | null}
 */
function cleanRuleEntry(v) {
  if (!v || typeof v !== "object") return null;
  const cfg = {
    hidePinNumbers: Boolean(v.hidePinNumbers),
    hidePinNames: Boolean(v.hidePinNames),
    valueParam:
      typeof v.valueParam === "string" && v.valueParam.trim() ? v.valueParam.trim() : null,
  };
  const sym = cleanSourceLayer(v.symbolSource);
  if (sym) cfg.symbolSource = sym;
  const fp = cleanSourceLayer(v.footprintSource);
  if (fp) cfg.footprintSource = fp;
  const labels = cleanLabelMapping(v.labelMapping);
  if (Object.keys(labels).length) cfg.labelMapping = labels;
  return cfg;
}

/**
 * Collapse duplicate LCSC paths (e.g. same trail with different casing, or
 * merged from DOM rows). Picks the longest display path as the stored key when
 * duplicates differ only by case.
 *
 * Doubles as a load-time sanitizer for the Rule schema: V2-era
 * ``autoApply`` / ``autoConfirm`` / ``action`` fields (removed by ADR-0006)
 * are silently stripped, while the V3 ``ComponentRule`` additions
 * (``symbolSource``, ``footprintSource``, ``labelMapping``) ride through the
 * merge intact.
 *
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {Record<string, object>}
 */
export function dedupeCategorySettings(raw) {
  if (!raw || typeof raw !== "object") return {};
  /** @type {Map<string, { displayKey: string, cfg: object }>} */
  const map = new Map();
  for (const [k, v] of Object.entries(raw)) {
    const cfg = cleanRuleEntry(v);
    if (!cfg) continue;
    const displayKey = normalizeCategoryPath(k);
    const canon = canonicalCategoryKey(k);
    if (!canon) continue;
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
