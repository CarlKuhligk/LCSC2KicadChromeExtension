"use strict";

/**
 * V3 Confidence Apply-Model (ADR-0006) — pure-function core for the SW
 * Matcher. Two exports:
 *
 *   - ``matchComponentRule(phase1, state)`` → ``MatchResult``
 *     Resolves a Category Rule against the Phase 1 metadata using the same
 *     deepest-prefix rule as ``resolveCategorySettings`` (background.js:50)
 *     and decides Symbol/Footprint suggestions + the Confidence state.
 *
 *   - ``computeConfidenceState(rule, symbol, footprint, factors)`` →
 *     ``"green" | "yellow" | "white"``
 *     The state machine itself. ADR-0006: 🟢 needs a registered Rule + all
 *     MVP-relevant factors + high confidence; ⚪ means no usable match;
 *     🟡 is everything in between.
 *
 * Issue #25 builds the ⚪ ``white`` path end-to-end. The 🟢 ``green`` path
 * (#29) and the 🟡 ``yellow`` path (#31) extend ``computeConfidenceState``
 * later — this file already accepts the full argument shape so those
 * slices add branches, not callers.
 *
 * Imported by the service worker (background.js) via the classic-script
 * shim ``chrome_extension/confidenceState.js`` (MV3 ``importScripts``
 * cannot load an ES module). Behavioral parity between the two files is
 * pinned by ``shared/confidenceState.test.mjs``.
 */

import { normalizeCategoryPath } from "./categoryPath.mjs";

/**
 * @typedef {{ source: "easyeda" } | { source: "template", libPath: string, name: string }} LayerChoice
 *
 * @typedef {{
 *   layer: "symbol" | "footprint",
 *   choice: LayerChoice,
 *   confidence: number,
 *   reasons: string[],
 *   source: "rule" | "auto-template-match" | "easyeda-fallback",
 * }} LayerSuggestion
 *
 * @typedef {{
 *   ruleKey: string | null,
 *   rule: object | null,
 *   symbol: LayerSuggestion,
 *   footprint: LayerSuggestion,
 *   state: "green" | "yellow" | "white",
 *   confidence: number,
 *   guards: {
 *     pinCountOk: boolean,
 *     packageFormOk: boolean,
 *     templatesResolvable: boolean,
 *     pinPadResolvable: boolean,
 *     overwriteClear: boolean,
 *   },
 * }} MatchResult
 */

/** Confidence assigned to an EasyEDA fallback when no Rule / no heuristic match exists. */
export const EASYEDA_FALLBACK_CONFIDENCE = 0.5;

function easyedaFallback(layer, reason) {
  return {
    layer,
    choice: { source: "easyeda" },
    confidence: EASYEDA_FALLBACK_CONFIDENCE,
    reasons: reason ? [reason] : [],
    source: "easyeda-fallback",
  };
}

/**
 * Deepest-prefix Rule lookup against ``categorySettings`` (the V3 storage
 * key — same map background.js consumes). Mirrors
 * ``resolveCategorySettings`` in background.js:50.
 *
 * @param {string} categoryPath  normalized Category Path
 * @param {object | null | undefined} categorySettings
 * @returns {{ key: string, rule: object } | null}
 */
function resolveDeepestPrefixRule(categoryPath, categorySettings) {
  if (!categoryPath || !categorySettings || typeof categorySettings !== "object") {
    return null;
  }
  let bestKey = null;
  let bestLen = -1;
  for (const [keyRaw, value] of Object.entries(categorySettings)) {
    if (!keyRaw || !value || typeof value !== "object") continue;
    const K = normalizeCategoryPath(keyRaw);
    if (!K) continue;
    if (categoryPath === K || categoryPath.startsWith(`${K}/`)) {
      if (K.length > bestLen) {
        bestLen = K.length;
        bestKey = keyRaw;
      }
    }
  }
  if (bestKey == null) return null;
  return { key: bestKey, rule: categorySettings[bestKey] };
}

/**
 * Match Phase 1 metadata against the user's Category Rules and decide the
 * Confidence state. This slice (Issue #25) only wires the ⚪ ``white`` path:
 * when no Rule resolves, both Layers fall back to EasyEDA and
 * ``computeConfidenceState`` returns ``"white"`` (Register-Prompt). The 🟢
 * (#29) and 🟡 (#31) paths extend this function without rewriting the
 * caller contract.
 *
 * @param {{ categoryPath?: string | null }} phase1
 * @param {{ categorySettings?: object | null }} [state]
 * @returns {MatchResult}
 */
export function matchComponentRule(phase1, state) {
  const categoryPath = normalizeCategoryPath(phase1?.categoryPath);
  const categorySettings = state?.categorySettings || null;

  const resolved = resolveDeepestPrefixRule(categoryPath, categorySettings);

  const guards = {
    pinCountOk: true,
    packageFormOk: true,
    templatesResolvable: true,
    pinPadResolvable: true,
    overwriteClear: true,
  };

  const fallbackReason = resolved ? null : "no Category Rule registered";
  const symbol = easyedaFallback("symbol", fallbackReason);
  const footprint = easyedaFallback("footprint", fallbackReason);

  const aggregateConfidence = Math.min(symbol.confidence, footprint.confidence);

  const factors = {
    ruleResolved: Boolean(resolved),
    symbolResolved: symbol.source !== "easyeda-fallback",
    footprintResolved: footprint.source !== "easyeda-fallback",
    confidence: aggregateConfidence,
  };

  const stateName = computeConfidenceState(
    resolved?.rule || null,
    symbol,
    footprint,
    factors,
  );

  return {
    ruleKey: resolved?.key ?? null,
    rule: resolved?.rule ?? null,
    symbol,
    footprint,
    state: stateName,
    confidence: aggregateConfidence,
    guards,
  };
}

/**
 * Confidence state machine (ADR-0006 §3.5). Pure function — callers feed in
 * the resolved Rule (or ``null``), the two Layer suggestions, and a set of
 * factors that the Symbol/Footprint slices populate.
 *
 * This slice (Issue #25) wires ``white`` only:
 *
 *   - No registered Rule → ``"white"`` (Register-Prompt).
 *
 * The 🟢 ``green`` branch (#29) lights up when a Rule + symbol-template-
 * resolvable + category recognised + label mapping + high confidence are
 * all present; the 🟡 ``yellow`` branch (#31) catches the in-between cases.
 * Until those slices ship, anything past the ``white`` gate falls through
 * to ``"yellow"`` so an unfinished pipeline never silently delivers a 🟢
 * one-click result.
 *
 * @param {object | null} rule
 * @param {object} _symbol  unused in the white slice; reserved for 🟢/🟡
 * @param {object} _footprint  unused in the white slice; reserved for 🟢/🟡
 * @param {object} [_factors]  unused in the white slice; reserved for 🟢/🟡
 * @returns {"green" | "yellow" | "white"}
 */
export function computeConfidenceState(rule, _symbol, _footprint, _factors) {
  if (!rule) return "white";
  // 🟢 + 🟡 branches arrive with Issues #29 and #31. Until then any
  // resolved rule lands in ``yellow`` so we never claim a 🟢 one-click
  // before the dependent guards exist.
  return "yellow";
}
