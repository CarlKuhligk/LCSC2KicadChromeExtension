"use strict";

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

/**
 * Build a single LCSC-label ↔ KiCad-property row inside the Register
 * Import-Editor's mapping table. Two text inputs side-by-side; the LCSC
 * label list is hinted as a ``<datalist>`` (the editor builds one shared
 * list for all rows so the user can pick from the snapshot or type a
 * custom label).
 */
function buildMappingRow(doc, datalistId, initial = {}) {
  const row = doc.createElement("div");
  row.setAttribute(OVERRIDE_REGISTER_MAPPING_ROW_ATTR, "true");
  row.style.cssText = "display:flex;gap:6px;align-items:center";

  const lcsc = doc.createElement("input");
  lcsc.type = "text";
  lcsc.setAttribute(OVERRIDE_REGISTER_MAPPING_LCSC_ATTR, "true");
  lcsc.placeholder = "LCSC label (z.B. Resistance)";
  if (datalistId) lcsc.setAttribute("list", datalistId);
  if (typeof initial.lcsc === "string") lcsc.value = initial.lcsc;
  lcsc.style.cssText = "flex:1;min-width:0";
  row.appendChild(lcsc);

  const arrow = doc.createElement("span");
  arrow.textContent = "→";
  arrow.style.cssText = "color:#94a3b8;flex-shrink:0";
  row.appendChild(arrow);

  const kicad = doc.createElement("input");
  kicad.type = "text";
  kicad.setAttribute(OVERRIDE_REGISTER_MAPPING_KICAD_ATTR, "true");
  kicad.placeholder = "Symbol-Property (z.B. Value)";
  if (typeof initial.kicad === "string") kicad.value = initial.kicad;
  kicad.style.cssText = "flex:1;min-width:0";
  row.appendChild(kicad);

  return row;
}

function collectMapping(panel) {
  const rows = Array.from(
    panel.querySelectorAll(`[${OVERRIDE_REGISTER_MAPPING_ROW_ATTR}="true"]`),
  );
  const mapping = {};
  for (const row of rows) {
    const lcsc = row.querySelector(`[${OVERRIDE_REGISTER_MAPPING_LCSC_ATTR}]`);
    const kicad = row.querySelector(`[${OVERRIDE_REGISTER_MAPPING_KICAD_ATTR}]`);
    const k = (lcsc?.value || "").trim();
    const v = (kicad?.value || "").trim();
    if (!k || !v) continue;
    mapping[k] = v;
  }
  return mapping;
}

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
 * @param {Document} doc
 * @param {{
 *   templateLibs?: Record<string, string[]>,
 *   pageParams?: Record<string, string>,
 *   categoryPath?: string | null,
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

  // Datalist hints from the LCSC page snapshot so the user can pick a
  // label they already see on the product page instead of typing it.
  const datalistId = "k2c-register-lcsc-labels";
  const datalist = doc.createElement("datalist");
  datalist.id = datalistId;
  const pageParams = opts.pageParams && typeof opts.pageParams === "object" ? opts.pageParams : {};
  for (const key of Object.keys(pageParams)) {
    const opt = doc.createElement("option");
    opt.value = key;
    datalist.appendChild(opt);
  }
  panel.appendChild(datalist);

  const mappingHeading = doc.createElement("div");
  mappingHeading.textContent = "Metadaten-Mapping (LCSC → Symbol-Property)";
  mappingHeading.style.cssText = "margin-top:4px;color:#475569";
  panel.appendChild(mappingHeading);

  const mappingHost = doc.createElement("div");
  mappingHost.style.cssText = "display:flex;flex-direction:column;gap:4px";
  panel.appendChild(mappingHost);
  // Start with one empty row — the user can `+ Zeile` to add more.
  mappingHost.appendChild(buildMappingRow(doc, datalistId));

  const addRowBtn = doc.createElement("button");
  addRowBtn.type = "button";
  addRowBtn.textContent = "+ Zeile";
  addRowBtn.setAttribute(OVERRIDE_REGISTER_MAPPING_ADD_ATTR, "true");
  addRowBtn.style.cssText = "align-self:flex-start";
  addRowBtn.addEventListener("click", () => {
    mappingHost.appendChild(buildMappingRow(doc, datalistId));
  });
  panel.appendChild(addRowBtn);

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

  symSelect.value = EASYEDA_OPTION_VALUE;

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
      labelMapping: collectMapping(panel),
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
 * **Confidence dispatch (ADR-0006).** When ``opts.match.state === "white"``
 * the panel renders the **Register-Prompt** with two buttons (⚪ ADR-0006):
 * „nur EasyEDA" (proceed via the existing EasyEDA path) and „registrieren"
 * (open the Import-Editor for the learning act — Issue #28 wires the body).
 * Without a ``match`` argument, or for non-white states (🟢/🟡 — Issues #29
 * / #31), the legacy Symbol/Footprint source picker renders unchanged.
 *
 * @param {HTMLElement} anchorRow
 * @param {{
 *   match?: { state?: "green" | "yellow" | "white" } | null,
 *   templateLibs?: Record<string, string[]>,
 *   templateLibsFootprints?: Record<string, string[]>,
 *   onConfirm?: (overrides: object) => void,
 *   onCancel?: () => void,
 *   onEasyedaOnly?: () => void,
 *   onRegister?: () => void,
 *   doc?: Document,
 * }} opts
 * @returns {HTMLElement | null} the panel, or null when ``anchorRow`` is detached
 */
export function renderOverridePanel(anchorRow, opts = {}) {
  if (!anchorRow || !anchorRow.parentNode) return null;
  const doc = opts.doc || (typeof document !== "undefined" ? document : null);
  if (!doc) return null;

  const existing = anchorRow.parentNode.querySelector(`[${OVERRIDE_PANEL_ATTR}="true"]`);
  if (existing) return existing;

  const isWhite = opts.match?.state === "white";
  const panel = isWhite ? buildRegisterPrompt(doc, opts) : buildOverridePanel(doc, opts);

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

  const removePanel = () => mount.remove();

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
 *   onSave?: (payload: { categoryPath: string, rule: object }) => void,
 *   onCancel?: () => void,
 *   doc?: Document,
 * }} [opts]
 * @returns {HTMLElement | null}
 */
export function renderRegisterImportEditor(anchorRow, opts = {}) {
  if (!anchorRow || !anchorRow.parentNode) return null;
  const doc = opts.doc || (typeof document !== "undefined" ? document : null);
  if (!doc) return null;

  // Idempotency: an existing editor wins; otherwise replace any non-editor
  // panel (typically the Register-Prompt the user clicked) so the editor
  // takes its slot.
  const existing = anchorRow.parentNode.querySelector(
    `[${OVERRIDE_PANEL_ATTR}="true"]`,
  );
  if (existing?.getAttribute(OVERRIDE_PANEL_MODE_ATTR) === "registerEditor") {
    return existing;
  }
  if (existing) {
    const wrapper = existing.closest(`[${OVERRIDE_PANEL_ROW_ATTR}="true"]`) || existing;
    wrapper.remove();
  }

  const panel = buildRegisterImportEditor(doc, opts);

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

  const removePanel = () => mount.remove();

  panel
    .querySelector(`[${OVERRIDE_REGISTER_SAVE_ATTR}]`)
    ?.addEventListener("click", () => {
      const payload = collectRegisterEditorRule(panel, opts.categoryPath || "");
      removePanel();
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
