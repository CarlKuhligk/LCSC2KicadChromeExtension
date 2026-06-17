"use strict";

/**
 * V3 Pre-Warm + Backend Status presentation for the Anchor Card button.
 *
 * Wires the service worker's pre-warm signal into a tri-state visual on the
 * Anchor Card's Download `<button>` (`data-k2c-action="download"`):
 *
 *   - `checking` — spinner cursor, disabled, "Checking native host…" tooltip;
 *     the SW is about to call `chrome.runtime.connectNative`.
 *   - `online`   — enabled, default cursor; tooltip carries the host version.
 *   - `offline`  — disabled, `[offline]` tooltip explaining the installer was
 *     never run / the Native-Host Manifest is missing.
 *
 * The module has no DOM injection of its own and no `chrome.runtime` glue at
 * load time — every side-effect is parameterized so the unit tests can drive
 * it directly with stubs.
 *
 * See V3-SPEC.md §3 (Cold-start mitigation — Pre-Warm) and CONTEXT.md term
 * "Pre-Warm" / "Backend Status Monitor".
 */

export const NATIVE_HOST_STATUS_BUTTON_ATTR = "data-k2c-status";
export const NATIVE_HOST_STATUS_UPDATE_TYPE = "v3NativeHostStatusUpdate";
export const PREWARM_MESSAGE_TYPE = "prewarmNativeHost";

const STATES = new Set(["checking", "online", "offline"]);

const STATE_STYLES = {
  checking: {
    label: "Download",
    title: "Checking native host…",
    disabled: true,
    opacity: "0.6",
    cursor: "progress",
  },
  online: {
    label: "Download",
    title: "",
    disabled: false,
    opacity: "1",
    cursor: "pointer",
  },
  offline: {
    label: "Download",
    title: "Native host is offline — run the installer.",
    disabled: true,
    opacity: "0.5",
    cursor: "not-allowed",
  },
};

/**
 * Normalize whatever `status` came over the wire into a {@code state} we know
 * how to render. Unknown / missing payloads degrade to `checking` so the user
 * never sees a stale label without explanation.
 *
 * @param {*} status
 * @returns {{ state: 'checking' | 'online' | 'offline', version: string | null, error: string | null }}
 */
export function normalizeNativeHostStatus(status) {
  if (!status || typeof status !== "object") {
    return { state: "checking", version: null, error: null };
  }
  const raw = typeof status.state === "string" ? status.state.toLowerCase() : "";
  const state = STATES.has(raw) ? raw : "checking";
  const version = typeof status.version === "string" && status.version
    ? status.version
    : null;
  const error = typeof status.error === "string" && status.error
    ? status.error
    : null;
  return { state, version, error };
}

/**
 * Apply a tri-state visual to `btn`. Pure DOM — does not subscribe to anything.
 * Idempotent, so callers can re-apply on every status push without diffing.
 *
 * @param {HTMLButtonElement | null | undefined} btn
 * @param {object} status   raw status (will be normalized).
 */
export function applyNativeHostStatusToButton(btn, status) {
  if (!btn) return;
  const { state, version, error } = normalizeNativeHostStatus(status);
  const style = STATE_STYLES[state];
  btn.setAttribute(NATIVE_HOST_STATUS_BUTTON_ATTR, state);
  // A caller (e.g. the "already imported" exists check) may pin a different
  // label via the `k2cLabelOverride` dataset hook — honor it so the heartbeat
  // re-paint does not reset "Re-Import" back to "Download".
  btn.textContent = btn.dataset.k2cLabelOverride || style.label;
  btn.disabled = style.disabled;
  btn.style.opacity = style.opacity;
  btn.style.cursor = style.cursor;
  const title = state === "online" && version
    ? `Native host online · v${version}`
    : state === "offline" && error
      ? `${style.title} (${error})`
      : style.title;
  if (title) {
    btn.title = title;
  } else {
    btn.removeAttribute("title");
  }
}

/**
 * Send a `prewarmNativeHost` message to the service worker. Returns the
 * normalized status from the SW, or an `offline` placeholder with the error
 * message when the runtime call throws (no SW, extension reloaded, etc).
 *
 * @param {(payload: object) => Promise<any>} send  contentRpc-shaped sender.
 */
export async function prewarmNativeHost(send) {
  try {
    const response = await send({ type: PREWARM_MESSAGE_TYPE });
    if (response?.ok) {
      return normalizeNativeHostStatus(response.data);
    }
    return { state: "offline", version: null, error: response?.error || "unknown error" };
  } catch (e) {
    return { state: "offline", version: null, error: e?.message || String(e) };
  }
}

/**
 * Wire `btn` to live status pushes from the service worker. Returns an
 * `unsubscribe` function the caller can call when the button is detached.
 *
 * `runtime` must expose Chrome's MV3 `chrome.runtime.onMessage` shape (only
 * `addListener` / `removeListener` are touched). The unit tests inject a
 * minimal stub.
 *
 * @param {HTMLButtonElement} btn
 * @param {{ addListener: Function, removeListener: Function }} runtime
 * @returns {() => void}
 */
export function subscribeToNativeHostStatus(btn, runtime) {
  if (!btn || !runtime || typeof runtime.addListener !== "function") {
    return () => {};
  }
  const listener = (message) => {
    if (!message || message.type !== NATIVE_HOST_STATUS_UPDATE_TYPE) return;
    applyNativeHostStatusToButton(btn, message.status);
  };
  runtime.addListener(listener);
  return () => {
    try { runtime.removeListener(listener); } catch (_e) { /* already gone */ }
  };
}

/**
 * One-shot helper: render `checking` immediately, kick off the SW pre-warm,
 * paint the result, and subscribe to subsequent pushes. Designed to be called
 * from `app.js` right after `injectAnchorCard` returns the new `<tr>`.
 *
 * @param {HTMLButtonElement} btn
 * @param {{ send: (payload: object) => Promise<any>, runtime: { addListener: Function, removeListener: Function } }} deps
 * @returns {Promise<() => void>}  resolves to an unsubscribe function.
 */
export async function attachNativeHostStatus(btn, { send, runtime }) {
  applyNativeHostStatusToButton(btn, { state: "checking" });
  const unsubscribe = subscribeToNativeHostStatus(btn, runtime);
  const status = await prewarmNativeHost(send);
  applyNativeHostStatusToButton(btn, status);
  return unsubscribe;
}
