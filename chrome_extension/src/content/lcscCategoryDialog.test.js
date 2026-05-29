import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  showCategoryDialog,
  removeCategoryDialog,
} from "./lcscCategoryDialog.js";
import { CATEGORY_DIALOG_ID } from "./constants.js";

function modal() {
  return document.getElementById(CATEGORY_DIALOG_ID);
}

function clickButtonByText(text) {
  const m = modal();
  if (!m) throw new Error(`category modal not mounted`);
  const btn = [...m.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === text,
  );
  if (!btn) throw new Error(`button "${text}" not found`);
  btn.click();
}

function noopActions() {
  return {
    onSaveAndContinue: vi.fn(),
    onContinueOnly: vi.fn(),
    onSkip: vi.fn(),
    onCancel: vi.fn(),
  };
}

describe("showCategoryDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    removeCategoryDialog();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("mounts an overlay with id = CATEGORY_DIALOG_ID", () => {
    showCategoryDialog("Passives/Resistors/SMD", [], noopActions());
    expect(modal()).toBeTruthy();
    expect(modal().tagName).toBe("DIV");
  });

  it("renders one breadcrumb button per path segment", () => {
    showCategoryDialog("Passives/Resistors/SMD", [], noopActions());
    const breadcrumb = modal().querySelector('[aria-label="Category path"]');
    const segmentButtons = breadcrumb.querySelectorAll("button");
    expect(segmentButtons).toHaveLength(3);
    expect([...segmentButtons].map((b) => b.textContent)).toEqual([
      "Passives",
      "Resistors",
      "SMD",
    ]);
  });

  it("clicking a non-leaf segment trims the saved path", () => {
    const actions = noopActions();
    showCategoryDialog("Passives/Resistors/SMD", [], actions);
    const breadcrumb = modal().querySelector('[aria-label="Category path"]');
    const segmentButtons = breadcrumb.querySelectorAll("button");
    // Click segment "Resistors" (index 1) — should trim path to "Passives/Resistors".
    segmentButtons[1].click();
    clickButtonByText("Continue");
    expect(actions.onContinueOnly).toHaveBeenCalledWith(
      expect.objectContaining({ category: "Passives/Resistors" }),
    );
  });

  it("renders a <select> when paramKeys are supplied", () => {
    showCategoryDialog("Passives/Resistors", ["MPN", "Tolerance"], noopActions());
    const sel = document.getElementById("easyeda2kicad-value-param-select");
    expect(sel).toBeTruthy();
    expect(sel.tagName).toBe("SELECT");
    const optionTexts = [...sel.options].map((o) => o.textContent);
    expect(optionTexts).toContain("MPN");
    expect(optionTexts).toContain("Tolerance");
    expect(optionTexts).toContain("Other (type manually)…");
  });

  it("renders a free-text <input> when paramKeys is empty", () => {
    showCategoryDialog("Passives", [], noopActions());
    expect(document.getElementById("easyeda2kicad-value-param")).toBeTruthy();
    expect(document.getElementById("easyeda2kicad-value-param-select")).toBeFalsy();
  });

  it("preselects the default value-param when present in paramKeys", () => {
    showCategoryDialog(
      "Passives/Resistors",
      ["Tolerance", "MPN", "Foo"],
      noopActions(),
    );
    const sel = document.getElementById("easyeda2kicad-value-param-select");
    // "MPN" is in PREFERRED_VALUE_PARAM_KEYS so it should be picked.
    expect(sel.value).toBe("MPN");
  });

  it("'Save & continue' calls onSaveAndContinue with the form payload", async () => {
    const actions = noopActions();
    showCategoryDialog("Passives/Resistors", ["MPN"], actions);
    document.getElementById("easyeda2kicad-hide-num").checked = true;
    clickButtonByText("Save & continue");
    expect(actions.onSaveAndContinue).toHaveBeenCalledWith({
      category: "Passives/Resistors",
      hidePinNumbers: true,
      hidePinNames: false,
      valueParam: "MPN",
    });
  });

  it("'Continue' calls onContinueOnly and dismisses", () => {
    const actions = noopActions();
    showCategoryDialog("Passives", ["MPN"], actions);
    clickButtonByText("Continue");
    expect(actions.onContinueOnly).toHaveBeenCalledTimes(1);
    expect(modal()).toBeFalsy();
  });

  it("'Skip' calls onSkip and dismisses", () => {
    const actions = noopActions();
    showCategoryDialog("Passives", [], actions);
    clickButtonByText("Skip");
    expect(actions.onSkip).toHaveBeenCalledTimes(1);
    expect(modal()).toBeFalsy();
  });

  it("'Cancel' calls onCancel and dismisses", () => {
    const actions = noopActions();
    showCategoryDialog("Passives", [], actions);
    clickButtonByText("Cancel");
    expect(actions.onCancel).toHaveBeenCalledTimes(1);
    expect(modal()).toBeFalsy();
  });

  it("backdrop mousedown calls onCancel", () => {
    const actions = noopActions();
    showCategoryDialog("Passives", [], actions);
    const overlay = modal();
    const event = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(event, "target", { value: overlay });
    overlay.dispatchEvent(event);
    expect(actions.onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape key calls onCancel", () => {
    const actions = noopActions();
    showCategoryDialog("Passives", [], actions);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(actions.onCancel).toHaveBeenCalledTimes(1);
    expect(modal()).toBeFalsy();
  });

  it("'Other (type manually)' reveals the custom text input", () => {
    showCategoryDialog("Passives", ["Tolerance", "Foo"], noopActions());
    const sel = document.getElementById("easyeda2kicad-value-param-select");
    const custom = document.getElementById("easyeda2kicad-value-param-custom");
    expect(custom.style.display).toBe("none");
    sel.value = "__custom__";
    sel.dispatchEvent(new Event("change"));
    expect(custom.style.display).toBe("block");
  });

  it("custom value-param flows into the saved payload", () => {
    const actions = noopActions();
    showCategoryDialog("Passives", ["Tolerance"], actions);
    const sel = document.getElementById("easyeda2kicad-value-param-select");
    const custom = document.getElementById("easyeda2kicad-value-param-custom");
    sel.value = "__custom__";
    sel.dispatchEvent(new Event("change"));
    custom.value = "Mfr. Part #";
    clickButtonByText("Continue");
    expect(actions.onContinueOnly).toHaveBeenCalledWith(
      expect.objectContaining({ valueParam: "Mfr. Part #" }),
    );
  });

  it("removeCategoryDialog is idempotent", () => {
    showCategoryDialog("Passives", [], noopActions());
    expect(modal()).toBeTruthy();
    removeCategoryDialog();
    expect(modal()).toBeFalsy();
    expect(() => removeCategoryDialog()).not.toThrow();
  });

  it("a second show() replaces the prior modal", () => {
    showCategoryDialog("Passives", [], noopActions());
    const first = modal();
    showCategoryDialog("Capacitors", [], noopActions());
    const second = modal();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
});
