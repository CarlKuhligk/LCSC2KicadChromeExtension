import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  matchComponentRule,
  computeConfidenceState,
  EASYEDA_FALLBACK_CONFIDENCE,
} from "./confidenceState.mjs";

/**
 * Issue #25 — Confidence-Pipeline + Register-Prompt (white state).
 * Only the ⚪ ``white`` path is wired here. 🟢 (#29) and 🟡 (#31) land later.
 */

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

  it("does not return 'green' yet — the 🟢 branch lands with Issue #29", () => {
    const result = computeConfidenceState(
      { categoryPath: "Passives/Resistors" },
      { confidence: 1 },
      { confidence: 1 },
      { ruleResolved: true, confidence: 1 },
    );
    // White is reserved for "no rule"; one-click (green) needs MVP factors
    // that this slice does not yet populate. Until #29 lands, any resolved
    // rule sits in yellow so we never silently grant one-click.
    expect(result).not.toBe("green");
    expect(result).not.toBe("white");
    expect(result).toBe("yellow");
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
    // Until #29 wires the 🟢 branch, a resolved rule still does not yield
    // green — only that we stop being ⚪ white.
    expect(result.state).not.toBe("white");
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
      "return { matchComponentRule, computeConfidenceState, EASYEDA_FALLBACK_CONFIDENCE };",
  );
  const classic = factory();

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
  ];

  it("EASYEDA_FALLBACK_CONFIDENCE matches the ESM", () => {
    expect(classic.EASYEDA_FALLBACK_CONFIDENCE).toBe(EASYEDA_FALLBACK_CONFIDENCE);
  });

  it("computeConfidenceState matches the ESM for null/non-null rule", () => {
    expect(classic.computeConfidenceState(null, {}, {}, {})).toBe(
      computeConfidenceState(null, {}, {}, {}),
    );
    expect(
      classic.computeConfidenceState({ x: 1 }, {}, {}, { ruleResolved: true }),
    ).toBe(computeConfidenceState({ x: 1 }, {}, {}, { ruleResolved: true }));
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
