/**
 * Tests for the V3 **Warm-Port** classic-script module
 * (``chrome_extension/nativeHostPort.js``).
 *
 * The file is loaded via ``importScripts`` in the MV3 service worker so it
 * must work as a plain script that defines globals. The test runs it inside
 * a ``new Function`` factory to capture the ``createWarmNativePort`` symbol
 * without hitting ``chrome.runtime`` — the production callers wire that up
 * in ``background.js``.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const classicPath = resolve(here, "..", "nativeHostPort.js");
const classicSrc = readFileSync(classicPath, "utf-8");

// `new Function` gives us a fresh scope; the script wraps its module under
// the `createWarmNativePort` name so we return that directly.
function loadModule() {
  const factory = new Function(
    `${classicSrc}\nreturn { createWarmNativePort };`,
  );
  return factory();
}

/**
 * A minimal Chrome ``Port`` stub: queues postMessage frames and exposes
 * triggers so tests can drive ``onMessage`` / ``onDisconnect`` deterministically.
 */
function makeFakePort() {
  const msgListeners = [];
  const discListeners = [];
  const sent = [];
  let disconnected = false;
  return {
    sent,
    postMessage(frame) {
      if (disconnected) throw new Error("Attempting to use a disconnected port");
      sent.push(frame);
    },
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      for (const fn of discListeners) {
        try { fn(); } catch (_) { /* ignore */ }
      }
    },
    onMessage: {
      addListener(fn) { msgListeners.push(fn); },
    },
    onDisconnect: {
      addListener(fn) { discListeners.push(fn); },
    },
    emit(message) {
      for (const fn of msgListeners) fn(message);
    },
    triggerDisconnect() {
      disconnected = true;
      for (const fn of discListeners) fn();
    },
    isDisconnected() { return disconnected; },
  };
}

