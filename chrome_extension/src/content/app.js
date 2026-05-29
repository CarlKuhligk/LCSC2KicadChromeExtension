"use strict";

import { normalizeCategoryPath } from "./categoryNormalize.js";
import {
  EASYEDA_DL_BTN_CLASS,
  TEMPLATE_DL_BTN_CLASS,
  DL_SUB_EASYEDA,
  DL_SUB_TEMPLATE,
  BTN_GROUP_ID,
  BTN_GROUP_MOUNT_CLASS,
  BUTTON_WRAPPER_ID,
  INIT_ATTR,
  PRODUCT_PROGRESS_ROW_ID,
  SVG_NS,
  PRODUCT_REGEX,
} from "./constants.js";
import {
  cssJoin,
  CS_DIALOG,
  applyDialogStyleSelect,
  cssModalPanelLight,
  dialogButtonStyle,
  CSS_MODAL_OVERLAY_STANDARD,
  lockOverlayPageScroll,
  unlockOverlayPageScroll,
  mountCsModal,
  dismissCsModalById,
} from "./dialog.js";
import { contentRpc, k2cRpc } from "./rpc.js";
import { BackendStatusMonitor } from "./backendStatusMonitor.js";
import { DatasheetPanel } from "./datasheetPanel.js";
import {
  JobStateStore,
  formatStatusColon,
  formatJobStatusMessage,
  progressBarFieldsFromJob,
} from "./jobStateStore.js";
import {
  needsValueParamFromPage,
  isConfiguredValueParamPresentOnPage,
  removeValueParamFallbackDialog,
  removeValueParamMismatchDialog,
  promiseValueParamFallback,
  promiseValueParamMismatch,
} from "./lcscValueParamDialogs.js";
import {
  removeCategoryDialog,
  showCategoryDialog,
} from "./lcscCategoryDialog.js";
import { extractPageData } from "./lcscPageSnapshot.js";
/** Datasheet panel / PDF.js pipeline — always on; filter DevTools console by `[KiCad datasheet]`. */
function k2cDatasheetLog(...args) {
  console.info("[KiCad datasheet]", ...args);
}

/** Singleton — owns the PDF.js viewer iframe lifecycle, cancellation token, blob-URL bookkeeping. */
const datasheetPanel = new DatasheetPanel({ log: k2cDatasheetLog });

/** Service worker reports fetch progress; template gallery matches on {@code requestId}. */
let k2cActiveDatasheetDownloadUi = null;

/**
 * Fast base64 → bytes (avoids {@code atob} + per-byte {@code charCodeAt}, which is very slow on multi‑MB PDFs).
 * @param {string} b64
 * @returns {Promise<Uint8Array>}
 */
async function k2cBase64ToUint8Array(b64) {
  const url = `data:application/octet-stream;base64,${b64}`;
  const ab = await (await fetch(url)).arrayBuffer();
  return new Uint8Array(ab);
}

const COLORS = {
  primary: "#1166dd",
  success: "#15803d",
  error: "#b91c1c",
  warning: "#d97706",
  spinner: "#1166dd",
};

/** LCSC product-page primary button (solid blue, flat, Vuetify-style). */
const LCSC_BTN = {
  blue: "#1166dd",
  radius: "4px",
  height: "42px",
  fontSize: "0.875rem",
};

/**
 * Cross-cutting job state (watchers, terminal-once, confetti-once, monotone UI).
 * Constructed early; `dbg` is forwarded via closure so debug-flag flips are picked up.
 */
const jobState = new JobStateStore({ log: (...args) => dbg(...args) });
const activeObservers = new Set();
let spinnerStyleInjected = false;
let debugEnabled = false;
/** Active product page context. TODO(PR#5): migrate into ProductButtonGroup. */
let backendOnlineMonitorLcscId = null;
let backendOnlineMonitorGroupDiv = null;
const backendStatusMonitor = new BackendStatusMonitor({
  rpc: { getState: () => contentRpc("getState", {}, k2cRpc(2, 200)) },
});
/** Debounce product-row refresh when `importDestReady` flips (e.g. user selects a library in the popup). */
let lastBroadcastImportDestReady = null;
let importDestRefreshTimer = null;
/** LCSC/Vue re-renders can drop our product-row; debounce re-attach checks from MutationObserver. */
let productAttachDebounceTimer = null;
function startBackendOnlineMonitor() {
  if (!backendOnlineMonitorLcscId || !backendOnlineMonitorGroupDiv) return;
  if (backendStatusMonitor.running) return;
  backendStatusMonitor.start({
    onTick: () => {
      if (backendOnlineMonitorLcscId && backendOnlineMonitorGroupDiv) {
        refreshButtonGroup(backendOnlineMonitorLcscId, backendOnlineMonitorGroupDiv);
      }
    },
    isStable: (state) => {
      const templateSymbolsByLib = state.templateSymbolsByLib || {};
      const shouldHaveTemplates =
        Object.keys(templateSymbolsByLib).length > 0 &&
        Object.values(templateSymbolsByLib).some((arr) => Array.isArray(arr) && arr.length > 0);
      if (!shouldHaveTemplates) return true;
      const groupDiv = backendOnlineMonitorGroupDiv;
      if (!groupDiv) return true;
      return queryProductGroupButtons(groupDiv).some(
        (b) => b.getAttribute("data-k2c-dl") === "template",
      );
    },
  });
}

const ICONS = {
  download: "M5 20h14v-2H5v2zm7-18v12h4l-5 5-5-5h4V2h2z",
  check: "M9 16.17 5.53 12.7 4.47 13.76 9 18.29 20 7.29 18.93 6.23 9 16.17z",
  spinner: "M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1 -8 -8V2z",
};

/**
 * Styles for product-page download buttons live inside Shadow DOM so LCSC/Vue/Dark Reader
 * cannot override fonts, colors, or flex layout (guaranteed isolation).
 */
function getProductBtnShadowStylesheet() {
  return `
    :host {
      display: inline-block;
      vertical-align: middle;
      position: relative;
      /* Do not inherit LCSC/table font-size:0 or other hacks from the light DOM */
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: normal;
      color: #fff;
    }
    .${BTN_GROUP_MOUNT_CLASS} {
      display: inline-flex;
      gap: 5px;
      align-items: center;
      flex-wrap: nowrap;
      position: relative;
      box-sizing: border-box;
      font-size: 14px;
      line-height: normal;
    }
    @keyframes easyeda2kicad-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .easyeda2kicad-spin-icon { animation: easyeda2kicad-spin 0.9s linear infinite; transform-origin: center; }

    .easyeda2kicad-dl-btn {
      /* Dark Reader / page extensions sometimes strip display:flex from inline style on one button only —
         without inline-flex, flex-direction is ignored and text stacks wrong beside the icon. */
      display: inline-flex !important;
      flex-direction: row !important;
      align-items: stretch !important;
      justify-content: flex-start !important;
      flex-wrap: nowrap !important;
      width: 128px;
      height: 42px;
      box-sizing: border-box;
      margin: 0;
      padding: 0 !important;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 0.875rem;
      font-weight: 500;
      line-height: 1.2;
      letter-spacing: 0;
      -webkit-appearance: none;
      appearance: none;
      border-style: solid;
      border-width: 1px;
      border-color: transparent;
      border-radius: 4px;
      box-shadow: none !important;
      transition-duration: 0.28s;
      transition-property: box-shadow, transform, opacity;
      transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
      /* Inline style used overflow:hidden; that clipped the second label line ("Template" / "EasyEDA") */
      overflow: visible !important;
    }
    .easyeda2kicad-dl-btn .dl-icon-wrap {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex-shrink: 0;
      width: 25px;
      align-self: stretch;
      height: 100%;
      box-sizing: border-box;
      border-right: 1px solid rgba(255,255,255,0.2);
      padding-right: 2px;
    }
    .easyeda2kicad-dl-btn[data-lib-state="no-library"] .dl-icon-wrap {
      opacity: 0.92;
    }

    .easyeda2kicad-dl-btn[data-lib-state="offline"] .dl-icon-wrap {
      border-right-color: rgba(255,255,255,0.28);
    }
    .easyeda2kicad-dl-btn .dl-text-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1 1 0;
      min-width: 0;
      overflow: visible;
      padding: 2px 4px 2px 3px;
      gap: 0;
      text-align: center;
      box-sizing: border-box;
      align-self: stretch;
    }
    /* One visual spec for both buttons (Template + EasyEDA); !important vs Dark Reader mutating one SVG */
    .easyeda2kicad-dl-btn .dl-icon-wrap svg.easyeda2kicad-icon {
      display: block !important;
      width: 17.5px !important;
      height: 17.5px !important;
      flex-shrink: 0;
      box-sizing: border-box;
      vertical-align: middle;
    }
    .easyeda2kicad-dl-btn .dl-icon-wrap path.easyeda2kicad-icon-path {
      fill: currentColor !important;
      opacity: 1 !important;
    }
    .easyeda2kicad-dl-btn .dl-main {
      font-size: 0.8125rem;
      font-weight: 500;
      line-height: 1.15;
      color: currentColor;
      flex-shrink: 0;
      white-space: nowrap;
      max-width: 100%;
    }
    .easyeda2kicad-dl-btn .dl-sub {
      display: block;
      font-size: 0.75rem;
      font-weight: 500;
      opacity: 0.92;
      line-height: 1.15;
      margin: 0;
      padding-top: 1px;
      text-align: center;
      white-space: nowrap;
      color: currentColor;
      flex-shrink: 0;
      max-width: 100%;
    }
    .easyeda2kicad-dl-btn:disabled {
      opacity: 1 !important;
      cursor: default !important;
      transform: none !important;
      filter: none !important;
    }
    .easyeda2kicad-confetti-wrap {
      position: absolute;
      inset: 0;
      pointer-events: none;
      overflow: visible;
      border-radius: 8px;
      z-index: 5;
    }
    .easyeda2kicad-confetti-wrap .confetti-piece {
      position: absolute;
      top: -12px;
      will-change: transform, opacity;
      animation: easyeda2kicad-confetti-fall var(--dur, 3.9s) cubic-bezier(0.18, 0.55, 0.38, 1) forwards;
      animation-delay: var(--delay, 0s);
      box-shadow: 0 0 1px rgba(255, 255, 255, 0.45);
    }
    @keyframes easyeda2kicad-confetti-fall {
      0% {
        transform: translate3d(0, -6px, 0) rotate(0deg) scale(1);
        opacity: 0;
      }
      6% {
        opacity: 1;
      }
      100% {
        transform: translate3d(var(--drift, 0px), var(--fall, 140px), 0) rotate(var(--spin, 720deg)) scale(0.35);
        opacity: 0;
      }
    }
  `;
}

function getBtnGroupMount(host) {
  if (!host || !host.shadowRoot) return null;
  return host.shadowRoot.querySelector(`.${BTN_GROUP_MOUNT_CLASS}`);
}

function ensureProductBtnGroupShadow(host) {
  if (!host) return null;
  if (host.shadowRoot) {
    return getBtnGroupMount(host);
  }
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = getProductBtnShadowStylesheet();
  const mount = document.createElement("div");
  mount.className = BTN_GROUP_MOUNT_CLASS;
  shadow.appendChild(style);
  shadow.appendChild(mount);
  return mount;
}

/** ShadowRoot children are not light-DOM descendants; use this instead of host.contains(node). */
function btnGroupHostContains(host, node) {
  if (!host || !node) return false;
  const sr = host.shadowRoot;
  if (sr && sr.contains(node)) return true;
  return host.contains(node);
}

function queryProductGroupButtons(host) {
  const mount = getBtnGroupMount(host);
  if (!mount) return [];
  return Array.from(mount.querySelectorAll("button"));
}

function ensureSpinnerStyle() {
  if (spinnerStyleInjected) {
    return;
  }
  const style = document.createElement("style");
  style.textContent = `
    @keyframes easyeda2kicad-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .easyeda2kicad-spin-icon { animation: easyeda2kicad-spin 0.9s linear infinite; transform-origin: center; }

    #${BUTTON_WRAPPER_ID} {
      display: inline-flex;
      flex-direction: column;
      align-items: stretch;
      gap: 0;
    }

    /* Product-page controls are rendered inside #${BTN_GROUP_ID}'s ShadowRoot (see ensureProductBtnGroupShadow). */
    #${BTN_GROUP_ID} {
      display: inline-block;
      vertical-align: middle;
      contain: layout style;
    }

    /* Progress + status sit in the LCSC table (usually light background). Default palette = light theme. */
    #easyeda2kicad-progress-track {
      width: 100%;
      height: 5px;
      background: rgba(15, 23, 42, 0.1);
      border-radius: 0 0 5px 5px;
      overflow: hidden;
      transition: opacity 0.3s ease;
      box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.07);
    }

    #easyeda2kicad-progress-bar {
      height: 100%;
      width: 0%;
      border-radius: 4px;
      background: linear-gradient(90deg, #38bdf8, #2563eb);
      transition: width 0.35s ease, background 0.3s ease;
      box-shadow: 0 0 8px rgba(37, 99, 235, 0.45);
    }

    #easyeda2kicad-progress-bar.indeterminate {
      width: 40%;
      animation: easyeda2kicad-indeterminate 1.4s ease-in-out infinite;
    }

    @keyframes easyeda2kicad-indeterminate {
      0%   { transform: translateX(-120%); }
      100% { transform: translateX(350%); }
    }

    #easyeda2kicad-progress-bar.success {
      background: #22c55e;
      width: 100%;
    }

    #easyeda2kicad-progress-bar.error {
      background: #ef4444;
      width: 100%;
    }

    #easyeda2kicad-progress-bar.easyeda2kicad-pin-mismatch {
      background: #d97706;
      width: 100%;
    }

    #easyeda2kicad-progress-bar.status-offline {
      background: linear-gradient(90deg, #ea580c, #dc2626);
      width: 100%;
    }

    #easyeda2kicad-progress-bar.status-no-library {
      background: linear-gradient(90deg, #ca8a04, #d97706);
      width: 100%;
    }

    /* !important: LCSC/Vue may set parent color to #fff; status line must stay dark/neutral (never white). */
    #easyeda2kicad-status-text.status-offline {
      color: #c2410c !important;
    }

    #easyeda2kicad-status-text.status-no-library {
      color: #9a3412 !important;
      text-align: left !important;
    }

    #easyeda2kicad-status-text.k2c-status-pre {
      white-space: pre-wrap;
      text-align: left;
      font-weight: 500;
      line-height: 1.45;
      max-width: 100%;
    }

    /* Light table: force readable slate text (LCSC/Vuetify may inherit light-on-light). */
    #easyeda2kicad-status-text {
      font-size: 11px;
      line-height: 1.3;
      margin-top: 5px;
      color: #1e293b !important;
      text-align: center;
      min-height: 0;
      transition: color 0.3s ease, opacity 0.3s ease;
      word-break: break-word;
    }

    #easyeda2kicad-status-text:empty {
      display: none;
    }

    #easyeda2kicad-status-text.status-error {
      color: #b91c1c !important;
    }

    #easyeda2kicad-status-text.status-success {
      color: #15803d !important;
    }

    #easyeda2kicad-status-text.k2c-status-progress {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.35;
      color: #0f172a !important;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.01em;
    }

    #easyeda2kicad-status-text .easyeda2kicad-copy-btn {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      margin-left: 6px;
      padding: 1px 6px;
      font-size: 10px;
      font-weight: 500;
      line-height: 1.4;
      border-radius: 4px;
      border: 1px solid #fecaca !important;
      background: #fef2f2 !important;
      color: #b91c1c !important;
      cursor: pointer;
      vertical-align: middle;
      transition: background 0.15s ease, border-color 0.15s ease;
      white-space: nowrap;
    }

    #easyeda2kicad-status-text .easyeda2kicad-copy-btn:hover {
      background: #fee2e2 !important;
      border-color: #f87171 !important;
    }

    #easyeda2kicad-status-text .easyeda2kicad-copy-btn.copied {
      border-color: #86efac !important;
      background: #f0fdf4 !important;
      color: #15803d !important;
    }

    /* Dark OS: track + high-contrast progress caption. */
    @media (prefers-color-scheme: dark) {
      #easyeda2kicad-progress-track {
        background: rgba(255,255,255,0.12);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
      }
      #easyeda2kicad-status-text {
        color: #cbd5e1 !important;
      }
      #easyeda2kicad-status-text.status-no-library {
        color: #fdba74 !important;
      }
      #easyeda2kicad-status-text.k2c-status-progress {
        color: #e2e8f0 !important;
      }
    }
  `;
  document.head.appendChild(style);
  spinnerStyleInjected = true;
}

function dbg(...args) {
  if (debugEnabled) {
    console.log("[easyeda2kicad]", ...args);
  }
}

async function initDebug() {
  try {
    const response = await contentRpc("getState", {}, k2cRpc(5, 300));
    if (response?.ok && response.data) {
      debugEnabled = Boolean(response.data.debugLogs);
      dbg("debug flag initial", debugEnabled);
    }
  } catch (_error) {
    // ignore
  }
}

function applyJobStatusToButton(button, jobId, job) {
  if (!jobState.shouldApplyUpdate(jobId, job)) {
    return false;
  }
  const { progress } = progressBarFieldsFromJob(job);
  const message = formatJobStatusMessage(job);
  const phase = String(job?.status || "").toLowerCase();
  updateButtonState(button, "progress", { progress, message, phase });
  return true;
}

function extractLcscIdFromString(str = "") {
  const match = str.match(/C\d+/i);
  return match ? match[0].toUpperCase() : null;
}

function hasModelPaths(result) {
  if (!result) {
    return false;
  }
  const modelPaths = result.model_paths;
  if (!modelPaths) {
    return false;
  }
  if (Array.isArray(modelPaths)) {
    return modelPaths.length > 0;
  }
  if (typeof modelPaths === "object") {
    return Object.values(modelPaths).some(Boolean);
  }
  return Boolean(modelPaths);
}

