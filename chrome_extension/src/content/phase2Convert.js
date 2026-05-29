"use strict";

/**
 * V3 **Phase 2 Conversion** default-path client wiring (Issue #4).
 *
 * After Phase 1 (issue #3) renders the LCSC metadata summary inline, this
 * module fires the slow conversion: a single ``v3Convert`` RPC to the
 * service worker which relays to the Native Host's ``convert`` verb. Per
 * ADR-0004 the host streams free-form ``progress`` frames on the same
 * Native-Messaging port until the terminal ``done`` (``ok=true``) or
 * ``error`` arrives. The SW broadcasts each progress frame to LCSC content
 * tabs as a ``v3ConvertProgress`` message keyed by ``lcscId`` — we filter
 * by our row's id so two tabs in flight (busy-blocked anyway) cannot bleed
 * progress into each other's UI.
 *
 * This slice ships the **default-path**: EasyEDA pipeline, no Override
 * Panel, no Pin↔Pad map, no 3D Layer. Symbol + Footprint go straight to
 * the user's selected Active library. The Override Panel (#5), Category
 * Rules (#8), Pin↔Pad (#9), Overwrite (#10), and 3D (#6) layer on top of
 * this wiring in later issues.
 */

import { PHASE1_STATUS_ATTR, ensurePhase1StatusNode } from "./phase1Fetch.js";

/** Marker for the inline status node the wiring reuses (same node as
 *  Phase 1 — the button has a single status surface across both phases). */
export const PHASE2_STATUS_ATTR = PHASE1_STATUS_ATTR;

function setStatus(node, state, text) {
  if (!node) return;
  node.setAttribute(PHASE2_STATUS_ATTR, state);
  node.textContent = text;
}

/**
 * Render a single progress frame as inline status text. The format is
 * ``"Phase 2: <message> (NN%)"`` when a percent is supplied, else just
 * ``"Phase 2: <message>"`` — keeps the button column readable when the
 * backend cannot estimate progress for a given step.
 *
 * @param {{message?: string, progress?: number|null}} frame
 */
export function formatPhase2Progress(frame) {
  const msg = (frame && typeof frame.message === "string" ? frame.message : "").trim();
  const pct =
    frame && Number.isFinite(Number(frame.progress)) && frame.progress != null
      ? Math.max(0, Math.min(100, Math.round(Number(frame.progress))))
      : null;
  const body = msg || "working…";
  return pct != null ? `Phase 2: ${body} (${pct}%)` : `Phase 2: ${body}`;
}

/**
 * Render the terminal frame's summary. On success we surface the symbol
 * library path so the user has an actionable confirmation the file landed
 * in the Active library. On failure we surface the backend error verbatim —
 * Phase 2 errors are short ("busy", "no Active library selected", "Failed
 * to fetch data for C99999: HTTP 404") and useful as-is.
 *
 * @param {{ok: boolean, result?: object, error?: string}} envelope
 */
export function formatPhase2Terminal(envelope) {
  if (envelope && envelope.ok === true) {
    const path = envelope.result?.symbolPath || envelope.result?.libraryPath || "";
    return path ? `Phase 2 done · ${path}` : "Phase 2 done";
  }
  const err = (envelope && envelope.error) || "unknown error";
  return `Phase 2 error: ${err}`;
}

/**
 * Subscribe to ``v3ConvertProgress`` broadcasts from the SW. The listener
 * filters by the row's ``lcscId`` so a (hypothetical, busy-blocked) second
 * tab's progress cannot leak into ours.
 *
 * Returns an ``unsubscribe`` function. The caller invokes it after the
 * terminal frame to free the listener — a stale listener would keep
 * accumulating progress from a later conversion the user starts.
 *
 * @param {string} lcscId
 * @param {(frame: {message?: string, progress?: number|null}) => void} onProgress
 * @param {{ runtime?: { onMessage: { addListener: Function, removeListener: Function } } }} [deps]
 */
export function subscribeConvertProgress(lcscId, onProgress, deps = {}) {
  const runtime = deps.runtime
    || (typeof chrome !== "undefined" && chrome?.runtime?.onMessage
      ? { onMessage: chrome.runtime.onMessage }
      : null);
  if (!runtime?.onMessage?.addListener || typeof onProgress !== "function") {
    return () => {};
  }
  const listener = (message) => {
    if (!message || message.type !== "v3ConvertProgress") return;
    if (message.lcscId !== lcscId) return;
    onProgress({
      message: typeof message.message === "string" ? message.message : "",
      progress: typeof message.progress === "number" ? message.progress : null,
    });
  };
  runtime.onMessage.addListener(listener);
  return () => {
    try {
      runtime.onMessage.removeListener?.(listener);
    } catch (_e) {
      /* listener already gone */
    }
  };
}

/**
 * Run Phase 2 for the given Anchor Card row + LCSC id. Renders progress
 * inline in the row's status node and resolves with the terminal envelope.
 *
 * @param {HTMLElement} anchorRow  result of ``injectAnchorCard``
 * @param {string} lcscId
 * @param {{
 *   rpc: (lcscId: string, libraryPath?: string) => Promise<{ok:boolean, result?:object, error?:string}>,
 *   libraryPath?: string,
 *   subscribe?: typeof subscribeConvertProgress,
 *   doc?: Document,
 *   log?: (...args: any[]) => void,
 * }} deps
 * @returns {Promise<{ok:boolean, result?:object, error?:string}>}
 */
export async function runPhase2Convert(anchorRow, lcscId, deps) {
  if (!anchorRow || !lcscId || !deps || typeof deps.rpc !== "function") {
    return { ok: false, error: "phase2: missing wiring" };
  }
  const doc = deps.doc || (typeof document !== "undefined" ? document : null);
  if (!doc) {
    return { ok: false, error: "phase2: no document" };
  }
  const actionsCell = anchorRow.querySelector('[data-k2c-anchor-actions="true"]') || anchorRow;
  const status = ensurePhase1StatusNode(actionsCell, doc);
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const subscribe = typeof deps.subscribe === "function" ? deps.subscribe : subscribeConvertProgress;

  setStatus(status, "loading", "Phase 2: starting…");
  const unsubscribe = subscribe(lcscId, (frame) => {
    setStatus(status, "loading", formatPhase2Progress(frame));
    log("phase2: progress", frame);
  });

  let envelope;
  try {
    envelope = await deps.rpc(lcscId, deps.libraryPath);
  } catch (e) {
    envelope = { ok: false, error: e?.message || String(e) };
  } finally {
    try { unsubscribe(); } catch (_e) { /* ignore */ }
  }

  if (envelope && envelope.ok === true) {
    log("phase2: ok", envelope.result);
    setStatus(status, "ok", formatPhase2Terminal(envelope));
  } else {
    log("phase2: error", envelope?.error);
    setStatus(status, "error", formatPhase2Terminal(envelope || { ok: false }));
  }
  return envelope;
}
