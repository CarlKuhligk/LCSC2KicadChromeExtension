import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  matchComponentRule,
  computeConfidenceState,
  autoTemplateMatch,
  AUTO_MATCH_MIN_SCORE,
  EASYEDA_FALLBACK_CONFIDENCE,
  GREEN_CONFIDENCE_THRESHOLD,
} from "./confidenceState.mjs";

/**
 * Confidence-Pipeline tests. Issue #25 wired the ⚪ ``white`` path;
 * Issue #29 lights up the 🟢 ``green`` path (registered Rule + MVP
 * factors + high confidence). 🟡 (#31) lands later.
 */

const FACTORS_GREEN_READY = Object.freeze({
  ruleResolved: true,
  categoryResolved: true,
  symbolTemplateResolvable: true,
  labelsMapped: true,
  confidence: 0.95,
});

/* -------------------------------------------------------------------------- */
/*  computeConfidenceState                                                    */
/* -------------------------------------------------------------------------- */

describe("computeConfidenceState", () => {
  it("returns 'white' when no Rule was resolved", () => {
    expect(computeConfidenceState(null, {}, {}, {})).toBe("white");
  });

  it("returns 'white' when the rule argument is undefined", () => {
    expect(computeConfidenceState(undefined, {}, {}, {})).toBe("white");
  });

  it("returns 'green' when rule + MVP factors are satisfied and confidence is high", () => {
    expect(
      computeConfidenceState({ x: 1 }, {}, {}, FACTORS_GREEN_READY),
    ).toBe("green");
  });

  it("returns 'yellow' when symbolTemplateResolvable is false (rule still gates)", () => {
    expect(
      computeConfidenceState(
        { x: 1 }, {}, {},
        { ...FACTORS_GREEN_READY, symbolTemplateResolvable: false },
      ),
    ).toBe("yellow");
  });

  it("returns 'yellow' when labelMapping is empty (no MVP label-mapped factor)", () => {
    expect(
      computeConfidenceState(
        { x: 1 }, {}, {},
        { ...FACTORS_GREEN_READY, labelsMapped: false },
      ),
    ).toBe("yellow");
  });

  it("returns 'yellow' when confidence is below the green threshold", () => {
    expect(
      computeConfidenceState(
        { x: 1 }, {}, {},
        { ...FACTORS_GREEN_READY, confidence: GREEN_CONFIDENCE_THRESHOLD - 0.01 },
      ),
    ).toBe("yellow");
  });

  it("returns 'yellow' when factors are missing entirely (no green claim from a bare rule)", () => {
    expect(computeConfidenceState({ x: 1 }, {}, {}, {})).toBe("yellow");
  });

  it("returns 'yellow' for rule=null + heuristicMatch=true (Auto-Template-Match without Rule)", () => {
    // Issue #31, ADR-0006 AD-4: a Heuristik-Match (Auto-Template-Match
    // suggestion above ``AUTO_MATCH_MIN_SCORE``) lifts ⚪ → 🟡 so the panel
    // can show a Low-Confidence preview. Never green — that requires a
    // registered Rule.
    expect(
      computeConfidenceState(null, {}, {}, { heuristicMatch: true, confidence: 1.0 }),
    ).toBe("yellow");
  });

  it("returns 'white' for rule=null + heuristicMatch missing (no usable preview)", () => {
    expect(
      computeConfidenceState(null, {}, {}, { confidence: EASYEDA_FALLBACK_CONFIDENCE }),
    ).toBe("white");
  });
});

/* -------------------------------------------------------------------------- */
/*  autoTemplateMatch — KONZEPT §3.4, Issue #31                                */
/* -------------------------------------------------------------------------- */

