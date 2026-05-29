import { describe, it, expect, beforeEach } from "vitest";
import {
  buildOverridePanel,
  renderOverridePanel,
  readPanelSelection,
  selectionToOverrides,
  decodeSourceValue,
  encodeTemplateValue,
  findMountedPanel,
  SOURCE_VALUE_EASYEDA,
} from "./overridePanel.js";
import { buildAnchorCardRow } from "./anchorCard.js";

function mountAnchorRow() {
  const row = buildAnchorCardRow(document, { colSpan: 1 });
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  tbody.appendChild(row);
  table.appendChild(tbody);
  document.body.appendChild(table);
  return row;
}

const FIXTURE_TEMPLATE_LIBS = {
  "C:/Templates/MyTemplates.kicad_sym": ["R_0603_HiCount", "C_0603_HiCount"],
  "/home/u/work/SharedTemplates.kicad_sym": ["U_OpAmp_TSSOP14"],
  "/home/u/empty.kicad_sym": [],
};

describe("encodeTemplateValue / decodeSourceValue", () => {
  it("round-trips a Linux template path", () => {
    const value = encodeTemplateValue("/home/u/work/SharedTemplates.kicad_sym", "U_OpAmp_TSSOP14");
    expect(decodeSourceValue(value)).toEqual({
      source: "template",
      libPath: "/home/u/work/SharedTemplates.kicad_sym",
      name: "U_OpAmp_TSSOP14",
    });
  });

  it("round-trips a Windows path that itself contains a colon", () => {
    const value = encodeTemplateValue("C:/Templates/MyTemplates.kicad_sym", "R_0603_HiCount");
    expect(decodeSourceValue(value)).toEqual({
      source: "template",
      libPath: "C:/Templates/MyTemplates.kicad_sym",
      name: "R_0603_HiCount",
    });
  });

  it("decodes the easyeda sentinel", () => {
    expect(decodeSourceValue(SOURCE_VALUE_EASYEDA)).toEqual({ source: "easyeda" });
  });

  it("rejects garbage input rather than guessing", () => {
    expect(decodeSourceValue("template:")).toBeNull();
    expect(decodeSourceValue("template:onlyone")).toBeNull();
    expect(decodeSourceValue("")).toBeNull();
    expect(decodeSourceValue(null)).toBeNull();
  });
});

describe("buildOverridePanel", () => {
  it("renders keep-EasyEDA plus one optgroup per non-empty template library", () => {
    const panel = buildOverridePanel({ templateLibs: FIXTURE_TEMPLATE_LIBS, doc: document });
    const symbolSel = panel.querySelector('[data-k2c-override-select="symbol"]');
    const footprintSel = panel.querySelector('[data-k2c-override-select="footprint"]');
    expect(symbolSel).toBeTruthy();
    expect(footprintSel).toBeTruthy();

    // First option is the keep-EasyEDA sentinel — gives users a "do nothing"
    // default that matches Phase 2's default-path slice.
    expect(symbolSel.options[0].value).toBe(SOURCE_VALUE_EASYEDA);
    expect(symbolSel.options[0].textContent).toBe("keep EasyEDA");

    // Two non-empty Template Libraries → two optgroups; the empty one is
    // suppressed so the user does not see an empty heading.
    const groups = symbolSel.querySelectorAll("optgroup");
    expect(groups.length).toBe(2);
    const labels = Array.from(groups).map((g) => g.label).sort();
    expect(labels).toEqual(["MyTemplates", "SharedTemplates"]);

    const allOptionValues = Array.from(symbolSel.options).map((o) => o.value);
    expect(allOptionValues).toContain(
      encodeTemplateValue("C:/Templates/MyTemplates.kicad_sym", "R_0603_HiCount"),
    );
    expect(allOptionValues).toContain(
      encodeTemplateValue("/home/u/work/SharedTemplates.kicad_sym", "U_OpAmp_TSSOP14"),
    );

    // Symbol and Footprint selects must be populated identically — both
    // layers are independently overridable per V3-SPEC.md §2.
    expect(footprintSel.options.length).toBe(symbolSel.options.length);
  });

  it("survives when no template libraries are registered (keep-EasyEDA is still selectable)", () => {
    const panel = buildOverridePanel({ templateLibs: {}, doc: document });
    const symbolSel = panel.querySelector('[data-k2c-override-select="symbol"]');
    expect(symbolSel.options.length).toBe(1);
    expect(symbolSel.options[0].value).toBe(SOURCE_VALUE_EASYEDA);
  });

  it("exposes a Confirm and a Cancel button for the caller to wire", () => {
    const panel = buildOverridePanel({ templateLibs: FIXTURE_TEMPLATE_LIBS, doc: document });
    expect(panel.querySelector('[data-k2c-override-action="confirm"]')).toBeTruthy();
    expect(panel.querySelector('[data-k2c-override-action="cancel"]')).toBeTruthy();
  });
});

