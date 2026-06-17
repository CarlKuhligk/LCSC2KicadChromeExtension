import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  NATIVE_HOST_STATUS_BUTTON_ATTR,
  NATIVE_HOST_STATUS_UPDATE_TYPE,
  PREWARM_MESSAGE_TYPE,
  applyNativeHostStatusToButton,
  attachNativeHostStatus,
  normalizeNativeHostStatus,
  prewarmNativeHost,
  subscribeToNativeHostStatus,
} from "./nativeHostStatusButton.js";

function makeButton() {
  const btn = document.createElement("button");
  btn.setAttribute("data-k2c-action", "download");
  btn.textContent = "Download";
  return btn;
}

describe("normalizeNativeHostStatus", () => {
  it("defaults to checking on unknown / missing payloads", () => {
    expect(normalizeNativeHostStatus(undefined)).toEqual({ state: "checking", version: null, error: null });
    expect(normalizeNativeHostStatus(null)).toEqual({ state: "checking", version: null, error: null });
    expect(normalizeNativeHostStatus({})).toEqual({ state: "checking", version: null, error: null });
    expect(normalizeNativeHostStatus({ state: "weird" })).toEqual({ state: "checking", version: null, error: null });
  });

  it("preserves a known state with version + error", () => {
    expect(normalizeNativeHostStatus({ state: "online", version: "0.0.1" })).toEqual({
      state: "online",
      version: "0.0.1",
      error: null,
    });
    expect(normalizeNativeHostStatus({ state: "offline", error: "timeout" })).toEqual({
      state: "offline",
      version: null,
      error: "timeout",
    });
  });

  it("is case-insensitive on the state", () => {
    expect(normalizeNativeHostStatus({ state: "ONLINE" }).state).toBe("online");
  });
});

describe("applyNativeHostStatusToButton", () => {
  it("renders the `checking` state — disabled, spinner cursor, tooltip", () => {
    const btn = makeButton();
    applyNativeHostStatusToButton(btn, { state: "checking" });
    expect(btn.getAttribute(NATIVE_HOST_STATUS_BUTTON_ATTR)).toBe("checking");
    expect(btn.disabled).toBe(true);
    expect(btn.style.cursor).toBe("progress");
    expect(btn.title).toBe("Checking native host…");
  });

  it("renders the `online` state — enabled, version in tooltip", () => {
    const btn = makeButton();
    applyNativeHostStatusToButton(btn, { state: "online", version: "1.2.3" });
    expect(btn.getAttribute(NATIVE_HOST_STATUS_BUTTON_ATTR)).toBe("online");
    expect(btn.disabled).toBe(false);
    expect(btn.style.cursor).toBe("pointer");
    expect(btn.title).toBe("Native host online · v1.2.3");
  });

  it("renders the `offline` state — disabled, installer hint + error context", () => {
    const btn = makeButton();
    applyNativeHostStatusToButton(btn, { state: "offline", error: "Specified native messaging host not found." });
    expect(btn.getAttribute(NATIVE_HOST_STATUS_BUTTON_ATTR)).toBe("offline");
    expect(btn.disabled).toBe(true);
    expect(btn.style.cursor).toBe("not-allowed");
    expect(btn.title).toContain("Native host is offline — run the installer.");
    expect(btn.title).toContain("Specified native messaging host not found.");
  });

  it("does nothing when the button is null (no throw)", () => {
    expect(() => applyNativeHostStatusToButton(null, { state: "online" })).not.toThrow();
  });

  it("idempotent — applying the same state twice yields the same DOM", () => {
    const btn = makeButton();
    applyNativeHostStatusToButton(btn, { state: "online", version: "1" });
    const before = btn.outerHTML;
    applyNativeHostStatusToButton(btn, { state: "online", version: "1" });
    expect(btn.outerHTML).toBe(before);
  });

  it("honors a k2cLabelOverride dataset hook across state re-paints", () => {
    const btn = makeButton();
    btn.dataset.k2cLabelOverride = "Re-Import";
    // Every heartbeat re-applies; the override must win over the default label.
    applyNativeHostStatusToButton(btn, { state: "online", version: "1.2.3" });
    expect(btn.textContent).toBe("Re-Import");
    applyNativeHostStatusToButton(btn, { state: "offline", error: "x" });
    expect(btn.textContent).toBe("Re-Import");
    applyNativeHostStatusToButton(btn, { state: "checking" });
    expect(btn.textContent).toBe("Re-Import");
  });
});

