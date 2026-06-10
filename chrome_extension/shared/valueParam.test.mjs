import { describe, it, expect } from "vitest";
import { detectValueParam, PREFERRED_VALUE_PARAMS } from "./valueParam.mjs";

describe("detectValueParam", () => {
  it("picks Resistance for a resistor", () => {
    expect(detectValueParam({ Resistance: "10k", Tolerance: "1%" })).toBe("Resistance");
  });

  it("picks Capacitance for a capacitor", () => {
    expect(detectValueParam({ Capacitance: "100nF", Voltage: "50V" })).toBe("Capacitance");
  });

  it("follows priority order (Resistance before Voltage)", () => {
    expect(detectValueParam({ Voltage: "50V", Resistance: "1k" })).toBe("Resistance");
  });

  it("is case-insensitive on the key and returns the verbatim key", () => {
    expect(detectValueParam({ resistance: "1k" })).toBe("resistance");
  });

  it("returns null when no preferred param is present", () => {
    expect(detectValueParam({ "Mfr. Part #": "X", Tolerance: "1%" })).toBeNull();
  });

  it("ignores blank values", () => {
    expect(detectValueParam({ Resistance: "  " })).toBeNull();
  });

  it("returns null for empty / non-object input", () => {
    expect(detectValueParam(null)).toBeNull();
    expect(detectValueParam({})).toBeNull();
    expect(detectValueParam("nope")).toBeNull();
  });

  it("exposes a non-empty priority list", () => {
    expect(PREFERRED_VALUE_PARAMS).toContain("Resistance");
    expect(PREFERRED_VALUE_PARAMS.length).toBeGreaterThan(0);
  });
});
