import { describe, it, expect, beforeEach } from "vitest";
import {
  runPhase2Convert,
  subscribeConvertProgress,
  formatPhase2Progress,
  formatPhase2Terminal,
  PHASE2_STATUS_ATTR,
} from "./phase2Convert.js";
import { buildAnchorCardRow } from "./anchorCard.js";

/** Same scaffold as phase1Fetch.test — Phase 2 reuses the row's status node. */
function mountAnchorRow() {
  const row = buildAnchorCardRow(document, { colSpan: 1 });
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  tbody.appendChild(row);
  table.appendChild(tbody);
  document.body.appendChild(table);
  return row;
}

/** Mock the SW broadcast surface so tests stay off ``chrome.runtime``. */
function makeMockRuntime() {
  const listeners = new Set();
  return {
    runtime: {
      onMessage: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
      },
    },
    /** Fire a broadcast as the SW would. */
    emit: (message) => {
      for (const fn of listeners) fn(message);
    },
    listenerCount: () => listeners.size,
  };
}

describe("formatPhase2Progress", () => {
  it("renders message and rounded percent when both present", () => {
    expect(
      formatPhase2Progress({ message: "Writing .kicad_mod file…", progress: 73.6 }),
    ).toBe("Phase 2: Writing .kicad_mod file… (74%)");
  });

  it("omits the percent suffix when progress is null", () => {
    expect(formatPhase2Progress({ message: "Finalising…", progress: null })).toBe(
      "Phase 2: Finalising…",
    );
  });

  it("falls back to 'working…' when the SW frame is empty", () => {
    expect(formatPhase2Progress({})).toBe("Phase 2: working…");
  });

  it("clamps wildly out-of-range progress to 0..100", () => {
    expect(formatPhase2Progress({ message: "x", progress: 250 })).toBe("Phase 2: x (100%)");
    expect(formatPhase2Progress({ message: "x", progress: -30 })).toBe("Phase 2: x (0%)");
  });
});

describe("formatPhase2Terminal", () => {
  it("uses the symbol path on success when present", () => {
    expect(
      formatPhase2Terminal({
        ok: true,
        result: { symbolPath: "/abs/MyLib.kicad_sym", libraryPath: "/abs/MyLib" },
      }),
    ).toBe("Phase 2 done · /abs/MyLib.kicad_sym");
  });

  it("falls back to libraryPath when symbolPath is missing", () => {
    expect(formatPhase2Terminal({ ok: true, result: { libraryPath: "/abs/MyLib" } })).toBe(
      "Phase 2 done · /abs/MyLib",
    );
  });

  it("renders bare 'done' when result has no path", () => {
    expect(formatPhase2Terminal({ ok: true, result: {} })).toBe("Phase 2 done");
  });

  it("surfaces the backend error verbatim", () => {
    expect(formatPhase2Terminal({ ok: false, error: "busy" })).toBe("Phase 2 error: busy");
  });

  it("uses 'unknown error' as a last resort", () => {
    expect(formatPhase2Terminal({ ok: false })).toBe("Phase 2 error: unknown error");
    expect(formatPhase2Terminal(null)).toBe("Phase 2 error: unknown error");
  });
});

describe("subscribeConvertProgress", () => {
  it("filters broadcasts by lcscId so two tabs do not bleed into each other", () => {
    const mock = makeMockRuntime();
    const seen = [];
    subscribeConvertProgress("C22548", (frame) => seen.push(frame), { runtime: mock.runtime });
    mock.emit({ type: "v3ConvertProgress", lcscId: "C9999", message: "wrong tab", progress: 10 });
    mock.emit({ type: "v3ConvertProgress", lcscId: "C22548", message: "mine", progress: 42 });
    expect(seen).toEqual([{ message: "mine", progress: 42 }]);
  });

  it("ignores broadcasts with the wrong type", () => {
    const mock = makeMockRuntime();
    const seen = [];
    subscribeConvertProgress("C22548", (frame) => seen.push(frame), { runtime: mock.runtime });
    mock.emit({ type: "stateUpdate", lcscId: "C22548", message: "ignored" });
    expect(seen).toEqual([]);
  });

  it("returns an unsubscribe that frees the listener", () => {
    const mock = makeMockRuntime();
    const unsub = subscribeConvertProgress("C22548", () => {}, { runtime: mock.runtime });
    expect(mock.listenerCount()).toBe(1);
    unsub();
    expect(mock.listenerCount()).toBe(0);
  });
});

