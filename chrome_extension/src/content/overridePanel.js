"use strict";

import { mountCsModal } from "./dialog.js";

/**
 * V3 **Override Panel** — inline UI between Phase 1 Fetch and Phase 2
 * Conversion (Issue #5). Replaces V2's 5-dialog cascade with one inline
 * surface attached to the Anchor Card.
 *
 * Scope of this slice: Symbol-source and Footprint-source selection only.
 * Category Rules (#8), Pin↔Pad Map (#9), Overwrite confirm (#10), Datasheet
 * preview (#11) and the Customize Button (#12) dock onto this same panel
 * in later slices.
 *
 * The selection is encoded as a flat ``"<source>:<libPath>:<name>"`` option
 * value so a single ``<select>`` works for both "EasyEDA" and "Template-X".
 * ``selectionToOverrides`` parses that back into the structured shape the
 * Native Host's Phase 2 RPC expects (see ``native_host/phase2.py``):
 *
 *   {
 *     symbol:    { source: "easyeda" } | { source: "template", libPath, name },
 *     footprint: { source: "easyeda" } | { source: "template", libPath, name }
 *   }
 *
 * **Always Re-Resolve** is enforced backend-side: the panel only stores the
 * template name + lib path, never the file bytes. Phase 2 reads the template
 * fresh from disk on every conversion (V3-SPEC.md §"Always Re-Resolve").
 */

export const OVERRIDE_PANEL_ATTR = "data-k2c-override-panel";
export const OVERRIDE_PANEL_ROW_ATTR = "data-k2c-override-panel-row";
export const OVERRIDE_PANEL_MODE_ATTR = "data-k2c-override-panel-mode";
export const OVERRIDE_SYMBOL_SELECT_ATTR = "data-k2c-override-symbol";
export const OVERRIDE_FOOTPRINT_SELECT_ATTR = "data-k2c-override-footprint";
export const OVERRIDE_CONFIRM_ATTR = "data-k2c-override-confirm";
export const OVERRIDE_CANCEL_ATTR = "data-k2c-override-cancel";
/** Register-Prompt buttons (⚪ white state, ADR-0006). */
export const OVERRIDE_EASYEDA_ONLY_ATTR = "data-k2c-override-easyeda-only";
export const OVERRIDE_REGISTER_ATTR = "data-k2c-override-register";
/** Register Import-Editor controls (Issue #28). */
export const OVERRIDE_REGISTER_EDITOR_ATTR = "data-k2c-register-editor";
export const OVERRIDE_REGISTER_SAVE_ATTR = "data-k2c-register-save";
export const OVERRIDE_REGISTER_CANCEL_ATTR = "data-k2c-register-cancel";
export const OVERRIDE_REGISTER_MAPPING_ROW_ATTR = "data-k2c-register-mapping-row";
export const OVERRIDE_REGISTER_MAPPING_LCSC_ATTR = "data-k2c-register-mapping-lcsc";
export const OVERRIDE_REGISTER_MAPPING_KICAD_ATTR = "data-k2c-register-mapping-kicad";
export const OVERRIDE_REGISTER_MAPPING_ADD_ATTR = "data-k2c-register-mapping-add";
export const OVERRIDE_REGISTER_PROP_PREVIEW_ATTR = "data-k2c-register-prop-preview";
/** 🟢 One-Click panel controls (Issue #29). */
export const OVERRIDE_IMPORT_ATTR = "data-k2c-override-import";
export const OVERRIDE_MODIFY_ATTR = "data-k2c-override-modify";
export const OVERRIDE_ONECLICK_PREVIEW_ATTR = "data-k2c-override-oneclick-preview";
/** 🟡 Low-Confidence panel controls (Issue #31). */
export const OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR = "data-k2c-yellow-keep-easyeda";
export const OVERRIDE_YELLOW_OPEN_EDITOR_ATTR = "data-k2c-yellow-open-editor";
export const OVERRIDE_YELLOW_HINT_ATTR = "data-k2c-yellow-hint";

export const EASYEDA_OPTION_VALUE = "easyeda";
const TEMPLATE_VALUE_PREFIX = "template:";

function libBasename(libPath) {
  const tail = String(libPath || "").replace(/^.*[/\\]/, "");
  return tail.replace(/\.kicad_sym$/i, "") || libPath;
}

function encodeTemplateValue(libPath, name) {
  return `${TEMPLATE_VALUE_PREFIX}${libPath}:${name}`;
}

function populateSelect(select, doc, templateLibs) {
  const easyeda = doc.createElement("option");
  easyeda.value = EASYEDA_OPTION_VALUE;
  easyeda.textContent = "Keep EasyEDA";
  select.appendChild(easyeda);

  const libs = templateLibs || {};
  for (const libPath of Object.keys(libs)) {
    const names = Array.isArray(libs[libPath]) ? libs[libPath] : [];
    if (!names.length) continue;
    const group = doc.createElement("optgroup");
    group.label = libBasename(libPath);
    for (const name of names) {
      const opt = doc.createElement("option");
      opt.value = encodeTemplateValue(libPath, name);
      opt.textContent = name;
      group.appendChild(opt);
    }
    select.appendChild(group);
  }
}

