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

/**
 * 🟢 threshold from KONZEPT.md §3.6: high ≥ 0.85, medium 0.6–0.85, low < 0.6.
 * Pin only the high/green boundary here; the 🟡 medium band falls out of
 * "rule exists but factor missing or confidence below this threshold".
 */
export const GREEN_CONFIDENCE_THRESHOLD = 0.85;

/** Confidence assigned when a Rule's Symbol-Template is resolvable in the registered libs. */
const RULE_TEMPLATE_CONFIDENCE = 0.95;

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
 * The Rule's Symbol-Template is "resolvable" when the libPath/name pair
 * picked at registration time still exists in the user's registered
 * Template Libraries. An EasyEDA-source rule (the seed default) has no
 * template to resolve and therefore can never satisfy the 🟢 MVP factor
 * "symbol template matched" (KONZEPT.md §3.6, ADR-0006).
 */
function isSymbolTemplateResolvable(symbolSource, templateSymbolsByLib) {
  if (!symbolSource || symbolSource.source !== "template") return false;
  const libPath = symbolSource.libPath;
  const name = symbolSource.name;
  if (!libPath || !name) return false;
  if (!templateSymbolsByLib || typeof templateSymbolsByLib !== "object") {
    return false;
  }
  const names = templateSymbolsByLib[libPath];
  return Array.isArray(names) && names.includes(name);
}

function hasLabelMappingEntries(labelMapping) {
  if (!labelMapping || typeof labelMapping !== "object") return false;
  return Object.keys(labelMapping).length > 0;
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
 * Confidence state. Issue #25 wired the ⚪ ``white`` path; this slice
 * (#29) lights up the 🟢 ``green`` path by surfacing the Rule's
 * ``symbolSource`` as the Symbol Suggestion when the Template Library it
 * points at is still installed, and by raising the aggregate confidence
 * past the 🟢 threshold so ``computeConfidenceState`` returns ``"green"``.
 * The 🟡 path (#31) lands later; until then a resolved Rule that misses
 * any MVP factor still falls through to ``"yellow"``.
 *
 * **MVP (Symbol-first):** only Symbol-layer factors gate 🟢. The
 * Footprint Layer stays on the EasyEDA default and does not block green
 * (KONZEPT.md §3.6, ADR-0006). Footprint/3D become green-relevant with
 * the Footprint follow-up slice.
 *
 * @param {{ categoryPath?: string | null }} phase1
 * @param {{ categorySettings?: object | null, templateSymbolsByLib?: object | null }} [state]
 * @returns {MatchResult}
 */
export function matchComponentRule(phase1, state) {
  const categoryPath = normalizeCategoryPath(phase1?.categoryPath);
  const categorySettings = state?.categorySettings || null;
  const templateSymbolsByLib = state?.templateSymbolsByLib || null;

  const resolved = resolveDeepestPrefixRule(categoryPath, categorySettings);
  const rule = resolved?.rule || null;

  const symbolTemplateResolvable = isSymbolTemplateResolvable(
    rule?.symbolSource,
    templateSymbolsByLib,
  );
  const labelsMapped = hasLabelMappingEntries(rule?.labelMapping);

  const guards = {
    pinCountOk: true,
    packageFormOk: true,
    templatesResolvable: symbolTemplateResolvable,
    pinPadResolvable: true,
    overwriteClear: true,
  };

  let symbol;
  let footprint;
  if (symbolTemplateResolvable) {
    // 🟢 MVP path: Rule's Symbol-Template still resolves — surface it as
    // the Suggestion so the Override Panel can render the Ein-Klick
    // preview verbatim (no second look-up in the content script).
    symbol = {
      layer: "symbol",
      choice: { ...rule.symbolSource },
      confidence: RULE_TEMPLATE_CONFIDENCE,
      reasons: [`Category Rule "${resolved.key}" symbol template`],
      source: "rule",
    };
    // Footprint stays on EasyEDA until the Footprint follow-up slice
    // (KONZEPT.md §3.6 "MVP (Symbol-first)").
    footprint = easyedaFallback(
      "footprint",
      "footprint follow-up slice — EasyEDA default",
    );
  } else {
    const fallbackReason = resolved ? null : "no Category Rule registered";
    symbol = easyedaFallback("symbol", fallbackReason);
    footprint = easyedaFallback("footprint", fallbackReason);
  }

  // MVP (Symbol-first): green decides on the Symbol Layer alone; the
  // Footprint Layer's EasyEDA fallback must NOT drag the aggregate
  // confidence down below the 🟢 threshold (KONZEPT.md §3.6 / ADR-0006
  // "footprint/3D as confidence drivers arrive with the footprint
  // follow-up slice").
  const aggregateConfidence = symbol.confidence;

  const factors = {
    ruleResolved: Boolean(resolved),
    categoryResolved: Boolean(resolved),
    symbolResolved: symbol.source !== "easyeda-fallback",
    symbolTemplateResolvable,
    labelsMapped,
    footprintResolved: footprint.source !== "easyeda-fallback",
    confidence: aggregateConfidence,
  };

  const stateName = computeConfidenceState(rule, symbol, footprint, factors);

  return {
    ruleKey: resolved?.key ?? null,
    rule,
    symbol,
    footprint,
    state: stateName,
    confidence: aggregateConfidence,
    guards,
  };
}

/**
 * Confidence state machine (ADR-0006 §3.5). Pure function — callers feed in
 * the resolved Rule (or ``null``), the two Layer suggestions, and the
 * factors ``matchComponentRule`` populates.
 *
 *   - No registered Rule → ``"white"`` (Register-Prompt).
 *   - Registered Rule + MVP factors satisfied + confidence ≥ green
 *     threshold → ``"green"`` (Ein-Klick + [Modifizieren]).
 *   - Anything in between → ``"yellow"`` (placeholder until #31 wires the
 *     user-setting branch).
 *
 * **MVP (Symbol-first)** factors (KONZEPT.md §3.6, ADR-0006 §9): the
 * registered Rule must resolve a Symbol Template against the installed
 * Template Libraries, the LCSC Category must be recognised (implied by
 * the deepest-prefix Rule lookup), and the Rule must carry a non-empty
 * ``labelMapping``. Footprint / Pin↔Pad / 3D factors are NOT green
 * blockers in the Symbol-MVP — they ride along on EasyEDA by default
 * until the Footprint follow-up slice extends this state machine.
 *
 * @param {object | null} rule
 * @param {object} _symbol  reserved for the 🟡 branch (#31)
 * @param {object} _footprint  reserved for the 🟡 branch (#31)
 * @param {object} [factors]  output of ``matchComponentRule``
 * @returns {"green" | "yellow" | "white"}
 */
export function computeConfidenceState(rule, _symbol, _footprint, factors) {
  if (!rule) return "white";
  const f = factors || {};
  const greenReady =
    f.ruleResolved === true
    && f.categoryResolved === true
    && f.symbolTemplateResolvable === true
    && f.labelsMapped === true
    && typeof f.confidence === "number"
    && f.confidence >= GREEN_CONFIDENCE_THRESHOLD;
  if (greenReady) return "green";
  // 🟡 placeholder — #31 splits this band into the keepEasyeda vs
  // openEditor user-setting. Until then any resolved rule that misses an
  // MVP factor lands here so we never silently grant a 🟢 one-click.
  return "yellow";
}
