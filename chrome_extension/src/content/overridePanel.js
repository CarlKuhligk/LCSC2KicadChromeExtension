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
/** Pin↔Pad Mapper (Issue #9). */
export const OVERRIDE_REGISTER_PINMAP_ATTR = "data-k2c-register-pinmap";
export const OVERRIDE_REGISTER_PINMAP_TABLE_ATTR = "data-k2c-register-pinmap-table";
export const OVERRIDE_REGISTER_PINMAP_PAD_ATTR = "data-k2c-register-pinmap-pad";
export const OVERRIDE_REGISTER_MAPSTATUS_ATTR = "data-k2c-register-mapstatus";
/** Import-Editor 4-column layout — symbol/footprint lists + search (Issue #49). */
export const OVERRIDE_REGISTER_FOOTPRINT_LIST_ATTR = "data-k2c-register-footprint-list";
export const OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR = "data-k2c-register-footprint-item";
export const OVERRIDE_REGISTER_FP_SHOWALL_ATTR = "data-k2c-register-fp-showall";
export const OVERRIDE_REGISTER_SYMBOL_SEARCH_ATTR = "data-k2c-register-symbol-search";
export const OVERRIDE_REGISTER_FOOTPRINT_SEARCH_ATTR = "data-k2c-register-footprint-search";
/** Backend sentinel for "no connection" — mirrors the gallery's K2C_GALLERY_PAD_NC. */
export const OVERRIDE_REGISTER_PINMAP_NC = "__NC__";
/** 🟢 One-Click panel controls (Issue #29). */
export const OVERRIDE_IMPORT_ATTR = "data-k2c-override-import";
export const OVERRIDE_MODIFY_ATTR = "data-k2c-override-modify";
export const OVERRIDE_ONECLICK_PREVIEW_ATTR = "data-k2c-override-oneclick-preview";
/** 🟡 Low-Confidence panel controls (Issue #31). */
export const OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR = "data-k2c-yellow-keep-easyeda";
export const OVERRIDE_YELLOW_OPEN_EDITOR_ATTR = "data-k2c-yellow-open-editor";
export const OVERRIDE_YELLOW_HINT_ATTR = "data-k2c-yellow-hint";
/** EasyEDA-availability gate (Issue #47). The unavailable-message banner the
 * Override Panel renders when EasyEDA carries no CAD data; suppresses every
 * EasyEDA-dependent action so the user is steered into the template-only path
 * instead of running into ``ConversionError: No CAD data received…``. */
export const OVERRIDE_CAD_UNAVAILABLE_ATTR = "data-k2c-cad-unavailable";
export const CAD_UNAVAILABLE_MESSAGE =
  "EasyEDA hat keine Daten für dieses Teil — bitte eigenes Symbol- und Footprint-Template wählen.";

export const EASYEDA_OPTION_VALUE = "easyeda";
const TEMPLATE_VALUE_PREFIX = "template:";

/**
 * Build the shared ⚠ DE message banner (Issue #47). Rendered inside every panel
 * whose EasyEDA-dependent actions had to be suppressed. Themed via
 * ``dialog.js`` warning tokens so the styling tracks the user's chosen dialog
 * palette.
 */
function buildCadUnavailableNotice(doc, theme) {
  const T = getDialogTokens(theme);
  const notice = doc.createElement("div");
  notice.setAttribute(OVERRIDE_CAD_UNAVAILABLE_ATTR, "true");
  notice.textContent = CAD_UNAVAILABLE_MESSAGE;
  notice.style.cssText = [
    `padding:${DIALOG_SPACING.xs} ${DIALOG_SPACING.sm}`,
    `border:1px solid ${T.warningBorder}`,
    `border-radius:${T.radiusSm}`,
    `background:${T.warningSurface}`,
    `color:${T.warningText}`,
    `font-size:${DIALOG_TYPE.small}`,
    "line-height:1.4",
  ].join(";");
  return notice;
}

/**
 * Reduce the front-end gate to the same condition Phase 2's ``needs_easyeda``
 * branch checks (``conversion.py:556-560``) — keep ``genModel`` in the
 * disjunction so the gate stays correct when 3D is enabled in a later slice
 * (ADR-0005 / Issue #6). Today Phase 2 forces ``generate_model=False`` so
 * the third term collapses to the user's setting (defaults to false).
 *
 * @param {{symbol?: object|null, footprint?: object|null}} overrides
 * @param {boolean} [generateModel]
 * @returns {boolean}
 */
export function emittedOverridesNeedEasyeda(overrides, generateModel = false) {
  const symbol = overrides?.symbol;
  const footprint = overrides?.footprint;
  const symbolNeeds = symbol?.source !== "template";
  const footprintNeeds = footprint?.source !== "template";
  return symbolNeeds || footprintNeeds || Boolean(generateModel);
}

/**
 * Reduce Phase 1's ``cadAvailable`` flag to the single boolean the Issue #47
 * gate consumes: true iff EasyEDA carries neither a symbol nor a footprint
 * (the "No CAD data received" failure mode of ``conversion.py:590-593``).
 * Absent flag ⇒ false (no regression on older Native Hosts / snapshot path).
 *
 * @param {{symbol?: boolean, footprint?: boolean} | null | undefined} cadAvailable
 * @returns {boolean}
 */
