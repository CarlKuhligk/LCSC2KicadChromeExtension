"use strict";

/**
 * LCSC category breadcrumb → canonical `A/B/C`.
 * Loaded before `popup.js` and via `importScripts` in the service worker.
 * LCSC content script uses the same logic from `src/content/categoryNormalize.js` (ES module).
 */
function normalizeCategoryPath(raw) {
  if (raw == null || typeof raw !== "string") return "";
  return raw
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}