/**
 * Build the ⚪ **white-state Register-Prompt** (ADR-0006, Issue #25).
 *
 * Rendered when ``matchResult.state === "white"`` — i.e. no Category Rule
 * matches the LCSC part's category. The prompt offers two actions:
 *
 *   1. **„nur EasyEDA"** — proceed with the default EasyEDA conversion,
 *      no learning. Triggers the existing Phase 2 flow with EasyEDA on
 *      both Layers (no regression vs the pre-Confidence behaviour).
 *   2. **„Registrieren"** — open the Import-Editor for the learning act
 *      (Issue #28). This slice wires the button; the Register UI lands
 *      with that follow-up issue. ``onRegister`` is fired with no args.
 *
 * Both buttons remove the panel after firing their callback so a second
 * click on Download re-opens a fresh prompt.
 *
 * @param {Document} doc
 * @param {{ onEasyedaOnly?: () => void, onRegister?: () => void }} [opts]
 */
export function buildRegisterPrompt(doc, opts = {}) {
  const panel = doc.createElement("div");
  panel.setAttribute(OVERRIDE_PANEL_ATTR, "true");
  panel.setAttribute(OVERRIDE_PANEL_MODE_ATTR, "white");
  panel.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "gap:8px",
    "padding:10px 12px",
    "border:1px solid #cbd5e1",
    "border-radius:6px",
    "background:#f8fafc",
    "margin-top:6px",
    "font-size:12px",
    "color:#1e293b",
  ].join(";");

  const heading = doc.createElement("div");
  heading.textContent = "Neues Bauteil";
  heading.style.cssText =
    "font-weight:600;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#475569";
  panel.appendChild(heading);

  const body = doc.createElement("div");
  body.textContent =
    "Neues Bauteil — nur EasyEDA herunterladen ODER registrieren?";
  body.style.cssText = "line-height:1.4";
  panel.appendChild(body);

  const actions = doc.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:4px";

  const easyedaBtn = doc.createElement("button");
  easyedaBtn.type = "button";
  easyedaBtn.textContent = "nur EasyEDA";
  easyedaBtn.setAttribute(OVERRIDE_EASYEDA_ONLY_ATTR, "true");
  actions.appendChild(easyedaBtn);

  const registerBtn = doc.createElement("button");
  registerBtn.type = "button";
  registerBtn.textContent = "registrieren";
  registerBtn.setAttribute(OVERRIDE_REGISTER_ATTR, "true");
  actions.appendChild(registerBtn);

  panel.appendChild(actions);

  return panel;
}

function describeSymbolSource(symbolSource) {
  if (!symbolSource || symbolSource.source === "easyeda") {
    return "EasyEDA (default)";
  }
  if (symbolSource.source === "template") {
    const lib = libBasename(symbolSource.libPath);
    return symbolSource.name ? `${symbolSource.name} (${lib})` : lib;
  }
  return "—";
}

/**
 * Build the 🟢 **green-state One-Click Confirm-Preview** (ADR-0006,
 * Issue #29). Rendered when ``matchResult.state === "green"`` — a
 * registered Category Rule resolves the Symbol-Template against the
 * installed Template Library, the LCSC Category is recognised, the
 * Rule's ``labelMapping`` is non-empty and the aggregate confidence is
 * high. Two actions:
 *
 *   1. **[Import]** — start Phase 2 with the Rule's ``symbolSource`` and
 *      ``labelMapping`` baked in. No separate confirm, no countdown
 *      (ADR-0006 §3, ``§U3.3``): the preview IS the confirm.
 *   2. **[Modifizieren]** — open the Import-Editor (same component the
 *      Register flow uses) with the Rule's current values prefilled, so
 *      the special case is one edit and a save away.
 *
 * @param {Document} doc
 * @param {{
 *   ruleKey?: string | null,
 *   symbolSource?: object | null,
 *   labelMapping?: Record<string, string> | null,
 *   onImport?: () => void,
 *   onModify?: () => void,
 * }} [opts]
 */
