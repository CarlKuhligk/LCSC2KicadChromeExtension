"use strict";

/**
 * V3 **Override Panel** — inline UI between Phase 1 Fetch and Phase 2
 * Conversion (Issue #5). Replaces V2's 5-dialog cascade (Template Gallery /
 * Category / Value-Param / Overwrite / Pin↔Pad) with one surface attached to
 * the Anchor Card row.
 *
 * Scope of this slice: Symbol-source + Footprint-source dropdowns plus
 * Confirm / Cancel. Each layer offers ``keep EasyEDA`` and one option per
 * Template in the user's registered Template Libraries. Later slices dock
 * onto the same panel: Category Rules + Skip-Panel Flow (#8), Pin↔Pad Map
 * (#9), Overwrite inline confirm (#10), Datasheet preview (#11), Customize
 * Button (#12).
 *
 * **Always Re-Resolve** (V3-SPEC.md, ADR-0005 spirit): the panel records
 * only the template *name* and the lib path it lives in — the template file
 * is always read fresh from disk by the conversion pipeline at Phase 2
 * time. No snapshotting here, no per-Rule pinning.
 */

const PANEL_ATTR = "data-k2c-override-panel";

/** Option value for "no template, run the EasyEDA pipeline for this layer". */
export const SOURCE_VALUE_EASYEDA = "easyeda";

/**
 * Encode a Template choice as ``template:<libPath>:<symbolName>``. We embed
 * both the library path and the symbol name so the Native Host receives an
 * unambiguous (lib, name) tuple — without the lib path the host would have
 * to scan every registered Template Library, which races with the user
 * editing their config between Phase 1 and Phase 2.
 *
 * @param {string} libPath
 * @param {string} name
 */
export function encodeTemplateValue(libPath, name) {
  return `template:${libPath}:${name}`;
}

/**
 * Inverse of ``encodeTemplateValue`` — used both by the panel (to repopulate
 * a dropdown after re-render) and by ``selectionToOverrides`` to build the
 * Phase 2 payload.
 *
 * @param {string} value
 * @returns {{source: "easyeda"} | {source: "template", libPath: string, name: string} | null}
 */
export function decodeSourceValue(value) {
  if (typeof value !== "string") return null;
  if (value === SOURCE_VALUE_EASYEDA) return { source: "easyeda" };
  if (!value.startsWith("template:")) return null;
  const rest = value.slice("template:".length);
  // libPath may contain ":" on Windows (drive letter). Split on the LAST ":"
  // so the template name is whatever follows the final colon.
  const idx = rest.lastIndexOf(":");
  if (idx < 0) return null;
  const libPath = rest.slice(0, idx);
  const name = rest.slice(idx + 1);
  if (!libPath || !name) return null;
  return { source: "template", libPath, name };
}

/**
 * Convert the panel's current selection to the ``overrides`` object the
 * Phase 2 RPC expects.
 *
 * @param {{symbol: string, footprint: string}} selection
 * @returns {{symbol: object, footprint: object}}
 */
export function selectionToOverrides(selection) {
  const sym = decodeSourceValue(selection?.symbol) || { source: "easyeda" };
  const fp = decodeSourceValue(selection?.footprint) || { source: "easyeda" };
  return { symbol: sym, footprint: fp };
}

/** Library-path → display name. Strips trailing ``.kicad_sym`` and the
 *  directory prefix so the user sees "MyTemplates" not the full path. */
