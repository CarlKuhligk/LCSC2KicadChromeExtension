"use strict";

/**
 * LCSC category breadcrumb → canonical `A/B/C`.
 * Mirrors {@link ../../categoryPath.js} (used by the service worker and popup).
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
