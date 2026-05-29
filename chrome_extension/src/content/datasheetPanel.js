"use strict";

import { cssJoin } from "./dialog.js";

/**
 * PDF.js cannot load reliably in the content-script isolated world. We render
 * inside an extension-origin iframe (`pdf_viewer.html`) and pass bytes via
 * postMessage. `DatasheetPanel` owns the iframe lifecycle, the postMessage
 * protocol, the stall-timeout, the cancellation token, and the blob-URL
 * housekeeping. Fetching bytes and showing a per-fetch progress UI stays with
 * the caller.
 */
export class DatasheetPanel {
  #log;
  #getExtensionUrl;
  #extensionOrigin;
  #stallTimeoutMs;
  #renderGen = 0;
  #listener = null;
  #stallTimer = null;
  #blobUrl = null;

  /**
   * @param {object} [opts]
   * @param {(path: string) => string} [opts.getExtensionUrl]
   *   Wraps `chrome.runtime.getURL` for testability.
   * @param {string} [opts.extensionOrigin]
   *   The extension's own origin (used to validate inbound postMessages). If
   *   omitted, computed from `getExtensionUrl("")`. Pass it explicitly in
   *   tests, because Node's WHATWG URL parser returns `"null"` for
   *   non-special schemes like `chrome-extension://`.
   * @param {(...args: any[]) => void} [opts.log]
   *   Logger. Defaults to `console.info("[KiCad datasheet]", ...)`.
   * @param {number} [opts.stallTimeoutMs=25000]
   *   How long to wait for the iframe to acknowledge before falling back to
   *   the failure placeholder.
   */
  constructor({
    getExtensionUrl,
    extensionOrigin,
    log,
    stallTimeoutMs = 25000,
  } = {}) {
    this.#getExtensionUrl =
      getExtensionUrl ?? ((path) => chrome.runtime.getURL(path));
    this.#log = log ?? ((...args) => console.info("[KiCad datasheet]", ...args));
    this.#stallTimeoutMs = stallTimeoutMs;
    this.#extensionOrigin =
      extensionOrigin ?? (() => {
        try {
          return new URL(this.#getExtensionUrl("")).origin;
        } catch (_e) {
          return "null";
        }
      })();
  }

  /**
   * Current generation token. Capture this at the start of an async op so you
   * can check `isCurrent(gen)` later to detect cancellation.
   */
  get currentGen() {
    return this.#renderGen;
  }

  /** True if `gen` still matches the current generation (op not cancelled). */
  isCurrent(gen) {
    return gen === this.#renderGen;
  }

  /**
   * Bump the cancellation token and tear down the iframe-side listeners.
   * Returns the new generation token (so callers can capture it).
   */
  cancel() {
    this.#renderGen = (this.#renderGen | 0) + 1;
    this.#removeListener();
    this.#clearStallTimer();
    return this.#renderGen;
  }

  /**
   * Track a blob URL so `unmount()` will revoke it. Calling this with a new
   * URL revokes any previously tracked URL.
   */
  trackBlobUrl(url) {
    if (this.#blobUrl && this.#blobUrl !== url) {
      try {
        URL.revokeObjectURL(this.#blobUrl);
      } catch (_e) {
        /* ignore */
      }
    }
    this.#blobUrl = url ?? null;
  }

  /**
   * Render the PDF.js viewer inside `scrollHost`. If `gen` is omitted the
   * panel bumps and uses a fresh generation. `onShown` is called as soon as
   * the iframe acknowledges and bytes are sent (callers use this to hide a
   * "loading" UI).
   *
   * @param {HTMLElement} scrollHost
   * @param {Uint8Array} pdfBytes
   * @param {{ gen?: number, onShown?: () => void }} [opts]
   * @returns {number} the generation token used for this mount.
   */
  mountViewer(scrollHost, pdfBytes, { gen, onShown = () => {} } = {}) {
    const myGen = typeof gen === "number" ? gen : this.cancel();
    const extOrigin = this.#extensionOrigin;
    this.#log(
      "mount extension PDF viewer",
      "bytes=",
      pdfBytes?.length ?? 0,
      "extOrigin=",
      extOrigin,
      "pageOrigin=",
      typeof window !== "undefined" ? window.location.origin : "(no window)",
    );

    scrollHost.textContent = "";
    scrollHost.style.overflow = "hidden";

    this.#removeListener();
    this.#clearStallTimer();

    const finishFailure = (reason) => {
      this.#clearStallTimer();
      this.#removeListener();
      if (!this.isCurrent(myGen)) return;
      this.#log("viewer failure:", reason);
      onShown();
      scrollHost.textContent = "";
      this.mountFailurePlaceholder(scrollHost);
    };

    const onParentMsg = (e) => {
      const d = e.data;
      const ours = d && typeof d.type === "string" && d.type.startsWith("k2c-pdf");
      if (e.origin !== extOrigin) {
        if (ours) {
          this.#log(
            "ignored postMessage (wrong origin); expected extension frame",
            e.origin,
            "type=",
            d.type,
          );
        }
        return;
      }
      if (d?.type === "k2c-pdf-log-v1" && Array.isArray(d.parts)) {
        this.#log("(pdf iframe)", ...d.parts);
        return;
      }
      if (d?.type === "k2c-pdf-ready-v1") {
        if (!this.isCurrent(myGen)) return;
        this.#log("iframe ready, sending PDF bytes to viewer");
        try {
          const ab = pdfBytes.buffer.slice(
            pdfBytes.byteOffset,
            pdfBytes.byteOffset + pdfBytes.byteLength,
          );
          try {
            iframe.contentWindow?.postMessage(
              { type: "k2c-pdf-render-v1", buffer: ab },
              extOrigin,
              [ab],
            );
          } catch (_transferErr) {
            const copy = new Uint8Array(pdfBytes);
            iframe.contentWindow?.postMessage(
              { type: "k2c-pdf-render-v1", buffer: copy.buffer },
              extOrigin,
            );
          }
          /* Hide immediately — iframe paints asynchronously (was waiting until all pages finished). */
          onShown();
        } catch (err) {
          this.#log("postMessage(render) threw:", err?.message || err);
          finishFailure("postMessage to iframe failed");
        }
        return;
      }
      if (d?.type === "k2c-pdf-done") {
        this.#clearStallTimer();
        this.#removeListener();
        if (!this.isCurrent(myGen)) return;
        /* Overlay usually hidden already on render start; safe if duplicate. */
        onShown();
        if (!d.ok) {
          this.#log("iframe reported render failure", d.detail || "(no detail)");
          scrollHost.textContent = "";
          this.mountFailurePlaceholder(scrollHost);
        } else {
          this.#log("iframe reported render success");
        }
      }
    };

    this.#listener = onParentMsg;
    window.addEventListener("message", onParentMsg);

    this.#stallTimer = setTimeout(
      () =>
        finishFailure(
          `timeout (${(this.#stallTimeoutMs / 1000) | 0}s): no ready+done from pdf_viewer iframe`,
        ),
      this.#stallTimeoutMs,
    );

