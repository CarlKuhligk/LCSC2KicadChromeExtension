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
  OVERRIDE_IMPORT_ATTR,
  OVERRIDE_MODIFY_ATTR,
  OVERRIDE_ONECLICK_PREVIEW_ATTR,
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

  it("starts with one empty mapping row", () => {
    const panel = buildRegisterImportEditor(document, {});
    const rows = panel.querySelectorAll(
      `[${OVERRIDE_REGISTER_MAPPING_ROW_ATTR}="true"]`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector(`[${OVERRIDE_REGISTER_MAPPING_LCSC_ATTR}]`).value).toBe("");
    expect(rows[0].querySelector(`[${OVERRIDE_REGISTER_MAPPING_KICAD_ATTR}]`).value).toBe("");
  });

  it("'+ Zeile' appends another empty mapping row", () => {
    const panel = buildRegisterImportEditor(document, {});
    panel.querySelector(`[${OVERRIDE_REGISTER_MAPPING_ADD_ATTR}]`).click();
    panel.querySelector(`[${OVERRIDE_REGISTER_MAPPING_ADD_ATTR}]`).click();
    expect(
      panel.querySelectorAll(`[${OVERRIDE_REGISTER_MAPPING_ROW_ATTR}="true"]`).length,
    ).toBe(3);
  });

  it("publishes LCSC labels as a datalist so the user can pick from the snapshot", () => {
    const panel = buildRegisterImportEditor(document, { pageParams: PAGE_PARAMS });
    const datalistOptions = Array.from(panel.querySelectorAll("datalist option")).map(
      (o) => o.value,
    );
    expect(datalistOptions).toContain("Resistance");
    expect(datalistOptions).toContain("Tolerance");
    expect(datalistOptions).toContain("Power(Watts)");
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
});

describe("collectRegisterEditorRule", () => {
  it("returns the chosen symbolSource + labelMapping", () => {
    const panel = buildRegisterImportEditor(document, {
      templateLibs: ONE_LIB,
      pageParams: PAGE_PARAMS,
    });
    const sym = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
    sym.value = "template:/home/user/templates/MyTemplates.kicad_sym:R0603";
    const row = panel.querySelector(`[${OVERRIDE_REGISTER_MAPPING_ROW_ATTR}="true"]`);
    row.querySelector(`[${OVERRIDE_REGISTER_MAPPING_LCSC_ATTR}]`).value = "Resistance";
    row.querySelector(`[${OVERRIDE_REGISTER_MAPPING_KICAD_ATTR}]`).value = "Value";
    const payload = collectRegisterEditorRule(panel, "Passives/Resistors");
    expect(payload).toEqual({
      categoryPath: "Passives/Resistors",
      rule: {
        symbolSource: {
          source: "template",
          libPath: "/home/user/templates/MyTemplates.kicad_sym",
          name: "R0603",
        },
        labelMapping: { Resistance: "Value" },
      },
    });
  });

  it("drops mapping rows where the LCSC label or the KiCad property is blank", () => {
    const panel = buildRegisterImportEditor(document, {});
    // Three rows; two of them half-filled.
    panel.querySelector(`[${OVERRIDE_REGISTER_MAPPING_ADD_ATTR}]`).click();
    panel.querySelector(`[${OVERRIDE_REGISTER_MAPPING_ADD_ATTR}]`).click();
    const rows = panel.querySelectorAll(
      `[${OVERRIDE_REGISTER_MAPPING_ROW_ATTR}="true"]`,
    );
    rows[0].querySelector(`[${OVERRIDE_REGISTER_MAPPING_LCSC_ATTR}]`).value = "Resistance";
    rows[0].querySelector(`[${OVERRIDE_REGISTER_MAPPING_KICAD_ATTR}]`).value = "Value";
    // Row 1: blank LCSC
    rows[1].querySelector(`[${OVERRIDE_REGISTER_MAPPING_KICAD_ATTR}]`).value = "Power";
    // Row 2: blank KiCad
    rows[2].querySelector(`[${OVERRIDE_REGISTER_MAPPING_LCSC_ATTR}]`).value = "Tolerance";
    const payload = collectRegisterEditorRule(panel, "Passives");
    expect(payload.rule.labelMapping).toEqual({ Resistance: "Value" });
  });

  it("defaults to symbolSource={source:'easyeda'} when the user did not change the dropdown", () => {
    const panel = buildRegisterImportEditor(document, { templateLibs: ONE_LIB });
    const payload = collectRegisterEditorRule(panel, "Passives");
    expect(payload.rule.symbolSource).toEqual({ source: "easyeda" });
  });
});

