"use strict";

/**
 * LCSC category breadcrumb → canonical `A/B/C`.
 * Loaded before `contentScript.js` and `popup.js`, and via `importScripts` in the service worker.
 */
function normalizeCategoryPath(raw) {
  if (raw == null || typeof raw !== "string") return "";
  return raw
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}