describe("createWarmNativePort", () => {
  it("opens the native port lazily on first send and reuses it across calls", async () => {
    const { createWarmNativePort } = loadModule();
    const port = makeFakePort();
    const connectNative = vi.fn(() => port);
    const warm = createWarmNativePort({ connectNative });

    expect(warm.isOpen()).toBe(false);
    expect(connectNative).not.toHaveBeenCalled();

    const p1 = warm.send("ping");
    const p2 = warm.send("listTemplates", { libPath: "/x" });
    expect(connectNative).toHaveBeenCalledTimes(1);
    expect(warm.connectCount()).toBe(1);
    expect(warm.pendingCount()).toBe(2);
    expect(port.sent).toHaveLength(2);
    expect(port.sent[0].verb).toBe("ping");
    expect(port.sent[1].verb).toBe("listTemplates");
    expect(port.sent[1].params).toEqual({ libPath: "/x" });

    // Reply out of order — verify the id correlation routes responses correctly.
    port.emit({ id: port.sent[1].id, ok: true, result: { symbols: ["R"] } });
    port.emit({ id: port.sent[0].id, ok: true, version: "0.0.1" });

    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toEqual({ id: port.sent[0].id, ok: true, version: "0.0.1" });
    expect(r2).toEqual({
      id: port.sent[1].id,
      ok: true,
      result: { symbols: ["R"] },
    });
    expect(warm.pendingCount()).toBe(0);
  });

  it("survives between Phase 1 (fetchMetadata) and Phase 2 (convert) with one connect", async () => {
    const { createWarmNativePort } = loadModule();
    const port = makeFakePort();
    const connectNative = vi.fn(() => port);
    const warm = createWarmNativePort({ connectNative });

    const phase1 = warm.send("fetchMetadata", { lcscId: "C22548" });
    port.emit({
      id: port.sent[0].id,
      ok: true,
      result: { categoryPath: "Passives/Resistors", pinCount: 2 },
    });
    await phase1;
    expect(warm.connectCount()).toBe(1);

    // Phase 2 dispatched after the user clicks Convert. With the warm port
    // the Python process stays alive — no second connectNative call.
    const phase2 = warm.send("convert", { lcscId: "C22548", libraryPath: "/tmp/L" });
    expect(connectNative).toHaveBeenCalledTimes(1);
    port.emit({
      id: port.sent[1].id,
      ok: true,
      result: { symbolPath: "/tmp/L.kicad_sym" },
    });
    const result = await phase2;
    expect(result.ok).toBe(true);
    expect(connectNative).toHaveBeenCalledTimes(1);
  });

  it("multiplexes overlapping verbs on the same port and routes responses by id", async () => {
    const { createWarmNativePort } = loadModule();
    const port = makeFakePort();
    const warm = createWarmNativePort({ connectNative: () => port });

    const convert = warm.send("convert", {}, { timeoutMs: 60000 });
    const list = warm.send("listTemplates", { libPath: "/x" });

    expect(port.sent).toHaveLength(2);
    const convertId = port.sent[0].id;
    const listId = port.sent[1].id;
    expect(convertId).not.toBe(listId);

    // listTemplates arrives first while convert is mid-flight — proves
    // overlapping read-only verbs are NOT blocked by the slow convert.
    port.emit({ id: listId, ok: true, result: { symbols: [] } });
    const listResult = await list;
    expect(listResult.ok).toBe(true);
    expect(warm.pendingCount()).toBe(1);

    // Now finish the convert.
    port.emit({ id: convertId, ok: true, result: { symbolPath: "/tmp/L.kicad_sym" } });
    const convertResult = await convert;
    expect(convertResult.ok).toBe(true);
    expect(warm.pendingCount()).toBe(0);
  });

  it("forwards progress frames to the call's onProgress without resolving it", async () => {
    const { createWarmNativePort } = loadModule();
    const port = makeFakePort();
    const warm = createWarmNativePort({ connectNative: () => port });

    const progress = [];
    const convert = warm.send(
      "convert",
      { lcscId: "C1" },
      { timeoutMs: 60000, onProgress: (frame) => progress.push(frame) },
    );
    const id = port.sent[0].id;

    port.emit({ id, type: "progress", message: "Connecting…", progress: 10 });
    port.emit({ id, type: "progress", message: "Writing symbol…", progress: 55 });

    // Not resolved yet — terminal frame still pending.
    expect(warm.pendingCount()).toBe(1);
    expect(progress).toEqual([
      { id, type: "progress", message: "Connecting…", progress: 10 },
      { id, type: "progress", message: "Writing symbol…", progress: 55 },
    ]);

    port.emit({ id, ok: true, result: { symbolPath: "/tmp/L.kicad_sym" } });
    const result = await convert;
    expect(result.ok).toBe(true);
    expect(warm.pendingCount()).toBe(0);
  });

  it("returns timeout envelope when the host never responds", async () => {
    vi.useFakeTimers();
    try {
      const { createWarmNativePort } = loadModule();
      const port = makeFakePort();
      const warm = createWarmNativePort({ connectNative: () => port });

      const p = warm.send("listTemplates", { libPath: "/x" }, { timeoutMs: 5000 });
      // Advance past the timeout — no response from the port.
      vi.advanceTimersByTime(5001);
      const result = await p;
      expect(result).toEqual({ ok: false, error: "timeout" });
      expect(warm.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects in-flight calls with disconnected and reconnects on the next send", async () => {
    const { createWarmNativePort } = loadModule();
    const port1 = makeFakePort();
    const port2 = makeFakePort();
    const connectNative = vi.fn();
    connectNative.mockImplementationOnce(() => port1);
    connectNative.mockImplementationOnce(() => port2);
    const warm = createWarmNativePort({ connectNative });

    const a = warm.send("listTemplates", { libPath: "/x" });
    const b = warm.send("ping");
    expect(warm.pendingCount()).toBe(2);

    port1.triggerDisconnect();
    const aRes = await a;
    const bRes = await b;
    expect(aRes.ok).toBe(false);
    expect(aRes.error).toBeDefined();
    expect(bRes.ok).toBe(false);
    expect(warm.pendingCount()).toBe(0);
    expect(warm.isOpen()).toBe(false);

    // Next send reconnects with a fresh port.
    const c = warm.send("ping");
    expect(connectNative).toHaveBeenCalledTimes(2);
    expect(warm.connectCount()).toBe(2);
    port2.emit({ id: port2.sent[0].id, ok: true, version: "0.0.1" });
    const cRes = await c;
    expect(cRes.ok).toBe(true);
  });

  it("returns a structured error when connectNative throws", async () => {
    const { createWarmNativePort } = loadModule();
    const errors = [];
    const warm = createWarmNativePort({
      connectNative: () => { throw new Error("Specified native messaging host not found."); },
      onError: (e) => errors.push(e),
    });

    const res = await warm.send("ping");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Specified native messaging host not found.");
    expect(errors).toHaveLength(1);
  });

  it("disconnect() drains pending and frees the live port", async () => {
    const { createWarmNativePort } = loadModule();
    const port = makeFakePort();
    const warm = createWarmNativePort({ connectNative: () => port });

    const p = warm.send("ping");
    expect(warm.isOpen()).toBe(true);

    warm.disconnect();
    expect(warm.isOpen()).toBe(false);
    expect(port.isDisconnected()).toBe(true);

    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.error).toBe("disconnected");
  });

  it("ignores stray messages with unknown ids (delayed responses after disconnect)", async () => {
    const { createWarmNativePort } = loadModule();
    const port = makeFakePort();
    const warm = createWarmNativePort({ connectNative: () => port });
    const p = warm.send("ping");
    const id = port.sent[0].id;

    // Unknown id — must NOT resolve the pending ping or throw.
    port.emit({ id: id + 999, ok: true, result: {} });
    expect(warm.pendingCount()).toBe(1);

    port.emit({ id, ok: true, version: "0.0.1" });
    const r = await p;
    expect(r.ok).toBe(true);
  });

  it("missing verb returns structured error without going to the wire", async () => {
    const { createWarmNativePort } = loadModule();
    const port = makeFakePort();
    const warm = createWarmNativePort({ connectNative: () => port });

    const r = await warm.send("");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing verb");
    // No port opened, no postMessage sent.
    expect(warm.isOpen()).toBe(false);
    expect(port.sent).toHaveLength(0);
  });
});
