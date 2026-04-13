"use strict";

/**
 * LCSC category breadcrumb → canonical `A/B/C`.
 * Loaded before `popup.js` and via `importScripts` in the service worker.
 * LCSC content script uses the same logic from `src/content/categoryNormalize.js` (ES module).
 */
function normalizeCategoryPath(raw) {
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
 * Stable key for de-duplicating paths that differ only by letter case (or spacing already
 * normalized). Used as object-key identity for categorySettings.
 */
function canonicalCategoryKey(raw) {
  const n = normalizeCategoryPath(raw);
  return n ? n.toLowerCase() : "";
}

function mergeCategoryConfig(a, b) {
  const vp = (x) =>
    x && typeof x.valueParam === "string" && x.valueParam.trim() ? x.valueParam.trim() : "";
  return {
    hidePinNumbers: Boolean(a && a.hidePinNumbers) || Boolean(b && b.hidePinNumbers),
    hidePinNames: Boolean(a && a.hidePinNames) || Boolean(b && b.hidePinNames),
    valueParam: vp(a) || vp(b) || null,
  };
}

/**
 * Collapse duplicate LCSC paths (e.g. same trail with different casing, or merged from DOM rows).
 * Picks the longest display path as the stored key when duplicates differ only by case.
 */
function dedupeCategorySettings(raw) {
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