describe("runPhase2Convert", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders progress frames inline as they arrive, then the terminal state", async () => {
    const row = mountAnchorRow();
    const mock = makeMockRuntime();
    let resolveRpc;
    const rpc = () => new Promise((r) => { resolveRpc = r; });

    const finished = runPhase2Convert(row, "C22548", {
      rpc,
      subscribe: (id, onProgress, _deps) =>
        subscribeConvertProgress(id, onProgress, { runtime: mock.runtime }),
    });

    const status = row.querySelector(`[${PHASE2_STATUS_ATTR}]`);
    expect(status).toBeTruthy();
    expect(status.getAttribute(PHASE2_STATUS_ATTR)).toBe("loading");
    expect(status.textContent).toContain("Phase 2: starting");

    mock.emit({
      type: "v3ConvertProgress",
      lcscId: "C22548",
      message: "Connecting to EasyEDA…",
      progress: 10,
    });
    expect(status.textContent).toContain("Connecting to EasyEDA");
    expect(status.textContent).toContain("10%");

    mock.emit({
      type: "v3ConvertProgress",
      lcscId: "C22548",
      message: "Writing .kicad_mod file…",
      progress: 90,
    });
    expect(status.textContent).toContain("Writing .kicad_mod");

    resolveRpc({
      ok: true,
      result: { symbolPath: "/abs/MyLib.kicad_sym", libraryPath: "/abs/MyLib" },
    });
    const envelope = await finished;
    expect(envelope.ok).toBe(true);
    expect(status.getAttribute(PHASE2_STATUS_ATTR)).toBe("ok");
    expect(status.textContent).toContain("/abs/MyLib.kicad_sym");
  });

  it("renders the backend error inline and resolves with the failure envelope", async () => {
    const row = mountAnchorRow();
    const envelope = await runPhase2Convert(row, "C22548", {
      rpc: () => Promise.resolve({ ok: false, error: "Failed to fetch data for C22548: HTTP 404" }),
      subscribe: () => () => {},
    });
    const status = row.querySelector(`[${PHASE2_STATUS_ATTR}]`);
    expect(status.getAttribute(PHASE2_STATUS_ATTR)).toBe("error");
    expect(status.textContent).toContain("Phase 2 error");
    expect(status.textContent).toContain("404");
    expect(envelope.ok).toBe(false);
  });

  it("treats a thrown RPC as an error without crashing the page", async () => {
    const row = mountAnchorRow();
    const envelope = await runPhase2Convert(row, "C22548", {
      rpc: () => Promise.reject(new Error("Extension was reloaded")),
      subscribe: () => () => {},
    });
    const status = row.querySelector(`[${PHASE2_STATUS_ATTR}]`);
    expect(status.getAttribute(PHASE2_STATUS_ATTR)).toBe("error");
    expect(status.textContent).toContain("Extension was reloaded");
    expect(envelope.ok).toBe(false);
  });

  it("unsubscribes from the progress broadcast after the terminal frame", async () => {
    const row = mountAnchorRow();
    const mock = makeMockRuntime();
    await runPhase2Convert(row, "C22548", {
      rpc: () => Promise.resolve({ ok: true, result: { symbolPath: "/x.kicad_sym" } }),
      subscribe: (id, onProgress) =>
        subscribeConvertProgress(id, onProgress, { runtime: mock.runtime }),
    });
    expect(mock.listenerCount()).toBe(0);
  });

  it("returns a clear error envelope when wiring is incomplete", async () => {
    const row = mountAnchorRow();
    const envelope = await runPhase2Convert(row, "C22548", {});
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("missing wiring");
  });

  it("forwards an explicit libraryPath to the SW relay", async () => {
    const row = mountAnchorRow();
    const seen = { calls: [] };
    await runPhase2Convert(row, "C22548", {
      rpc: (id, libraryPath) => {
        seen.calls.push({ id, libraryPath });
        return Promise.resolve({ ok: true, result: { symbolPath: "/x.kicad_sym" } });
      },
      libraryPath: "/abs/OverrideLib",
      subscribe: () => () => {},
    });
    expect(seen.calls).toEqual([{ id: "C22548", libraryPath: "/abs/OverrideLib" }]);
  });
});
