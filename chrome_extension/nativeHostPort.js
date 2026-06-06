"use strict";

/**
 * V3 **Warm-Port** — persistent Native-Messaging port the service worker
 * reuses for every RPC (Issue #26).
 *
 * The pre-#26 SW called ``chrome.runtime.connectNative`` per RPC, so every
 * ``fetchMetadata`` / ``convert`` / ``listTemplates`` paid the Python
 * cold-start cost. With a warm port the host process stays alive for the
 * whole session: the Phase 1 → Phase 2 hand-off is hot, the 25-s keep-alive
 * ``ping`` runs on the same connection, and panel reads (``listTemplates``,
 * future ``getRule`` / ``fsList``) overlap a long ``convert`` (host-side
 * multi-threading also lands in #26).
 *
 * Concurrent RPCs share the port via the existing Native-Messaging ``id``
 * field — every ``send()`` allocates a monotonic ``seq`` and routes the
 * matching response back to the right caller. Streaming verbs (``convert``)
 * forward each ``type: "progress"`` frame to the call's ``onProgress``
 * callback; the call only resolves on the terminal envelope. A timeout per
 * call frees the entry if the host wedges. Port disconnects (Python crash,
 * SW idle, manifest reload) reject every in-flight call with ``disconnected``
 * — the next ``send()`` reconnects lazily.
 *
 * The module has no ``chrome.*`` glue at load time; ``createWarmNativePort``
 * takes a ``connectNative`` factory so tests can drive it with a fake port.
 * See ``chrome_extension/shared/nativeHostPort.test.mjs``.
 *
 * Single-flight semantics for ``fetchMetadata`` / ``convert`` are enforced
 * **host-side** by the shared ``_busy_lock`` (ADR-0004) — the warm port
 * does NOT serialize sends. SW callers keep their own pre-checks
 * (``nativeHostConvertInFlight``) to avoid a port roundtrip; those flags
 * stay valid because the host's ``busy`` reply is still observed.
 *
 * Globals defined: ``k2cCreateWarmNativePort``.
 */

function createWarmNativePort(options) {
  const opts = options || {};
  if (typeof opts.connectNative !== "function") {
    throw new Error("createWarmNativePort: connectNative is required");
  }
  const connectNative = opts.connectNative;
  const onError = typeof opts.onError === "function" ? opts.onError : () => {};
  const setTimer = typeof opts.setTimeout === "function" ? opts.setTimeout : setTimeout;
  const clearTimer = typeof opts.clearTimeout === "function" ? opts.clearTimeout : clearTimeout;

  /** @type {object|null} The live ``chrome.runtime.Port`` (or test stub). */
  let port = null;
  /** @type {Map<number, {resolve: (value: object) => void, timer: unknown, onProgress: ((frame: object) => void) | null}>} */
  const pending = new Map();
  let seq = 0;
  /** Total connect calls; tests assert this stays at 1 for warm reuse. */
  let connectCount = 0;
  /** Last disconnect error message — surfaced on the next reconnect. */
  let lastDisconnectError = null;

  function drainPending(detail) {
    const entries = Array.from(pending.values());
    pending.clear();
    for (const entry of entries) {
      clearTimer(entry.timer);
      entry.resolve({ ok: false, error: detail });
    }
  }

  function ensurePort() {
    if (port) return port;
    let next;
    try {
      next = connectNative();
    } catch (e) {
      const err = new Error(e && e.message ? e.message : "connectNative threw");
      onError(err);
      throw err;
    }
    if (!next || typeof next.postMessage !== "function") {
      const err = new Error("connectNative returned no port");
      onError(err);
      throw err;
    }
    connectCount += 1;
    port = next;
    lastDisconnectError = null;

    next.onMessage.addListener(handleMessage);
    next.onDisconnect.addListener(handleDisconnect);
    return next;
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    const id = message.id;
    if (id == null) return;
    const entry = pending.get(id);
    if (!entry) return;
    // Streaming verbs (currently only ``convert``) keep the entry open
    // until the terminal envelope arrives. The host marks streaming frames
    // with ``type: "progress"`` so any future addition (warnings, etc.)
    // does NOT accidentally resolve here.
    if (message.type === "progress") {
      if (typeof entry.onProgress === "function") {
        try {
          entry.onProgress(message);
        } catch (e) {
          onError(e instanceof Error ? e : new Error(String(e)));
        }
      }
      return;
    }
    pending.delete(id);
    clearTimer(entry.timer);
    entry.resolve(message);
  }

  function handleDisconnect() {
    // No port.disconnect() call needed — Chrome already tore it down.
    port = null;
    // Capture the last-error message before draining pending so callers see
    // a meaningful reason instead of plain "disconnected".
    let detail = "disconnected";
    try {
      if (
        typeof globalThis !== "undefined"
        && globalThis.chrome
        && globalThis.chrome.runtime
        && globalThis.chrome.runtime.lastError
        && globalThis.chrome.runtime.lastError.message
      ) {
        detail = globalThis.chrome.runtime.lastError.message;
      }
    } catch (_e) {
      /* runtime not available in tests — fall back to plain "disconnected" */
    }
    lastDisconnectError = detail;
    drainPending(detail);
  }

  function send(verb, params, callOpts) {
    if (typeof verb !== "string" || !verb) {
      return Promise.resolve({ ok: false, error: "missing verb" });
    }
    const co = callOpts || {};
    const timeoutMs = Number.isFinite(co.timeoutMs) ? Number(co.timeoutMs) : 5000;
    const onProgress = typeof co.onProgress === "function" ? co.onProgress : null;

    let livePort;
    try {
      livePort = ensurePort();
    } catch (e) {
      return Promise.resolve({ ok: false, error: e && e.message ? e.message : String(e) });
    }

    seq = (seq + 1) >>> 0 || 1; // wrap-around stays positive (0 reserved)
    const id = seq;

    return new Promise((resolve) => {
      const timer = setTimer(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        resolve({ ok: false, error: "timeout" });
      }, timeoutMs);

      pending.set(id, {
        resolve,
        timer,
        onProgress,
      });

      try {
        const frame = { id, verb };
        if (params !== undefined) frame.params = params;
        livePort.postMessage(frame);
      } catch (e) {
        pending.delete(id);
        clearTimer(timer);
        resolve({
          ok: false,
          error: e && e.message ? e.message : "postMessage threw",
        });
      }
    });
  }

  function disconnect() {
    const livePort = port;
    port = null;
    if (livePort && typeof livePort.disconnect === "function") {
      try {
        livePort.disconnect();
      } catch (_) { /* already gone */ }
    }
    drainPending("disconnected");
  }

  return {
    send,
    disconnect,
    isOpen() { return Boolean(port); },
    pendingCount() { return pending.size; },
    connectCount() { return connectCount; },
    lastDisconnectError() { return lastDisconnectError; },
  };
}

// Classic-script export for ``importScripts`` callers (background.js).
if (typeof globalThis !== "undefined") {
  globalThis.k2cCreateWarmNativePort = createWarmNativePort;
}