export function buildOneClickPanel(doc, opts = {}) {
  const panel = doc.createElement("div");
  panel.setAttribute(OVERRIDE_PANEL_ATTR, "true");
  panel.setAttribute(OVERRIDE_PANEL_MODE_ATTR, "green");
  panel.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "gap:8px",
    "padding:10px 12px",
    "border:1px solid #bbf7d0",
    "border-radius:6px",
    "background:#f0fdf4",
    "margin-top:6px",
    "font-size:12px",
    "color:#14532d",
  ].join(";");

  const heading = doc.createElement("div");
  const ruleKey = typeof opts.ruleKey === "string" && opts.ruleKey ? opts.ruleKey : "";
  heading.textContent = ruleKey
    ? `Registriert: "${ruleKey}" — Ein-Klick`
    : "Registriert — Ein-Klick";
  heading.style.cssText =
    "font-weight:600;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#166534";
  panel.appendChild(heading);

  // Preview — Symbol Source + Label-Mapping summary so the user can see
  // what will be applied before clicking [Import] (ADR-0006: "the
  // resolved result is shown before the click").
  const preview = doc.createElement("div");
  preview.setAttribute(OVERRIDE_ONECLICK_PREVIEW_ATTR, "true");
  preview.style.cssText = "display:flex;flex-direction:column;gap:4px";

  const symbolLine = doc.createElement("div");
  symbolLine.style.cssText = "display:flex;gap:6px;align-items:baseline";
  const symLabel = doc.createElement("span");
  symLabel.textContent = "Symbol:";
  symLabel.style.cssText = "color:#166534;font-weight:500;min-width:64px";
  const symValue = doc.createElement("span");
  symValue.textContent = describeSymbolSource(opts.symbolSource);
  symValue.style.cssText = "color:#14532d";
  symbolLine.appendChild(symLabel);
  symbolLine.appendChild(symValue);
  preview.appendChild(symbolLine);

  const mapping = opts.labelMapping && typeof opts.labelMapping === "object"
    ? opts.labelMapping
    : {};
  const mappingEntries = Object.entries(mapping);
  if (mappingEntries.length) {
    const mappingLine = doc.createElement("div");
    mappingLine.style.cssText = "display:flex;gap:6px;align-items:baseline";
    const mapLabel = doc.createElement("span");
    mapLabel.textContent = "Mapping:";
    mapLabel.style.cssText = "color:#166534;font-weight:500;min-width:64px";
    const mapValue = doc.createElement("span");
    mapValue.textContent = mappingEntries
      .map(([k, v]) => `${k} → ${v}`)
      .join(", ");
    mapValue.style.cssText = "color:#14532d;word-break:break-word";
    mappingLine.appendChild(mapLabel);
    mappingLine.appendChild(mapValue);
    preview.appendChild(mappingLine);
  }

  panel.appendChild(preview);

  const actions = doc.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:4px";

  // [Modifizieren] sits to the LEFT of [Import] so the visual cursor
  // ends on the primary action (one-click ergonomics).
  const modifyBtn = doc.createElement("button");
  modifyBtn.type = "button";
  modifyBtn.textContent = "Modifizieren";
  modifyBtn.setAttribute(OVERRIDE_MODIFY_ATTR, "true");
  actions.appendChild(modifyBtn);

  const importBtn = doc.createElement("button");
  importBtn.type = "button";
  importBtn.textContent = "Import";
  importBtn.setAttribute(OVERRIDE_IMPORT_ATTR, "true");
  actions.appendChild(importBtn);

  panel.appendChild(actions);

  return panel;
}

/**
 * Build the 🟡 **Low-Confidence panel** (ADR-0006 §3.5, Issue #31). Rendered
 * when ``matchResult.state === "yellow"`` AND the user's
 * ``lowConfidenceBehaviour`` setting is ``"keepEasyeda"`` — the
 * keepEasyeda branch shows the heuristic suggestion as an unobtrusive
 * hint while defaulting the Confirm button to EasyEDA on both Layers.
 *
 * Two actions:
 *   1. **[EasyEDA übernehmen]** (primary, prefilled) — fires
 *      ``onEasyedaOnly`` with the EasyEDA fallback overrides baked in.
 *   2. **[Editor öffnen]** — escape hatch; fires ``onModify`` so the
 *      caller can swap this panel for the Import-Editor (the same one
 *      Register / 🟢 Modify use).
 *
 * ``buildYellowPanel`` only constructs the DOM; ``renderOverridePanel``
 * wires the buttons to the supplied callbacks. The ``"openEditor"``
 * branch of the setting bypasses this builder entirely and renders the
 * Import-Editor directly — see ``renderOverridePanel``.
 *
 * @param {Document} doc
 * @param {{
 *   ruleKey?: string | null,
 *   match?: object | null,
 *   onEasyedaOnly?: () => void,
 *   onModify?: () => void,
 * }} [opts]
 */
export function buildYellowPanel(doc, opts = {}) {
  const panel = doc.createElement("div");
  panel.setAttribute(OVERRIDE_PANEL_ATTR, "true");
  panel.setAttribute(OVERRIDE_PANEL_MODE_ATTR, "yellow");
  panel.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "gap:8px",
    "padding:10px 12px",
    "border:1px solid #fde68a",
    "border-radius:6px",
    "background:#fefce8",
    "margin-top:6px",
    "font-size:12px",
    "color:#713f12",
  ].join(";");

  const heading = doc.createElement("div");
  heading.textContent = "Niedrige Confidence — prüfen oder EasyEDA behalten";
  heading.style.cssText =
    "font-weight:600;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#92400e";
  panel.appendChild(heading);

  // Unobtrusive hint about the heuristic candidate the matcher picked.
  // KONZEPT.md §3.5 / §21 calls this „dezenter Hinweis" — one line, no
  // ceremony, the user keeps EasyEDA unless they actively click the
  // editor escape hatch.
  const match = opts.match || null;
  const symbolSrc = match?.symbol;
  const footprintSrc = match?.footprint;
  const hintLines = [];
  if (symbolSrc?.source === "auto-template-match") {
    hintLines.push(
      `Vorschlag Symbol: ${describeSymbolSource(symbolSrc.choice)}`,
    );
  }
  if (footprintSrc?.source === "auto-template-match") {
    hintLines.push(
      `Vorschlag Footprint: ${describeSymbolSource(footprintSrc.choice)}`,
    );
  }
  if (!hintLines.length && match?.ruleKey) {
    hintLines.push(`Regel „${match.ruleKey}" — Confidence niedrig`);
  }
  if (hintLines.length) {
    const hint = doc.createElement("div");
    hint.setAttribute(OVERRIDE_YELLOW_HINT_ATTR, "true");
    hint.style.cssText = "line-height:1.4;color:#78350f";
    hint.textContent = hintLines.join(" · ");
    panel.appendChild(hint);
  }

  const actions = doc.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:4px";

  const openEditorBtn = doc.createElement("button");
  openEditorBtn.type = "button";
  openEditorBtn.textContent = "Editor öffnen";
  openEditorBtn.setAttribute(OVERRIDE_YELLOW_OPEN_EDITOR_ATTR, "true");
  actions.appendChild(openEditorBtn);

  const keepEasyedaBtn = doc.createElement("button");
  keepEasyedaBtn.type = "button";
  keepEasyedaBtn.textContent = "EasyEDA übernehmen";
  keepEasyedaBtn.setAttribute(OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR, "true");
  actions.appendChild(keepEasyedaBtn);

  panel.appendChild(actions);

  return panel;
}

