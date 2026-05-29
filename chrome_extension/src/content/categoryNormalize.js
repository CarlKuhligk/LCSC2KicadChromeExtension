"use strict";

/**
 * LCSC category breadcrumb → canonical `A/B/C`.
 *
 * Thin re-export from the canonical shared module so the content script keeps
 * its existing import path (`./categoryNormalize.js`) while the rule lives in
 * one place. See `../../shared/categoryPath.mjs` for the rule and rationale.
 */

export { normalizeCategoryPath } from "../../shared/categoryPath.mjs";