function coerceConversionResult(raw) {
  if (raw == null || raw === "") {
    return null;
  }
  if (typeof raw === "string") {
    try {
      return coerceConversionResult(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const o = raw;
  const mp = o.model_paths ?? o.modelPaths;
  return {
    symbol_path: o.symbol_path ?? o.symbolPath ?? null,
    footprint_path: o.footprint_path ?? o.footprintPath ?? null,
    model_paths:
      mp && typeof mp === "object" && !Array.isArray(mp) ? mp : {},
    messages: Array.isArray(o.messages) ? o.messages : [],
  };
}

function computeOutputAnalysis(job = {}) {
  const requested = {
    symbol: Boolean(job.outputs && job.outputs.symbol),
    footprint: Boolean(job.outputs && job.outputs.footprint),
    model: Boolean(job.outputs && job.outputs.model),
  };
  const raw =
    job.result != null && job.result !== ""
      ? job.result
      : job.Result != null && job.Result !== ""
        ? job.Result
        : null;
  const result = coerceConversionResult(raw) || {};
  const actual = {
    symbol: Boolean(result.symbol_path),
    footprint: Boolean(result.footprint_path),
    model: hasModelPaths(result),
  };
  const requestedAny = Object.values(requested).some(Boolean);
  const missing = [];
  if (requested.symbol && !actual.symbol) {
    missing.push("symbol");
  }
  if (requested.footprint && !actual.footprint) {
    missing.push("footprint");
  }
  if (requested.model && !actual.model) {
    missing.push("model");
  }
  return {
    requested,
    actual,
    missing,
    partial: requestedAny && missing.length > 0,
    complete: requestedAny ? missing.length === 0 : true,
  };
}

function mapMissingLabel(key) {
  switch (key) {
    case "symbol":
      return "Symbol";
    case "footprint":
      return "Footprint";
    case "model":
      return "3D model";
    default:
      return key;
  }
}

/** Detail segment for {@link formatStatusColon} (progress row / tooltips). */
function formatMissingSummary(missing = []) {
  if (!missing.length) return "incomplete";
  const labels = missing.map(mapMissingLabel);
  if (labels.length === 1) {
    return `${labels[0]} missing`;
  }
  const head = labels.slice(0, -1).join(", ");
  const tail = labels[labels.length - 1];
  return `${head} and ${tail} missing`;
}

function formatMissingTooltip(missing = []) {
  return formatStatusColon("Incomplete", formatMissingSummary(missing));
}

function buildSuccessTooltip(analysis, messages) {
  const parts = [];
  if (Array.isArray(messages) && messages.length) {
    parts.push(messages.join("; "));
  }
  if (analysis && analysis.missing && analysis.missing.length) {
    parts.push(formatMissingTooltip(analysis.missing));
  }
  return parts.length ? parts.join(" | ") : null;
}

function formatLibraryStatusMessage(libraryName, libraryPath) {
  const name = libraryName
    || (libraryPath ? libraryPath.replace(/^.*[/\\]/, "").replace(/\.(kicad_sym|lib)$/i, "") : null);
  return name ? `Already available in the library: ${name}` : "Already available in the library";
}

function formatAddedToLibraryMessage(libraryName, libraryPath) {
  const name = libraryName
    || (libraryPath ? libraryPath.replace(/^.*[/\\]/, "").replace(/\.(kicad_sym|lib)$/i, "") : null);
  return name ? `Added to the library: ${name}` : "Added to the library";
}

function formatPartialImportMessage(messages, missing) {
  const detail = Array.isArray(messages) && messages.length
    ? messages.join("; ")
    : formatMissingSummary(missing);
  return formatStatusColon("Partial import", detail);
}

/** Shared copy for backend-unreachable UI (progress row + titles). */
const MSG_BACKEND_OFFLINE = formatStatusColon("Download unavailable", "backend offline");

/** Product page: no active non-template library for EasyEDA / template output. */
const MSG_NO_IMPORT_LIB_TITLE = formatStatusColon("Download unavailable", "no library selected or available");
const MSG_NO_IMPORT_LIB_DETAIL = [
  "Add or select a working KiCad library in the extension:",
  "",
  "1. Click the KiCad Parts Importer icon in the Chrome toolbar (or the puzzle piece → find the extension, or Menu (⋮) → Extensions).",
  "2. Open the Library tab.",
  "3. Use Add to create or import a library folder, then turn on that row's switch so it is the active library (not Template-only).",
  "",
  "EasyEDA and template downloads both write into that active library.",
].join("\n");

const MSG_LIBRARY_TITLE = formatStatusColon("Already in library", "click to update");

function extractLcscId() {
  const match = window.location.pathname.match(PRODUCT_REGEX);
  if (!match) {
    return null;
  }
  return match[1].toUpperCase();
}

// extractPageData → ./lcscPageSnapshot.js

/**
 * After user cancels the category dialog, restore buttons + status (pending/spinner otherwise sticks).
 */
function resumeDownloadUiAfterCategoryAbort(button, lcscId) {
  removeCategoryDialog();
  removeValueParamFallbackDialog();
  removeValueParamMismatchDialog();
  const group = document.getElementById(BTN_GROUP_ID);
  /** Product page: always re-sync both Template + EasyEDA buttons (do not rely on btnGroupHostContains(button)). */
  if (group) {
    setGroupEnabled(true);
    void refreshButtonGroup(lcscId, group, { skipIdleReset: true });
    return;
  }
  setGroupEnabled(true);
  if (!button) return;
  button.disabled = false;
  void (async () => {
    try {
      const resp = await contentRpc("checkComponentExists", { lcscId }, k2cRpc(2, 300));
      if (resp?.ok && resp.data) {
        const d = resp.data || {};
        const analysis = d.outputAnalysis
          || computeOutputAnalysis({ outputs: d.outputs, result: d.result });
        if (d.completed && !analysis.partial) {
          updateButtonState(button, "exists", {
            message: MSG_LIBRARY_TITLE,
            libraryName: d.libraryName,
            libraryPath: d.libraryPath,
          });
          return;
        }
      }
    } catch (_e) {
      // fall through to idle
    }
    updateButtonState(button, "idle");
  })();
}

/**
 * If `shouldAbort` (user cancelled a pre-download dialog), restore UI and return `true` so the caller can `return`.
 */
function abortPreDownloadIf(button, lcscId, shouldAbort) {
  if (!shouldAbort) return false;
  resumeDownloadUiAfterCategoryAbort(button, lcscId);
  return true;
}

/**
 * Float-button mode (V3 pattern). The button group lives in a fixed-position
 * panel attached to `<body>`, decoupled from LCSC's product-page DOM. LCSC
 * can repaint, rearrange, or rename its tables — the button stays put.
 *
 * Style: bottom-right corner, modest shadow, high z-index so LCSC's own
 * floating widgets don't cover us. The Shadow DOM (see ensureProductBtnGroupShadow)
 * still isolates our internal styles from LCSC's Tailwind utility classes.
 */
function buildFloatHostStyle() {
  return [
    "position:fixed",
    "right:24px",
    "bottom:24px",
    "z-index:2147483646",
    "background:#ffffff",
    "border:1px solid rgba(0,0,0,0.08)",
    "border-radius:10px",
    "box-shadow:0 8px 28px rgba(0,0,0,0.18),0 2px 8px rgba(0,0,0,0.10)",
    "padding:10px 12px",
    "min-width:240px",
    "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
  ].join(";");
}

function setIcon(button, color, type = "download") {
  const path = button.querySelector(".easyeda2kicad-icon-path");
  if (!path) return;
  const iconPath = ICONS[type] || ICONS.download;
  path.setAttribute("d", iconPath);
  // Always rely on the button's `color` via `currentColor` for consistent rendering.
  // This removes any dependency on whether the button has an ID (primary) or not (template).
  path.setAttribute("fill", "currentColor");
  path.setAttribute("opacity", "1");
  button.dataset.iconType = type;
}

function setBtnLabel(button, text) {
  const label = button.querySelector(".dl-main");
  if (label) label.textContent = text;
}

function setGroupEnabled(enabled) {
  const group = document.getElementById(BTN_GROUP_ID);
  if (!group) return;
  queryProductGroupButtons(group).forEach((btn) => {
    btn.disabled = !enabled;
    if (!enabled) {
      btn.style.opacity = "0.5";
      btn.style.cursor = "default";
    } else {
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    }
  });
}

/**
 * After one download button is set to "exists", mirror that state onto the other button(s) in the group.
 * Uses `data-k2c-dl` (easyeda | template) instead of object identity — reference checks were unreliable in Shadow DOM.
 */
function markGroupExists(updatedButton, tooltip) {
  const group = document.getElementById(BTN_GROUP_ID);
  if (!group) return;
  const msg = tooltip || MSG_LIBRARY_TITLE;
  const skipRole = updatedButton?.getAttribute?.("data-k2c-dl") || "easyeda";
  queryProductGroupButtons(group).forEach((b) => {
    if (b.getAttribute("data-k2c-dl") === skipRole) return;
    setSpin(b, false);
    setIcon(b, "#d1fae5", "download");
    setBtnLabel(b, "Download");
    setBtnTheme(b, "exists");
    b.dataset.libState = "exists";
    b.disabled = false;
    b.style.opacity = "1";
    b.style.cursor = "pointer";
    b.setAttribute("title", msg);
  });
}

function setBtnTheme(button, theme) {
  const b = LCSC_BTN.blue;
  const themes = {
    primary: {
      background: b,
      border: `1px solid ${b}`,
      boxShadow: "none",
      color: "#fff",
      opacity: "1",
    },
    success: {
      background: "#16a34a",
      border: "1px solid #16a34a",
      boxShadow: "none",
      color: "#fff",
      opacity: "1",
    },
    warning: {
      background: "#ed6c02",
      border: "1px solid #ed6c02",
      boxShadow: "none",
      color: "#fff",
      opacity: "1",
    },
    error: {
      background: "#d32f2f",
      border: "1px solid #d32f2f",
      boxShadow: "none",
      color: "#fff",
      opacity: "1",
    },
    disabled: {
      background: "#90a4ae",
      border: "1px solid #90a4ae",
      boxShadow: "none",
      color: "rgba(255,255,255,0.92)",
      opacity: "0.95",
    },
    exists: {
      background: "#048061",
      border: "1px solid #048061",
      boxShadow: "none",
      color: "#fff",
      opacity: "1",
    },
    offline: {
      background: "#757575",
      border: "1px solid #616161",
      boxShadow: "none",
      color: "#fff",
      opacity: "1",
    },
  };
  const resolvedKey = themes[theme] ? theme : "primary";
  const t = themes[theme] || themes.primary;
  Object.assign(button.style, t);
  button.dataset.easyeda2kicadBtnTheme = resolvedKey;
}

/** Hover shadow matching current theme (mouseleave restores via setBtnTheme). */
function setDlButtonHoverShadow(button) {
  const theme = button.dataset.easyeda2kicadBtnTheme || "primary";
  /* LCSC buttons use flat style (box-shadow: none); keep hover shadow minimal / none */
  const hover = {
    primary: "none",
    success: "none",
    warning: "none",
    error: "none",
    disabled: "none",
    exists: "none",
    offline: "none",
  };
  button.style.boxShadow = hover[theme] || "none";
}

function setGroupBackendOffline() {
  const group = document.getElementById(BTN_GROUP_ID);
  if (!group) return;
  const offlineMessage = MSG_BACKEND_OFFLINE;
  queryProductGroupButtons(group).forEach((b) => {
    b.disabled = true;
    setSpin(b, false);
    // Use currentColor so the icon color stays consistent with the button text color.
    setIcon(b, "currentColor", "download");
    setBtnLabel(b, "Download");
    setBtnTheme(b, "offline");
    b.dataset.libState = "offline";
    b.style.cursor = "not-allowed";
    b.setAttribute("title", offlineMessage);
    // Force icon consistency even if SVG fill was modified earlier.
    b.querySelectorAll(".easyeda2kicad-icon-path").forEach((p) => {
      p.setAttribute("fill", "currentColor");
      p.setAttribute("opacity", "1");
    });
  });
  setProgressUI({
    visible: true,
    barClass: "status-offline",
    widthPct: 100,
    message: offlineMessage,
    messageClass: "status-offline",
  });

  // Automatically recover once backend is back online.
  startBackendOnlineMonitor();
}

function setGroupNoImportLibrary() {
  const group = document.getElementById(BTN_GROUP_ID);
  if (!group) return;
  queryProductGroupButtons(group).forEach((b) => {
    b.disabled = true;
    setSpin(b, false);
    setIcon(b, "currentColor", "download");
    setBtnLabel(b, "Download");
    setBtnTheme(b, "warning");
    b.dataset.libState = "no-library";
    b.style.cursor = "not-allowed";
    b.setAttribute("title", MSG_NO_IMPORT_LIB_TITLE);
    b.querySelectorAll(".easyeda2kicad-icon-path").forEach((p) => {
      p.setAttribute("fill", "currentColor");
      p.setAttribute("opacity", "1");
    });
  });
  setProgressUI({
    visible: true,
    barClass: "status-no-library",
    widthPct: 100,
    message: `${MSG_NO_IMPORT_LIB_TITLE}\n\n${MSG_NO_IMPORT_LIB_DETAIL}`,
    messageClass: "status-no-library",
    preformatted: true,
  });
}

function showBackendOfflineUIForButton(button, options = {}) {
  const offlineMessage = options.message || MSG_BACKEND_OFFLINE;
  const group = document.getElementById(BTN_GROUP_ID);
  if (group && button && btnGroupHostContains(group, button)) {
    setGroupBackendOffline();
    // Ensure the exact message is visible even if setGroupBackendOffline uses defaults.
    setProgressUI({
      visible: true,
      barClass: "status-offline",
      widthPct: 100,
      message: offlineMessage,
      messageClass: "status-offline",
    });
    return;
  }
  if (button) {
    updateButtonState(button, "offline", { message: offlineMessage });
  }
}

function setButtonDisabledPlaceholder(button, title = formatStatusColon("Download", "pending")) {
  if (!button) return;
  button.disabled = true;
  setSpin(button, false);
  // For primary buttons icon-path exists; for secondary buttons this becomes a no-op.
  setIcon(button, COLORS.primary, "download");
  setBtnTheme(button, "disabled");
  setBtnLabel(button, "Download");
  button.style.cursor = "default";
  button.setAttribute("title", title);
  setProgressUI({ visible: false });

  // Ensure icon is consistent (disabled/template share the same look).
  button.querySelectorAll(".easyeda2kicad-icon-path").forEach((p) => {
    p.setAttribute("fill", "currentColor");
    p.setAttribute("opacity", "1");
  });
}

function triggerConfetti(host) {
  if (!host) return;
  const mount = getBtnGroupMount(host);
  const appendTo = mount || host;
  const wrap = document.createElement("div");
  wrap.className = "easyeda2kicad-confetti-wrap";
  const rect = host.getBoundingClientRect();
  const fallDistance = Math.max(rect.height + 56, 130);
  /** Harmonized with success UI: greens + gold + cool accents */
  const colors = [
    "#22c55e", "#4ade80", "#16a34a", "#86efac",
    "#fbbf24", "#fcd34d", "#f59e0b",
    "#38bdf8", "#7dd3fc",
    "#a78bfa", "#c4b5fd",
    "#f472b6", "#fb7185",
  ];
  const count = 72;
  const rand = (a, b) => a + Math.random() * (b - a);
  for (let i = 0; i < count; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    const t = i / count;
    /** Fan from center-heavy to edges for a subtle “burst” */
    const spread = (t - 0.5) * 1.15 + (Math.random() - 0.5) * 0.4;
    const leftPct = 50 + spread * 42 + (Math.random() - 0.5) * 18;
    piece.style.left = `${Math.max(2, Math.min(98, leftPct))}%`;
    const shapeRoll = Math.random();
    let w;
    let h;
    let br;
    if (shapeRoll < 0.38) {
      w = rand(4, 7);
      h = w;
      br = "50%";
    } else if (shapeRoll < 0.72) {
      w = rand(5, 9);
      h = rand(3, 6);
      br = "1px";
    } else {
      w = rand(2.5, 4);
      h = rand(9, 14);
      br = "2px";
    }
    piece.style.width = `${w}px`;
    piece.style.height = `${h}px`;
    piece.style.borderRadius = br;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    const drift = rand(-52, 52);
    const spin = rand(-1080, 1080);
    piece.style.setProperty("--fall", `${fallDistance + rand(-12, 24)}px`);
    piece.style.setProperty("--drift", `${drift}px`);
    piece.style.setProperty("--spin", `${spin}deg`);
    piece.style.setProperty("--delay", `${rand(0, 0.65)}s`);
    piece.style.setProperty("--dur", `${rand(3.2, 4.35)}s`);
    wrap.appendChild(piece);
  }
  appendTo.appendChild(wrap);
  setTimeout(() => {
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
  }, 5600);
}

function setSpin(button, enable) {
  const svg = button.querySelector(".easyeda2kicad-icon");
  if (!svg) return;
  if (enable) {
    ensureSpinnerStyle();
    svg.classList.add("easyeda2kicad-spin-icon");
  } else {
    svg.classList.remove("easyeda2kicad-spin-icon");
  }
}


function updateButtonState(button, state, options = {}) {
  switch (state) {
    case "idle":
      button.disabled = false;
      setSpin(button, false);
      setIcon(button, COLORS.primary, "download");
      setBtnLabel(button, "Download");
      setBtnTheme(button, "primary");
      button.dataset.libState = "";
      button.style.cursor = "pointer";
      button.setAttribute("title", "Download KiCad files");
      setProgressUI({ visible: false });
      setGroupEnabled(true);
      break;
    case "exists": {
      const statusMessage = formatLibraryStatusMessage(options.libraryName, options.libraryPath);
      button.disabled = false;
      setSpin(button, false);
      setIcon(button, "#d1fae5", "download");
      setBtnLabel(button, "Download");
      setBtnTheme(button, "exists");
      button.dataset.libState = "exists";
      button.style.cursor = "pointer";
      button.setAttribute("title", options.message || MSG_LIBRARY_TITLE);
      setProgressUI({
        visible: true,
        barClass: "success",
        widthPct: 100,
        message: statusMessage,
        messageClass: "status-success",
      });
      setGroupEnabled(true);
      break;
    }
    case "pending":
      setGroupEnabled(false);
      button.disabled = true;
      setSpin(button, true);
      setIcon(button, COLORS.spinner, "spinner");
      setBtnLabel(button, "Starting…");
      setBtnTheme(button, "disabled");
      button.style.cursor = "default";
      {
        const pendingLine = options.message || formatStatusColon("Conversion", "submitting job");
        button.setAttribute("title", pendingLine);
        setProgressUI({
          visible: true,
          barClass: "indeterminate",
          widthPct: null,
          message: pendingLine,
          messageClass: "k2c-status-progress",
        });
      }
      break;
    case "progress": {
      setGroupEnabled(false);
      const phase = String(options.phase || "").toLowerCase();
      const pctRaw = Number(options.progress);
      const pct = Number.isFinite(pctRaw) ? Math.max(0, Math.min(100, pctRaw)) : 0;
      button.disabled = true;
      setSpin(button, true);
      setIcon(button, COLORS.spinner, "spinner");
      const btnShort = phase === "queued"
        ? "Queue"
        : `${Math.round(pct)}%`;
      setBtnLabel(button, btnShort);
      setBtnTheme(button, "disabled");
      button.style.cursor = "default";
      const progressLine = options.message
        || (phase === "queued"
          ? formatStatusColon("In queue", "waiting")
          : formatStatusColon("Converting", `${Math.round(pct)}%`));
      button.setAttribute("title", options.message || progressLine);
      const indeterminate = phase === "queued" || pct <= 0;
      setProgressUI({
        visible: true,
        barClass: indeterminate ? "indeterminate" : "",
        widthPct: !indeterminate ? pct : null,
        message: progressLine,
        messageClass: "k2c-status-progress",
      });
      break;
    }
    case "success": {
      if (options.libraryName != null) button.dataset.libraryName = String(options.libraryName);
      if (options.libraryPath != null) button.dataset.libraryPath = String(options.libraryPath);
      button.disabled = false;
      setSpin(button, false);
      setIcon(button, COLORS.success, "check");
      setBtnLabel(button, "Done");
      setBtnTheme(button, "success");
      button.style.cursor = "pointer";
      button.setAttribute("title", options.message || formatStatusColon("Library", "import complete"));
      setProgressUI({
        visible: true,
        barClass: "success",
        widthPct: 100,
        message: formatAddedToLibraryMessage(options.libraryName, options.libraryPath),
        messageClass: "status-success",
      });
      setGroupEnabled(true);
      const group = document.getElementById(BTN_GROUP_ID);
      const celebrate = options.celebrate !== false;
      const cjid = options.celebrateJobId;
      let doConfetti = celebrate && cjid && group && btnGroupHostContains(group, button);
      if (doConfetti && jobState.hadConfetti(cjid)) {
        doConfetti = false;
      }
      if (doConfetti && cjid) {
        jobState.markConfetti(cjid);
        setTimeout(() => jobState.forgetConfetti(cjid), 180000);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => triggerConfetti(group));
        });
      }
      const libName = options.libraryName ?? button.dataset.libraryName ?? null;
      const libPath = options.libraryPath ?? button.dataset.libraryPath ?? null;
      setTimeout(() => {
        updateButtonState(button, "exists", {
          message: MSG_LIBRARY_TITLE,
          libraryName: libName || undefined,
          libraryPath: libPath || undefined,
        });
        markGroupExists(button, MSG_LIBRARY_TITLE);
      }, 4000);
      break;
    }
    case "partial":
      button.disabled = false;
      setSpin(button, false);
      setIcon(button, COLORS.warning, options.iconType || "download");
      setBtnLabel(button, "Partial");
      setBtnTheme(button, "warning");
      button.style.cursor = "pointer";
      {
        const partialLine = options.message || formatStatusColon("Partial import", "incomplete");
        button.setAttribute("title", partialLine);
        setProgressUI({
          visible: true,
          barClass: "success",
          widthPct: 100,
          message: partialLine,
          messageClass: "status-success",
        });
      }
      setGroupEnabled(true);
      setTimeout(() => {
        setBtnLabel(button, "Download");
        setBtnTheme(button, "primary");
        setIcon(button, COLORS.primary, "download");
        setProgressUI({ visible: false });
        setGroupEnabled(true);
      }, 6000);
      break;
    case "offline": {
      const offlineMsg = options.message || MSG_BACKEND_OFFLINE;
      button.disabled = true;
      setSpin(button, false);
      setIcon(button, "currentColor", "download");
      setBtnLabel(button, "Download");
      setBtnTheme(button, "offline");
      button.dataset.libState = "offline";
      button.style.cursor = "not-allowed";
      button.setAttribute("title", offlineMsg);
      setProgressUI({
        visible: true,
        barClass: "status-offline",
        widthPct: 100,
        message: offlineMsg,
        messageClass: "status-offline",
      });
      setGroupEnabled(false);
      // Force icon consistency even if SVG fill was modified earlier.
      button.querySelectorAll(".easyeda2kicad-icon-path").forEach((p) => {
        p.setAttribute("fill", "currentColor");
        p.setAttribute("opacity", "1");
      });
      break;
    }
    case "error":
      button.disabled = false;
      setSpin(button, false);
      setIcon(button, COLORS.error, "download");
      setBtnLabel(button, "Retry");
      setBtnTheme(button, "error");
      button.style.cursor = "pointer";
      {
        const errLine = options.message || formatStatusColon("Download", "failed");
        button.setAttribute("title", errLine);
        setProgressUI({
          visible: true,
          barClass: "error",
          widthPct: 100,
          message: errLine,
          messageClass: "status-error",
          copyText: options.copyText || options.message || null,
        });
      }
      setGroupEnabled(true);
      break;
    default:
      break;
  }
}

function applyComponentState(button, data) {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const analysis = data.outputAnalysis
    || computeOutputAnalysis({ outputs: data.outputs, result: data.result });

  if (data.completed) {
    if (analysis.partial) {
      updateButtonState(button, "partial", {
        message: formatPartialImportMessage(messages, analysis.missing),
        iconType: "download",
      });
    } else {
      const tooltip = buildSuccessTooltip(analysis, messages);
      updateButtonState(button, "exists", {
        message: tooltip || MSG_LIBRARY_TITLE,
        libraryName: data.libraryName,
        libraryPath: data.libraryPath,
      });
      markGroupExists(button);
    }
    button.dataset[INIT_ATTR] = "true";
    return;
  }

  if (data.inProgress && data.jobId) {
    button.dataset.k2cWatchJobId = data.jobId;
    applyJobStatusToButton(button, data.jobId, {
      status: data.status,
      progress: data.progress,
      message: data.message,
      queue_position: data.queue_position,
    });
    startJobWatcher(button, data.jobId);
    button.dataset[INIT_ATTR] = "true";
    return;
  }

  updateButtonState(button, "idle");
  button.dataset[INIT_ATTR] = "true";
}

/**
 * Progress section lives inside the float panel (sibling of the Shadow-DOM mount).
 * No LCSC table dependency; LCSC repaints leave it untouched.
 */
function ensureProductProgressRow() {
  if (document.getElementById(PRODUCT_PROGRESS_ROW_ID)) {
    return;
  }
  const group = document.getElementById(BTN_GROUP_ID);
  if (!group) return;

  const progressRow = document.createElement("div");
  progressRow.id = PRODUCT_PROGRESS_ROW_ID;
  progressRow.style.display = "none";
  progressRow.style.cssText += [
    "display:none",
    "margin-top:8px",
    "padding-top:8px",
    "border-top:1px solid rgba(0,0,0,0.08)",
  ].join(";");

  const track = document.createElement("div");
  track.id = "easyeda2kicad-progress-track";

  const bar = document.createElement("div");
  bar.id = "easyeda2kicad-progress-bar";
  track.appendChild(bar);

  const statusText = document.createElement("div");
  statusText.id = "easyeda2kicad-status-text";

  progressRow.appendChild(track);
  progressRow.appendChild(statusText);
  group.appendChild(progressRow);
}

function getProgressElements() {
  return {
    track: document.getElementById("easyeda2kicad-progress-track"),
    bar: document.getElementById("easyeda2kicad-progress-bar"),
    text: document.getElementById("easyeda2kicad-status-text"),
    row: document.getElementById(PRODUCT_PROGRESS_ROW_ID),
  };
}

function setProgressUI({
  visible = true,
  barClass = "",
  widthPct = null,
  message = "",
  messageClass = "",
  copyText = null,
  preformatted = false,
} = {}) {
  if (visible) {
    ensureProductProgressRow();
  }
  const { track, bar, text, row } = getProgressElements();
  if (!row) return;

  row.style.display = visible ? "" : "none";

  if (bar) {
    bar.className = barClass;
    if (widthPct !== null && !barClass.includes("indeterminate")) {
      bar.style.width = `${Math.min(100, Math.max(0, widthPct))}%`;
    } else {
      bar.style.width = "";
    }
  }

  if (text) {
    const preClass = preformatted ? " k2c-status-pre" : "";
    text.className = `easyeda2kicad-status-text${messageClass ? ` ${messageClass}` : ""}${preClass}`;
    text.textContent = message;

    if (copyText && messageClass === "status-error") {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "easyeda2kicad-copy-btn";
      copyBtn.title = "Copy error details";
      copyBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
      </svg>Copy`;
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(copyText).then(() => {
          copyBtn.textContent = "Copied!";
          copyBtn.classList.add("copied");
          setTimeout(() => {
            copyBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
            </svg>Copy`;
            copyBtn.classList.remove("copied");
          }, 2000);
        }).catch(() => {
          copyBtn.textContent = "Failed";
        });
      });
      text.appendChild(copyBtn);
    }
  }
}

