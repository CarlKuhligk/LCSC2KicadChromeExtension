"use strict";

import {
  mountCsModal,
  getDialogTokens,
  applyDialogStyleSelect,
  dialogButtonStyle,
  DIALOG_SPACING,
  DIALOG_TYPE,
} from "./dialog.js";
import { templatesMatchingCategory } from "../../shared/confidenceState.mjs";
import { detectValueParam } from "../../shared/valueParam.mjs";

/**
 * V3 **Override Panel** — inline UI between Phase 1 Fetch and Phase 2
 * Conversion (Issue #5). Replaces V2's 5-dialog cascade with one inline
 * surface attached to the Anchor Card.
 *
 * Scope of this slice: Symbol-source and Footprint-source selection only.
 * Category Rules (#8), Pin↔Pad Map (#9), Overwrite confirm (#10) and Datasheet
 * preview (#11) dock onto this same panel in later slices. This panel — via
 * "registrieren" / "Modifizieren" → the Import-Editor — is also the Customize
 * surface (the standalone Anchor-Card Customize button was dropped).
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
export const OVERRIDE_REGISTER_TEMPLATE_LIST_ATTR = "data-k2c-register-template-list";
export const OVERRIDE_REGISTER_TEMPLATE_ITEM_ATTR = "data-k2c-register-template-item";
export const OVERRIDE_REGISTER_SYMBOL_PREVIEW_ATTR = "data-k2c-register-symbol-preview";
export const OVERRIDE_REGISTER_FOOTPRINT_PREVIEW_ATTR = "data-k2c-register-footprint-preview";
export const OVERRIDE_REGISTER_SHOWALL_ATTR = "data-k2c-register-showall";
export const OVERRIDE_REGISTER_HIDE_PINNUM_ATTR = "data-k2c-register-hide-pinnum";
export const OVERRIDE_REGISTER_HIDE_PINNAME_ATTR = "data-k2c-register-hide-pinname";
export const OVERRIDE_REGISTER_VALUE_PARAM_ATTR = "data-k2c-register-value-param";
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
  const T = getDialogTokens(opts.theme);
  const panel = doc.createElement("div");
  panel.setAttribute(OVERRIDE_PANEL_ATTR, "true");
  panel.setAttribute(OVERRIDE_PANEL_MODE_ATTR, "white");
  panel.style.cssText = [
    "display:flex",
    "flex-direction:column",
    `gap:${DIALOG_SPACING.sm}`,
    `padding:${DIALOG_SPACING.md} ${DIALOG_SPACING.md}`,
    `border:1px solid ${T.borderStrong}`,
    `border-radius:${T.radiusSm}`,
    `background:${T.surface2}`,
    `margin-top:${DIALOG_SPACING.xs}`,
    `font-size:${DIALOG_TYPE.small}`,
    `color:${T.text}`,
  ].join(";");

  const heading = doc.createElement("div");
  heading.textContent = "Neues Bauteil";
  heading.style.cssText =
    `font-weight:600;font-size:${DIALOG_TYPE.micro};letter-spacing:0.04em;text-transform:uppercase;color:${T.textMuted}`;
  panel.appendChild(heading);

  const body = doc.createElement("div");
  body.textContent =
    "Neues Bauteil — nur EasyEDA herunterladen ODER registrieren?";
  body.style.cssText = "line-height:1.4";
  panel.appendChild(body);

  const actions = doc.createElement("div");
  actions.style.cssText = `display:flex;gap:${DIALOG_SPACING.sm};justify-content:flex-end;margin-top:${DIALOG_SPACING.xs}`;

  const easyedaBtn = doc.createElement("button");
  easyedaBtn.type = "button";
  easyedaBtn.textContent = "nur EasyEDA";
  easyedaBtn.setAttribute(OVERRIDE_EASYEDA_ONLY_ATTR, "true");
  easyedaBtn.style.cssText = dialogButtonStyle("secondary", "dense", { theme: opts.theme });
  actions.appendChild(easyedaBtn);

  const registerBtn = doc.createElement("button");
  registerBtn.type = "button";
  registerBtn.textContent = "registrieren";
  registerBtn.setAttribute(OVERRIDE_REGISTER_ATTR, "true");
  registerBtn.style.cssText = dialogButtonStyle("primary", "dense", { theme: opts.theme });
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
  const T = getDialogTokens(opts.theme);
  const panel = doc.createElement("div");
  panel.setAttribute(OVERRIDE_PANEL_ATTR, "true");
  panel.setAttribute(OVERRIDE_PANEL_MODE_ATTR, "green");
  panel.style.cssText = [
    "display:flex",
    "flex-direction:column",
    `gap:${DIALOG_SPACING.sm}`,
    `padding:${DIALOG_SPACING.md} ${DIALOG_SPACING.md}`,
    `border:1px solid ${T.successBorder}`,
    `border-radius:${T.radiusSm}`,
    `background:${T.successSurface}`,
    `margin-top:${DIALOG_SPACING.xs}`,
    `font-size:${DIALOG_TYPE.small}`,
    `color:${T.successText}`,
  ].join(";");

  const heading = doc.createElement("div");
  const ruleKey = typeof opts.ruleKey === "string" && opts.ruleKey ? opts.ruleKey : "";
  heading.textContent = ruleKey
    ? `Registriert: "${ruleKey}" — Ein-Klick`
    : "Registriert — Ein-Klick";
  heading.style.cssText =
    `font-weight:600;font-size:${DIALOG_TYPE.micro};letter-spacing:0.04em;text-transform:uppercase;color:${T.success}`;
  panel.appendChild(heading);

  // Preview — Symbol Source + Label-Mapping summary so the user can see
  // what will be applied before clicking [Import] (ADR-0006: "the
  // resolved result is shown before the click").
  const preview = doc.createElement("div");
  preview.setAttribute(OVERRIDE_ONECLICK_PREVIEW_ATTR, "true");
  preview.style.cssText = `display:flex;flex-direction:column;gap:${DIALOG_SPACING.xs}`;

  const lblStyle = `color:${T.success};font-weight:500;min-width:64px`;
  const valStyle = `color:${T.successText}`;

  const symbolLine = doc.createElement("div");
  symbolLine.style.cssText = `display:flex;gap:${DIALOG_SPACING.xs};align-items:baseline`;
  const symLabel = doc.createElement("span");
  symLabel.textContent = "Symbol:";
  symLabel.style.cssText = lblStyle;
  const symValue = doc.createElement("span");
  symValue.textContent = describeSymbolSource(opts.symbolSource);
  symValue.style.cssText = valStyle;
  symbolLine.appendChild(symLabel);
  symbolLine.appendChild(symValue);
  preview.appendChild(symbolLine);

  const mapping = opts.labelMapping && typeof opts.labelMapping === "object"
    ? opts.labelMapping
    : {};
  const mappingEntries = Object.entries(mapping);
  if (mappingEntries.length) {
    const mappingLine = doc.createElement("div");
    mappingLine.style.cssText = `display:flex;gap:${DIALOG_SPACING.xs};align-items:baseline`;
    const mapLabel = doc.createElement("span");
    mapLabel.textContent = "Mapping:";
    mapLabel.style.cssText = lblStyle;
    const mapValue = doc.createElement("span");
    mapValue.textContent = mappingEntries
      .map(([k, v]) => `${k} → ${v}`)
      .join(", ");
    mapValue.style.cssText = `${valStyle};word-break:break-word`;
    mappingLine.appendChild(mapLabel);
    mappingLine.appendChild(mapValue);
    preview.appendChild(mappingLine);
  }

  // Pin-visibility + Value-Param are part of the resolved result, so they must
  // be visible BEFORE the one-click [Import] (ADR-0006: "the resolved result is
  // shown before the click"). Only rendered when set, to keep the green panel
  // terse for the common default case.
  const addPreviewLine = (labelText, valueText) => {
    const line = doc.createElement("div");
    line.style.cssText = `display:flex;gap:${DIALOG_SPACING.xs};align-items:baseline`;
    const lbl = doc.createElement("span");
    lbl.textContent = labelText;
    lbl.style.cssText = lblStyle;
    const val = doc.createElement("span");
    val.textContent = valueText;
    val.style.cssText = `${valStyle};word-break:break-word`;
    line.appendChild(lbl);
    line.appendChild(val);
    preview.appendChild(line);
  };

  const hiddenPins = [];
  if (opts.hidePinNumbers) hiddenPins.push("Nummern");
  if (opts.hidePinNames) hiddenPins.push("Namen");
  if (hiddenPins.length) {
    addPreviewLine("Pins:", `${hiddenPins.join(" + ")} ausgeblendet`);
  }
  if (typeof opts.valueParam === "string" && opts.valueParam.trim()) {
    addPreviewLine("Value:", opts.valueParam.trim());
  }

  panel.appendChild(preview);

  const actions = doc.createElement("div");
  actions.style.cssText = `display:flex;gap:${DIALOG_SPACING.sm};justify-content:flex-end;margin-top:${DIALOG_SPACING.xs}`;

  // [Modifizieren] sits to the LEFT of [Import] so the visual cursor
  // ends on the primary action (one-click ergonomics).
  const modifyBtn = doc.createElement("button");
  modifyBtn.type = "button";
  modifyBtn.textContent = "Modifizieren";
  modifyBtn.setAttribute(OVERRIDE_MODIFY_ATTR, "true");
  modifyBtn.style.cssText = dialogButtonStyle("secondary", "dense", { theme: opts.theme });
  actions.appendChild(modifyBtn);

  const importBtn = doc.createElement("button");
  importBtn.type = "button";
  importBtn.textContent = "Import";
  importBtn.setAttribute(OVERRIDE_IMPORT_ATTR, "true");
  importBtn.style.cssText = dialogButtonStyle("primary", "dense", { theme: opts.theme });
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
  const T = getDialogTokens(opts.theme);
  const panel = doc.createElement("div");
  panel.setAttribute(OVERRIDE_PANEL_ATTR, "true");
  panel.setAttribute(OVERRIDE_PANEL_MODE_ATTR, "yellow");
  panel.style.cssText = [
    "display:flex",
    "flex-direction:column",
    `gap:${DIALOG_SPACING.sm}`,
    `padding:${DIALOG_SPACING.md} ${DIALOG_SPACING.md}`,
    `border:1px solid ${T.warningBorder}`,
    `border-radius:${T.radiusSm}`,
    `background:${T.warningSurface}`,
    `margin-top:${DIALOG_SPACING.xs}`,
    `font-size:${DIALOG_TYPE.small}`,
    `color:${T.warningText}`,
  ].join(";");

  const heading = doc.createElement("div");
  heading.textContent = "Niedrige Confidence — prüfen oder EasyEDA behalten";
  heading.style.cssText =
    `font-weight:600;font-size:${DIALOG_TYPE.micro};letter-spacing:0.04em;text-transform:uppercase;color:${T.warning}`;
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
    hint.style.cssText = `line-height:1.4;color:${T.warningHint}`;
    hint.textContent = hintLines.join(" · ");
    panel.appendChild(hint);
  }

  const actions = doc.createElement("div");
  actions.style.cssText = `display:flex;gap:${DIALOG_SPACING.sm};justify-content:flex-end;margin-top:${DIALOG_SPACING.xs}`;

  const openEditorBtn = doc.createElement("button");
  openEditorBtn.type = "button";
  openEditorBtn.textContent = "Editor öffnen";
  openEditorBtn.setAttribute(OVERRIDE_YELLOW_OPEN_EDITOR_ATTR, "true");
  openEditorBtn.style.cssText = dialogButtonStyle("secondary", "dense", { theme: opts.theme });
  actions.appendChild(openEditorBtn);

  const keepEasyedaBtn = doc.createElement("button");
  keepEasyedaBtn.type = "button";
  keepEasyedaBtn.textContent = "EasyEDA übernehmen";
  keepEasyedaBtn.setAttribute(OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR, "true");
  keepEasyedaBtn.style.cssText = dialogButtonStyle("primary", "dense", { theme: opts.theme });
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
 *   - Footprint Source (#9) — a ``<select>`` mirroring the Symbol Source:
 *     EasyEDA default OR a curated template footprint (a ``.kicad_mod`` from
 *     a template library's sibling ``.pretty``). The footprint preview below
 *     follows the selection.
 *
 * 3D stays on the footprint's own ``(model …)`` ref ("3D follows the
 * Footprint", #6) — no separate 3D control.
 *
 * **Prefill (Issue #29 Modify path).** When ``initialSymbolSource`` /
 * ``initialFootprintSource`` / ``initialLabelMapping`` are supplied the editor
 * opens with those values selected — the 🟢 ``[Modifizieren]`` button reuses
 * this same component (ADR-0006: "A single, reusable Import-Editor serves all
 * three call sites — register / modify / low-confidence").
 *
 * @param {Document} doc
 * @param {{
 *   templateLibs?: Record<string, string[]>,
 *   templateLibsFootprints?: Record<string, string[]>,
 *   pageParams?: Record<string, string>,
 *   categoryPath?: string | null,
 *   initialSymbolSource?: object | null,
 *   initialFootprintSource?: object | null,
 *   initialLabelMapping?: Record<string, string> | null,
 *   fetchSymbolPreview?: (sel: {libPath: string, name: string}) => Promise<{svg: string|null, error?: string}>,
 *   fetchFootprintPreview?: () => Promise<{svg: string|null, error?: string}>,
 *   fetchTemplateFootprintPreview?: (sel: {libPath: string, name: string}) => Promise<{svg: string|null, error?: string}>,
 *   onSave?: (rule: { categoryPath: string, rule: object }) => void,
 *   onCancel?: () => void,
 * }} [opts]
 */
