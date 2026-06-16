import { describe, it, expect, beforeEach } from "vitest";
import {
  buildOverridePanel,
  buildRegisterPrompt,
  buildRegisterImportEditor,
  buildOneClickPanel,
  renderOverridePanel,
  renderRegisterImportEditor,
  collectRegisterEditorRule,
  selectionToOverrides,
  OVERRIDE_PANEL_ATTR,
  OVERRIDE_PANEL_MODE_ATTR,
  OVERRIDE_PANEL_ROW_ATTR,
  OVERRIDE_SYMBOL_SELECT_ATTR,
  OVERRIDE_FOOTPRINT_SELECT_ATTR,
  OVERRIDE_CONFIRM_ATTR,
  OVERRIDE_CANCEL_ATTR,
  OVERRIDE_EASYEDA_ONLY_ATTR,
  OVERRIDE_REGISTER_ATTR,
  OVERRIDE_REGISTER_EDITOR_ATTR,
  OVERRIDE_REGISTER_SAVE_ATTR,
  OVERRIDE_REGISTER_CANCEL_ATTR,
  OVERRIDE_REGISTER_MAPPING_ROW_ATTR,
  OVERRIDE_REGISTER_MAPPING_LCSC_ATTR,
  OVERRIDE_REGISTER_MAPPING_KICAD_ATTR,
  OVERRIDE_REGISTER_MAPPING_ADD_ATTR,
  OVERRIDE_REGISTER_PROP_PREVIEW_ATTR,
  OVERRIDE_REGISTER_TEMPLATE_LIST_ATTR,
  OVERRIDE_REGISTER_TEMPLATE_ITEM_ATTR,
  OVERRIDE_REGISTER_SYMBOL_PREVIEW_ATTR,
  OVERRIDE_REGISTER_FOOTPRINT_PREVIEW_ATTR,
  OVERRIDE_REGISTER_SHOWALL_ATTR,
  OVERRIDE_REGISTER_HIDE_PINNUM_ATTR,
  OVERRIDE_REGISTER_HIDE_PINNAME_ATTR,
  OVERRIDE_REGISTER_VALUE_PARAM_ATTR,
  OVERRIDE_IMPORT_ATTR,
  OVERRIDE_MODIFY_ATTR,
  OVERRIDE_ONECLICK_PREVIEW_ATTR,
  OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR,
  OVERRIDE_YELLOW_OPEN_EDITOR_ATTR,
  OVERRIDE_YELLOW_HINT_ATTR,
  buildYellowPanel,
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

  it("a second white render replaces the prompt modal (one overlay at a time)", () => {
    const row = mountAnchorRow();
    renderOverridePanel(row, { match: { state: "white" } });
    renderOverridePanel(row, { match: { state: "white" } });
    // ⚪ is a modal now; mountCsModal keeps a single prompt overlay by id, so a
    // re-render replaces rather than stacking.
    expect(
      document.querySelectorAll(`[${OVERRIDE_PANEL_ATTR}="true"]`).length,
    ).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Issue #28 — Register Import-Editor (ADR-0006)                            */
/* -------------------------------------------------------------------------- */

const PAGE_PARAMS = {
  Resistance: "10k",
  Tolerance: "1%",
  "Power(Watts)": "0.25W",
  "Mfr. Part #": "RC0603FR-0710KL",
};

describe("buildRegisterImportEditor", () => {
  it("renders a panel with mode=registerEditor", () => {
    const panel = buildRegisterImportEditor(document, {});
    expect(panel.getAttribute(OVERRIDE_PANEL_ATTR)).toBe("true");
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("registerEditor");
    expect(panel.getAttribute(OVERRIDE_REGISTER_EDITOR_ATTR)).toBe("true");
  });

  it("renders a Symbol-source dropdown with EasyEDA + Template-Optgroups", () => {
    const panel = buildRegisterImportEditor(document, { templateLibs: ONE_LIB });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    expect(sym).toBeTruthy();
    const groups = Array.from(sym.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toContain("MyTemplates");
    const values = Array.from(sym.querySelectorAll("option")).map((o) => o.value);
    expect(values[0]).toBe(EASYEDA_OPTION_VALUE);
    expect(values).toContain(
      "template:/home/user/templates/MyTemplates.kicad_sym:R0603",
    );
  });

  it("does NOT render a Footprint dropdown in the Symbol-MVP", () => {
    const panel = buildRegisterImportEditor(document, { templateLibs: ONE_LIB });
    expect(panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`)).toBeNull();
  });

  it("renders a read-only property preview from the snapshot (no manual mapper)", () => {
    // ADR-0006 (refined): no manual label-mapping UI; all scraped params are
    // shown as the Properties that will be auto-upserted into the symbol.
    const panel = buildRegisterImportEditor(document, { pageParams: PAGE_PARAMS });
    expect(
      panel.querySelector(`[${OVERRIDE_REGISTER_MAPPING_ROW_ATTR}="true"]`),
    ).toBeNull();
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_MAPPING_ADD_ATTR}]`)).toBeNull();
    const preview = panel.querySelector(`[${OVERRIDE_REGISTER_PROP_PREVIEW_ATTR}]`);
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain("Resistance");
    expect(preview.textContent).toContain("Tolerance");
    expect(preview.textContent).toContain("Power(Watts)");
  });

  it("shows a 'no metadata' note when the snapshot has no params", () => {
    const panel = buildRegisterImportEditor(document, { pageParams: {} });
    expect(
      panel.querySelector(`[${OVERRIDE_REGISTER_PROP_PREVIEW_ATTR}]`),
    ).toBeNull();
    expect(panel.textContent).toContain("Keine Metadaten");
  });

  it("shows the category path in the heading area", () => {
    const panel = buildRegisterImportEditor(document, {
      categoryPath: "Passives/Resistors/SMD",
    });
    expect(panel.textContent).toContain("Passives/Resistors/SMD");
  });

  it("has Übernehmen and Abbrechen buttons", () => {
    const panel = buildRegisterImportEditor(document, {});
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_SAVE_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_CANCEL_ATTR}]`)).toBeTruthy();
  });

  const LIB_PATH = "/home/user/templates/MyTemplates.kicad_sym";
  const ONE_LIB_CATS = { [LIB_PATH]: { R0603: "Resistors" } };

  it("shows only category-matched templates in the list by default", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateCategoriesByLib: ONE_LIB_CATS,
      categoryPath: "Resistors/Chip Resistor - Surface Mount",
    });
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_TEMPLATE_LIST_ATTR}]`)).toBeTruthy();
    const values = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_TEMPLATE_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    expect(values).toContain(EASYEDA_OPTION_VALUE);
    expect(values).toContain(`template:${LIB_PATH}:R0603`);
    // C0805 has no matching category → hidden until "show all".
    expect(values).not.toContain(`template:${LIB_PATH}:C0805`);
  });

  it("preselects the unique category match (drives the hidden select)", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateCategoriesByLib: ONE_LIB_CATS,
      categoryPath: "Resistors/Chip Resistor",
    });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    expect(sym.value).toBe(`template:${LIB_PATH}:R0603`);
  });

  it("'alle Templates anzeigen' reveals every template", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateCategoriesByLib: ONE_LIB_CATS,
      categoryPath: "Resistors/Chip Resistor",
    });
    const cb = panel.querySelector(`[${OVERRIDE_REGISTER_SHOWALL_ATTR}]`);
    cb.checked = true;
    cb.dispatchEvent(new Event("change"));
    const values = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_TEMPLATE_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    expect(values).toContain(`template:${LIB_PATH}:C0805`);
  });

  it("clicking a list item drives the hidden select", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateCategoriesByLib: {},
    });
    const cb = panel.querySelector(`[${OVERRIDE_REGISTER_SHOWALL_ATTR}]`);
    cb.checked = true;
    cb.dispatchEvent(new Event("change"));
    const item = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_TEMPLATE_ITEM_ATTR}]`),
    ).find((i) => i.dataset.value === `template:${LIB_PATH}:C0805`);
    item.click();
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    expect(sym.value).toBe(`template:${LIB_PATH}:C0805`);
  });

  it("renders pin-visibility checkboxes (default unchecked)", () => {
    const panel = buildRegisterImportEditor(document, {});
    const num = panel.querySelector(`[${OVERRIDE_REGISTER_HIDE_PINNUM_ATTR}]`);
    const name = panel.querySelector(`[${OVERRIDE_REGISTER_HIDE_PINNAME_ATTR}]`);
    expect(num).toBeTruthy();
    expect(name).toBeTruthy();
    expect(num.checked).toBe(false);
    expect(name.checked).toBe(false);
  });

  it("prefills pin-visibility checkboxes from opts (≤2-pin auto-heuristic)", () => {
    const panel = buildRegisterImportEditor(document, {
      initialHidePinNumbers: true,
      initialHidePinNames: false,
    });
    expect(
      panel.querySelector(`[${OVERRIDE_REGISTER_HIDE_PINNUM_ATTR}]`).checked,
    ).toBe(true);
    expect(
      panel.querySelector(`[${OVERRIDE_REGISTER_HIDE_PINNAME_ATTR}]`).checked,
    ).toBe(false);
  });

  it("collectRegisterEditorRule reads the pin-visibility checkboxes", () => {
    const panel = buildRegisterImportEditor(document, { initialHidePinNumbers: true });
    panel.querySelector(`[${OVERRIDE_REGISTER_HIDE_PINNAME_ATTR}]`).checked = true;
    const payload = collectRegisterEditorRule(panel, "Passives");
    expect(payload.rule.hidePinNumbers).toBe(true);
    expect(payload.rule.hidePinNames).toBe(true);
  });

  it("renders a Value-Param dropdown with 'Name — Wert' options", () => {
    const panel = buildRegisterImportEditor(document, { pageParams: PAGE_PARAMS });
    const sel = panel.querySelector(`[${OVERRIDE_REGISTER_VALUE_PARAM_ATTR}]`);
    expect(sel).toBeTruthy();
    const labels = Array.from(sel.options).map((o) => o.textContent);
    expect(labels.some((t) => t.includes("Resistance — 10k"))).toBe(true);
  });

  it("auto-selects the detected Value-Param (Resistance)", () => {
    const panel = buildRegisterImportEditor(document, { pageParams: PAGE_PARAMS });
    expect(
      panel.querySelector(`[${OVERRIDE_REGISTER_VALUE_PARAM_ATTR}]`).value,
    ).toBe("Resistance");
  });

  it("respects initialValueParam (Modify prefill)", () => {
    const panel = buildRegisterImportEditor(document, {
      pageParams: PAGE_PARAMS,
      initialValueParam: "Tolerance",
    });
    expect(
      panel.querySelector(`[${OVERRIDE_REGISTER_VALUE_PARAM_ATTR}]`).value,
    ).toBe("Tolerance");
  });

  it("collectRegisterEditorRule returns null valueParam for the 'none' option", () => {
    const panel = buildRegisterImportEditor(document, { pageParams: PAGE_PARAMS });
    panel.querySelector(`[${OVERRIDE_REGISTER_VALUE_PARAM_ATTR}]`).value = "";
    expect(collectRegisterEditorRule(panel, "X").rule.valueParam).toBeNull();
  });
});

describe("collectRegisterEditorRule", () => {
  it("returns the chosen symbolSource + an empty labelMapping (metadata is auto)", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      pageParams: PAGE_PARAMS,
    });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    sym.value = "template:/home/user/templates/MyTemplates.kicad_sym:R0603";
    const payload = collectRegisterEditorRule(panel, "Passives/Resistors");
    expect(payload).toEqual({
      categoryPath: "Passives/Resistors",
      rule: {
        symbolSource: {
          source: "template",
          libPath: "/home/user/templates/MyTemplates.kicad_sym",
          name: "R0603",
        },
        // ADR-0006 (refined): no manual mapping — all params auto-upserted.
        labelMapping: {},
        hidePinNumbers: false,
        hidePinNames: false,
        // Value dropdown auto-selects "Resistance" from PAGE_PARAMS.
        valueParam: "Resistance",
      },
    });
  });

  it("defaults to symbolSource={source:'easyeda'} when the user did not change the dropdown", () => {
    const panel = buildRegisterImportEditor(document, { templateLibs: ONE_LIB });
    const payload = collectRegisterEditorRule(panel, "Passives");
    expect(payload.rule.symbolSource).toEqual({ source: "easyeda" });
  });
});

describe("renderRegisterImportEditor", () => {
  it("mounts the editor as a modal overlay on document.body and returns it", () => {
    const row = mountAnchorRow();
    const editor = renderRegisterImportEditor(row, {
      templateLibs: EMPTY_LIBS,
      pageParams: PAGE_PARAMS,
      categoryPath: "Passives/Resistors",
    });
    expect(editor).toBeTruthy();
    expect(editor.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("registerEditor");
    // ADR-0006 (refined): the editor is a modal overlay on document.body, not
    // an inline row beneath the Anchor Card.
    expect(document.body.contains(editor)).toBe(true);
    expect(document.getElementById("k2c-register-editor-modal")).toBeTruthy();
  });

  it("a second render replaces the first modal (one editor overlay at a time)", () => {
    const row = mountAnchorRow();
    renderRegisterImportEditor(row, {});
    renderRegisterImportEditor(row, {});
    expect(
      document.querySelectorAll(
        `[${OVERRIDE_PANEL_MODE_ATTR}="registerEditor"]`,
      ).length,
    ).toBe(1);
  });

  it("Übernehmen fires onSave with the rule and dismisses the modal", () => {
    const row = mountAnchorRow();
    const calls = [];
    const editor = renderRegisterImportEditor(row, {
      templateLibs: ONE_LIB,
      pageParams: PAGE_PARAMS,
      categoryPath: "Passives/Resistors",
      onSave: (payload) => calls.push(payload),
    });
    const sym = editor.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    sym.value = "template:/home/user/templates/MyTemplates.kicad_sym:R0603";
    editor.querySelector(`[${OVERRIDE_REGISTER_SAVE_ATTR}]`).click();
    expect(calls).toEqual([
      {
        categoryPath: "Passives/Resistors",
        rule: {
          symbolSource: {
            source: "template",
            libPath: "/home/user/templates/MyTemplates.kicad_sym",
            name: "R0603",
          },
          labelMapping: {},
          hidePinNumbers: false,
          hidePinNames: false,
          valueParam: "Resistance",
        },
      },
    ]);
    // Modal overlay is gone after save.
    expect(document.getElementById("k2c-register-editor-modal")).toBeNull();
  });

  it("Abbrechen fires onCancel and dismisses the modal", () => {
    const row = mountAnchorRow();
    const cancelled = [];
    const editor = renderRegisterImportEditor(row, {
      onCancel: () => cancelled.push(true),
    });
    editor.querySelector(`[${OVERRIDE_REGISTER_CANCEL_ATTR}]`).click();
    expect(cancelled).toEqual([true]);
    expect(document.getElementById("k2c-register-editor-modal")).toBeNull();
  });

  it("save does not also fire onCancel (no double-settle)", () => {
    const row = mountAnchorRow();
    const calls = [];
    const editor = renderRegisterImportEditor(row, {
      onSave: () => calls.push("save"),
      onCancel: () => calls.push("cancel"),
    });
    editor.querySelector(`[${OVERRIDE_REGISTER_SAVE_ATTR}]`).click();
    expect(calls).toEqual(["save"]);
  });

  it("[Modifizieren] entry: prefills the Symbol dropdown with the matched rule's source", () => {
    const row = mountAnchorRow();
    const editor = renderRegisterImportEditor(row, {
      templateLibs: ONE_LIB,
      initialSymbolSource: {
        source: "template",
        libPath: "/home/user/templates/MyTemplates.kicad_sym",
        name: "R0603",
      },
    });
    const sym = editor.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    expect(sym.value).toBe(
      "template:/home/user/templates/MyTemplates.kicad_sym:R0603",
    );
  });

  it("falls back to EasyEDA on prefill when the supplied template lib was unregistered", () => {
    const row = mountAnchorRow();
    const editor = renderRegisterImportEditor(row, {
      templateLibs: EMPTY_LIBS,
      initialSymbolSource: {
        source: "template",
        libPath: "/dropped/Other.kicad_sym",
        name: "Foo",
      },
    });
    const sym = editor.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    expect(sym.value).toBe(EASYEDA_OPTION_VALUE);
  });
});

/* -------------------------------------------------------------------------- */
/*  Issue #29 — 🟢 green state One-Click panel (ADR-0006)                     */
/* -------------------------------------------------------------------------- */

const GREEN_RULE = {
  symbolSource: {
    source: "template",
    libPath: "/home/user/templates/MyTemplates.kicad_sym",
    name: "R0603",
  },
  labelMapping: { Resistance: "Value", Tolerance: "Tolerance" },
};

describe("buildOneClickPanel (green state)", () => {
  it("renders a panel with mode=green", () => {
    const panel = buildOneClickPanel(document, {
      ruleKey: "Passives/Resistors",
      symbolSource: GREEN_RULE.symbolSource,
      labelMapping: GREEN_RULE.labelMapping,
    });
    expect(panel.getAttribute(OVERRIDE_PANEL_ATTR)).toBe("true");
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("green");
  });

  it("renders an [Import] button AND a [Modifizieren] button", () => {
    const panel = buildOneClickPanel(document, {});
    expect(panel.querySelector(`[${OVERRIDE_IMPORT_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_MODIFY_ATTR}]`)).toBeTruthy();
  });

  it("renders a preview block (the resolved result is shown BEFORE the click — ADR-0006)", () => {
    const panel = buildOneClickPanel(document, {
      ruleKey: "Passives/Resistors",
      symbolSource: GREEN_RULE.symbolSource,
      labelMapping: GREEN_RULE.labelMapping,
    });
    const preview = panel.querySelector(`[${OVERRIDE_ONECLICK_PREVIEW_ATTR}]`);
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain("R0603");
    expect(preview.textContent).toContain("Resistance");
    expect(preview.textContent).toContain("Value");
  });

  it("does NOT render a Confirm button — the [Import] click IS the confirm (ADR-0006 §U3.3)", () => {
    const panel = buildOneClickPanel(document, {});
    expect(panel.querySelector(`[${OVERRIDE_CONFIRM_ATTR}]`)).toBeNull();
    expect(panel.querySelector(`[${OVERRIDE_CANCEL_ATTR}]`)).toBeNull();
  });

  it("shows the registered Category Path in the heading so the user can tell what was matched", () => {
    const panel = buildOneClickPanel(document, { ruleKey: "Passives/Resistors" });
    expect(panel.textContent).toContain("Passives/Resistors");
    expect(panel.textContent).toContain("Ein-Klick");
  });

  it("renders pin-visibility + value-param settings in the preview (transparency before one-click)", () => {
    const panel = buildOneClickPanel(document, {
      ruleKey: "Passives/Resistors",
      symbolSource: GREEN_RULE.symbolSource,
      hidePinNumbers: true,
      hidePinNames: true,
      valueParam: "Resistance",
    });
    const preview = panel.querySelector(`[${OVERRIDE_ONECLICK_PREVIEW_ATTR}]`);
    expect(preview.textContent).toContain("Pins:");
    expect(preview.textContent).toContain("Nummern + Namen ausgeblendet");
    expect(preview.textContent).toContain("Value:");
    expect(preview.textContent).toContain("Resistance");
  });

  it("shows only the pin line that applies (numbers hidden, names shown)", () => {
    const panel = buildOneClickPanel(document, { hidePinNumbers: true });
    const preview = panel.querySelector(`[${OVERRIDE_ONECLICK_PREVIEW_ATTR}]`);
    expect(preview.textContent).toContain("Nummern ausgeblendet");
    expect(preview.textContent).not.toContain("Namen");
  });

  it("omits pin/value lines when not configured (terse default)", () => {
    const panel = buildOneClickPanel(document, { symbolSource: GREEN_RULE.symbolSource });
    const preview = panel.querySelector(`[${OVERRIDE_ONECLICK_PREVIEW_ATTR}]`);
    expect(preview.textContent).not.toContain("Pins:");
    expect(preview.textContent).not.toContain("ausgeblendet");
    expect(preview.textContent).not.toContain("Value:");
  });
});

describe("renderOverridePanel — green state", () => {
  it("renders the One-Click panel when match.state === 'green'", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      match: {
        state: "green",
        ruleKey: "Passives/Resistors",
        rule: GREEN_RULE,
      },
    });
    expect(panel).toBeTruthy();
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("green");
    expect(panel.querySelector(`[${OVERRIDE_IMPORT_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_MODIFY_ATTR}]`)).toBeTruthy();
  });

  it("[Import] click fires onImport with NO args and removes the panel — one-click, no countdown", () => {
    const row = mountAnchorRow();
    const fired = [];
    const panel = renderOverridePanel(row, {
      match: { state: "green", ruleKey: "Passives/Resistors", rule: GREEN_RULE },
      onImport: () => fired.push("import"),
    });
    panel.querySelector(`[${OVERRIDE_IMPORT_ATTR}]`).click();
    expect(fired).toEqual(["import"]);
    expect(row.parentNode.querySelector(`[${OVERRIDE_PANEL_ATTR}="true"]`)).toBeNull();
  });

  it("[Modifizieren] click fires onModify so the caller can open the Import-Editor", () => {
    const row = mountAnchorRow();
    const fired = [];
    const panel = renderOverridePanel(row, {
      match: { state: "green", ruleKey: "Passives/Resistors", rule: GREEN_RULE },
      onModify: () => fired.push("modify"),
    });
    panel.querySelector(`[${OVERRIDE_MODIFY_ATTR}]`).click();
    expect(fired).toEqual(["modify"]);
    expect(row.parentNode.querySelector(`[${OVERRIDE_PANEL_ATTR}="true"]`)).toBeNull();
  });

  it("is idempotent in the green state — a second render returns the existing one-click panel", () => {
    const row = mountAnchorRow();
    const first = renderOverridePanel(row, {
      match: { state: "green", ruleKey: "Passives/Resistors", rule: GREEN_RULE },
    });
    const second = renderOverridePanel(row, {
      match: { state: "green", ruleKey: "Passives/Resistors", rule: GREEN_RULE },
    });
    expect(second).toBe(first);
    expect(
      row.parentNode.querySelectorAll(`[${OVERRIDE_PANEL_ATTR}="true"]`).length,
    ).toBe(1);
  });

  it("yellow + keepEasyeda renders the Low-Confidence panel (Issue #31)", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      match: { state: "yellow", ruleKey: "Passives/Resistors", rule: GREEN_RULE },
      lowConfidenceBehaviour: "keepEasyeda",
      templateLibs: EMPTY_LIBS,
    });
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("yellow");
    expect(panel.querySelector(`[${OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_YELLOW_OPEN_EDITOR_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_IMPORT_ATTR}]`)).toBeNull();
  });

  it("an unrecognised state falls through to the legacy sources panel (back-compat)", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      match: { state: "unknown", ruleKey: "Passives/Resistors", rule: GREEN_RULE },
      templateLibs: EMPTY_LIBS,
    });
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("sources");
  });
});

/* -------------------------------------------------------------------------- */
/*  🟡 Low-Confidence panel — Issue #31, ADR-0006 §3.5                         */
/* -------------------------------------------------------------------------- */

describe("buildYellowPanel", () => {
  it("renders a Vorschlag-hint when the matcher surfaced an auto-template-match symbol", () => {
    const panel = buildYellowPanel(document, {
      match: {
        symbol: {
          source: "auto-template-match",
          choice: { source: "template", libPath: "/x/Lib.kicad_sym", name: "Resistor_Std" },
        },
        footprint: { source: "easyeda-fallback" },
      },
    });
    const hint = panel.querySelector(`[${OVERRIDE_YELLOW_HINT_ATTR}]`);
    expect(hint?.textContent).toMatch(/Symbol/);
    expect(hint?.textContent).toMatch(/Resistor_Std/);
  });

  it("renders both keep-EasyEDA and open-editor buttons", () => {
    const panel = buildYellowPanel(document, {});
    expect(panel.querySelector(`[${OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_YELLOW_OPEN_EDITOR_ATTR}]`)).toBeTruthy();
  });

  it("marks the panel mode 'yellow'", () => {
    const panel = buildYellowPanel(document, {});
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("yellow");
  });
});

describe("renderOverridePanel — 🟡 yellow dispatch (Issue #31)", () => {
  it("opens the editor immediately when state=yellow + default (openEditor)", () => {
    const row = mountAnchorRow();
    let modifyCalled = false;
    const panel = renderOverridePanel(row, {
      match: { state: "yellow", ruleKey: "Passives/Resistors", rule: { symbolSource: {} } },
      onModify: () => { modifyCalled = true; },
    });
    // openEditor branch returns null without mounting a panel — caller
    // is expected to render the Import-Editor in its onModify callback.
    expect(panel).toBeNull();
    expect(modifyCalled).toBe(true);
    expect(
      row.parentNode.querySelector(`[${OVERRIDE_PANEL_ATTR}="true"]`),
    ).toBeNull();
  });

  it("opens the editor when lowConfidenceBehaviour is missing entirely (Default)", () => {
    const row = mountAnchorRow();
    let modifyCalled = false;
    renderOverridePanel(row, {
      match: { state: "yellow", rule: {} },
      onModify: () => { modifyCalled = true; },
    });
    expect(modifyCalled).toBe(true);
  });

  it("mounts the keepEasyeda panel when lowConfidenceBehaviour='keepEasyeda'", () => {
    const row = mountAnchorRow();
    let modifyCalled = false;
    const panel = renderOverridePanel(row, {
      match: { state: "yellow", rule: {} },
      lowConfidenceBehaviour: "keepEasyeda",
      onModify: () => { modifyCalled = true; },
    });
    expect(modifyCalled).toBe(false);
    expect(panel?.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("yellow");
  });

  it("[EasyEDA übernehmen] fires onEasyedaOnly and removes the panel", () => {
    const row = mountAnchorRow();
    let easyedaOnlyCalls = 0;
    const panel = renderOverridePanel(row, {
      match: { state: "yellow", rule: {} },
      lowConfidenceBehaviour: "keepEasyeda",
      onEasyedaOnly: () => { easyedaOnlyCalls += 1; },
    });
    const keepBtn = panel.querySelector(`[${OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR}]`);
    keepBtn.click();
    expect(easyedaOnlyCalls).toBe(1);
    expect(
      row.parentNode.querySelector(`[${OVERRIDE_PANEL_ATTR}="true"]`),
    ).toBeNull();
  });

  it("[EasyEDA übernehmen] falls back to onConfirm with EasyEDA on both Layers", () => {
    const row = mountAnchorRow();
    let confirmedOverrides = null;
    const panel = renderOverridePanel(row, {
      match: { state: "yellow", rule: {} },
      lowConfidenceBehaviour: "keepEasyeda",
      onConfirm: (overrides) => { confirmedOverrides = overrides; },
    });
    panel.querySelector(`[${OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR}]`).click();
    expect(confirmedOverrides).toEqual({
      symbol: { source: "easyeda" },
      footprint: { source: "easyeda" },
    });
  });

  it("[Editor öffnen] fires onModify and removes the panel", () => {
    const row = mountAnchorRow();
    let modifyCalls = 0;
    const panel = renderOverridePanel(row, {
      match: { state: "yellow", rule: {} },
      lowConfidenceBehaviour: "keepEasyeda",
      onModify: () => { modifyCalls += 1; },
    });
    panel.querySelector(`[${OVERRIDE_YELLOW_OPEN_EDITOR_ATTR}]`).click();
    expect(modifyCalls).toBe(1);
    expect(
      row.parentNode.querySelector(`[${OVERRIDE_PANEL_ATTR}="true"]`),
    ).toBeNull();
  });
});

describe("buildRegisterImportEditor — symbol preview (Etappe B)", () => {
  const TPL = "/home/user/templates/MyTemplates.kicad_sym";
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("renders a preview pane; EasyEDA default shows a placeholder and does not fetch", () => {
    let calls = 0;
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      fetchSymbolPreview: () => {
        calls += 1;
        return Promise.resolve({ svg: "<svg></svg>" });
      },
    });
    const pane = panel.querySelector(`[${OVERRIDE_REGISTER_SYMBOL_PREVIEW_ATTR}]`);
    expect(pane).toBeTruthy();
    // Default selection is EasyEDA → placeholder text, fetcher untouched.
    expect(pane.querySelector("img")).toBeNull();
    expect(pane.textContent).toContain("EasyEDA");
    expect(calls).toBe(0);
  });

  it("fetches and renders the SVG for a preselected template symbol", async () => {
    const seen = [];
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      initialSymbolSource: { source: "template", libPath: TPL, name: "R0603" },
      fetchSymbolPreview: (arg) => {
        seen.push(arg);
        return Promise.resolve({ svg: "<svg id='x'></svg>" });
      },
    });
    const pane = panel.querySelector(`[${OVERRIDE_REGISTER_SYMBOL_PREVIEW_ATTR}]`);
    // Synchronously shows a loading hint before the promise resolves.
    expect(pane.textContent).toContain("Lade");
    await flush();
    expect(seen).toEqual([{ libPath: TPL, name: "R0603" }]);
    const img = pane.querySelector("img");
    expect(img).toBeTruthy();
    expect(decodeURIComponent(img.getAttribute("src"))).toContain("<svg id='x'>");
  });

  it("fetches when the user clicks a template row", async () => {
    let calls = 0;
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      fetchSymbolPreview: () => {
        calls += 1;
        return Promise.resolve({ svg: "<svg></svg>" });
      },
    });
    // Reveal all templates, then click the first template row.
    const cb = panel.querySelector(`[${OVERRIDE_REGISTER_SHOWALL_ATTR}]`);
    cb.checked = true;
    cb.dispatchEvent(new Event("change"));
    const row = panel.querySelector(
      `[${OVERRIDE_REGISTER_TEMPLATE_ITEM_ATTR}][data-value^="template:"]`,
    );
    row.click();
    await flush();
    expect(calls).toBeGreaterThan(0);
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_SYMBOL_PREVIEW_ATTR}] img`)).toBeTruthy();
  });

  it("shows the error text on a soft preview miss", async () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      initialSymbolSource: { source: "template", libPath: TPL, name: "R0603" },
      fetchSymbolPreview: () => Promise.resolve({ svg: null, error: "symbol_not_found" }),
    });
    await flush();
    const pane = panel.querySelector(`[${OVERRIDE_REGISTER_SYMBOL_PREVIEW_ATTR}]`);
    expect(pane.querySelector("img")).toBeNull();
    expect(pane.textContent).toContain("symbol_not_found");
  });
});