describe("autoTemplateMatch (symbol)", () => {
  const SYMBOL_LIB = "/templates/StdLib.kicad_sym";
  const SYMBOL_LIBS = { [SYMBOL_LIB]: ["Resistor_Std", "Capacitor_Std", "MCU_Big"] };

  it("returns null when no template library is registered", () => {
    expect(
      autoTemplateMatch("symbol", { categoryPath: "Passives/Resistors" }, null),
    ).toBeNull();
  });

  it("name-token alone scores 0.5 — below the 0.6 floor (KONZEPT §3.4)", () => {
    // Only the +0.5 leaf-token contribution fires; the heuristic refuses to
    // surface a candidate until a second signal (pin-count or family) joins.
    const suggestion = autoTemplateMatch(
      "symbol",
      { categoryPath: "Passives/Resistor" },
      SYMBOL_LIBS,
    );
    expect(suggestion).toBeNull();
  });

  it("name-token + pin-count match clears the floor and surfaces the candidate", () => {
    const suggestion = autoTemplateMatch(
      "symbol",
      { categoryPath: "Passives/Resistor", pinCount: 2 },
      SYMBOL_LIBS,
      { templatePinCounts: { [SYMBOL_LIB]: { Resistor_Std: 2 } } },
    );
    expect(suggestion?.choice).toEqual({
      source: "template",
      libPath: SYMBOL_LIB,
      name: "Resistor_Std",
    });
    expect(suggestion.source).toBe("auto-template-match");
    expect(suggestion.confidence).toBeGreaterThanOrEqual(AUTO_MATCH_MIN_SCORE);
  });

  it("scores leaf-token + pin-count at 0.8 and lists both reasons", () => {
    const suggestion = autoTemplateMatch(
      "symbol",
      { categoryPath: "Passives/Resistor", pinCount: 2 },
      SYMBOL_LIBS,
      { templatePinCounts: { [SYMBOL_LIB]: { Resistor_Std: 2, Capacitor_Std: 2 } } },
    );
    expect(suggestion?.confidence).toBeCloseTo(0.8, 5);
    expect(suggestion.reasons).toEqual(
      expect.arrayContaining(["category leaf token", "pin-count 2"]),
    );
  });

  it("never picks a candidate when its score falls below the 0.6 threshold", () => {
    // Pin-count alone is +0.3 — below the floor.
    const suggestion = autoTemplateMatch(
      "symbol",
      { categoryPath: "Unknown/Category", pinCount: 2 },
      SYMBOL_LIBS,
      { templatePinCounts: { [SYMBOL_LIB]: { Resistor_Std: 2 } } },
    );
    expect(suggestion).toBeNull();
  });
});

