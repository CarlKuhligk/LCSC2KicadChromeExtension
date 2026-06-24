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

import { getDialogTokens, DIALOG_TYPE, DIALOG_SPACING, DIALOG_RADIUS } from "./dialog.js";

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
 * Build the V3 anchor `<tr>` as a **native LCSC table row**: a "KiCad" label
 * cell on the left + an actions cell on the right holding the primary button,
 * styled to match the LCSC product page (solid blue, 4px radius). The Phase-1
 * status caption + Phase-2 progress bar mount below the button inside the
 * actions cell (`data-k2c-anchor-actions` hook). `markAnchorCardImported`
 * relabels Download → Re-Import when the part is already present.
 *
 * @param {Document} [doc=document]
 * @param {{ colSpan?: number }} [opts]
 * @returns {HTMLTableRowElement}
 */
export function buildAnchorCardRow(doc = document, opts = {}) {
  injectAnchorCardStyles(doc);
  const tr = doc.createElement("tr");
  tr.setAttribute(ANCHOR_ROW_ATTR, "true");
  tr.setAttribute("data-k2c-mode", "anchored");

  const label = doc.createElement("td");
  label.className = "k2c-ac-label";
  label.setAttribute("data-k2c-anchor-label", "true");
  label.textContent = "KiCad";
  tr.appendChild(label);

  // Actions cell = the contract container: button on top, the Phase-1 caption
  // and Phase-2 progress bar attach below it (see phase1Fetch / phase2Convert).
  const actions = doc.createElement("td");
  actions.className = "k2c-ac-cell";
  actions.setAttribute("data-k2c-anchor-actions", "true");
  if (opts.colSpan && opts.colSpan > 1) actions.colSpan = opts.colSpan;

  // Button lives in a span so markAnchorCardImported's `.querySelector("span")`
  // lookup keeps working.
  const wrap = doc.createElement("span");
  wrap.className = "k2c-ac-actions";

  const downloadBtn = doc.createElement("button");
  downloadBtn.type = "button";
  downloadBtn.className = "k2c-ac-btn";
  downloadBtn.textContent = "Download";
  downloadBtn.setAttribute("data-k2c-action", "download");
  wrap.appendChild(downloadBtn);

  actions.appendChild(wrap);
  tr.appendChild(actions);
  return tr;
}

/** Id of the single injected anchor-card stylesheet (mirrors phase2Progress). */
export const ANCHOR_CARD_STYLE_ID = "k2c-anchor-card-style";

/**
 * Token-driven rule body for ONE theme. Re-emitted verbatim inside a
 * ``@media (prefers-color-scheme: dark)`` block with the dark token map, so
 * light/dark flips for free without any hardcoded hex. The button matches the
 * LCSC product page (solid blue ``primary`` = #1166dd, 4px radius); the
 * Phase-1 status caption colors are scoped with ``:not(.k2c-p2-cap)`` so
 * phase2Progress's caption styling wins once it adopts the status node.
 */
function anchorCardRules(T) {
  return `
.k2c-ac-label {
  color: ${T.textMuted};
  font-family: ${T.fontUi};
  font-size: ${DIALOG_TYPE.base};
  vertical-align: middle;
  white-space: nowrap;
}
.k2c-ac-actions { display: inline-flex; gap: ${DIALOG_SPACING.sm}; align-items: center; flex-wrap: wrap; }
.k2c-ac-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: ${DIALOG_SPACING.xs};
  box-sizing: border-box;
  min-width: 116px;
  height: 36px;
  padding: 0 ${DIALOG_SPACING.lg};
  border: 1px solid ${T.primary};
  border-radius: ${DIALOG_RADIUS.sm};
  background: ${T.primary};
  color: ${T.primaryFg};
  font-family: ${T.fontUi};
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.2;
  cursor: pointer;
  transition: filter 0.18s ease, box-shadow 0.18s ease;
}
.k2c-ac-btn:hover { filter: brightness(1.08); box-shadow: 0 2px 8px rgba(17,102,221,0.25); }
.k2c-ac-btn:active { filter: brightness(0.95); }
.k2c-ac-btn:focus-visible { outline: 2px solid ${T.primary}; outline-offset: 2px; }
.k2c-ac-btn[disabled] { opacity: 0.6; cursor: default; }
[data-k2c-phase1-status]:not(.k2c-p2-cap) {
  display: block;
  margin-top: ${DIALOG_SPACING.xs};
  font-family: ${T.fontUi};
  font-size: ${DIALOG_TYPE.small};
  color: ${T.textMuted};
  line-height: 1.35;
}
[data-k2c-phase1-status="loading"]:not(.k2c-p2-cap) { color: ${T.textMuted}; }
[data-k2c-phase1-status="ok"]:not(.k2c-p2-cap) { color: ${T.success}; }
[data-k2c-phase1-status="error"]:not(.k2c-p2-cap) { color: ${T.danger}; }
.k2c-ac-retry { background: transparent; border: 0; padding: 0; color: ${T.primary}; font: inherit; cursor: pointer; }
.k2c-ac-retry:hover { text-decoration: underline; }
`;
}

/**
 * Inject the scoped anchor-card stylesheet once per document. Theme-independent
 * motion (the loading spinner, the facts dim-transition) and the idle-empty
 * collapse live outside the per-theme blocks; reduced-motion neutralizes both.
 */
export function injectAnchorCardStyles(doc = document) {
  if (!doc || !doc.head || doc.getElementById(ANCHOR_CARD_STYLE_ID)) return;
  const css = `${anchorCardRules(getDialogTokens("light"))}
@media (prefers-color-scheme: dark) {${anchorCardRules(getDialogTokens("dark"))}}
[data-k2c-phase1-status="idle"]:not(.k2c-p2-cap):empty { display: none; }
button[data-k2c-action="download"][aria-busy="true"]::before {
  content: "";
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: ${DIALOG_SPACING.xs};
  vertical-align: -1px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: k2c-ac-spin 0.7s linear infinite;
}
@keyframes k2c-ac-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  button[data-k2c-action="download"][aria-busy="true"]::before { animation: none; }
}`;
  const style = doc.createElement("style");
  style.id = ANCHOR_CARD_STYLE_ID;
  style.textContent = css;
  doc.head.appendChild(style);
}

/**
 * Mark the anchor card as **already imported**: relabel the Download button to
 * "Re-Import" via the `k2cLabelOverride` dataset hook so the Native-Host status
 * presenter — which re-paints the button text on every heartbeat — keeps it
 * instead of resetting to "Download". The button label alone conveys the state
 * (no separate badge). Re-import is an intentional overwrite: V3 Phase 2 always
 * converts with ``overwrite=True``. Idempotent — safe to call repeatedly.
 *
 * @param {HTMLTableRowElement | null | undefined} anchorRow
 * @returns {boolean} true when the row's button was (or already was) relabelled.
 */
export function markAnchorCardImported(anchorRow) {
  if (!anchorRow?.querySelector) return false;
  const downloadBtn = anchorRow.querySelector('button[data-k2c-action="download"]');
  if (!downloadBtn) return false;
  downloadBtn.dataset.k2cLabelOverride = "Re-Import";
  downloadBtn.textContent = "Re-Import";
  downloadBtn.title = "Bereits in der aktiven Library — erneuter Import überschreibt Symbol + Footprint.";
  return true;
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

  // The "KiCad" label takes the first column; the actions cell spans the rest.
  const colSpan = Math.max(1, anchor.children.length - 1);
  const row = buildAnchorCardRow(doc, { colSpan });
  const target = ownerTable?.querySelector("tbody") || anchor.parentNode;
  target.appendChild(row);
  return row;
}
