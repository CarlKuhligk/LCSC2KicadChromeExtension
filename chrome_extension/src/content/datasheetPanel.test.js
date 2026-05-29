import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatasheetPanel } from "./datasheetPanel.js";

const EXT_ORIGIN_BASE = "chrome-extension://abc123def456";
const getExtensionUrl = (path) => `${EXT_ORIGIN_BASE}/${path ?? ""}`;

function postFromExtension(type, extra = {}) {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: EXT_ORIGIN_BASE,
      data: { type, ...extra },
    }),
  );
}

function postFromOtherOrigin(type, extra = {}) {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: "https://attacker.example",
      data: { type, ...extra },
    }),
  );
}

function makeHost() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

describe("DatasheetPanel", () => {
  let log;
  let panel;
  let revokeCalls;
  let originalRevoke;

  beforeEach(() => {
    vi.useFakeTimers();
    log = vi.fn();
    panel = new DatasheetPanel({
      getExtensionUrl,
      extensionOrigin: EXT_ORIGIN_BASE,
      log,
      stallTimeoutMs: 500,
    });
    // jsdom 26 has no URL.revokeObjectURL; install a stub so calls are observable.
    revokeCalls = [];
    originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (u) => {
      revokeCalls.push(u);
    };
  });

  afterEach(() => {
    panel.unmount();
    document.body.innerHTML = "";
    URL.revokeObjectURL = originalRevoke;
    vi.useRealTimers();
  });

  it("mountViewer inserts an iframe pointing at pdf_viewer.html", () => {
    const host = makeHost();
    panel.mountViewer(host, PDF_BYTES);

    const iframe = host.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe.src).toBe(`${EXT_ORIGIN_BASE}/pdf_viewer.html`);
    expect(iframe.title).toBe("Datasheet PDF");
  });

  it("calls onShown when the iframe announces ready (correct origin)", () => {
    const host = makeHost();
    const onShown = vi.fn();
    panel.mountViewer(host, PDF_BYTES, { onShown });

    postFromExtension("k2c-pdf-ready-v1");
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it("ignores messages from foreign origins (and logs them)", () => {
    const host = makeHost();
    const onShown = vi.fn();
    panel.mountViewer(host, PDF_BYTES, { onShown });

    postFromOtherOrigin("k2c-pdf-ready-v1");
    expect(onShown).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "ignored postMessage (wrong origin); expected extension frame",
      "https://attacker.example",
      "type=",
      "k2c-pdf-ready-v1",
    );
  });

  it("shows the failure placeholder when the iframe reports render failure", () => {
    const host = makeHost();
    panel.mountViewer(host, PDF_BYTES);

    postFromExtension("k2c-pdf-done", { ok: false, detail: "boom" });

    const text = host.textContent;
    expect(text).toContain("Could not render the datasheet in this panel.");
    expect(text).toContain("Open in tab");
    expect(host.querySelector("iframe")).toBeFalsy();
  });

  it("shows the failure placeholder when the stall timeout fires", async () => {
    const host = makeHost();
    panel.mountViewer(host, PDF_BYTES);

    await vi.advanceTimersByTimeAsync(500);

    expect(host.textContent).toContain("Could not render the datasheet in this panel.");
    expect(host.querySelector("iframe")).toBeFalsy();
  });

  it("cancel() invalidates the current generation so late messages are no-ops", () => {
    const host = makeHost();
    const onShown = vi.fn();
    panel.mountViewer(host, PDF_BYTES, { onShown });

    panel.cancel();

    postFromExtension("k2c-pdf-ready-v1");
    expect(onShown).not.toHaveBeenCalled();
  });

  it("unmount() removes the listener, clears stall timer, revokes blob URL", async () => {
    const host = makeHost();
    const onShown = vi.fn();
    panel.mountViewer(host, PDF_BYTES, { onShown });
    panel.trackBlobUrl("blob:abc");

    panel.unmount();

    postFromExtension("k2c-pdf-ready-v1");
    expect(onShown).not.toHaveBeenCalled();

    expect(revokeCalls).toContain("blob:abc");

    await vi.advanceTimersByTimeAsync(1000);
    expect(host.textContent).not.toContain("Could not render the datasheet");
  });

  it("trackBlobUrl revokes the previous URL when set to a new one", () => {
    panel.trackBlobUrl("blob:first");
    panel.trackBlobUrl("blob:second");
    expect(revokeCalls).toContain("blob:first");
    expect(revokeCalls).not.toContain("blob:second");
  });

  it("isCurrent reflects cancel()-bumped generation", () => {
    const initial = panel.currentGen;
    expect(panel.isCurrent(initial)).toBe(true);
    panel.cancel();
    expect(panel.isCurrent(initial)).toBe(false);
    expect(panel.isCurrent(panel.currentGen)).toBe(true);
  });
});
