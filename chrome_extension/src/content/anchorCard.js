"use strict";

/**
 * V3 Anchor Card detector + injector — see V3-SPEC.md §4 (DOM injection).
 *
 * The V3 download controls are rendered as a new <tr> in the LCSC product
 * **header card** (the same table that carries "Hersteller / LCSC-Nr. / …").
 * That keeps the action visually adjacent to the product info the user is
 * already reading. When no anchor table can be found — LCSC ships a layout
 * we don't recognize — the caller falls back to the **Float Fallback** in
 * `app.js#attachButton`.
 *
 * Detection mirrors `lcscPageSnapshot.js`: structural <table>-walk, not
 * class-based, so LCSC's Tailwind rotation does not break us. We pick the
 * row whose first cell is a localized LCSC-Nr. label, and degrade to any
 * row that contains a cell matching `/^C\d+$/` (the LCSC ID itself).
 */

/**
 * Load-bearing labels for the LCSC ID row. Order is informational; the matcher
 * uses set membership.
 */
export const LCSC_ID_LABELS = [
  "LCSC-Nr.",          // DE
  "LCSC#",             // EN short
  "LCSC Part #",       // EN long
  "LCSC Part Number",  // EN verbose
  "LCSC编号",          // ZH
  "Numéro LCSC",       // FR
];

/** A cell that contains *only* an LCSC ID (e.g. `C22548`). */
const LCSC_ID_CELL_RE = /^\s*C\d+\s*$/;

/** Marker on the injected <tr> so callers and `cleanupInjectedUi` can find it. */
export const ANCHOR_ROW_ATTR = "data-k2c-anchor-row";

function cellText(el) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

/**
 * Walk every `<table>` in `doc` and return the anchor row — the row beneath
 * which the V3 controls should be injected. Label match wins over cell-pattern
 * match (header card before spec tables); first hit wins.
 *
 * @param {Document} [doc=document]
 * @returns {HTMLTableRowElement | null}
 */
export function findAnchorRow(doc = document) {
  if (!doc?.querySelectorAll) return null;
  let labelMatch = null;
  let cellMatch = null;
  for (const tbl of doc.querySelectorAll("table")) {
    for (const tr of tbl.querySelectorAll("tr")) {
      if (tr.querySelector("th")) continue;
      const cells = tr.children;
      if (cells.length < 2) continue;
      const key = cellText(cells[0]);
      if (key && LCSC_ID_LABELS.includes(key)) {
        labelMatch = tr;
        break;
      }
      if (!cellMatch) {
        for (const cell of cells) {
          if (LCSC_ID_CELL_RE.test(cellText(cell))) {
            cellMatch = tr;
            break;
          }
        }
      }
    }
    if (labelMatch) break;
  }
  return labelMatch || cellMatch || null;
}

/**
 * Build the V3 anchor `<tr>`: a "KiCad" label cell + an actions cell holding
 * the **Download** and **Customize** buttons. **Visual scaffold only** —
 * click handlers belong to #4 (Phase 2 Conversion) and #12 (Customize). The
 * `data-k2c-action` hooks let those slices wire behavior without re-walking.
 *
 * @param {Document} [doc=document]
 * @param {{ colSpan?: number }} [opts]
 * @returns {HTMLTableRowElement}
 */
export function buildAnchorCardRow(doc = document, opts = {}) {
  const tr = doc.createElement("tr");
  tr.setAttribute(ANCHOR_ROW_ATTR, "true");
  tr.setAttribute("data-k2c-mode", "anchored");

  const label = doc.createElement("td");
  label.textContent = "KiCad";
  label.setAttribute("data-k2c-anchor-label", "true");
  tr.appendChild(label);

  const actions = doc.createElement("td");
  actions.setAttribute("data-k2c-anchor-actions", "true");
  if (opts.colSpan && opts.colSpan > 1) {
    actions.colSpan = opts.colSpan;
  }

  const wrap = doc.createElement("span");
  wrap.style.cssText = "display:inline-flex;gap:8px;align-items:center;";

  const downloadBtn = doc.createElement("button");
  downloadBtn.type = "button";
  downloadBtn.textContent = "Download";
  downloadBtn.setAttribute("data-k2c-action", "download");
  wrap.appendChild(downloadBtn);

  const customizeBtn = doc.createElement("button");
  customizeBtn.type = "button";
  customizeBtn.textContent = "Customize";
  customizeBtn.setAttribute("data-k2c-action", "customize");
  wrap.appendChild(customizeBtn);

  actions.appendChild(wrap);
  tr.appendChild(actions);
  return tr;
}

/**
 * Insert the V3 anchor `<tr>` as the **last row** of the anchor table's body.
 * Position at the end reads as an action bar; placing it mid-table reads as
 * a stray data row. Returns the injected (or pre-existing) row, or `null`
 * when no anchor was found — the caller falls back to the float panel.
 * Idempotent: a second call returns the previously injected row instead of
 * duplicating.
 *
 * @param {Document} [doc=document]
 * @returns {HTMLTableRowElement | null}
 */
export function injectAnchorCard(doc = document) {
  const anchor = findAnchorRow(doc);
  if (!anchor) return null;
  const ownerTable = anchor.closest?.("table") || null;
  const existing = ownerTable?.querySelector?.(`[${ANCHOR_ROW_ATTR}="true"]`);
  if (existing) return existing;

  const colSpan = Math.max(1, anchor.children.length - 1);
  const row = buildAnchorCardRow(doc, { colSpan });
  const target = ownerTable?.querySelector("tbody") || anchor.parentNode;
  target.appendChild(row);
  return row;
}
