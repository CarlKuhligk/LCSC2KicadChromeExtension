import { describe, it, expect } from "vitest";

import { detectPackageForm, DEFAULT_TAXONOMY } from "./packageForm.mjs";

/* -------------------------------------------------------------------------- */
/*  Real LCSC `Package` strings (acceptance corpus)                           */
/* -------------------------------------------------------------------------- */

describe("detectPackageForm — real LCSC strings", () => {
  it("normalizes a bare imperial chip", () => {
    const out = detectPackageForm("0603");
    expect(out.canonical).toBe("0603");
    expect(out.family).toBe("0603");
    expect(out.sizeImperial).toBe("0603");
    expect(out.sizeMetric).toBe("1608");
    expect(out.confidence).toBe(1.0);
  });

  it("normalizes imperial+metric in parens", () => {
    const out = detectPackageForm("0603(1608 Metric)");
    expect(out.canonical).toBe("0603");
    expect(out.family).toBe("0603");
    expect(out.sizeMetric).toBe("1608");
    expect(out.confidence).toBe(1.0);
  });

  it("normalizes a bare metric to its imperial alias", () => {
    const out = detectPackageForm("1608");
    expect(out.canonical).toBe("0603");
    expect(out.sizeImperial).toBe("0603");
    expect(out.sizeMetric).toBe("1608");
    expect(out.confidence).toBe(1.0);
  });

  it("normalizes a SOT family with explicit pin suffix", () => {
    const out = detectPackageForm("SOT-23-3");
    expect(out.canonical).toBe("SOT-23-3");
    expect(out.family).toBe("SOT-23");
    expect(out.pinSuffix).toBe(3);
    expect(out.confidence).toBe(1.0);
  });

  it("derives SOT-23 pin suffix from pinCount when the raw lacks it", () => {
    const out = detectPackageForm("SOT-23", { pinCount: 3 });
    expect(out.canonical).toBe("SOT-23-3");
    expect(out.family).toBe("SOT-23");
    expect(out.pinSuffix).toBe(3);
    expect(out.confidence).toBe(0.8);
  });

  it("keeps bare SOT-23 when no pinCount is known", () => {
    const out = detectPackageForm("SOT-23");
    expect(out.canonical).toBe("SOT-23");
    expect(out.family).toBe("SOT-23");
    expect(out.pinSuffix).toBeNull();
    expect(out.confidence).toBe(1.0);
  });

  it("falls back for SOP packages (outside UQ-4 family list)", () => {
    const out = detectPackageForm("SOP-8_3.9x4.9x1.27P");
    expect(out.canonical).toBe("SOP-8_3.9x4.9x1.27P");
    expect(out.family).toBeNull();
    expect(out.confidence).toBe(0.4);
  });

  it("normalizes SOIC with whitelist pin count", () => {
    const out = detectPackageForm("SOIC-8");
    expect(out.canonical).toBe("SOIC-8");
    expect(out.family).toBe("SOIC");
    expect(out.pinSuffix).toBe(8);
    expect(out.confidence).toBe(1.0);
  });

  it("normalizes QFN with whitelist pin count", () => {
    const out = detectPackageForm("QFN-32");
    expect(out.canonical).toBe("QFN-32");
    expect(out.family).toBe("QFN");
    expect(out.pinSuffix).toBe(32);
    expect(out.confidence).toBe(1.0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Edge cases                                                                */
/* -------------------------------------------------------------------------- */

describe("detectPackageForm — edge cases", () => {
  it("returns an empty result for empty/non-string input", () => {
    expect(detectPackageForm(null)).toEqual({
      canonical: "",
      family: null,
      raw: "",
      confidence: 0,
    });
    expect(detectPackageForm(undefined)).toEqual({
      canonical: "",
      family: null,
      raw: "",
      confidence: 0,
    });
    expect(detectPackageForm(42)).toEqual({
      canonical: "",
      family: null,
      raw: "",
      confidence: 0,
    });
    expect(detectPackageForm("")).toEqual({
      canonical: "",
      family: null,
      raw: "",
      confidence: 0,
    });
  });

  it("falls back to trimmed raw for unrecognized packages", () => {
    const out = detectPackageForm("DPAK-3");
    expect(out.canonical).toBe("DPAK-3");
    expect(out.family).toBeNull();
    expect(out.confidence).toBe(0.4);
  });

  it("preserves raw verbatim alongside canonical", () => {
    const out = detectPackageForm("  0603  ");
    expect(out.canonical).toBe("0603");
    expect(out.raw).toBe("0603");
  });

  it("accepts a custom taxonomy override", () => {
    const tiny = {
      version: 1,
      chipImperial: ["9999"],
      metricToImperial: {},
      families: {},
    };
    const out = detectPackageForm("9999", { taxonomy: tiny });
    expect(out.canonical).toBe("9999");
    expect(out.family).toBe("9999");
  });

  it("uses footprint name as secondary signal when raw is empty", () => {
    const out = detectPackageForm("", { footprintName: "R_0603_1608Metric" });
    expect(out.canonical).toBe("0603");
    expect(out.family).toBe("0603");
  });

  it("exports the default taxonomy with the documented shape", () => {
    expect(DEFAULT_TAXONOMY.version).toBe(1);
    expect(Array.isArray(DEFAULT_TAXONOMY.chipImperial)).toBe(true);
    expect(DEFAULT_TAXONOMY.chipImperial).toContain("0603");
    expect(DEFAULT_TAXONOMY.metricToImperial["1608"]).toBe("0603");
    expect(DEFAULT_TAXONOMY.families["SOT-23"]).toBeDefined();
    expect(DEFAULT_TAXONOMY.families["SOIC"]).toBeDefined();
    expect(DEFAULT_TAXONOMY.families["QFN"]).toBeDefined();
    // Per UQ-4, families OUTSIDE SMD-chip / SOT / SOIC / QFN are excluded.
    expect(DEFAULT_TAXONOMY.families["SOP"]).toBeUndefined();
    expect(DEFAULT_TAXONOMY.families["BGA"]).toBeUndefined();
    expect(DEFAULT_TAXONOMY.families["DPAK"]).toBeUndefined();
  });
});