// Note: the V2-era manual label-mapping editor (buildMappingRow / collectMapping)
// was removed in the ADR-0006 refinement (2026-06-09). Metadata is now
// auto-upserted from the page snapshot; the editor shows a read-only preview
// instead of an editable LCSC→Property mapping table.

/**
 * Build the **Register Import-Editor** (Issue #28). Opens from the ⚪
 * Register-Prompt's „registrieren" button and lets the user author a
 * **Category Rule**:
 *
 *   - Symbol Source — same dropdown the override panel uses, populated
 *     from the Native Host's ``listTemplates`` so EasyEDA + every Template
 *     Library symbol appears as an option.
 *   - Label-Mapping rows — LCSC parameter labels (lifted from the page
 *     snapshot) mapped onto KiCad Symbol Property names. ``+ Zeile``
 *     appends another empty row; rows whose LCSC label or KiCad property
 *     is blank are dropped on save.
 *
 * Footprint/3D stay on the EasyEDA default in the Symbol-MVP — those
 * controls land with the footprint follow-up slice.
 *
 * **Prefill (Issue #29 Modify path).** When ``initialSymbolSource`` /
 * ``initialLabelMapping`` are supplied the editor opens with those
 * values selected — the 🟢 ``[Modifizieren]`` button reuses this same
 * component (ADR-0006: "A single, reusable Import-Editor serves all
 * three call sites — register / modify / low-confidence").
 *
 * @param {Document} doc
 * @param {{
 *   templateLibs?: Record<string, string[]>,
 *   pageParams?: Record<string, string>,
 *   categoryPath?: string | null,
 *   initialSymbolSource?: object | null,
 *   initialLabelMapping?: Record<string, string> | null,
 *   onSave?: (rule: { categoryPath: string, rule: object }) => void,
 *   onCancel?: () => void,
 * }} [opts]
 */
export function buildRegisterImportEditor(doc, opts = {}) {
  const panel = doc.createElement("div");
  panel.setAttribute(OVERRIDE_PANEL_ATTR, "true");
  panel.setAttribute(OVERRIDE_PANEL_MODE_ATTR, "registerEditor");
  panel.setAttribute(OVERRIDE_REGISTER_EDITOR_ATTR, "true");
  panel.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "gap:8px",
    "padding:10px 12px",
    "border:1px solid #cbd5e1",
    "border-radius:6px",
    "background:#f8fafc",
    "margin-top:6px",
    "font-size:12px",
    "color:#1e293b",
  ].join(";");

  const heading = doc.createElement("div");
  heading.textContent = "Registrieren";
  heading.style.cssText =
    "font-weight:600;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#475569";
  panel.appendChild(heading);

  const categoryLine = doc.createElement("div");
  const categoryPath = typeof opts.categoryPath === "string" ? opts.categoryPath : "";
  categoryLine.textContent = categoryPath
    ? `Kategorie: ${categoryPath}`
    : "Kategorie: (unbekannt)";
  categoryLine.style.cssText = "color:#64748b";
  panel.appendChild(categoryLine);

  // Symbol-Source dropdown — same shape as the override panel's picker so
  // the parser ``parseLayer`` can decode the chosen option without a
  // second code path.
  const symLabel = doc.createElement("label");
  symLabel.style.cssText = "display:flex;align-items:center;gap:8px";
  symLabel.appendChild(doc.createTextNode("Symbol"));
  const symSelect = doc.createElement("select");
  symSelect.setAttribute(OVERRIDE_SYMBOL_SELECT_ATTR, "true");
  populateSelect(symSelect, doc, opts.templateLibs);
  symLabel.appendChild(symSelect);
  panel.appendChild(symLabel);

  // Metadata preview (ADR-0006, refined 2026-06-09): no manual mapping. Every
  // LCSC spec param is auto-upserted as a symbol Property on import. Show a
  // read-only list so the user sees exactly which Properties will be written
  // (existing Property → value replaced, missing → added).
  const pageParams =
    opts.pageParams && typeof opts.pageParams === "object" ? opts.pageParams : {};
  const propEntries = Object.entries(pageParams).filter(
    ([k, v]) =>
      typeof k === "string" && k.trim() && typeof v === "string" && v.trim(),
  );

  const propHeading = doc.createElement("div");
  propHeading.textContent = propEntries.length
    ? `Eigenschaften, die ins Symbol übernommen werden (${propEntries.length})`
    : "Keine Metadaten auf der Produktseite gefunden";
  propHeading.style.cssText = "margin-top:4px;color:#475569";
  panel.appendChild(propHeading);

  if (propEntries.length) {
    const propList = doc.createElement("div");
    propList.setAttribute(OVERRIDE_REGISTER_PROP_PREVIEW_ATTR, "true");
    propList.style.cssText = [
      "display:flex",
      "flex-direction:column",
      "gap:2px",
      "max-height:180px",
      "overflow:auto",
      "border:1px solid #e2e8f0",
      "border-radius:4px",
      "padding:6px 8px",
      "background:#ffffff",
    ].join(";");
    for (const [k, v] of propEntries) {
      const propRow = doc.createElement("div");
      propRow.style.cssText =
        "display:flex;justify-content:space-between;gap:12px;line-height:1.4";
      const key = doc.createElement("span");
      key.textContent = k;
      key.style.cssText = "color:#475569;flex:0 0 auto";
      const val = doc.createElement("span");
      val.textContent = v;
      val.style.cssText =
        "color:#0f172a;font-weight:500;text-align:right;word-break:break-word";
      propRow.appendChild(key);
      propRow.appendChild(val);
      propList.appendChild(propRow);
    }
    panel.appendChild(propList);
  }

  const actions = doc.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:4px";

  const cancelBtn = doc.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Abbrechen";
  cancelBtn.setAttribute(OVERRIDE_REGISTER_CANCEL_ATTR, "true");
  actions.appendChild(cancelBtn);

  const saveBtn = doc.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Übernehmen";
  saveBtn.setAttribute(OVERRIDE_REGISTER_SAVE_ATTR, "true");
  actions.appendChild(saveBtn);

  panel.appendChild(actions);

  // Prefill the Symbol Source dropdown when the caller supplied one (🟢
  // [Modifizieren] path). Fall back to the EasyEDA default for the
  // fresh-register flow, and also when the supplied Template Library was
  // unregistered between the Rule's save time and now — the candidate
  // won't appear in the populated <option>s, and `renderOverridePanel`
  // won't have routed to 🟢 in that case anyway.
  const initialSym = opts.initialSymbolSource;
  const candidate =
    initialSym?.source === "template" && initialSym.libPath && initialSym.name
      ? encodeTemplateValue(initialSym.libPath, initialSym.name)
      : EASYEDA_OPTION_VALUE;
  const hasOption = Array.from(symSelect.options).some(
    (o) => o.value === candidate,
  );
  symSelect.value = hasOption ? candidate : EASYEDA_OPTION_VALUE;

  return panel;
}

