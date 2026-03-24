"use strict";

/**
 * LCSC category breadcrumb → canonical `A/B/C`.
 * Mirrors {@link ../../categoryPath.js} (used by the service worker and popup).
 */
export function normalizeCategoryPath(raw) {
  if (raw == null || typeof raw !== "string") return "";
  return raw
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}
