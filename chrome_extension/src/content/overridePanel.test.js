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
  OVERRIDE_REGISTER_PINMAP_ATTR,
  OVERRIDE_REGISTER_PINMAP_TABLE_ATTR,
  OVERRIDE_REGISTER_PINMAP_PAD_ATTR,
  OVERRIDE_REGISTER_MAPSTATUS_ATTR,
  OVERRIDE_REGISTER_PINMAP_NC,
  OVERRIDE_REGISTER_FOOTPRINT_LIST_ATTR,
  OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR,
  OVERRIDE_REGISTER_FP_SHOWALL_ATTR,
  OVERRIDE_REGISTER_SYMBOL_SEARCH_ATTR,
  OVERRIDE_REGISTER_FOOTPRINT_SEARCH_ATTR,
  OVERRIDE_IMPORT_ATTR,
  OVERRIDE_MODIFY_ATTR,
  OVERRIDE_ONECLICK_PREVIEW_ATTR,
  OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR,
  OVERRIDE_YELLOW_OPEN_EDITOR_ATTR,
  OVERRIDE_YELLOW_HINT_ATTR,
  OVERRIDE_CAD_UNAVAILABLE_ATTR,
  CAD_UNAVAILABLE_MESSAGE,
  emittedOverridesNeedEasyeda,
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

// Footprint layer for ONE_LIB — keyed by the SAME .kicad_sym path (the template
// library identifier; the host resolves the sibling .pretty). (#9)
const ONE_LIB_FP = {
  "/home/user/templates/MyTemplates.kicad_sym": ["R0603_HandSolder", "C0805_Std"],
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

  it("renders a Footprint dropdown (EasyEDA + template footprints, #9)", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
    });
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    expect(fp).toBeTruthy();
    const values = Array.from(fp.querySelectorAll("option")).map((o) => o.value);
    expect(values[0]).toBe(EASYEDA_OPTION_VALUE);
    expect(values).toContain(
      "template:/home/user/templates/MyTemplates.kicad_sym:R0603_HandSolder",
    );
    // Default selection is EasyEDA until the user picks a template footprint.
    expect(fp.value).toBe(EASYEDA_OPTION_VALUE);
  });

  it("prefills the Footprint dropdown from initialFootprintSource (Modify)", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      initialFootprintSource: {
        source: "template",
        libPath: "/home/user/templates/MyTemplates.kicad_sym",
        name: "C0805_Std",
      },
    });
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    expect(fp.value).toBe(
      "template:/home/user/templates/MyTemplates.kicad_sym:C0805_Std",
    );
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
        // Footprint defaults to EasyEDA when the user did not pick a template FP.
        footprintSource: { source: "easyeda" },
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

  it("returns the chosen footprintSource (template) (#9)", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
    });
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    fp.value = "template:/home/user/templates/MyTemplates.kicad_sym:R0603_HandSolder";
    const payload = collectRegisterEditorRule(panel, "Passives");
    expect(payload.rule.footprintSource).toEqual({
      source: "template",
      libPath: "/home/user/templates/MyTemplates.kicad_sym",
      name: "R0603_HandSolder",
    });
  });

  it("defaults footprintSource to easyeda when no template FP picked", () => {
    const panel = buildRegisterImportEditor(document, { templateLibs: ONE_LIB });
    expect(collectRegisterEditorRule(panel, "X").rule.footprintSource).toEqual({
      source: "easyeda",
    });
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
          footprintSource: { source: "easyeda" },
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

  it("does NOT render a Confirm button — the [Import] click IS the confirm (ADR-0006 §U3.3)", () => {
    const panel = buildOneClickPanel(document, {});
    expect(panel.querySelector(`[${OVERRIDE_CONFIRM_ATTR}]`)).toBeNull();
    expect(panel.querySelector(`[${OVERRIDE_CANCEL_ATTR}]`)).toBeNull();
  });

  it("shows the matched rule in a slim neutral line — no green box, no preview text wall", () => {
    const panel = buildOneClickPanel(document, {
      ruleKey: "Passives/Resistors",
      symbolSource: GREEN_RULE.symbolSource,
      labelMapping: GREEN_RULE.labelMapping,
      hidePinNumbers: true,
      valueParam: "Resistance",
    });
    expect(panel.textContent).toContain("Passives/Resistors");
    expect(panel.textContent).toContain("erkannt");
    // The verbose Symbol/Mapping/Pins/Value preview wall is gone.
    expect(panel.querySelector(`[${OVERRIDE_ONECLICK_PREVIEW_ATTR}]`)).toBeNull();
    expect(panel.textContent).not.toContain("Mapping:");
    expect(panel.textContent).not.toContain("Pins:");
    // No loud green fill — it blends into the page as a line, not a box.
    expect(panel.style.background).toBe("");
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

  it("EasyEDA default fetches the EasyEDA symbol preview (not the template fetcher) and renders it", async () => {
    let tplCalls = 0;
    let easyCalls = 0;
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      fetchSymbolPreview: () => {
        tplCalls += 1;
        return Promise.resolve({ svg: "<svg></svg>" });
      },
      fetchEasyedaSymbolPreview: () => {
        easyCalls += 1;
        return Promise.resolve({ svg: "<svg id='e'></svg>", pins: [] });
      },
    });
    const pane = panel.querySelector(`[${OVERRIDE_REGISTER_SYMBOL_PREVIEW_ATTR}]`);
    expect(pane).toBeTruthy();
    // Synchronously shows the loading hint, then resolves to the EasyEDA symbol.
    expect(pane.textContent).toContain("Lade");
    await flush();
    expect(easyCalls).toBe(1);
    expect(tplCalls).toBe(0); // the template fetcher is NOT used for EasyEDA
    expect(pane.querySelector("img")).toBeTruthy();
  });

  it("EasyEDA default falls back to a placeholder when no EasyEDA fetcher is wired", async () => {
    const panel = buildRegisterImportEditor(document, { templateLibs: ONE_LIB });
    const pane = panel.querySelector(`[${OVERRIDE_REGISTER_SYMBOL_PREVIEW_ATTR}]`);
    await flush();
    expect(pane.querySelector("img")).toBeNull();
    expect(pane.textContent).toContain("EasyEDA");
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

  it("shows a placeholder when no footprint fetcher is provided", async () => {
    const panel = buildRegisterImportEditor(document, { templateLibs: ONE_LIB });
    await flush();
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

  it("fetches the TEMPLATE footprint preview when a template FP is selected (#9)", async () => {
    const seen = [];
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      fetchFootprintPreview: () => Promise.resolve({ svg: "<svg id='ee'></svg>" }),
      fetchTemplateFootprintPreview: ({ libPath, name }) => {
        seen.push({ libPath, name });
        return Promise.resolve({ svg: "<svg id='tpl'></svg>" });
      },
    });
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    fp.value = "template:/home/user/templates/MyTemplates.kicad_sym:R0603_HandSolder";
    fp.dispatchEvent(new Event("change"));
    await flush();
    expect(seen).toEqual([
      { libPath: "/home/user/templates/MyTemplates.kicad_sym", name: "R0603_HandSolder" },
    ]);
    const img = panel.querySelector(
      `[${OVERRIDE_REGISTER_FOOTPRINT_PREVIEW_ATTR}] img`,
    );
    expect(decodeURIComponent(img.getAttribute("src"))).toContain("<svg id='tpl'>");
  });
});

/* -------------------------------------------------------------------------- */
/*  Issue #43 — design tokens flow through panel chrome (light + dark theme) */
/* -------------------------------------------------------------------------- */

// JSDOM normalizes color strings (hex / rgba) — round-trip the expected value
// through a throwaway element so the assertion compares apples to apples.
function jsdomColor(value) {
  const probe = document.createElement("div");
  probe.style.background = value;
  return probe.style.background;
}

describe("Override Panel — theme-aware token chrome (#43)", () => {
  it("buildRegisterPrompt in dark theme uses the dark surface", async () => {
    const { getDialogTokens } = await import("./dialog.js");
    const dark = getDialogTokens("dark");
    const panel = buildRegisterPrompt(document, { theme: "dark" });
    expect(panel.style.background).toBe(jsdomColor(dark.surface2));
  });

  it("buildOneClickPanel is a slim neutral line (no green surface) in dark theme too", async () => {
    const { getDialogTokens } = await import("./dialog.js");
    const dark = getDialogTokens("dark");
    const panel = buildOneClickPanel(document, { theme: "dark", ruleKey: "X" });
    // No filled surface — it blends into the page as a line, not a green box.
    expect(panel.style.background).toBe("");
    expect(panel.style.background).not.toBe(jsdomColor(dark.successSurface));
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("green");
  });

  it("buildYellowPanel in dark theme honors the dark warning surface", async () => {
    const { getDialogTokens } = await import("./dialog.js");
    const light = getDialogTokens("light");
    const dark = getDialogTokens("dark");
    const panel = buildYellowPanel(document, { theme: "dark" });
    expect(panel.style.background).toBe(jsdomColor(dark.warningSurface));
    expect(panel.style.background).not.toBe(jsdomColor(light.warningSurface));
  });

  it("buildRegisterImportEditor preview panes use the dark surface in dark theme", async () => {
    const { getDialogTokens } = await import("./dialog.js");
    const dark = getDialogTokens("dark");
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      theme: "dark",
    });
    const sym = panel.querySelector(`[${OVERRIDE_REGISTER_SYMBOL_PREVIEW_ATTR}]`);
    const fp = panel.querySelector(`[${OVERRIDE_REGISTER_FOOTPRINT_PREVIEW_ATTR}]`);
    // The pre-#43 implementation hard-coded ``background:#ffffff`` here —
    // the dark theme MUST move away from that so SVGs (which the backend
    // ships in dark-aware palettes when ``previewTheme="dark"``) read
    // against a matching pane.
    expect(sym.style.background).toBe(jsdomColor(dark.surface2));
    expect(fp.style.background).toBe(jsdomColor(dark.surface2));
    expect(sym.style.background).not.toBe(jsdomColor("#ffffff"));
    expect(fp.style.background).not.toBe(jsdomColor("#ffffff"));
  });

  it("Value-Param select keeps its flex sizing across focus (regression #43)", () => {
    // ``applyDialogStyleSelect`` rewrites the select's ``cssText`` on
    // focus/blur/hover. The Value-Feld row places the select inside a
    // flex wrapper so the row's ``flex:1`` + ``min-width:0`` survive the
    // rewrite — otherwise focusing the select would collapse the layout.
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      pageParams: { "MPN": "ABC123" },
    });
    const valueSelect = panel.querySelector(
      `[${OVERRIDE_REGISTER_VALUE_PARAM_ATTR}]`,
    );
    const wrap = valueSelect.parentElement;
    // JSDOM normalizes ``flex:1`` to ``1 1 0%``; ``flexGrow`` is the
    // canonical read-out and survives the normalization.
    expect(wrap.style.flexGrow).toBe("1");
    expect(wrap.style.minWidth).toBe("0");
    valueSelect.dispatchEvent(new Event("focus"));
    expect(wrap.style.flexGrow).toBe("1");
    expect(wrap.style.minWidth).toBe("0");
  });
});

