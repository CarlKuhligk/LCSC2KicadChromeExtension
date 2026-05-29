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
export const OVERRIDE_SYMBOL_SELECT_ATTR = "data-k2c-override-symbol";
export const OVERRIDE_FOOTPRINT_SELECT_ATTR = "data-k2c-override-footprint";
export const OVERRIDE_CONFIRM_ATTR = "data-k2c-override-confirm";
export const OVERRIDE_CANCEL_ATTR = "data-k2c-override-cancel";

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
 * @param {HTMLElement} anchorRow
 * @param {{
 *   templateLibs?: Record<string, string[]>,
 *   onConfirm?: (overrides: object) => void,
 *   onCancel?: () => void,
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

  const panel = buildOverridePanel(doc, opts);

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

  const symSelect = panel.querySelector(`[${OVERRIDE_SYMBOL_SELECT_ATTR}]`);
  const fpSelect = panel.querySelector(`[${OVERRIDE_FOOTPRINT_SELECT_ATTR}]`);
  const confirmBtn = panel.querySelector(`[${OVERRIDE_CONFIRM_ATTR}]`);
  const cancelBtn = panel.querySelector(`[${OVERRIDE_CANCEL_ATTR}]`);

  const removePanel = () => mount.remove();

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