describe("autoTemplateMatch (footprint)", () => {
  const FP_LIB = "/templates/StdLib.kicad_sym";
  const FP_LIBS = { [FP_LIB]: ["R_0603_1608Metric", "R_0805", "SOT-23-3"] };

  it("uses packageForm.canonical for the +0.7 token match", () => {
    const suggestion = autoTemplateMatch(
      "footprint",
      { packageForm: { canonical: "0603", family: "0603" } },
      FP_LIBS,
    );
    expect(suggestion?.choice).toEqual({
      source: "template",
      libPath: FP_LIB,
      name: "R_0603_1608Metric",
    });
    expect(suggestion.confidence).toBeCloseTo(0.7, 5);
    expect(suggestion.source).toBe("auto-template-match");
  });

  it("adds family + pinSuffix contributions for SOT-style packages", () => {
    const suggestion = autoTemplateMatch(
      "footprint",
      {
        packageForm: { canonical: "SOT-23-3", family: "SOT-23", pinSuffix: 3 },
      },
      FP_LIBS,
    );
    // canonical "sot-23-3" doesn't tokenise to a single haystack token; the
    // tokens after splitting are ["sot","23","3"]. Family "sot-23" -> ["sot","23"]
    // matches name tokens. PinSuffix 3 matches token "3".
    expect(suggestion?.choice.name).toBe("SOT-23-3");
    expect(suggestion.confidence).toBeGreaterThanOrEqual(AUTO_MATCH_MIN_SCORE);
  });

  it("returns null when nothing crosses the 0.6 floor", () => {
    const suggestion = autoTemplateMatch(
      "footprint",
      { packageForm: { canonical: "QFN-48" } },
      FP_LIBS,
    );
    expect(suggestion).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  matchComponentRule — 🟡 yellow-state slice (Issue #31)                     */
/* -------------------------------------------------------------------------- */

describe("matchComponentRule (yellow-state slice)", () => {
  const LIB = "/templates/StdLib.kicad_sym";

  it("returns state='yellow' when no Rule matches but Auto-Template-Match finds a footprint", () => {
    const result = matchComponentRule(
      {
        categoryPath: "Passives/Resistors",
        packageForm: { canonical: "0603", family: "0603" },
      },
      {
        categorySettings: {},
        templateSymbolsByLib: {},
        templateFootprintsByLib: { [LIB]: ["R_0603_1608Metric"] },
      },
    );
    expect(result.state).toBe("yellow");
    expect(result.footprint.source).toBe("auto-template-match");
    expect(result.footprint.choice).toEqual({
      source: "template",
      libPath: LIB,
      name: "R_0603_1608Metric",
    });
    expect(result.ruleKey).toBeNull();
  });

  it("returns state='yellow' when no Rule matches but Auto-Template-Match finds a symbol", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistor", pinCount: 2 },
      {
        categorySettings: {},
        templateSymbolsByLib: { [LIB]: ["Resistor_Std"] },
        templatePinCounts: { [LIB]: { Resistor_Std: 2 } },
      },
    );
    expect(result.state).toBe("yellow");
    expect(result.symbol.source).toBe("auto-template-match");
    expect(result.symbol.choice.name).toBe("Resistor_Std");
  });

  it("stays state='white' when no Rule + no heuristic candidate clears 0.6", () => {
    const result = matchComponentRule(
      { categoryPath: "Sensors/Specialty", pinCount: 4 },
      {
        categorySettings: {},
        templateSymbolsByLib: { [LIB]: ["Resistor_Std"] },
        templateFootprintsByLib: { [LIB]: ["R_0603"] },
      },
    );
    expect(result.state).toBe("white");
    expect(result.symbol.source).toBe("easyeda-fallback");
    expect(result.footprint.source).toBe("easyeda-fallback");
  });

  it("Heuristik-Match alone never raises to 🟢 (ADR-0006 AD-4)", () => {
    // Cap the auto-template match at confidence ≤ 1; even at 1.0 the lack
    // of a registered Rule forces 🟡 yellow, never 🟢 green.
    const result = matchComponentRule(
      {
        categoryPath: "Passives/Resistor",
        pinCount: 2,
        packageForm: { canonical: "0603", family: "0603" },
      },
      {
        categorySettings: {},
        templateSymbolsByLib: { [LIB]: ["Resistor_0603_Std"] },
        templateFootprintsByLib: { [LIB]: ["R_0603_1608Metric"] },
        templatePinCounts: { [LIB]: { Resistor_0603_Std: 2 } },
      },
    );
    expect(result.state).not.toBe("green");
    expect(result.state).toBe("yellow");
  });
});

/* -------------------------------------------------------------------------- */
/*  matchComponentRule — white-path slice                                     */
/* -------------------------------------------------------------------------- */

describe("matchComponentRule (white-state slice)", () => {
  it("returns state='white' when no rules are registered", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors" },
      { categorySettings: {} },
    );
    expect(result.state).toBe("white");
    expect(result.ruleKey).toBeNull();
    expect(result.rule).toBeNull();
  });

  it("returns state='white' when categorySettings is null", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors" },
      { categorySettings: null },
    );
    expect(result.state).toBe("white");
    expect(result.ruleKey).toBeNull();
  });

  it("returns state='white' when no rule prefix matches the page's category", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors" },
      { categorySettings: { Capacitors: { hidePinNumbers: true } } },
    );
    expect(result.state).toBe("white");
    expect(result.ruleKey).toBeNull();
  });

  it("returns state='white' when the categoryPath itself is missing", () => {
    const result = matchComponentRule(
      { categoryPath: null },
      { categorySettings: { Passives: { hidePinNumbers: true } } },
    );
    expect(result.state).toBe("white");
  });

  it("falls back to EasyEDA for both Layers in the white state", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors" },
      { categorySettings: {} },
    );
    expect(result.symbol.choice).toEqual({ source: "easyeda" });
    expect(result.footprint.choice).toEqual({ source: "easyeda" });
    expect(result.symbol.source).toBe("easyeda-fallback");
    expect(result.footprint.source).toBe("easyeda-fallback");
    expect(result.confidence).toBe(EASYEDA_FALLBACK_CONFIDENCE);
  });

  it("returns a non-null rule when deepest-prefix matches (rule shape only — green still gates)", () => {
    const rule = { hidePinNumbers: true, valueParam: "Resistance" };
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors/SMD" },
      { categorySettings: { "Passives/Resistors": rule } },
    );
    expect(result.ruleKey).toBe("Passives/Resistors");
    expect(result.rule).toBe(rule);
    // No ``symbolSource`` / ``labelMapping`` on this legacy-shape rule →
    // ``computeConfidenceState`` parks it in 🟡, not ⚪, not 🟢.
    expect(result.state).toBe("yellow");
  });

  it("picks the deepest prefix when multiple rules could match", () => {
    const shallow = { hidePinNames: true };
    const deep = { hidePinNumbers: true };
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors/SMD" },
      {
        categorySettings: {
          Passives: shallow,
          "Passives/Resistors": deep,
        },
      },
    );
    expect(result.ruleKey).toBe("Passives/Resistors");
    expect(result.rule).toBe(deep);
  });

  it("does not match a partial-segment prefix (Resistor vs Resistors)", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistor" },
      { categorySettings: { "Passives/Resistors": { hidePinNumbers: true } } },
    );
    expect(result.state).toBe("white");
    expect(result.ruleKey).toBeNull();
  });

  it("exposes MatchResult.state + MatchResult.confidence for the Phase-1 wire format", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors" },
      { categorySettings: {} },
    );
    // Acceptance criterion: "Phase-1-Antwort trägt MatchResult{ state, confidence }"
    expect(typeof result.state).toBe("string");
    expect(typeof result.confidence).toBe("number");
  });

  it("populates the guards object with the MVP slot names so 🟢/🟡 slices can fill them in", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors" },
      { categorySettings: {} },
    );
    expect(result.guards).toEqual(
      expect.objectContaining({
        pinCountOk: expect.any(Boolean),
        packageFormOk: expect.any(Boolean),
        templatesResolvable: expect.any(Boolean),
        pinPadResolvable: expect.any(Boolean),
        overwriteClear: expect.any(Boolean),
      }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  matchComponentRule — 🟢 green-state slice (Issue #29)                      */
/* -------------------------------------------------------------------------- */

describe("matchComponentRule (green-state slice)", () => {
  const TEMPLATE_LIB_PATH = "/home/user/templates/StdLib.kicad_sym";
  const greenRule = {
    symbolSource: {
      source: "template",
      libPath: TEMPLATE_LIB_PATH,
      name: "Resistor_Std",
    },
    labelMapping: { Resistance: "Value", Tolerance: "Tolerance" },
  };
  const greenState = {
    categorySettings: { "Passives/Resistors": greenRule },
    templateSymbolsByLib: { [TEMPLATE_LIB_PATH]: ["Resistor_Std", "Capacitor_Std"] },
  };

  it("returns state='green' when rule + template lib + labelMapping line up", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors/SMD" },
      greenState,
    );
    expect(result.state).toBe("green");
    expect(result.ruleKey).toBe("Passives/Resistors");
    expect(result.rule).toBe(greenRule);
  });

  it("surfaces the rule's symbolSource as the Symbol Suggestion (preview source)", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors/SMD" },
      greenState,
    );
    expect(result.symbol.source).toBe("rule");
    expect(result.symbol.choice).toEqual(greenRule.symbolSource);
    expect(result.symbol.confidence).toBeGreaterThanOrEqual(
      GREEN_CONFIDENCE_THRESHOLD,
    );
  });

  it("guards.templatesResolvable is true on the green path", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors/SMD" },
      greenState,
    );
    expect(result.guards.templatesResolvable).toBe(true);
  });

  it("MVP (Symbol-first): footprint stays on EasyEDA and does NOT block 🟢", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors/SMD" },
      greenState,
    );
    expect(result.state).toBe("green");
    expect(result.footprint.choice).toEqual({ source: "easyeda" });
    expect(result.footprint.source).toBe("easyeda-fallback");
  });

  it("falls back to 🟡 when the Template Library was unregistered between save and now", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors/SMD" },
      {
        categorySettings: greenState.categorySettings,
        templateSymbolsByLib: {},
      },
    );
    expect(result.state).toBe("yellow");
    expect(result.guards.templatesResolvable).toBe(false);
    // Symbol falls back to EasyEDA so the Override Panel can still render
    // a sensible default (no broken template reference reaches Phase 2).
    expect(result.symbol.choice).toEqual({ source: "easyeda" });
  });

  it("stays 🟢 with no labelMapping — metadata is auto-upserted (ADR-0006 refined)", () => {
    // ADR-0006 (refined 2026-06-09): all LCSC spec params are auto-upserted as
    // symbol Properties, so an empty/absent labelMapping no longer blocks green.
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors" },
      {
        categorySettings: {
          "Passives/Resistors": { ...greenRule, labelMapping: {} },
        },
        templateSymbolsByLib: greenState.templateSymbolsByLib,
      },
    );
    expect(result.state).toBe("green");
  });

  it("falls back to 🟡 when the symbolSource is EasyEDA (no template to resolve)", () => {
    const result = matchComponentRule(
      { categoryPath: "Passives/Resistors" },
      {
        categorySettings: {
          "Passives/Resistors": {
            ...greenRule,
            symbolSource: { source: "easyeda" },
          },
        },
        templateSymbolsByLib: greenState.templateSymbolsByLib,
      },
    );
    expect(result.state).toBe("yellow");
    expect(result.guards.templatesResolvable).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Classic-script parity                                                     */
/*                                                                            */
/*  The MV3 service worker loads chrome_extension/confidenceState.js as a    */
/*  classic script (no ESM in importScripts). This block pins that file      */
/*  behaviorally equivalent to the canonical ESM for the test corpus above.  */
/*  If a future edit changes one but not the other, this test fails.         */
/* -------------------------------------------------------------------------- */

describe("classic-script confidenceState.js parity", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const classicPath = resolve(here, "..", "confidenceState.js");
  const classicSrc = readFileSync(classicPath, "utf-8");
  // categoryPath.js defines normalizeCategoryPath as a global — load it in
  // the same factory so confidenceState.js (which calls that global) sees it.
  const categoryClassicSrc = readFileSync(
    resolve(here, "..", "categoryPath.js"),
    "utf-8",
  );
  const factory = new Function(
    `${categoryClassicSrc}\n${classicSrc}\n` +
      "return { matchComponentRule, computeConfidenceState, autoTemplateMatch, " +
      "EASYEDA_FALLBACK_CONFIDENCE, GREEN_CONFIDENCE_THRESHOLD, AUTO_MATCH_MIN_SCORE };",
  );
  const classic = factory();

  const GREEN_LIB = "/home/user/templates/StdLib.kicad_sym";
  const greenRule = {
    symbolSource: { source: "template", libPath: GREEN_LIB, name: "Resistor_Std" },
    labelMapping: { Resistance: "Value" },
  };
  const cases = [
    [{ categoryPath: "Passives/Resistors" }, { categorySettings: {} }],
    [{ categoryPath: "Passives/Resistors" }, { categorySettings: null }],
    [{ categoryPath: null }, { categorySettings: { Passives: { hidePinNumbers: true } } }],
    [
      { categoryPath: "Passives/Resistors/SMD" },
      {
        categorySettings: {
          Passives: { hidePinNames: true },
          "Passives/Resistors": { hidePinNumbers: true },
        },
      },
    ],
    [
      { categoryPath: "Passives/Resistor" },
      { categorySettings: { "Passives/Resistors": { hidePinNumbers: true } } },
    ],
    // 🟢 green-state corpus — verifies the classic shim mirrors the new
    // template-resolution / labelMapping factors.
    [
      { categoryPath: "Passives/Resistors/SMD" },
      {
        categorySettings: { "Passives/Resistors": greenRule },
        templateSymbolsByLib: { [GREEN_LIB]: ["Resistor_Std"] },
      },
    ],
    // 🟡 fallback: same rule but the template lib was unregistered.
    [
      { categoryPath: "Passives/Resistors/SMD" },
      {
        categorySettings: { "Passives/Resistors": greenRule },
        templateSymbolsByLib: {},
      },
    ],
    // 🟡 Issue #31 — no Rule but Auto-Template-Match finds a footprint.
    [
      {
        categoryPath: "Passives/Resistors",
        packageForm: { canonical: "0603", family: "0603" },
      },
      {
        categorySettings: {},
        templateSymbolsByLib: {},
        templateFootprintsByLib: { [GREEN_LIB]: ["R_0603_1608Metric"] },
      },
    ],
    // 🟡 Issue #31 — no Rule but Auto-Template-Match finds a symbol via
    // category leaf + cached TemplatePinCheck.
    [
      { categoryPath: "Passives/Resistor", pinCount: 2 },
      {
        categorySettings: {},
        templateSymbolsByLib: { [GREEN_LIB]: ["Resistor_Std"] },
        templatePinCounts: { [GREEN_LIB]: { Resistor_Std: 2 } },
      },
    ],
  ];

  it("EASYEDA_FALLBACK_CONFIDENCE matches the ESM", () => {
    expect(classic.EASYEDA_FALLBACK_CONFIDENCE).toBe(EASYEDA_FALLBACK_CONFIDENCE);
  });

  it("GREEN_CONFIDENCE_THRESHOLD matches the ESM", () => {
    expect(classic.GREEN_CONFIDENCE_THRESHOLD).toBe(GREEN_CONFIDENCE_THRESHOLD);
  });

  it("AUTO_MATCH_MIN_SCORE matches the ESM", () => {
    expect(classic.AUTO_MATCH_MIN_SCORE).toBe(AUTO_MATCH_MIN_SCORE);
  });

  it("autoTemplateMatch matches the ESM for symbol + footprint cases", () => {
    const sym = ["symbol", { categoryPath: "Passives/Resistor", pinCount: 2 },
      { [GREEN_LIB]: ["Resistor_Std"] },
      { templatePinCounts: { [GREEN_LIB]: { Resistor_Std: 2 } } }];
    expect(classic.autoTemplateMatch(...sym)).toEqual(autoTemplateMatch(...sym));
    const fp = ["footprint",
      { packageForm: { canonical: "0603", family: "0603" } },
      { [GREEN_LIB]: ["R_0603_1608Metric"] }];
    expect(classic.autoTemplateMatch(...fp)).toEqual(autoTemplateMatch(...fp));
  });

  it("computeConfidenceState matches the ESM for null / yellow / green factor sets", () => {
    expect(classic.computeConfidenceState(null, {}, {}, {})).toBe(
      computeConfidenceState(null, {}, {}, {}),
    );
    expect(
      classic.computeConfidenceState({ x: 1 }, {}, {}, { ruleResolved: true }),
    ).toBe(computeConfidenceState({ x: 1 }, {}, {}, { ruleResolved: true }));
    expect(
      classic.computeConfidenceState({ x: 1 }, {}, {}, FACTORS_GREEN_READY),
    ).toBe(computeConfidenceState({ x: 1 }, {}, {}, FACTORS_GREEN_READY));
  });

  it("matchComponentRule matches the ESM across the corpus", () => {
    for (const [phase1, state] of cases) {
      const a = classic.matchComponentRule(phase1, state);
      const b = matchComponentRule(phase1, state);
      // Object identity for inner rule pointers will differ between the two
      // captures of the same input map; compare structurally.
      expect(a).toEqual(b);
    }
  });
});