/** Identical download glyph for both product buttons (shared DOM + shadow CSS). */
function createDlButtonIconWrap() {
  const iconWrap = document.createElement("div");
  iconWrap.className = "dl-icon-wrap";

  const iconSvg = document.createElementNS(SVG_NS, "svg");
  iconSvg.setAttribute("viewBox", "0 0 24 24");
  iconSvg.setAttribute("aria-hidden", "true");
  iconSvg.setAttribute("focusable", "false");
  iconSvg.classList.add("easyeda2kicad-icon");

  const iconPath = document.createElementNS(SVG_NS, "path");
  iconPath.setAttribute("d", ICONS.download);
  iconPath.setAttribute("fill", "currentColor");
  iconPath.setAttribute("opacity", "1");
  iconPath.classList.add("easyeda2kicad-icon-path");
  iconSvg.appendChild(iconPath);

  iconWrap.appendChild(iconSvg);
  return iconWrap;
}

function createDlButton(subLabel, { primary = false } = {}) {
  ensureSpinnerStyle();
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("easyeda2kicad-dl-btn");
  if (primary) button.classList.add(EASYEDA_DL_BTN_CLASS);
  else button.classList.add(TEMPLATE_DL_BTN_CLASS);
  button.setAttribute("data-k2c-dl", primary ? "easyeda" : "template");

  Object.assign(button.style, {
    display: "inline-flex",
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "flex-start",
    padding: "0",
    minWidth: "128px",
    minHeight: LCSC_BTN.height,
    borderRadius: LCSC_BTN.radius,
    border: `1px solid ${LCSC_BTN.blue}`,
    background: LCSC_BTN.blue,
    color: "#fff",
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontSize: LCSC_BTN.fontSize,
    fontWeight: "500",
    letterSpacing: "0",
    cursor: "pointer",
    transition: "box-shadow 0.28s cubic-bezier(0.4, 0, 0.2, 1), transform 0.28s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.28s cubic-bezier(0.4, 0, 0.2, 1), filter 0.18s ease",
    boxShadow: "none",
    userSelect: "none",
    position: "relative",
    overflow: "visible",
    outline: "0",
  });
  button.dataset.easyeda2kicadBtnTheme = "primary";

  const iconWrap = createDlButtonIconWrap();

  const textWrap = document.createElement("div");
  textWrap.className = "dl-text-wrap";

  const mainTextSpan = document.createElement("span");
  mainTextSpan.className = "dl-main";
  mainTextSpan.textContent = "Download";

  const subSpan = document.createElement("span");
  subSpan.className = "dl-sub";
  subSpan.textContent = subLabel;

  textWrap.appendChild(mainTextSpan);
  textWrap.appendChild(subSpan);

  button.appendChild(iconWrap);
  button.appendChild(textWrap);

  button.addEventListener("mouseenter", () => {
    if (!button.disabled) {
      button.style.filter = "brightness(1.12)";
      setDlButtonHoverShadow(button);
    }
  });
  button.addEventListener("mouseleave", () => {
    button.style.filter = "";
    const theme = button.dataset.easyeda2kicadBtnTheme || "primary";
    setBtnTheme(button, theme);
  });

  return button;
}

function buildDlOptions(hasTemplates) {
  const options = [];
  // Requirement: Template button on the left, EasyEDA on the right.
  if (hasTemplates) {
    options.push({ subLabel: DL_SUB_TEMPLATE, useTemplate: true, opensDropdown: true });
  }
  options.push({ subLabel: DL_SUB_EASYEDA, useTemplate: false, opensDropdown: false });
  return options;
}

/**
 * @param {string} lcscId
 * @param {HTMLElement} groupDiv
 * @param {{ skipIdleReset?: boolean }} [options]
 *   If `skipIdleReset` is true (e.g. after canceling "New category"), do not set both buttons to
 *   idle/blue before `checkComponentExists` — avoids flashing away the correct "exists" green.
 */
// --- Product-page button group (shadow DOM, exists/progress UI) ---
async function refreshButtonGroup(lcscId, groupDiv, options = {}) {
  const skipIdleReset = Boolean(options.skipIdleReset);
  const mount = ensureProductBtnGroupShadow(groupDiv);
  if (!mount) return;

  const getTemplateBtn = () => mount.querySelector('button[data-k2c-dl="template"]');

  try {
    const stateResp = await contentRpc("getState", {}, k2cRpc(2, 200));
    const state = stateResp?.ok ? (stateResp.data || {}) : {};
    // Must treat ok:false or connected !== true as offline (previously only `connected === false` missed unreachable backend).
    const backendOnline = stateResp?.ok === true && state.connected === true;

    const templateSymbolsByLib = state.templateSymbolsByLib || {};
    const hasCachedTemplates = Object.keys(templateSymbolsByLib).length > 0
      && Object.values(templateSymbolsByLib).some((arr) => Array.isArray(arr) && arr.length > 0);

    // Keep the Template button visible whenever template libraries exist in the extension settings.
    const hasTemplateLibraries = Array.isArray(state.libraries)
      && state.libraries.some((l) => Boolean(l && l.isTemplateLibrary));

    const wantTemplate = hasTemplateLibraries || hasCachedTemplates;

    // Ensure EasyEDA button exists.
    let easyBtn = mount.querySelector(`.${EASYEDA_DL_BTN_CLASS}`);
    if (!easyBtn) {
      easyBtn = createDlButton(DL_SUB_EASYEDA, { primary: true });
      easyBtn.dataset.lcscId = lcscId;
      // Always append so order stays [Template, EasyEDA] (Template is inserted before easyBtn when added).
      mount.appendChild(easyBtn);
    }

    // Ensure Template button exists (but keep stable layout; hide if not wanted).
    let templateBtn = getTemplateBtn();
    if (wantTemplate) {
      if (!templateBtn) {
        templateBtn = createDlButton(DL_SUB_TEMPLATE, { primary: false });
        templateBtn.dataset.lcscId = lcscId;
        // Insert before EasyEDA so Template is on the left.
        mount.insertBefore(templateBtn, easyBtn);
      }
      templateBtn.style.display = "";
    } else if (templateBtn) {
      templateBtn.style.display = "none";
    }

    // Bind click handlers (overwrite previous via onclick).
    easyBtn.onclick = () => handleDownloadClick(easyBtn, lcscId, { useTemplate: false });
    if (templateBtn && templateBtn.style.display !== "none") {
      templateBtn.onclick = () => {
        void beginTemplateImportFlow(templateBtn, groupDiv, lcscId, state);
      };
    }

    // If backend is offline or state could not be read, grey out buttons and show status.
    if (!backendOnline) {
      setGroupBackendOffline();
      return;
    }

    if (!state.importDestReady) {
      setGroupNoImportLibrary();
      return;
    }

    const anyJobWatch =
      Boolean(easyBtn.dataset.k2cWatchJobId)
      || Boolean(templateBtn && templateBtn.dataset.k2cWatchJobId);
    if (!skipIdleReset && !anyJobWatch) {
      updateButtonState(easyBtn, "idle");
      if (templateBtn && templateBtn.style.display !== "none") {
        updateButtonState(templateBtn, "idle");
      }
    }
    easyBtn.dataset[INIT_ATTR] = "true";

    // Async: update exists/progress/partial without blocking render.
    void (async () => {
      try {
        const existResp = await contentRpc("checkComponentExists", { lcscId }, k2cRpc(3, 300));
        if (!mount.contains(easyBtn)) return;

        if (existResp?.ok) {
          const d = existResp.data || {};
          const msgs = Array.isArray(d.messages) ? d.messages : [];
          const analysis = d.outputAnalysis
            || computeOutputAnalysis({ outputs: d.outputs, result: d.result });
          if (d.completed && !analysis.partial) {
            const tooltip = buildSuccessTooltip(analysis, msgs);
            updateButtonState(easyBtn, "exists", {
              message: tooltip || MSG_LIBRARY_TITLE,
              libraryName: d.libraryName,
              libraryPath: d.libraryPath,
            });
            markGroupExists(easyBtn);
          } else if (d.completed && analysis.partial) {
            updateButtonState(easyBtn, "partial", {
              message: formatPartialImportMessage(msgs, analysis.missing),
              iconType: "download",
            });
          } else if (d.inProgress && d.jobId) {
            easyBtn.dataset.k2cWatchJobId = d.jobId;
            applyJobStatusToButton(easyBtn, d.jobId, {
              status: d.status,
              progress: d.progress,
              message: d.message,
              queue_position: d.queue_position,
            });
            startJobWatcher(easyBtn, d.jobId);
          } else {
            updateButtonState(easyBtn, "idle");
          }
        } else {
          const msg = existResp?.error || "";
          if (/backend|reach/i.test(msg)) {
            setGroupBackendOffline();
          } else {
            updateButtonState(easyBtn, "idle");
          }
        }
      } catch (e) {
        dbg("refreshButtonGroup: checkComponentExists failed", e);
        const msg = e?.message || String(e);
        if (/backend|reach/i.test(msg)) {
          setGroupBackendOffline();
        } else if (mount.contains(easyBtn)) {
          updateButtonState(easyBtn, "idle");
        }
      }
    })();
  } catch (err) {
    dbg("refreshButtonGroup failed", err);
    // If getState failed, treat it as offline so UI doesn't hang.
    setGroupBackendOffline();
  }
}

const TEMPLATE_DROPDOWN_ID = "easyeda2kicad-template-dropdown";
const TEMPLATE_GALLERY_MODAL_ID = "easyeda2kicad-template-gallery-modal";
/** Bumps SVG cache when preview options change (e.g. pin names on symbol). */
const K2C_GALLERY_SYMBOL_SVG_CACHE_TAG = "\nlg:v6imgPreview";
const TEMPLATE_HOVER_PREVIEW_ID = "easyeda2kicad-template-hover-preview";
/** Footprint pad → symbol pin dropdown: explicit no-connection (template gallery). */
const K2C_GALLERY_PAD_NC = "__NC__";

/**
 * Match ``easyeda2kicad.kicad.footprint_pad_remap.normalize_easyeda_pad_number`` so the
 * gallery pad column ↔ KiCad ``(pad "…")`` / template_pin_map stay aligned if a raw
 * EasyEDA-style label ever appears in the API payload.
 */
function normalizeGalleryPadLabel(s) {
  let t = String(s ?? "").trim();
  if (!t) return t;
  for (let i = 0; i < 6; i++) {
    const prev = t;
    const padM = t.match(/^\$PAD\(([^)]+)\)/i);
    if (padM) {
      t = String(padM[1] ?? "").trim();
      if (t) continue;
    }
    const dollM = t.match(/^\$([^$]+)\$$/);
    if (dollM) {
      const inn = String(dollM[1] ?? "").trim();
      if (inn && !inn.includes("(")) {
        t = inn;
        continue;
      }
    }
    const op = t.indexOf("(");
    const cp = op >= 0 ? t.indexOf(")", op + 1) : -1;
    if (op >= 0 && cp > op) {
      const inner = t.slice(op + 1, cp).trim();
      if (inner && inner !== t) {
        t = inner;
        continue;
      }
    }
    if (t === prev) break;
  }
  return t;
}

/**
 * Table is pad → chosen **template symbol** pin number; backend expects symbol pin (key) → pad name (value).
 * KiCad matches symbol ``(number …)`` to footprint ``(pad …)``; import rewrites symbol numbers
 * to the pad names only (footprint pads stay EasyEDA).
 * @param {Record<string, string> | null | undefined} padToSymbol
 * @returns {Record<string, string>}
 */
function buildTemplatePinMapFromGalleryPadMap(padToSymbol) {
  const o = padToSymbol && typeof padToSymbol === "object" ? padToSymbol : {};
  const templatePinMap = {};
  for (const [pad, symRaw] of Object.entries(o)) {
    const sym = String(symRaw ?? "").trim();
    if (!sym || sym === K2C_GALLERY_PAD_NC) continue;
    const p = normalizeGalleryPadLabel(pad);
    if (!p) continue;
    // Template symbol pin number → footprint pad (including 1:1). Backend applies symbol (number …) remap.
    templatePinMap[sym] = p;
  }
  return templatePinMap;
}

const templateSvgPreviewCache = new Map();
let templateHoverTimer = null;
let templateHoverRow = null;

function removeTemplateHoverPreviewUI() {
  document.getElementById(TEMPLATE_HOVER_PREVIEW_ID)?.remove();
}

function cancelTemplateHoverInteraction() {
  if (templateHoverTimer) {
    clearTimeout(templateHoverTimer);
    templateHoverTimer = null;
  }
  templateHoverRow = null;
  removeTemplateHoverPreviewUI();
}

function scheduleTemplateHoverPreview(row, item) {
  if (templateHoverTimer) {
    clearTimeout(templateHoverTimer);
    templateHoverTimer = null;
  }
  templateHoverTimer = setTimeout(() => {
    templateHoverTimer = null;
    void loadAndShowTemplateHoverPreview(row, item);
  }, 260);
}