function libDisplayName(libPath) {
  if (!libPath || typeof libPath !== "string") return "";
  const trimmed = libPath.replace(/\.(kicad_sym|lib)$/i, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || trimmed;
}

function buildSelect(doc, name, templateLibs) {
  const select = doc.createElement("select");
  select.setAttribute("data-k2c-override-select", name);
  select.style.cssText = [
    "margin-left:6px",
    "font-size:12px",
    "padding:1px 4px",
    "max-width:240px",
  ].join(";");

  const easyeda = doc.createElement("option");
  easyeda.value = SOURCE_VALUE_EASYEDA;
  easyeda.textContent = "keep EasyEDA";
  select.appendChild(easyeda);

  if (templateLibs && typeof templateLibs === "object") {
    for (const [libPath, names] of Object.entries(templateLibs)) {
      if (!Array.isArray(names) || names.length === 0) continue;
      const group = doc.createElement("optgroup");
      group.label = libDisplayName(libPath);
      for (const symbolName of names) {
        if (typeof symbolName !== "string" || !symbolName) continue;
        const opt = doc.createElement("option");
        opt.value = encodeTemplateValue(libPath, symbolName);
        opt.textContent = `Template · ${symbolName}`;
        group.appendChild(opt);
      }
      if (group.childElementCount > 0) select.appendChild(group);
    }
  }
  return select;
}

/**
 * Build the Override Panel as a detached DOM fragment. The caller mounts it
 * inline next to the Anchor Card's actions cell.
 *
 * @param {object} [opts]
 * @param {Record<string, string[]>} [opts.templateLibs]  ``state.templateSymbolsByLib`` from the SW broadcast.
 * @param {Document} [opts.doc]
 * @returns {HTMLElement}
 */
export function buildOverridePanel(opts = {}) {
  const doc = opts.doc || (typeof document !== "undefined" ? document : null);
  if (!doc) throw new Error("buildOverridePanel: no document");
  const templateLibs = opts.templateLibs && typeof opts.templateLibs === "object"
    ? opts.templateLibs
    : {};

  const root = doc.createElement("div");
  root.setAttribute(PANEL_ATTR, "true");
  root.style.cssText = [
    "display:block",
    "margin-top:8px",
    "padding:8px 10px",
    "border:1px solid rgba(15,23,42,0.12)",
    "border-radius:6px",
    "background:#f8fafc",
    "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
    "font-size:12px",
    "color:#0f172a",
  ].join(";");

  const heading = doc.createElement("div");
  heading.textContent = "Override sources";
  heading.style.cssText = [
    "font-weight:600",
    "margin-bottom:6px",
    "letter-spacing:0.02em",
  ].join(";");
  root.appendChild(heading);

  const symbolRow = doc.createElement("div");
  symbolRow.style.cssText = "margin-bottom:4px;";
  const symbolLabel = doc.createElement("label");
  symbolLabel.textContent = "Symbol:";
  symbolLabel.style.cssText = "font-weight:500;";
  const symbolSelect = buildSelect(doc, "symbol", templateLibs);
  symbolLabel.appendChild(symbolSelect);
  symbolRow.appendChild(symbolLabel);
  root.appendChild(symbolRow);

  const footprintRow = doc.createElement("div");
  footprintRow.style.cssText = "margin-bottom:8px;";
  const footprintLabel = doc.createElement("label");
  footprintLabel.textContent = "Footprint:";
  footprintLabel.style.cssText = "font-weight:500;";
  const footprintSelect = buildSelect(doc, "footprint", templateLibs);
  footprintLabel.appendChild(footprintSelect);
  footprintRow.appendChild(footprintLabel);
  root.appendChild(footprintRow);

  const actions = doc.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;";
  const confirmBtn = doc.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.textContent = "Confirm & convert";
  confirmBtn.setAttribute("data-k2c-override-action", "confirm");
  const cancelBtn = doc.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.setAttribute("data-k2c-override-action", "cancel");
  actions.appendChild(confirmBtn);
  actions.appendChild(cancelBtn);
  root.appendChild(actions);

  return root;
}

/**
 * Read the current dropdown selection back out of a panel DOM node.
 *
 * @param {HTMLElement} panel
 * @returns {{symbol: string, footprint: string}}
 */
export function readPanelSelection(panel) {
  if (!panel) return { symbol: SOURCE_VALUE_EASYEDA, footprint: SOURCE_VALUE_EASYEDA };
  const sym = panel.querySelector('[data-k2c-override-select="symbol"]');
  const fp = panel.querySelector('[data-k2c-override-select="footprint"]');
  return {
    symbol: sym ? sym.value : SOURCE_VALUE_EASYEDA,
    footprint: fp ? fp.value : SOURCE_VALUE_EASYEDA,
  };
}

/**
 * Mount the Override Panel inline next to the Anchor Card row's actions
 * cell. Idempotent — a second call against the same row replaces the
 * previous panel so a user who clicks Download → Cancel → Download again
 * sees a freshly populated panel (e.g. if they added a Template Library
 * mid-flight).
 *
 * Calls ``opts.onConfirm({selection, overrides, panel})`` on Confirm and
 * ``opts.onCancel({panel})`` on Cancel. The panel removes itself on either
 * action — the caller's onConfirm typically kicks off Phase 2, whose own
 * status rendering reuses the row's status node.
 *
 * @param {HTMLElement} anchorRow
 * @param {{
 *   templateLibs?: Record<string, string[]>,
 *   onConfirm?: (ev: {selection: object, overrides: object, panel: HTMLElement}) => void,
 *   onCancel?: (ev: {panel: HTMLElement}) => void,
 *   doc?: Document,
 * }} [opts]
 * @returns {HTMLElement | null}
 */
export function renderOverridePanel(anchorRow, opts = {}) {
  if (!anchorRow) return null;
  const doc = opts.doc || anchorRow.ownerDocument || (typeof document !== "undefined" ? document : null);
  if (!doc) return null;

  // Replace any previously-mounted panel on this row so re-render after
  // Cancel does not stack.
  const existing = anchorRow.querySelector(`[${PANEL_ATTR}="true"]`);
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const panel = buildOverridePanel({ templateLibs: opts.templateLibs, doc });
  const actionsCell = anchorRow.querySelector('[data-k2c-anchor-actions="true"]') || anchorRow;
  actionsCell.appendChild(panel);

  const confirmBtn = panel.querySelector('[data-k2c-override-action="confirm"]');
  const cancelBtn = panel.querySelector('[data-k2c-override-action="cancel"]');

  const dismiss = () => {
    if (panel.parentNode) panel.parentNode.removeChild(panel);
  };

  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => {
      const selection = readPanelSelection(panel);
      const overrides = selectionToOverrides(selection);
      dismiss();
      if (typeof opts.onConfirm === "function") {
        try {
          opts.onConfirm({ selection, overrides, panel });
        } catch (_e) {
          /* caller-side errors are caller's problem; panel is already gone */
        }
      }
    });
  }
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      dismiss();
      if (typeof opts.onCancel === "function") {
        try {
          opts.onCancel({ panel });
        } catch (_e) {
          /* swallow — Cancel just resets the row */
        }
      }
    });
  }
  return panel;
}

/**
 * Helper for tests / callers that need to query whether a row currently has
 * a panel open.
 */
export function findMountedPanel(anchorRow) {
  if (!anchorRow) return null;
  return anchorRow.querySelector(`[${PANEL_ATTR}="true"]`);
}