/* -------------------------------------------------------------------------- */
/*  Issue #9 — Import-Editor layout overhaul + Pin↔Pad Mapper                 */
/* -------------------------------------------------------------------------- */

const PINMAP_TPL = "/home/user/templates/MyTemplates.kicad_sym";
const PINMAP_SYM_PINS = [
  { number: "1", name: "A" },
  { number: "2", name: "B" },
];
const PINMAP_PADS = ["1", "2"];
const flushAsync = () => new Promise((r) => setTimeout(r, 0));

describe("buildRegisterImportEditor — 4-column layout (#49)", () => {
  it("uses an explicit 4-column × 2-row grid; the side lists span the full height", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
    });
    const symList = panel.querySelector(`[${OVERRIDE_REGISTER_TEMPLATE_LIST_ATTR}]`);
    const fpList = panel.querySelector(`[${OVERRIDE_REGISTER_FOOTPRINT_LIST_ATTR}]`);
    const symbolCol = symList.parentElement;
    const footprintCol = fpList.parentElement;
    const body = symbolCol.parentElement;
    expect(body.style.display).toBe("grid");
    // Explicit 4 columns (NOT auto-fit) + 2 rows, so the lists can span both rows.
    expect(body.style.gridTemplateColumns).not.toMatch(/auto-fit/);
    expect((body.style.gridTemplateColumns.match(/minmax/g) || []).length).toBe(4);
    expect(body.style.gridTemplateRows).toBeTruthy();
    // Slice 1 (symbol list) + slice 4 (footprint list) span BOTH rows → full height,
    // never shortened by the metadata that sits under the viewers.
    expect(symbolCol.style.gridRow.replace(/\s/g, "")).toBe("1/span2");
    expect(footprintCol.style.gridRow.replace(/\s/g, "")).toBe("1/span2");
  });

  it("renders the status strip + Pin-Mapper host + table in the right pane", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
    });
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_MAPSTATUS_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_PINMAP_ATTR}]`)).toBeTruthy();
  });

  it("marks the category-matched symbol + the EasyEDA original in the symbol list", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      templateCategoriesByLib: {
        "/home/user/templates/MyTemplates.kicad_sym": { R0603: "Resistors" },
      },
      categoryPath: "Resistors/Chip Resistor",
    });
    const byVal = {};
    panel
      .querySelectorAll(`[${OVERRIDE_REGISTER_TEMPLATE_ITEM_ATTR}]`)
      .forEach((r) => { byVal[r.dataset.value] = r; });
    // EasyEDA "Original" row is flagged original, never matched.
    expect(byVal[EASYEDA_OPTION_VALUE].dataset.k2cOriginal).toBe("true");
    expect(byVal[EASYEDA_OPTION_VALUE].dataset.k2cMatched).toBeUndefined();
    // The category-matched template is flagged matched.
    const r0603 = byVal["template:/home/user/templates/MyTemplates.kicad_sym:R0603"];
    expect(r0603).toBeTruthy();
    expect(r0603.dataset.k2cMatched).toBe("true");
  });

  it("marks the packageHint-matched footprint + the EasyEDA original (show-all view)", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      packageHint: "R0603",
    });
    // Reveal ALL footprints (the default view already hides non-matching ones via
    // the packageHint filter) so both the matching + non-matching rows render.
    const showAll = panel.querySelector(`[${OVERRIDE_REGISTER_FP_SHOWALL_ATTR}]`);
    showAll.checked = true;
    showAll.dispatchEvent(new Event("change"));
    const byVal = {};
    panel
      .querySelectorAll(`[${OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR}]`)
      .forEach((r) => { byVal[r.dataset.value] = r; });
    expect(byVal[EASYEDA_OPTION_VALUE].dataset.k2cOriginal).toBe("true");
    // "R0603_HandSolder" contains the package hint "R0603" → matched.
    const fp = byVal["template:/home/user/templates/MyTemplates.kicad_sym:R0603_HandSolder"];
    expect(fp).toBeTruthy();
    expect(fp.dataset.k2cMatched).toBe("true");
    // "C0805_Std" does not → not matched.
    const c0805 = byVal["template:/home/user/templates/MyTemplates.kicad_sym:C0805_Std"];
    expect(c0805).toBeTruthy();
    expect(c0805.dataset.k2cMatched).toBeUndefined();
  });

  it("puts the viewers in row 1 (cols 2 & 3) with metadata/Pin-Mapper in row 2 below them", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
    });
    const sym = panel.querySelector(`[${OVERRIDE_REGISTER_SYMBOL_PREVIEW_ATTR}]`);
    const fp = panel.querySelector(`[${OVERRIDE_REGISTER_FOOTPRINT_PREVIEW_ATTR}]`);
    const symCell = sym.parentElement;
    const fpCell = fp.parentElement;
    // Both viewer cells live in the same body grid.
    expect(symCell.parentElement).toBe(fpCell.parentElement);
    const body = symCell.parentElement;
    expect(body.style.display).toBe("grid");
    expect(body.style.gridTemplateColumns).not.toMatch(/auto-fit/);
    // Viewers: row 1, middle columns.
    expect(symCell.style.gridColumn).toBe("2");
    expect(symCell.style.gridRow).toBe("1");
    expect(fpCell.style.gridColumn).toBe("3");
    expect(fpCell.style.gridRow).toBe("1");
    // The metadata + Pin-Mapper block is a grid child in row 2 spanning cols 2–3.
    const pinmap = panel.querySelector(`[${OVERRIDE_REGISTER_PINMAP_ATTR}]`);
    let metaCell = pinmap;
    while (metaCell && metaCell.parentElement !== body) metaCell = metaCell.parentElement;
    expect(metaCell).toBeTruthy();
    expect(metaCell.style.gridColumn.replace(/\s/g, "")).toBe("2/span2");
    expect(metaCell.style.gridRow).toBe("2");
  });

  it("the source file performs no panel.clientWidth read (intrinsic collapse only)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "src/content/overridePanel.js"),
      "utf-8",
    );
    expect(src).not.toMatch(/\.clientWidth\b/);
  });
});

describe("buildRegisterImportEditor — Pin↔Pad Mapper (#9)", () => {
  it("shows the 'Pin-Zuordnung nur für Template-Symbole' placeholder when symbol source is EasyEDA", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
    });
    const host = panel.querySelector(`[${OVERRIDE_REGISTER_PINMAP_ATTR}]`);
    expect(host.textContent).toContain("nur für Template-Symbole");
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_PINMAP_TABLE_ATTR}]`)).toBeNull();
  });

  it("renders one row per footprint pad once pins+pads are fetched, with selects keyed by pad label", async () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      initialSymbolSource: { source: "template", libPath: PINMAP_TPL, name: "R0603" },
      fetchSymbolPreview: () => Promise.resolve({ svg: "<svg/>", pins: PINMAP_SYM_PINS }),
      fetchFootprintPreview: () => Promise.resolve({ svg: "<svg/>", pads: PINMAP_PADS }),
    });
    await flushAsync();
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_PINMAP_TABLE_ATTR}]`)).toBeTruthy();
    const selects = panel.querySelectorAll(`select[${OVERRIDE_REGISTER_PINMAP_PAD_ATTR}]`);
    expect(selects.length).toBe(2);
    expect(selects[0].getAttribute(OVERRIDE_REGISTER_PINMAP_PAD_ATTR)).toBe("1");
    expect(selects[1].getAttribute(OVERRIDE_REGISTER_PINMAP_PAD_ATTR)).toBe("2");
  });

  it("auto-defaults pad→pin 1:1 when pad labels and pin numbers match (digit-normalized)", async () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      initialSymbolSource: { source: "template", libPath: PINMAP_TPL, name: "R0603" },
      // ``"01"`` should normalize against pin ``"1"`` so a pad with a leading
      // zero still picks up the auto-default (parts ship both forms).
      fetchSymbolPreview: () => Promise.resolve({ svg: "<svg/>", pins: PINMAP_SYM_PINS }),
      fetchFootprintPreview: () => Promise.resolve({ svg: "<svg/>", pads: ["01", "2"] }),
    });
    await flushAsync();
    const selects = panel.querySelectorAll(`select[${OVERRIDE_REGISTER_PINMAP_PAD_ATTR}]`);
    expect(selects[0].value).toBe("1");
    expect(selects[1].value).toBe("2");
  });

  it("collectRegisterEditorRule emits templatePinMap as {symbolPinNumber: footprintPadLabel}", async () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      initialSymbolSource: { source: "template", libPath: PINMAP_TPL, name: "R0603" },
      fetchSymbolPreview: () => Promise.resolve({ svg: "<svg/>", pins: PINMAP_SYM_PINS }),
      fetchFootprintPreview: () => Promise.resolve({ svg: "<svg/>", pads: PINMAP_PADS }),
    });
    await flushAsync();
    const payload = collectRegisterEditorRule(panel, "Passives/Resistors");
    expect(payload.rule.templatePinMap).toEqual({ "1": "1", "2": "2" });
  });

  it("skips __NC__ / blank selections when building templatePinMap", async () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      initialSymbolSource: { source: "template", libPath: PINMAP_TPL, name: "R0603" },
      fetchSymbolPreview: () => Promise.resolve({ svg: "<svg/>", pins: PINMAP_SYM_PINS }),
      fetchFootprintPreview: () => Promise.resolve({ svg: "<svg/>", pads: PINMAP_PADS }),
    });
    await flushAsync();
    const selects = panel.querySelectorAll(`select[${OVERRIDE_REGISTER_PINMAP_PAD_ATTR}]`);
    selects[0].value = OVERRIDE_REGISTER_PINMAP_NC;
    const payload = collectRegisterEditorRule(panel, "X");
    expect(payload.rule.templatePinMap).toEqual({ "2": "2" });
  });

  it("omits templatePinMap entirely when symbolSource.source !== 'template'", () => {
    const panel = buildRegisterImportEditor(document, { templateLibs: ONE_LIB });
    const payload = collectRegisterEditorRule(panel, "X");
    expect(payload.rule.symbolSource.source).toBe("easyeda");
    expect("templatePinMap" in payload.rule).toBe(false);
  });

  it("omits templatePinMap when the user clears every assignment (NC-only is no-op)", async () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      initialSymbolSource: { source: "template", libPath: PINMAP_TPL, name: "R0603" },
      fetchSymbolPreview: () => Promise.resolve({ svg: "<svg/>", pins: PINMAP_SYM_PINS }),
      fetchFootprintPreview: () => Promise.resolve({ svg: "<svg/>", pads: PINMAP_PADS }),
    });
    await flushAsync();
    for (const sel of panel.querySelectorAll(`select[${OVERRIDE_REGISTER_PINMAP_PAD_ATTR}]`)) {
      sel.value = OVERRIDE_REGISTER_PINMAP_NC;
    }
    const payload = collectRegisterEditorRule(panel, "X");
    expect("templatePinMap" in payload.rule).toBe(false);
  });

  it("updates the status strip text on every <select> change", async () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      initialSymbolSource: { source: "template", libPath: PINMAP_TPL, name: "R0603" },
      fetchSymbolPreview: () => Promise.resolve({ svg: "<svg/>", pins: PINMAP_SYM_PINS }),
      fetchFootprintPreview: () => Promise.resolve({ svg: "<svg/>", pads: PINMAP_PADS }),
    });
    await flushAsync();
    const status = panel.querySelector(`[${OVERRIDE_REGISTER_MAPSTATUS_ATTR}]`);
    expect(status.textContent).toContain("2/2");
    const first = panel.querySelector(`select[${OVERRIDE_REGISTER_PINMAP_PAD_ATTR}]`);
    first.value = OVERRIDE_REGISTER_PINMAP_NC;
    first.dispatchEvent(new Event("change"));
    expect(status.textContent).toContain("1/2");
    expect(status.textContent).toContain("1 offen");
  });

  it("template footprint selection swaps the mapper to the 'noch nicht verfügbar' placeholder", async () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      initialSymbolSource: { source: "template", libPath: PINMAP_TPL, name: "R0603" },
      fetchSymbolPreview: () => Promise.resolve({ svg: "<svg/>", pins: PINMAP_SYM_PINS }),
      fetchFootprintPreview: () => Promise.resolve({ svg: "<svg/>", pads: PINMAP_PADS }),
      fetchTemplateFootprintPreview: () => Promise.resolve({ svg: "<svg/>" }),
    });
    await flushAsync();
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_PINMAP_TABLE_ATTR}]`)).toBeTruthy();
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    fp.value = "template:/home/user/templates/MyTemplates.kicad_sym:R0603_HandSolder";
    fp.dispatchEvent(new Event("change"));
    await flushAsync();
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_PINMAP_TABLE_ATTR}]`)).toBeNull();
    expect(
      panel.querySelector(`[${OVERRIDE_REGISTER_PINMAP_ATTR}]`).textContent,
    ).toContain("Template-Footprints noch nicht verfügbar");
  });

  it("preserves a still-valid user choice across a rebuild (preview swap doesn't wipe selections)", async () => {
    let pins = PINMAP_SYM_PINS;
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      initialSymbolSource: { source: "template", libPath: PINMAP_TPL, name: "R0603" },
      fetchSymbolPreview: () => Promise.resolve({ svg: "<svg/>", pins }),
      fetchFootprintPreview: () => Promise.resolve({ svg: "<svg/>", pads: PINMAP_PADS }),
    });
    await flushAsync();
    // Hand-mapped pad "1" → pin "2" (intentional swap).
    const padOne = panel.querySelector(
      `select[${OVERRIDE_REGISTER_PINMAP_PAD_ATTR}="1"]`,
    );
    padOne.value = "2";
    padOne.dispatchEvent(new Event("change"));
    // Trigger a rebuild (e.g. re-fetch via the template list).
    const cb = panel.querySelector(`[${OVERRIDE_REGISTER_SHOWALL_ATTR}]`);
    cb.checked = true;
    cb.dispatchEvent(new Event("change"));
    await flushAsync();
    const padOneAfter = panel.querySelector(
      `select[${OVERRIDE_REGISTER_PINMAP_PAD_ATTR}="1"]`,
    );
    expect(padOneAfter.value).toBe("2");
  });

  it("provides a per-select aria-label so screen readers can announce the pad context", async () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      initialSymbolSource: { source: "template", libPath: PINMAP_TPL, name: "R0603" },
      fetchSymbolPreview: () => Promise.resolve({ svg: "<svg/>", pins: PINMAP_SYM_PINS }),
      fetchFootprintPreview: () => Promise.resolve({ svg: "<svg/>", pads: PINMAP_PADS }),
    });
    await flushAsync();
    const sel = panel.querySelector(`select[${OVERRIDE_REGISTER_PINMAP_PAD_ATTR}="1"]`);
    expect(sel.getAttribute("aria-label")).toBe("Symbol-Pin für Footprint-Pad 1");
  });
});

describe("buildRegisterImportEditor — Pin-Mapper tokens + dark theme", () => {
  it("Pin-Mapper host uses the dark surface in dark theme (no hardcoded hex)", async () => {
    const { getDialogTokens } = await import("./dialog.js");
    const dark = getDialogTokens("dark");
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      theme: "dark",
    });
    const host = panel.querySelector(`[${OVERRIDE_REGISTER_PINMAP_ATTR}]`);
    expect(host.style.background).toBe(jsdomColor(dark.surface2));
    expect(host.style.background).not.toBe(jsdomColor("#f1f5f9"));
  });

  it("status strip is themed via primarySoft / primary tokens (no hardcoded hex)", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
    });
    const status = panel.querySelector(`[${OVERRIDE_REGISTER_MAPSTATUS_ATTR}]`);
    expect(status.style.background).toBeTruthy();
    expect(status.style.color).toBeTruthy();
    // The mapper hex-literals called out in the spec (gallery table) must not
    // leak into the panel chrome.
    const text = status.style.cssText.toLowerCase();
    expect(text).not.toContain("#f1f5f9");
    expect(text).not.toContain("#0f172a");
    expect(text).not.toContain("#94a3b8");
  });

  it("Pin-Mapper selects are styled via applyDialogStyleSelect (chevron + hover wiring)", async () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      initialSymbolSource: { source: "template", libPath: PINMAP_TPL, name: "R0603" },
      fetchSymbolPreview: () => Promise.resolve({ svg: "<svg/>", pins: PINMAP_SYM_PINS }),
      fetchFootprintPreview: () => Promise.resolve({ svg: "<svg/>", pads: PINMAP_PADS }),
    });
    await flushAsync();
    const sel = panel.querySelector(`select[${OVERRIDE_REGISTER_PINMAP_PAD_ATTR}="1"]`);
    // applyDialogStyleSelect installs a custom background-image chevron.
    expect(sel.style.backgroundImage).toContain("svg");
  });
});

/* -------------------------------------------------------------------------- */
/*  Issue #47 — EasyEDA availability pre-check (no-CAD gate)                  */
/* -------------------------------------------------------------------------- */

const CAD_UNAVAILABLE = { symbol: false, footprint: false };
const CAD_BOTH_AVAILABLE = { symbol: true, footprint: true };

const FULLY_TEMPLATE_RULE = {
  symbolSource: {
    source: "template",
    libPath: "/home/user/templates/MyTemplates.kicad_sym",
    name: "R0603",
  },
  footprintSource: {
    source: "template",
    libPath: "/home/user/templates/MyTemplates.kicad_sym",
    name: "R0603_HandSolder",
  },
  labelMapping: {},
};

const MIXED_RULE = {
  symbolSource: {
    source: "template",
    libPath: "/home/user/templates/MyTemplates.kicad_sym",
    name: "R0603",
  },
  // No footprintSource → green import's footprint would default to EasyEDA.
  labelMapping: {},
};

describe("emittedOverridesNeedEasyeda — front-end mirror of conversion.py:556-560", () => {
  it("returns false when both layers are template AND no 3D requested (today's Phase 2 default)", () => {
    expect(
      emittedOverridesNeedEasyeda({
        symbol: { source: "template", libPath: "/L.kicad_sym", name: "X" },
        footprint: { source: "template", libPath: "/L.kicad_sym", name: "X" },
      }),
    ).toBe(false);
  });

  it("returns true when EITHER layer is EasyEDA (Phase 2 still fetches CAD)", () => {
    expect(
      emittedOverridesNeedEasyeda({
        symbol: { source: "template", libPath: "/L.kicad_sym", name: "X" },
        footprint: { source: "easyeda" },
      }),
    ).toBe(true);
    expect(
      emittedOverridesNeedEasyeda({
        symbol: { source: "easyeda" },
        footprint: { source: "template", libPath: "/L.kicad_sym", name: "X" },
      }),
    ).toBe(true);
  });

  it("keeps the genModel term in the disjunction so the mirror stays correct when 3D is later enabled", () => {
    expect(
      emittedOverridesNeedEasyeda(
        {
          symbol: { source: "template", libPath: "/L.kicad_sym", name: "X" },
          footprint: { source: "template", libPath: "/L.kicad_sym", name: "X" },
        },
        true,
      ),
    ).toBe(true);
  });
});

describe("renderOverridePanel — ⚪ white + cadAvailable gate (Issue #47)", () => {
  it("HIDES the „nur EasyEDA\" action when EasyEDA carries no CAD", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      match: { state: "white" },
      cadAvailable: CAD_UNAVAILABLE,
    });
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("white");
    expect(panel.querySelector(`[${OVERRIDE_EASYEDA_ONLY_ATTR}]`)).toBeNull();
    // „registrieren" is still offered — it routes into the template-only path.
    expect(panel.querySelector(`[${OVERRIDE_REGISTER_ATTR}]`)).toBeTruthy();
  });

  it("renders the shared DE notice when EasyEDA is unavailable", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      match: { state: "white" },
      cadAvailable: CAD_UNAVAILABLE,
    });
    const notice = panel.querySelector(`[${OVERRIDE_CAD_UNAVAILABLE_ATTR}]`);
    expect(notice).toBeTruthy();
    expect(notice.textContent).toBe(CAD_UNAVAILABLE_MESSAGE);
  });

  it("KEEPS the „nur EasyEDA\" action when EasyEDA is available (no regression)", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      match: { state: "white" },
      cadAvailable: CAD_BOTH_AVAILABLE,
    });
    expect(panel.querySelector(`[${OVERRIDE_EASYEDA_ONLY_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_CAD_UNAVAILABLE_ATTR}]`)).toBeNull();
  });

  it("KEEPS the „nur EasyEDA\" action when cadAvailable is absent (back-compat with older Native Hosts)", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, { match: { state: "white" } });
    expect(panel.querySelector(`[${OVERRIDE_EASYEDA_ONLY_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_CAD_UNAVAILABLE_ATTR}]`)).toBeNull();
  });
});

describe("renderOverridePanel — 🟢 green + cadAvailable gate (Issue #47)", () => {
  it("HIDES [Import] when EasyEDA is unavailable AND the rule is mixed (rule footprint defaults to EasyEDA)", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      match: { state: "green", ruleKey: "Passives/Resistors", rule: MIXED_RULE },
      cadAvailable: CAD_UNAVAILABLE,
    });
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("green");
    expect(panel.querySelector(`[${OVERRIDE_IMPORT_ATTR}]`)).toBeNull();
    // [Modifizieren] stays — that's the user's escape into the editor.
    expect(panel.querySelector(`[${OVERRIDE_MODIFY_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_CAD_UNAVAILABLE_ATTR}]`)).toBeTruthy();
  });

  it("KEEPS [Import] when EasyEDA is unavailable AND the rule is FULLY template (allowImport)", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      match: {
        state: "green",
        ruleKey: "Passives/Resistors",
        rule: FULLY_TEMPLATE_RULE,
      },
      cadAvailable: CAD_UNAVAILABLE,
    });
    expect(panel.querySelector(`[${OVERRIDE_IMPORT_ATTR}]`)).toBeTruthy();
    // Notice is still shown so the user knows why the rest of the actions
    // look different (and as a safety net if they wonder).
    expect(panel.querySelector(`[${OVERRIDE_CAD_UNAVAILABLE_ATTR}]`)).toBeTruthy();
  });

  it("KEEPS [Import] when EasyEDA is available (no regression on the mixed-rule path)", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      match: { state: "green", ruleKey: "Passives/Resistors", rule: MIXED_RULE },
      cadAvailable: CAD_BOTH_AVAILABLE,
    });
    expect(panel.querySelector(`[${OVERRIDE_IMPORT_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_CAD_UNAVAILABLE_ATTR}]`)).toBeNull();
  });
});

describe("renderOverridePanel — 🟡 yellow + cadAvailable gate (Issue #47)", () => {
  it("HIDES [EasyEDA übernehmen] in the keepEasyeda branch when EasyEDA is unavailable", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      match: { state: "yellow", rule: {} },
      lowConfidenceBehaviour: "keepEasyeda",
      cadAvailable: CAD_UNAVAILABLE,
    });
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("yellow");
    expect(panel.querySelector(`[${OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR}]`)).toBeNull();
    expect(panel.querySelector(`[${OVERRIDE_YELLOW_OPEN_EDITOR_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_CAD_UNAVAILABLE_ATTR}]`)).toBeTruthy();
  });

  it("KEEPS [EasyEDA übernehmen] when EasyEDA is available", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      match: { state: "yellow", rule: {} },
      lowConfidenceBehaviour: "keepEasyeda",
      cadAvailable: CAD_BOTH_AVAILABLE,
    });
    expect(panel.querySelector(`[${OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR}]`)).toBeTruthy();
    expect(panel.querySelector(`[${OVERRIDE_CAD_UNAVAILABLE_ATTR}]`)).toBeNull();
  });

  it("openEditor branch still bypasses the panel (caller forces template-on-both in onModify)", () => {
    const row = mountAnchorRow();
    let modifyCalled = false;
    const panel = renderOverridePanel(row, {
      match: { state: "yellow", rule: {} },
      cadAvailable: CAD_UNAVAILABLE,
      onModify: () => { modifyCalled = true; },
    });
    expect(panel).toBeNull();
    expect(modifyCalled).toBe(true);
  });
});

describe("renderOverridePanel — legacy sources picker + cadAvailable gate (Issue #47)", () => {
  it("strips the EasyEDA option from BOTH selects when EasyEDA is unavailable", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      cadAvailable: CAD_UNAVAILABLE,
    });
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("sources");
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    const symValues = Array.from(sym.options).map((o) => o.value);
    const fpValues = Array.from(fp.options).map((o) => o.value);
    expect(symValues).not.toContain(EASYEDA_OPTION_VALUE);
    expect(fpValues).not.toContain(EASYEDA_OPTION_VALUE);
    // Confirm cannot emit an EasyEDA layer.
    let confirmed = null;
    panel.querySelector(`[${OVERRIDE_CONFIRM_ATTR}]`).addEventListener("click", () => {
      confirmed = selectionToOverrides({
        symbolValue: sym.value,
        footprintValue: fp.value,
      });
    });
    panel.querySelector(`[${OVERRIDE_CONFIRM_ATTR}]`).click();
    expect(confirmed.symbol.source).toBe("template");
    expect(confirmed.footprint.source).toBe("template");
  });

  it("renders the shared DE notice in the sources picker", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      templateLibs: ONE_LIB,
      cadAvailable: CAD_UNAVAILABLE,
    });
    expect(panel.querySelector(`[${OVERRIDE_CAD_UNAVAILABLE_ATTR}]`)?.textContent)
      .toBe(CAD_UNAVAILABLE_MESSAGE);
  });

  it("leaves the EasyEDA option in place when EasyEDA is available (no regression)", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      templateLibs: ONE_LIB,
      cadAvailable: CAD_BOTH_AVAILABLE,
    });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    expect(Array.from(sym.options).map((o) => o.value)).toContain(EASYEDA_OPTION_VALUE);
    expect(sym.value).toBe(EASYEDA_OPTION_VALUE);
    expect(panel.querySelector(`[${OVERRIDE_CAD_UNAVAILABLE_ATTR}]`)).toBeNull();
  });
});

describe("buildRegisterImportEditor — editor forcing in unavailable mode (Issue #47)", () => {
  const TPL_SYM = "/home/user/templates/MyTemplates.kicad_sym";

  it("defaults BOTH selects to a template option when easyedaUnavailable is true and no initial source supplied", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      easyedaUnavailable: true,
    });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    expect(sym.value).not.toBe(EASYEDA_OPTION_VALUE);
    expect(sym.value.startsWith("template:")).toBe(true);
    expect(fp.value).not.toBe(EASYEDA_OPTION_VALUE);
    expect(fp.value.startsWith("template:")).toBe(true);
  });

  it("respects an initial template source even in unavailable mode", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      easyedaUnavailable: true,
      initialSymbolSource: { source: "template", libPath: TPL_SYM, name: "C0805" },
      initialFootprintSource: { source: "template", libPath: TPL_SYM, name: "C0805_Std" },
    });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    expect(sym.value).toBe(`template:${TPL_SYM}:C0805`);
    expect(fp.value).toBe(`template:${TPL_SYM}:C0805_Std`);
  });

  it("falls back to EasyEDA defaults when easyedaUnavailable is false (no regression)", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
    });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    expect(sym.value).toBe(EASYEDA_OPTION_VALUE);
    expect(fp.value).toBe(EASYEDA_OPTION_VALUE);
  });
});

describe("renderRegisterImportEditor — Issue #49 modal width bump", () => {
  it("mounts with maxWidthPx=1080 so the 4-column layout fits without horizontal scroll", () => {
    const row = (() => {
      const r = buildAnchorCardRow(document, { colSpan: 1 });
      const table = document.createElement("table");
      const tbody = document.createElement("tbody");
      tbody.appendChild(r);
      table.appendChild(tbody);
      document.body.appendChild(table);
      return r;
    })();
    renderRegisterImportEditor(row, { templateLibs: EMPTY_LIBS });
    const modal = document.getElementById("k2c-register-editor-modal");
    // ``mountCsModal`` writes the width onto the panel; the value comes through
    // as either ``max-width: 1080px`` or ``width: 1080px`` depending on the
    // helper. Either way the 1080 token must show up in the inline cssText.
    expect(modal).toBeTruthy();
    const panel = modal.querySelector('[style*="1080"]') || modal;
    expect(panel.outerHTML).toContain("1080");
  });
});

/* -------------------------------------------------------------------------- */
/*  Issue #49 — 4-column Import-Editor (symbol/footprint LIST + search)       */
/* -------------------------------------------------------------------------- */

const FP_TPL = "/home/user/templates/MyTemplates.kicad_sym";
const FP_MANY = {
  [FP_TPL]: ["R0603_1608Metric", "C0805_2012Metric", "SOIC-8_3.9x4.9mm", "QFN-16_3x3mm"],
};

describe("buildRegisterImportEditor — footprint LIST (#49)", () => {
  it("renders the footprint list host + one item per footprint plus the EasyEDA row", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
    });
    const host = panel.querySelector(`[${OVERRIDE_REGISTER_FOOTPRINT_LIST_ATTR}]`);
    expect(host).toBeTruthy();
    const values = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    expect(values[0]).toBe(EASYEDA_OPTION_VALUE);
    expect(values).toContain(`template:${FP_TPL}:R0603_HandSolder`);
    expect(values).toContain(`template:${FP_TPL}:C0805_Std`);
  });

  it("clicking a footprint LIST row updates the hidden fp <select> + footprintSource round-trips through collectRegisterEditorRule", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
    });
    const target = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR}]`),
    ).find((i) => i.dataset.value === `template:${FP_TPL}:R0603_HandSolder`);
    expect(target).toBeTruthy();
    target.click();
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    expect(fp.value).toBe(`template:${FP_TPL}:R0603_HandSolder`);
    const payload = collectRegisterEditorRule(panel, "Passives");
    expect(payload.rule.footprintSource).toEqual({
      source: "template",
      libPath: FP_TPL,
      name: "R0603_HandSolder",
    });
  });

  it("hides the visible footprint <select> — the LIST replaces it as the user-facing chooser", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
    });
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    expect(fp.style.display).toBe("none");
  });

  it("clicking the EasyEDA row routes back to the EasyEDA footprint default", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      initialFootprintSource: { source: "template", libPath: FP_TPL, name: "C0805_Std" },
    });
    const easyedaRow = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR}]`),
    ).find((i) => i.dataset.value === EASYEDA_OPTION_VALUE);
    easyedaRow.click();
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    expect(fp.value).toBe(EASYEDA_OPTION_VALUE);
    expect(collectRegisterEditorRule(panel, "X").rule.footprintSource).toEqual({
      source: "easyeda",
    });
  });
});

describe("buildRegisterImportEditor — footprint show-all + packageHint (#49)", () => {
  it("with no packageHint, the default subset IS show-all (no surprise hiding)", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: FP_MANY,
    });
    const values = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    // Every footprint should appear when no hint is supplied.
    expect(values).toContain(`template:${FP_TPL}:R0603_1608Metric`);
    expect(values).toContain(`template:${FP_TPL}:SOIC-8_3.9x4.9mm`);
    expect(values).toContain(`template:${FP_TPL}:QFN-16_3x3mm`);
  });

  it("packageHint narrows the default subset to footprints whose name contains the hint", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: FP_MANY,
      packageHint: "SOIC",
    });
    const values = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    expect(values).toContain(`template:${FP_TPL}:SOIC-8_3.9x4.9mm`);
    expect(values).not.toContain(`template:${FP_TPL}:R0603_1608Metric`);
    expect(values).not.toContain(`template:${FP_TPL}:QFN-16_3x3mm`);
    // EasyEDA row always present.
    expect(values).toContain(EASYEDA_OPTION_VALUE);
  });

  it("packageHint matches case-insensitively", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: FP_MANY,
      packageHint: "soic",
    });
    const values = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    expect(values).toContain(`template:${FP_TPL}:SOIC-8_3.9x4.9mm`);
  });

  it("'alle Footprints anzeigen' overrides the packageHint subset", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: FP_MANY,
      packageHint: "SOIC",
    });
    const showAll = panel.querySelector(`[${OVERRIDE_REGISTER_FP_SHOWALL_ATTR}]`);
    showAll.checked = true;
    showAll.dispatchEvent(new Event("change"));
    const values = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    expect(values).toContain(`template:${FP_TPL}:R0603_1608Metric`);
    expect(values).toContain(`template:${FP_TPL}:QFN-16_3x3mm`);
  });

  it("auto-ticks 'alle Footprints anzeigen' when the prefilled footprint is outside the packageHint subset", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: FP_MANY,
      packageHint: "SOIC",
      initialFootprintSource: {
        source: "template",
        libPath: FP_TPL,
        name: "QFN-16_3x3mm",
      },
    });
    const showAll = panel.querySelector(`[${OVERRIDE_REGISTER_FP_SHOWALL_ATTR}]`);
    expect(showAll.checked).toBe(true);
    const values = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    expect(values).toContain(`template:${FP_TPL}:QFN-16_3x3mm`);
  });
});

describe("buildRegisterImportEditor — symbol search (#49)", () => {
  const SYM_MANY = {
    [FP_TPL]: ["R0603", "C0805", "L_Inductor", "Op_Amp_Generic"],
    "/home/user/templates/Other.kicad_sym": ["LED_RED", "Diode_Schottky"],
  };

  it("the symbol search input has the expected attr + placeholder", () => {
    const panel = buildRegisterImportEditor(document, { templateLibs: SYM_MANY });
    const input = panel.querySelector(`[${OVERRIDE_REGISTER_SYMBOL_SEARCH_ATTR}]`);
    expect(input).toBeTruthy();
    expect(input.tagName).toBe("INPUT");
    expect(input.placeholder).toContain("Symbol");
  });

  it("substring-filters the template LIST live on each input event, EasyEDA row always shown", () => {
    const panel = buildRegisterImportEditor(document, { templateLibs: SYM_MANY });
    // Reveal all templates first so we have something to filter from.
    const showAll = panel.querySelector(`[${OVERRIDE_REGISTER_SHOWALL_ATTR}]`);
    showAll.checked = true;
    showAll.dispatchEvent(new Event("change"));
    const input = panel.querySelector(`[${OVERRIDE_REGISTER_SYMBOL_SEARCH_ATTR}]`);
    input.value = "diode";
    input.dispatchEvent(new Event("input"));
    const values = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_TEMPLATE_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    expect(values).toContain(EASYEDA_OPTION_VALUE);
    expect(values).toContain(
      `template:/home/user/templates/Other.kicad_sym:Diode_Schottky`,
    );
    expect(values).not.toContain(`template:${FP_TPL}:R0603`);
    expect(values).not.toContain(`template:${FP_TPL}:C0805`);
  });

  it("non-empty query searches the FULL library pool — category match shortlist is ignored", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: SYM_MANY,
      // Category shortlist only includes R0603; without search the list
      // collapses to ``EasyEDA + R0603``.
      templateCategoriesByLib: { [FP_TPL]: { R0603: "Resistors" } },
      categoryPath: "Resistors",
    });
    // Confirm the default-shortlist behavior before searching.
    const beforeValues = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_TEMPLATE_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    expect(beforeValues).not.toContain(`template:${FP_TPL}:Op_Amp_Generic`);
    // A query for "op_amp" must reach into the full pool, NOT just the
    // category-matched shortlist.
    const input = panel.querySelector(`[${OVERRIDE_REGISTER_SYMBOL_SEARCH_ATTR}]`);
    input.value = "op_amp";
    input.dispatchEvent(new Event("input"));
    const values = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_TEMPLATE_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    expect(values).toContain(`template:${FP_TPL}:Op_Amp_Generic`);
  });

  it("clearing the query restores the category-matched default", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: SYM_MANY,
      templateCategoriesByLib: { [FP_TPL]: { R0603: "Resistors" } },
      categoryPath: "Resistors",
    });
    const input = panel.querySelector(`[${OVERRIDE_REGISTER_SYMBOL_SEARCH_ATTR}]`);
    input.value = "op_amp";
    input.dispatchEvent(new Event("input"));
    input.value = "";
    input.dispatchEvent(new Event("input"));
    const values = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_TEMPLATE_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    expect(values).toContain(`template:${FP_TPL}:R0603`);
    expect(values).not.toContain(`template:${FP_TPL}:Op_Amp_Generic`);
  });
});

describe("buildRegisterImportEditor — footprint search (#49)", () => {
  it("the footprint search input has the expected attr + placeholder", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: FP_MANY,
    });
    const input = panel.querySelector(`[${OVERRIDE_REGISTER_FOOTPRINT_SEARCH_ATTR}]`);
    expect(input).toBeTruthy();
    expect(input.tagName).toBe("INPUT");
    expect(input.placeholder).toContain("Footprint");
  });

  it("substring-filters the footprint LIST live, EasyEDA row always shown", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: FP_MANY,
    });
    const input = panel.querySelector(`[${OVERRIDE_REGISTER_FOOTPRINT_SEARCH_ATTR}]`);
    input.value = "QFN";
    input.dispatchEvent(new Event("input"));
    const values = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    expect(values).toContain(EASYEDA_OPTION_VALUE);
    expect(values).toContain(`template:${FP_TPL}:QFN-16_3x3mm`);
    expect(values).not.toContain(`template:${FP_TPL}:R0603_1608Metric`);
    expect(values).not.toContain(`template:${FP_TPL}:SOIC-8_3.9x4.9mm`);
  });

  it("non-empty query overrides the packageHint default subset", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: FP_MANY,
      packageHint: "SOIC",
    });
    const input = panel.querySelector(`[${OVERRIDE_REGISTER_FOOTPRINT_SEARCH_ATTR}]`);
    input.value = "QFN";
    input.dispatchEvent(new Event("input"));
    const values = Array.from(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR}]`),
    ).map((i) => i.dataset.value);
    expect(values).toContain(`template:${FP_TPL}:QFN-16_3x3mm`);
    // Default SOIC subset would have hidden QFN; the search lifted that.
    expect(values).not.toContain(`template:${FP_TPL}:R0603_1608Metric`);
  });
});

describe("buildRegisterImportEditor — easyedaUnavailable forcing on BOTH lists (#49 + #47)", () => {
  it("neither hidden select carries EasyEDA as the selected value, both lists render the forced row as selected", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      templateLibsFootprints: ONE_LIB_FP,
      easyedaUnavailable: true,
    });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    const fp = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
    expect(sym.value).not.toBe(EASYEDA_OPTION_VALUE);
    expect(fp.value).not.toBe(EASYEDA_OPTION_VALUE);
    // The FORCED row carries the accent treatment in both lists.
    const fpRows = panel.querySelectorAll(`[${OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR}]`);
    const selectedFp = Array.from(fpRows).find(
      (r) => r.dataset.value === fp.value,
    );
    expect(selectedFp).toBeTruthy();
  });
});
