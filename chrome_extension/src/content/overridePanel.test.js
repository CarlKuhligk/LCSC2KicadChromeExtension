import { describe, it, expect, beforeEach } from "vitest";
import {
  buildOverridePanel,
  buildRegisterPrompt,
  renderOverridePanel,
  selectionToOverrides,
  OVERRIDE_PANEL_ATTR,
  OVERRIDE_PANEL_MODE_ATTR,
  OVERRIDE_SYMBOL_SELECT_ATTR,
  OVERRIDE_FOOTPRINT_SELECT_ATTR,
  OVERRIDE_CONFIRM_ATTR,
  OVERRIDE_CANCEL_ATTR,
  OVERRIDE_EASYEDA_ONLY_ATTR,
  OVERRIDE_REGISTER_ATTR,
  EASYEDA_OPTION_VALUE,
} from "./overridePanel.js";
import { buildAnchorCardRow, ANCHOR_ROW_ATTR } from "./anchorCard.js";

/**
 * Issue #5 — Override Panel covers Symbol/Footprint source selection
 * inline beneath the Anchor Card. No rules, no pin-map, no datasheet
 * preview — those land with #8 / #9 / #11.
 */

function mountAnchorRow() {
  const row = buildAnchorCardRow(document, { colSpan: 1 });
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  tbody.appendChild(row);
  table.appendChild(tbody);
  document.body.appendChild(table);
  return row;
}

const EMPTY_LIBS = {};

const ONE_LIB = {
  "/home/user/templates/MyTemplates.kicad_sym": ["R0603", "C0805"],
};

