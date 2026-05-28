import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BackendStatusMonitor } from "./backendStatusMonitor.js";

describe("BackendStatusMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls until isStable returns true, then stops", async () => {
    const states = [
      { ok: true, data: { connected: false } },
      { ok: true, data: { connected: true, templateSymbolsByLib: {} } },
      { ok: true, data: { connected: true, templateSymbolsByLib: { L: ["T_R"] } } },
    ];
    let i = 0;
    const rpc = {
      getState: vi.fn(() => Promise.resolve(states[Math.min(i++, states.length - 1)])),
    };
    const onTick = vi.fn();
    const m = new BackendStatusMonitor({ rpc, intervalMs: 100, maxAttempts: 10 });

    m.start({
      isStable: (state) => Object.keys(state.templateSymbolsByLib || {}).length > 0,
      onTick,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(onTick).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(m.running).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(m.running).toBe(false);
  });

  it("stops after maxAttempts even if never stable", async () => {
    const rpc = {
      getState: () => Promise.resolve({ ok: true, data: { connected: true } }),
    };
    const onTick = vi.fn();
    const m = new BackendStatusMonitor({ rpc, intervalMs: 100, maxAttempts: 3 });

    m.start({ isStable: () => false, onTick });

    await vi.advanceTimersByTimeAsync(350);
    expect(onTick).toHaveBeenCalledTimes(3);
    expect(m.running).toBe(false);
  });

  it("stop() halts polling immediately", async () => {
    const rpc = {
      getState: () => Promise.resolve({ ok: true, data: { connected: false } }),
    };
    const m = new BackendStatusMonitor({ rpc, intervalMs: 100 });
    m.start({ isStable: () => false, onTick: () => {} });
    await vi.advanceTimersByTimeAsync(50);
    m.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(m.running).toBe(false);
  });

  it("swallows rpc errors and keeps polling", async () => {
    const rpc = {
      getState: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue({ ok: true, data: { connected: true } }),
    };
    const onTick = vi.fn();
    const m = new BackendStatusMonitor({ rpc, intervalMs: 100, maxAttempts: 2 });
    m.start({ isStable: () => true, onTick });

    await vi.advanceTimersByTimeAsync(100);
    expect(onTick).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(m.running).toBe(false);
  });

  it("start() is idempotent while running", async () => {
    const rpc = {
      getState: vi.fn(() => Promise.resolve({ ok: true, data: { connected: false } })),
    };
    const m = new BackendStatusMonitor({ rpc, intervalMs: 100 });
    m.start({ isStable: () => false, onTick: () => {} });
    m.start({ isStable: () => false, onTick: () => {} });
    await vi.advanceTimersByTimeAsync(250);
    // Only one timer running ⇒ exactly two ticks observed (at 100ms and 200ms).
    expect(rpc.getState).toHaveBeenCalledTimes(2);
    m.stop();
  });
});