describe("buildRegisterImportEditor — footprint preview (3-column layout)", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("renders a footprint pane and fetches it once on build", async () => {
    let calls = 0;
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      fetchFootprintPreview: () => {
        calls += 1;
        return Promise.resolve({ svg: "<svg id='fp'></svg>" });
      },
    });
    const pane = panel.querySelector(`[${OVERRIDE_REGISTER_FOOTPRINT_PREVIEW_ATTR}]`);
    expect(pane).toBeTruthy();
    await flush();
    expect(calls).toBe(1); // one-shot — independent of template selection
    const img = pane.querySelector("img");
    expect(img).toBeTruthy();
    expect(decodeURIComponent(img.getAttribute("src"))).toContain("<svg id='fp'>");
  });

  it("shows a placeholder when no footprint fetcher is provided", () => {
    const panel = buildRegisterImportEditor(document, { templateLibs: ONE_LIB });
    const pane = panel.querySelector(`[${OVERRIDE_REGISTER_FOOTPRINT_PREVIEW_ATTR}]`);
    expect(pane.querySelector("img")).toBeNull();
    expect(pane.textContent).toContain("nicht verfügbar");
  });

  it("shows the error text on a soft footprint miss", async () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      fetchFootprintPreview: () => Promise.resolve({ svg: null, error: "footprint_unavailable" }),
    });
    await flush();
    const pane = panel.querySelector(`[${OVERRIDE_REGISTER_FOOTPRINT_PREVIEW_ATTR}]`);
    expect(pane.querySelector("img")).toBeNull();
    expect(pane.textContent).toContain("footprint_unavailable");
  });
});
