import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  normalizeCategoryPath,
  canonicalCategoryKey,
  mergeCategoryConfig,
  dedupeCategorySettings,
} from "./categoryPath.mjs";

/* -------------------------------------------------------------------------- */
/*  normalizeCategoryPath                                                     */
/* -------------------------------------------------------------------------- */

describe("normalizeCategoryPath", () => {
  it("returns empty string for non-string input", () => {
    expect(normalizeCategoryPath(null)).toBe("");
    expect(normalizeCategoryPath(undefined)).toBe("");
    expect(normalizeCategoryPath(42)).toBe("");
    expect(normalizeCategoryPath({})).toBe("");
    expect(normalizeCategoryPath([])).toBe("");
  });

  it("strips leading and trailing slashes", () => {
    expect(normalizeCategoryPath("/A/B/C/")).toBe("A/B/C");
    expect(normalizeCategoryPath("///A///")).toBe("A");
  });

  it("collapses repeated slashes between segments", () => {
    expect(normalizeCategoryPath("Passives///Resistors//SMD")).toBe(
      "Passives/Resistors/SMD",
    );
  });

  it("trims whitespace inside segments and drops empty ones", () => {
    expect(normalizeCategoryPath("  Passives  /  Resistors  /  SMD  ")).toBe(
      "Passives/Resistors/SMD",
    );
    expect(normalizeCategoryPath("A/  /B")).toBe("A/B");
  });

  it("converts backslashes to forward slashes", () => {
    expect(normalizeCategoryPath("A\\B\\C")).toBe("A/B/C");
    expect(normalizeCategoryPath("Mixed\\And/Slashes")).toBe("Mixed/And/Slashes");
  });

  it("applies Unicode NFC normalization", () => {
    // U+00E9 (precomposed é) vs. U+0065 U+0301 (e + combining acute) → same NFC.
    const decomposed = "Café/Sub";
    const precomposed = "Café/Sub";
    expect(normalizeCategoryPath(decomposed)).toBe(precomposed);
    expect(normalizeCategoryPath(decomposed)).toBe(normalizeCategoryPath(precomposed));
  });

  it("returns empty string for whitespace-only or slashes-only input", () => {
    expect(normalizeCategoryPath("")).toBe("");
    expect(normalizeCategoryPath("   ")).toBe("");
    expect(normalizeCategoryPath("///")).toBe("");
  });

  it("preserves casing and inner punctuation", () => {
    expect(normalizeCategoryPath("Resistors/SMD 0805/±1%")).toBe(
      "Resistors/SMD 0805/±1%",
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  canonicalCategoryKey                                                      */
/* -------------------------------------------------------------------------- */

describe("canonicalCategoryKey", () => {
  it("lowercases the normalized path", () => {
    expect(canonicalCategoryKey("Passives/Resistors/SMD")).toBe("passives/resistors/smd");
    expect(canonicalCategoryKey("/Passives//Resistors/")).toBe("passives/resistors");
  });

  it("returns empty string for empty normalized result", () => {
    expect(canonicalCategoryKey("///")).toBe("");
    expect(canonicalCategoryKey(null)).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/*  mergeCategoryConfig                                                       */
/* -------------------------------------------------------------------------- */

describe("mergeCategoryConfig", () => {
  it("OR's pin-visibility flags from both sides", () => {
    expect(
      mergeCategoryConfig(
        { hidePinNumbers: true, hidePinNames: false, valueParam: null },
        { hidePinNumbers: false, hidePinNames: true, valueParam: null },
      ),
    ).toEqual({ hidePinNumbers: true, hidePinNames: true, valueParam: null });
  });

  it("prefers a's valueParam over b's when both are set", () => {
    expect(
      mergeCategoryConfig(
        { valueParam: "Resistance" },
        { valueParam: "Capacitance" },
      ),
    ).toEqual({
      hidePinNumbers: false,
      hidePinNames: false,
      valueParam: "Resistance",
    });
  });

  it("falls back to b's valueParam when a is empty or whitespace", () => {
    expect(mergeCategoryConfig({ valueParam: "   " }, { valueParam: "Capacitance" })).toEqual({
      hidePinNumbers: false,
      hidePinNames: false,
      valueParam: "Capacitance",
    });
  });

  it("returns null valueParam when neither side has one", () => {
    expect(mergeCategoryConfig(null, undefined)).toEqual({
      hidePinNumbers: false,
      hidePinNames: false,
      valueParam: null,
    });
  });

  /* -------- V3 ComponentRule fields (ADR-0006, Issue #30) -------- */

  it("preserves a's symbolSource when only a has one", () => {
    const out = mergeCategoryConfig(
      { symbolSource: { source: "easyeda" } },
      { hidePinNumbers: true },
    );
    expect(out.symbolSource).toEqual({ source: "easyeda" });
  });

  it("falls back to b's symbolSource when a has none", () => {
    const out = mergeCategoryConfig(
      { hidePinNumbers: true },
      {
        symbolSource: {
          source: "template",
          libPath: "/libs/R.kicad_sym",
          name: "R_SMD",
        },
      },
    );
    expect(out.symbolSource).toEqual({
      source: "template",
      libPath: "/libs/R.kicad_sym",
      name: "R_SMD",
    });
  });

  it("prefers a's symbolSource over b's when both are set", () => {
    const out = mergeCategoryConfig(
      { symbolSource: { source: "easyeda" } },
      {
        symbolSource: {
          source: "template",
          libPath: "/libs/R.kicad_sym",
          name: "R_SMD",
        },
      },
    );
    expect(out.symbolSource).toEqual({ source: "easyeda" });
  });

  it("preserves footprintSource the same way as symbolSource", () => {
    const out = mergeCategoryConfig(
      {},
      {
        footprintSource: {
          source: "template",
          libPath: "/libs/R.pretty",
          name: "R_0805",
        },
      },
    );
    expect(out.footprintSource).toEqual({
      source: "template",
      libPath: "/libs/R.pretty",
      name: "R_0805",
    });
  });

  it("unions labelMapping with a's keys winning on conflict", () => {
    const out = mergeCategoryConfig(
      { labelMapping: { Resistance: "Value", Tolerance: "Tol_A" } },
      { labelMapping: { Tolerance: "Tol_B", Power: "Power" } },
    );
    expect(out.labelMapping).toEqual({
      Tolerance: "Tol_A",
      Power: "Power",
      Resistance: "Value",
    });
  });

  it("drops malformed source-layer descriptors instead of throwing", () => {
    const out = mergeCategoryConfig(
      { symbolSource: { source: "template", libPath: "/lib.kicad_sym" } },
      { symbolSource: { source: "bogus" } },
    );
    expect(out.symbolSource).toBeUndefined();
  });

  it("omits the V3 fields when neither side carries them (no shape bloat)", () => {
    const out = mergeCategoryConfig({ valueParam: "Resistance" }, { hidePinNumbers: true });
    expect(out).toEqual({
      hidePinNumbers: true,
      hidePinNames: false,
      valueParam: "Resistance",
    });
    expect(out).not.toHaveProperty("symbolSource");
    expect(out).not.toHaveProperty("footprintSource");
    expect(out).not.toHaveProperty("labelMapping");
  });

  it("silently drops ADR-0006-removed fields (autoApply / autoConfirm / action)", () => {
    const out = mergeCategoryConfig(
      { autoApply: "auto", autoConfirm: true, action: "skip" },
      { valueParam: "Resistance" },
    );
    expect(out).not.toHaveProperty("autoApply");
    expect(out).not.toHaveProperty("autoConfirm");
    expect(out).not.toHaveProperty("action");
    expect(out.valueParam).toBe("Resistance");
  });
});

/* -------------------------------------------------------------------------- */
/*  dedupeCategorySettings                                                    */
/* -------------------------------------------------------------------------- */

describe("dedupeCategorySettings", () => {
  it("returns an empty object for non-object input", () => {
    expect(dedupeCategorySettings(null)).toEqual({});
    expect(dedupeCategorySettings(undefined)).toEqual({});
    expect(dedupeCategorySettings("nope")).toEqual({});
  });

  it("collapses entries that differ only by letter case, picking the longer display key", () => {
    const out = dedupeCategorySettings({
      "Passives/Resistors": { hidePinNumbers: true, hidePinNames: false, valueParam: "Resistance" },
      "passives/resistors": { hidePinNumbers: false, hidePinNames: true, valueParam: null },
    });
    // Same length → first wins on display, but flags OR.
    expect(Object.keys(out)).toHaveLength(1);
    const [k] = Object.keys(out);
    expect(k.toLowerCase()).toBe("passives/resistors");
    expect(out[k]).toEqual({ hidePinNumbers: true, hidePinNames: true, valueParam: "Resistance" });
  });

  it("normalizes display keys (strips repeated/trailing slashes, trims segments)", () => {
    const out = dedupeCategorySettings({
      "/Passives//Resistors/  SMD  /": {
        hidePinNumbers: false,
        hidePinNames: false,
        valueParam: "Resistance",
      },
    });
    expect(Object.keys(out)).toEqual(["Passives/Resistors/SMD"]);
  });

  it("drops entries whose key normalizes to empty", () => {
    const out = dedupeCategorySettings({
      "///": { hidePinNumbers: true, hidePinNames: true, valueParam: "X" },
      "Valid/Path": { hidePinNumbers: false, hidePinNames: false, valueParam: null },
    });
    expect(Object.keys(out)).toEqual(["Valid/Path"]);
  });

  /* -------- V3 ComponentRule fields (ADR-0006, Issue #30) -------- */

  it("preserves symbolSource / footprintSource / labelMapping verbatim", () => {
    const rule = {
      hidePinNumbers: false,
      hidePinNames: false,
      valueParam: null,
      symbolSource: {
        source: "template",
        libPath: "/libs/R.kicad_sym",
        name: "R_SMD",
      },
      footprintSource: {
        source: "template",
        libPath: "/libs/R.pretty",
        name: "R_0805",
      },
      labelMapping: { Resistance: "Value", Tolerance: "Tol" },
    };
    const out = dedupeCategorySettings({ "Passives/Resistors": rule });
    expect(out["Passives/Resistors"]).toEqual({
      hidePinNumbers: false,
      hidePinNames: false,
      valueParam: null,
      symbolSource: rule.symbolSource,
      footprintSource: rule.footprintSource,
      labelMapping: rule.labelMapping,
    });
  });

  it("silently strips ADR-0006-removed fields when loading legacy rules", () => {
    const out = dedupeCategorySettings({
      "Passives/Resistors": {
        hidePinNumbers: false,
        hidePinNames: false,
        valueParam: "Resistance",
        autoApply: "auto",
        autoConfirm: true,
        action: "skip",
        symbolSource: { source: "easyeda" },
      },
    });
    const entry = out["Passives/Resistors"];
    expect(entry).not.toHaveProperty("autoApply");
    expect(entry).not.toHaveProperty("autoConfirm");
    expect(entry).not.toHaveProperty("action");
    expect(entry.valueParam).toBe("Resistance");
    expect(entry.symbolSource).toEqual({ source: "easyeda" });
  });

  it("merges new fields when case-collapsing duplicates (deepest a-wins, label union)", () => {
    const out = dedupeCategorySettings({
      "Passives/Resistors": {
        symbolSource: { source: "easyeda" },
        labelMapping: { Resistance: "Value" },
      },
      "passives/resistors": {
        footprintSource: {
          source: "template",
          libPath: "/libs/R.pretty",
          name: "R_0805",
        },
        labelMapping: { Power: "Power" },
      },
    });
    expect(Object.keys(out)).toHaveLength(1);
    const [k] = Object.keys(out);
    const merged = out[k];
    expect(merged.symbolSource).toEqual({ source: "easyeda" });
    expect(merged.footprintSource).toEqual({
      source: "template",
      libPath: "/libs/R.pretty",
      name: "R_0805",
    });
    expect(merged.labelMapping).toEqual({
      Power: "Power",
      Resistance: "Value",
    });
  });

  it("drops blank labelMapping entries", () => {
    const out = dedupeCategorySettings({
      "Passives/Resistors": {
        labelMapping: { Resistance: "Value", "": "Skipped", Tolerance: "  " },
      },
    });
    expect(out["Passives/Resistors"].labelMapping).toEqual({
      Resistance: "Value",
    });
  });

  it("drops malformed source-layer descriptors instead of writing a broken rule", () => {
    const out = dedupeCategorySettings({
      "Passives/Resistors": {
        symbolSource: { source: "template", libPath: "/libs/R.kicad_sym" },
        footprintSource: { source: "bogus" },
      },
    });
    expect(out["Passives/Resistors"]).not.toHaveProperty("symbolSource");
    expect(out["Passives/Resistors"]).not.toHaveProperty("footprintSource");
  });
});

/* -------------------------------------------------------------------------- */
/*  Classic-script parity                                                     */
/*                                                                            */
/*  The MV3 service worker and popup load `chrome_extension/categoryPath.js`  */
/*  as a classic script that defines globals (no ESM in `importScripts`).    */
/*  This block pins that file behaviorally equivalent to the canonical ESM   */
/*  for the full test corpus above. If a future edit changes one but not    */
/*  the other, this test fails.                                              */
/* -------------------------------------------------------------------------- */

describe("classic-script categoryPath.js parity", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const classicPath = resolve(here, "..", "categoryPath.js");
  const classicSrc = readFileSync(classicPath, "utf-8");
  // Run the classic script in an isolated function scope and capture the four
  // function declarations via the `return` at the end. `new Function` gives us
  // a fresh global-less scope; the classic file does not depend on `window` or
  // `chrome`, only on built-in globals (Map, Object, String).
  const factory = new Function(
    `${classicSrc}\n` +
      "return { normalizeCategoryPath, canonicalCategoryKey, mergeCategoryConfig, dedupeCategorySettings };",
  );
  const classic = factory();

  /** Inputs cover every branch exercised above. */
  const stringCorpus = [
    null,
    undefined,
    42,
    {},
    [],
    "",
    "   ",
    "///",
    "/A/B/C/",
    "Passives///Resistors//SMD",
    "  Passives  /  Resistors  /  SMD  ",
    "A\\B\\C",
    "Café/Sub",
    "Resistors/SMD 0805/±1%",
  ];
  const dedupeCorpus = [
    null,
    undefined,
    "string",
    {
      "Passives/Resistors": {
        hidePinNumbers: true,
        hidePinNames: false,
        valueParam: "Resistance",
      },
      "passives/resistors": {
        hidePinNumbers: false,
        hidePinNames: true,
        valueParam: null,
      },
    },
    {
      "/Passives//Resistors/  SMD  /": {
        hidePinNumbers: false,
        hidePinNames: false,
        valueParam: "  ",
      },
    },
    {
      "///": { hidePinNumbers: true, hidePinNames: true, valueParam: "X" },
      "Valid/Path": { hidePinNumbers: false, hidePinNames: false, valueParam: null },
    },
    // V3 ComponentRule fields — both halves of a case-collision must survive
    // the dedupe pass identically on both sides.
    {
      "Passives/Resistors": {
        hidePinNumbers: false,
        hidePinNames: false,
        valueParam: null,
        symbolSource: { source: "easyeda" },
        labelMapping: { Resistance: "Value" },
      },
      "passives/resistors": {
        hidePinNumbers: false,
        hidePinNames: false,
        valueParam: null,
        footprintSource: {
          source: "template",
          libPath: "/libs/R.pretty",
          name: "R_0805",
        },
        labelMapping: { Power: "Power" },
      },
    },
    // Legacy V2-era row carrying the ADR-0006-removed fields — they must
    // disappear in lockstep on both sides.
    {
      "Passives/Resistors": {
        hidePinNumbers: true,
        hidePinNames: false,
        valueParam: "Resistance",
        autoApply: "auto",
        autoConfirm: true,
        action: "skip",
      },
    },
  ];

  it("normalizeCategoryPath matches the ESM across the corpus", () => {
    for (const input of stringCorpus) {
      expect(classic.normalizeCategoryPath(input)).toBe(normalizeCategoryPath(input));
    }
  });

  it("canonicalCategoryKey matches the ESM across the corpus", () => {
    for (const input of stringCorpus) {
      expect(classic.canonicalCategoryKey(input)).toBe(canonicalCategoryKey(input));
    }
  });

  it("mergeCategoryConfig matches the ESM for representative pairs", () => {
    const pairs = [
      [null, null],
      [{ valueParam: "A" }, { valueParam: "B" }],
      [{ valueParam: "  " }, { valueParam: "B" }],
      [
        { hidePinNumbers: true, hidePinNames: false },
        { hidePinNumbers: false, hidePinNames: true },
      ],
      // V3 ComponentRule fields — source layers + labelMapping merge order
      // must be identical on both sides for the JS↔Python parity step
      // to mean anything.
      [
        { symbolSource: { source: "easyeda" } },
        {
          symbolSource: {
            source: "template",
            libPath: "/libs/R.kicad_sym",
            name: "R_SMD",
          },
        },
      ],
      [
        { labelMapping: { Resistance: "Value", Tolerance: "Tol_A" } },
        { labelMapping: { Tolerance: "Tol_B", Power: "Power" } },
      ],
      [
        { autoApply: "auto", autoConfirm: true, action: "skip" },
        { valueParam: "Resistance" },
      ],
    ];
    for (const [a, b] of pairs) {
      expect(classic.mergeCategoryConfig(a, b)).toEqual(mergeCategoryConfig(a, b));
    }
  });

  it("dedupeCategorySettings matches the ESM across the corpus", () => {
    for (const input of dedupeCorpus) {
      expect(classic.dedupeCategorySettings(input)).toEqual(dedupeCategorySettings(input));
    }
  });
});