/**
 * Translate the Register Import-Editor's DOM into the ``setRule`` RPC payload.
 * The Symbol Source uses the same ``"<source>:<libPath>:<name>"`` grammar as
 * the override panel so ``parseLayer`` decodes it into the ADR-0006
 * ``ComponentRule`` shape verbatim.
 *
 * @param {HTMLElement} panel
 * @param {string} categoryPath
 * @returns {{ categoryPath: string, rule: { symbolSource: object, labelMapping: Record<string,string> } }}
 */
export function collectRegisterEditorRule(panel, categoryPath) {
  const symSelect = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
  const symbolSource = parseLayer(symSelect?.value);
  return {
    categoryPath: typeof categoryPath === "string" ? categoryPath : "",
    rule: {
      symbolSource,
      // ADR-0006 (refined): metadata is auto-upserted from the page snapshot;
      // the rule no longer carries a manual label mapping.
      labelMapping: {},
    },
  };
}

/**
 * Build the panel element. The caller decides where in the DOM to mount it
 * (the Anchor Card's anchored case mounts it as a sibling ``<tr>``, the
 * Float Fallback would mount it inside its own ``<div>``).
 *
 * @param {Document} doc
 * @param {{
 *   templateLibs?: Record<string, string[]>,
 *   templateLibsFootprints?: Record<string, string[]>,
 *   onConfirm?: (overrides: object) => void,
 *   onCancel?: () => void,
 * }} opts
 */
export function buildOverridePanel(doc, opts = {}) {
  const panel = doc.createElement("div");
  panel.setAttribute(OVERRIDE_PANEL_ATTR, "true");
  panel.setAttribute(OVERRIDE_PANEL_MODE_ATTR, "sources");
  panel.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "gap:8px",
    "padding:10px 12px",
    "border:1px solid #cbd5e1",
    "border-radius:6px",
    "background:#f8fafc",
    "margin-top:6px",
    "font-size:12px",
    "color:#1e293b",
  ].join(";");

  const heading = doc.createElement("div");
  heading.textContent = "Override sources";
  heading.style.cssText = "font-weight:600;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#475569";
  panel.appendChild(heading);

  const symLabel = doc.createElement("label");
  symLabel.style.cssText = "display:flex;align-items:center;gap:8px";
  symLabel.appendChild(doc.createTextNode("Symbol"));
  const symSelect = doc.createElement("select");
  symSelect.setAttribute(OVERRIDE_SYMBOL_SELECT_ATTR, "true");
  populateSelect(symSelect, doc, opts.templateLibs);
  symLabel.appendChild(symSelect);
  panel.appendChild(symLabel);

  const fpLabel = doc.createElement("label");
  fpLabel.style.cssText = "display:flex;align-items:center;gap:8px";
  fpLabel.appendChild(doc.createTextNode("Footprint"));
  const fpSelect = doc.createElement("select");
  fpSelect.setAttribute(OVERRIDE_FOOTPRINT_SELECT_ATTR, "true");
  populateSelect(fpSelect, doc, opts.templateLibsFootprints || opts.templateLibs);
  fpLabel.appendChild(fpSelect);
  panel.appendChild(fpLabel);

  const actions = doc.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:4px";

  const cancelBtn = doc.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.setAttribute(OVERRIDE_CANCEL_ATTR, "true");
  actions.appendChild(cancelBtn);

  const confirmBtn = doc.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.textContent = "Confirm";
  confirmBtn.setAttribute(OVERRIDE_CONFIRM_ATTR, "true");
  actions.appendChild(confirmBtn);

  panel.appendChild(actions);

  symSelect.value = EASYEDA_OPTION_VALUE;
  fpSelect.value = EASYEDA_OPTION_VALUE;

  return panel;
}

