/**
 * Runs in extension origin (iframe). Loads PDF.js via import; LCSC page posts PDF bytes.
 */
async function main() {
  function forwardLog(...parts) {
    const safe = parts.map((p) => {
      if (p instanceof Error) {
        return p.stack || p.message || String(p);
      }
      if (typeof p === "object" && p !== null) {
        try {
          return JSON.stringify(p);
        } catch (_e) {
          return String(p);
        }
      }
      return String(p);
    });
    console.info("[KiCad datasheet pdf iframe]", ...safe);
    try {
      window.parent.postMessage({ type: "k2c-pdf-log-v1", parts: safe }, "*");
    } catch (_e) {
      /* ignore */
    }
  }

  function postDone(ok, detail) {
    try {
      window.parent.postMessage(
        { type: "k2c-pdf-done", ok: Boolean(ok), detail: detail ? String(detail) : "" },
        "*",
      );
    } catch (_e) {
      /* ignore */
    }
  }

  forwardLog("pdf_viewer_page started", "href=", location.href);

  try {
    await import("./vendor/pdfjs/pdf.min.mjs");
  } catch (err) {
    forwardLog("pdf.min.mjs import failed:", err);
    postDone(false, "pdf.js import failed");
    return;
  }

  const pdfjsLib = globalThis.pdfjsLib;
  if (!pdfjsLib?.getDocument) {
    forwardLog("pdfjsLib.getDocument missing after import");
    postDone(false, "pdfjsLib missing");
    return;
  }
  if (pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "./vendor/pdfjs/pdf.worker.min.mjs",
      import.meta.url,
    ).href;
  }

  /**
   * PDF.js outline / bookmarks → 1-based page number (null if unresolved).
   * Only used when {@code pdf.getOutline()} returns items (embedded TOC).
   */
  async function resolveDestToPageNumber(pdf, dest) {
    if (dest == null) {
      return null;
    }
    try {
      let explicit = dest;
      if (explicit && typeof explicit === "object" && typeof explicit.then === "function") {
        explicit = await explicit;
      }
      if (typeof explicit === "string") {
        explicit = await pdf.getDestination(explicit);
      }
      if (!explicit || !Array.isArray(explicit) || explicit.length === 0) {
        return null;
      }
      const target = explicit[0];
      if (target && typeof target === "object" && typeof target.num === "number") {
        const idx = await pdf.getPageIndex(target);
        if (typeof idx === "number" && idx >= 0) {
          return idx + 1;
        }
        return null;
      }
      if (typeof target === "number" && Number.isFinite(target)) {
        return target + 1;
      }
    } catch (_e) {
      /* ignore */
    }
    return null;
  }

  /** Parent is the LCSC tab (content script); hostname can vary (e.g. regional hosts). */
  function isAllowedLcscParentOrigin(origin) {
    if (!origin || origin === "null") {
      return false;
    }
    try {
      const u = new URL(origin);
      if (u.protocol !== "https:") {
        return false;
      }
      const h = u.hostname.toLowerCase();
      if (h === "lcsc.com" || h.endsWith(".lcsc.com")) {
        return true;
      }
      if (h === "lcsiglobal.com" || h.endsWith(".lcsiglobal.com")) {
        return true;
      }
      if (h === "szlcsc.com" || h.endsWith(".szlcsc.com")) {
        return true;
      }
      return false;
    } catch (_e) {
      return false;
    }
  }

  window.addEventListener("message", async (ev) => {
    if (!ev.data || typeof ev.data.type !== "string") {
      return;
    }
    if (ev.data.type !== "k2c-pdf-render-v1") {
      return;
    }
    if (!isAllowedLcscParentOrigin(ev.origin)) {
      forwardLog(
        "ignored k2c-pdf-render-v1 — parent origin not allowed:",
        ev.origin,
        "(allowed: https *.lcsc.com, *.lcsiglobal.com, *.szlcsc.com)",
      );
      return;
    }
    const root = document.getElementById("root");
    if (!root) {
      forwardLog("#root missing");
      postDone(false, "no #root");
      return;
    }
    root.replaceChildren();

    let buffer = ev.data.buffer;
    if (buffer instanceof ArrayBuffer && buffer.byteLength === 0) {
      forwardLog("empty ArrayBuffer");
      postDone(false, "empty buffer");
      return;
    }
    if (ArrayBuffer.isView(buffer)) {
      buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    if (!(buffer instanceof ArrayBuffer)) {
      forwardLog("payload is not ArrayBuffer; got", typeof buffer);
      postDone(false, "bad buffer type");
      return;
    }

    const u8 = new Uint8Array(buffer);
    forwardLog("render request", "buffer bytes=", u8.length, "parentOrigin=", ev.origin);

    try {
      /** Prefer worker (enables full parser pipeline); fall back if extension context rejects it. */
      const docOpts = (disableWorker) => ({
        data: u8,
        useSystemFonts: true,
        disableWorker,
        verbosity: 0,
      });
      let pdf;
      try {
        pdf = await pdfjsLib.getDocument(docOpts(false)).promise;
        forwardLog("getDocument OK (worker enabled)");
      } catch (wErr) {
        forwardLog("getDocument with worker failed, retrying main-thread:", wErr);
        pdf = await pdfjsLib.getDocument(docOpts(true)).promise;
        forwardLog("getDocument OK (disableWorker fallback)");
      }

      /** Resolve bookmarks while pages render (sequential was blocking first paint). */
      const outlinePromise = (async () => {
        if (typeof pdf.getOutline !== "function") {
          forwardLog("pdf.getOutline missing — PDF.js build has no outline API");
          return null;
        }
        try {
          return await pdf.getOutline();
        } catch (err) {
          forwardLog("getOutline failed:", err);
          return null;
        }
      })();

      root.style.cssText = [
        "height:100%",
        "box-sizing:border-box",
        "padding:0",
        "display:flex",
        "flex-direction:column",
        "min-height:0",
      ].join(";");

      const layout = document.createElement("div");
      layout.style.cssText = [
        "display:flex",
        "flex:1",
        "flex-direction:row",
        "min-height:0",
        "width:100%",
        "align-items:stretch",
      ].join(";");

      const mainCol = document.createElement("div");
      mainCol.style.cssText = [
        "flex:1",
        "min-width:0",
        "min-height:0",
        "overflow:auto",
        "box-sizing:border-box",
        "padding:8px",
        "-webkit-overflow-scrolling:touch",
      ].join(";");

      const inner = document.createElement("div");
      inner.style.cssText = [
        "display:flex",
        "flex-direction:column",
        "align-items:stretch",
        "gap:8px",
        "padding:0",
        "box-sizing:border-box",
        "width:100%",
        "min-width:0",
      ].join(";");

      /**
       * Render the whole downloaded PDF in-panel (up to cap). Beyond cap, use Open in tab.
       * Batched + idle yields keep the tab responsive while pages stream in.
       */
      const PREVIEW_PAGE_CAP = 150;
      const maxPages = Math.min(pdf.numPages, PREVIEW_PAGE_CAP);

      function scrollToPdfPage(pageNum) {
        const n =
          typeof pageNum === "number" && pageNum >= 1
            ? Math.min(Math.floor(pageNum), maxPages)
            : 1;
        const el = document.getElementById(`k2c-pdf-page-${n}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }

      function createTocShell(ariaLabel, titleText) {
        const tocAside = document.createElement("aside");
        tocAside.setAttribute("aria-label", ariaLabel);
        tocAside.style.cssText = [
          "flex:0 0 min(240px,32vw)",
          "max-width:min(280px,40vw)",
          "min-width:min(180px,28vw)",
          "min-height:0",
          "overflow:auto",
          "box-sizing:border-box",
          "border-right:1px solid rgba(148,163,184,0.35)",
          "background:rgba(15,23,42,0.5)",
          "padding:10px 0 10px 0",
        ].join(";");

        const tocTitle = document.createElement("div");
        tocTitle.textContent = titleText;
        tocTitle.style.cssText = [
          "font-size:10px",
          "font-weight:700",
          "letter-spacing:0.08em",
          "text-transform:uppercase",
          "color:#94a3b8",
          "padding:0 12px 8px 12px",
        ].join(";");

        const tocList = document.createElement("nav");
        tocList.style.cssText = "display:flex;flex-direction:column;gap:2px;padding:0 6px;";
        tocAside.appendChild(tocTitle);
        tocAside.appendChild(tocList);
        return { tocAside, tocList };
      }

      function styleTocRowButton(row, padL) {
        row.style.cssText = [
          "display:block",
          "width:100%",
          "text-align:left",
          "border:none",
          "background:transparent",
          "color:#e2e8f0",
          "font-size:12px",
          "line-height:1.35",
          "padding:6px 8px 6px " + padL + "px",
          "cursor:pointer",
          "border-radius:6px",
          "font-family:inherit",
        ].join(";");
        row.addEventListener("mouseenter", () => {
          row.style.background = "rgba(255,255,255,0.08)";
        });
        row.addEventListener("mouseleave", () => {
          row.style.background = "transparent";
        });
      }

      mainCol.appendChild(inner);
      layout.appendChild(mainCol);
      root.appendChild(layout);

      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const hostW = mainCol.getBoundingClientRect().width || root.getBoundingClientRect().width || 360;
      const targetW = Math.max(200, Math.round(hostW - 16));
      const dpr = Math.min(window.devicePixelRatio || 1, 1);

      const renderedPageIndices = [];

      async function renderOnePage(pi) {
        const page = await pdf.getPage(pi);
        const baseVp = page.getViewport({ scale: 1 });
        if (baseVp.width < 1) {
          return null;
        }
        const scale = targetW / baseVp.width;
        const vp = page.getViewport({ scale: Math.max(scale, 0.15) });
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) {
          throw new Error("no canvas 2d");
        }
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        const rw = Number(vp.width.toFixed(3));
        const rh = Number(vp.height.toFixed(3));
        canvas.style.cssText = [
          "display:block",
          "width:100%",
          "max-width:100%",
          `aspect-ratio:${rw} / ${rh}`,
          "height:auto",
          "background:#fff",
          "box-shadow:0 1px 4px rgba(0,0,0,0.25)",
          "box-sizing:border-box",
        ].join(";");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const renderTask = page.render({ canvasContext: ctx, viewport: vp });
        await (renderTask?.promise ?? renderTask);
        const pageWrap = document.createElement("div");
        pageWrap.id = `k2c-pdf-page-${pi}`;
        pageWrap.style.cssText = "scroll-margin-top:8px;width:100%;box-sizing:border-box;";
        pageWrap.appendChild(canvas);
        return { pi, pageWrap };
      }

      const PAGE_BATCH = 4;
      function yieldForUi() {
        return new Promise((resolve) => {
          if (typeof requestIdleCallback === "function") {
            requestIdleCallback(() => resolve(), { timeout: 500 });
          } else {
            setTimeout(resolve, 0);
          }
        });
      }
      for (let start = 1; start <= maxPages; start += PAGE_BATCH) {
        if (start > 1) {
          await yieldForUi();
        }
        const batch = [];
        for (let pi = start; pi < start + PAGE_BATCH && pi <= maxPages; pi += 1) {
          batch.push(pi);
        }
        const part = await Promise.all(
          batch.map(async (pi) => {
            try {
              return await renderOnePage(pi);
            } catch (e) {
              forwardLog("page render failed", pi, e);
              return null;
            }
          }),
        );
        const ok = part.filter(Boolean);
        ok.sort((a, b) => a.pi - b.pi);
        for (const { pi, pageWrap } of ok) {
          inner.appendChild(pageWrap);
          renderedPageIndices.push(pi);
        }
      }

      if (renderedPageIndices.length === 0 && pdf.numPages > 0) {
        forwardLog("no pages rendered to canvas");
        postDone(false, "Could not render PDF pages");
        return;
      }

      const outline = await outlinePromise;
      const hasToc = Array.isArray(outline) && outline.length > 0;
      let outlineNavShown = false;

      if (hasToc) {
        const { tocAside, tocList } = createTocShell("Table of contents", "Contents");

        function appendOutlineNodes(nodes, depth) {
          if (!Array.isArray(nodes)) {
            return;
          }
          for (const item of nodes) {
            const title = typeof item.title === "string" ? item.title : "";
            const sub = Array.isArray(item.items) ? item.items : [];
            const hasDest = item.dest != null;
            const linkUrl =
              typeof item.url === "string" && item.url.trim()
                ? item.url.trim()
                : typeof item.unsafeUrl === "string" && item.unsafeUrl.trim()
                  ? item.unsafeUrl.trim()
                  : "";
            const hasUrl = linkUrl.length > 0;

            if (!hasDest && !hasUrl && sub.length > 0) {
              const hdr = document.createElement("div");
              hdr.textContent = title || "—";
              hdr.style.cssText = [
                "font-size:11px",
                "font-weight:600",
                "color:#cbd5e1",
                "padding:8px 10px 4px " + (10 + depth * 10) + "px",
                "line-height:1.3",
              ].join(";");
              tocList.appendChild(hdr);
              appendOutlineNodes(sub, depth + 1);
              continue;
            }

            if (!hasDest && !hasUrl) {
              continue;
            }

            const row = document.createElement("button");
            row.type = "button";
            row.textContent = title || "(untitled)";
            const padL = 10 + depth * 10;
            styleTocRowButton(row, padL);
            row.addEventListener("click", async () => {
              if (hasUrl && !hasDest) {
                window.open(linkUrl, "_blank", "noopener,noreferrer");
                return;
              }
              const pn = await resolveDestToPageNumber(pdf, item.dest);
              if (pn != null) {
                scrollToPdfPage(pn);
                if (pn > maxPages) {
                  forwardLog("TOC target page beyond preview", pn, "maxPreview=", maxPages);
                }
              } else if (hasUrl) {
                window.open(linkUrl, "_blank", "noopener,noreferrer");
              }
            });

            tocList.appendChild(row);
            if (sub.length > 0) {
              appendOutlineNodes(sub, depth + 1);
            }
          }
        }

        appendOutlineNodes(outline, 0);
        if (tocList.childElementCount === 0) {
          forwardLog("outline present but no navigable entries");
        } else {
          layout.insertBefore(tocAside, mainCol);
          outlineNavShown = true;
          forwardLog("TOC panel shown", "top-level items=", outline.length);
        }
      }

      if (pdf.numPages > maxPages) {
        const note = document.createElement("div");
        note.textContent = `Showing first ${maxPages} of ${pdf.numPages} pages in this panel — use “Open in tab” for the entire file.`;
        note.style.cssText =
          "font-size:11px;color:#94a3b8;text-align:center;padding:4px 8px;width:100%;box-sizing:border-box;";
        inner.appendChild(note);
      }

      if (!outlineNavShown && renderedPageIndices.length > 0) {
        const { tocAside: pageAside, tocList: pageNav } = createTocShell("Pages", "Pages");
        const lastPi = renderedPageIndices[renderedPageIndices.length - 1];
        for (const pi of renderedPageIndices) {
          const row = document.createElement("button");
          row.type = "button";
          row.textContent =
            pdf.numPages > maxPages && pi === lastPi
              ? `Page ${pi} (preview ends)`
              : `Page ${pi}`;
          styleTocRowButton(row, 10);
          row.addEventListener("click", () => scrollToPdfPage(pi));
          pageNav.appendChild(row);
        }
        layout.insertBefore(pageAside, mainCol);
        forwardLog("page-index nav enabled", "count=", renderedPageIndices.length);
      }

      forwardLog(
        "render OK",
        "pages drawn=",
        renderedPageIndices.length,
        "previewCap=",
        maxPages,
        "total=",
        pdf.numPages,
        "outlineBookmarks=",
        Boolean(hasToc && outlineNavShown),
        "leftNav=",
        outlineNavShown || renderedPageIndices.length > 0,
      );
      postDone(true, "");
    } catch (err) {
      forwardLog("getDocument/render threw:", err);
      postDone(false, err?.message || String(err));
    }
  });

  try {
    forwardLog("posting k2c-pdf-ready-v1 to parent");
    window.parent.postMessage({ type: "k2c-pdf-ready-v1" }, "*");
  } catch (err) {
    forwardLog("postMessage(ready) threw:", err);
    postDone(false, "ready postMessage failed");
  }
}

void main();
