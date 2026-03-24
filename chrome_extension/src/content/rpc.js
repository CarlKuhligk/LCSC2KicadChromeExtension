"use strict";

import { EXT_RELOAD_BANNER_ID } from "./constants.js";

let extReloadBannerShown = false;

/** After extension reload/update, MV3 invalidates this tab’s content script; only a page refresh fixes it. */
export function showExtensionContextInvalidatedBanner() {
  if (extReloadBannerShown || document.getElementById(EXT_RELOAD_BANNER_ID)) return;
  extReloadBannerShown = true;
  const bar = document.createElement("div");
  bar.id = EXT_RELOAD_BANNER_ID;
  bar.setAttribute("role", "alert");
  bar.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "right:0",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "gap:12px",
    "flex-wrap:wrap",
    "padding:10px 14px",
    "background:#1e3a8a",
    "color:#f8fafc",
    "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
    "font-size:13px",
    "line-height:1.4",
    "box-shadow:0 4px 16px rgba(15,23,42,0.25)",
  ].join(";");
  const msg = document.createElement("span");
  msg.textContent =
    "KiCad Parts Importer was reloaded or updated. Refresh this LCSC tab to reconnect the extension.";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Refresh page";
  btn.style.cssText = [
    "cursor:pointer",
    "border:none",
    "border-radius:6px",
    "padding:6px 12px",
    "font:inherit",
    "font-weight:600",
    "background:#f8fafc",
    "color:#1e3a8a",
  ].join(";");
  btn.addEventListener("click", () => {
    window.location.reload();
  });
  bar.appendChild(msg);
  bar.appendChild(btn);
  document.body.appendChild(bar);
}

export function sendRuntimeMessage(payload, { retries = 3, delay = 250 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      chrome.runtime.sendMessage(payload, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          const message = runtimeError.message || "Runtime messaging error";
          const normalized = message.toLowerCase();
          if (normalized.includes("extension context invalidated")) {
            try {
              showExtensionContextInvalidatedBanner();
            } catch (_e) {
              /* ignore */
            }
            reject(new Error("Extension was reloaded. Refresh this page (F5), then try again."));
            return;
          }
          if (remaining > 0 && (/no sw/i.test(message) || normalized.includes("receiving end does not exist"))) {
            setTimeout(() => attempt(remaining - 1), delay);
            return;
          }
          reject(new Error(message));
          return;
        }
        resolve(response);
      });
    };
    attempt(retries);
  });
}

export function contentRpc(type, fields = {}, opts) {
  return sendRuntimeMessage({ type, ...fields }, opts);
}

/** Retry profile for {@link contentRpc} (`retries` attempts, `delayMs` between). */
export function k2cRpc(retries, delayMs) {
  return { retries, delay: delayMs };
}