describe("renderRegisterImportEditor", () => {
  it("mounts the editor beneath the anchor row and returns it", () => {
    const row = mountAnchorRow();
    const editor = renderRegisterImportEditor(row, {
      templateLibs: EMPTY_LIBS,
      pageParams: PAGE_PARAMS,
      categoryPath: "Passives/Resistors",
    });
    expect(editor).toBeTruthy();
    expect(editor.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("registerEditor");
    expect(row.parentNode.contains(editor)).toBe(true);
  });

  it("replaces an existing white-state Register-Prompt with the editor (same DOM slot)", () => {
    const row = mountAnchorRow();
    renderOverridePanel(row, { match: { state: "white" } });
    renderRegisterImportEditor(row, { templateLibs: EMPTY_LIBS });
    // Only the editor remains.
    const panels = row.parentNode.querySelectorAll(
      `[${OVERRIDE_PANEL_ATTR}="true"]`,
    );
    expect(panels.length).toBe(1);
    expect(panels[0].getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("registerEditor");
  });

  it("is idempotent — a second render returns the existing editor", () => {
    const row = mountAnchorRow();
    const first = renderRegisterImportEditor(row, {});
    const second = renderRegisterImportEditor(row, {});
    expect(second).toBe(first);
    expect(
      row.parentNode.querySelectorAll(`[${OVERRIDE_PANEL_ATTR}="true"]`).length,
    ).toBe(1);
  });

  it("Übernehmen fires onSave with the collected rule and removes the panel", () => {
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
    const mappingRow = editor.querySelector(
      `[${OVERRIDE_REGISTER_MAPPING_ROW_ATTR}="true"]`,
    );
    mappingRow.querySelector(`[${OVERRIDE_REGISTER_MAPPING_LCSC_ATTR}]`).value =
      "Resistance";
    mappingRow.querySelector(`[${OVERRIDE_REGISTER_MAPPING_KICAD_ATTR}]`).value =
      "Value";
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
          labelMapping: { Resistance: "Value" },
        },
      },
    ]);
    expect(row.parentNode.querySelector(`[${OVERRIDE_PANEL_ATTR}="true"]`)).toBeNull();
  });

  it("Abbrechen fires onCancel and removes the panel", () => {
    const row = mountAnchorRow();
    const cancelled = [];
    const editor = renderRegisterImportEditor(row, {
      onCancel: () => cancelled.push(true),
    });
    editor.querySelector(`[${OVERRIDE_REGISTER_CANCEL_ATTR}]`).click();
    expect(cancelled).toEqual([true]);
    expect(row.parentNode.querySelector(`[${OVERRIDE_PANEL_ATTR}="true"]`)).toBeNull();
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

  it("[Modifizieren] entry: prefills mapping rows with the matched rule's labelMapping", () => {
    const row = mountAnchorRow();
    const editor = renderRegisterImportEditor(row, {
      templateLibs: ONE_LIB,
      initialLabelMapping: { Resistance: "Value", Tolerance: "Tolerance" },
    });
    const rows = editor.querySelectorAll(
      `[${OVERRIDE_REGISTER_MAPPING_ROW_ATTR}="true"]`,
    );
    expect(rows.length).toBe(2);
    expect(
      rows[0].querySelector(`[${OVERRIDE_REGISTER_MAPPING_LCSC_ATTR}]`).value,
    ).toBe("Resistance");
    expect(
      rows[0].querySelector(`[${OVERRIDE_REGISTER_MAPPING_KICAD_ATTR}]`).value,
    ).toBe("Value");
    expect(
      rows[1].querySelector(`[${OVERRIDE_REGISTER_MAPPING_LCSC_ATTR}]`).value,
    ).toBe("Tolerance");
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

  it("non-green states still get the legacy sources panel (back-compat)", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, {
      match: { state: "yellow", ruleKey: "Passives/Resistors", rule: GREEN_RULE },
      templateLibs: EMPTY_LIBS,
    });
    expect(panel.getAttribute(OVERRIDE_PANEL_MODE_ATTR)).toBe("sources");
    expect(panel.querySelector(`[${OVERRIDE_IMPORT_ATTR}]`)).toBeNull();
  });
});