/**
 * Parse the ``<select>`` values back into the structured ``overrides`` payload
 * the Native Host RPC consumes. The option value format is ``"easyeda"`` or
 * ``"template:<libPath>:<name>"``; the split anchors on the ``.kicad_sym``
 * suffix that always terminates a Template Library path, so Windows drive
 * letters in ``libPath`` and ``":"`` characters in ``name`` both survive
 * round-tripping.
 *
 * @param {{ symbolValue?: string, footprintValue?: string }} selection
 */
export function selectionToOverrides(selection) {
  return {
    symbol: parseLayer(selection?.symbolValue),
    footprint: parseLayer(selection?.footprintValue),
  };
}

const KICAD_SYM_SUFFIX = ".kicad_sym";

function parseLayer(raw) {
  if (typeof raw !== "string" || !raw || raw === EASYEDA_OPTION_VALUE) {
    return { source: "easyeda" };
  }
  if (!raw.startsWith(TEMPLATE_VALUE_PREFIX)) {
    return { source: "easyeda" };
  }
  const body = raw.slice(TEMPLATE_VALUE_PREFIX.length);

  // Primary split: a ``.kicad_sym`` suffix anchors the boundary between
  // libPath and name, so both Windows drive letters (``C:\…``) inside
  // libPath and any ``":"`` chars inside the user-authored name survive.
  const suffixIdx = body.toLowerCase().indexOf(KICAD_SYM_SUFFIX);
  if (suffixIdx > 0) {
    const sep = suffixIdx + KICAD_SYM_SUFFIX.length;
    if (body[sep] === ":") {
      const libPath = body.slice(0, sep);
      const name = body.slice(sep + 1);
      if (libPath && name) {
        return { source: "template", libPath, name };
      }
    }
  }

  // Fallback for off-spec libPaths without the ``.kicad_sym`` suffix:
  // split on the last ``":"``. Names containing ``":"`` are ambiguous here,
  // but valid inputs never reach this branch.
  const idx = body.lastIndexOf(":");
  if (idx <= 0 || idx === body.length - 1) {
    return { source: "easyeda" };
  }
  return { source: "template", libPath: body.slice(0, idx), name: body.slice(idx + 1) };
}

/**
 * Mount the panel as a sibling of ``anchorRow`` (an injected ``<tr>``).
 * For ``<tr>`` rows the panel is wrapped in its own row with a single
 * full-width cell so it sits inside the same ``<tbody>`` and continues the
 * Anchor Card visually. Idempotent — a second call returns the existing
 * panel without stacking handlers or duplicating DOM.
 *
 * The returned node is the panel ``<div>`` itself, not the wrapper row, so
 * tests and callers can query its inputs directly.
 *
 * **Confidence dispatch (ADR-0006).**
 *
 *   - ⚪ ``match.state === "white"`` → **Register-Prompt** with „nur
 *     EasyEDA" / „registrieren".
 *   - 🟢 ``match.state === "green"`` → **One-Click panel** with
 *     **[Import]** (fires ``onImport``) + **[Modifizieren]** (fires
 *     ``onModify``). No separate confirm, no countdown — the preview IS
 *     the confirm (ADR-0006 §U3.3).
 *   - 🟡 ``match.state === "yellow"`` (Issue #31) → user-setting branch:
 *       - ``opts.lowConfidenceBehaviour === "openEditor"`` (Default):
 *         opens the Import-Editor immediately via ``onModify``. Same
 *         editor as 🟢 Modify / ⚪ Register (ADR-0006: one editor for
 *         register / modify / low-confidence).
 *       - ``opts.lowConfidenceBehaviour === "keepEasyeda"``: renders the
 *         **Low-Confidence panel** with a single-line Vorschlag hint,
 *         an ``[EasyEDA übernehmen]`` button (fires ``onEasyedaOnly``)
 *         and an ``[Editor öffnen]`` escape hatch (fires ``onModify``).
 *   - No match / unknown state → legacy Symbol/Footprint source picker.
 *
 * @param {HTMLElement} anchorRow
 * @param {{
 *   match?: {
 *     state?: "green" | "yellow" | "white",
 *     ruleKey?: string | null,
 *     rule?: object | null,
 *   } | null,
 *   lowConfidenceBehaviour?: "openEditor" | "keepEasyeda",
 *   templateLibs?: Record<string, string[]>,
 *   templateLibsFootprints?: Record<string, string[]>,
 *   onConfirm?: (overrides: object) => void,
 *   onCancel?: () => void,
 *   onEasyedaOnly?: () => void,
 *   onRegister?: () => void,
 *   onImport?: () => void,
 *   onModify?: () => void,
 *   doc?: Document,
 * }} opts
 * @returns {HTMLElement | null} the panel, or null when ``anchorRow`` is detached
 */