export function isEasyedaUnavailable(cadAvailable) {
  if (cadAvailable == null) return false;
  return cadAvailable.symbol === false && cadAvailable.footprint === false;
}

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
 * **EasyEDA availability gate (Issue #47).** When ``opts.easyedaUnavailable``
 * is true the ``"nur EasyEDA"`` action is suppressed (it would route to
 * ``run_conversion``'s ``needs_easyeda`` branch and die with
 * ``ConversionError: No CAD data received…``) and the shared DE banner is
 * rendered above the actions. The ``„registrieren"`` action stays so the
 * user can still steer the part into a template-only import.
 *
 * @param {Document} doc
 * @param {{ onEasyedaOnly?: () => void, onRegister?: () => void, easyedaUnavailable?: boolean }} [opts]
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

  if (opts.easyedaUnavailable) {
    panel.appendChild(buildCadUnavailableNotice(doc, opts.theme));
  }

  const actions = doc.createElement("div");
  actions.style.cssText = `display:flex;gap:${DIALOG_SPACING.sm};justify-content:flex-end;margin-top:${DIALOG_SPACING.xs}`;

  // Issue #47: suppress „nur EasyEDA" when EasyEDA carries no CAD — the action
  // hard-routes through ``runEasyedaPhase2`` and the ``needs_easyeda`` branch
  // of ``conversion.py`` would die mid-fetch.
  if (!opts.easyedaUnavailable) {
    const easyedaBtn = doc.createElement("button");
    easyedaBtn.type = "button";
    easyedaBtn.textContent = "nur EasyEDA";
    easyedaBtn.setAttribute(OVERRIDE_EASYEDA_ONLY_ATTR, "true");
    easyedaBtn.style.cssText = dialogButtonStyle("secondary", "dense", { theme: opts.theme });
    actions.appendChild(easyedaBtn);
  }

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
 * **EasyEDA availability gate (Issue #47).** When ``opts.easyedaUnavailable``
 * is true the panel suppresses the ``[Import]`` action unless
 * ``opts.allowImport`` is also true (the rule resolves to template on BOTH
 * layers; ``runRulePhase2`` honors ``rule.footprintSource`` in that case so
 * the convert never re-acquires the EasyEDA dependency). The shared DE
 * banner is rendered above the actions. ``[Modifizieren]`` always stays —
 * the editor is the user's escape hatch into the template-only path.
 *
 * @param {Document} doc
 * @param {{
 *   ruleKey?: string | null,
 *   symbolSource?: object | null,
 *   labelMapping?: Record<string, string> | null,
 *   onImport?: () => void,
 *   onModify?: () => void,
 *   easyedaUnavailable?: boolean,
 *   allowImport?: boolean,
 * }} [opts]
 */
export function buildOneClickPanel(doc, opts = {}) {
  const T = getDialogTokens(opts.theme);
  const panel = doc.createElement("div");
  panel.setAttribute(OVERRIDE_PANEL_ATTR, "true");
  panel.setAttribute(OVERRIDE_PANEL_MODE_ATTR, "green");
  // Slim, neutral line that blends into the LCSC page — no loud green surface,
  // no preview text wall. Just the matched rule name + two LCSC-style actions;
  // clicking [Import] IS the confirm (ADR-0006 §U3.3).
  panel.style.cssText = [
    "display:flex",
    "flex-wrap:wrap",
    "align-items:center",
    `gap:${DIALOG_SPACING.sm}`,
    `margin-top:${DIALOG_SPACING.xs}`,
    `font-family:${T.fontUi}`,
    `font-size:${DIALOG_TYPE.small}`,
    `color:${T.textMuted}`,
  ].join(";");

  const label = doc.createElement("span");
  const ruleKey = typeof opts.ruleKey === "string" && opts.ruleKey ? opts.ruleKey : "";
  label.textContent = ruleKey ? `Vorlage „${ruleKey}“ erkannt` : "Vorlage erkannt";
  label.style.cssText = `color:${T.textMuted}`;
  panel.appendChild(label);

  if (opts.easyedaUnavailable) {
    panel.appendChild(buildCadUnavailableNotice(doc, opts.theme));
  }

  const actions = doc.createElement("span");
  actions.style.cssText = `display:inline-flex;gap:${DIALOG_SPACING.sm};margin-left:auto`;

  // [Bearbeiten] sits to the LEFT of [Import] so the cursor ends on the
  // primary action (one-click ergonomics).
  const modifyBtn = doc.createElement("button");
  modifyBtn.type = "button";
  modifyBtn.textContent = "Bearbeiten";
  modifyBtn.setAttribute(OVERRIDE_MODIFY_ATTR, "true");
  modifyBtn.style.cssText = dialogButtonStyle("secondary", "dense", { theme: opts.theme });
  actions.appendChild(modifyBtn);

  // Issue #47: in the unavailable case [Import] is only safe when the rule is
  // FULLY template (allowImport). Otherwise the green path's
  // ``runRulePhase2`` would emit an EasyEDA layer and Phase 2 would die.
  const showImport = !opts.easyedaUnavailable || opts.allowImport;
  if (showImport) {
    const importBtn = doc.createElement("button");
    importBtn.type = "button";
    importBtn.textContent = "Import";
    importBtn.setAttribute(OVERRIDE_IMPORT_ATTR, "true");
    importBtn.style.cssText = dialogButtonStyle("primary", "dense", { theme: opts.theme });
    actions.appendChild(importBtn);
  }

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
 * **EasyEDA availability gate (Issue #47).** When ``opts.easyedaUnavailable``
 * is true the ``[EasyEDA übernehmen]`` action is suppressed (it would route
 * through ``runEasyedaPhase2`` and die in ``needs_easyeda``). The shared DE
 * banner replaces the ``Vorschlag`` hint (any heuristic suggestion is moot
 * when the upstream CAD is missing). ``[Editor öffnen]`` remains so the
 * caller can swap in the template-on-both editor.
 *
 * @param {Document} doc
 * @param {{
 *   ruleKey?: string | null,
 *   match?: object | null,
 *   onEasyedaOnly?: () => void,
 *   onModify?: () => void,
 *   easyedaUnavailable?: boolean,
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
  if (hintLines.length && !opts.easyedaUnavailable) {
    const hint = doc.createElement("div");
    hint.setAttribute(OVERRIDE_YELLOW_HINT_ATTR, "true");
    hint.style.cssText = `line-height:1.4;color:${T.warningHint}`;
    hint.textContent = hintLines.join(" · ");
    panel.appendChild(hint);
  }

  if (opts.easyedaUnavailable) {
    panel.appendChild(buildCadUnavailableNotice(doc, opts.theme));
  }

  const actions = doc.createElement("div");
  actions.style.cssText = `display:flex;gap:${DIALOG_SPACING.sm};justify-content:flex-end;margin-top:${DIALOG_SPACING.xs}`;

  const openEditorBtn = doc.createElement("button");
  openEditorBtn.type = "button";
  openEditorBtn.textContent = "Editor öffnen";
  openEditorBtn.setAttribute(OVERRIDE_YELLOW_OPEN_EDITOR_ATTR, "true");
  openEditorBtn.style.cssText = dialogButtonStyle("secondary", "dense", { theme: opts.theme });
  actions.appendChild(openEditorBtn);

  // Issue #47: suppress „EasyEDA übernehmen" when EasyEDA carries no CAD —
  // the action routes through ``runEasyedaPhase2`` and would die in
  // ``needs_easyeda``.
  if (!opts.easyedaUnavailable) {
    const keepEasyedaBtn = doc.createElement("button");
    keepEasyedaBtn.type = "button";
    keepEasyedaBtn.textContent = "EasyEDA übernehmen";
    keepEasyedaBtn.setAttribute(OVERRIDE_YELLOW_KEEP_EASYEDA_ATTR, "true");
    keepEasyedaBtn.style.cssText = dialogButtonStyle("primary", "dense", { theme: opts.theme });
    actions.appendChild(keepEasyedaBtn);
  }

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
 * **EasyEDA availability gate (Issue #47).** ``opts.easyedaUnavailable`` tells
 * the editor to default BOTH the symbol and footprint selects to a template
 * option instead of EasyEDA — the part EasyEDA does not carry CAD for can
 * still be imported from the user's templates. When the caller supplied no
 * matching ``initialSymbolSource`` / ``initialFootprintSource``, the first
 * registered template (in each layer's library map) is preselected. The user
 * still has to confirm the concrete pick; the gate's job is only to make sure
 * EasyEDA isn't the pre-selected/blocking choice.
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
 *   easyedaUnavailable?: boolean,
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

  // Import-Editor 4-column layout (Issue #49 redesign of the #9 two-pane).
  //
  // TOP BAR (full width, above the grid): heading "Registrieren", category line,
  // live Pin-Mapper status strip. The intent is one glanceable "what's happening"
  // line above every control.
  //
  // BODY (CSS Grid): four columns — SYMBOL list · SYMBOL viewer · FOOTPRINT viewer
  // · FOOTPRINT list — built with ``repeat(auto-fit, minmax(220px, 1fr))`` so the
  // layout collapses intrinsically (4→2→1 columns) without any post-mount
  // width-read (a width-read would race ``mountCsModal``'s own layout pass).
  //
  // BOTTOM BLOCK (centered under the two viewers): the read-only METADATA
  // preview (``Value-Feld`` + ``OVERRIDE_REGISTER_PROP_PREVIEW_ATTR`` list) and
  // the Pin↔Pad Mapper sit here, ``max-width:720px;margin:0 auto`` so they read
  // as a single centered block beneath the viewers.
  const topBar = doc.createElement("div");
  topBar.style.cssText = `display:flex;flex-direction:column;gap:${DIALOG_SPACING.xs}`;
  panel.appendChild(topBar);

  const body = doc.createElement("div");
  // 4 vertical slices: [symbol list | symbol viewer | footprint viewer | footprint list].
  // The two side LISTS span BOTH rows (full height); the viewers sit in row 1, and the
  // metadata + Pin-Mapper block fills row 2 UNDER the viewers (cols 2–3) — so the lists
  // are never shortened by it.
  body.style.cssText = [
    "display:grid",
    "grid-template-columns:minmax(170px,0.8fr) minmax(210px,1.1fr) minmax(210px,1.1fr) minmax(170px,0.8fr)",
    "grid-template-rows:auto auto",
    `gap:${DIALOG_SPACING.lg}`,
    "align-items:stretch",
  ].join(";");
  panel.appendChild(body);

  const mkColLabel = (text) => {
    const el = doc.createElement("div");
    el.textContent = text;
    el.style.cssText = `color:${T.textMuted};font-weight:600;font-size:${DIALOG_TYPE.micro}`;
    return el;
  };

  const mkSearchInput = (attr, placeholder) => {
    const input = doc.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.setAttribute(attr, "true");
    input.style.cssText = [
      `border:1px solid ${T.borderSoft}`,
      `background:${T.surface}`,
      `color:${T.text}`,
      `font-size:${DIALOG_TYPE.small}`,
      `border-radius:${T.radiusSm}`,
      `padding:${DIALOG_SPACING.xs} ${DIALOG_SPACING.sm}`,
      "min-width:0",
      "width:100%",
      "box-sizing:border-box",
    ].join(";");
    return input;
  };

  // Build a clickable choice row for either list (#49). Shared so the symbol
  // and footprint lists render with byte-identical styling — hover affordance,
  // selected accent, optional category tag. Click wiring is passed in because
  // the symbol list re-renders only, while the footprint list also kicks off
  // ``loadFootprintPreview`` after the value change.
  const mkChoiceRow = (item, { itemAttr, selected, matched = false, original = false, onClick }) => {
    const row = doc.createElement("div");
    row.setAttribute(itemAttr, "true");
    row.dataset.value = item.value;
    if (matched) row.dataset.k2cMatched = "true";
    if (original) row.dataset.k2cOriginal = "true";
    // Subtle left accent bar: a system-MATCHED entry (category match for symbols,
    // package match for footprints) gets the accent color; the EasyEDA "ORIGINAL"
    // entry a muted bar. Drawn as an inset box-shadow so the hover/selected
    // background never wipes it — quiet but perceptible.
    const accentBar = matched
      ? `box-shadow:inset 3px 0 0 ${T.accent}`
      : original
        ? `box-shadow:inset 3px 0 0 ${T.textFaint}`
        : "";
    row.style.cssText = [
      "display:flex", "justify-content:space-between", `gap:${DIALOG_SPACING.sm}`,
      `padding:${DIALOG_SPACING.xs} ${DIALOG_SPACING.xs}`, "border-radius:3px", "cursor:pointer",
      selected ? `background:${T.selectedSurface}` : "background:transparent",
      "transition:background 0.12s ease",
      accentBar,
    ].filter(Boolean).join(";");
    const left = doc.createElement("span");
    left.textContent = item.label;
    left.style.cssText = selected
      ? `font-weight:600;color:${T.accent}`
      : `color:${T.text}`;
    row.appendChild(left);
    if (item.category) {
      const tag = doc.createElement("span");
      tag.textContent = item.category;
      tag.style.cssText = `color:${T.textFaint};font-size:${DIALOG_TYPE.micro}`;
      row.appendChild(tag);
    }
    if (!selected) {
      row.addEventListener("mouseenter", () => {
        row.style.background = T.surface3;
      });
      row.addEventListener("mouseleave", () => {
        row.style.background = "transparent";
      });
    }
    row.addEventListener("click", onClick);
    return row;
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

  // Live Pin-Mapper status strip (Issue #9). One short line that summarizes the
  // current assignment so the user can verify completeness at a glance without
  // scanning the table. Updated on every <select> change.
  const mapStatus = doc.createElement("div");
  mapStatus.setAttribute(OVERRIDE_REGISTER_MAPSTATUS_ATTR, "true");
  mapStatus.style.cssText = [
    "display:inline-block",
    "align-self:flex-start",
    `padding:2px ${DIALOG_SPACING.sm}`,
    `border-radius:${T.radiusSm}`,
    `font-size:${DIALOG_TYPE.micro}`,
    `background:${T.primarySoft}`,
    `color:${T.primary}`,
  ].join(";");
  mapStatus.textContent = "Standard (1:1)";
  topBar.appendChild(mapStatus);

  /* ----- COLUMN 1 — Symbol list -------------------------------------------- */

  const symbolCol = doc.createElement("div");
  symbolCol.style.cssText = `display:flex;flex-direction:column;gap:${DIALOG_SPACING.sm};min-width:0;min-height:0;grid-column:1;grid-row:1 / span 2`;
  body.appendChild(symbolCol);

  // Hidden <select> is the source of truth — parseLayer / collectRegisterEditorRule
  // read it, prefill sets it, the visible LIST drives it on click.
  const symSelect = doc.createElement("select");
  symSelect.setAttribute(OVERRIDE_SYMBOL_SELECT_ATTR, "true");
  populateSelect(symSelect, doc, opts.templateLibs);
  symSelect.style.cssText = "display:none";
  symbolCol.appendChild(symSelect);

  const symSearch = mkSearchInput(
    OVERRIDE_REGISTER_SYMBOL_SEARCH_ATTR,
    "Symbol suchen …",
  );
  symbolCol.appendChild(symSearch);

  const symHeadRow = doc.createElement("div");
  symHeadRow.style.cssText =
    `display:flex;align-items:center;justify-content:space-between;gap:${DIALOG_SPACING.sm};flex-wrap:wrap`;
  symHeadRow.appendChild(mkColLabel("Symbol-Vorlage"));
  const showAllLabel = doc.createElement("label");
  showAllLabel.style.cssText =
    `display:flex;align-items:center;gap:${DIALOG_SPACING.xs};font-size:${DIALOG_TYPE.micro};color:${T.textFaint};cursor:pointer`;
  const showAllCb = doc.createElement("input");
  showAllCb.type = "checkbox";
  showAllCb.setAttribute(OVERRIDE_REGISTER_SHOWALL_ATTR, "true");
  showAllLabel.appendChild(showAllCb);
  showAllLabel.appendChild(doc.createTextNode("alle Templates anzeigen"));
  symHeadRow.appendChild(showAllLabel);
  symbolCol.appendChild(symHeadRow);

  const listHost = doc.createElement("div");
  listHost.setAttribute(OVERRIDE_REGISTER_TEMPLATE_LIST_ATTR, "true");
  listHost.style.cssText = [
    "display:flex", "flex-direction:column", "gap:2px",
    "flex:1 1 0", "min-height:120px", "overflow:auto",
    `border:1px solid ${T.borderStrong}`, `border-radius:${T.radiusSm}`,
    `padding:${DIALOG_SPACING.xs}`,
    `background:${T.surface2}`,
  ].join(";");
  symbolCol.appendChild(listHost);

  /* ----- COLUMN 2 — Symbol viewer ------------------------------------------ */

  const paneStyle = [
    "display:flex", "align-items:center", "justify-content:center",
    "min-height:120px", "max-height:240px", `padding:${DIALOG_SPACING.xs}`,
    `border:1px solid ${T.borderStrong}`, `border-radius:${T.radiusSm}`,
    `background:${T.surface2}`,
    "overflow:hidden",
  ].join(";");

  const symPreviewCell = doc.createElement("div");
  symPreviewCell.style.cssText = `display:flex;flex-direction:column;gap:${DIALOG_SPACING.xs};min-width:0;grid-column:2;grid-row:1`;
  symPreviewCell.appendChild(mkColLabel("Symbol"));
  const previewPane = doc.createElement("div");
  previewPane.setAttribute(OVERRIDE_REGISTER_SYMBOL_PREVIEW_ATTR, "true");
  previewPane.style.cssText = paneStyle;
  symPreviewCell.appendChild(previewPane);
  body.appendChild(symPreviewCell);

  /* ----- COLUMN 3 — Footprint viewer --------------------------------------- */

  const fpPreviewCell = doc.createElement("div");
  fpPreviewCell.style.cssText = `display:flex;flex-direction:column;gap:${DIALOG_SPACING.xs};min-width:0;grid-column:3;grid-row:1`;
  fpPreviewCell.appendChild(mkColLabel("Footprint"));
  const footprintPane = doc.createElement("div");
  footprintPane.setAttribute(OVERRIDE_REGISTER_FOOTPRINT_PREVIEW_ATTR, "true");
  footprintPane.style.cssText = paneStyle;
  fpPreviewCell.appendChild(footprintPane);
  body.appendChild(fpPreviewCell);

  /* ----- COLUMN 4 — Footprint list ----------------------------------------- */

  const footprintCol = doc.createElement("div");
  footprintCol.style.cssText = `display:flex;flex-direction:column;gap:${DIALOG_SPACING.sm};min-width:0;min-height:0;grid-column:4;grid-row:1 / span 2`;
  body.appendChild(footprintCol);

  // Hidden <select> is the source of truth (kept for collectRegisterEditorRule
  // and ``OVERRIDE_FOOTPRINT_SELECT_ATTR`` round-trips). The visible LIST drives
  // its ``.value`` on click; the existing change-listener still re-renders the
  // footprint preview + Pin-Mapper.
  const fpSelect = doc.createElement("select");
  fpSelect.setAttribute(OVERRIDE_FOOTPRINT_SELECT_ATTR, "true");
  populateSelect(fpSelect, doc, opts.templateLibsFootprints);
  fpSelect.style.cssText = "display:none";
  fpSelect.addEventListener("change", () => loadFootprintPreview());
  footprintCol.appendChild(fpSelect);

  const fpSearch = mkSearchInput(
    OVERRIDE_REGISTER_FOOTPRINT_SEARCH_ATTR,
    "Footprint suchen …",
  );
  footprintCol.appendChild(fpSearch);

  const fpHeadRow = doc.createElement("div");
  fpHeadRow.style.cssText =
    `display:flex;align-items:center;justify-content:space-between;gap:${DIALOG_SPACING.sm};flex-wrap:wrap`;
  fpHeadRow.appendChild(mkColLabel("Footprint-Vorlage"));
  const fpShowAllLabel = doc.createElement("label");
  fpShowAllLabel.style.cssText =
    `display:flex;align-items:center;gap:${DIALOG_SPACING.xs};font-size:${DIALOG_TYPE.micro};color:${T.textFaint};cursor:pointer`;
  const fpShowAllCb = doc.createElement("input");
  fpShowAllCb.type = "checkbox";
  fpShowAllCb.setAttribute(OVERRIDE_REGISTER_FP_SHOWALL_ATTR, "true");
  fpShowAllLabel.appendChild(fpShowAllCb);
  fpShowAllLabel.appendChild(doc.createTextNode("alle Footprints anzeigen"));
  fpHeadRow.appendChild(fpShowAllLabel);
  footprintCol.appendChild(fpHeadRow);

  const fpListHost = doc.createElement("div");
  fpListHost.setAttribute(OVERRIDE_REGISTER_FOOTPRINT_LIST_ATTR, "true");
  fpListHost.style.cssText = [
    "display:flex", "flex-direction:column", "gap:2px",
    "flex:1 1 0", "min-height:120px", "overflow:auto",
    `border:1px solid ${T.borderStrong}`, `border-radius:${T.radiusSm}`,
    `padding:${DIALOG_SPACING.xs}`,
    `background:${T.surface2}`,
  ].join(";");
  footprintCol.appendChild(fpListHost);

  /* ----- BOTTOM BLOCK — METADATA + Pin↔Pad Mapper (centered) --------------- */

  // Metadata + Pin-Mapper sit in ROW 2 of the middle two slices — directly UNDER the
  // symbol & footprint viewers — spanning cols 2–3. The side lists (cols 1 & 4) keep
  // their full height because they span both rows.
  const bottomBlock = doc.createElement("div");
  bottomBlock.style.cssText = [
    "display:flex",
    "flex-direction:column",
    `gap:${DIALOG_SPACING.sm}`,
    "min-width:0",
    "grid-column:2 / span 2",
    "grid-row:2",
  ].join(";");
  body.appendChild(bottomBlock);

  // Pin-label visibility (V2 carry-over): hide pin numbers / names in the
  // written symbol — typical for 2-pin parts (R/C/L/D) where they clutter the
  // schematic. The caller auto-prefills "hide numbers" for ≤2-pin parts via
  // opts.initialHidePinNumbers; the engine applies it on both symbol paths.
  bottomBlock.appendChild(mkColLabel("Pin-Beschriftung"));

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
  bottomBlock.appendChild(pinRow);

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
    `display:flex;align-items:center;gap:${DIALOG_SPACING.sm};color:${T.textMuted}`;
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
  bottomBlock.appendChild(valueRow);

  bottomBlock.appendChild(mkColLabel(
    propEntries.length
      ? `Eigenschaften, die ins Symbol übernommen werden (${propEntries.length})`
      : "Keine Metadaten auf der Produktseite gefunden",
  ));

  if (propEntries.length) {
    const propList = doc.createElement("div");
    propList.setAttribute(OVERRIDE_REGISTER_PROP_PREVIEW_ATTR, "true");
    propList.style.cssText = [
      "display:flex",
      "flex-direction:column",
      "gap:2px",
      "max-height:160px",
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
    bottomBlock.appendChild(propList);
  }

  // Pin↔Pad Mapper (#9). A pad-driven assignment table — one <tr> per footprint
  // pad with a native <select> picking which template symbol pin connects to it.
  // Same mental model as the gallery's renderFootprintPadMapTable; native selects
  // give Tab walking + arrow keys + typeahead for free. Drag, inline-SVG, and
  // bezier connectors are deferred (the verified-highest-risk pieces).
  const pinMapHost = doc.createElement("div");
  pinMapHost.setAttribute(OVERRIDE_REGISTER_PINMAP_ATTR, "true");
  pinMapHost.style.cssText = [
    "display:flex",
    "flex-direction:column",
    `gap:${DIALOG_SPACING.xs}`,
    `padding:${DIALOG_SPACING.sm}`,
    `border:1px solid ${T.borderSoft}`,
    `border-radius:${T.radiusSm}`,
    `background:${T.surface2}`,
  ].join(";");
  pinMapHost.appendChild(mkColLabel("Pin-Zuordnung (Footprint-Pad → Symbol-Pin)"));
  const pinMapBody = doc.createElement("div");
  pinMapBody.style.cssText = "max-height:240px;overflow:auto";
  pinMapHost.appendChild(pinMapBody);
  bottomBlock.appendChild(pinMapHost);

  /* ----- Preview fetch helpers --------------------------------------------- */

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

  // Captured from the preview fetcher returns — drive the Pin-Mapper without
  // re-parsing the SVG. Absent ⇒ mapper shows a placeholder.
  let editorSymbolPins = [];
  let editorFootprintPads = [];

  let previewReq = 0;
  function updateSymbolPreview() {
    const layer = parseLayer(symSelect.value);
    if (layer.source !== "template") {
      setPaneText(previewPane, "EasyEDA-Standardsymbol — keine Vorschau");
      editorSymbolPins = [];
      rebuildPinMap();
      return;
    }
    if (typeof opts.fetchSymbolPreview !== "function") {
      setPaneText(previewPane, "Vorschau nicht verfügbar");
      editorSymbolPins = [];
      rebuildPinMap();
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
        editorSymbolPins = res && Array.isArray(res.pins) ? res.pins : [];
        rebuildPinMap();
      })
      .catch((err) => {
        if (reqId !== previewReq) return;
        setPaneText(previewPane, (err && err.message) || "Vorschau fehlgeschlagen");
        editorSymbolPins = [];
        rebuildPinMap();
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
    const isTemplate = layer.source === "template";
    if (isTemplate) {
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
        // Pad labels are only available on the EasyEDA path (``lcscFootprintPreview``
        // returns ``pads``). Template footprints have no pad-label source today
        // (``template_footprint_preview`` only ships ``meta.pad_count``), so the
        // mapper shows a "noch nicht verfügbar" placeholder for template FPs.
        if (!isTemplate && res && Array.isArray(res.pads)) {
          editorFootprintPads = res.pads;
        } else {
          editorFootprintPads = [];
        }
        rebuildPinMap();
      })
      .catch((err) => {
        if (reqId !== fpPreviewReq) return;
        setPaneText(footprintPane, (err && err.message) || "Footprint-Vorschau fehlgeschlagen");
        editorFootprintPads = [];
        rebuildPinMap();
      });
  }

  /* ----- Pin↔Pad Mapper ---------------------------------------------------- */

  function setMapStatus(text, tone) {
    mapStatus.textContent = text;
    let bg = T.primarySoft;
    let fg = T.primary;
    if (tone === "success") {
      bg = T.successSurface;
      fg = T.successText;
    } else if (tone === "warning") {
      bg = T.warningSurface;
      fg = T.warningText;
    }
    mapStatus.style.background = bg;
    mapStatus.style.color = fg;
  }

  function showPinMapPlaceholder(text) {
    const placeholder = doc.createElement("div");
    placeholder.textContent = text;
    placeholder.style.cssText =
      `color:${T.placeholder};font-size:${DIALOG_TYPE.micro};font-style:italic;padding:${DIALOG_SPACING.xs}`;
    pinMapBody.appendChild(placeholder);
    setMapStatus("Standard (1:1)", null);
  }

  function rebuildPinMap() {
    // Snapshot existing user choices BEFORE clearing so a preview swap doesn't
    // silently wipe a hand-made mapping for pads that still exist post-swap.
    const prevChoices = readEditorPadToSymbolMap(panel);
    pinMapBody.innerHTML = "";

    const usingTemplateSymbol = parseLayer(symSelect.value).source === "template";
    const usingTemplateFootprint = parseLayer(fpSelect.value).source === "template";

    if (!usingTemplateSymbol) {
      showPinMapPlaceholder("Pin-Zuordnung nur für Template-Symbole");
      return;
    }
    if (usingTemplateFootprint) {
      showPinMapPlaceholder("Pin-Zuordnung für Template-Footprints noch nicht verfügbar");
      return;
    }
    if (!editorFootprintPads.length || !editorSymbolPins.length) {
      showPinMapPlaceholder(
        editorFootprintPads.length
          ? "Pin-Daten der Vorlage werden geladen …"
          : "Pad-Daten des Footprints werden geladen …",
      );
      return;
    }

    const table = doc.createElement("table");
    table.setAttribute(OVERRIDE_REGISTER_PINMAP_TABLE_ATTR, "true");
    table.style.cssText = `width:100%;border-collapse:collapse;font-size:${DIALOG_TYPE.small}`;

    const thead = doc.createElement("thead");
    const headRow = doc.createElement("tr");
    for (const text of ["Footprint-Pad", "Symbol-Pin"]) {
      const th = doc.createElement("th");
      th.scope = "col";
      th.textContent = text;
      th.style.cssText = [
        "position:sticky", "top:0", "text-align:left",
        `padding:${DIALOG_SPACING.xs} ${DIALOG_SPACING.sm}`,
        `background:${T.surface3}`,
        `color:${T.textMuted}`,
        `border-bottom:1px solid ${T.borderSoft}`,
        `font-size:${DIALOG_TYPE.micro}`,
        "font-weight:600",
      ].join(";");
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = doc.createElement("tbody");
    for (const padRaw of editorFootprintPads) {
      const padLabel = String(padRaw ?? "");
      if (!padLabel) continue;
      const tr = doc.createElement("tr");
      const padCell = doc.createElement("td");
      padCell.textContent = padLabel;
      padCell.style.cssText = [
        `padding:${DIALOG_SPACING.xs} ${DIALOG_SPACING.sm}`,
        `color:${T.textStrong}`,
        "font-weight:600",
        "font-variant-numeric:tabular-nums",
        `border-bottom:1px solid ${T.borderSoft}`,
        "width:1%",
        "white-space:nowrap",
      ].join(";");
      tr.appendChild(padCell);

      const selCell = doc.createElement("td");
      selCell.style.cssText =
        `padding:${DIALOG_SPACING.xs} ${DIALOG_SPACING.sm};border-bottom:1px solid ${T.borderSoft}`;
      const sel = doc.createElement("select");
      sel.setAttribute(OVERRIDE_REGISTER_PINMAP_PAD_ATTR, padLabel);
      sel.setAttribute(
        "aria-label",
        `Symbol-Pin für Footprint-Pad ${padLabel}`,
      );
      applyDialogStyleSelect(sel, { theme: opts.theme });

      const ncOpt = doc.createElement("option");
      ncOpt.value = OVERRIDE_REGISTER_PINMAP_NC;
      ncOpt.textContent = "NC";
      sel.appendChild(ncOpt);
      for (const pin of editorSymbolPins) {
        if (!pin || pin.number == null) continue;
        const opt = doc.createElement("option");
        opt.value = String(pin.number);
        const label = pin.name ? `${pin.number} · ${pin.name}` : String(pin.number);
        opt.textContent = label;
        sel.appendChild(opt);
      }

      // Preserve a still-valid prior choice; else auto-default 1:1 (with digit
      // normalization "01"→"1"); else NC.
      const prior = prevChoices[padLabel];
      const validPriorPin =
        typeof prior === "string"
          && prior !== ""
          && (prior === OVERRIDE_REGISTER_PINMAP_NC
            || editorSymbolPins.some((p) => String(p?.number) === prior));
      if (validPriorPin) {
        sel.value = prior;
      } else {
        const padNorm = normalizePinMapPadLabel(padLabel);
        const autoPin = editorSymbolPins.find(
          (p) => normalizePinMapPadLabel(String(p?.number ?? "")) === padNorm,
        );
        sel.value = autoPin ? String(autoPin.number) : OVERRIDE_REGISTER_PINMAP_NC;
      }

      sel.addEventListener("change", updateMapStatus);
      selCell.appendChild(sel);
      tr.appendChild(selCell);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    pinMapBody.appendChild(table);
    updateMapStatus();
  }

  function updateMapStatus() {
    const selects = pinMapBody.querySelectorAll(
      `select[${OVERRIDE_REGISTER_PINMAP_PAD_ATTR}]`,
    );
    if (!selects.length) {
      // Placeholder mode — keep whatever setMapStatus already set in rebuildPinMap.
      return;
    }
    let assigned = 0;
    for (const s of selects) {
      if (s.value && s.value !== OVERRIDE_REGISTER_PINMAP_NC) assigned += 1;
    }
    const open = selects.length - assigned;
    const tone = open === 0 ? "success" : "warning";
    setMapStatus(
      `Pin-Zuordnung: ${assigned}/${selects.length} zugeordnet · ${open} offen`,
      tone,
    );
  }

  /* ----- Category-matched template list + search (Issue #49) -------------- */

  // Category-matched templates for the current LCSC category (self-describing
  // templates) — the default shortlist. "show all" reveals every template,
  // and the symbol search (when non-empty) expands the candidate pool to the
  // full library set regardless of category match / show-all.
  const matched = templatesMatchingCategory(categoryPath, opts.templateCategoriesByLib);
  const matchedKeys = new Set(
    matched.map((m) => encodeTemplateValue(m.libPath, m.name)),
  );
  const allLibs =
    opts.templateLibs && typeof opts.templateLibs === "object" ? opts.templateLibs : {};
  const allFootprintLibs =
    opts.templateLibsFootprints && typeof opts.templateLibsFootprints === "object"
      ? opts.templateLibsFootprints
      : {};
  const packageHintLower =
    typeof opts.packageHint === "string"
      ? opts.packageHint.trim().toLowerCase()
      : "";

  function renderTemplateList() {
    listHost.innerHTML = "";
    const query = symSearch.value.trim().toLowerCase();
    // EasyEDA row is always present so the user can return to the default
    // regardless of search/show-all state.
    const items = [
      { value: EASYEDA_OPTION_VALUE, label: "EasyEDA (kein Template)", category: "" },
    ];
    if (query) {
      // Non-empty query expands the pool to every registered template; the
      // category-matched shortlist is irrelevant when the user is searching.
      for (const libPath of Object.keys(allLibs)) {
        const names = Array.isArray(allLibs[libPath]) ? allLibs[libPath] : [];
        for (const name of names) {
          if (!name.toLowerCase().includes(query)) continue;
          items.push({
            value: encodeTemplateValue(libPath, name),
            label: name,
            category: "",
          });
        }
      }
    } else if (showAllCb.checked) {
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
    if (!query && !showAllCb.checked && matched.length === 0) {
      const none = doc.createElement("div");
      none.style.cssText = `color:${T.placeholder};padding:${DIALOG_SPACING.xs} ${DIALOG_SPACING.xs};font-style:italic`;
      none.textContent = "Kein passendes Template — „alle Templates anzeigen“ aktivieren";
      listHost.appendChild(none);
    }
    for (const it of items) {
      listHost.appendChild(mkChoiceRow(it, {
        itemAttr: OVERRIDE_REGISTER_TEMPLATE_ITEM_ATTR,
        selected: symSelect.value === it.value,
        matched: matchedKeys.has(it.value),
        original: it.value === EASYEDA_OPTION_VALUE,
        onClick: () => {
          symSelect.value = it.value;
          renderTemplateList();
        },
      }));
    }
    updateSymbolPreview();
  }
  showAllCb.addEventListener("change", renderTemplateList);
  symSearch.addEventListener("input", renderTemplateList);

  // Footprint list (Issue #49) — mirrors the symbol list. EasyEDA always shown.
  // Default subset filters by ``opts.packageHint`` (case-insensitive substring
  // of the footprint name) when the show-all toggle is off; when no package
  // hint is supplied, the default IS show-all (no surprise hiding). A non-empty
  // search query overrides both: it walks the full footprint pool and filters
  // by substring.
  function renderFootprintList() {
    fpListHost.innerHTML = "";
    const query = fpSearch.value.trim().toLowerCase();
    // Hint filter only applies in the default state: checkbox off, no hint
    // override from search, and a hint string exists in the first place.
    const filterByHint = !query && !fpShowAllCb.checked && Boolean(packageHintLower);
    const items = [
      { value: EASYEDA_OPTION_VALUE, label: "EasyEDA (kein Template)" },
    ];
    for (const libPath of Object.keys(allFootprintLibs)) {
      const names = Array.isArray(allFootprintLibs[libPath])
        ? allFootprintLibs[libPath]
        : [];
      for (const name of names) {
        const nameLower = name.toLowerCase();
        if (query && !nameLower.includes(query)) continue;
        if (filterByHint && !nameLower.includes(packageHintLower)) continue;
        items.push({ value: encodeTemplateValue(libPath, name), label: name });
      }
    }
    for (const it of items) {
      fpListHost.appendChild(mkChoiceRow(it, {
        itemAttr: OVERRIDE_REGISTER_FOOTPRINT_ITEM_ATTR,
        selected: fpSelect.value === it.value,
        matched:
          it.value !== EASYEDA_OPTION_VALUE
          && Boolean(packageHintLower)
          && it.label.toLowerCase().includes(packageHintLower),
        original: it.value === EASYEDA_OPTION_VALUE,
        onClick: () => {
          fpSelect.value = it.value;
          renderFootprintList();
          loadFootprintPreview();
        },
      }));
    }
  }
  fpShowAllCb.addEventListener("change", renderFootprintList);
  fpSearch.addEventListener("input", renderFootprintList);

  /* ----- Actions ----------------------------------------------------------- */

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
  //
  // Issue #47 — when EasyEDA carries no CAD the fallback flips from EasyEDA
  // to the first registered template option (Symbol-Source's <select> options
  // are in optgroup-order; skip the EasyEDA option). The user still has to
  // confirm a concrete pick; the gate only ensures EasyEDA isn't the default.
  const initialSym = opts.initialSymbolSource;
  const firstTemplateSymbolOpt = Array.from(symSelect.options).find(
    (o) => o.value !== EASYEDA_OPTION_VALUE,
  );
  const symbolFallback =
    opts.easyedaUnavailable && firstTemplateSymbolOpt
      ? firstTemplateSymbolOpt.value
      : EASYEDA_OPTION_VALUE;
  let candidate = symbolFallback;
  if (initialSym?.source === "template" && initialSym.libPath && initialSym.name) {
    candidate = encodeTemplateValue(initialSym.libPath, initialSym.name);
  } else if (matched.length === 1) {
    // Unique category match → preselect it so a self-described part lands ready.
    candidate = encodeTemplateValue(matched[0].libPath, matched[0].name);
  }
  const hasOption = Array.from(symSelect.options).some(
    (o) => o.value === candidate,
  );
  symSelect.value = hasOption ? candidate : symbolFallback;
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
  // Issue #47 — unavailable mode flips the default to the first registered
  // template footprint instead of EasyEDA.
  const initialFp = opts.initialFootprintSource;
  if (initialFp?.source === "template" && initialFp.libPath && initialFp.name) {
    const fpCandidate = encodeTemplateValue(initialFp.libPath, initialFp.name);
    if (Array.from(fpSelect.options).some((o) => o.value === fpCandidate)) {
      fpSelect.value = fpCandidate;
    }
  } else if (opts.easyedaUnavailable) {
    const firstTemplateFpOpt = Array.from(fpSelect.options).find(
      (o) => o.value !== EASYEDA_OPTION_VALUE,
    );
    if (firstTemplateFpOpt) fpSelect.value = firstTemplateFpOpt.value;
  }

  // If the selected footprint is outside the default subset (package-hint
  // filter), auto-tick "alle Footprints anzeigen" so the user can see what's
  // selected — same auto-reveal pattern the symbol show-all uses above.
  if (
    fpSelect.value !== EASYEDA_OPTION_VALUE
    && packageHintLower
    && !fpShowAllCb.checked
  ) {
    const fpLayer = parseLayer(fpSelect.value);
    if (
      fpLayer.source === "template"
      && !String(fpLayer.name || "").toLowerCase().includes(packageHintLower)
    ) {
      fpShowAllCb.checked = true;
    }
  }

  renderTemplateList();
  renderFootprintList();
  loadFootprintPreview();

  return panel;
}

/**
 * Pad-label normalization for the Pin↔Pad Mapper's auto-default match. Strips
 * leading zeros on digit-only labels so a footprint pad ``"01"`` lines up with a
 * symbol pin ``"1"``. Re-authored locally (rather than imported from app.js's
 * private ``normalizeGalleryPadLabel``) to keep cross-file extraction off the
 * AFK risk surface; alphanumeric pad labels (``A1`` etc.) are compared as-is.
 *
 * @param {string} s
 * @returns {string}
 */
function normalizePinMapPadLabel(s) {
  const t = String(s ?? "").trim();
  if (!t) return t;
  if (/^\d+$/.test(t)) {
    return String(parseInt(t, 10));
  }
  return t;
}

/**
 * Read the Pin↔Pad Mapper selects into a flat ``{padLabel: symbolPinValue}``
 * dict. ``symbolPinValue`` is the option's value (``"__NC__"`` for no
 * connection, otherwise the symbol pin number).
 *
 * @param {HTMLElement} panel
 * @returns {Record<string, string>}
 */
function readEditorPadToSymbolMap(panel) {
  const out = {};
  if (!panel) return out;
  const selects = panel.querySelectorAll(`select[${OVERRIDE_REGISTER_PINMAP_PAD_ATTR}]`);
  for (const sel of selects) {
    const pad = sel.getAttribute(OVERRIDE_REGISTER_PINMAP_PAD_ATTR) || "";
    if (!pad) continue;
    out[pad] = sel.value;
  }
  return out;
}

/**
 * Invert the editor's pad→symbol-pin map into the backend's
 * ``templatePinMap`` shape (``{symbolPinNumber: footprintPadLabel}``). Mirrors
 * ``app.js``'s ``buildTemplatePinMapFromGalleryPadMap`` last-wins semantics on
 * duplicate symbol pins.
 *
 * @param {Record<string, string>} padToSymbol
 * @returns {Record<string, string>}
 */
function buildEditorTemplatePinMap(padToSymbol) {
  const out = {};
  for (const [pad, symRaw] of Object.entries(padToSymbol || {})) {
    const sym = String(symRaw ?? "").trim();
    if (!sym || sym === OVERRIDE_REGISTER_PINMAP_NC) continue;
    const p = normalizePinMapPadLabel(pad);
    if (!p) continue;
    out[sym] = p;
  }
  return out;
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
  // Pin↔Pad Mapper (#9): only attach ``templatePinMap`` when the symbol source
  // is a template AND the inverted map is non-empty (matches phase2.py's
  // ``use_template && non-empty dict`` guard). Existing fields are untouched —
  // ``templatePinMap`` is a NEW optional key so older callers are unaffected.
  const rule = {
    symbolSource,
    footprintSource,
    // ADR-0006 (refined): metadata is auto-upserted from the page snapshot;
    // the rule no longer carries a manual label mapping.
    labelMapping: {},
    hidePinNumbers,
    hidePinNames,
    valueParam,
  };
  if (symbolSource?.source === "template") {
    const padToSym = readEditorPadToSymbolMap(panel);
    const templatePinMap = buildEditorTemplatePinMap(padToSym);
    if (Object.keys(templatePinMap).length > 0) {
      rule.templatePinMap = templatePinMap;
    }
  }
  return {
    categoryPath: typeof categoryPath === "string" ? categoryPath : "",
    rule,
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
 *   easyedaUnavailable?: boolean,
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

  if (opts.easyedaUnavailable) {
    panel.appendChild(buildCadUnavailableNotice(doc, opts.theme));
  }

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

  // Issue #47: in the unavailable case strip the EasyEDA option from both
  // selects so ``selectionToOverrides`` can't emit a layer that would die in
  // ``needs_easyeda``. Editor-style default lands on the first non-EasyEDA
  // option (the first registered template) instead.
  if (opts.easyedaUnavailable) {
    for (const sel of [symSelect, fpSelect]) {
      const easyedaOpt = Array.from(sel.options).find(
        (o) => o.value === EASYEDA_OPTION_VALUE,
      );
      if (easyedaOpt) easyedaOpt.remove();
    }
  }

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

  if (!opts.easyedaUnavailable) {
    symSelect.value = EASYEDA_OPTION_VALUE;
    fpSelect.value = EASYEDA_OPTION_VALUE;
  }

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
 * **EasyEDA availability gate (Issue #47).** ``opts.cadAvailable`` (the
 * ``{symbol, footprint}`` dict Phase 1 surfaces from the already-fetched CAD
 * payload) drives the gate. When BOTH layers are unavailable the front-end
 * pre-empts Phase 2's "No CAD data received" failure (``conversion.py:590-593``)
 * and suppresses every action that would emit an EasyEDA layer (⚪ „nur
 * EasyEDA", 🟡 „EasyEDA übernehmen", 🟢 [Import] for non-fully-template
 * rules). When only one layer is missing the gate stays off — a mixed
 * template/EasyEDA import for the surviving layer can still succeed.
 * ``cadAvailable`` absent ⇒ assume available (no regression on older hosts
 * / missing snapshots).
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
 *   cadAvailable?: { symbol?: boolean, footprint?: boolean } | null,
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

  const easyedaUnavailable = isEasyedaUnavailable(opts.cadAvailable);

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

  // Issue #47 green-state gate: read the EMITTED overrides, not the rule.
  // ``runRulePhase2`` honors ``rule.footprintSource`` when the rule is fully
  // template (app.js fix), so [Import] is safe iff both layers resolve to a
  // template. ``emittedOverridesNeedEasyeda`` is the same disjunction Phase 2
  // uses (``conversion.py:556-560``) — keeping it factored makes the mirror
  // stay correct if 3D is enabled later (ADR-0005).
  const rule = opts.match?.rule || null;
  const ruleFullyTemplate =
    rule?.symbolSource?.source === "template"
    && rule?.footprintSource?.source === "template";

  let panel;
  if (isWhite) {
    panel = buildRegisterPrompt(doc, { ...opts, easyedaUnavailable });
  } else if (isGreen) {
    panel = buildOneClickPanel(doc, {
      ruleKey: opts.match?.ruleKey ?? null,
      symbolSource: opts.match?.rule?.symbolSource ?? null,
      labelMapping: opts.match?.rule?.labelMapping ?? null,
      hidePinNumbers: opts.match?.rule?.hidePinNumbers ?? false,
      hidePinNames: opts.match?.rule?.hidePinNames ?? false,
      valueParam: opts.match?.rule?.valueParam ?? null,
      theme: opts.theme,
      easyedaUnavailable,
      allowImport: ruleFullyTemplate,
    });
  } else if (isYellow) {
    // ``keepEasyeda`` branch — Hinweis + EasyEDA default + editor escape.
    panel = buildYellowPanel(doc, {
      ruleKey: opts.match?.ruleKey ?? null,
      match: opts.match || null,
      theme: opts.theme,
      easyedaUnavailable,
    });
  } else {
    panel = buildOverridePanel(doc, { ...opts, easyedaUnavailable });
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
    // Bumped from 880 → 1080 (Issue #49) so the 4-column layout (symbol LIST ·
    // symbol viewer · footprint viewer · footprint LIST) fits comfortably with
    // both lists' search boxes visible. The body grid keeps its
    // ``auto-fit, minmax(220px, 1fr)`` rule so a narrow viewport still
    // collapses intrinsically — 4 → 2 → 1 column — without a media-query.
    maxWidthPx: 1080,
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