describe("selectionToOverrides", () => {
  it("produces an EasyEDA override for the default selection", () => {
    expect(selectionToOverrides({ symbol: SOURCE_VALUE_EASYEDA, footprint: SOURCE_VALUE_EASYEDA }))
      .toEqual({
        symbol: { source: "easyeda" },
        footprint: { source: "easyeda" },
      });
  });

  it("produces a template payload that the Native Host can consume directly", () => {
    const symValue = encodeTemplateValue("/u/Templates.kicad_sym", "R_0603_HiCount");
    expect(selectionToOverrides({ symbol: symValue, footprint: SOURCE_VALUE_EASYEDA })).toEqual({
      symbol: { source: "template", libPath: "/u/Templates.kicad_sym", name: "R_0603_HiCount" },
      footprint: { source: "easyeda" },
    });
  });

  it("falls back to EasyEDA when the encoded value is missing or malformed", () => {
    expect(selectionToOverrides({})).toEqual({
      symbol: { source: "easyeda" },
      footprint: { source: "easyeda" },
    });
    expect(selectionToOverrides({ symbol: "template:nothing", footprint: "" })).toEqual({
      symbol: { source: "easyeda" },
      footprint: { source: "easyeda" },
    });
  });
});

describe("renderOverridePanel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("mounts inline next to the Anchor Card row's actions cell", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, { templateLibs: FIXTURE_TEMPLATE_LIBS });
    expect(panel).toBeTruthy();
    expect(findMountedPanel(row)).toBe(panel);
    const actionsCell = row.querySelector('[data-k2c-anchor-actions="true"]');
    expect(actionsCell.contains(panel)).toBe(true);
  });

  it("forwards the user's choice to onConfirm as an overrides payload", () => {
    const row = mountAnchorRow();
    const events = [];
    const panel = renderOverridePanel(row, {
      templateLibs: FIXTURE_TEMPLATE_LIBS,
      onConfirm: (ev) => events.push(ev),
    });
    const symSel = panel.querySelector('[data-k2c-override-select="symbol"]');
    symSel.value = encodeTemplateValue(
      "C:/Templates/MyTemplates.kicad_sym",
      "R_0603_HiCount",
    );

    panel.querySelector('[data-k2c-override-action="confirm"]').click();

    expect(events).toHaveLength(1);
    expect(events[0].overrides).toEqual({
      symbol: {
        source: "template",
        libPath: "C:/Templates/MyTemplates.kicad_sym",
        name: "R_0603_HiCount",
      },
      footprint: { source: "easyeda" },
    });
    // Confirm dismisses the panel so Phase 2's progress can render in the
    // row's status node without panel chrome covering it.
    expect(findMountedPanel(row)).toBeNull();
  });

  it("removes the panel on Cancel and fires onCancel — onConfirm is not called", () => {
    const row = mountAnchorRow();
    const confirms = [];
    const cancels = [];
    renderOverridePanel(row, {
      templateLibs: FIXTURE_TEMPLATE_LIBS,
      onConfirm: (ev) => confirms.push(ev),
      onCancel: (ev) => cancels.push(ev),
    });

    row.querySelector('[data-k2c-override-action="cancel"]').click();

    expect(confirms).toEqual([]);
    expect(cancels).toHaveLength(1);
    expect(findMountedPanel(row)).toBeNull();
  });

  it("idempotent re-render replaces the previous panel instead of stacking", () => {
    const row = mountAnchorRow();
    renderOverridePanel(row, { templateLibs: FIXTURE_TEMPLATE_LIBS });
    renderOverridePanel(row, { templateLibs: FIXTURE_TEMPLATE_LIBS });

    // Only one panel mounted, second call wins
    expect(row.querySelectorAll('[data-k2c-override-panel="true"]').length).toBe(1);
  });

  it("readPanelSelection returns the EasyEDA defaults for a fresh panel", () => {
    const row = mountAnchorRow();
    const panel = renderOverridePanel(row, { templateLibs: FIXTURE_TEMPLATE_LIBS });
    expect(readPanelSelection(panel)).toEqual({
      symbol: SOURCE_VALUE_EASYEDA,
      footprint: SOURCE_VALUE_EASYEDA,
    });
  });
});