export function renderOverridePanel(anchorRow, opts = {}) {
  if (!anchorRow || !anchorRow.parentNode) return null;
  const doc = opts.doc || (typeof document !== "undefined" ? document : null);
  if (!doc) return null;

  const matchState = opts.match?.state;
  const isWhite = matchState === "white";
  const isGreen = matchState === "green";
  const isYellow = matchState === "yellow";

  // Inline idempotency for the non-modal states (🟢/🟡/sources). ⚪ white now
  // mounts as a modal overlay; mountCsModal dismisses any existing prompt modal
  // by id, so a re-render simply replaces it (no inline "return existing").
  if (!isWhite) {
    const existing = anchorRow.parentNode.querySelector(
      `[${OVERRIDE_PANEL_ATTR}="true"]`,
    );
    if (existing) return existing;
  }
  const lowConfidenceBehaviour =
    opts.lowConfidenceBehaviour === "keepEasyeda" ? "keepEasyeda" : "openEditor";

  // 🟡 + ``openEditor`` (Default) bypasses the panel and goes straight
  // into the Import-Editor. The host's ``onModify`` callback is the
  // canonical entry point (same one 🟢 [Modifizieren] uses); the caller
  // is expected to ``renderRegisterImportEditor`` with the matched
  // Rule's values prefilled.
  if (isYellow && lowConfidenceBehaviour === "openEditor") {
    if (typeof opts.onModify === "function") {
      try {
        opts.onModify();
      } catch (_e) {
        /* swallow — caller logs */
      }
    }
    return null;
  }

  let panel;
  if (isWhite) {
    panel = buildRegisterPrompt(doc, opts);
  } else if (isGreen) {
    panel = buildOneClickPanel(doc, {
      ruleKey: opts.match?.ruleKey ?? null,
      symbolSource: opts.match?.rule?.symbolSource ?? null,
      labelMapping: opts.match?.rule?.labelMapping ?? null,
    });
  } else if (isYellow) {
    // ``keepEasyeda`` branch — Hinweis + EasyEDA default + editor escape.
    panel = buildYellowPanel(doc, {
      ruleKey: opts.match?.ruleKey ?? null,
      match: opts.match || null,
    });
  } else {
    panel = buildOverridePanel(doc, opts);
  }

  // ⚪ white Register-Prompt mounts as a modal overlay (ADR-0006 refined, user
  // choice 2026-06-09) so it reads as a dialog. 🟢/🟡/sources stay inline
  // beneath the Anchor Card — their always-visible preview is part of the page
  // flow, not a dialog, and would be intrusive as an overlay on every part.
  let removePanel;
  if (isWhite) {
    const { dismiss } = mountCsModal({
      id: "k2c-register-prompt-modal",
      maxWidthPx: 460,
      children: [panel],
      closeOnBackdrop: true,
      closeOnEscape: true,
    });
    removePanel = dismiss;
  } else {
    // Wrap the panel in a <tr><td colspan>…</td></tr> when the anchor lives in
    // a table so it lines up with the existing Anchor Card row. Outside a
    // table (Float Fallback) the panel is inserted as a plain sibling.
    let mount = panel;
    if (anchorRow.tagName?.toLowerCase() === "tr") {
      const tr = doc.createElement("tr");
      tr.setAttribute(OVERRIDE_PANEL_ROW_ATTR, "true");
      const td = doc.createElement("td");
      td.colSpan = Math.max(1, anchorRow.children.length);
      td.appendChild(panel);
      tr.appendChild(td);
      mount = tr;
    }
    anchorRow.parentNode.insertBefore(mount, anchorRow.nextSibling);
    removePanel = () => mount.remove();
  }

  if (isWhite) {
    const easyedaBtn = panel.querySelector(`[${OVERRIDE_EASYEDA_ONLY_ATTR}]`);
    const registerBtn = panel.querySelector(`[${OVERRIDE_REGISTER_ATTR}]`);

    easyedaBtn?.addEventListener("click", () => {
      removePanel();
      if (typeof opts.onEasyedaOnly === "function") {
        try {
          opts.onEasyedaOnly();
        } catch (_e) {
          /* swallow — caller's job to log */
        }
      } else if (typeof opts.onConfirm === "function") {
        // Fall back to the legacy onConfirm hook with EasyEDA on both
        // Layers so existing call sites (#3 Phase-1 chain, #4 default
        // Phase-2 path) keep working without a code change.
        try {
          opts.onConfirm({
            symbol: { source: "easyeda" },
            footprint: { source: "easyeda" },
          });
        } catch (_e) { /* swallow */ }
      }
    });

    registerBtn?.addEventListener("click", () => {
      removePanel();
      if (typeof opts.onRegister === "function") {
        try {
          opts.onRegister();
        } catch (_e) { /* swallow */ }
      }
    });

    return panel;
  }

  if (isGreen) {
    const importBtn = panel.querySelector(`[${OVERRIDE_IMPORT_ATTR}]`);
    const modifyBtn = panel.querySelector(`[${OVERRIDE_MODIFY_ATTR}]`);

    importBtn?.addEventListener("click", () => {
      removePanel();
      if (typeof opts.onImport === "function") {
        try {
          opts.onImport();
        } catch (_e) { /* swallow — caller logs */ }
      }
    });

    modifyBtn?.addEventListener("click", () => {
      removePanel();
      if (typeof opts.onModify === "function") {
        try {
          opts.onModify();
        } catch (_e) { /* swallow */ }
      }
    });

    return panel;
  }

  if (isYellow) {
    // Issue #31 — 🟡 keepEasyeda branch. The openEditor branch returned
    // early above before any panel was constructed.
    const keepBtn = panel.querySelector(`[${OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR}]`);
    const openBtn = panel.querySelector(`[${OVERRIDE_YELLOW_OPEN_EDITOR_ATTR}]`);

    keepBtn?.addEventListener("click", () => {
      removePanel();
      if (typeof opts.onEasyedaOnly === "function") {
        try {
          opts.onEasyedaOnly();
        } catch (_e) { /* swallow */ }
      } else if (typeof opts.onConfirm === "function") {
        // Fallback to onConfirm with EasyEDA on both Layers — same
        // contract the ⚪ Register-Prompt uses for "nur EasyEDA".
        try {
          opts.onConfirm({
            symbol: { source: "easyeda" },
            footprint: { source: "easyeda" },
          });
        } catch (_e) { /* swallow */ }
      }
    });

    openBtn?.addEventListener("click", () => {
      removePanel();
      if (typeof opts.onModify === "function") {
        try {
          opts.onModify();
        } catch (_e) { /* swallow */ }
      }
    });

    return panel;
  }

  const symSelect = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
  const fpSelect = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
  const confirmBtn = panel.querySelector(`[${OVERRIDE_CONFIRM_ATTR}]`);
  const cancelBtn = panel.querySelector(`[${OVERRIDE_CANCEL_ATTR}]`);

  confirmBtn?.addEventListener("click", () => {
    const overrides = selectionToOverrides({
      symbolValue: symSelect?.value,
      footprintValue: fpSelect?.value,
    });
    removePanel();
    if (typeof opts.onConfirm === "function") {
      try {
        opts.onConfirm(overrides);
      } catch (_e) {
        /* swallow — caller's job to log */
      }
    }
  });

  cancelBtn?.addEventListener("click", () => {
    removePanel();
    if (typeof opts.onCancel === "function") {
      try {
        opts.onCancel();
      } catch (_e) {
        /* swallow */
      }
    }
  });

  return panel;
}

