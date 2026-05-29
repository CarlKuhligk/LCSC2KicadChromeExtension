"use strict";

/**
 * V3 **Phase 1 Fetch** client wiring (Issue #3).
 *
 * Hooks the Anchor Card's Download button to the SW's ``v3FetchMetadata``
 * relay (``background.js#nativeHostFetchMetadata``), which in turn calls the
 * Native Host's ``fetchMetadata`` RPC. The result — Category Path, pin
 * count, datasheet URL — is rendered inline in the injected ``<tr>`` so a
 * human can verify the round-trip works without opening DevTools. The
 * **Override Panel** (Issue #5) builds on top of this metadata in later
 * slices.
 *
 * Scope of this slice (per Issue #3): Phase 1 only — no Phase 2 conversion,
 * no Category Rule matching, no Override Panel. Just enough to prove the
 * RPC round-trips and the result reaches the DOM.
 */

import { extractPageData } from "./lcscPageSnapshot.js";

/** Marker attribute for the inline status node the click handler updates. */
export const PHASE1_STATUS_ATTR = "data-k2c-phase1-status";

/**
 * Render Phase 1 metadata as a short single-line summary, e.g.
 * ``"Passives/Resistors · 2 pins · datasheet ✓"``. Used in the minimal
 * inline status display only — the Override Panel (#5) replaces this.
 *
 * @param {{categoryPath?: string|null, pinCount?: number|null, datasheetUrl?: string|null}} result
 */
export function formatPhase1Summary(result) {
  const r = result || {};
  const parts = [];
  if (r.categoryPath) parts.push(String(r.categoryPath));
  if (r.pinCount != null && Number.isFinite(Number(r.pinCount))) {
    const n = Number(r.pinCount);
    parts.push(`${n} pin${n === 1 ? "" : "s"}`);
  }
  if (r.datasheetUrl) parts.push("datasheet ✓");
  return parts.join(" · ") || "(no metadata)";
}

/**
 * Build the inline status node. Idempotent against the actions cell — a
 * second call reuses the existing node so click handlers can re-render
 * without leaking duplicate DOM.
 *
 * @param {HTMLElement} actionsCell  the cell that already contains the buttons
 * @param {Document} [doc=document]
 * @returns {HTMLElement}
 */
export function ensurePhase1StatusNode(actionsCell, doc = document) {
  if (!actionsCell) return null;
  let node = actionsCell.querySelector(`[${PHASE1_STATUS_ATTR}]`);
  if (node) return node;
  node = doc.createElement("span");
  node.setAttribute(PHASE1_STATUS_ATTR, "idle");
  node.style.cssText = [
    "display:inline-block",
    "margin-left:12px",
    "font-size:12px",
    "color:#475569",
    "vertical-align:middle",
  ].join(";");
  actionsCell.appendChild(node);
  return node;
}

/**
 * Wire the Anchor Card's Download click to Phase 1 Fetch. ``deps.rpc`` is the
 * SW-bridged ``v3FetchMetadata`` call (injected so tests don't have to mock
 * ``chrome.runtime``); ``deps.snapshot`` is the LCSC page-data extractor
 * (defaults to ``extractPageData`` from ``lcscPageSnapshot.js``).
 *
 * Returns true when the Download button was found and the listener attached;
 * false if the row has no Download action (caller can skip wiring then).
 *
 * @param {HTMLElement} anchorRow  result of ``injectAnchorCard``
 * @param {string} lcscId
 * @param {{
 *   rpc: (lcscId: string, pageHints: object|null) => Promise<{ok:boolean, result?:object, error?:string}>,
 *   snapshot?: (doc?: Document) => {category?: string|null, datasheetUrl?: string|null},
 *   doc?: Document,
 *   log?: (...args: any[]) => void,
 *   onPhase1Ok?: (result: object, anchorRow: HTMLElement) => void | Promise<unknown>,
 * }} deps
 *
 * The optional ``onPhase1Ok`` callback fires after the inline OK status is
 * rendered. The V3 default-path chain (Issue #4) uses this hook to kick off
 * Phase 2 Conversion — the Override Panel (#5) replaces the hook with its
 * own user-confirmation step in later slices.
 */
export function wirePhase1Download(anchorRow, lcscId, deps) {
  if (!anchorRow || !lcscId || !deps || typeof deps.rpc !== "function") return false;
  const doc = deps.doc || (typeof document !== "undefined" ? document : null);
  if (!doc) return false;
  const downloadBtn = anchorRow.querySelector('[data-k2c-action="download"]');
  if (!downloadBtn) return false;
  // Idempotent guard: a second call on the same button is a no-op so
  // re-injecting the Anchor Card (LCSC reflow, attachButton retries) does
  // not stack duplicate click handlers.
  if (downloadBtn.__k2cPhase1Wired) return true;
  downloadBtn.__k2cPhase1Wired = true;

  const actionsCell = anchorRow.querySelector('[data-k2c-anchor-actions="true"]') || anchorRow;
  const status = ensurePhase1StatusNode(actionsCell, doc);
  const snapshot = typeof deps.snapshot === "function" ? deps.snapshot : extractPageData;
  const log = typeof deps.log === "function" ? deps.log : () => {};

  const renderStatus = (state, text) => {
    if (!status) return;
    status.setAttribute(PHASE1_STATUS_ATTR, state);
    status.textContent = text;
  };

  downloadBtn.addEventListener("click", async () => {
    renderStatus("loading", "Phase 1: fetching metadata…");
    let pageHints = null;
    try {
      const snap = snapshot(doc) || {};
      pageHints = {
        categoryPath: typeof snap.category === "string" ? snap.category : null,
        datasheetUrl: typeof snap.datasheetUrl === "string" ? snap.datasheetUrl : null,
      };
    } catch (e) {
      log("phase1: snapshot failed", e);
    }
    try {
      const resp = await deps.rpc(lcscId, pageHints);
      if (resp && resp.ok === true && resp.result) {
        log("phase1: ok", resp.result);
        renderStatus("ok", formatPhase1Summary(resp.result));
        if (typeof deps.onPhase1Ok === "function") {
          try {
            // Don't await — Phase 2 owns the status node from this point on
            // and renders its own progress; awaiting here would block the
            // click handler for the full conversion duration.
            const maybe = deps.onPhase1Ok(resp.result, anchorRow);
            if (maybe && typeof maybe.catch === "function") {
              maybe.catch((err) => log("phase1: onPhase1Ok threw", err));
            }
          } catch (err) {
            log("phase1: onPhase1Ok threw", err);
          }
        }
      } else {
        const err = (resp && resp.error) || "unknown error";
        log("phase1: error", err);
        renderStatus("error", `Phase 1 error: ${err}`);
      }
    } catch (e) {
      log("phase1: rpc threw", e);
      renderStatus("error", `Phase 1 error: ${e?.message || String(e)}`);
    }
  });
  return true;
}
