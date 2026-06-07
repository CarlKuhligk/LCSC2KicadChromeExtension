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

/**
 * 🟡 threshold from KONZEPT.md §3.4. Auto-Template-Match scoring needs to clear
 * this floor before the heuristic suggestion is surfaced; below it the layer
 * stays on the EasyEDA fallback.
 */
export const AUTO_MATCH_MIN_SCORE = 0.6;

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

/* -------------------------------------------------------------------------- */
/*  Auto-Template-Match heuristic (KONZEPT.md §3.4, Issue #31)                 */
/* -------------------------------------------------------------------------- */

const _TOKEN_SPLIT_RE = /[^a-z0-9]+/i;

function _normalizedTokens(value) {
  if (typeof value !== "string" || !value) return [];
  return value
    .toLowerCase()
    .split(_TOKEN_SPLIT_RE)
    .filter((t) => t.length > 0);
}

function _categoryLeafTokens(categoryPath) {
  if (!categoryPath || typeof categoryPath !== "string") return [];
  const leaf = categoryPath.split("/").filter(Boolean).pop() || "";
  return _normalizedTokens(leaf);
}

function _templatePinCountFor(libPath, name, templatePinCounts) {
  if (!templatePinCounts || typeof templatePinCounts !== "object") return null;
  const byName = templatePinCounts[libPath];
  if (!byName || typeof byName !== "object") return null;
  const value = byName[name];
  return Number.isFinite(value) ? Number(value) : null;
}

function _includesToken(haystackTokens, needle) {
  if (!needle) return false;
  return haystackTokens.includes(needle.toLowerCase());
}

/**
 * Returns true when every token of ``needle`` (multi-token strings like
 * ``"SOT-23-3"`` → ``["sot","23","3"]``) appears in ``haystackTokens``.
 * Single-token needles fall through to ``_includesToken`` semantics. Used
 * so a Footprint named ``SOT-23-3.kicad_mod`` matches a canonical of the
 * same shape — the bare ``_includesToken`` would never hit because the
 * hyphenated needle never round-trips as a single haystack entry.
 */
function _includesAllTokens(haystackTokens, needle) {
  if (!needle || typeof needle !== "string") return false;
  const needleTokens = _normalizedTokens(needle);
  if (!needleTokens.length) return false;
  return needleTokens.every((t) => haystackTokens.includes(t));
}

/**
 * Score a single Symbol-Template candidate against the LCSC Category leaf +
 * pin-count + family hints (KONZEPT.md §3.4 SYMBOL block):
 *
 *   +0.5  name-token appears in the Category leaf
 *         (e.g. ``Resistor_Std`` vs ``…/Resistors``)
 *   +0.3  ``templatePinCounts[lib][name] === phase1.pinCount``
 *         (cached TemplatePinCheck RPC result — caller-supplied)
 *   +0.2  packageForm.family appears in the name (uncommon for Symbols)
 *
 * The threshold ``AUTO_MATCH_MIN_SCORE`` (0.6) is checked by the caller; this
 * helper just adds up the contributions.
 */
function _scoreSymbolCandidate(name, libPath, phase1, templatePinCounts) {
  const tokens = _normalizedTokens(name);
  let score = 0;
  const reasons = [];

  const leafTokens = _categoryLeafTokens(phase1?.categoryPath);
  if (leafTokens.length && tokens.some((t) => leafTokens.includes(t))) {
    score += 0.5;
    reasons.push("category leaf token");
  }

  const templatePinCount = _templatePinCountFor(libPath, name, templatePinCounts);
  const easyedaPinCount = Number(phase1?.pinCount);
  if (
    Number.isFinite(templatePinCount)
    && Number.isFinite(easyedaPinCount)
    && templatePinCount > 0
    && easyedaPinCount > 0
    && templatePinCount === easyedaPinCount
  ) {
    score += 0.3;
    reasons.push(`pin-count ${easyedaPinCount}`);
  }

  const family = phase1?.packageForm?.family;
  if (typeof family === "string" && family && _includesToken(tokens, family)) {
    score += 0.2;
    reasons.push(`family "${family}"`);
  }

  return { score, reasons };
}

/**
 * Score a single Footprint-Template candidate against the detected
 * Package-Form (KONZEPT.md §3.4 FOOTPRINT block):
 *
 *   +0.7  ``packageForm.canonical`` appears as a token in the FP name
 *         (e.g. ``R_0603_1608Metric`` vs ``0603``)
 *   +0.2  ``packageForm.family`` matches a name token
 *   +0.1  ``packageForm.pinSuffix`` matches a numeric token
 */
function _scoreFootprintCandidate(name, phase1) {
  const tokens = _normalizedTokens(name);
  const packageForm = phase1?.packageForm || {};
  let score = 0;
  const reasons = [];

  const canonical = typeof packageForm.canonical === "string" ? packageForm.canonical : "";
  if (canonical && _includesAllTokens(tokens, canonical)) {
    score += 0.7;
    reasons.push(`package "${canonical}"`);
  }

  const family = typeof packageForm.family === "string" ? packageForm.family : "";
  if (family && family !== canonical && _includesAllTokens(tokens, family)) {
    score += 0.2;
    reasons.push(`family "${family}"`);
  }

  const pinSuffix = packageForm.pinSuffix;
  if (Number.isFinite(pinSuffix) && pinSuffix > 0) {
    if (tokens.includes(String(pinSuffix))) {
      score += 0.1;
      reasons.push(`pin-suffix ${pinSuffix}`);
    }
  }

  return { score, reasons };
}