describe("prewarmNativeHost", () => {
  it("posts the prewarm message and returns the normalized status on success", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, data: { state: "online", version: "0.0.1" } });
    const result = await prewarmNativeHost(send);
    expect(send).toHaveBeenCalledWith({ type: PREWARM_MESSAGE_TYPE });
    expect(result).toEqual({ state: "online", version: "0.0.1", error: null });
  });

  it("treats `ok: false` as offline and surfaces the error", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, error: "no host" });
    const result = await prewarmNativeHost(send);
    expect(result).toEqual({ state: "offline", version: null, error: "no host" });
  });

  it("treats a thrown sender (e.g. extension context invalidated) as offline", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Extension was reloaded."));
    const result = await prewarmNativeHost(send);
    expect(result.state).toBe("offline");
    expect(result.error).toBe("Extension was reloaded.");
  });
});

describe("subscribeToNativeHostStatus", () => {
  it("updates the button on a matching push message", () => {
    const btn = makeButton();
    let listener = null;
    const runtime = {
      addListener: vi.fn((fn) => { listener = fn; }),
      removeListener: vi.fn(),
    };
    subscribeToNativeHostStatus(btn, runtime);
    expect(runtime.addListener).toHaveBeenCalled();

    listener({ type: NATIVE_HOST_STATUS_UPDATE_TYPE, status: { state: "online", version: "0.0.1" } });
    expect(btn.getAttribute(NATIVE_HOST_STATUS_BUTTON_ATTR)).toBe("online");

    listener({ type: NATIVE_HOST_STATUS_UPDATE_TYPE, status: { state: "offline", error: "boom" } });
    expect(btn.getAttribute(NATIVE_HOST_STATUS_BUTTON_ATTR)).toBe("offline");
  });

  it("ignores unrelated messages", () => {
    const btn = makeButton();
    let listener = null;
    const runtime = {
      addListener: (fn) => { listener = fn; },
      removeListener: vi.fn(),
    };
    subscribeToNativeHostStatus(btn, runtime);
    listener({ type: "stateUpdate", state: {} });
    expect(btn.hasAttribute(NATIVE_HOST_STATUS_BUTTON_ATTR)).toBe(false);
  });

  it("returns a noop when given a missing runtime — no throw on unsubscribe", () => {
    const btn = makeButton();
    const unsubscribe = subscribeToNativeHostStatus(btn, null);
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });

  it("unsubscribe removes the listener", () => {
    const btn = makeButton();
    const runtime = {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    };
    const unsubscribe = subscribeToNativeHostStatus(btn, runtime);
    unsubscribe();
    expect(runtime.removeListener).toHaveBeenCalled();
  });
});

describe("attachNativeHostStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("paints `checking` synchronously, then resolves with the real status", async () => {
    vi.useRealTimers();
    const btn = makeButton();
    const send = vi.fn(() => new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, data: { state: "online", version: "0.0.1" } }), 10);
    }));
    const runtime = { addListener: vi.fn(), removeListener: vi.fn() };

    const pending = attachNativeHostStatus(btn, { send, runtime });
    expect(btn.getAttribute(NATIVE_HOST_STATUS_BUTTON_ATTR)).toBe("checking");

    await pending;
    expect(btn.getAttribute(NATIVE_HOST_STATUS_BUTTON_ATTR)).toBe("online");
    expect(runtime.addListener).toHaveBeenCalled();
  });

  it("resolves to `offline` when the SW reports it is not reachable", async () => {
    vi.useRealTimers();
    const btn = makeButton();
    const send = vi.fn().mockResolvedValue({ ok: true, data: { state: "offline", error: "no host" } });
    const runtime = { addListener: vi.fn(), removeListener: vi.fn() };

    await attachNativeHostStatus(btn, { send, runtime });
    expect(btn.getAttribute(NATIVE_HOST_STATUS_BUTTON_ATTR)).toBe("offline");
    expect(btn.title).toContain("no host");
  });
});