    const iframe = document.createElement("iframe");
    iframe.title = "Datasheet PDF";
    iframe.style.cssText = cssJoin([
      "position:absolute",
      "inset:0",
      "width:100%",
      "height:100%",
      "border:none",
      "background:#334155",
    ]);
    const pdfViewerUrl = this.#getExtensionUrl("pdf_viewer.html");
    iframe.addEventListener("load", () => {
      this.#log("pdf_viewer iframe load event fired", pdfViewerUrl);
    });
    iframe.addEventListener("error", () => {
      this.#log(
        "pdf_viewer iframe error event (often unused in Chrome; if load never follows, check WAR/manifest)",
      );
    });
    iframe.src = pdfViewerUrl;
    scrollHost.appendChild(iframe);
    return myGen;
  }

  /**
   * Shown when PDF.js cannot render; avoids Chrome's iframe PDF plugin
   * (tiny embedded viewer).
   *
   * @param {HTMLElement} scrollHost
   */
  mountFailurePlaceholder(scrollHost) {
    scrollHost.textContent = "";
    scrollHost.style.overflow = "auto";
    const wrap = scrollHost.ownerDocument.createElement("div");
    wrap.style.cssText = cssJoin([
      "padding:24px",
      "max-width:480px",
      "margin:0 auto",
      "color:#e2e8f0",
      "font-size:13px",
      "line-height:1.55",
      "text-align:center",
    ]);
    const p1 = scrollHost.ownerDocument.createElement("p");
    p1.style.margin = "0 0 12px 0";
    p1.textContent = "Could not render the datasheet in this panel.";
    const p2 = scrollHost.ownerDocument.createElement("p");
    p2.style.margin = "0";
    p2.textContent = "Use “Open in tab” above for the full PDF.";
    wrap.appendChild(p1);
    wrap.appendChild(p2);
    scrollHost.appendChild(wrap);
  }

  /**
   * Full teardown: cancels any in-flight render, removes the message
   * listener, clears the stall timer, and revokes the tracked blob URL.
   */
  unmount() {
    this.cancel();
    if (this.#blobUrl) {
      try {
        URL.revokeObjectURL(this.#blobUrl);
      } catch (_e) {
        /* ignore */
      }
      this.#blobUrl = null;
    }
  }

  #removeListener() {
    if (this.#listener) {
      window.removeEventListener("message", this.#listener);
      this.#listener = null;
    }
  }

  #clearStallTimer() {
    if (this.#stallTimer !== null) {
      clearTimeout(this.#stallTimer);
      this.#stallTimer = null;
    }
  }
}
