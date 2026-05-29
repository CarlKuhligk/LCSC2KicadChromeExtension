import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getDefaultValueParamKey,
  needsValueParamFromPage,
  isConfiguredValueParamPresentOnPage,
  promiseValueParamFallback,
  promiseValueParamMismatch,
  removeValueParamFallbackDialog,
  removeValueParamMismatchDialog,
} from "./lcscValueParamDialogs.js";
import {
  VALUE_PARAM_FALLBACK_DIALOG_ID,
  VALUE_PARAM_MISMATCH_DIALOG_ID,
} from "./constants.js";

function clickButtonByText(modalId, text) {
  const modal = document.getElementById(modalId);
  if (!modal) throw new Error(`modal ${modalId} not mounted`);
  const btn = [...modal.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === text,
  );
  if (!btn) throw new Error(`button "${text}" not found in ${modalId}`);
  btn.click();
}

describe("getDefaultValueParamKey", () => {
  it("returns empty string for empty/missing input", () => {
    expect(getDefaultValueParamKey([])).toBe("");
    expect(getDefaultValueParamKey(undefined)).toBe("");
    expect(getDefaultValueParamKey(null)).toBe("");
  });

  it("returns the first preferred match (case-insensitive)", () => {
    expect(getDefaultValueParamKey(["foo", "MPN", "bar"])).toBe("MPN");
    expect(getDefaultValueParamKey(["foo", "mpn", "bar"])).toBe("mpn");
    expect(getDefaultValueParamKey(["x", "Manufacturer Part Number"])).toBe(
      "Manufacturer Part Number",
    );
  });

  it("falls back to the first key when no preferred name matches", () => {
    expect(getDefaultValueParamKey(["Foo", "Bar"])).toBe("Foo");
  });
});

describe("needsValueParamFromPage", () => {
  it("true when params and valueParamOptions are both empty", () => {
    expect(needsValueParamFromPage({})).toBe(true);
    expect(needsValueParamFromPage({ params: {}, valueParamOptions: [] })).toBe(true);
    expect(needsValueParamFromPage({ params: { foo: "" }, valueParamOptions: [] })).toBe(true);
  });

  it("false when any param value is non-empty", () => {
    expect(needsValueParamFromPage({ params: { foo: "bar" } })).toBe(false);
  });

  it("false when valueParamOptions has entries even if params empty", () => {
    expect(
      needsValueParamFromPage({ params: {}, valueParamOptions: ["MPN"] }),
    ).toBe(false);
  });
});

describe("isConfiguredValueParamPresentOnPage", () => {
  it("true when the configured key has a non-empty value", () => {
    expect(
      isConfiguredValueParamPresentOnPage({ params: { MPN: "C123" } }, "MPN"),
    ).toBe(true);
  });

  it("false when the configured key is missing or empty", () => {
    expect(
      isConfiguredValueParamPresentOnPage({ params: { MPN: "" } }, "MPN"),
    ).toBe(false);
    expect(
      isConfiguredValueParamPresentOnPage({ params: {} }, "MPN"),
    ).toBe(false);
  });

  it("true when no key is configured (degenerate)", () => {
    expect(isConfiguredValueParamPresentOnPage({ params: {} }, "")).toBe(true);
    expect(isConfiguredValueParamPresentOnPage({ params: {} }, "   ")).toBe(true);
  });
});

describe("promiseValueParamFallback", () => {
  afterEach(() => {
    removeValueParamFallbackDialog();
    document.body.innerHTML = "";
  });

  it("resolves with mode: 'default' when 'Use EasyEDA default' is clicked", async () => {
    const p = promiseValueParamFallback();
    clickButtonByText(VALUE_PARAM_FALLBACK_DIALOG_ID, "Use EasyEDA default");
    await expect(p).resolves.toEqual({ mode: "default" });
  });

  it("resolves with mode: 'configure' when the configure button is clicked", async () => {
    const p = promiseValueParamFallback();
    clickButtonByText(VALUE_PARAM_FALLBACK_DIALOG_ID, "Configure value source…");
    await expect(p).resolves.toEqual({ mode: "configure" });
  });

  it("resolves with mode: 'cancel' when Cancel is clicked", async () => {
    const p = promiseValueParamFallback();
    clickButtonByText(VALUE_PARAM_FALLBACK_DIALOG_ID, "Cancel");
    await expect(p).resolves.toEqual({ mode: "cancel" });
  });

  it("subsequent show() replaces the prior modal", () => {
    promiseValueParamFallback();
    const first = document.getElementById(VALUE_PARAM_FALLBACK_DIALOG_ID);
    promiseValueParamFallback();
    const second = document.getElementById(VALUE_PARAM_FALLBACK_DIALOG_ID);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
});

describe("promiseValueParamMismatch", () => {
  afterEach(() => {
    removeValueParamMismatchDialog();
    document.body.innerHTML = "";
  });

  it("displays the configured key prominently", () => {
    promiseValueParamMismatch("Mfr. Part #");
    const modal = document.getElementById(VALUE_PARAM_MISMATCH_DIALOG_ID);
    expect(modal.textContent).toContain("Mfr. Part #");
  });

  it("falls back to '(empty)' when no key is provided", () => {
    promiseValueParamMismatch("");
    const modal = document.getElementById(VALUE_PARAM_MISMATCH_DIALOG_ID);
    expect(modal.textContent).toContain("(empty)");
  });

  it("resolves with each of default/configure/cancel", async () => {
    const a = promiseValueParamMismatch("MPN");
    clickButtonByText(VALUE_PARAM_MISMATCH_DIALOG_ID, "Use EasyEDA default");
    await expect(a).resolves.toEqual({ mode: "default" });

    const b = promiseValueParamMismatch("MPN");
    clickButtonByText(VALUE_PARAM_MISMATCH_DIALOG_ID, "Change value parameter…");
    await expect(b).resolves.toEqual({ mode: "configure" });

    const c = promiseValueParamMismatch("MPN");
    clickButtonByText(VALUE_PARAM_MISMATCH_DIALOG_ID, "Cancel");
    await expect(c).resolves.toEqual({ mode: "cancel" });
  });
});