/**
 * Auto-Template-Match heuristic — picks the best Template-Library candidate
 * for a Layer when no Category Rule supplies one (KONZEPT.md §3.4). Never
 * raises a result to 🟢: even at confidence 1.0 the heuristic is capped at
 * 🟡 by ``computeConfidenceState`` (ADR-0006 AD-4).
 *
 * @param {"symbol" | "footprint"} layer
 * @param {object} phase1                  Phase 1 Fetch result
 * @param {object | null | undefined} libsByLayer  ``{libPath: string[]}`` map
 * @param {{ templatePinCounts?: object | null }} [opts]
 *        ``templatePinCounts[libPath][name]`` is the cached
 *        TemplatePinCheck-RPC result. Optional; the Symbol scorer just
 *        forgoes the +0.3 contribution when it's missing.
 * @returns {LayerSuggestion | null}
 */
export function autoTemplateMatch(layer, phase1, libsByLayer, opts = {}) {
  if (layer !== "symbol" && layer !== "footprint") return null;
  if (!libsByLayer || typeof libsByLayer !== "object") return null;

  const templatePinCounts =
    opts && typeof opts.templatePinCounts === "object" ? opts.templatePinCounts : null;

  let best = null;
  for (const libPath of Object.keys(libsByLayer)) {
    const names = libsByLayer[libPath];
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      if (typeof name !== "string" || !name) continue;
      const scored =
        layer === "symbol"
          ? _scoreSymbolCandidate(name, libPath, phase1, templatePinCounts)
          : _scoreFootprintCandidate(name, phase1);
      if (scored.score < AUTO_MATCH_MIN_SCORE) continue;
      if (best == null || scored.score > best.score) {
        best = { libPath, name, ...scored };
      }
    }
  }
  if (best == null) return null;
  return {
    layer,
    choice: { source: "template", libPath: best.libPath, name: best.name },
    confidence: Math.min(1, best.score),
    reasons: best.reasons,
    source: "auto-template-match",
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
  const templateFootprintsByLib = state?.templateFootprintsByLib || null;
  const templatePinCounts = state?.templatePinCounts || null;

  const resolved = resolveDeepestPrefixRule(categoryPath, categorySettings);
  const rule = resolved?.rule || null;

  const symbolTemplateResolvable = isSymbolTemplateResolvable(
    rule?.symbolSource,
    templateSymbolsByLib,
  );
  const labelsMapped = hasLabelMappingEntries(rule?.labelMapping);

  const phase1Normalized = { ...(phase1 || {}), categoryPath };
  const autoMatchOpts = { templatePinCounts };

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
    // ⚪/🟡 path: no Rule (or the Rule's symbol template went missing) —
    // try the Auto-Template-Match heuristic so the Panel can preview a
    // sensible candidate. Heuristic-only suggestions are capped at 🟡 by
    // ``computeConfidenceState`` (ADR-0006 AD-4).
    const symbolAuto = autoTemplateMatch(
      "symbol",
      phase1Normalized,
      templateSymbolsByLib,
      autoMatchOpts,
    );
    const footprintAuto = autoTemplateMatch(
      "footprint",
      phase1Normalized,
      templateFootprintsByLib,
      autoMatchOpts,
    );
    const fallbackReason = resolved ? null : "no Category Rule registered";
    symbol = symbolAuto || easyedaFallback("symbol", fallbackReason);
    footprint = footprintAuto || easyedaFallback("footprint", fallbackReason);
  }

  const guards = {
    pinCountOk: true,
    packageFormOk: true,
    templatesResolvable: symbolTemplateResolvable,
    pinPadResolvable: true,
    overwriteClear: true,
  };

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
    heuristicMatch:
      symbol.source === "auto-template-match"
      || footprint.source === "auto-template-match",
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
  const f = factors || {};
  if (!rule) {
    // ⚪/🟡 split for the rule-less branch (Issue #31, ADR-0006 AD-4):
    // a Heuristik-Match (Auto-Template-Match suggestion that cleared the
    // ``AUTO_MATCH_MIN_SCORE`` floor) raises the state to 🟡 so the user
    // sees a Low-Confidence preview instead of the bare Register-Prompt.
    // Without any heuristic hit we stay ⚪ white → Register-Prompt.
    return f.heuristicMatch === true ? "yellow" : "white";
  }
  const greenReady =
    f.ruleResolved === true
    && f.categoryResolved === true
    && f.symbolTemplateResolvable === true
    && f.labelsMapped === true
    && typeof f.confidence === "number"
    && f.confidence >= GREEN_CONFIDENCE_THRESHOLD;
  if (greenReady) return "green";
  // 🟡 — registered Rule but at least one MVP factor is missing or the
  // aggregate confidence is below ``GREEN_CONFIDENCE_THRESHOLD``. The
  // panel branches further on the user's ``lowConfidenceBehaviour``
  // setting (keep EasyEDA vs open Import-Editor).
  return "yellow";
}