async function loadAndShowTemplateHoverPreview(row, item) {
  if (templateHoverRow !== row) return;
  let previewTheme = "light";
  try {
    const st = await chrome.storage.local.get("popupUiState");
    if (st?.popupUiState?.theme === "dark") {
      previewTheme = "dark";
    }
  } catch (_e) {
    /* default light */
  }
  const key = `${item.libPath}\n${item.name}\npt:${previewTheme}`;
  let entry = templateSvgPreviewCache.get(key);
  if (!entry) {
    try {
      const resp = await contentRpc(
        "templatesPreviewSvg",
        {
          templateName: item.name,
          templateLibPath: item.libPath,
          labelPins: false,
          previewTheme,
        },
        k2cRpc(1, 400),
      );
      if (resp?.ok && resp.data?.ok && typeof resp.data.svg === "string") {
        entry = { svg: resp.data.svg };
      } else {
        const detail = (resp?.data && (resp.data.error || resp.data.message)) || "Preview unavailable";
        entry = { svg: null, err: String(detail) };
      }
    } catch (err) {
      entry = { svg: null, err: err?.message || "Preview failed" };
    }
    templateSvgPreviewCache.set(key, entry);
  }
  if (templateHoverRow !== row) return;
  removeTemplateHoverPreviewUI();
  const wrap = document.createElement("div");
  wrap.id = TEMPLATE_HOVER_PREVIEW_ID;
  wrap.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "pointer-events:none",
    "max-width:312px",
    "max-height:252px",
    "padding:6px",
    "box-sizing:border-box",
    "background:#ffffff",
    "border:1px solid #e2e8f0",
    "border-radius:10px",
    "box-shadow:0 12px 40px rgba(15,23,42,0.14)",
  ].join(";");
  if (entry.svg) {
    const inner = document.createElement("div");
    inner.style.cssText =
      "display:flex;align-items:center;justify-content:center;max-width:296px;max-height:234px;overflow:hidden;";
    const img = document.createElement("img");
    img.alt = "";
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(entry.svg)}`;
    img.style.cssText = "display:block;max-width:296px;max-height:234px;width:auto;height:auto;";
    inner.appendChild(img);
    wrap.appendChild(inner);
  } else {
    const t = document.createElement("div");
    t.textContent = entry.err || "No preview";
    t.style.cssText = "font-size:11px;line-height:1.35;color:#64748b;max-width:220px;padding:4px;";
    wrap.appendChild(t);
  }
  const r = row.getBoundingClientRect();
  const margin = 8;
  const preferLeft = r.right + margin + 248 > window.innerWidth;
  let left = preferLeft ? r.left - margin - 248 : r.right + margin;
  left = Math.max(margin, Math.min(left, window.innerWidth - 248 - margin));
  let top = Math.max(margin, r.top);
  top = Math.min(top, window.innerHeight - 198 - margin);
  wrap.style.left = `${left}px`;
  wrap.style.top = `${top}px`;
  document.body.appendChild(wrap);
}

function padSortKey(s) {
  const n = parseInt(String(s), 10);
  return Number.isFinite(n) && String(n) === String(s) ? [0, n] : [1, String(s)];
}

function sortPadNumbers(nums) {
  return [...new Set(nums.map((x) => String(x)))].sort((a, b) => {
    const ka = padSortKey(a);
    const kb = padSortKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[0] === 0) return ka[1] - kb[1];
    return ka[1].localeCompare(kb[1]);
  });
}

/** Match template / KiCad pin numbers in the PAD map (e.g. ``01`` vs ``1``). */
function symbolPinNumbersMatchForGallery(a, b) {
  const sa = String(a ?? "").trim();
  const sb = String(b ?? "").trim();
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) {
    return parseInt(sa, 10) === parseInt(sb, 10);
  }
  return false;
}

/** Template gallery: same text as PAD map dropdown options (pin · name). */
function galleryTemplatePinLabel(tp) {
  const n = String(tp?.number ?? "").trim();
  let nm = String(tp?.name ?? "").trim();
  if (nm === "~") nm = "";
  if (!n) return nm || "—";
  return nm ? `${n} · ${nm}` : n;
}

/** SVG user units: first copper ink shape inside a pad group (skips drill + text). */
function fpPadFirstCopperShape(g) {
  for (const el of g.children) {
    if (!(el instanceof SVGElement)) {
      continue;
    }
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "text") {
      continue;
    }
    if (el.classList.contains("k2c-fp-drill")) {
      continue;
    }
    if (tag === "polygon" || tag === "path" || tag === "rect" || tag === "ellipse") {
      return el;
    }
  }
  return null;
}

const FP_INNER_LABEL_FONT =
  'system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif';

/**
 * @param {SVGSVGElement} svg
 * @param {string} text
 * @param {number} fontSize
 * @param {string} fontWeight
 */
function fpMeasureTextBBox(svg, text, fontSize, fontWeight) {
  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("x", "0");
  t.setAttribute("y", "0");
  t.setAttribute("font-size", String(fontSize));
  t.setAttribute("font-weight", fontWeight);
  t.setAttribute("font-family", FP_INNER_LABEL_FONT);
  t.setAttribute("text-anchor", "middle");
  t.setAttribute("dominant-baseline", "middle");
  t.textContent = text;
  t.setAttribute("visibility", "hidden");
  svg.appendChild(t);
  let bb = { width: text.length * fontSize * 0.52, height: fontSize * 0.82 };
  try {
    bb = t.getBBox();
  } catch (_e) {
    /* keep estimate */
  }
  svg.removeChild(t);
  return bb;
}

/**
 * @param {string} padNum
 * @param {Record<string, string> | null | undefined} padToSymbol
 * @param {Array<{ number?: string, name?: string }> | null | undefined} symbolPins
 */
function resolveGalleryPinNameForPad(padNum, padToSymbol, symbolPins) {
  const pins = Array.isArray(symbolPins) ? symbolPins : [];
  const map = padToSymbol && typeof padToSymbol === "object" ? padToSymbol : {};
  const rawVal = map[padNum] ?? map[String(padNum)];
  const symSel = String(rawVal ?? "").trim() || K2C_GALLERY_PAD_NC;
  if (!symSel || symSel === K2C_GALLERY_PAD_NC) {
    return "";
  }
  let tpMatch = null;
  for (let i = 0; i < pins.length; i += 1) {
    const tp = pins[i];
    const n = String(tp?.number ?? "").trim();
    if (n && symbolPinNumbersMatchForGallery(symSel, n)) {
      tpMatch = tp;
      break;
    }
  }
  if (!tpMatch) {
    return "";
  }
  let nm = tpMatch.name != null ? String(tpMatch.name).trim() : "";
  if (nm === "~") {
    nm = "";
  }
  return nm;
}

/**
 * Lay out pad number + optional mapped template pin name inside the copper bbox.
 * Wide pads: stacked lines; tall pads: side by side. Font size scales to fit.
 * @param {SVGSVGElement} svg
 * @param {NodeListOf<SVGGElement> | SVGGElement[]} padGroups
 * @param {boolean} padMapUi
 * @param {Record<string, string> | null | undefined} padToSymbol
 * @param {Array<{ number?: string, name?: string }> | null | undefined} symbolPins
 */
function layoutFpPadInnerLabels(svg, padGroups, padMapUi, padToSymbol, symbolPins) {
  const list = Array.from(padGroups);
  const nPads = list.length;
  const manyPads = nPads > 36;
  const maxNameLen = manyPads ? 12 : 18;

  list.forEach((g) => {
    const copper = fpPadFirstCopperShape(g);
    const numEl = g.querySelector("text.k2c-fp-pad-num");
    if (!copper || !numEl) {
      return;
    }
    let bb;
    try {
      bb = copper.getBBox();
    } catch (_e) {
      return;
    }
    const cx = bb.x + bb.width / 2;
    const cy = bb.y + bb.height / 2;
    const pw = Math.max(bb.width, 0.04);
    const ph = Math.max(bb.height, 0.04);
    const margin = 0.84;
    const tw = pw * margin;
    const th = ph * margin;

    const padNum = String(g.getAttribute("data-pad") || "").trim();
    const numStr = (numEl.textContent || padNum).trim() || "?";

    let nameStr = "";
    if (padMapUi) {
      nameStr = resolveGalleryPinNameForPad(padNum, padToSymbol, symbolPins);
      if (nameStr.length > maxNameLen) {
        nameStr = `${nameStr.slice(0, Math.max(1, maxNameLen - 1))}…`;
      }
    }

    /** @type {SVGTextElement | null} */
    let assignEl = g.querySelector("text.k2c-fp-pad-assign");
    if (padMapUi && !assignEl) {
      assignEl = document.createElementNS(SVG_NS, "text");
      assignEl.setAttribute("class", "k2c-fp-pad-assign");
      assignEl.setAttribute("pointer-events", "none");
      assignEl.setAttribute("text-anchor", "middle");
      assignEl.setAttribute("dominant-baseline", "middle");
      assignEl.setAttribute("text-rendering", "geometricPrecision");
      g.appendChild(assignEl);
    }

    const hasName = Boolean(nameStr);
    const aspect = pw / Math.max(ph, 1e-6);
    const stackVertical = aspect >= 1;

    const wNum = "700";
    const wName = "600";
    const nameScale = 0.9;

    /**
     * @param {number} fs
     */
    function fits(fs) {
      const bNum = fpMeasureTextBBox(svg, numStr, fs, wNum);
      if (!hasName) {
        return bNum.width <= tw && bNum.height <= th;
      }
      const fsN = fs * nameScale;
      const bName = fpMeasureTextBBox(svg, nameStr, fsN, wName);
      const gap = fs * 0.22;
      if (stackVertical) {
        const H = bNum.height + gap + bName.height;
        const W = Math.max(bNum.width, bName.width);
        return W <= tw && H <= th;
      }
      const W = bNum.width + gap + bName.width;
      const H = Math.max(bNum.height, bName.height);
      return W <= tw && H <= th;
    }

    let lo = 0.055;
    let hi = Math.min(pw, ph) * 0.5;
    for (let iter = 0; iter < 24; iter += 1) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    let fs = lo;
    if (fs < 0.06) {
      fs = 0.06;
    }

    numEl.setAttribute("font-family", FP_INNER_LABEL_FONT);
    numEl.setAttribute("font-size", String(fs));
    numEl.setAttribute("font-weight", wNum);
    numEl.setAttribute("text-anchor", "middle");
    numEl.setAttribute("dominant-baseline", "middle");

    if (!hasName) {
      numEl.setAttribute("x", String(cx));
      numEl.setAttribute("y", String(cy));
      if (assignEl) {
        assignEl.textContent = "";
        assignEl.setAttribute("opacity", "0");
      }
      return;
    }

    if (!assignEl) {
      return;
    }

    const fsName = fs * nameScale;
    const bNum = fpMeasureTextBBox(svg, numStr, fs, wNum);
    const bName = fpMeasureTextBBox(svg, nameStr, fsName, wName);
    const gap = fs * 0.22;

    assignEl.setAttribute("font-family", FP_INNER_LABEL_FONT);
    assignEl.setAttribute("font-weight", wName);
    assignEl.setAttribute("text-anchor", "middle");
    assignEl.setAttribute("dominant-baseline", "middle");
    assignEl.setAttribute("text-rendering", "geometricPrecision");
    assignEl.setAttribute("fill", "#fef9c3");
    assignEl.textContent = nameStr;
    assignEl.setAttribute("opacity", "1");

    if (stackVertical) {
      const blockH = bNum.height + gap + bName.height;
      const yNum = cy - blockH / 2 + bNum.height / 2;
      const yName = cy - blockH / 2 + bNum.height + gap + bName.height / 2;
      numEl.setAttribute("x", String(cx));
      numEl.setAttribute("y", String(yNum));
      assignEl.setAttribute("font-size", String(fsName));
      assignEl.setAttribute("x", String(cx));
      assignEl.setAttribute("y", String(yName));
    } else {
      const blockW = bNum.width + gap + bName.width;
      const xNum = cx - blockW / 2 + bNum.width / 2;
      const xName = cx - blockW / 2 + bNum.width + gap + bName.width / 2;
      numEl.setAttribute("x", String(xNum));
      numEl.setAttribute("y", String(cy));
      assignEl.setAttribute("font-size", String(fsName));
      assignEl.setAttribute("x", String(xName));
      assignEl.setAttribute("y", String(cy));
    }
  });
}

/**
 * @param {SVGSVGElement} svg
 * @param {NodeListOf<SVGGElement> | SVGGElement[]} padGroups
 * @param {Record<string, string>} padToSymbol
 * @param {Array<{ number?: string, name?: string }> | null | undefined} symbolPins
 */
function syncFpPadAssignmentLabels(svg, padGroups, padToSymbol, symbolPins) {
  layoutFpPadInnerLabels(svg, padGroups, true, padToSymbol, symbolPins);
}

/** Comma-separated copper shape selectors under a pad group prefix (excludes drill). */
function fpPadCopperCssSelectors(groupPrefix) {
  const shapes = [
    "> polygon",
    "> path",
    "> rect",
    "> ellipse:not(.k2c-fp-drill)",
  ];
  return shapes.map((s) => `${groupPrefix} ${s}`).join(",");
}

function closeTemplateGalleryModal() {
  cancelTemplateHoverInteraction();
  datasheetPanel.unmount();
  const el = document.getElementById(TEMPLATE_GALLERY_MODAL_ID);
  if (el) {
    const esc = el._easyeda2kicadGalleryEsc;
    if (typeof esc === "function") {
      document.removeEventListener("keydown", esc, true);
    }
    el.remove();
  }
  document.getElementById(TEMPLATE_DROPDOWN_ID)?.remove();
  unlockOverlayPageScroll();
}

/**
 * Inline footprint SVG. With {@code padMapUi}, pads mirror the PAD map table (highlight + assignment labels).
 * Otherwise pads are clickable for exploration.
 * @param {{ padMapUi?: boolean, onPadPick?: (padNum: string, ev?: Event) => void }} [opts]
 */

/**
 * Root {@code <svg>} often shipped with a square width/height while {@code viewBox} matches the
 * footprint aspect ratio; flex + max-height then mis-sizes the layout box vs the painted “meet”
 * transform and pad hit-testing feels offset. Recompute width/height from viewBox aspect.
 * @param {SVGSVGElement} svg
 */
function normalizeFootprintPreviewSvgSizing(svg) {
  const vb = svg.getAttribute("viewBox");
  if (!vb) {
    return;
  }
  const parts = vb
    .trim()
    .split(/[\s,]+/)
    .filter((s) => s.length > 0);
  if (parts.length !== 4) {
    return;
  }
  const vw = parseFloat(parts[2]);
  const vh = parseFloat(parts[3]);
  if (!(vw > 0 && vh > 0)) {
    return;
  }
  const wAttr = parseFloat(svg.getAttribute("width") || "");
  const hAttr = parseFloat(svg.getAttribute("height") || "");
  const w0 = Number.isFinite(wAttr) && wAttr > 0 ? wAttr : 0;
  const h0 = Number.isFinite(hAttr) && hAttr > 0 ? hAttr : 0;
  const maxDim = Math.max(w0, h0, 220);
  const ar = vw / vh;
  let outW;
  let outH;
  if (ar >= 1) {
    outW = maxDim;
    outH = Math.max(1, Math.round(maxDim / ar));
  } else {
    outH = maxDim;
    outW = Math.max(1, Math.round(maxDim * ar));
  }
  svg.setAttribute("width", String(outW));
  svg.setAttribute("height", String(outH));
}

function mountInteractiveFootprintSvg(host, hintEl, svgStr, opts) {
  const o = opts || {};
  const padMapUi = Boolean(o.padMapUi);
  const onPadPick = typeof o.onPadPick === "function" ? o.onPadPick : null;
  host.innerHTML = "";
  if (!svgStr || typeof svgStr !== "string") {
    return false;
  }
  const doc = new DOMParser().parseFromString(svgStr, "image/svg+xml");
  const root = doc.documentElement;
  const perr = doc.querySelector("parsererror");
  if (perr || !root || root.localName !== "svg") {
    return false;
  }
  const svg = document.importNode(root, true);
  normalizeFootprintPreviewSvgSizing(svg);
  svg.style.cssText = cssJoin([
    "display:block",
    "max-width:100%",
    "max-height:100%",
    "width:auto",
    "height:auto",
    "margin:0 auto",
    "flex-shrink:1",
    "cursor:default",
    "touch-action:manipulation",
    "-webkit-user-select:none",
    "user-select:none",
  ]);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const styleEl = document.createElementNS(SVG_NS, "style");
  styleEl.textContent = [
    "g.k2c-fp-pad{cursor:pointer;outline:none;pointer-events:none;}",
    `${fpPadCopperCssSelectors("g.k2c-fp-pad")}{pointer-events:fill!important;}`,
    padMapUi ? "" : "g.k2c-fp-pad:focus-visible{outline:2px solid #1166dd;outline-offset:1px;}",
    padMapUi
      ? `${fpPadCopperCssSelectors("g.k2c-fp-pad:hover:not(.k2c-fp-pad-map-focus)")}{fill:#fb923c!important;stroke:none!important;}`
      : `${fpPadCopperCssSelectors("g.k2c-fp-pad:hover:not(.k2c-fp-pad-selected)")}{fill:#fb923c!important;stroke:none!important;}`,
    padMapUi
      ? ""
      : `${fpPadCopperCssSelectors("g.k2c-fp-pad-selected")}{fill:#c026d3!important;stroke:none!important;}`,
    padMapUi
      ? `${fpPadCopperCssSelectors("g.k2c-fp-pad:focus-visible")}{fill:#2563eb!important;stroke:none!important;}`
      : "",
    "text.k2c-fp-pad-assign{font-family:system-ui,Segoe UI,sans-serif;}",
    padMapUi
      ? `${fpPadCopperCssSelectors("g.k2c-fp-pad.k2c-fp-pad-map-focus")}{fill:#c026d3!important;stroke:none!important;}`
      : "",
  ]
    .filter(Boolean)
    .join("");
  svg.insertBefore(styleEl, svg.firstChild);

  const pads = svg.querySelectorAll("g[data-pad]");
  if (pads.length === 0) {
    return false;
  }

  /**
   * Hits only the copper fill (`pointer-events: fill`), not strokes/bbox extras from `all`.
   * Pad {@code <g>} uses pointer-events:none so the group never steals events beside the ink.
   */
  function wireFpPadPointerEvents() {
    pads.forEach((g) => {
      g.querySelectorAll(".k2c-fp-hit").forEach((n) => n.remove());
      for (const el of g.children) {
        if (!(el instanceof SVGElement)) continue;
        const tag = String(el.tagName || "").toLowerCase();
        const cls = el.getAttribute("class") || "";
        if (tag === "text" || cls.includes("k2c-fp-pad-assign")) {
          el.setAttribute("pointer-events", "none");
          continue;
        }
        if (cls.includes("k2c-fp-drill")) {
          el.setAttribute("pointer-events", "none");
          continue;
        }
        if (
          tag === "polygon"
          || tag === "rect"
          || tag === "ellipse"
          || tag === "circle"
          || tag === "path"
        ) {
          el.setAttribute("pointer-events", "fill");
        }
      }
    });
  }

  let selected = null;
  function selectPad(g, num) {
    if (selected) {
      selected.classList.remove("k2c-fp-pad-selected");
    }
    selected = g;
    if (g) {
      g.classList.add("k2c-fp-pad-selected");
    }
    if (hintEl) {
      hintEl.textContent = num
        ? `Selected pad: ${num} — tap another pad to change`
        : "Tap or click directly on a pad shape.";
    }
  }

  if (!padMapUi) {
    pads.forEach((g) => {
      const num = g.getAttribute("data-pad") || "";
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "button");
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        selectPad(g, num);
      });
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectPad(g, num);
        }
      });
    });
  }

  host.appendChild(svg);
  wireFpPadPointerEvents();
  requestAnimationFrame(() => {
    wireFpPadPointerEvents();
    layoutFpPadInnerLabels(
      svg,
      pads,
      padMapUi,
      padMapUi ? {} : null,
      null,
    );
  });

  delete host._k2cFpPadMapUi;
  delete host._k2cClearFpPadDragOver;

  if (padMapUi) {
    /** @type {SVGGElement | null} */
    let mapFocusPad = null;
    function setMapFocusPad(padNum) {
      if (mapFocusPad) {
        mapFocusPad.classList.remove("k2c-fp-pad-map-focus");
        mapFocusPad = null;
      }
      const want = padNum == null ? "" : String(padNum).trim();
      if (!want) {
        return;
      }
      /** @type {SVGGElement | null} */
      let gHit = null;
      pads.forEach((pg) => {
        const n = String(pg.getAttribute("data-pad") || "").trim();
        if (n === want) {
          gHit = pg;
        }
      });
      if (!gHit) {
        pads.forEach((pg) => {
          const n = String(pg.getAttribute("data-pad") || "").trim();
          if (!gHit && symbolPinNumbersMatchForGallery(n, want)) {
            gHit = pg;
          }
        });
      }
      if (gHit) {
        gHit.classList.add("k2c-fp-pad-map-focus");
        mapFocusPad = gHit;
      }
    }

    pads.forEach((g) => {
      const num = String(g.getAttribute("data-pad") || "").trim();
      if (!num) {
        return;
      }
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "button");
      g.setAttribute("aria-label", `Footprint pad ${num}; opens template pin list`);
      // Use `click` (not `pointerdown`): Chrome ties <select>.showPicker() to the click user-activation;
      // deferred rAF/microtask retries run after the gesture expires and the picker silently fails.
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        setMapFocusPad(num);
        onPadPick?.(num, e);
      });
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setMapFocusPad(num);
          onPadPick?.(num, e);
        }
      });
    });

    host._k2cFpPadMapUi = {
      setHighlightPad(padNum) {
        setMapFocusPad(padNum);
      },
      syncAssignments(padToSymbol, symbolPins) {
        syncFpPadAssignmentLabels(svg, pads, padToSymbol, symbolPins);
        requestAnimationFrame(() => {
          wireFpPadPointerEvents();
        });
      },
    };

    if (hintEl) {
      hintEl.textContent = `${pads.length} pads — click a pad or use the table; mapped **pin names** appear inside pads when set.`;
    }
  } else if (hintEl) {
    hintEl.textContent = `${pads.length} pads — tap a pad shape to select it`;
  }

  return true;
}

const K2C_TPL_GALLERY_STYLE_ID = "easyeda2kicad-template-gallery-anim-css";