/**
 * Mount the **Register Import-Editor** beneath the Anchor Card. Replaces
 * an existing Override Panel (e.g. the ⚪ Register-Prompt the user just
 * clicked „registrieren" in) so the editor takes the same DOM slot — the
 * user sees the editor flip in beneath the Anchor Card, not stack below
 * the prompt.
 *
 * @param {HTMLElement} anchorRow
 * @param {{
 *   templateLibs?: Record<string, string[]>,
 *   pageParams?: Record<string, string>,
 *   categoryPath?: string | null,
 *   initialSymbolSource?: object | null,
 *   initialLabelMapping?: Record<string, string> | null,
 *   onSave?: (payload: { categoryPath: string, rule: object }) => void,
 *   onCancel?: () => void,
 *   doc?: Document,
 * }} [opts]
 * @returns {HTMLElement | null}
 */
export function renderRegisterImportEditor(anchorRow, opts = {}) {
  const doc = opts.doc || (typeof document !== "undefined" ? document : null);
  if (!doc) return null;

  // ADR-0006 (refined 2026-06-09): the Import-Editor is a modal overlay, not an
  // inline Anchor-Card row — better to use, dims the page behind it. The
  // ``anchorRow`` argument is kept for API compatibility but no longer drives
  // the mount; the panel goes into a centered ``mountCsModal`` shell on
  // ``document.body``. Idempotency is handled by mountCsModal (it dismisses any
  // existing modal with the same id first).
  const panel = buildRegisterImportEditor(doc, opts);

  let settled = false;
  const { dismiss } = mountCsModal({
    id: "k2c-register-editor-modal",
    maxWidthPx: 560,
    children: [panel],
    closeOnBackdrop: true,
    closeOnEscape: true,
    onDismiss: () => {
      // Backdrop / Escape / cancel all funnel through here. Guard against a
      // double-fire after a save() already dismissed.
      if (settled) return;
      settled = true;
      if (typeof opts.onCancel === "function") {
        try {
          opts.onCancel();
        } catch (_e) {
          /* swallow */
        }
      }
    },
  });

  panel
    .querySelector(`[${OVERRIDE_REGISTER_SAVE_ATTR}]`)
    ?.addEventListener("click", () => {
      const payload = collectRegisterEditorRule(panel, opts.categoryPath || "");
      settled = true; // suppress the onDismiss -> onCancel path for a save
      dismiss();
      if (typeof opts.onSave === "function") {
        try {
          opts.onSave(payload);
        } catch (_e) {
          /* swallow — caller logs */
        }
      }
    });

  panel
    .querySelector(`[${OVERRIDE_REGISTER_CANCEL_ATTR}]`)
    ?.addEventListener("click", () => {
      // dismiss() triggers onDismiss -> opts.onCancel.
      dismiss();
    });

  return panel;
}