export function buildRegisterImportEditor(doc, opts = {}) {
  const T = getDialogTokens(opts.theme);
  const panel = doc.createElement("div");
  panel.setAttribute(OVERRIDE_PANEL_ATTR, "true");
  panel.setAttribute(OVERRIDE_PANEL_MODE_ATTR, "registerEditor");
  panel.setAttribute(OVERRIDE_REGISTER_EDITOR_ATTR, "true");
  panel.style.cssText = [
    "display:flex",
    "flex-direction:column",
    `gap:${DIALOG_SPACING.sm}`,
    `padding:${DIALOG_SPACING.md} ${DIALOG_SPACING.md}`,
    `border:1px solid ${T.borderStrong}`,
    `border-radius:${T.radiusSm}`,
    `background:${T.surface}`,
    `margin-top:${DIALOG_SPACING.xs}`,
    `font-size:${DIALOG_TYPE.small}`,
    `color:${T.text}`,
  ].join(";");

  // 3-column layout: left = template navigation, center = symbol (top) +
  // footprint (below) previews, right = pin/value controls + the read-only
  // property list. Columns wrap on narrow widths so the on-page editor stays
  // usable in tight layouts. Heading/category span the top; actions the bottom.
  const topBar = doc.createElement("div");
  topBar.style.cssText = `display:flex;flex-direction:column;gap:${DIALOG_SPACING.xs}`;
  panel.appendChild(topBar);

  const body = doc.createElement("div");
  body.style.cssText = `display:flex;flex-wrap:wrap;gap:${DIALOG_SPACING.md};align-items:flex-start`;
  panel.appendChild(body);

  const navCol = doc.createElement("div");
  navCol.style.cssText =
    `display:flex;flex-direction:column;gap:${DIALOG_SPACING.xs};flex:1 1 180px;min-width:160px;max-width:280px`;
  body.appendChild(navCol);

  const centerCol = doc.createElement("div");
  centerCol.style.cssText =
    `display:flex;flex-direction:column;gap:${DIALOG_SPACING.xs};flex:1 1 280px;min-width:220px`;
  body.appendChild(centerCol);

  const rightCol = doc.createElement("div");
  rightCol.style.cssText =
    `display:flex;flex-direction:column;gap:${DIALOG_SPACING.xs};flex:1 1 220px;min-width:200px`;
  body.appendChild(rightCol);

  const mkColLabel = (text) => {
    const el = doc.createElement("div");
    el.textContent = text;
    el.style.cssText = `color:${T.textMuted};font-weight:600;font-size:${DIALOG_TYPE.micro}`;
    return el;
  };

  const heading = doc.createElement("div");
  heading.textContent = "Registrieren";
  heading.style.cssText =
    `font-weight:600;font-size:${DIALOG_TYPE.micro};letter-spacing:0.04em;text-transform:uppercase;color:${T.textMuted}`;
  topBar.appendChild(heading);

  const categoryLine = doc.createElement("div");
  const categoryPath = typeof opts.categoryPath === "string" ? opts.categoryPath : "";
  categoryLine.textContent = categoryPath
    ? `Kategorie: ${categoryPath}`
    : "Kategorie: (unbekannt)";
  categoryLine.style.cssText = `color:${T.textFaint}`;
  topBar.appendChild(categoryLine);

  // Symbol-Source: a hidden <select> stays the source of truth (parseLayer /
  // collectRegisterEditorRule read it; prefill sets it). The visible UI is a
  // selectable TEMPLATE LIST — Category-matched templates shown by default with
  // a "show all" toggle — that drives the hidden select on click.
  const symSelect = doc.createElement("select");
  symSelect.setAttribute(OVERRIDE_SYMBOL_SELECT_ATTR, "true");
  populateSelect(symSelect, doc, opts.templateLibs);
  symSelect.style.cssText = "display:none";
  navCol.appendChild(symSelect);

  const symHeadRow = doc.createElement("div");
  symHeadRow.style.cssText =
    `display:flex;align-items:center;justify-content:space-between;gap:${DIALOG_SPACING.sm};margin-top:${DIALOG_SPACING.xs}`;
  const symHeading = doc.createElement("div");
  symHeading.textContent = "Symbol-Vorlage";
  symHeading.style.cssText = `color:${T.textMuted}`;
  symHeadRow.appendChild(symHeading);
  const showAllLabel = doc.createElement("label");
  showAllLabel.style.cssText =
    `display:flex;align-items:center;gap:${DIALOG_SPACING.xs};font-size:${DIALOG_TYPE.micro};color:${T.textFaint};cursor:pointer`;
  const showAllCb = doc.createElement("input");
  showAllCb.type = "checkbox";
  showAllCb.setAttribute(OVERRIDE_REGISTER_SHOWALL_ATTR, "true");
  showAllLabel.appendChild(showAllCb);
  showAllLabel.appendChild(doc.createTextNode("alle Templates anzeigen"));
  symHeadRow.appendChild(showAllLabel);
  navCol.appendChild(symHeadRow);

  const listHost = doc.createElement("div");
  listHost.setAttribute(OVERRIDE_REGISTER_TEMPLATE_LIST_ATTR, "true");
  listHost.style.cssText = [
    "display:flex", "flex-direction:column", "gap:2px",
    "max-height:200px", "overflow:auto",
    `border:1px solid ${T.borderStrong}`, `border-radius:${T.radiusSm}`,
    `padding:${DIALOG_SPACING.xs}`,
    `background:${T.surface2}`,
  ].join(";");
  navCol.appendChild(listHost);

  // Symbol PREVIEW pane (UI Etappe B): renders the selected template symbol as
  // an SVG so the user sees what they are assigning — the symbol-side analogue
  // of the footprint preview. The actual render is fetched via the injected
  // ``opts.fetchSymbolPreview`` callback (keeps this module chrome-free and
  // unit-testable); a stale-request token guards against out-of-order replies.
  // In dark theme the pane sits on ``surface2`` so the SVG (which the backend
  // renders in dark colors when ``previewTheme="dark"``) reads cleanly.
  const paneStyle = [
    "display:flex", "align-items:center", "justify-content:center",
    "min-height:120px", "max-height:240px", `padding:${DIALOG_SPACING.xs}`,
    `border:1px solid ${T.borderStrong}`, `border-radius:${T.radiusSm}`,
    `background:${T.surface2}`,
    "overflow:hidden",
  ].join(";");

  const previewPane = doc.createElement("div");
  previewPane.setAttribute(OVERRIDE_REGISTER_SYMBOL_PREVIEW_ATTR, "true");
  previewPane.style.cssText = paneStyle;
  centerCol.appendChild(mkColLabel("Symbol"));
  centerCol.appendChild(previewPane);

  // Footprint-Source selector (#9): EasyEDA default OR a curated template
  // footprint from a template library's sibling .pretty. The visible <select>
  // is the source of truth (collectRegisterEditorRule reads it via parseLayer);
  // changing it re-renders the footprint preview below.
  const footprintPane = doc.createElement("div");
  footprintPane.setAttribute(OVERRIDE_REGISTER_FOOTPRINT_PREVIEW_ATTR, "true");
  footprintPane.style.cssText = paneStyle;
  const fpSelect = doc.createElement("select");
  fpSelect.setAttribute(OVERRIDE_FOOTPRINT_SELECT_ATTR, "true");
  populateSelect(fpSelect, doc, opts.templateLibsFootprints);
  applyDialogStyleSelect(fpSelect, { theme: opts.theme });
  fpSelect.addEventListener("change", () => loadFootprintPreview());
  centerCol.appendChild(mkColLabel("Footprint"));
  centerCol.appendChild(fpSelect);
  centerCol.appendChild(footprintPane);

  function setPaneText(pane, text) {
    pane.innerHTML = "";
    const t = doc.createElement("div");
    t.textContent = text;
    t.style.cssText = `color:${T.placeholder};font-size:${DIALOG_TYPE.micro};font-style:italic;text-align:center`;
    pane.appendChild(t);
  }

  function setPaneImage(pane, svg, alt) {
    pane.innerHTML = "";
    const img = doc.createElement("img");
    img.alt = alt;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    img.style.cssText = "display:block;max-width:100%;max-height:228px;width:auto;height:auto";
    pane.appendChild(img);
  }

  let previewReq = 0;
  function updateSymbolPreview() {
    const layer = parseLayer(symSelect.value);
    if (layer.source !== "template") {
      setPaneText(previewPane, "EasyEDA-Standardsymbol — keine Vorschau");
      return;
    }
    if (typeof opts.fetchSymbolPreview !== "function") {
      setPaneText(previewPane, "Vorschau nicht verfügbar");
      return;
    }
    const reqId = ++previewReq;
    setPaneText(previewPane, "Lade Vorschau …");
    Promise.resolve(opts.fetchSymbolPreview({ libPath: layer.libPath, name: layer.name }))
      .then((res) => {
        if (reqId !== previewReq) return; // a newer selection superseded this one
        if (res && typeof res.svg === "string" && res.svg) {
          setPaneImage(previewPane, res.svg, "Symbol-Vorschau");
        } else {
          setPaneText(previewPane, (res && res.error) || "Keine Vorschau verfügbar");
        }
      })
      .catch((err) => {
        if (reqId !== previewReq) return;
        setPaneText(previewPane, (err && err.message) || "Vorschau fehlgeschlagen");
      });
  }

  // Footprint preview follows the Footprint-Source selector: EasyEDA default →
  // ``opts.fetchFootprintPreview()`` (the part's EasyEDA footprint), template →
  // ``opts.fetchTemplateFootprintPreview({libPath, name})`` (the curated
  // .kicad_mod). A stale-request token guards against out-of-order replies when
  // the user flips the selector quickly.
  let fpPreviewReq = 0;
  function loadFootprintPreview() {
    const layer = parseLayer(fpSelect.value);
    const reqId = ++fpPreviewReq;
    setPaneText(footprintPane, "Lade Footprint …");
    let fetchP;
    if (layer.source === "template") {
      fetchP =
        typeof opts.fetchTemplateFootprintPreview === "function"
          ? Promise.resolve(
              opts.fetchTemplateFootprintPreview({ libPath: layer.libPath, name: layer.name }),
            )
          : Promise.resolve({ svg: null, error: "Footprint-Vorschau nicht verfügbar" });
    } else {
      fetchP =
        typeof opts.fetchFootprintPreview === "function"
          ? Promise.resolve(opts.fetchFootprintPreview())
          : Promise.resolve({ svg: null, error: "Footprint-Vorschau nicht verfügbar" });
    }
    fetchP
      .then((res) => {
        if (reqId !== fpPreviewReq) return; // a newer selection superseded this one
        if (res && typeof res.svg === "string" && res.svg) {
          setPaneImage(footprintPane, res.svg, "Footprint-Vorschau");
        } else {
          setPaneText(footprintPane, (res && res.error) || "Keine Footprint-Vorschau");
        }
      })
      .catch((err) => {
        if (reqId !== fpPreviewReq) return;
        setPaneText(footprintPane, (err && err.message) || "Footprint-Vorschau fehlgeschlagen");
      });
  }

  // Category-matched templates for the current LCSC category (self-describing
  // templates) — the default shortlist. "show all" reveals every template.
  const matched = templatesMatchingCategory(categoryPath, opts.templateCategoriesByLib);
  const matchedKeys = new Set(
    matched.map((m) => encodeTemplateValue(m.libPath, m.name)),
  );
  const allLibs =
    opts.templateLibs && typeof opts.templateLibs === "object" ? opts.templateLibs : {};

  function renderTemplateList() {
    listHost.innerHTML = "";
    const items = [
      { value: EASYEDA_OPTION_VALUE, label: "EasyEDA (kein Template)", category: "" },
    ];
    if (showAllCb.checked) {
      for (const libPath of Object.keys(allLibs)) {
        const names = Array.isArray(allLibs[libPath]) ? allLibs[libPath] : [];
        for (const name of names) {
          items.push({ value: encodeTemplateValue(libPath, name), label: name, category: "" });
        }
      }
    } else {
      for (const m of matched) {
        items.push({
          value: encodeTemplateValue(m.libPath, m.name),
          label: m.name,
          category: m.category,
        });
      }
    }
    if (!showAllCb.checked && matched.length === 0) {
      const none = doc.createElement("div");
      none.style.cssText = `color:${T.placeholder};padding:${DIALOG_SPACING.xs} ${DIALOG_SPACING.xs};font-style:italic`;
      none.textContent = "Kein passendes Template — „alle Templates anzeigen“ aktivieren";
      listHost.appendChild(none);
    }
    for (const it of items) {
      const row = doc.createElement("div");
      row.setAttribute(OVERRIDE_REGISTER_TEMPLATE_ITEM_ATTR, "true");
      row.dataset.value = it.value;
      const selected = symSelect.value === it.value;
      row.style.cssText = [
        "display:flex", "justify-content:space-between", `gap:${DIALOG_SPACING.sm}`,
        `padding:${DIALOG_SPACING.xs} ${DIALOG_SPACING.xs}`, "border-radius:3px", "cursor:pointer",
        selected ? `background:${T.selectedSurface}` : "background:transparent",
        "transition:background 0.12s ease",
      ].join(";");
      const left = doc.createElement("span");
      left.textContent = it.label;
      left.style.cssText = selected
        ? `font-weight:600;color:${T.accent}`
        : `color:${T.text}`;
      row.appendChild(left);
      if (it.category) {
        const tag = doc.createElement("span");
        tag.textContent = it.category;
        tag.style.cssText = `color:${T.textFaint};font-size:${DIALOG_TYPE.micro}`;
        row.appendChild(tag);
      }
      // Hover affordance for unselected rows; selected rows keep their
      // accent highlight.
      if (!selected) {
        row.addEventListener("mouseenter", () => {
          row.style.background = T.surface3;
        });
        row.addEventListener("mouseleave", () => {
          row.style.background = "transparent";
        });
      }
      row.addEventListener("click", () => {
        symSelect.value = it.value;
        renderTemplateList();
      });
      listHost.appendChild(row);
    }
    updateSymbolPreview();
  }
  showAllCb.addEventListener("change", renderTemplateList);

  // Pin-label visibility (V2 carry-over): hide pin numbers / names in the
  // written symbol — typical for 2-pin parts (R/C/L/D) where they clutter the
  // schematic. The caller auto-prefills "hide numbers" for ≤2-pin parts via
  // opts.initialHidePinNumbers; the engine applies it on both symbol paths.
  const pinHeading = doc.createElement("div");
  pinHeading.textContent = "Pin-Beschriftung";
  pinHeading.style.cssText = `color:${T.textMuted};font-weight:600;font-size:${DIALOG_TYPE.micro}`;
  rightCol.appendChild(pinHeading);

  const pinRow = doc.createElement("div");
  pinRow.style.cssText = `display:flex;gap:${DIALOG_SPACING.lg};flex-wrap:wrap`;
  const mkPinCheckbox = (attr, labelText, checked) => {
    const lbl = doc.createElement("label");
    lbl.style.cssText =
      `display:flex;align-items:center;gap:${DIALOG_SPACING.xs};font-size:${DIALOG_TYPE.small};color:${T.text};cursor:pointer`;
    const cb = doc.createElement("input");
    cb.type = "checkbox";
    cb.setAttribute(attr, "true");
    cb.checked = Boolean(checked);
    lbl.appendChild(cb);
    lbl.appendChild(doc.createTextNode(labelText));
    pinRow.appendChild(lbl);
  };
  mkPinCheckbox(
    OVERRIDE_REGISTER_HIDE_PINNUM_ATTR,
    "Pin-Nummern ausblenden",
    opts.initialHidePinNumbers,
  );
  mkPinCheckbox(
    OVERRIDE_REGISTER_HIDE_PINNAME_ATTR,
    "Pin-Namen ausblenden",
    opts.initialHidePinNames,
  );
  rightCol.appendChild(pinRow);

  // Value-Param + Metadata preview (ADR-0006 refined). The Value dropdown picks
  // the one param whose value fills the KiCad Value field; the read-only preview
  // lists every param written as a Property and marks the chosen one ("→ Value")
  // — that one is NOT also written as a duplicate Property (engine excludes it).
  const pageParams =
    opts.pageParams && typeof opts.pageParams === "object" ? opts.pageParams : {};
  const propEntries = Object.entries(pageParams).filter(
    ([k, v]) =>
      typeof k === "string" && k.trim() && typeof v === "string" && v.trim(),
  );

  // Value-Param dropdown (over the preview). The select sits inside a flex
  // wrapper because ``applyDialogStyleSelect`` rewrites the select's own
  // ``cssText`` on focus/hover, which would otherwise wipe out the flex
  // sizing the row layout depends on.
  const valueRow = doc.createElement("label");
  valueRow.style.cssText =
    `display:flex;align-items:center;gap:${DIALOG_SPACING.sm};margin-top:${DIALOG_SPACING.xs};color:${T.textMuted}`;
  valueRow.appendChild(doc.createTextNode("Value-Feld"));
  const valueSelectWrap = doc.createElement("div");
  valueSelectWrap.style.cssText = "flex:1;min-width:0";
  const valueSelect = doc.createElement("select");
  valueSelect.setAttribute(OVERRIDE_REGISTER_VALUE_PARAM_ATTR, "true");
  applyDialogStyleSelect(valueSelect, { theme: opts.theme });
  const noneOpt = doc.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "— Kein Value-Param (EasyEDA-Standard) —";
  valueSelect.appendChild(noneOpt);
  for (const [k, v] of propEntries) {
    const opt = doc.createElement("option");
    opt.value = k;
    opt.textContent = `${k} — ${v}`;
    valueSelect.appendChild(opt);
  }
  // Preselect: caller's initialValueParam, else auto-detect, else none.
  const presetValueParam =
    (typeof opts.initialValueParam === "string" && opts.initialValueParam) ||
    detectValueParam(pageParams) ||
    "";
  const hasValueOpt = Array.from(valueSelect.options).some(
    (o) => o.value === presetValueParam,
  );
  valueSelect.value = hasValueOpt ? presetValueParam : "";
  valueSelectWrap.appendChild(valueSelect);
  valueRow.appendChild(valueSelectWrap);
  rightCol.appendChild(valueRow);

  const propHeading = doc.createElement("div");
  propHeading.textContent = propEntries.length
    ? `Eigenschaften, die ins Symbol übernommen werden (${propEntries.length})`
    : "Keine Metadaten auf der Produktseite gefunden";
  propHeading.style.cssText = `margin-top:${DIALOG_SPACING.xs};color:${T.textMuted};font-weight:600;font-size:${DIALOG_TYPE.micro}`;
  rightCol.appendChild(propHeading);

  if (propEntries.length) {
    const propList = doc.createElement("div");
    propList.setAttribute(OVERRIDE_REGISTER_PROP_PREVIEW_ATTR, "true");
    propList.style.cssText = [
      "display:flex",
      "flex-direction:column",
      "gap:2px",
      "max-height:180px",
      "overflow:auto",
      `border:1px solid ${T.borderSoft}`,
      `border-radius:${T.radiusSm}`,
      `padding:${DIALOG_SPACING.xs} ${DIALOG_SPACING.sm}`,
      `background:${T.surface2}`,
    ].join(";");
    // Re-rendered when the Value-Param changes so the "→ Value" badge follows.
    const renderPropPreview = () => {
      propList.innerHTML = "";
      const chosen = valueSelect.value;
      for (const [k, v] of propEntries) {
        const isValue = k === chosen;
        const propRow = doc.createElement("div");
        propRow.style.cssText =
          `display:flex;justify-content:space-between;gap:${DIALOG_SPACING.md};line-height:1.4`;
        const key = doc.createElement("span");
        key.textContent = isValue ? `${k} → Value` : k;
        key.style.cssText = isValue
          ? `color:${T.accent};font-weight:600;flex:0 0 auto`
          : `color:${T.textMuted};flex:0 0 auto`;
        const val = doc.createElement("span");
        val.textContent = v;
        val.style.cssText =
          `color:${T.textStrong};font-weight:500;text-align:right;word-break:break-word`;
        propRow.appendChild(key);
        propRow.appendChild(val);
        propList.appendChild(propRow);
      }
    };
    renderPropPreview();
    valueSelect.addEventListener("change", renderPropPreview);
    rightCol.appendChild(propList);
  }

  const actions = doc.createElement("div");
  actions.style.cssText = `display:flex;gap:${DIALOG_SPACING.sm};justify-content:flex-end;margin-top:${DIALOG_SPACING.xs};border-top:1px solid ${T.borderSoft};padding-top:${DIALOG_SPACING.md}`;

  const cancelBtn = doc.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Abbrechen";
  cancelBtn.setAttribute(OVERRIDE_REGISTER_CANCEL_ATTR, "true");
  cancelBtn.style.cssText = dialogButtonStyle("secondary", "wide", { theme: opts.theme });
  actions.appendChild(cancelBtn);

  const saveBtn = doc.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Übernehmen";
  saveBtn.setAttribute(OVERRIDE_REGISTER_SAVE_ATTR, "true");
  saveBtn.style.cssText = dialogButtonStyle("primary", "wide", { theme: opts.theme });
  actions.appendChild(saveBtn);

  panel.appendChild(actions);

  // Prefill the Symbol Source dropdown when the caller supplied one (🟢
  // [Modifizieren] path). Fall back to the EasyEDA default for the
  // fresh-register flow, and also when the supplied Template Library was
  // unregistered between the Rule's save time and now — the candidate
  // won't appear in the populated <option>s, and `renderOverridePanel`
  // won't have routed to 🟢 in that case anyway.
  const initialSym = opts.initialSymbolSource;
  let candidate = EASYEDA_OPTION_VALUE;
  if (initialSym?.source === "template" && initialSym.libPath && initialSym.name) {
    candidate = encodeTemplateValue(initialSym.libPath, initialSym.name);
  } else if (matched.length === 1) {
    // Unique category match → preselect it so a self-described part lands ready.
    candidate = encodeTemplateValue(matched[0].libPath, matched[0].name);
  }
  const hasOption = Array.from(symSelect.options).some(
    (o) => o.value === candidate,
  );
  symSelect.value = hasOption ? candidate : EASYEDA_OPTION_VALUE;
  // If the preselected template is not in the matched shortlist, reveal the
  // full list so the user can see what's selected.
  if (
    symSelect.value !== EASYEDA_OPTION_VALUE
    && !matchedKeys.has(symSelect.value)
  ) {
    showAllCb.checked = true;
  }

  // Footprint prefill (Modify path): preselect the rule's template footprint
  // when it is still present in the populated options; else stay on EasyEDA.
  const initialFp = opts.initialFootprintSource;
  if (initialFp?.source === "template" && initialFp.libPath && initialFp.name) {
    const fpCandidate = encodeTemplateValue(initialFp.libPath, initialFp.name);
    if (Array.from(fpSelect.options).some((o) => o.value === fpCandidate)) {
      fpSelect.value = fpCandidate;
    }
  }

  renderTemplateList();
  loadFootprintPreview();

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
  // Footprint-Source (#9): EasyEDA default or a curated template footprint.
  // Same ``"<source>:<libPath>:<name>"`` grammar as the symbol select; for a
  // footprint the libPath is the template ``.kicad_sym`` (the engine + preview
  // resolve the sibling ``.pretty``).
  const fpSelect = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
  const footprintSource = parseLayer(fpSelect?.value);
  const hidePinNumbers = Boolean(
    panel.querySelector(`[${OVERRIDE_REGISTER_HIDE_PINNUM_ATTR}]`)?.checked,
  );
  const hidePinNames = Boolean(
    panel.querySelector(`[${OVERRIDE_REGISTER_HIDE_PINNAME_ATTR}]`)?.checked,
  );
  const vp = panel.querySelector(`[${OVERRIDE_REGISTER_VALUE_PARAM_ATTR}]`)?.value;
  const valueParam = typeof vp === "string" && vp.trim() ? vp.trim() : null;
  return {
    categoryPath: typeof categoryPath === "string" ? categoryPath : "",
    rule: {
      symbolSource,
      footprintSource,
      // ADR-0006 (refined): metadata is auto-upserted from the page snapshot;
      // the rule no longer carries a manual label mapping.
      labelMapping: {},
      hidePinNumbers,
      hidePinNames,
      valueParam,
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
  const T = getDialogTokens(opts.theme);
  const panel = doc.createElement("div");
  panel.setAttribute(OVERRIDE_PANEL_ATTR, "true");
  panel.setAttribute(OVERRIDE_PANEL_MODE_ATTR, "sources");
  panel.style.cssText = [
    "display:flex",
    "flex-direction:column",
    `gap:${DIALOG_SPACING.sm}`,
    `padding:${DIALOG_SPACING.md} ${DIALOG_SPACING.md}`,
    `border:1px solid ${T.borderStrong}`,
    `border-radius:${T.radiusSm}`,
    `background:${T.surface2}`,
    `margin-top:${DIALOG_SPACING.xs}`,
    `font-size:${DIALOG_TYPE.small}`,
    `color:${T.text}`,
  ].join(";");

  const heading = doc.createElement("div");
  heading.textContent = "Override sources";
  heading.style.cssText = `font-weight:600;font-size:${DIALOG_TYPE.micro};letter-spacing:0.04em;text-transform:uppercase;color:${T.textMuted}`;
  panel.appendChild(heading);

  const symLabel = doc.createElement("label");
  symLabel.style.cssText = `display:flex;align-items:center;gap:${DIALOG_SPACING.sm}`;
  symLabel.appendChild(doc.createTextNode("Symbol"));
  const symSelect = doc.createElement("select");
  symSelect.setAttribute(OVERRIDE_SYMBOL_SELECT_ATTR, "true");
  populateSelect(symSelect, doc, opts.templateLibs);
  symLabel.appendChild(symSelect);
  panel.appendChild(symLabel);

  const fpLabel = doc.createElement("label");
  fpLabel.style.cssText = `display:flex;align-items:center;gap:${DIALOG_SPACING.sm}`;
  fpLabel.appendChild(doc.createTextNode("Footprint"));
  const fpSelect = doc.createElement("select");
  fpSelect.setAttribute(OVERRIDE_FOOTPRINT_SELECT_ATTR, "true");
  populateSelect(fpSelect, doc, opts.templateLibsFootprints || opts.templateLibs);
  fpLabel.appendChild(fpSelect);
  panel.appendChild(fpLabel);

  const actions = doc.createElement("div");
  actions.style.cssText = `display:flex;gap:${DIALOG_SPACING.sm};justify-content:flex-end;margin-top:${DIALOG_SPACING.xs}`;

  const cancelBtn = doc.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.setAttribute(OVERRIDE_CANCEL_ATTR, "true");
  cancelBtn.style.cssText = dialogButtonStyle("secondary", "dense", { theme: opts.theme });
  actions.appendChild(cancelBtn);

  const confirmBtn = doc.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.textContent = "Confirm";
  confirmBtn.setAttribute(OVERRIDE_CONFIRM_ATTR, "true");
  confirmBtn.style.cssText = dialogButtonStyle("primary", "dense", { theme: opts.theme });
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
      hidePinNumbers: opts.match?.rule?.hidePinNumbers ?? false,
      hidePinNames: opts.match?.rule?.hidePinNames ?? false,
      valueParam: opts.match?.rule?.valueParam ?? null,
      theme: opts.theme,
    });
  } else if (isYellow) {
    // ``keepEasyeda`` branch — Hinweis + EasyEDA default + editor escape.
    panel = buildYellowPanel(doc, {
      ruleKey: opts.match?.ruleKey ?? null,
      match: opts.match || null,
      theme: opts.theme,
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
      title: "Neues Bauteil",
      closeable: true,
      ariaLabel: "Neues Bauteil registrieren",
      children: [panel],
      closeOnBackdrop: true,
      closeOnEscape: true,
      theme: opts.theme,
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
    maxWidthPx: 720,
    title: "Import-Editor",
    closeable: true,
    ariaLabel: "Import-Editor — Symbol-/Footprint-Vorlagen zuweisen",
    children: [panel],
    closeOnBackdrop: true,
    closeOnEscape: true,
    theme: opts.theme,
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