function injectTemplateGalleryKeyframes() {
  if (document.getElementById(K2C_TPL_GALLERY_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = K2C_TPL_GALLERY_STYLE_ID;
  style.textContent = `
@keyframes k2cTplSpin { to { transform: rotate(360deg); } }
@keyframes k2cTplShimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@keyframes k2cTplPulseOpacity {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
.k2c-tpl-muted-pulse {
  animation: k2cTplPulseOpacity 1.15s ease-in-out infinite;
}
.k2c-tpl-spinner {
  display: inline-block;
  width: 15px;
  height: 15px;
  border: 2px solid #cbd5e1;
  border-top-color: #1166dd;
  border-radius: 50%;
  animation: k2cTplSpin 0.65s linear infinite;
  flex-shrink: 0;
  vertical-align: middle;
}
.k2c-tpl-load-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 20px 16px;
  min-height: 100px;
  width: 100%;
  box-sizing: border-box;
}
.k2c-tpl-load-title {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
  text-align: center;
}
.k2c-tpl-load-sub {
  font-size: 11px;
  color: #64748b;
  text-align: center;
  line-height: 1.35;
  max-width: 240px;
}
.k2c-tpl-skel-line {
  height: 7px;
  width: min(200px, 78%);
  border-radius: 4px;
  background: linear-gradient(90deg, #f1f5f9 0%, #e2e8f0 40%, #f1f5f9 80%);
  background-size: 200% 100%;
  animation: k2cTplShimmer 1.15s ease-in-out infinite;
}
.k2c-pad-map-table tbody tr {
  transition: background-color 0.12s ease;
}
.k2c-pad-map-table tbody tr:hover {
  background-color: #f1f5f9;
}
.k2c-pad-map-table tbody tr:has(select[data-footprint-pad]:focus) {
  background-color: #eff6ff;
}
`;
  document.head.appendChild(style);
}

/**
 * Centered loading state with spinner + shimmer bar (template import previews).
 * @param {HTMLElement} host
 * @param {string} title
 * @param {string} [sub]
 */
function mountGalleryPreviewLoading(host, title, sub) {
  host.innerHTML = "";
  const card = document.createElement("div");
  card.className = "k2c-tpl-load-card";
  const spin = document.createElement("div");
  spin.className = "k2c-tpl-spinner";
  spin.setAttribute("aria-hidden", "true");
  const t = document.createElement("div");
  t.className = "k2c-tpl-load-title";
  t.textContent = title || "Loading…";
  card.appendChild(spin);
  card.appendChild(t);
  if (sub) {
    const s = document.createElement("div");
    s.className = "k2c-tpl-load-sub";
    s.textContent = sub;
    card.appendChild(s);
  }
  const sk = document.createElement("div");
  sk.className = "k2c-tpl-skel-line";
  sk.setAttribute("aria-hidden", "true");
  card.appendChild(sk);
  host.appendChild(card);
}

/**
 * @param {HTMLElement} host
 * @param {HTMLElement | null} hintEl
 * @param {string | null | undefined} svgStr
 * @param {string} emptyMsg
 * @param {{ interactive?: boolean, loading?: boolean, padMapUi?: boolean, onPadPick?: (padNum: string, ev?: Event) => void }} [opts]
 */
function mountFootprintPreviewInHost(host, hintEl, svgStr, emptyMsg, opts) {
  const interactive = !opts || opts.interactive !== false;
  const loadingUi = Boolean(opts && opts.loading);
  const padMapUi = Boolean(opts && opts.padMapUi);
  const onPadPick = opts && typeof opts.onPadPick === "function" ? opts.onPadPick : undefined;
  host.innerHTML = "";
  if (host._k2cClearFpPadDragOver) {
    delete host._k2cClearFpPadDragOver;
  }
  if (host._k2cFpPadMapUi) {
    delete host._k2cFpPadMapUi;
  }
  if (hintEl) {
    hintEl.textContent =
      !svgStr || typeof svgStr !== "string"
        ? loadingUi
          ? "Loading footprint…"
          : emptyMsg || "—"
        : padMapUi
          ? "PAD map: table or click pads on the footprint; lists match other extension dialogs."
          : interactive
            ? "Tap a pad on its copper shape."
            : "Footprint preview — assign pads in the PAD map table.";
  }
  if (!svgStr || typeof svgStr !== "string") {
    if (loadingUi) {
      mountGalleryPreviewLoading(
        host,
        emptyMsg || "Loading footprint…",
        "Fetching package geometry and pads from EasyEDA",
      );
    } else {
      const t = document.createElement("div");
      t.textContent = emptyMsg || "Preview unavailable";
      t.style.cssText = "font-size:12px;color:#64748b;padding:8px;text-align:center;";
      host.appendChild(t);
    }
    return;
  }
  if (padMapUi && mountInteractiveFootprintSvg(host, hintEl, svgStr, { padMapUi: true, onPadPick })) {
    return;
  }
  if (interactive && mountInteractiveFootprintSvg(host, hintEl, svgStr)) {
    return;
  }
  if (hintEl) {
    hintEl.textContent = interactive
      ? "Pad numbers on the drawing (static preview)."
      : "Footprint pads are listed in the PAD map table.";
  }
  const wrap = document.createElement("div");
  wrap.style.cssText = cssJoin([
    "position:absolute",
    "inset:0",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "box-sizing:border-box",
    "width:100%",
    "min-width:0",
    "min-height:0",
    "padding:2px",
  ]);
  const img = document.createElement("img");
  img.alt = "";
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`;
  img.style.cssText = cssJoin([
    "display:block",
    "width:100%",
    "height:100%",
    "max-width:100%",
    "max-height:100%",
    "min-width:0",
    "min-height:0",
    "flex-shrink:1",
    "object-fit:contain",
    "object-position:center",
    "box-sizing:border-box",
  ]);
  wrap.appendChild(img);
  host.appendChild(wrap);
}

function buildTemplateListItems(templateSymbolsByLib) {
  const items = [];
  Object.entries(templateSymbolsByLib || {}).forEach(([libPath, names]) => {
    if (!Array.isArray(names)) return;
    const libName = libPath.replace(/^.*[/\\]/, "").replace(/\.kicad_sym$/, "") || "Library";
    names.forEach((name) => {
      items.push({ name, libPath, libName });
    });
  });
  items.sort((a, b) => String(a.name).localeCompare(b.name, undefined, { sensitivity: "base" }));
  return items;
}

function showTemplateGalleryEmpty(_anchorButton, _groupDiv, hasTemplateLibraries) {
  closeTemplateGalleryModal();
  lockOverlayPageScroll();
  const overlay = document.createElement("div");
  overlay.id = TEMPLATE_GALLERY_MODAL_ID;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "No KiCad templates available");
  overlay.style.cssText = CSS_MODAL_OVERLAY_STANDARD;

  const box = document.createElement("div");
  box.style.cssText = cssModalPanelLight(440);

  const title = document.createElement("h3");
  title.style.cssText = `margin:0 0 8px 0;font-size:15px;font-weight:600;color:${CS_DIALOG.panelText};`;
  title.textContent = "No KiCad templates found";

  const msg = document.createElement("p");
  msg.style.cssText = `margin:0 0 16px 0;font-size:13px;line-height:1.45;color:${CS_DIALOG.panelMuted};`;
  msg.textContent = hasTemplateLibraries
    ? "No template symbols were found. Check that the backend is running and the template library’s .kicad_sym file is valid. Use the extension popup to refresh libraries if needed, then try again."
    : "No template library is set. In the extension popup → Library, turn on Template for a library that contains your template symbols.";

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;justify-content:flex-end;gap:10px;";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.textContent = "Close";
  ok.style.cssText = dialogButtonStyle("primary", "wide");
  ok.addEventListener("click", () => closeTemplateGalleryModal());

  btnRow.appendChild(ok);
  box.appendChild(title);
  box.appendChild(msg);
  box.appendChild(btnRow);
  overlay.appendChild(box);

  function onEsc(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeTemplateGalleryModal();
      document.removeEventListener("keydown", onEsc, true);
    }
  }
  overlay._easyeda2kicadGalleryEsc = onEsc;
  document.addEventListener("keydown", onEsc, true);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeTemplateGalleryModal();
  });

  document.body.appendChild(overlay);
  ok.focus();
}

/**
 * @param {{ templatePreflightOverrides?: { overwrite?: boolean, overwrite_model?: boolean, categoryConfigOverride?: object | null } }} [galleryOptions]
 *   Set when overwrite + category gates already ran ({@link beginTemplateImportFlow}).
 */
async function openTemplateGallery(anchorButton, groupDiv, lcscId, state, galleryOptions) {
  const templatePreflightOverrides = galleryOptions?.templatePreflightOverrides || null;
  if (document.getElementById(TEMPLATE_GALLERY_MODAL_ID)) {
    closeTemplateGalleryModal();
    return;
  }
  cancelTemplateHoverInteraction();
  document.getElementById(TEMPLATE_DROPDOWN_ID)?.remove();

  const hasTplLibs = Array.isArray(state.libraries)
    && state.libraries.some((l) => Boolean(l && l.isTemplateLibrary));

  let templateSymbolsByLib = { ...(state.templateSymbolsByLib || {}) };
  let allItems = buildTemplateListItems(templateSymbolsByLib);

  // Always re-fetch symbol names from the backend so the list matches the current .kicad_sym files.
  if (hasTplLibs) {
    try {
      const ref = await contentRpc("refreshTemplateSymbols", {}, k2cRpc(3, 400));
      if (ref?.ok && ref.data?.templateSymbolsByLib) {
        templateSymbolsByLib = ref.data.templateSymbolsByLib;
        allItems = buildTemplateListItems(templateSymbolsByLib);
      }
    } catch (_e) {
      dbg("refreshTemplateSymbols failed", _e);
    }
  }

  if (!allItems.length) {
    showTemplateGalleryEmpty(anchorButton, groupDiv, hasTplLibs);
    return;
  }

  const pageData = extractPageData();
  const datasheetUrl = (pageData.datasheetUrl && String(pageData.datasheetUrl).trim()) || "";

  lockOverlayPageScroll();
  injectTemplateGalleryKeyframes();
  let previewTheme = "light";
  try {
    const themeResp = await contentRpc("getState", {}, k2cRpc(1, 200));
    if (themeResp?.ok && themeResp.data?.uiTheme === "dark") {
      previewTheme = "dark";
    }
  } catch (_e) {
    /* keep light */
  }

  const overlay = document.createElement("div");
  overlay.id = TEMPLATE_GALLERY_MODAL_ID;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Import from KiCad template");
  overlay.style.cssText = cssJoin([
    "position:fixed",
    "inset:0",
    `background:${CS_DIALOG.overlayDim}`,
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    `font-family:${CS_DIALOG.fontUi}`,
    "padding:10px",
    "box-sizing:border-box",
  ]);

  const shell = document.createElement("div");
  shell.style.cssText = cssJoin([
    `background:${CS_DIALOG.panelBg}`,
    `border:1px solid ${CS_DIALOG.panelBorder}`,
    "border-radius:12px",
    `box-shadow:${CS_DIALOG.panelShadow}`,
    "width:min(1920px,calc(100vw - 16px))",
    "height:min(96vh,calc(100vh - 16px))",
    "max-height:calc(100vh - 16px)",
    "display:flex",
    "flex-direction:column",
    "overflow:hidden",
    "box-sizing:border-box",
  ]);

  const header = document.createElement("div");
  header.style.cssText = cssJoin([
    "flex-shrink:0",
    "display:flex",
    "align-items:flex-start",
    "justify-content:space-between",
    "gap:12px",
    "padding:12px 16px",
    `border-bottom:1px solid ${"#e2e8f0"}`,
  ]);
  const titleStack = document.createElement("div");
  titleStack.style.cssText = "display:flex;flex-direction:column;gap:2px;min-width:0;";
  const titleEl = document.createElement("h2");
  titleEl.textContent = "Import from KiCad template";
  titleEl.style.cssText = cssJoin([
    "margin:0",
    "font-size:16px",
    "font-weight:600",
    `color:${"#0f172a"}`,
    "letter-spacing:-0.02em",
  ]);
  const idLine = document.createElement("div");
  idLine.textContent = `LCSC part ${lcscId}`;
  idLine.style.cssText = cssJoin(["font-size:12px", `color:${"#64748b"}`, "font-weight:500"]);
  titleStack.appendChild(titleEl);
  titleStack.appendChild(idLine);
  const headerClose = document.createElement("button");
  headerClose.type = "button";
  headerClose.textContent = "Close";
  headerClose.style.cssText = dialogButtonStyle("secondary", "dense");
  headerClose.addEventListener("click", () => closeTemplateGalleryModal());
  header.appendChild(titleStack);
  header.appendChild(headerClose);

  const loadTracks = { footprint: false, pinSummary: false };
  let symbolPreviewBusy = false;
  const statusBar = document.createElement("div");
  statusBar.setAttribute("role", "status");
  statusBar.setAttribute("aria-live", "polite");
  statusBar.style.cssText = cssJoin([
    "flex-shrink:0",
    "display:flex",
    "align-items:center",
    "gap:10px",
    "padding:10px 16px",
    `background:${"linear-gradient(90deg,#eff6ff 0%,#f8fafc 55%)"}`,
    `border-bottom:1px solid ${"#bfdbfe"}`,
    "min-height:44px",
    "box-sizing:border-box",
  ]);
  const statusSpinner = document.createElement("span");
  statusSpinner.className = "k2c-tpl-spinner";
  const statusText = document.createElement("span");
  statusText.style.cssText = cssJoin([
    "font-size:12px",
    `color:${"#1e3a5f"}`,
    "font-weight:500",
    "line-height:1.4",
    "flex:1",
    "min-width:0",
  ]);
  statusBar.appendChild(statusSpinner);
  statusBar.appendChild(statusText);

  function updateGalleryStatusBar() {
    if (symbolPreviewBusy) {
      statusSpinner.style.display = "inline-block";
      statusText.textContent = "Loading template symbol preview and pin list…";
      return;
    }
    const busy = !loadTracks.footprint || !loadTracks.pinSummary;
    statusSpinner.style.display = busy ? "inline-block" : "none";
    if (!loadTracks.footprint && !loadTracks.pinSummary) {
      statusText.textContent =
        "Loading EasyEDA footprint and cross-checking template pin counts…";
    } else if (!loadTracks.footprint) {
      statusText.textContent = "Still loading footprint preview and pad list…";
    } else if (!loadTracks.pinSummary) {
      statusText.textContent =
        "Comparing each template’s pin count to this LCSC part — the list on the left unlocks when done.";
    } else {
      statusText.textContent =
        "Ready — choose a template, wire pads in the map, then Continue.";
    }
  }

  const body = document.createElement("div");
  body.style.cssText = cssJoin([
    "display:flex",
    "flex:1",
    "min-height:0",
    "min-width:0",
    "width:100%",
    "align-items:stretch",
  ]);

  const leftCol = document.createElement("div");
  leftCol.style.cssText = cssJoin([
    "width:252px",
    "flex-shrink:0",
    `border-right:1px solid ${"#e2e8f0"}`,
    "display:flex",
    "flex-direction:column",
    "min-height:0",
    `background:${"#f8fafc"}`,
    `color:${"#0f172a"}`,
  ]);

  const listHeader = document.createElement("div");
  listHeader.textContent = "KiCad templates";
  listHeader.style.cssText = cssJoin([
    "padding:10px 14px 0 14px",
    "font-size:11px",
    "font-weight:600",
    `color:${"#64748b"}`,
    "text-transform:uppercase",
    "letter-spacing:0.06em",
    "flex-shrink:0",
  ]);

  const pinCompatFilterWrap = document.createElement("div");
  pinCompatFilterWrap.style.cssText = cssJoin([
    "flex-shrink:0",
    "display:flex",
    "align-items:flex-start",
    "gap:8px",
    "padding:6px 14px 2px 14px",
    "box-sizing:border-box",
  ]);
  const pinCompatFilterInput = document.createElement("input");
  pinCompatFilterInput.type = "checkbox";
  pinCompatFilterInput.id = "easyeda2kicad-tpl-pin-compat-filter";
  pinCompatFilterInput.checked = true;
  pinCompatFilterInput.setAttribute(
    "aria-label",
    "When checked, hide templates whose pin count does not match this LCSC part",
  );
  const pinCompatFilterLabel = document.createElement("label");
  pinCompatFilterLabel.htmlFor = pinCompatFilterInput.id;
  pinCompatFilterLabel.textContent = "Pin-compatible only";
  pinCompatFilterLabel.style.cssText = cssJoin([
    "font-size:12px",
    `color:${"#334155"}`,
    "font-weight:500",
    "line-height:1.35",
    "cursor:pointer",
    "user-select:none",
    "flex:1",
    "min-width:0",
  ]);
  pinCompatFilterWrap.appendChild(pinCompatFilterInput);
  pinCompatFilterWrap.appendChild(pinCompatFilterLabel);

  const searchBox = document.createElement("input");
  searchBox.type = "search";
  searchBox.autocomplete = "off";
  searchBox.placeholder = "Search by name…";
  searchBox.setAttribute("aria-label", "Filter templates");
  function gallerySearchBaseStyle() {
    return cssJoin([
      "margin:6px 12px 8px 12px",
      "padding:8px 12px",
      `border:1px solid ${"#d1d5db"}`,
      "border-radius:8px",
      `background:${"#ffffff"}`,
      `color:${"#111827"}`,
      "font-size:13px",
      "line-height:1.35",
      "outline:none",
      "box-sizing:border-box",
      "width:calc(100% - 24px)",
      "transition:border-color 0.15s ease,box-shadow 0.15s ease",
    ]);
  }
  const searchBaseStyle = gallerySearchBaseStyle();
  searchBox.style.cssText = searchBaseStyle;
  searchBox.addEventListener("focus", () => {
    searchBox.style.borderColor = "#1166dd";
    searchBox.style.boxShadow = `0 0 0 3px ${"rgba(17,102,221,0.18)"}`;
  });
  searchBox.addEventListener("blur", () => {
    searchBox.style.cssText = gallerySearchBaseStyle();
  });

  const list = document.createElement("div");
  list.style.cssText = cssJoin([
    "flex:1",
    "overflow-y:auto",
    "overflow-x:hidden",
    "min-height:0",
    "padding:2px 8px 12px 8px",
    "scrollbar-width:thin",
    `scrollbar-color:${"#cbd5e1"} ${"#f1f5f9"}`,
  ]);
  /** ``libPath\\nname`` → ``{ match, easyeda, template }`` from ``templatesGalleryPinSummary``. */
  const templatePinMismatch = new Map();
  leftCol.appendChild(listHeader);
  leftCol.appendChild(pinCompatFilterWrap);
  leftCol.appendChild(searchBox);
  leftCol.appendChild(list);

  function previewSection(labelText, hostOpts) {
    const flexGrow = hostOpts?.flexGrow != null ? String(hostOpts.flexGrow) : "1";
    const hostAlign =
      hostOpts?.hostAlign != null
        ? String(hostOpts.hostAlign)
        : hostOpts?.scrollLargeSvg
          ? "flex-start"
          : "center";
    const hostOverflow = hostOpts?.hostOverflow != null ? String(hostOpts.hostOverflow) : "hidden";
    const wrap = document.createElement("div");
    wrap.style.cssText = cssJoin([
      `flex:${flexGrow} 1 0`,
      "min-height:0",
      "display:flex",
      "flex-direction:column",
      "border:1px solid #e2e8f0",
      "border-radius:8px",
      "overflow:hidden",
      "background:#fff",
    ]);
    const cap = document.createElement("div");
    cap.textContent = labelText;
    cap.style.cssText =
      "flex-shrink:0;padding:6px 10px;font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;background:#f1f5f9;border-bottom:1px solid #e2e8f0;";
    const host = document.createElement("div");
    host.style.cssText = cssJoin([
      "flex:1",
      "min-height:0",
      "display:flex",
      `align-items:${hostAlign}`,
      "justify-content:center",
      "padding:8px",
      `overflow:${hostOverflow}`,
      "background:#fafafa",
      "-webkit-overflow-scrolling:touch",
    ]);
    wrap.appendChild(cap);
    wrap.appendChild(host);
    return { wrap, host, cap };
  }

  const centerCol = document.createElement("div");
  centerCol.style.cssText = cssJoin([
    "flex:1 1 280px",
    "min-width:0",
    "display:flex",
    "flex-direction:column",
    "gap:8px",
    "padding:10px",
    "min-height:0",
    "overflow:hidden",
  ]);
  const symWrap = document.createElement("div");
  symWrap.style.cssText = cssJoin([
    "flex:1 1 0",
    "min-height:0",
    "display:flex",
    "flex-direction:column",
    `border:1px solid ${"#e2e8f0"}`,
    "border-radius:8px",
    "overflow:hidden",
    `background:${"#ffffff"}`,
  ]);
  const symCap = document.createElement("div");
  symCap.textContent = "Template symbol";
  symCap.style.cssText = cssJoin([
    "flex-shrink:0",
    "padding:6px 10px",
    "font-size:11px",
    "font-weight:600",
    `color:${"#64748b"}`,
    "text-transform:uppercase",
    "letter-spacing:0.05em",
    `background:${"#f1f5f9"}`,
    `border-bottom:1px solid ${"#e2e8f0"}`,
  ]);
  const symRow = document.createElement("div");
  symRow.style.cssText = cssJoin([
    "flex:1",
    "min-height:0",
    "display:flex",
    "flex-direction:row",
    "align-items:stretch",
    "overflow:hidden",
  ]);
  const symHostCol = document.createElement("div");
  symHostCol.style.cssText = cssJoin([
    "flex:1",
    "min-width:0",
    "min-height:0",
    "display:flex",
    "align-items:stretch",
    "padding:8px",
    `background:${"#fafafa"}`,
    "overflow:hidden",
  ]);
  const symHost = document.createElement("div");
  symHost.style.cssText = cssJoin([
    "flex:1",
    "min-width:0",
    "min-height:0",
    "position:relative",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "overflow:auto",
    "-webkit-overflow-scrolling:touch",
    "scrollbar-width:thin",
  ]);
  symHostCol.appendChild(symHost);
  const pinTablePane = document.createElement("div");
  pinTablePane.style.cssText = cssJoin([
    "flex:0 0 200px",
    "width:200px",
    "min-width:160px",
    "max-width:min(260px,34vw)",
    "min-height:0",
    "display:flex",
    "flex-direction:column",
    `border-left:1px solid ${"#e2e8f0"}`,
    `background:${"#f8fafc"}`,
  ]);
  const pinTableCap = document.createElement("div");
  pinTableCap.textContent = "Pins on template";
  pinTableCap.style.cssText = cssJoin([
    "flex-shrink:0",
    "padding:6px 10px",
    "font-size:11px",
    "font-weight:600",
    `color:${"#64748b"}`,
    "text-transform:uppercase",
    "letter-spacing:0.05em",
    `border-bottom:1px solid ${"#e2e8f0"}`,
    `background:${"#f1f5f9"}`,
  ]);
  const pinTableHint = document.createElement("div");
  pinTableHint.textContent =
    "Reference list for the template symbol. Assign pads with **Pad → template pin**; the footprint drawing updates there.";
  pinTableHint.style.cssText = cssJoin([
    "flex-shrink:0",
    "padding:4px 10px 7px",
    "font-size:10px",
    `color:${"#475569"}`,
    "line-height:1.35",
    `border-bottom:1px solid ${"#e2e8f0"}`,
    `background:${"#f8fafc"}`,
  ]);
  const pinTableScroll = document.createElement("div");
  pinTableScroll.setAttribute("role", "region");
  pinTableScroll.setAttribute("aria-label", "Template symbol pins");
  pinTableScroll.style.cssText = cssJoin([
    "flex:1",
    "min-height:0",
    "overflow:auto",
    "padding:6px 8px 8px",
    "scrollbar-width:thin",
    `scrollbar-color:${"#cbd5e1"} ${"#f1f5f9"}`,
  ]);
  pinTablePane.appendChild(pinTableCap);
  pinTablePane.appendChild(pinTableHint);
  pinTablePane.appendChild(pinTableScroll);
  symRow.appendChild(symHostCol);
  symRow.appendChild(pinTablePane);
  symWrap.appendChild(symCap);
  symWrap.appendChild(symRow);

  const fpWrap = document.createElement("div");
  fpWrap.style.cssText = cssJoin([
    "flex:1 1 0",
    "min-height:0",
    "display:flex",
    "flex-direction:column",
    `border:1px solid ${"#e8edf3"}`,
    "border-radius:8px",
    "overflow:hidden",
    `background:${"#ffffff"}`,
    "box-shadow:none",
  ]);
  const fpCap = document.createElement("div");
  fpCap.textContent = "EasyEDA footprint";
  fpCap.style.cssText = cssJoin([
    "flex-shrink:0",
    "padding:6px 10px",
    "font-size:11px",
    "font-weight:600",
    `color:${"#64748b"}`,
    "text-transform:uppercase",
    "letter-spacing:0.05em",
    `background:${"#f1f5f9"}`,
    `border-bottom:1px solid ${"#e2e8f0"}`,
  ]);
  const fpRow = document.createElement("div");
  fpRow.style.cssText = cssJoin([
    "flex:1",
    "min-height:0",
    "display:flex",
    "flex-direction:row",
    "align-items:stretch",
    "overflow:hidden",
  ]);
  const fpHostCol = document.createElement("div");
  fpHostCol.style.cssText = cssJoin([
    "flex:1",
    "min-width:0",
    "min-height:0",
    "display:flex",
    "align-items:stretch",
    "padding:6px",
    `background:${"#ffffff"}`,
    "overflow:hidden",
  ]);
  const fpHost = document.createElement("div");
  fpHost.style.cssText = cssJoin([
    "flex:1",
    "min-width:0",
    "min-height:0",
    "position:relative",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "overflow:auto",
    "overflow-x:auto",
    "overflow-y:auto",
    "-webkit-overflow-scrolling:touch",
    "scrollbar-width:thin",
  ]);
  fpHostCol.appendChild(fpHost);
  const fpPadMapPane = document.createElement("div");
  fpPadMapPane.style.cssText = cssJoin([
    "flex:0 0 200px",
    "width:200px",
    "min-width:160px",
    "max-width:min(260px,34vw)",
    "min-height:0",
    "display:flex",
    "flex-direction:column",
    `border-left:1px solid ${"#e2e8f0"}`,
    `background:${"#f8fafc"}`,
  ]);
  const fpPadMapCap = document.createElement("div");
  fpPadMapCap.textContent = "Pad → template pin";
  fpPadMapCap.style.cssText = cssJoin([
    "flex-shrink:0",
    "padding:6px 10px",
    "font-size:11px",
    "font-weight:600",
    `color:${"#64748b"}`,
    "text-transform:uppercase",
    "letter-spacing:0.05em",
    `border-bottom:1px solid ${"#e2e8f0"}`,
    `background:${"#f1f5f9"}`,
  ]);
  const fpPadMapScroll = document.createElement("div");
  fpPadMapScroll.setAttribute("role", "region");
  fpPadMapScroll.setAttribute("aria-label", "Map each footprint pad to a template symbol pin");
  fpPadMapScroll.style.cssText = cssJoin([
    "flex:1",
    "min-height:0",
    "overflow:auto",
    "padding:6px 8px 10px",
    "scrollbar-width:thin",
    `scrollbar-color:${"#cbd5e1"} ${"#f1f5f9"}`,
  ]);
  fpPadMapPane.appendChild(fpPadMapCap);
  fpPadMapPane.appendChild(fpPadMapScroll);
  fpRow.appendChild(fpHostCol);
  fpRow.appendChild(fpPadMapPane);
  const fpPadHint = document.createElement("div");
  fpPadHint.style.cssText = cssJoin([
    "flex-shrink:0",
    "padding:6px 10px",
    "font-size:11px",
    "font-weight:500",
    `color:${"#64748b"}`,
    "line-height:1.4",
    `background:${"#f8fafc"}`,
    `border-top:1px solid ${"#e2e8f0"}`,
  ]);
  fpPadHint.textContent =
    "KiCad links schematic pins to pads by matching labels. Use **Pad → template pin** (same styling as other extension dialogs), or **click a pad** on the footprint to open that row’s list. Hover pads for a highlight. Pin **names** only on the drawing when the library defines them. Import rewrites pin numbers only; the EasyEDA footprint is unchanged.";
  fpWrap.appendChild(fpCap);
  fpWrap.appendChild(fpRow);
  fpWrap.appendChild(fpPadHint);
  centerCol.appendChild(symWrap);
  centerCol.appendChild(fpWrap);

  let galleryFootprintPads = [];
  /** @type {Array<{ number?: string, name?: string }>} Selected template symbol pins (PAD map + preview table). */
  let gallerySymbolPinsForPadMap = [];
  /** Clears footprint pad highlight after PAD map {@code <select>} blur (deferred). */
  let fpPadMapHighlightClearTimer = null;

  function focusGalleryPadMapSelect(padNum, _sourceEvent) {
    const want = String(padNum ?? "").trim();
    if (!want) {
      return;
    }
    const sels = fpPadMapScroll.querySelectorAll("select[data-footprint-pad]");
    /** @type {HTMLSelectElement | null} */
    let hit = null;
    for (let i = 0; i < sels.length; i++) {
      const s = sels[i];
      const p = String(s.dataset.footprintPad || "").trim();
      if (p === want) {
        hit = s;
        break;
      }
    }
    if (!hit) {
      for (let i = 0; i < sels.length; i++) {
        const s = sels[i];
        const p = String(s.dataset.footprintPad || "").trim();
        if (symbolPinNumbersMatchForGallery(p, want)) {
          hit = s;
          break;
        }
      }
    }
    if (!hit) {
      return;
    }
    hit.scrollIntoView({ block: "nearest", behavior: "auto" });
    hit.focus({ preventScroll: true });
    if (typeof hit.showPicker === "function") {
      try {
        hit.showPicker();
      } catch (_e) {
        /* showPicker needs a fresh user gesture; avoid async retry — it loses activation */
      }
    }
  }
  const galleryContinueTitleReady =
    "Continue submits the import using your template and pad map (overwrite and category settings were confirmed earlier).";

  const rightCol = document.createElement("div");
  rightCol.style.cssText = cssJoin([
    "flex:1 1 34%",
    "min-width:max(280px,33.333%)",
    `border-left:1px solid ${"#e2e8f0"}`,
    "display:flex",
    "flex-direction:column",
    "min-height:0",
    "background:#0f172a",
  ]);
  const pdfCap = document.createElement("div");
  pdfCap.style.cssText = cssJoin([
    "flex-shrink:0",
    "display:flex",
    "align-items:center",
    "justify-content:space-between",
    "gap:8px",
    "padding:8px 12px",
    `background:${"#1e293b"}`,
    `border-bottom:1px solid ${"#334155"}`,
  ]);
  const pdfTitle = document.createElement("span");
  pdfTitle.textContent = "Datasheet";
  pdfTitle.style.cssText = "font-size:11px;font-weight:600;color:#e2e8f0;text-transform:uppercase;letter-spacing:0.06em;";
  const pdfOpen = document.createElement("button");
  pdfOpen.type = "button";
  pdfOpen.textContent = "Open in tab";
  pdfOpen.disabled = !datasheetUrl;
  pdfOpen.style.cssText = dialogButtonStyle("outline", "dense");
  Object.assign(pdfOpen.style, {
    borderColor: "#475569",
    color: "#e2e8f0",
    background: "transparent",
    fontSize: "11px",
    padding: "4px 10px",
  });
  pdfOpen.addEventListener("click", () => {
    if (datasheetUrl) window.open(datasheetUrl, "_blank", "noopener,noreferrer");
  });
  pdfCap.appendChild(pdfTitle);
  pdfCap.appendChild(pdfOpen);
  const pdfFrameWrap = document.createElement("div");
  pdfFrameWrap.style.cssText = cssJoin([
    "flex:1",
    "min-height:0",
    "position:relative",
    `background:${"#1e293b"}`,
  ]);
  const pdfScrollHost = document.createElement("div");
  pdfScrollHost.setAttribute("role", "region");
  pdfScrollHost.setAttribute("aria-label", "Datasheet PDF");
  pdfScrollHost.style.cssText = cssJoin([
    "position:absolute",
    "inset:0",
    "overflow:auto",
    "overflow-x:hidden",
    "-webkit-overflow-scrolling:touch",
    `background:${"#334155"}`,
  ]);
  pdfFrameWrap.appendChild(pdfScrollHost);
  const pdfLoading = document.createElement("div");
  pdfLoading.style.cssText =
    "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;font-size:12px;color:#cbd5e1;background:#1e293b;z-index:1;";
  const pdfFallback = document.createElement("div");
  pdfFallback.style.cssText =
    "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;text-align:center;font-size:13px;color:#cbd5e1;line-height:1.45;";
  if (!datasheetUrl) {
    pdfFallback.textContent = "No datasheet link on this product page.";
    pdfFrameWrap.appendChild(pdfFallback);
  } else {
    const pdfProgRef = { label: null, fill: null };

    function mountPdfLoadingProgressUi() {
      pdfLoading.textContent = "";
      pdfLoading.style.display = "flex";
      pdfLoading.style.flexDirection = "column";
      pdfLoading.style.alignItems = "center";
      pdfLoading.style.justifyContent = "center";
      pdfLoading.style.gap = "10px";
      const label = document.createElement("div");
      label.style.cssText =
        "font-size:12px;color:#cbd5e1;text-align:center;line-height:1.4;max-width:92%";
      label.textContent = "Downloading datasheet…";
      const track = document.createElement("div");
      track.style.cssText =
        "width:min(220px,85%);height:6px;border-radius:999px;background:rgba(148,163,184,0.35);overflow:hidden;";
      const fill = document.createElement("div");
      fill.style.cssText =
        "height:100%;width:0%;background:#60a5fa;border-radius:999px;transition:width 0.15s ease-out";
      track.appendChild(fill);
      pdfLoading.appendChild(label);
      pdfLoading.appendChild(track);
      pdfProgRef.label = label;
      pdfProgRef.fill = fill;
    }

    function setPdfDownloadProgress(received, total) {
      const fill = pdfProgRef.fill;
      const label = pdfProgRef.label;
      if (!fill || !label) {
        return;
      }
      if (total != null && Number.isFinite(total) && total > 0) {
        const pct = Math.min(100, Math.round((received / total) * 100));
        fill.style.width = `${pct}%`;
        const mbTot = total / 1048576;
        if (mbTot >= 0.05) {
          label.textContent = `Downloading datasheet… ${pct}% (${(received / 1048576).toFixed(1)} / ${mbTot.toFixed(1)} MB)`;
        } else {
          label.textContent = `Downloading datasheet… ${pct}%`;
        }
      } else {
        fill.style.width = "38%";
        label.textContent = `Downloading datasheet… ${(received / 1048576).toFixed(2)} MB`;
      }
    }

    mountPdfLoadingProgressUi();
    pdfFrameWrap.appendChild(pdfLoading);

    function datasheetPdfEmbedUrl(raw) {
      if (!raw || typeof raw !== "string") return raw;
      if (raw.includes("#")) return raw;
      return `${raw}#page=1&view=FitH`;
    }

    function mountPdfIframeFallback(src) {
      pdfScrollHost.textContent = "";
      pdfScrollHost.style.overflow = "hidden";
      const iframe = document.createElement("iframe");
      iframe.title = "Datasheet PDF";
      iframe.src = src;
      iframe.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;border:none;background:#525252;";
      pdfScrollHost.appendChild(iframe);
      iframe.addEventListener(
        "load",
        () => {
          pdfLoading.style.display = "none";
        },
        { once: true },
      );
      setTimeout(() => {
        pdfLoading.style.display = "none";
      }, 12000);
    }

    void (async () => {
      const myGen = datasheetPanel.cancel();
      const hideLoad = () => {
        pdfLoading.style.display = "none";
      };

      function showLargeDatasheetApproval(data) {
        return new Promise((resolve) => {
          if (!datasheetPanel.isCurrent(myGen)) {
            resolve(false);
            return;
          }
          pdfLoading.textContent = "";
          pdfLoading.style.flexDirection = "column";
          const wrap = document.createElement("div");
          wrap.style.cssText =
            "display:flex;flex-direction:column;align-items:center;gap:12px;padding:8px;max-width:300px;";
          const p = document.createElement("p");
          p.style.cssText =
            "margin:0;font-size:13px;color:#e2e8f0;line-height:1.45;text-align:center";
          const exp = data?.expectedBytes;
          p.textContent =
            typeof exp === "number" && exp > 0
              ? `This datasheet is about ${(exp / 1048576).toFixed(1)} MB. Load it in this panel?`
              : "This datasheet is over 5 MB. Load it in this panel?";
          const row = document.createElement("div");
          row.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;justify-content:center";
          const loadBtn = document.createElement("button");
          loadBtn.type = "button";
          loadBtn.textContent = "Load";
          loadBtn.style.cssText = cssJoin([
            dialogButtonStyle("primary", "dense"),
            "font-size:12px",
            "padding:6px 14px",
          ]);
          const skipBtn = document.createElement("button");
          skipBtn.type = "button";
          skipBtn.textContent = "Skip";
          skipBtn.style.cssText = cssJoin([
            dialogButtonStyle("secondary", "dense"),
            "font-size:12px",
            "padding:6px 14px",
            `border-color:${"#475569"}`,
            `color:${"#e2e8f0"}`,
            "background:transparent",
          ]);
          const done = (v) => {
            loadBtn.disabled = true;
            skipBtn.disabled = true;
            resolve(v);
          };
          loadBtn.addEventListener("click", () => done(true));
          skipBtn.addEventListener("click", () => done(false));
          wrap.appendChild(p);
          row.appendChild(loadBtn);
          row.appendChild(skipBtn);
          wrap.appendChild(row);
          pdfLoading.appendChild(wrap);
        });
      }

      /** @type {Uint8Array | null} */
      let pdfBytes = null;
      try {
        k2cActiveDatasheetDownloadUi = {
          requestId: myGen,
          onProgress: (received, total) => {
            if (!datasheetPanel.isCurrent(myGen)) {
              return;
            }
            setPdfDownloadProgress(received, total);
          },
        };

        const runFetch = (confirmedLarge) =>
          contentRpc(
            "fetchDatasheetBlob",
            { url: datasheetUrl, requestId: myGen, confirmedLarge },
            k2cRpc(1, 500),
          );

        k2cDatasheetLog("fetchDatasheetBlob →", datasheetUrl);
        let resp = await runFetch(false);

        if (!datasheetPanel.isCurrent(myGen)) {
          return;
        }

        if (resp?.ok && resp.data?.needsApproval) {
          k2cActiveDatasheetDownloadUi = null;
          const ok = await showLargeDatasheetApproval(resp.data);
          if (!datasheetPanel.isCurrent(myGen)) {
            return;
          }
          if (!ok) {
            pdfLoading.textContent = "";
            pdfLoading.style.display = "flex";
            pdfLoading.style.flexDirection = "column";
            pdfLoading.style.alignItems = "center";
            pdfLoading.style.justifyContent = "center";
            const skip = document.createElement("div");
            skip.textContent = "Large datasheet not loaded. Use “Open in tab” to view the full file.";
            skip.style.cssText =
              "font-size:12px;color:#94a3b8;text-align:center;padding:12px;max-width:280px;line-height:1.45";
            pdfLoading.appendChild(skip);
            return;
          }
          mountPdfLoadingProgressUi();
          k2cActiveDatasheetDownloadUi = {
            requestId: myGen,
            onProgress: (received, total) => {
              if (!datasheetPanel.isCurrent(myGen)) {
                return;
              }
              setPdfDownloadProgress(received, total);
            },
          };
          resp = await runFetch(true);
        }

        if (resp?.ok && resp.data?.base64) {
          if (pdfProgRef.fill) {
            pdfProgRef.fill.style.width = "100%";
          }
          if (pdfProgRef.label) {
            pdfProgRef.label.textContent = "Preparing viewer…";
          }
          const u8 = await k2cBase64ToUint8Array(resp.data.base64);
          pdfBytes = u8;
          k2cDatasheetLog(
            "fetch OK",
            "bytes=",
            u8.length,
            "contentType=",
            resp.data.contentType || "(none)",
          );
          const blob = new Blob([u8], { type: resp.data.contentType || "application/pdf" });
          const blobUrl = URL.createObjectURL(blob);
          datasheetPanel.trackBlobUrl(blobUrl);
        } else {
          k2cDatasheetLog(
            "fetchDatasheetBlob RPC not usable",
            "ok=",
            resp?.ok,
            "error=",
            resp?.error || "(none)",
            "needsApproval=",
            Boolean(resp?.data?.needsApproval),
          );
        }
      } catch (e) {
        k2cDatasheetLog("fetchDatasheetBlob threw:", e?.message || e);
        /* fall through to remote URL */
      } finally {
        k2cActiveDatasheetDownloadUi = null;
      }

      if (!datasheetPanel.isCurrent(myGen)) {
        return;
      }

      await new Promise((r) => {
        requestAnimationFrame(() => requestAnimationFrame(r));
      });
      if (!datasheetPanel.isCurrent(myGen)) {
        return;
      }

      if (pdfBytes && pdfBytes.length > 0) {
        k2cDatasheetLog("using extension PDF.js viewer (fetched bytes)");
        datasheetPanel.mountViewer(pdfScrollHost, pdfBytes, { gen: myGen, onShown: hideLoad });
        return;
      }

      if (!datasheetPanel.isCurrent(myGen)) {
        return;
      }

      const iframeSrc = datasheetPdfEmbedUrl(datasheetUrl);
      k2cDatasheetLog("using direct PDF URL in iframe (no fetched bytes)", iframeSrc);
      mountPdfIframeFallback(iframeSrc);
    })();
  }
  rightCol.appendChild(pdfCap);
  rightCol.appendChild(pdfFrameWrap);

  const footer = document.createElement("div");
  footer.style.cssText = cssJoin([
    "flex-shrink:0",
    "display:flex",
    "justify-content:flex-end",
    "align-items:center",
    "gap:10px",
    "padding:12px 16px",
    `border-top:1px solid ${"#e2e8f0"}`,
    `background:${"#f8fafc"}`,
  ]);
  const cancelFooter = document.createElement("button");
  cancelFooter.type = "button";
  cancelFooter.textContent = "Cancel";
  cancelFooter.style.cssText = dialogButtonStyle("secondary", "wide");
  cancelFooter.addEventListener("click", () => closeTemplateGalleryModal());
  const useBtn = document.createElement("button");
  useBtn.type = "button";
  useBtn.textContent = "Continue";
  useBtn.disabled = true;
  useBtn.title = galleryContinueTitleReady;
  useBtn.style.cssText = dialogButtonStyle("primary", "wide");
  footer.appendChild(cancelFooter);
  footer.appendChild(useBtn);

  let selectedItem = null;
  let selectedRow = null;

  function formatGalleryTemplatePinLabel(tp) {
    return galleryTemplatePinLabel(tp);
  }

  function syncGalleryContinueButton() {
    const pinMapReady =
      galleryFootprintPads.length > 0
      && gallerySymbolPinsForPadMap.length > 0
      && fpPadMapScroll.querySelectorAll("select[data-footprint-pad]").length > 0;
    useBtn.disabled = !selectedItem || !pinMapReady;
    useBtn.title = pinMapReady
      ? galleryContinueTitleReady
      : "Wait for footprint preview and template symbol pins to load, then confirm your pad ↔ symbol map.";
  }

  function refreshGalleryFootprintPadMap() {
    renderFootprintPadMapTable(fpPadMapScroll, galleryFootprintPads, gallerySymbolPinsForPadMap, fpHost);
    fpHost._k2cFpPadMapUi?.syncAssignments(readGalleryPadToSymbolMap(), gallerySymbolPinsForPadMap);
    syncGalleryContinueButton();
  }

  /**
   * @param {HTMLElement} container
   * @param {Array<{ number?: string }>} pads
   * @param {Array<{ number?: string, name?: string }> | null} symbolPins Pins from the **selected template** (same as symbol preview).
   * @param {HTMLElement | null} fpHostMap Footprint preview host ({@code _k2cFpPadMapUi}).
   */
  function renderFootprintPadMapTable(container, pads, symbolPins, fpHostMap) {
    container.textContent = "";
    const padNums = sortPadNumbers((pads || []).map((p) => p.number).filter((n) => String(n).trim()));
    if (padNums.length === 0) {
      const d = document.createElement("div");
      d.textContent = symbolPins?.length ? "No footprint pads returned." : "Loading pads…";
      d.style.cssText = cssJoin([
        "font-size:12px",
        `color:${"#94a3b8"}`,
        "line-height:1.4",
        "padding:4px 2px",
      ]);
      container.appendChild(d);
      return;
    }
    if (!symbolPins || symbolPins.length === 0) {
      const d = document.createElement("div");
      d.className = "k2c-tpl-muted-pulse";
      d.textContent = "Loading template symbol pins… (select a template if the list is empty)";
      d.style.cssText = cssJoin([
        "font-size:12px",
        `color:${"#94a3b8"}`,
        "line-height:1.4",
        "padding:4px 2px",
      ]);
      container.appendChild(d);
      return;
    }
    const symByExactNum = new Map(
      symbolPins.map((tp) => [String(tp?.number ?? "").trim(), tp]).filter(([k]) => k),
    );
    const table = document.createElement("table");
    table.className = "k2c-pad-map-table";
    table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;";
    const thead = document.createElement("thead");
    const thr = document.createElement("tr");
    ["Footprint pad", "Template symbol pin"].forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      th.style.cssText = cssJoin([
        "text-align:left",
        "padding:4px 6px 6px",
        `color:${"#64748b"}`,
        "font-weight:600",
        "font-size:10px",
        "text-transform:uppercase",
        "letter-spacing:0.04em",
        `border-bottom:1px solid ${"#e2e8f0"}`,
      ]);
      thr.appendChild(th);
    });
    thead.appendChild(thr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    padNums.forEach((padNum) => {
      const tr = document.createElement("tr");
      const tdP = document.createElement("td");
      tdP.textContent = padNum;
      tdP.style.cssText = cssJoin([
        "padding:5px 6px",
        `border-bottom:1px solid ${"#f1f5f9"}`,
        `color:${"#0f172a"}`,
        "font-weight:700",
        "font-variant-numeric:tabular-nums",
        "vertical-align:middle",
      ]);
      const tdSel = document.createElement("td");
      tdSel.style.cssText = cssJoin([
        "padding:8px 6px",
        `border-bottom:1px solid ${"#f1f5f9"}`,
        "vertical-align:middle",
        "min-width:0",
      ]);
      const sel = document.createElement("select");
      sel.dataset.footprintPad = padNum;
      sel.setAttribute("aria-label", `Template symbol pin that connects to footprint pad ${padNum}`);
      sel.title =
        "Which pin on the **template symbol** (same as the preview) connects to this footprint pad. On import, that pin’s number is rewritten to match the pad label.";
      applyDialogStyleSelect(sel);
      const optNc = document.createElement("option");
      optNc.value = K2C_GALLERY_PAD_NC;
      optNc.textContent = "NC";
      optNc.title = "No connection — pad not tied to a template symbol pin.";
      sel.appendChild(optNc);
      symbolPins.forEach((tp) => {
        const n = String(tp?.number ?? "").trim();
        if (!n) return;
        const opt = document.createElement("option");
        opt.value = n;
        opt.textContent = formatGalleryTemplatePinLabel(tp);
        sel.appendChild(opt);
      });
      let defaultPin = K2C_GALLERY_PAD_NC;
      if (symByExactNum.has(padNum)) {
        defaultPin = padNum;
      } else {
        for (const tp of symbolPins) {
          const n = String(tp?.number ?? "").trim();
          if (n && symbolPinNumbersMatchForGallery(padNum, n)) {
            defaultPin = n;
            break;
          }
        }
      }
      sel.value = defaultPin;
      sel.addEventListener("focus", () => {
        if (fpPadMapHighlightClearTimer) {
          clearTimeout(fpPadMapHighlightClearTimer);
          fpPadMapHighlightClearTimer = null;
        }
        fpHostMap?._k2cFpPadMapUi?.setHighlightPad(padNum);
      });
      sel.addEventListener("blur", () => {
        fpPadMapHighlightClearTimer = setTimeout(() => {
          fpPadMapHighlightClearTimer = null;
          const ae = document.activeElement;
          if (
            fpPadMapScroll.contains(ae)
            && ae instanceof HTMLSelectElement
            && ae.matches("select[data-footprint-pad]")
          ) {
            return;
          }
          fpHostMap?._k2cFpPadMapUi?.setHighlightPad(null);
        }, 0);
      });
      sel.addEventListener("change", () => {
        fpHostMap?._k2cFpPadMapUi?.syncAssignments(
          readGalleryPadToSymbolMap(),
          gallerySymbolPinsForPadMap,
        );
      });
      tdSel.appendChild(sel);
      tr.appendChild(tdP);
      tr.appendChild(tdSel);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  function readGalleryPadToSymbolMap() {
    /** @type {Record<string, string>} */
    const map = {};
    fpPadMapScroll.querySelectorAll("select[data-footprint-pad]").forEach((sel) => {
      const p = String(sel.dataset.footprintPad || "").trim();
      if (!p) return;
      map[p] = String(sel.value || K2C_GALLERY_PAD_NC);
    });
    return map;
  }

  /**
   * @param {HTMLElement} container
   * @param {{ pins?: Array<{ number?: string, name?: string }>, placeholder?: string }} opts
   */
  function renderTemplatePinTable(container, opts) {
    const o = opts || {};
    container.textContent = "";
    if (o.placeholder) {
      const d = document.createElement("div");
      d.textContent = o.placeholder;
      d.style.cssText = cssJoin([
        "font-size:12px",
        `color:${"#94a3b8"}`,
        "line-height:1.4",
        "padding:4px 2px",
      ]);
      container.appendChild(d);
      return;
    }
    const pins = Array.isArray(o.pins) ? o.pins : [];
    if (pins.length === 0) {
      const d = document.createElement("div");
      d.textContent = "No pins in this symbol.";
      d.style.cssText = cssJoin([
        "font-size:12px",
        `color:${"#94a3b8"}`,
        "line-height:1.4",
        "padding:4px 2px",
      ]);
      container.appendChild(d);
      return;
    }
    const table = document.createElement("table");
    table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;";
    const thead = document.createElement("thead");
    const thr = document.createElement("tr");
    ["Pin", "Name"].forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      th.style.cssText = cssJoin([
        "text-align:left",
        "padding:4px 6px 6px",
        `color:${"#64748b"}`,
        "font-weight:600",
        "font-size:10px",
        "text-transform:uppercase",
        "letter-spacing:0.04em",
        `border-bottom:1px solid ${"#e2e8f0"}`,
      ]);
      thr.appendChild(th);
    });
    thead.appendChild(thr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    pins.forEach((p) => {
      const rawN = p && p.number != null ? String(p.number).trim() : "";
      const rawNm = p && p.name != null ? String(p.name).trim() : "";
      const tr = document.createElement("tr");
      tr.className = "k2c-tpl-pin-row";
      const tdN = document.createElement("td");
      tdN.textContent = rawN || "—";
      tdN.style.cssText = cssJoin([
        "padding:5px 6px",
        `border-bottom:1px solid ${"#f1f5f9"}`,
        `color:${"#0f172a"}`,
        "font-weight:700",
        "font-variant-numeric:tabular-nums",
      ]);
      const tdNm = document.createElement("td");
      const showName = rawNm && rawNm !== "~";
      tdNm.textContent = showName ? rawNm : "—";
      tdNm.style.cssText = cssJoin([
        "padding:5px 6px",
        `border-bottom:1px solid ${"#f1f5f9"}`,
        `color:${"#334155"}`,
        "word-break:break-word",
      ]);
      tr.appendChild(tdN);
      tr.appendChild(tdNm);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  /**
   * @param {{ loading?: boolean, subtext?: string }} [loadOpts]
   */
  function setSvgHost(host, svgStr, emptyMsg, loadOpts) {
    host.innerHTML = "";
    if (!svgStr || typeof svgStr !== "string") {
      if (loadOpts && loadOpts.loading) {
        mountGalleryPreviewLoading(
          host,
          emptyMsg || "Loading…",
          loadOpts.subtext || "",
        );
      } else {
        const t = document.createElement("div");
        t.textContent = emptyMsg || "Preview unavailable";
        t.style.cssText = cssJoin([
          "font-size:12px",
          `color:${"#64748b"}`,
          "padding:8px",
          "text-align:center",
        ]);
        host.appendChild(t);
      }
      return;
    }
    const wrap = document.createElement("div");
    wrap.style.cssText = cssJoin([
      "position:absolute",
      "inset:0",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "box-sizing:border-box",
      "width:100%",
      "min-width:0",
      "min-height:0",
      "padding:2px",
    ]);
    const img = document.createElement("img");
    img.alt = "";
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`;
    img.style.cssText = cssJoin([
      "display:block",
      "width:100%",
      "height:100%",
      "max-width:100%",
      "max-height:100%",
      "min-width:0",
      "min-height:0",
      "flex-shrink:1",
      "object-fit:contain",
      "object-position:center",
      "box-sizing:border-box",
    ]);
    wrap.appendChild(img);
    host.appendChild(wrap);
  }

  async function loadSymbolForItem(item) {
    symbolPreviewBusy = true;
    updateGalleryStatusBar();
    gallerySymbolPinsForPadMap = [];
    setSvgHost(symHost, null, "Loading symbol preview…", {
      loading: true,
      subtext: "Rendering template from your .kicad_sym library",
    });
    renderTemplatePinTable(pinTableScroll, { placeholder: "Loading…" });
    refreshGalleryFootprintPadMap();
    syncGalleryContinueButton();
    try {
      const key = `${item.libPath}\n${item.name}${K2C_GALLERY_SYMBOL_SVG_CACHE_TAG}\npt:${previewTheme}`;
      const cached = templateSvgPreviewCache.get(key);
      if (cached && cached.svg && Array.isArray(cached.pins)) {
        gallerySymbolPinsForPadMap = cached.pins;
        setSvgHost(symHost, cached.svg, "No preview");
        renderTemplatePinTable(pinTableScroll, { pins: cached.pins });
        refreshGalleryFootprintPadMap();
        return;
      }
      if (cached && cached.svg && !Array.isArray(cached.pins)) {
        templateSvgPreviewCache.delete(key);
      }
      try {
        const resp = await contentRpc(
          "templatesPreviewSvg",
          {
            templateName: item.name,
            templateLibPath: item.libPath,
            labelPins: true,
            drawPinNames: true,
            previewTheme,
          },
          k2cRpc(1, 400),
        );
        if (resp?.ok && resp.data?.ok && typeof resp.data.svg === "string") {
          const pins = Array.isArray(resp.data.pins) ? resp.data.pins : [];
          templateSvgPreviewCache.set(key, { svg: resp.data.svg, pins });
          gallerySymbolPinsForPadMap = pins;
          setSvgHost(symHost, resp.data.svg, "No preview");
          renderTemplatePinTable(pinTableScroll, { pins });
          refreshGalleryFootprintPadMap();
        } else {
          const detail =
            (resp?.data && (resp.data.error || resp.data.message)) || "Preview unavailable";
          gallerySymbolPinsForPadMap = [];
          setSvgHost(symHost, null, String(detail));
          renderTemplatePinTable(pinTableScroll, { placeholder: "—" });
          refreshGalleryFootprintPadMap();
        }
      } catch (err) {
        gallerySymbolPinsForPadMap = [];
        setSvgHost(symHost, null, err?.message || "Preview failed");
        renderTemplatePinTable(pinTableScroll, { placeholder: "—" });
        refreshGalleryFootprintPadMap();
      }
    } finally {
      symbolPreviewBusy = false;
      updateGalleryStatusBar();
    }
  }

  function selectItem(item, row) {
    const same =
      selectedItem
      && String(selectedItem.name) === String(item.name)
      && String(selectedItem.libPath) === String(item.libPath);
    if (selectedRow) {
      selectedRow.style.background = "";
      selectedRow.style.outline = "";
    }
    selectedItem = item;
    selectedRow = row;
    row.style.background = "#dbeafe";
    row.style.outline = `1px solid ${"#1166dd"}`;
    syncGalleryContinueButton();
    if (!same) {
      void loadSymbolForItem(item);
    }
  }

  function renderTemplateListAwaitingPins() {
    list.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.style.cssText = cssJoin([
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      "gap:12px",
      "padding:28px 16px",
      "text-align:center",
      "min-height:120px",
      "box-sizing:border-box",
    ]);
    const sp = document.createElement("span");
    sp.className = "k2c-tpl-spinner";
    sp.style.display = "inline-block";
    const t1 = document.createElement("div");
    t1.textContent = "Resolving pin counts…";
    t1.style.cssText = cssJoin(["font-size:13px", "font-weight:600", `color:${"#334155"}`]);
    const t2 = document.createElement("div");
    t2.textContent =
      "Templates appear here once each KiCad symbol is compared to this LCSC part. You can pick one then — no second load replacing the list.";
    t2.style.cssText = cssJoin([
      "font-size:12px",
      `color:${"#64748b"}`,
      "line-height:1.45",
      "max-width:232px",
    ]);
    wrap.appendChild(sp);
    wrap.appendChild(t1);
    wrap.appendChild(t2);
    list.appendChild(wrap);
  }

  /**
   * @param {string} query
   * @param {{ preserveSelectionKey?: string | null }} [opts]
   *   If the same lib/name key is still visible after filter, keep that row selected (no duplicate preview fetch).
   */
  function filterList(query, opts = {}) {
    cancelTemplateHoverInteraction();
    const preserveKey =
      typeof opts.preserveSelectionKey === "string" && opts.preserveSelectionKey.length > 0
        ? opts.preserveSelectionKey
        : null;
    const q = (query || "").trim().toLowerCase();
    const pinCompatOnly = pinCompatFilterInput.checked;
    let afterPin = allItems;
    if (pinCompatOnly) {
      afterPin = allItems.filter((it) => {
        const pinKey = `${it.libPath}\n${it.name}`;
        const pinInfo = templatePinMismatch.get(pinKey);
        if (!pinInfo) {
          return true;
        }
        return Boolean(pinInfo.match);
      });
    }
    const filtered = q
      ? afterPin.filter((it) => it.name.toLowerCase().includes(q))
      : afterPin;
    list.innerHTML = "";
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      if (afterPin.length === 0 && allItems.length > 0 && pinCompatOnly) {
        empty.textContent = q
          ? "No pin-compatible templates match your search."
          : "No pin-compatible templates. Uncheck Pin-compatible only to show mismatched symbols.";
      } else {
        empty.textContent = "No matching templates";
      }
      empty.style.cssText = cssJoin([
        "padding:20px 12px",
        "text-align:center",
        "font-size:12px",
        `color:${"#94a3b8"}`,
      ]);
      list.appendChild(empty);
      selectedItem = null;
      selectedRow = null;
      setSvgHost(symHost, null, "No template selected");
      gallerySymbolPinsForPadMap = [];
      renderTemplatePinTable(pinTableScroll, { placeholder: "Select a template" });
      refreshGalleryFootprintPadMap();
      return;
    }
    filtered.forEach((item) => {
      const row = document.createElement("button");
      row.type = "button";
      row.setAttribute("role", "option");
      row._galleryItem = item;
      row.style.cssText = cssJoin([
        "display:block",
        "width:100%",
        "text-align:left",
        "padding:8px 10px",
        "margin:0 0 4px 0",
        "border:none",
        "border-radius:8px",
        "cursor:pointer",
        "background:transparent",
        "font:inherit",
        `color:${"#0f172a"}`,
        "box-sizing:border-box",
      ]);
      const nameLine = document.createElement("span");
      nameLine.style.cssText = cssJoin([
        "display:block",
        "font-weight:600",
        "font-size:13px",
        `color:${"#0f172a"}`,
        "line-height:1.25",
        "white-space:nowrap",
        "overflow:hidden",
        "text-overflow:ellipsis",
        "flex:1",
        "min-width:0",
      ]);
      nameLine.textContent = item.name;
      const nameRow = document.createElement("div");
      nameRow.style.cssText = "display:flex;align-items:center;gap:4px;min-width:0;width:100%;";
      nameRow.appendChild(nameLine);
      const pinKey = `${item.libPath}\n${item.name}`;
      const pinInfo = templatePinMismatch.get(pinKey);
      if (pinInfo && !pinInfo.match) {
        const bang = document.createElement("span");
        bang.textContent = "!";
        bang.style.cssText = cssJoin([
          "flex-shrink:0",
          "font-weight:800",
          `color:${"#b45309"}`,
          "font-size:15px",
          "line-height:1",
          "width:1em",
          "text-align:center",
        ]);
        const tp = pinInfo.template;
        if (typeof tp === "number" && tp < 0) {
          bang.title = "Could not load this template to count pins.";
        } else {
          const ee = pinInfo.easyeda;
          bang.title = `Pin count mismatch: LCSC part has ${ee} pin(s); this template has ${tp}.`;
        }
        bang.setAttribute("aria-label", bang.title);
        nameRow.appendChild(bang);
      }
      const libLine = document.createElement("span");
      libLine.style.cssText = cssJoin([
        "display:block",
        "margin-top:3px",
        "font-size:11px",
        "font-weight:500",
        `color:${"#64748b"}`,
        "line-height:1.2",
        "white-space:nowrap",
        "overflow:hidden",
        "text-overflow:ellipsis",
      ]);
      libLine.textContent = item.libName;
      row.appendChild(nameRow);
      row.appendChild(libLine);
      row.title = `${item.name} — ${item.libName}`;
      row.addEventListener("click", () => selectItem(item, row));
      list.appendChild(row);
    });
    let chosen = null;
    let chosenItem = null;
    if (preserveKey) {
      for (const btn of list.querySelectorAll('button[role="option"]')) {
        const gi = btn._galleryItem;
        if (!gi) continue;
        const k = `${gi.libPath}\n${gi.name}`;
        if (k === preserveKey) {
          chosen = btn;
          chosenItem = gi;
          break;
        }
      }
    }
    if (chosen && chosenItem) {
      selectItem(chosenItem, chosen);
    } else {
      const first = list.querySelector('button[role="option"]');
      if (first && first._galleryItem) {
        selectItem(first._galleryItem, first);
      }
    }
  }

  updateGalleryStatusBar();
  mountFootprintPreviewInHost(fpHost, fpPadHint, null, "Loading footprint…", {
    interactive: false,
    loading: true,
  });
  refreshGalleryFootprintPadMap();

  useBtn.addEventListener("click", () => {
    if (!selectedItem) return;
    const galleryPadToSymbolPin = readGalleryPadToSymbolMap();
    closeTemplateGalleryModal();
    void onTemplateSelected(anchorButton, lcscId, selectedItem.name, selectedItem.libPath, {
      galleryPadToSymbolPin,
      templatePreflightOverrides,
    });
  });

  function filterListPreserveSelection() {
    const pk =
      selectedItem && selectedItem.libPath != null && selectedItem.name != null
        ? `${selectedItem.libPath}\n${selectedItem.name}`
        : null;
    filterList(searchBox.value || "", { preserveSelectionKey: pk });
  }
  searchBox.addEventListener("input", () => filterListPreserveSelection());
  searchBox.addEventListener("click", (e) => e.stopPropagation());
  pinCompatFilterInput.addEventListener("change", () => filterListPreserveSelection());

  body.appendChild(leftCol);
  body.appendChild(centerCol);
  body.appendChild(rightCol);
  shell.appendChild(header);
  shell.appendChild(statusBar);
  shell.appendChild(body);
  shell.appendChild(footer);
  overlay.appendChild(shell);

  function onEsc(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeTemplateGalleryModal();
    }
  }
  overlay._easyeda2kicadGalleryEsc = onEsc;
  document.addEventListener("keydown", onEsc, true);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeTemplateGalleryModal();
  });

  document.body.appendChild(overlay);

  renderTemplateListAwaitingPins();
  searchBox.disabled = true;
  pinCompatFilterInput.disabled = true;
  setSvgHost(symHost, null, "Waiting for template pin counts…", {
    loading: true,
    subtext: "The template list unlocks when the server finishes comparing pins.",
  });
  renderTemplatePinTable(pinTableScroll, { placeholder: "Waiting for pin data…" });
  refreshGalleryFootprintPadMap();
  updateGalleryStatusBar();

  void (async () => {
    try {
      const resp = await contentRpc("lcscFootprintPreview", { lcscId }, k2cRpc(2, 400));
      if (resp?.ok && resp.data?.footprint_svg) {
        galleryFootprintPads = Array.isArray(resp.data.pads) ? resp.data.pads : [];
        mountFootprintPreviewInHost(fpHost, fpPadHint, resp.data.footprint_svg, "No footprint preview", {
          interactive: false,
          padMapUi: true,
          onPadPick: focusGalleryPadMapSelect,
        });
        const fn = (resp.data.footprint_name && String(resp.data.footprint_name).trim()) || "";
        if (fn) {
          fpCap.textContent = `Footprint · ${fn}`;
        }
        refreshGalleryFootprintPadMap();
      } else {
        galleryFootprintPads = [];
        mountFootprintPreviewInHost(
          fpHost,
          fpPadHint,
          null,
          resp?.error || "Footprint preview unavailable",
          { interactive: false },
        );
        refreshGalleryFootprintPadMap();
      }
    } catch (err) {
      galleryFootprintPads = [];
      mountFootprintPreviewInHost(fpHost, fpPadHint, null, err?.message || "Footprint preview failed", {
        interactive: false,
      });
      refreshGalleryFootprintPadMap();
    } finally {
      loadTracks.footprint = true;
      updateGalleryStatusBar();
    }
  })();

  void (async () => {
    try {
      const resp = await contentRpc(
        "templatesGalleryPinSummary",
        {
          lcscId,
          templates: allItems.map((it) => ({
            templateName: it.name,
            templateLibPath: it.libPath,
          })),
        },
        k2cRpc(1, 600),
      );
      if (resp?.ok && resp.data && Array.isArray(resp.data.entries)) {
        for (const e of resp.data.entries) {
          const lp = String(e.template_lib_path || "").trim();
          const nm = String(e.template_name || "").trim();
          if (!lp || !nm) continue;
          templatePinMismatch.set(`${lp}\n${nm}`, {
            match: Boolean(e.match),
            easyeda: resp.data.easyeda_pin_count,
            template: e.template_pin_count,
          });
        }
      }
    } catch (_e) {
      dbg("templatesGalleryPinSummary", _e);
    } finally {
      loadTracks.pinSummary = true;
      searchBox.disabled = false;
      pinCompatFilterInput.disabled = false;
      const pk =
        selectedItem && selectedItem.libPath != null && selectedItem.name != null
          ? `${selectedItem.libPath}\n${selectedItem.name}`
          : null;
      filterList(searchBox.value || "", { preserveSelectionKey: pk });
      updateGalleryStatusBar();
      try {
        searchBox.focus();
      } catch (_fe) {
        /* ignore */
      }
    }
  })();
}

async function onTemplateSelected(button, lcscId, templateName, templateLibPath, flowOpts) {
  const galleryFlow = flowOpts && typeof flowOpts === "object" ? flowOpts : {};
  const padMap =
    galleryFlow.galleryPadToSymbolPin && typeof galleryFlow.galleryPadToSymbolPin === "object"
      ? galleryFlow.galleryPadToSymbolPin
      : {};
  const pre = galleryFlow.templatePreflightOverrides;
  let status;
  try {
    status = await contentRpc("getState", {}, k2cRpc(2, 200));
    if (!status?.ok || !status?.data || status.data.connected !== true) {
      showBackendOfflineUIForButton(button);
      return;
    }
    if (!status.data.importDestReady) {
      const group = document.getElementById(BTN_GROUP_ID);
      if (group && btnGroupHostContains(group, button)) {
        setGroupNoImportLibrary();
      } else {
        updateButtonState(button, "error", { message: MSG_NO_IMPORT_LIB_TITLE });
      }
      return;
    }
  } catch (_e) {
    showBackendOfflineUIForButton(button);
    return;
  }

  const templatePinMap = buildTemplatePinMapFromGalleryPadMap(padMap);
  const dl = {
    useTemplate: true,
    templateName,
    templateLibPath,
    forceTemplate: false,
    skipLibraryAndCategoryGates: true,
  };
  if (Object.keys(templatePinMap).length > 0) {
    dl.templatePinMap = templatePinMap;
  }
  if (pre && typeof pre === "object") {
    if (pre.overwrite === true) dl.overwrite = true;
    if (pre.overwrite_model === true) dl.overwrite_model = true;
    if (pre.categoryConfigOverride != null) {
      dl.categoryConfigOverride = pre.categoryConfigOverride;
    }
  }
  void handleDownloadClick(button, lcscId, dl);
}

/** LCSC product table: caption + buttons (Vuetify often forces light text on <td>). */
function styleLightTableCaption(textEl, msgEl) {
  if (textEl) {
    textEl.style.setProperty("color", CS_DIALOG.slate900, "important");
  }
  if (msgEl) {
    msgEl.style.setProperty("color", CS_DIALOG.slate900, "important");
  }
}

/**
 * @param {object} existingOverrides Passed through to the resumed download (template options, etc.).
 * @param {{ onResumeAfterOverwrite?: (merged: object) => void }} [dialogOptions]
 *   If set (template preflight), Override does not call {@link handleDownloadClick}; it calls this
 *   with merged flags so the caller can run category gates and open the template gallery.
 */
function showOverwriteDialog(button, lcscId, pageData, existingOverrides, dialogOptions) {
  const { row } = getProgressElements();
  const isProductPage = Boolean(row);

  const msgText = formatStatusColon("Part already in library", "overwrite?");
  const resumeOnly = typeof dialogOptions?.onResumeAfterOverwrite === "function";
  const onResumeAfterOverwrite = dialogOptions?.onResumeAfterOverwrite;
  const templateNote =
    existingOverrides && existingOverrides.useTemplate && !resumeOnly
      ? " Your template and symbol ↔ pad map will be applied to this import."
      : "";

  const runDownload = (extraOverrides) => {
    if (row) {
      row.querySelector(".easyeda2kicad-overwrite-dialog")?.remove();
      row.style.display = "";
    } else if (overlay) {
      overlay.remove();
      unlockOverlayPageScroll();
    }
    const merged = { ...existingOverrides, ...extraOverrides };
    if (resumeOnly) {
      onResumeAfterOverwrite(merged);
    } else {
      handleDownloadClick(button, lcscId, merged);
    }
  };

  const restoreExists = () => {
    if (!isProductPage && overlay) {
      overlay.remove();
      unlockOverlayPageScroll();
    }
    const libName = button.dataset.libraryName || null;
    const libPath = button.dataset.libraryPath || null;
    updateButtonState(button, "exists", {
      message: MSG_LIBRARY_TITLE,
      libraryName: libName || undefined,
      libraryPath: libPath || undefined,
    });
    markGroupExists(button, MSG_LIBRARY_TITLE);
  };

  if (isProductPage) {
    row.style.display = "";
    if (row.querySelector(".easyeda2kicad-overwrite-dialog")) return;
    const track = document.getElementById("easyeda2kicad-progress-track");
    const bar = document.getElementById("easyeda2kicad-progress-bar");
    const text = document.getElementById("easyeda2kicad-status-text");
    if (bar) {
      bar.className = "easyeda2kicad-pin-mismatch";
      bar.style.width = "100%";
    }
    if (text) {
      text.className = "easyeda2kicad-status-text k2c-status-progress";
      text.innerHTML = "";
      const msg = document.createElement("span");
      msg.textContent = msgText + templateNote;
      styleLightTableCaption(text, msg);
      text.appendChild(msg);
      const btnWrap = document.createElement("div");
      btnWrap.className = "easyeda2kicad-overwrite-dialog";
      btnWrap.style.cssText =
        "display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;justify-content:center;align-items:center;width:100%;";
      const btnOverride = document.createElement("button");
      btnOverride.type = "button";
      btnOverride.textContent = "Override";
      btnOverride.style.cssText = dialogButtonStyle("primary", "dense");
      const btnPermanent = document.createElement("button");
      btnPermanent.type = "button";
      btnPermanent.textContent = "Permanent override";
      btnPermanent.style.cssText = dialogButtonStyle("outline", "dense");
      const btnCancel = document.createElement("button");
      btnCancel.type = "button";
      btnCancel.textContent = "Cancel";
      btnCancel.style.cssText = dialogButtonStyle("secondary", "dense");
      btnOverride.addEventListener("click", () => runDownload({ overwrite: true, overwrite_model: true }));
      btnPermanent.addEventListener("click", async () => {
        try {
          await contentRpc("updateSettings", { overwriteFootprints: true, overwriteModels: true });
        } catch (_e) {}
        runDownload({});
      });
      btnCancel.addEventListener("click", restoreExists);
      btnWrap.appendChild(btnOverride);
      btnWrap.appendChild(btnPermanent);
      btnWrap.appendChild(btnCancel);
      text.appendChild(btnWrap);
    }
    return;
  }

  const overlay = document.createElement("div");
  overlay.style.cssText = CSS_MODAL_OVERLAY_STANDARD;
  const box = document.createElement("div");
  box.style.cssText = cssModalPanelLight(340);
  const titleEl = document.createElement("h3");
  titleEl.style.cssText = `margin:0 0 8px 0;font-size:15px;font-weight:600;letter-spacing:-0.015em;color:${CS_DIALOG.panelText};`;
  titleEl.textContent = "Part already in library";
  const detailEl = document.createElement("p");
  detailEl.style.cssText = `margin:0 0 16px 0;font-size:13px;color:${CS_DIALOG.panelMuted};line-height:1.45;`;
  detailEl.textContent =
    "This part may already exist in your active library. Override this download, enable permanent overwrite, or cancel."
    + templateNote;
  const btnWrap = document.createElement("div");
  btnWrap.style.cssText =
    "display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;justify-content:flex-start;align-items:center;width:100%;";
  const btnOverride = document.createElement("button");
  btnOverride.type = "button";
  btnOverride.textContent = "Override";
  btnOverride.style.cssText = dialogButtonStyle("primary", "wide");
  const btnPermanent = document.createElement("button");
  btnPermanent.type = "button";
  btnPermanent.textContent = "Permanent override";
  btnPermanent.style.cssText = dialogButtonStyle("outline", "wide");
  const btnCancel = document.createElement("button");
  btnCancel.type = "button";
  btnCancel.textContent = "Cancel";
  btnCancel.style.cssText = dialogButtonStyle("secondary", "wide");
  btnOverride.addEventListener("click", () => runDownload({ overwrite: true, overwrite_model: true }));
  btnPermanent.addEventListener("click", async () => {
    try {
      await contentRpc("updateSettings", { overwriteFootprints: true, overwriteModels: true });
    } catch (_e) {}
    runDownload({});
  });
  btnCancel.addEventListener("click", restoreExists);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) restoreExists(); });
  btnWrap.appendChild(btnOverride);
  btnWrap.appendChild(btnPermanent);
  btnWrap.appendChild(btnCancel);
  box.appendChild(titleEl);
  box.appendChild(detailEl);
  box.appendChild(btnWrap);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  lockOverlayPageScroll();
}

function attachButton(lcscId) {
  if (document.getElementById(BTN_GROUP_ID)) {
    dbg("attachButton: product button group already present");
    ensureProductProgressRow();
    return true;
  }

  // Float-host: fixed-position panel on <body>. No LCSC table dependency.
  const groupDiv = document.createElement("div");
  groupDiv.id = BTN_GROUP_ID;
  groupDiv.style.cssText = buildFloatHostStyle();
  backendOnlineMonitorLcscId = lcscId;
  backendOnlineMonitorGroupDiv = groupDiv;

  // Small heading so the panel reads as ours when LCSC content scrolls past.
  const heading = document.createElement("div");
  heading.id = `${BTN_GROUP_ID}-heading`;
  heading.textContent = "KiCad";
  heading.style.cssText = [
    "font-size:11px",
    "font-weight:600",
    "letter-spacing:0.04em",
    "text-transform:uppercase",
    "color:#475569",
    "margin:0 0 6px 2px",
  ].join(";");
  groupDiv.appendChild(heading);

  const mount = ensureProductBtnGroupShadow(groupDiv);

  // Render buttons immediately (fast UX). refreshButtonGroup will rebuild with correct states.
  const templatePlaceholder = createDlButton(DL_SUB_TEMPLATE, { primary: false });
  templatePlaceholder.dataset.lcscId = lcscId;
  setButtonDisabledPlaceholder(templatePlaceholder, formatStatusColon("Backend", "checking"));
  templatePlaceholder.addEventListener("click", () => {});
  mount.appendChild(templatePlaceholder);

  const button = createDlButton(DL_SUB_EASYEDA, { primary: true });
  button.dataset.lcscId = lcscId;
  setButtonDisabledPlaceholder(button, formatStatusColon("Backend", "checking"));
  // Use `onclick` only — `refreshButtonGroup` assigns the real handler; `addEventListener`
  // would stack and fire twice per click (double job enqueue).
  button.onclick = () => handleDownloadClick(button, lcscId, { useTemplate: false });
  button.dataset[INIT_ATTR] = "false";
  mount.appendChild(button);

  document.body.appendChild(groupDiv);
  ensureProductProgressRow();

  // Defer expensive "exists" checks to refreshButtonGroup() to keep UI responsive.
  refreshButtonGroup(lcscId, groupDiv);
  dbg("attachButton: float panel attached", lcscId);
  return true;
}

function setButtonOfflineNoBackend(button) {
  const group = document.getElementById(BTN_GROUP_ID);
  if (group && btnGroupHostContains(group, button)) {
    setGroupBackendOffline();
  } else {
    updateButtonState(button, "offline", { message: MSG_BACKEND_OFFLINE });
  }
}

/** LCSC attribute keys for the category / value-parameter dialog. */
function paramKeysFromPageData(pageData) {
  const opts = pageData.valueParamOptions;
  return opts && opts.length ? opts : Object.keys(pageData.params || {});
}

/**
 * @param {{ value: object | null }} catCfgRef mutable — "Continue only" config or null after save/skip
 */
function createCategoryDialogCallbacks(catCfgRef, resolve) {
  return {
    onSaveAndContinue: async (payload) => {
      const {
        category: savePath,
        hidePinNumbers,
        hidePinNames,
        valueParam,
      } = payload || {};
      const cat = normalizeCategoryPath(savePath || "");
      try {
        await contentRpc("saveCategorySettings", {
          category: cat,
          config: { hidePinNumbers, hidePinNames, valueParam },
        });
      } catch (_err) {
        dbg("saveCategorySettings failed", _err);
      }
      catCfgRef.value = null;
      resolve({ cancelled: false });
    },
    onContinueOnly: (payload) => {
      const { hidePinNumbers, hidePinNames, valueParam } = payload || {};
      catCfgRef.value = { hidePinNumbers, hidePinNames, valueParam };
      resolve({ cancelled: false });
    },
    onSkip: () => {
      catCfgRef.value = null;
      resolve({ cancelled: false });
    },
    onCancel: () => resolve({ cancelled: true }),
  };
}

function openCategoryDialogPromise(category, pageData, catCfgRef) {
  return new Promise((resolve) => {
    showCategoryDialog(
      category,
      paramKeysFromPageData(pageData),
      createCategoryDialogCallbacks(catCfgRef, resolve),
    );
  });
}

/**
 * Pre-``quickDownload`` prompts (EasyEDA and template **before** the gallery):
 * no-parameters fallback → saved value-param mismatch → **New category** (unknown path) last.
 * @returns {Promise<boolean>} true if the caller should abort the download pipeline
 */
async function runPreDownloadCategoryGates(button, lcscId, pageData, catCfg) {
  let categoryDialogShown = false;

  const valueFallback = async () => {
    if (!needsValueParamFromPage(pageData) || categoryDialogShown) return false;
    const fallbackResult = await promiseValueParamFallback();
    if (abortPreDownloadIf(button, lcscId, fallbackResult.mode === "cancel")) return true;
    if (fallbackResult.mode === "configure") {
      categoryDialogShown = true;
      const catLabel = pageData.category || "Uncategorized";
      const { cancelled } = await openCategoryDialogPromise(catLabel, pageData, catCfg);
      if (abortPreDownloadIf(button, lcscId, cancelled)) return true;
    }
    return false;
  };

  const valueMismatch = async () => {
    if (!pageData.category || needsValueParamFromPage(pageData) || categoryDialogShown) {
      return false;
    }
    try {
      const cfgResp = await contentRpc(
        "getCategorySettings",
        { category: pageData.category },
        k2cRpc(2, 200),
      );
      if (cfgResp?.ok) {
        const saved = cfgResp.data;
        const vp = saved && typeof saved.valueParam === "string" ? saved.valueParam.trim() : "";
        if (vp && !isConfiguredValueParamPresentOnPage(pageData, vp)) {
          const mismatchResult = await promiseValueParamMismatch(vp);
          if (abortPreDownloadIf(button, lcscId, mismatchResult.mode === "cancel")) return true;
          if (mismatchResult.mode === "configure") {
            categoryDialogShown = true;
            const { cancelled } = await openCategoryDialogPromise(pageData.category, pageData, catCfg);
            if (abortPreDownloadIf(button, lcscId, cancelled)) return true;
          }
        }
      }
    } catch (_err) {
      dbg("getCategorySettings / value param mismatch flow failed", _err);
    }
    return false;
  };

  const unknownCategory = async () => {
    if (!pageData.category || categoryDialogShown) return false;
    try {
      const knownResponse = await contentRpc(
        "checkCategoryKnown",
        { category: pageData.category },
        k2cRpc(2, 200),
      );
      const isKnown = knownResponse?.ok && knownResponse.data?.known;
      if (!isKnown) {
        categoryDialogShown = true;
        const { cancelled } = await openCategoryDialogPromise(pageData.category, pageData, catCfg);
        if (abortPreDownloadIf(button, lcscId, cancelled)) return true;
      }
    } catch (_err) {
      dbg("checkCategoryKnown failed", _err);
    }
    return false;
  };

  for (const step of [valueFallback, valueMismatch, unknownCategory]) {
    if (await step()) return true;
  }
  return false;
}

/**
 * After overwrite is resolved (or not needed): category/value gates, then template gallery.
 * @param {object} preOverwrite merged flags from overwrite dialog (may be empty).
 */
async function runTemplatePostOverwritePhase(
  templateBtn,
  groupDiv,
  lcscId,
  state,
  pageData,
  preOverwrite = {},
) {
  const catCfg = { value: null };
  if (await runPreDownloadCategoryGates(templateBtn, lcscId, pageData, catCfg)) {
    return;
  }
  openTemplateGallery(templateBtn, groupDiv, lcscId, state, {
    templatePreflightOverrides: {
      overwrite: preOverwrite.overwrite,
      overwrite_model: preOverwrite.overwrite_model,
      categoryConfigOverride: catCfg.value,
    },
  });
}

/**
 * Template button: library overwrite prompt → category gates → gallery (pick template + pad map).
 */
async function beginTemplateImportFlow(templateBtn, groupDiv, lcscId, state) {
  let status;
  try {
    status = await contentRpc("getState", {}, k2cRpc(2, 200));
    if (!status?.ok || !status.data) {
      throw new Error(status?.error || "Unable to reach extension backend.");
    }
    if (!status.data.connected) {
      setButtonOfflineNoBackend(templateBtn);
      return;
    }
    if (!status.data.importDestReady) {
      if (groupDiv && btnGroupHostContains(groupDiv, templateBtn)) {
        setGroupNoImportLibrary();
      } else {
        updateButtonState(templateBtn, "error", { message: MSG_NO_IMPORT_LIB_TITLE });
      }
      return;
    }
  } catch (_e) {
    setButtonOfflineNoBackend(templateBtn);
    return;
  }

  const pageData = extractPageData();
  const stateData = status.data;
  // Gate on symbol/footprint overwrite only (Settings → "Overwrite footprints & symbols").
  // 3D model overwrite is a separate toggle; disabling only footprints/symbols must still prompt.
  const askBeforeSymbolFootprintOverwrite = stateData
    ? !stateData.overwriteFootprints
    : false;

  let partExistsForOverwrite = templateBtn.dataset.libState === "exists";
  if (askBeforeSymbolFootprintOverwrite) {
    try {
      const existResp = await contentRpc(
        "checkComponentExists",
        { lcscId },
        k2cRpc(2, 250),
      );
      if (existResp?.ok && existResp.data) {
        const d = existResp.data;
        if (d.inProgress && d.jobId) {
          applyComponentState(templateBtn, d);
          return;
        }
        const analysis = d.outputAnalysis
          || computeOutputAnalysis({ outputs: d.outputs, result: d.result });
        partExistsForOverwrite = Boolean(d.completed && !analysis.partial);
      }
    } catch (_e) {
      dbg("beginTemplateImportFlow: checkComponentExists", _e);
    }
  }

  if (partExistsForOverwrite && askBeforeSymbolFootprintOverwrite) {
    showOverwriteDialog(templateBtn, lcscId, pageData, {}, {
      onResumeAfterOverwrite: (merged) => {
        void runTemplatePostOverwritePhase(
          templateBtn,
          groupDiv,
          lcscId,
          state,
          pageData,
          merged,
        );
      },
    });
    return;
  }

  await runTemplatePostOverwritePhase(templateBtn, groupDiv, lcscId, state, pageData, {});
}

// --- Download pipeline (gates → quickDownload RPC) ---
async function handleDownloadClick(button, lcscId, overrides = {}) {
  dbg("handleDownloadClick", lcscId, overrides);
  const skipLibraryAndCategoryGates = Boolean(overrides.skipLibraryAndCategoryGates);
  let status;
  try {
    status = await contentRpc("getState", {}, k2cRpc(2, 200));
    if (!status?.ok || !status.data) {
      throw new Error(status?.error || "Unable to reach extension backend.");
    }
    if (!status.data.connected) {
      setButtonOfflineNoBackend(button);
      return;
    }
    if (!status.data.importDestReady) {
      const group = document.getElementById(BTN_GROUP_ID);
      if (group && button && btnGroupHostContains(group, button)) {
        setGroupNoImportLibrary();
      } else {
        updateButtonState(button, "error", {
          message: MSG_NO_IMPORT_LIB_TITLE,
        });
      }
      return;
    }
  } catch (_error) {
    setButtonOfflineNoBackend(button);
    return;
  }

  const pageData = extractPageData();
  dbg("extractPageData", pageData);

  /**
   * EasyEDA: checkComponentExists → overwrite UI → category gates → quickDownload.
   * Template-from-gallery: gates already ran before the gallery; {@code skipLibraryAndCategoryGates}.
   */
  const useTemplate = Boolean(overrides.useTemplate);
  const stateData = status?.data;
  const askBeforeSymbolFootprintOverwrite = stateData
    ? !stateData.overwriteFootprints
    : false;
  const oneTimeOverwrite =
    overrides.overwrite === true || overrides.overwrite_model === true;

  /** "Continue only" mapping for this job; also accepts initial value from `overrides`. */
  let catCfg = { value: overrides.categoryConfigOverride ?? null };

  if (!skipLibraryAndCategoryGates) {
    let partExistsForOverwrite = button.dataset.libState === "exists";
    if (askBeforeSymbolFootprintOverwrite && !oneTimeOverwrite) {
      try {
        const existResp = await contentRpc(
          "checkComponentExists",
          { lcscId },
          k2cRpc(2, 250),
        );
        if (existResp?.ok && existResp.data) {
          const d = existResp.data;
          if (d.inProgress && d.jobId) {
            applyComponentState(button, d);
            return;
          }
          const analysis = d.outputAnalysis
            || computeOutputAnalysis({ outputs: d.outputs, result: d.result });
          partExistsForOverwrite = Boolean(d.completed && !analysis.partial);
        }
      } catch (_e) {
        dbg("handleDownloadClick: checkComponentExists (overwrite gate)", _e);
      }
    }

    if (partExistsForOverwrite && askBeforeSymbolFootprintOverwrite && !oneTimeOverwrite) {
      showOverwriteDialog(button, lcscId, pageData, overrides);
      return;
    }

    if (await runPreDownloadCategoryGates(button, lcscId, pageData, catCfg)) return;
  }

  const pendingMsg = useTemplate
    ? formatStatusColon("KiCad import", "creating part from template…")
    : formatStatusColon("Conversion", "submitting job");
  updateButtonState(button, "pending", { progress: 0, message: pendingMsg });
  try {
    const response = await contentRpc(
      "quickDownload",
      {
        lcscId,
        source: "contentScript",
        category: pageData.category,
        componentPackage: pageData.package,
        params: pageData.params,
        description: pageData.description,
        datasheetUrl: pageData.datasheetUrl,
        useTemplate,
        templateName: overrides.templateName || null,
        templateLibPath: overrides.templateLibPath || null,
        forceTemplate: overrides.forceTemplate || false,
        ...(useTemplate
          && overrides.templatePinMap
          && typeof overrides.templatePinMap === "object"
          && Object.keys(overrides.templatePinMap).length > 0
          ? { templatePinMap: overrides.templatePinMap }
          : {}),
        overwrite: overrides.overwrite,
        overwrite_model: overrides.overwrite_model,
        categoryConfigOverride: catCfg.value != null ? catCfg.value : null,
      },
      k2cRpc(4, 300),
    );
    if (!response?.ok) {
      dbg("handleDownloadClick: backend returned error", response);
      throw new Error(response?.error || "Unknown error");
    }
    const data = response.data || {};
    const jobId = data.jobId;
    if (jobId) {
      const prevWatch = button.dataset.k2cWatchJobId;
      if (prevWatch && prevWatch !== jobId) {
        jobState.clearWatcher(prevWatch);
        jobState.forgetUi(prevWatch);
      }
      jobState.forgetUi(jobId);
      button.dataset.k2cWatchJobId = jobId;
      applyJobStatusToButton(button, jobId, {
        status: data.status || "queued",
        progress: data.progress,
        message: data.message,
        queue_position: data.queue_position,
      });
      startJobWatcher(button, jobId);
    } else {
      updateButtonState(button, "progress", {
        progress: 0,
        phase: "queued",
        message: formatStatusColon(
          "Conversion",
          "job submitted — open extension popup if this stays stuck",
        ),
      });
    }
  } catch (error) {
    console.error("easyeda2kicad quick download failed", error);
    updateButtonState(button, "error", {
      message: formatStatusColon("Conversion failed", error.message || "unknown error"),
      copyText: `Error: ${error.message || "Unknown error"}\n\nLCSC: ${lcscId}\n${error.stack || ""}`.trim(),
    });
    dbg("handleDownloadClick: failed", lcscId, error);
  }
}

/** Terminal UI from WebSocket-driven state (no getJobStatus polling). */
function applyTerminalJobUI(button, jobId, job) {
  if (!button || !jobId || !job) return;
  if (jobState.isTerminalHandled(jobId)) return;
  jobState.markTerminal(jobId);
  setTimeout(() => jobState.forgetTerminal(jobId), 180000);
  jobState.forgetUi(jobId);
  jobState.clearWatcher(jobId);
  delete button.dataset.k2cWatchJobId;
  const messages = Array.isArray(job.messages)
    ? job.messages
    : (job.result?.messages || []);
  const analysis = job.outputAnalysis
    || computeOutputAnalysis({ outputs: job.outputs, result: job.result });
  if (job.status === "completed") {
    if (analysis.partial) {
      updateButtonState(button, "partial", {
        message: formatPartialImportMessage(messages, analysis.missing),
      });
    } else {
      const tooltip = buildSuccessTooltip(analysis, messages);
      updateButtonState(button, "success", {
        message: tooltip || undefined,
        libraryName: job.libraryName,
        libraryPath: job.libraryPath,
        celebrateJobId: jobId,
      });
    }
    return;
  }
  if (job.status === "failed") {
    updateButtonState(button, "error", {
      message: formatStatusColon("Conversion failed", job.message || "unknown error"),
      copyText: `Job failed: ${job.message || "Unknown error"}\n\nJob ID: ${jobId}\nStatus: ${job.status}\n${job.error || ""}`.trim(),
    });
  }
}

function startJobWatcher(button, jobId) {
  const prevBtnJob = button.dataset.k2cWatchJobId;
  if (prevBtnJob && prevBtnJob !== jobId) {
    jobState.clearWatcher(prevBtnJob);
    jobState.forgetUi(prevBtnJob);
  }
  button.dataset.k2cWatchJobId = jobId;
  jobState.setWatcher(jobId, true);
  dbg("startJobWatcher(ws push)", jobId);
}

function registerObserver(observer) {
  activeObservers.add(observer);
}

function cleanupObservers() {
  if (productAttachDebounceTimer != null) {
    clearTimeout(productAttachDebounceTimer);
    productAttachDebounceTimer = null;
  }
  activeObservers.forEach((observer) => observer.disconnect());
  activeObservers.clear();
}

/**
 * LCSC often re-renders the attributes table after load. If we only observe until the first
 * successful insert (or stop after 10s), the KiCad row disappears and never comes back.
 */
function scheduleProductPageAttachCheck(lcscId) {
  if (productAttachDebounceTimer != null) {
    return;
  }
  productAttachDebounceTimer = setTimeout(() => {
    productAttachDebounceTimer = null;
    try {
      if (!PRODUCT_REGEX.test(window.location.pathname || "")) {
        return;
      }
      const cur = extractLcscId();
      if (!cur || String(cur) !== String(lcscId)) {
        return;
      }
      const group = document.getElementById(BTN_GROUP_ID);
      if (group && group.isConnected) {
        ensureProductProgressRow();
        return;
      }
      attachButton(lcscId);
    } catch (_e) {
      // ignore
    }
  }, 200);
}

function cleanupInjectedUi() {
  // Float panel — single container holds buttons + progress + heading.
  const group = document.getElementById(BTN_GROUP_ID);
  if (group?.parentElement) {
    group.parentElement.removeChild(group);
  }
  // Legacy progress row (V2 table layout) — kept for graceful upgrade.
  const progressRow = document.getElementById(PRODUCT_PROGRESS_ROW_ID);
  if (progressRow?.parentElement && progressRow.parentElement !== group) {
    progressRow.parentElement.removeChild(progressRow);
  }
  jobState.reset();
  backendStatusMonitor.stop();
  if (importDestRefreshTimer) {
    clearTimeout(importDestRefreshTimer);
    importDestRefreshTimer = null;
  }
  lastBroadcastImportDestReady = null;
  backendOnlineMonitorLcscId = null;
  backendOnlineMonitorGroupDiv = null;
}

/** When LCSC’s Vue app paints after `document_idle`, retry inserting the KiCad row (MutationObserver covers most cases). */
const K2C_PRODUCT_ATTACH_RETRY_MS = 450;
const K2C_PRODUCT_ATTACH_MAX_ATTEMPTS = 40;

function scheduleDeferredProductAttach(lcscId, attempt = 0) {
  if (attempt >= K2C_PRODUCT_ATTACH_MAX_ATTEMPTS) {
    dbg("scheduleDeferredProductAttach: max attempts", lcscId);
    return;
  }
  window.setTimeout(() => {
    try {
      const path = window.location.pathname || "";
      if (!PRODUCT_REGEX.test(path)) {
        return;
      }
      const cur = extractLcscId();
      if (!cur || String(cur) !== String(lcscId)) {
        return;
      }
      if (document.getElementById(BTN_GROUP_ID)?.isConnected) {
        return;
      }
      if (attachButton(lcscId)) {
        dbg("scheduleDeferredProductAttach: attached on retry", attempt);
        return;
      }
      scheduleDeferredProductAttach(lcscId, attempt + 1);
    } catch (_e) {
      scheduleDeferredProductAttach(lcscId, attempt + 1);
    }
  }, K2C_PRODUCT_ATTACH_RETRY_MS);
}

function setupForCurrentRoute() {
  cleanupObservers();
  cleanupInjectedUi();

  const path = window.location.pathname || "";
  dbg("setupForCurrentRoute", path);

  if (PRODUCT_REGEX.test(path)) {
    const lcscId = extractLcscId();
    if (!lcscId) {
      dbg("product page but no lcsc id in url");
      return;
    }

    if (!attachButton(lcscId)) {
      dbg("attachButton: tbody not ready; deferred retries + observer");
      scheduleDeferredProductAttach(lcscId, 0);
    } else {
      dbg("product button inserted immediately");
    }

    const observer = new MutationObserver(() => {
      scheduleProductPageAttachCheck(lcscId);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    registerObserver(observer);
    return;
  }
}

/** Pathname + search only — Nuxt often `replaceState`s the same product URL with a new hash; full-href compares wiped our row via `cleanupInjectedUi`. */
function k2cRouteIdentity() {
  return `${window.location.pathname || ""}${window.location.search || ""}`;
}

let currentRouteIdentity = k2cRouteIdentity();

function scheduleRouteCheck() {
  const next = k2cRouteIdentity();
  if (next === currentRouteIdentity) {
    return;
  }
  currentRouteIdentity = next;
  setupForCurrentRoute();
}

function setupRouteListener() {
  const wrapHistory = (method) => {
    const original = history[method];
    history[method] = function wrappedHistory(...args) {
      const result = original.apply(this, args);
      scheduleRouteCheck();
      return result;
    };
  };
  wrapHistory("pushState");
  wrapHistory("replaceState");
  window.addEventListener("popstate", scheduleRouteCheck);
  window.addEventListener("hashchange", scheduleRouteCheck);
}

/**
 * Progress from `stateUpdate` (WebSocket pushes merged in the service worker).
 */
function syncWatchedJobUIFromExtensionState(extState) {
  const jobs = Array.isArray(extState?.jobs) ? extState.jobs : [];
  if (!jobs.length) return;
  const group = document.getElementById(BTN_GROUP_ID);
  if (!group) return;
  queryProductGroupButtons(group).forEach((btn) => {
    const jid = btn.dataset.k2cWatchJobId;
    if (!jid) return;
    const job = jobs.find((j) => j && j.id === jid);
    if (!job) return;
    const st = String(job.status || "").toLowerCase();
    if (st === "completed" || st === "failed") return;
    applyJobStatusToButton(btn, jid, job);
  });
}

/** If `jobTerminal` was missed, pick terminal rows up from `jobHistory`. */
function syncWatchedTerminalFromExtensionState(extState) {
  const hist = Array.isArray(extState?.jobHistory) ? extState.jobHistory : [];
  if (!hist.length) return;
  const group = document.getElementById(BTN_GROUP_ID);
  if (!group) return;
  const active = Array.isArray(extState?.jobs) ? extState.jobs : [];
  queryProductGroupButtons(group).forEach((btn) => {
    const jid = btn.dataset.k2cWatchJobId;
    if (!jid) return;
    if (active.some((j) => j && j.id === jid)) return;
    const job = hist.find((h) => h && h.id === jid);
    if (!job) return;
    const st = String(job.status || "").toLowerCase();
    if (st !== "completed" && st !== "failed") return;
    applyTerminalJobUI(btn, jid, job);
  });
}

function init() {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
      return;
    }
  } catch (_e) {
    return;
  }

  void initDebug();
  try {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "k2c-datasheet-fetch-progress") {
      const sink = k2cActiveDatasheetDownloadUi;
      if (
        sink
        && message.requestId === sink.requestId
        && typeof sink.onProgress === "function"
      ) {
        sink.onProgress(message.received, message.total);
      }
      return;
    }
    if (message?.type === "stateUpdate" && message.state) {
      const previous = debugEnabled;
      debugEnabled = Boolean(message.state.debugLogs);
      if (!previous && debugEnabled) {
        console.log("[easyeda2kicad] debug logs enabled");
      } else if (previous && !debugEnabled) {
        console.log("[easyeda2kicad] debug logs disabled");
      }
      const ready = message.state.importDestReady;
      if (typeof ready === "boolean" && ready !== lastBroadcastImportDestReady) {
        lastBroadcastImportDestReady = ready;
        if (backendOnlineMonitorLcscId && backendOnlineMonitorGroupDiv) {
          if (importDestRefreshTimer) clearTimeout(importDestRefreshTimer);
          importDestRefreshTimer = setTimeout(() => {
            importDestRefreshTimer = null;
            void refreshButtonGroup(backendOnlineMonitorLcscId, backendOnlineMonitorGroupDiv);
          }, 250);
        }
      }
      syncWatchedJobUIFromExtensionState(message.state);
      syncWatchedTerminalFromExtensionState(message.state);
    }
    if (message?.type === "jobTerminal" && message.jobId && message.job) {
      const group = document.getElementById(BTN_GROUP_ID);
      if (!group) return;
      queryProductGroupButtons(group).forEach((btn) => {
        if (btn.dataset.k2cWatchJobId === message.jobId) {
          applyTerminalJobUI(btn, message.jobId, message.job);
        }
      });
    }
  });

  setupRouteListener();
  setupForCurrentRoute();
  } catch (err) {
    console.error("[KiCad Importer] LCSC page script init failed:", err);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