const TWO_LIBS = {
  "/home/user/templates/MyTemplates.kicad_sym": ["R0603", "C0805"],
  "/home/user/templates/Other.kicad_sym": ["LED_RED"],
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("buildOverridePanel", () => {
  it("renders a Symbol select and a Footprint select", () => {
    const panel = buildOverridePanel(document, { templateLibs: EMPTY_LIBS });
    expect(panel.getAttribute(OVERRIDE_PANEL_ATTR)).toBe("true");
    expect(panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`)).toBeTruthy();
  });

  it("with no template libraries, both selects only offer EasyEDA", () => {
    const panel = buildOverridePanel(document, { templateLibs: EMPTY_LIBS });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    const symValues = Array.from(sym.querySelectorAll("option")).map((o) => o.value);
    const fpValues = Array.from(fp.querySelectorAll("option")).map((o) => o.value);
    expect(symValues).toEqual([EASYEDA_OPTION_VALUE]);
    expect(fpValues).toEqual([EASYEDA_OPTION_VALUE]);
  });

  it("populates template options from the supplied templateSymbolsByLib map", () => {
    const panel = buildOverridePanel(document, { templateLibs: ONE_LIB });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    const values = Array.from(sym.querySelectorAll("option")).map((o) => o.value);
    expect(values[0]).toBe(EASYEDA_OPTION_VALUE);
    expect(values).toContain(
      `template:/home/user/templates/MyTemplates.kicad_sym:R0603`,
    );
    expect(values).toContain(
      `template:/home/user/templates/MyTemplates.kicad_sym:C0805`,
    );
  });

  it("renders template options grouped by library so the user can tell sources apart", () => {
    const panel = buildOverridePanel(document, { templateLibs: TWO_LIBS });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    const groups = Array.from(sym.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toContain("MyTemplates");
    expect(groups).toContain("Other");
  });

  it("defaults both selects to EasyEDA", () => {
    const panel = buildOverridePanel(document, { templateLibs: ONE_LIB });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    expect(sym.value).toBe(EASYEDA_OPTION_VALUE);
    expect(fp.value).toBe(EASYEDA_OPTION_VALUE);
  });

  it("has a Confirm and a Cancel button", () => {
    const panel = buildOverridePanel(document, { templateLibs: EMPTY_LIBS });
    expect(panel.querySelector(`[${OVERRIDE_CONFIRM_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_CANCEL_ATTR}]`)).toBeTruthy();
  });
});

describe("selectionToOverrides", () => {
  it("returns easyeda for both layers when nothing was picked", () => {
    expect(
      selectionToOverrides({
        symbolValue: EASYEDA_OPTION_VALUE,
        footprintValue: EASYEDA_OPTION_VALUE,
      }),
    ).toEqual({
      symbol: { source: "easyeda" },
      footprint: { source: "easyeda" },
    });
  });

  it("parses a template option back into libPath + name", () => {
    const out = selectionToOverrides({
      symbolValue: "template:/home/user/templates/MyTemplates.kicad_sym:R0603",
      footprintValue: EASYEDA_OPTION_VALUE,
    });
    expect(out.symbol).toEqual({
      source: "template",
      libPath: "/home/user/templates/MyTemplates.kicad_sym",
      name: "R0603",
    });
    expect(out.footprint).toEqual({ source: "easyeda" });
  });

  it("anchors the libPath/name split on the ``.kicad_sym`` suffix, so a Windows drive letter or a name containing ':' round-trips", () => {
    const out = selectionToOverrides({
      symbolValue: "template:C:\\Users\\me\\Templates.kicad_sym:Op_Amp:Variant",
      footprintValue: EASYEDA_OPTION_VALUE,
    });
    expect(out.symbol).toEqual({
      source: "template",
      libPath: "C:\\Users\\me\\Templates.kicad_sym",
      name: "Op_Amp:Variant",
    });
  });
});

describe("renderOverridePanel", () => {
  it("inserts a panel row in the anchor table and returns it", () => {
    const row = mountAnchorRow();
    const out = renderOverridePanel(row, {
      templateLibs: EMPTY_LIBS,
      onConfirm: () => {},
      onCancel: () => {},
    });
    expect(out).toBeTruthy();
    // Sibling-of-anchor inside the same tbody so the panel reads as a
    // continuation of the Anchor Card.
    expect(row.parentNode.contains(out)).toBe(true);
  });

  it("is idempotent — a second call reuses the existing panel", () => {
    const row = mountAnchorRow();
    const first = renderOverridePanel(row, { templateLibs: EMPTY_LIBS });
    const second = renderOverridePanel(row, { templateLibs: EMPTY_LIBS });
    expect(second).toBe(first);
    expect(
      row.parentNode.querySelectorAll(`[${OVERRIDE_PANEL_ATTR}="true"]`).length,
    ).toBe(1);
  });

  it("Confirm click invokes onConfirm with the parsed overrides", () => {
    const row = mountAnchorRow();
    const calls = [];
    const panel = renderOverridePanel(row, {
      templateLibs: ONE_LIB,
      onConfirm: (overrides) => calls.push(overrides),
    });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    sym.value = "template:/home/user/templates/MyTemplates.kicad_sym:R0603";
    panel.querySelector(`[${OVERRIDE_CONFIRM_ATTR}]`).click();
    expect(calls).toHaveLength(1);
    expect(calls[0].symbol).toEqual({
      source: "template",
      libPath: "/home/user/templates/MyTemplates.kicad_sym",
      name: "R0603",
    });
    expect(calls[0].footprint).toEqual({ source: "easyeda" });
  });

  it("Cancel click invokes onCancel and removes the panel", () => {
    const row = mountAnchorRow();
    const cancelled = [];
    const panel = renderOverridePanel(row, {
      templateLibs: EMPTY_LIBS,
      onCancel: () => cancelled.push(true),
    });
    panel.querySelector(`[${OVERRIDE_CANCEL_ATTR}]`).click();
    expect(cancelled).toEqual([true]);
    expect(row.parentNode.querySelector(`[${OVERRIDE_PANEL_ATTR}="true"]`)).toBeNull();
  });

  it("Confirm click removes the panel after firing the callback", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      templateLibs: EMPTY_LIBS,
      onConfirm: () => {},
    });
    panel.querySelector(`[${OVERRIDE_CONFIRM_ATTR}]`).click();
    expect(row.parentNode.querySelector(`[${OVERRIDE_PANEL_ATTR}="true"]`)).toBeNull();
  });

  it("returns null when the anchor row is detached from the DOM", () => {
    const row = buildAnchorCardRow(document, { colSpan: 1 });
    // No parent — caller can't insert a sibling panel.
    expect(renderOverridePanel(row, { templateLibs: EMPTY_LIBS })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  Issue #25 — ⚪ white state Register-Prompt (ADR-0006)                    */
/* -------------------------------------------------------------------------- */

describe("buildRegisterPrompt (white state)", () => {
  it("renders a Register-Prompt panel with mode=white", () => {
    const panel = buildRegisterPrompt(document, {});
    expect(panel.getAttribute(OVERRIDE_PANEL_ATTR)).toBe("true");
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("white");
  });

  it("shows the 'Neues Bauteil — nur EasyEDA ODER registrieren?' message", () => {
    const panel = buildRegisterPrompt(document, {});
    expect(panel.textContent).toContain("Neues Bauteil");
    expect(panel.textContent).toContain("nur EasyEDA");
    expect(panel.textContent).toContain("registrieren");
  });

  it("renders a 'nur EasyEDA' button and a 'registrieren' button", () => {
    const panel = buildRegisterPrompt(document, {});
    expect(panel.querySelector(`[${OVERRIDE_EASYEDA_ONLY_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_ATTR}]`)).toBeTruthy();
  });

  it("does NOT render the Symbol/Footprint selects in the white state", () => {
    const panel = buildRegisterPrompt(document, {});
    expect(panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`)).toBeNull();
    expect(panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`)).toBeNull();
  });
});

describe("renderOverridePanel — white state", () => {
  it("renders the Register-Prompt when match.state === 'white'", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      match: { state: "white" },
      templateLibs: EMPTY_LIBS,
    });
    expect(panel).toBeTruthy();
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("white");
    expect(panel.querySelector(`[${OVERRIDE_EASYEDA_ONLY_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_ATTR}]`)).toBeTruthy();
  });

  it("still renders the sources panel when no match is supplied (back-compat)", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, { templateLibs: EMPTY_LIBS });
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("sources");
    expect(panel.querySelector(`[${OVERRIDE_EASYEDA_ONLY_ATTR}]`)).toBeNull();
  });

  it("'nur EasyEDA' click fires onEasyedaOnly and removes the panel", () => {
    const row = mountAnchorRow();
    const fired = [];
    const panel = renderOverridePanel(row, {
      match: { state: "white" },
      onEasyedaOnly: () => fired.push("easyeda"),
    });
    panel.querySelector(`[${OVERRIDE_EASYEDA_ONLY_ATTR}]`).click();
    expect(fired).toEqual(["easyeda"]);
    expect(row.parentNode.querySelector(`[${OVERRIDE_PANEL_ATTR}="true"]`)).toBeNull();
  });

  it("'nur EasyEDA' falls back to onConfirm({easyeda,easyeda}) when no onEasyedaOnly is provided — no regression", () => {
    const row = mountAnchorRow();
    const fired = [];
    const panel = renderOverridePanel(row, {
      match: { state: "white" },
      onConfirm: (overrides) => fired.push(overrides),
    });
    panel.querySelector(`[${OVERRIDE_EASYEDA_ONLY_ATTR}]`).click();
    expect(fired).toHaveLength(1);
    // The existing EasyEDA Phase 2 path runs with both Layers set to EasyEDA.
    expect(fired[0]).toEqual({
      symbol: { source: "easyeda" },
      footprint: { source: "easyeda" },
    });
  });

  it("'registrieren' click fires onRegister and removes the panel", () => {
    const row = mountAnchorRow();
    const fired = [];
    const panel = renderOverridePanel(row, {
      match: { state: "white" },
      onRegister: () => fired.push("register"),
    });
    panel.querySelector(`[${OVERRIDE_REGISTER_ATTR}]`).click();
    expect(fired).toEqual(["register"]);
    expect(row.parentNode.querySelector(`[${OVERRIDE_PANEL_ATTR}="true"]`)).toBeNull();
  });

  it("is idempotent in the white state too — a second render returns the existing prompt", () => {
    const row = mountAnchorRow();
    const first = renderOverridePanel(row, { match: { state: "white" } });
    const second = renderOverridePanel(row, { match: { state: "white" } });
    expect(second).toBe(first);
    expect(
      row.parentNode.querySelectorAll(`[${OVERRIDE_PANEL_ATTR}="true"]`).length,
    ).toBe(1);
  });
});
