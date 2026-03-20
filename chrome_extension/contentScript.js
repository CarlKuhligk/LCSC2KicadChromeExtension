"use strict";

const BUTTON_ID = "easyeda2kicad-download-btn";
/** Modifier on the EasyEDA button; template uses TEMPLATE_DL_BTN_CLASS — layout is the same (see shadow CSS). */
const EASYEDA_DL_BTN_CLASS = "easyeda2kicad-dl-btn--easyeda";
const TEMPLATE_DL_BTN_CLASS = "easyeda2kicad-dl-btn--template";
/** Second-line label under "Download". */
const DL_SUB_EASYEDA = "EasyEDA";
const DL_SUB_TEMPLATE = "Template";
const BTN_GROUP_ID = "easyeda2kicad-btn-group";
/** Inner flex container inside the product button group's ShadowRoot (buttons mount here). */
const BTN_GROUP_MOUNT_CLASS = "easyeda2kicad-btn-mount";
const BUTTON_WRAPPER_ID = "easyeda2kicad-download-wrapper";
const CATEGORY_DIALOG_ID = "easyeda2kicad-category-dialog";
const VALUE_PARAM_FALLBACK_DIALOG_ID = "easyeda2kicad-value-param-fallback-dialog";
const VALUE_PARAM_MISMATCH_DIALOG_ID = "easyeda2kicad-value-param-mismatch-dialog";
const INIT_ATTR = "easyeda2kicadInitialized";
const PRODUCT_PROGRESS_ROW_ID = "easyeda2kicad-progress-row";

// =============================================================================
// In-page dialog theme (light panels on LCSC — tweak colors in CS_DIALOG only)
// =============================================================================

/** @param {string[]} parts */
function cssJoin(parts) {
  return parts.join(";");
}

/** Single source for modal/backdrop/button colors used by category & value-param dialogs. */
const CS_DIALOG = {
  overlayDim: "rgba(0,0,0,0.45)",
  overlaySlate: "rgba(15,23,42,0.4)",
  fontSans: "sans-serif",
  fontUi: 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
  panelBg: "#fff",
  panelText: "#1a1a1a",
  panelShadow: "0 8px 32px rgba(0,0,0,0.18)",
  btnNeutralBorder: "#ccc",
  btnSecondaryBg: "#f5f5f5",
  btnOutlineBg: "#fff",
  primaryBg: "#1f6feb",
  primaryColor: "#fff",
  outlineAccentBorder: "#1f6feb",
  outlineAccentColor: "#1f6feb",
  radius: "4px",
  /** Product-row overwrite bar (LCSC blue) */
  lcscBlue: "#1166dd",
  slate900: "#0f172a",
  slate800: "#1e293b",
  slate400: "#94a3b8",
  slate600: "#475569",
  slate700: "#334155",
  slate200: "#e2e8f0",
};

function cssModalPanelLight(maxWidthPx) {
  return cssJoin([
    `background:${CS_DIALOG.panelBg}`, "border-radius:8px", "padding:24px 28px",
    `max-width:${Number(maxWidthPx)}px`, "width:90%", `box-shadow:${CS_DIALOG.panelShadow}`,
    `color:${CS_DIALOG.panelText}`,
  ]);
}

/** @param {"secondary"|"outline"|"primary"} variant @param {"wide"|"dense"} density */
function dialogButtonStyle(variant, density) {
  const padH = density === "dense" ? "12px" : "16px";
  const fs = density === "dense" ? "12px" : "13px";
  const base = [
    `padding:7px ${padH}`,
    `border-radius:${CS_DIALOG.radius}`,
    "cursor:pointer",
    `font-size:${fs}`,
    "white-space:nowrap",
    "flex-shrink:0",
    "box-sizing:border-box",
  ];
  if (variant === "secondary") {
    return cssJoin([
      ...base,
      `border:1px solid ${CS_DIALOG.btnNeutralBorder}`,
      `background:${CS_DIALOG.btnSecondaryBg}`,
    ]);
  }
  if (variant === "outline") {
    if (density === "dense") {
      return cssJoin([
        ...base,
        `border:1px solid ${CS_DIALOG.outlineAccentBorder}`,
        `background:${CS_DIALOG.btnOutlineBg}`,
        `color:${CS_DIALOG.outlineAccentColor}`,
        "font-weight:500",
      ]);
    }
    return cssJoin([
      ...base,
      `border:1px solid ${CS_DIALOG.btnNeutralBorder}`,
      `background:${CS_DIALOG.btnOutlineBg}`,
    ]);
  }
  return cssJoin([
    ...base,
    "border:none",
    `background:${CS_DIALOG.primaryBg}`,
    `color:${CS_DIALOG.primaryColor}`,
    "font-weight:600",
  ]);
}

const CSS_MODAL_OVERLAY_STANDARD = cssJoin([
  "position:fixed", "top:0", "left:0", "width:100%", "height:100%",
  `background:${CS_DIALOG.overlayDim}`, "z-index:2147483647",
  "display:flex", "align-items:center", "justify-content:center",
  `font-family:${CS_DIALOG.fontSans}`,
]);

const CSS_MODAL_OVERLAY_MISMATCH = cssJoin([
  "position:fixed", "top:0", "left:0", "width:100%", "height:100%",
  `background:${CS_DIALOG.overlaySlate}`, "z-index:2147483647",
  "display:flex", "align-items:center", "justify-content:center",
  `font-family:${CS_DIALOG.fontUi}`,
  "padding:16px",
  "box-sizing:border-box",
]);

const K2C_DLG_BTN_LIGHT_PRIMARY = cssJoin([
  "padding:6px 12px", "border-radius:6px",
  `border:1px solid ${CS_DIALOG.lcscBlue}`, "background:#fff", `color:${CS_DIALOG.slate900}`,
  "cursor:pointer", "font-size:12px", "font-weight:600",
]);
const K2C_DLG_BTN_LIGHT_SECONDARY = cssJoin([
  "padding:6px 12px", "border-radius:6px",
  `border:1px solid ${CS_DIALOG.slate400}`, "background:#f8fafc", `color:${CS_DIALOG.slate800}`,
  "cursor:pointer", "font-size:12px", "font-weight:500",
]);

/**
 * Disable page scrolling behind modal overlays / template menu (refcount supports close→open chains).
 */
let overlayScrollLockDepth = 0;
let overlayScrollLockSaved = null;

function lockOverlayPageScroll() {
  if (overlayScrollLockDepth === 0) {
    const html = document.documentElement;
    const body = document.body;
    overlayScrollLockSaved = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyTouchAction: body.style.touchAction || "",
    };
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.touchAction = "none";
  }
  overlayScrollLockDepth += 1;
}

function unlockOverlayPageScroll() {
  if (overlayScrollLockDepth <= 0) return;
  overlayScrollLockDepth -= 1;
  if (overlayScrollLockDepth === 0 && overlayScrollLockSaved) {
    const s = overlayScrollLockSaved;
    document.documentElement.style.overflow = s.htmlOverflow;
    document.body.style.overflow = s.bodyOverflow;
    document.body.style.touchAction = s.bodyTouchAction;
    overlayScrollLockSaved = null;
  }
}

/** Param keys that typically hold the component name / part number; used as default "Value parameter" in the category dialog. */
const PREFERRED_VALUE_PARAM_KEYS = [
  "Manufacturer Part Number",
  "Mfr. Part #",
  "Part Number",
  "Part #",
  "MPN",
  "Model",
  "Product Name",
  "Name",
];
const SVG_NS = "http://www.w3.org/2000/svg";
const PRODUCT_REGEX = /\/product-detail\/(C\d+)(?:\.html)?/i;

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

const jobWatchers = new Map();
/** Same completed/failed job must not run terminal UI twice (duplicate poll / race). */
const terminalJobHandled = new Set();
/** One confetti burst per successful job id. */
const confettiDoneForJobId = new Set();
const activeObservers = new Set();
let spinnerStyleInjected = false;
let debugEnabled = false;
let currentUrl = window.location.href;
let backendOnlineMonitorTimer = null;
let backendOnlineMonitorLcscId = null;
let backendOnlineMonitorGroupDiv = null;
let backendOnlineMonitorAttempts = 0;

// =============================================================================
// Runtime messaging (content script ↔ service worker)
// =============================================================================

function sendRuntimeMessage(payload, { retries = 3, delay = 250 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      chrome.runtime.sendMessage(payload, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          const message = runtimeError.message || "Runtime messaging error";
          const normalized = message.toLowerCase();
          if (normalized.includes("extension context invalidated")) {
            reject(new Error("Extension updated or reloaded. Refresh the page and try again."));
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

function contentRpc(type, fields = {}, opts) {
  return sendRuntimeMessage({ type, ...fields }, opts);
}

function startBackendOnlineMonitor() {
  if (!backendOnlineMonitorLcscId || !backendOnlineMonitorGroupDiv) return;
  if (backendOnlineMonitorTimer) return;
  backendOnlineMonitorAttempts = 0;
  backendOnlineMonitorTimer = setInterval(async () => {
    try {
      const resp = await contentRpc("getState", {}, { retries: 2, delay: 200 });
      if (resp?.ok && resp.data?.connected) {
        backendOnlineMonitorAttempts += 1;
        refreshButtonGroup(backendOnlineMonitorLcscId, backendOnlineMonitorGroupDiv);

        // If templates are expected, wait until Template button appears.
        const templateSymbolsByLib = resp.data.templateSymbolsByLib || {};
        const shouldHaveTemplates = Object.keys(templateSymbolsByLib).length > 0
          && Object.values(templateSymbolsByLib).some((arr) => Array.isArray(arr) && arr.length > 0);
        if (shouldHaveTemplates) {
          const hasTemplateBtn = queryProductGroupButtons(backendOnlineMonitorGroupDiv).some(
            (b) => b.getAttribute("data-k2c-dl") === "template",
          );
          if (!hasTemplateBtn && backendOnlineMonitorAttempts < 6) {
            return;
          }
        }

        // Connected and UI refreshed; stop polling after a short stabilization.
        if (backendOnlineMonitorTimer) {
          clearInterval(backendOnlineMonitorTimer);
          backendOnlineMonitorTimer = null;
        }
      }
    } catch (_e) {
      // keep polling until backend comes online
    }
  }, 2500);
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

    /* !important: LCSC/Vue may set parent color to #fff; status line must stay dark/neutral (never white). */
    #easyeda2kicad-status-text.status-offline {
      color: #c2410c !important;
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
    const response = await contentRpc("getState", {}, { retries: 5, delay: 300 });
    if (response?.ok && response.data) {
      debugEnabled = Boolean(response.data.debugLogs);
      dbg("debug flag initial", debugEnabled);
    }
  } catch (_error) {
    // ignore
  }
}

function clearJobWatcher(jobId) {
  const entry = jobWatchers.get(jobId);
  if (typeof entry === "number") {
    clearTimeout(entry);
  }
  jobWatchers.delete(jobId);
}

/** Never regress UI (e.g. running → queued) when snapshots arrive out of order. */
const jobUiMonotone = new Map();

function forgetJobUi(jobId) {
  if (jobId) jobUiMonotone.delete(jobId);
}

function normalizeJobProgressValue(job) {
  const p = job?.progress ?? job?.Progress;
  if (typeof p === "number" && Number.isFinite(p)) return Math.max(0, Math.min(100, p));
  const n = Number(p);
  if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
  return null;
}

function classifyJobTier(job) {
  const s = String(job?.status || "").toLowerCase();
  if (s === "completed" || s === "failed") return 3;
  if (s === "running") return 2;
  if (s === "queued") return 1;
  return 0;
}

/** @returns {boolean} false if update should be skipped (stale regression). */
function shouldApplyJobUiUpdate(jobId, job) {
  if (!jobUiMonotone.has(jobId)) {
    jobUiMonotone.set(jobId, { maxTier: 0, maxProgress: 0 });
  }
  const st = jobUiMonotone.get(jobId);
  const tier = classifyJobTier(job);
  if (tier === 1 && st.maxTier >= 2) {
    dbg("jobUi: skip stale queued after running", jobId);
    return false;
  }
  const prog = normalizeJobProgressValue(job) ?? 0;
  if (tier === 2 && st.maxProgress >= 5 && prog === 0) {
    dbg("jobUi: skip running 0% after meaningful progress", jobId);
    return false;
  }
  st.maxTier = Math.max(st.maxTier, tier);
  if (tier === 2) st.maxProgress = Math.max(st.maxProgress, prog);
  return true;
}

/** Same pattern as {@link formatLibraryStatusMessage}: "Lead: detail". */
function formatStatusColon(lead, detail) {
  const d = detail != null ? String(detail).trim() : "";
  return d ? `${lead}: ${d}` : lead;
}

function formatJobStatusMessage(job) {
  const s = String(job?.status || "").toLowerCase();
  const qp = job?.queue_position != null ? Number(job.queue_position) : null;
  const prog = normalizeJobProgressValue(job);
  if (s === "queued") {
    if (Number.isFinite(qp) && qp > 1) return formatStatusColon("In queue", `position ${qp}`);
    return formatStatusColon("In queue", "waiting");
  }
  if (s === "running") {
    const serverMsg = typeof job.message === "string" && job.message.trim() ? job.message.trim() : "";
    const pctKnown = prog != null && Number.isFinite(prog);
    const pct = pctKnown ? Math.round(Math.max(0, Math.min(100, prog))) : null;
    if (pct != null) {
      if (serverMsg) return formatStatusColon("Converting", `${serverMsg} (${pct}%)`);
      return formatStatusColon("Converting", `${pct}%`);
    }
    return serverMsg ? formatStatusColon("Converting", serverMsg) : formatStatusColon("Converting", "waiting");
  }
  return formatStatusColon("Status", "working");
}

function progressBarFieldsFromJob(job) {
  const s = String(job?.status || "").toLowerCase();
  const prog = normalizeJobProgressValue(job);
  if (s === "queued") {
    return { progress: 0 };
  }
  if (s === "running") {
    const p = prog ?? 0;
    return { progress: Math.max(0, Math.min(100, p)) };
  }
  return { progress: prog ?? 0 };
}

function applyJobStatusToButton(button, jobId, job) {
  if (!shouldApplyJobUiUpdate(jobId, job)) {
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

const MSG_LIBRARY_TITLE = formatStatusColon("Already in library", "click to update");

function extractLcscId() {
  const match = window.location.pathname.match(PRODUCT_REGEX);
  if (!match) {
    return null;
  }
  return match[1].toUpperCase();
}

function extractInfoTableRow(label) {
  const rows = document.querySelectorAll("table.tableInfoWrap tr");
  for (const row of rows) {
    const th = row.querySelector("td.font-Bold-600");
    if (th && th.textContent.trim() === label) {
      const td = th.nextElementSibling;
      return td ?? null;
    }
  }
  return null;
}

function getCellDisplayValue(td) {
  if (!td) return "";
  const span = td.querySelector("span.major2--text");
  if (span) return (span.textContent || "").trim();
  const a = td.querySelector("a.v2-a, a[href]");
  if (a) return (a.textContent || "").trim();
  return (td.textContent || "").replace(/\s+/g, " ").trim();
}

/** Build params and ordered labels from the product info table (tableInfoWrap) where the KiCad row lives. */
function extractTableInfoWrapSpecs() {
  const params = {};
  const labelsInOrder = [];
  const rows = document.querySelectorAll("table.tableInfoWrap tbody tr");
  for (const row of rows) {
    const labelTd = row.querySelector("td.font-Bold-600");
    if (!labelTd) continue;
    const label = (labelTd.textContent || "").replace(/\s+/g, " ").trim();
    if (!label) continue;
    if (label === "KiCad") continue;
    const valueTd = labelTd.nextElementSibling;
    const value = getCellDisplayValue(valueTd);
    params[label] = value;
    labelsInOrder.push(label);
  }
  return { params, labelsInOrder };
}

/**
 * LCSC product page: attributes in Vuetify `.v-data-table.common-table-v7` (Type | Description | …).
 * First column = field name, second = value (links or plain text).
 */
function extractVDataTableSpecs() {
  const params = {};
  const labelsInOrder = [];
  const table =
    document.querySelector(".v-data-table.common-table-v7 table")
    || document.querySelector(".v-data-table .v-data-table__wrapper table");
  if (!table) return { params, labelsInOrder };
  const rows = table.querySelectorAll("tbody tr");
  for (const row of rows) {
    const tds = row.querySelectorAll("td");
    if (tds.length < 2) continue;
    const labelTd = tds[0];
    const valueTd = tds[1];
    const label = (labelTd.textContent || "").replace(/\s+/g, " ").trim();
    if (!label) continue;
    let value = "";
    const link = valueTd.querySelector("a.v2-a, a[href]");
    if (link) value = (link.textContent || "").trim();
    else value = (valueTd.textContent || "").replace(/\s+/g, " ").trim();
    params[label] = value;
    labelsInOrder.push(label);
  }
  return { params, labelsInOrder };
}

function extractPageData() {
  try {
    const categoryCell = document.getElementById("category_id");
    const categoryRaw = categoryCell?.nextElementSibling
      ?.querySelector("a")?.textContent?.trim() ?? null;
    const category = categoryRaw ? (categoryRaw.split("/")[1] ?? categoryRaw).trim() : null;

    const packageCell = document.getElementById("package_id");
    let pkg = packageCell?.nextElementSibling?.textContent?.trim() ?? null;

    const { params: tableParams, labelsInOrder: wrapLabels } = extractTableInfoWrapSpecs();
    const { params: vDataParams, labelsInOrder: vDataLabels } = extractVDataTableSpecs();
    const params = { ...tableParams };
    for (const [k, v] of Object.entries(vDataParams)) {
      const existing = params[k];
      const existingEmpty = existing == null || String(existing).trim() === "";
      const vStr = v != null ? String(v).trim() : "";
      if (existingEmpty && vStr) {
        params[k] = v;
      }
    }
    const labelsInOrder = [...wrapLabels];
    const labelSeen = new Set(wrapLabels);
    for (const L of vDataLabels) {
      if (L && !labelSeen.has(L)) {
        labelsInOrder.push(L);
        labelSeen.add(L);
      }
    }
    if (pkg != null && pkg !== "" && params["Package"] == null) {
      params["Package"] = pkg;
    }
    if (pkg == null && params["Package"]) {
      pkg = params["Package"];
    }

    document.querySelectorAll("td[id^='paramsItem']").forEach((td) => {
      const label = (td.textContent || "").replace(/\s+/g, " ").replace(/:\s*$/, "").trim();
      const value = td.nextElementSibling?.textContent?.trim();
      if (label && value && params[label] == null) {
        params[label] = value;
      }
    });

    const descriptionTd = extractInfoTableRow("Description");
    const description = descriptionTd
      ? getCellDisplayValue(descriptionTd) || null
      : null;

    const datasheetTd = extractInfoTableRow("Datasheet");
    const datasheetUrl = datasheetTd?.querySelector("a")?.href ?? null;

    const preferredFirst = [
      "Mfr. Part #",
      "Manufacturer Part Number",
      "Manufacturer",
      "Category",
      "Package",
    ];
    const valueParamOptions = [];
    const used = new Set();
    const add = (k) => {
      const key = (k || "").trim();
      if (!key || used.has(key)) return;
      used.add(key);
      valueParamOptions.push(key);
    };
    preferredFirst.forEach((k) => {
      if (labelsInOrder.includes(k) || params[k] != null) add(k);
    });
    labelsInOrder.forEach(add);
    Object.keys(params).forEach((k) => add(k));

    return {
      category,
      package: pkg,
      params,
      description,
      datasheetUrl,
      valueParamOptions,
    };
  } catch (_err) {
    return {
      category: null,
      package: null,
      params: {},
      description: null,
      datasheetUrl: null,
      valueParamOptions: [],
    };
  }
}

function removeCategoryDialog() {
  const existing = document.getElementById(CATEGORY_DIALOG_ID);
  if (existing) {
    const esc = existing._easyeda2kicadEscHandler;
    if (typeof esc === "function") {
      document.removeEventListener("keydown", esc, true);
    }
    existing.remove();
    unlockOverlayPageScroll();
  }
}

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
      const resp = await contentRpc("checkComponentExists", { lcscId }, { retries: 2, delay: 300 });
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

function getDefaultValueParamKey(paramKeys) {
  if (!Array.isArray(paramKeys) || paramKeys.length === 0) return "";
  const keyLower = (k) => (k || "").toLowerCase();
  const preferredLower = PREFERRED_VALUE_PARAM_KEYS.map(keyLower);
  const match = paramKeys.find((k) => preferredLower.includes(keyLower(k)));
  return match != null ? match : paramKeys[0];
}

/**
 * No usable LCSC attribute table data (no param keys/values and no dropdown options).
 * In that case the user should choose EasyEDA default Value vs configuring the value-parameter mapping.
 */
function needsValueParamFromPage(pageData) {
  const params = pageData?.params && typeof pageData.params === "object" ? pageData.params : {};
  const hasAnyParam = Object.entries(params).some(([, v]) => v != null && String(v).trim() !== "");
  const opts = Array.isArray(pageData?.valueParamOptions) ? pageData.valueParamOptions : [];
  return !hasAnyParam && opts.length === 0;
}

function removeValueParamFallbackDialog() {
  const existing = document.getElementById(VALUE_PARAM_FALLBACK_DIALOG_ID);
  if (existing) {
    const esc = existing._easyeda2kicadEscHandler;
    if (typeof esc === "function") {
      document.removeEventListener("keydown", esc, true);
    }
    existing.remove();
    unlockOverlayPageScroll();
  }
}

/**
 * @param {(result: { mode: "default" | "configure" | "cancel" }) => void} onDone
 */
function showValueParamFallbackDialog(onDone) {
  removeValueParamFallbackDialog();

  const overlay = document.createElement("div");
  overlay.id = VALUE_PARAM_FALLBACK_DIALOG_ID;
  overlay.style.cssText = CSS_MODAL_OVERLAY_STANDARD;

  const box = document.createElement("div");
  box.style.cssText = cssModalPanelLight(440);

  const title = document.createElement("h3");
  title.style.cssText = "margin:0 0 6px 0;font-size:15px;font-weight:700;";
  title.textContent = "No product parameters found";

  const subtitle = document.createElement("p");
  subtitle.style.cssText = "margin:0 0 18px 0;font-size:13px;color:#555;line-height:1.45;";
  subtitle.textContent =
    "The LCSC attributes table could not be read (or it is empty). "
    + "You can keep the KiCad Value field as in EasyEDA (usually the part name), "
    + "or open the same settings as for a new category to choose which LCSC field maps to Value when data is available.";

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:4px;";

  const finish = (mode) => {
    removeValueParamFallbackDialog();
    if (typeof onDone === "function") onDone({ mode });
  };

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = dialogButtonStyle("secondary", "wide");

  const configureBtn = document.createElement("button");
  configureBtn.type = "button";
  configureBtn.textContent = "Configure value source…";
  configureBtn.style.cssText = dialogButtonStyle("outline", "wide");

  const defaultBtn = document.createElement("button");
  defaultBtn.type = "button";
  defaultBtn.textContent = "Use EasyEDA default";
  defaultBtn.style.cssText = dialogButtonStyle("primary", "wide");

  cancelBtn.addEventListener("click", () => finish("cancel"));
  configureBtn.addEventListener("click", () => finish("configure"));
  defaultBtn.addEventListener("click", () => finish("default"));

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) finish("cancel");
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(configureBtn);
  btnRow.appendChild(defaultBtn);
  box.appendChild(title);
  box.appendChild(subtitle);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  lockOverlayPageScroll();

  const escHandler = (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById(VALUE_PARAM_FALLBACK_DIALOG_ID)) return;
    e.preventDefault();
    e.stopPropagation();
    finish("cancel");
  };
  overlay._easyeda2kicadEscHandler = escHandler;
  document.addEventListener("keydown", escHandler, true);
}

/**
 * True when the saved category "Value parameter" key exists on the page with a non-empty value.
 */
function isConfiguredValueParamPresentOnPage(pageData, valueParamKey) {
  const key = (valueParamKey || "").trim();
  if (!key) return true;
  const params = pageData?.params && typeof pageData.params === "object" ? pageData.params : {};
  const raw = params[key];
  return raw != null && String(raw).trim() !== "";
}

function removeValueParamMismatchDialog() {
  const existing = document.getElementById(VALUE_PARAM_MISMATCH_DIALOG_ID);
  if (existing) {
    const esc = existing._easyeda2kicadEscHandler;
    if (typeof esc === "function") {
      document.removeEventListener("keydown", esc, true);
    }
    existing.remove();
    unlockOverlayPageScroll();
  }
}

/**
 * Saved Value parameter name does not match any non-empty LCSC attribute on this page.
 * @param {string} configuredKey
 * @param {(result: { mode: "default" | "configure" | "cancel" }) => void} onDone
 */
function showValueParamMismatchDialog(configuredKey, onDone) {
  removeValueParamMismatchDialog();

  const overlay = document.createElement("div");
  overlay.id = VALUE_PARAM_MISMATCH_DIALOG_ID;
  overlay.style.cssText = CSS_MODAL_OVERLAY_MISMATCH;

  const box = document.createElement("div");
  box.style.cssText = [
    "background:#fff",
    "border-radius:12px",
    "padding:0",
    "max-width:460px",
    "width:100%",
    "box-shadow:0 20px 50px rgba(15,23,42,0.18),0 0 0 1px rgba(15,23,42,0.06)",
    "color:#0f172a",
    "overflow:hidden",
  ].join(";");

  const header = document.createElement("div");
  header.style.cssText = [
    "padding:18px 22px 14px 22px",
    "border-bottom:1px solid #f1f5f9",
    "background:linear-gradient(180deg,#fff 0%,#fafbfc 100%)",
  ].join(";");
  const title = document.createElement("h3");
  title.style.cssText = "margin:0;font-size:16px;font-weight:700;color:#0f172a;line-height:1.3;";
  title.textContent = "Value parameter not found on page";
  header.appendChild(title);

  const body = document.createElement("div");
  body.style.cssText = "padding:18px 22px 8px 22px;";

  const intro = document.createElement("p");
  intro.style.cssText = "margin:0 0 12px 0;font-size:13px;color:#475569;line-height:1.55;";
  intro.textContent = "Your category uses this LCSC attribute for the KiCad Value field, but it is missing or has no value in the tables on this page:";

  const keyWrap = document.createElement("div");
  keyWrap.style.cssText = [
    "display:block",
    "margin:0 0 14px 0",
    "padding:12px 14px",
    "border-radius:8px",
    "background:#fef2f2",
    "border:1px solid #fecaca",
  ].join(";");
  const keyEl = document.createElement("span");
  keyEl.textContent = configuredKey && String(configuredKey).trim() ? String(configuredKey).trim() : "(empty)";
  keyEl.style.cssText = [
    "font-weight:700",
    "font-size:14px",
    "color:#b91c1c",
    "letter-spacing:0.01em",
    "word-break:break-word",
  ].join(";");
  keyWrap.appendChild(keyEl);

  const hint = document.createElement("p");
  hint.style.cssText = "margin:0;font-size:13px;color:#64748b;line-height:1.5;";
  hint.textContent =
    "You can continue with the EasyEDA default Value (usually the part name) or pick another LCSC field.";

  body.appendChild(intro);
  body.appendChild(keyWrap);
  body.appendChild(hint);

  const btnRow = document.createElement("div");
  btnRow.style.cssText = [
    "display:flex",
    "flex-direction:row",
    "flex-wrap:nowrap",
    "align-items:center",
    "gap:10px",
    "padding:14px 22px 18px 22px",
    "border-top:1px solid #f1f5f9",
    "background:#fafbfc",
  ].join(";");

  const finish = (mode) => {
    removeValueParamMismatchDialog();
    if (typeof onDone === "function") onDone({ mode });
  };

  const defaultBtn = document.createElement("button");
  defaultBtn.type = "button";
  defaultBtn.textContent = "Use EasyEDA default";
  defaultBtn.style.cssText = dialogButtonStyle("secondary", "wide");

  const configureBtn = document.createElement("button");
  configureBtn.type = "button";
  configureBtn.textContent = "Change value parameter…";
  configureBtn.style.cssText = dialogButtonStyle("primary", "wide");

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = `${dialogButtonStyle("secondary", "wide")};margin-left:auto;`;

  cancelBtn.addEventListener("click", () => finish("cancel"));
  configureBtn.addEventListener("click", () => finish("configure"));
  defaultBtn.addEventListener("click", () => finish("default"));

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) finish("cancel");
  });

  btnRow.appendChild(defaultBtn);
  btnRow.appendChild(configureBtn);
  btnRow.appendChild(cancelBtn);
  box.appendChild(header);
  box.appendChild(body);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  lockOverlayPageScroll();

  const escHandler = (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById(VALUE_PARAM_MISMATCH_DIALOG_ID)) return;
    e.preventDefault();
    e.stopPropagation();
    finish("cancel");
  };
  overlay._easyeda2kicadEscHandler = escHandler;
  document.addEventListener("keydown", escHandler, true);
}

function promiseValueParamFallback() {
  return new Promise((resolve) => {
    showValueParamFallbackDialog((result) => resolve(result));
  });
}

function promiseValueParamMismatch(configuredKey) {
  return new Promise((resolve) => {
    showValueParamMismatchDialog(configuredKey, (result) => resolve(result));
  });
}

/**
 * @param {string} category
 * @param {string[]} paramKeys
 * @param {{
 *   onSaveAndContinue: (config: { hidePinNumbers: boolean, hidePinNames: boolean, valueParam: string | null }) => void | Promise<void>,
 *   onContinueOnly: (config: { hidePinNumbers: boolean, hidePinNames: boolean, valueParam: string | null }) => void,
 *   onSkip: () => void,
 *   onCancel: () => void,
 * }} actions
 */
// --- Category / value-param dialogs (DOM modals) ---
function showCategoryDialog(category, paramKeys, actions) {
  const {
    onSaveAndContinue,
    onContinueOnly,
    onSkip,
    onCancel,
  } = actions || {};

  removeCategoryDialog();

  const overlay = document.createElement("div");
  overlay.id = CATEGORY_DIALOG_ID;
  overlay.style.cssText = CSS_MODAL_OVERLAY_STANDARD;

  const box = document.createElement("div");
  box.style.cssText = cssModalPanelLight(420);

  const title = document.createElement("h3");
  title.style.cssText = "margin:0 0 6px 0;font-size:15px;font-weight:700;";
  title.textContent = "New category detected";

  const subtitle = document.createElement("p");
  subtitle.style.cssText = "margin:0 0 8px 0;font-size:13px;color:#555;";
  subtitle.textContent = `Configure symbol settings for: ${category}`;

  const helpBlock = document.createElement("div");
  helpBlock.style.cssText = "margin:0 0 16px 0;font-size:12px;color:#64748b;line-height:1.5;";
  const helpRows = [
    {
      key: "Skip",
      text: "Keep defaults and download.",
    },
    {
      key: "Save & continue",
      text: "Store these defaults in the extension for this category.",
    },
    {
      key: "Continue",
      text: "Apply only to this download (not saved).",
    },
    {
      key: "Cancel",
      text: "Close the dialog without importing.",
    },
  ];
  helpRows.forEach((row, i) => {
    const line = document.createElement("div");
    line.style.cssText = [
      "display:flex",
      "gap:6px",
      "align-items:flex-start",
      i < helpRows.length - 1 ? "margin:0 0 8px 0" : "margin:0",
    ].join(";");
    const keySpan = document.createElement("span");
    keySpan.textContent = `${row.key}:`;
    keySpan.style.cssText = "font-weight:600;color:#475569;white-space:nowrap;flex-shrink:0;";
    const textSpan = document.createElement("span");
    textSpan.textContent = row.text;
    textSpan.style.cssText = "flex:1;min-width:0;";
    line.appendChild(keySpan);
    line.appendChild(textSpan);
    helpBlock.appendChild(line);
  });

  const checkRow = (labelText, id) => {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;cursor:pointer;";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.checked = true;
    cb.style.width = "16px";
    cb.style.height = "16px";
    const span = document.createElement("span");
    span.textContent = labelText;
    row.appendChild(cb);
    row.appendChild(span);
    return row;
  };

  const hideNumRow = checkRow("Hide pin numbers", "easyeda2kicad-hide-num");
  const hideNameRow = checkRow("Hide pin names", "easyeda2kicad-hide-name");

  const defaultValueParam = getDefaultValueParamKey(paramKeys);

  const valueRow = document.createElement("div");
  valueRow.style.cssText = "margin-bottom:16px;";
  const valueLabel = document.createElement("label");
  valueLabel.style.cssText = "display:block;font-size:13px;margin-bottom:4px;font-weight:600;color:#334155;";
  valueLabel.textContent = "Value parameter (optional)";
  const valueHint = document.createElement("p");
  valueHint.style.cssText = "margin:0 0 8px 0;font-size:12px;color:#64748b;line-height:1.35;";
  valueHint.textContent =
    "LCSC attribute name used for the KiCad Value field (from product tables below).";

  /** Chevron so the control reads as a dropdown even if LCSC CSS alters native &lt;select&gt; chrome. */
  const categorySelectChevronBg = `url("data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  )}")`;

  const selectDropdownStyle = [
    "display:block",
    "width:100%",
    "max-width:100%",
    "box-sizing:border-box",
    "min-height:40px",
    "padding:8px 40px 8px 12px",
    "border:1px solid #cbd5e1",
    "border-radius:8px",
    "font-size:13px",
    "line-height:1.35",
    "font-family:inherit",
    "background-color:#fff",
    "color:#0f172a",
    "cursor:pointer",
    "-webkit-appearance:none",
    "-moz-appearance:none",
    "appearance:none",
    "background-repeat:no-repeat",
    "background-position:right 10px center",
    "background-size:20px 20px",
    `background-image:${categorySelectChevronBg}`,
  ].join(";");

  const uniqueParamKeys = [...new Set((paramKeys || []).filter((k) => k && String(k).trim()))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );

  /** @type {HTMLInputElement | null} */
  let valueInput = null;
  /** @type {HTMLSelectElement | null} */
  let valueSelect = null;
  /** @type {HTMLInputElement | null} */
  let valueCustomInput = null;

  if (uniqueParamKeys.length > 0) {
    valueSelect = document.createElement("select");
    valueSelect.id = "easyeda2kicad-value-param-select";
    valueSelect.setAttribute("aria-label", "Value parameter — LCSC attribute");
    valueSelect.style.cssText = selectDropdownStyle;
    valueSelect.addEventListener("focus", () => {
      valueSelect.style.borderColor = "#1166dd";
      valueSelect.style.boxShadow = "0 0 0 3px rgba(17,102,221,0.2)";
      valueSelect.style.outline = "none";
    });
    valueSelect.addEventListener("blur", () => {
      valueSelect.style.borderColor = "#cbd5e1";
      valueSelect.style.boxShadow = "none";
    });

    const optPlaceholder = document.createElement("option");
    optPlaceholder.value = "";
    optPlaceholder.textContent = "— Choose LCSC attribute —";
    valueSelect.appendChild(optPlaceholder);

    uniqueParamKeys.forEach((k) => {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = k;
      valueSelect.appendChild(o);
    });

    const optCustom = document.createElement("option");
    optCustom.value = "__custom__";
    optCustom.textContent = "Other (type manually)…";
    valueSelect.appendChild(optCustom);

    valueCustomInput = document.createElement("input");
    valueCustomInput.type = "text";
    valueCustomInput.id = "easyeda2kicad-value-param-custom";
    valueCustomInput.autocomplete = "off";
    valueCustomInput.placeholder = "Attribute name (e.g. Mfr. Part #)";
    valueCustomInput.style.cssText = [
      "width:100%",
      "box-sizing:border-box",
      "padding:8px 10px",
      "border:1px solid #cbd5e1",
      "border-radius:8px",
      "font-size:13px",
      "margin-top:8px",
      "display:none",
    ].join(";");

    function syncCustomVisibility() {
      const show = valueSelect && valueSelect.value === "__custom__";
      if (valueCustomInput) valueCustomInput.style.display = show ? "block" : "none";
    }
    valueSelect.addEventListener("change", syncCustomVisibility);

    if (defaultValueParam && uniqueParamKeys.includes(defaultValueParam)) {
      valueSelect.value = defaultValueParam;
    } else if (defaultValueParam) {
      valueSelect.value = "__custom__";
      valueCustomInput.value = defaultValueParam;
      valueCustomInput.style.display = "block";
    }
    syncCustomVisibility();

    valueLabel.setAttribute("for", "easyeda2kicad-value-param-select");
    valueRow.appendChild(valueLabel);
    valueRow.appendChild(valueHint);
    valueRow.appendChild(valueSelect);
    valueRow.appendChild(valueCustomInput);
  } else {
    valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.id = "easyeda2kicad-value-param";
    valueInput.autocomplete = "off";
    valueInput.placeholder = defaultValueParam ? `e.g. ${defaultValueParam}` : "e.g. Resistance";
    valueInput.style.cssText = [
      "width:100%",
      "box-sizing:border-box",
      "padding:8px 10px",
      "border:1px solid #cbd5e1",
      "border-radius:8px",
      "font-size:13px",
    ].join(";");
    valueLabel.setAttribute("for", "easyeda2kicad-value-param");
    valueRow.appendChild(valueLabel);
    valueRow.appendChild(valueHint);
    valueRow.appendChild(valueInput);
  }

  function collectCategoryFormConfig() {
    const hidePinNumbers = document.getElementById("easyeda2kicad-hide-num")?.checked ?? true;
    const hidePinNames = document.getElementById("easyeda2kicad-hide-name")?.checked ?? true;
    let rawValueParam = "";
    const sel = document.getElementById("easyeda2kicad-value-param-select");
    const customEl = document.getElementById("easyeda2kicad-value-param-custom");
    const textEl = document.getElementById("easyeda2kicad-value-param");
    if (sel) {
      if (sel.value === "__custom__") {
        rawValueParam = (customEl?.value || "").trim();
      } else {
        rawValueParam = (sel.value || "").trim();
      }
    } else {
      rawValueParam = (textEl?.value || "").trim();
    }
    const valueParam = rawValueParam || defaultValueParam || null;
    return { hidePinNumbers, hidePinNames, valueParam };
  }

  const btnRow = document.createElement("div");
  btnRow.style.cssText = [
    "display:flex",
    "flex-direction:row",
    "flex-wrap:nowrap",
    "align-items:center",
    "gap:8px",
    "margin-top:4px",
    "justify-content:flex-start",
  ].join(";");

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.textContent = "Skip";
  skipBtn.setAttribute(
    "title",
    "Do not save this dialog. Use existing or built-in defaults for this category and proceed with the import.",
  );
  skipBtn.style.cssText = dialogButtonStyle("secondary", "dense");

  const saveContinueBtn = document.createElement("button");
  saveContinueBtn.type = "button";
  saveContinueBtn.textContent = "Save & continue";
  saveContinueBtn.setAttribute(
    "title",
    "Store these pin and Value settings in the extension for this LCSC category (Settings → category table), then start the import.",
  );
  saveContinueBtn.style.cssText = dialogButtonStyle("primary", "dense");

  const continueOnlyBtn = document.createElement("button");
  continueOnlyBtn.type = "button";
  continueOnlyBtn.textContent = "Continue";
  continueOnlyBtn.setAttribute(
    "title",
    "Use the settings above for this import only. Nothing is written to extension storage; next time the category may prompt again.",
  );
  continueOnlyBtn.style.cssText = dialogButtonStyle("outline", "dense");

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.setAttribute("title", "Close this dialog and abort the download (no changes applied).");
  cancelBtn.style.cssText = `${dialogButtonStyle("secondary", "dense")};margin-left:auto;`;

  skipBtn.addEventListener("click", () => {
    removeCategoryDialog();
    if (typeof onSkip === "function") onSkip();
  });

  saveContinueBtn.addEventListener("click", async () => {
    const config = collectCategoryFormConfig();
    removeCategoryDialog();
    if (typeof onSaveAndContinue === "function") {
      await Promise.resolve(onSaveAndContinue(config));
    }
  });

  continueOnlyBtn.addEventListener("click", () => {
    const config = collectCategoryFormConfig();
    removeCategoryDialog();
    if (typeof onContinueOnly === "function") onContinueOnly(config);
  });

  cancelBtn.addEventListener("click", () => {
    removeCategoryDialog();
    if (typeof onCancel === "function") onCancel();
  });

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) {
      removeCategoryDialog();
      if (typeof onCancel === "function") onCancel();
    }
  });

  btnRow.appendChild(skipBtn);
  btnRow.appendChild(saveContinueBtn);
  btnRow.appendChild(continueOnlyBtn);
  btnRow.appendChild(cancelBtn);
  box.appendChild(title);
  box.appendChild(subtitle);
  box.appendChild(helpBlock);
  box.appendChild(hideNumRow);
  box.appendChild(hideNameRow);
  box.appendChild(valueRow);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  lockOverlayPageScroll();

  const escHandler = (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById(CATEGORY_DIALOG_ID)) return;
    e.preventDefault();
    e.stopPropagation();
    removeCategoryDialog();
    if (typeof onCancel === "function") onCancel();
  };
  overlay._easyeda2kicadEscHandler = escHandler;
  document.addEventListener("keydown", escHandler, true);

  setTimeout(() => {
    const sel = document.getElementById("easyeda2kicad-value-param-select");
    const custom = document.getElementById("easyeda2kicad-value-param-custom");
    const plain = document.getElementById("easyeda2kicad-value-param");
    if (sel && sel.value === "__custom__" && custom) custom.focus();
    else if (sel) sel.focus();
    else if (plain) plain.focus();
  }, 50);
}

function findInsertionPoint() {
  try {
    return document
      .querySelector(".productImgSlide")
      ?.parentNode?.parentNode?.children?.[1]?.querySelector("tbody")
      || null;
  } catch (_error) {
    return null;
  }
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
      if (doConfetti && confettiDoneForJobId.has(cjid)) {
        doConfetti = false;
      }
      if (doConfetti && cjid) {
        confettiDoneForJobId.add(cjid);
        setTimeout(() => confettiDoneForJobId.delete(cjid), 180000);
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
 * LCSC/Vue often re-renders the table and drops our progress <tr> while keeping the button host.
 * Recreate the row after the KiCad product row when missing so setProgressUI never silently no-ops.
 */
function ensureProductProgressRow() {
  if (document.getElementById(PRODUCT_PROGRESS_ROW_ID)) {
    return;
  }
  const group = document.getElementById(BTN_GROUP_ID);
  const btnRow = group?.closest?.("tr");
  const tbody = btnRow?.parentElement;
  if (!btnRow || !tbody || String(tbody.tagName).toLowerCase() !== "tbody") {
    return;
  }

  const progressRow = document.createElement("tr");
  progressRow.id = PRODUCT_PROGRESS_ROW_ID;
  progressRow.style.display = "none";

  const progressCell = document.createElement("td");
  progressCell.setAttribute("colspan", "2");
  progressCell.style.paddingTop = "2px";
  progressCell.style.paddingBottom = "6px";

  const track = document.createElement("div");
  track.id = "easyeda2kicad-progress-track";

  const bar = document.createElement("div");
  bar.id = "easyeda2kicad-progress-bar";
  track.appendChild(bar);

  const statusText = document.createElement("div");
  statusText.id = "easyeda2kicad-status-text";

  progressCell.appendChild(track);
  progressCell.appendChild(statusText);
  progressRow.appendChild(progressCell);
  btnRow.insertAdjacentElement("afterend", progressRow);
}

function getProgressElements() {
  return {
    track: document.getElementById("easyeda2kicad-progress-track"),
    bar: document.getElementById("easyeda2kicad-progress-bar"),
    text: document.getElementById("easyeda2kicad-status-text"),
    row: document.getElementById(PRODUCT_PROGRESS_ROW_ID),
  };
}

function setProgressUI({ visible = true, barClass = "", widthPct = null, message = "", messageClass = "", copyText = null } = {}) {
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
    text.className = `easyeda2kicad-status-text${messageClass ? ` ${messageClass}` : ""}`;
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
  if (!primary) {
    subSpan.title = "Choose a symbol from a template library";
  }

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
    const stateResp = await contentRpc("getState", {}, { retries: 2, delay: 200 });
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
      templateBtn.onclick = () => openTemplateDropdown(templateBtn, groupDiv, lcscId, state);
    }

    // If backend is offline or state could not be read, grey out buttons and show status.
    if (!backendOnline) {
      setGroupBackendOffline();
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
        const existResp = await contentRpc("checkComponentExists", { lcscId }, { retries: 3, delay: 300 });
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

function openTemplateDropdown(anchorButton, groupDiv, lcscId, state) {
  let existing = document.getElementById(TEMPLATE_DROPDOWN_ID);
  if (existing) {
    existing.remove();
    unlockOverlayPageScroll();
    return;
  }

  const templateSymbolsByLib = state.templateSymbolsByLib || {};
  const allItems = buildTemplateListItems(templateSymbolsByLib);
  if (!allItems.length) return;

  const wrapper = document.getElementById(BUTTON_WRAPPER_ID) || groupDiv.parentElement;
  const dropdown = document.createElement("div");
  dropdown.id = TEMPLATE_DROPDOWN_ID;
  dropdown.setAttribute("role", "listbox");
  dropdown.setAttribute("aria-label", "Template symbols");
  dropdown.style.cssText = [
    "position:fixed",
    "z-index:2147483646",
    "min-width:260px",
    "max-width:360px",
    "max-height:min(320px,calc(100vh - 24px))",
    "background:#ffffff",
    "border:1px solid #e2e8f0",
    "border-radius:10px",
    "box-shadow:0 12px 40px rgba(15,23,42,0.12),0 4px 12px rgba(15,23,42,0.06)",
    "display:flex",
    "flex-direction:column",
    "overflow:hidden",
    "font-family:system-ui,-apple-system,\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial,sans-serif",
    "font-size:13px",
    "color:#0f172a",
  ].join(";");

  const header = document.createElement("div");
  header.textContent = "Template symbol";
  header.style.cssText = [
    "padding:12px 14px 0 14px",
    "font-size:11px",
    "font-weight:600",
    "color:#64748b",
    "text-transform:uppercase",
    "letter-spacing:0.06em",
    "line-height:1.2",
  ].join(";");

  const searchBox = document.createElement("input");
  searchBox.type = "search";
  searchBox.autocomplete = "off";
  searchBox.placeholder = "Filter by name…";
  searchBox.setAttribute("aria-label", "Filter templates");
  const searchBaseStyle = [
    "margin:10px 12px 8px 12px",
    "padding:8px 12px",
    "border:1px solid #d1d5db",
    "border-radius:8px",
    "background:#f9fafb",
    "color:#111827",
    "font-size:13px",
    "line-height:1.35",
    "outline:none",
    "box-sizing:border-box",
    "width:calc(100% - 24px)",
    "transition:border-color 0.15s ease,box-shadow 0.15s ease,background 0.15s ease",
  ].join(";");
  searchBox.style.cssText = searchBaseStyle;
  searchBox.addEventListener("focus", () => {
    searchBox.style.borderColor = "#1166dd";
    searchBox.style.background = "#ffffff";
    searchBox.style.boxShadow = "0 0 0 3px rgba(17,102,221,0.18)";
  });
  searchBox.addEventListener("blur", () => {
    searchBox.style.cssText = searchBaseStyle;
  });

  const list = document.createElement("div");
  list.style.cssText = [
    "overflow-y:auto",
    "overflow-x:hidden",
    "flex:1",
    "min-height:0",
    "padding:2px 8px 10px 8px",
    "scrollbar-width:thin",
    "scrollbar-color:#cbd5e1 #f1f5f9",
  ].join(";");

  function filterList(query) {
    const q = (query || "").trim().toLowerCase();
    list.innerHTML = "";
    const filtered = q
      ? allItems.filter((item) => item.name.toLowerCase().includes(q))
      : allItems;
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No matching templates";
      empty.style.cssText = [
        "padding:20px 12px",
        "text-align:center",
        "font-size:12px",
        "color:#94a3b8",
        "line-height:1.4",
      ].join(";");
      list.appendChild(empty);
      return;
    }
    filtered.forEach((item) => {
      const row = document.createElement("button");
      row.type = "button";
      row.setAttribute("role", "option");
      row.style.cssText = [
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
        "color:inherit",
        "box-sizing:border-box",
      ].join(";");
      const nameLine = document.createElement("span");
      nameLine.style.cssText = [
        "display:block",
        "font-weight:600",
        "font-size:13px",
        "color:#0f172a",
        "line-height:1.25",
        "white-space:nowrap",
        "overflow:hidden",
        "text-overflow:ellipsis",
      ].join(";");
      nameLine.textContent = item.name;
      const libLine = document.createElement("span");
      libLine.style.cssText = [
        "display:block",
        "margin-top:3px",
        "font-size:11px",
        "font-weight:500",
        "color:#64748b",
        "line-height:1.2",
        "white-space:nowrap",
        "overflow:hidden",
        "text-overflow:ellipsis",
      ].join(";");
      libLine.textContent = item.libName;
      row.appendChild(nameLine);
      row.appendChild(libLine);
      row.title = `${item.name} — ${item.libName}`;
      row.addEventListener("mouseenter", () => {
        row.style.background = "#f1f5f9";
      });
      row.addEventListener("mouseleave", () => {
        row.style.background = "transparent";
      });
      row.addEventListener("click", () => {
        closeDropdown();
        onTemplateSelected(anchorButton, lcscId, item.name, item.libPath);
      });
      list.appendChild(row);
    });
  }

  function closeDropdown() {
    const el = document.getElementById(TEMPLATE_DROPDOWN_ID);
    if (el) el.remove();
    document.removeEventListener("click", outsideClick);
    unlockOverlayPageScroll();
  }

  function outsideClick(e) {
    if (dropdown.contains(e.target) || (anchorButton && anchorButton.contains(e.target))) return;
    closeDropdown();
  }

  searchBox.addEventListener("input", () => filterList(searchBox.value));
  searchBox.addEventListener("click", (e) => e.stopPropagation());

  dropdown.appendChild(header);
  dropdown.appendChild(searchBox);
  dropdown.appendChild(list);
  filterList("");

  const rect = (wrapper || groupDiv).getBoundingClientRect();
  dropdown.style.top = `${rect.bottom + 6}px`;
  dropdown.style.left = `${rect.left}px`;

  lockOverlayPageScroll();
  document.body.appendChild(dropdown);
  setTimeout(() => document.addEventListener("click", outsideClick), 0);
  searchBox.focus();
}

async function onTemplateSelected(button, lcscId, templateName, templateLibPath) {
  // Keep backend-offline handling consistent with the EasyEDA button.
  try {
    const status = await contentRpc("getState", {}, { retries: 2, delay: 200 });
    if (!status?.ok || !status?.data || status.data.connected !== true) {
      showBackendOfflineUIForButton(button);
      return;
    }
  } catch (_e) {
    showBackendOfflineUIForButton(button);
    return;
  }

  updateButtonState(button, "pending", { progress: 0, message: formatStatusColon("Pin check", "in progress") });
  let pinCheckResp;
  try {
    pinCheckResp = await contentRpc(
      "templatesPinCheck",
      { lcscId, templateName, templateLibPath },
      { retries: 2, delay: 300 },
    );
  } catch (err) {
    const msg = err?.message || String(err);
    if (/backend|reach|offline/i.test(msg)) {
      showBackendOfflineUIForButton(button);
      return;
    }
    updateButtonState(button, "error", {
      message: formatStatusColon("Pin check failed", err.message || "unknown error"),
    });
    return;
  }

  if (!pinCheckResp?.ok || !pinCheckResp.data) {
    const msg = pinCheckResp?.error || pinCheckResp?.message || "";
    if (/backend|reach|offline/i.test(msg)) {
      showBackendOfflineUIForButton(button);
      return;
    }
    updateButtonState(button, "error", {
      message: formatStatusColon("Pin check failed", pinCheckResp?.error || "unknown error"),
    });
    return;
  }

  const { easyeda_pin_count, template_pin_count, match } = pinCheckResp.data;

  if (match) {
    handleDownloadClick(button, lcscId, {
      useTemplate: true,
      templateName,
      templateLibPath,
    });
    return;
  }

  showPinMismatchUI(button, lcscId, templateName, templateLibPath, easyeda_pin_count, template_pin_count);
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

/** @param {object} existingOverrides Passed through to the resumed download (template options, etc.). */
function showOverwriteDialog(button, lcscId, pageData, existingOverrides) {
  const { row } = getProgressElements();
  const isProductPage = Boolean(row);

  const msgText = formatStatusColon("Part already in library", "overwrite?");
  const btnStyleDarkModal = cssJoin([
    "padding:6px 12px",
    "border-radius:6px",
    `border:1px solid ${CS_DIALOG.slate600}`,
    `background:${CS_DIALOG.slate700}`,
    `color:${CS_DIALOG.slate200}`,
    "cursor:pointer",
    "font-size:12px",
  ]);

  const runDownload = (extraOverrides) => {
    if (row) {
      row.querySelector(".easyeda2kicad-overwrite-dialog")?.remove();
      row.style.display = "";
    } else if (overlay) {
      overlay.remove();
    }
    handleDownloadClick(button, lcscId, { ...existingOverrides, ...extraOverrides });
  };

  const restoreExists = () => {
    if (!isProductPage && overlay) overlay.remove();
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
      msg.textContent = msgText;
      styleLightTableCaption(text, msg);
      text.appendChild(msg);
      const btnWrap = document.createElement("div");
      btnWrap.className = "easyeda2kicad-overwrite-dialog";
      btnWrap.style.cssText =
        "display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;justify-content:center;align-items:center;width:100%;";
      const btnOverride = document.createElement("button");
      btnOverride.type = "button";
      btnOverride.textContent = "Override";
      btnOverride.style.cssText = K2C_DLG_BTN_LIGHT_PRIMARY;
      const btnPermanent = document.createElement("button");
      btnPermanent.type = "button";
      btnPermanent.textContent = "Permanent override";
      btnPermanent.style.cssText = K2C_DLG_BTN_LIGHT_PRIMARY;
      const btnCancel = document.createElement("button");
      btnCancel.type = "button";
      btnCancel.textContent = "Cancel";
      btnCancel.style.cssText = K2C_DLG_BTN_LIGHT_SECONDARY;
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

  let overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 999999;
  `;
  const box = document.createElement("div");
  box.style.cssText = `
    background: #1e293b;
    padding: 16px 20px;
    border-radius: 8px;
    border: 1px solid #475569;
    color: #e2e8f0;
    font-size: 13px;
    max-width: 320px;
  `;
  box.textContent = msgText;
  const btnWrap = document.createElement("div");
  btnWrap.style.cssText =
    "display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;justify-content:center;align-items:center;width:100%;";
  const btnOverride = document.createElement("button");
  btnOverride.type = "button";
  btnOverride.textContent = "Override";
  btnOverride.style.cssText = btnStyleDarkModal;
  const btnPermanent = document.createElement("button");
  btnPermanent.type = "button";
  btnPermanent.textContent = "Permanent override";
  btnPermanent.style.cssText = btnStyleDarkModal;
  const btnCancel = document.createElement("button");
  btnCancel.type = "button";
  btnCancel.textContent = "Cancel";
  btnCancel.style.cssText = btnStyleDarkModal;
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
  box.appendChild(btnWrap);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function showPinMismatchUI(button, lcscId, templateName, templateLibPath, easyedaPinCount, templatePinCount) {
  const { track, bar, text, row } = getProgressElements();
  if (!row) return;

  row.style.display = "";
  if (bar) {
    bar.className = "easyeda2kicad-pin-mismatch";
    bar.style.width = "100%";
  }
  if (text) {
    text.className = "easyeda2kicad-status-text k2c-status-progress";
    text.innerHTML = "";
    const msg = document.createElement("span");
    msg.textContent = formatStatusColon(
      "Pin count mismatch",
      `template ${templatePinCount} pins, EasyEDA ${easyedaPinCount} pins (manual fix may be required)`,
    );
    styleLightTableCaption(text, msg);
    text.appendChild(msg);

    const btnWrap = document.createElement("div");
    btnWrap.style.cssText =
      "display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;justify-content:center;align-items:center;width:100%;";
    const btnContinue = document.createElement("button");
    btnContinue.type = "button";
    btnContinue.textContent = "Continue (with pin incompatibility, manual fix required)";
    btnContinue.style.cssText = K2C_DLG_BTN_LIGHT_PRIMARY;
    const btnEasyEda = document.createElement("button");
    btnEasyEda.type = "button";
    btnEasyEda.textContent = "Download EasyEDA model";
    btnEasyEda.style.cssText = K2C_DLG_BTN_LIGHT_SECONDARY;

    btnContinue.addEventListener("click", () => {
      row.style.display = "none";
      handleDownloadClick(button, lcscId, {
        useTemplate: true,
        templateName,
        templateLibPath,
        forceTemplate: true,
      });
    });
    btnEasyEda.addEventListener("click", () => {
      row.style.display = "none";
      handleDownloadClick(button, lcscId, { useTemplate: false });
    });

    btnWrap.appendChild(btnContinue);
    btnWrap.appendChild(btnEasyEda);
    text.appendChild(btnWrap);
  }
}

function attachButton(lcscId) {
  const tbody = findInsertionPoint();
  if (!tbody) {
    dbg("attachButton: no tbody found");
    return false;
  }

  if (document.getElementById(BTN_GROUP_ID)) {
    dbg("attachButton: product button group already present");
    ensureProductProgressRow();
    return true;
  }

  // Create button group wrapper
  const groupDiv = document.createElement("div");
  groupDiv.id = BTN_GROUP_ID;
  backendOnlineMonitorLcscId = lcscId;
  backendOnlineMonitorGroupDiv = groupDiv;

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
  button.addEventListener("click", () => handleDownloadClick(button, lcscId));
  button.dataset[INIT_ATTR] = "false";
  mount.appendChild(button);

  const row = document.createElement("tr");
  row.id = `${BUTTON_ID}-row`;

  const labelCell = document.createElement("td");
  labelCell.textContent = "KiCad";
  labelCell.style.fontWeight = "600";
  labelCell.style.whiteSpace = "nowrap";

  const actionCell = document.createElement("td");
  actionCell.style.padding = "6px 0 6px 12px";
  actionCell.appendChild(groupDiv);

  row.appendChild(labelCell);
  row.appendChild(actionCell);
  tbody.appendChild(row);

  // Progress / status row (initially hidden, spans both columns)
  const progressRow = document.createElement("tr");
  progressRow.id = PRODUCT_PROGRESS_ROW_ID;
  progressRow.style.display = "none";

  const progressCell = document.createElement("td");
  progressCell.setAttribute("colspan", "2");
  progressCell.style.paddingTop = "2px";
  progressCell.style.paddingBottom = "6px";

  const track = document.createElement("div");
  track.id = "easyeda2kicad-progress-track";

  const bar = document.createElement("div");
  bar.id = "easyeda2kicad-progress-bar";
  track.appendChild(bar);

  const statusText = document.createElement("div");
  statusText.id = "easyeda2kicad-status-text";

  progressCell.appendChild(track);
  progressCell.appendChild(statusText);
  progressRow.appendChild(progressCell);
  tbody.appendChild(progressRow);

  // Defer expensive "exists" checks to refreshButtonGroup() to keep UI responsive.
  // Async: add template buttons if templates are configured for this category
  refreshButtonGroup(lcscId, groupDiv);
  dbg("attachButton: inserted product button", lcscId);
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
function createCategoryDialogCallbacks(category, catCfgRef, resolve) {
  return {
    onSaveAndContinue: async (config) => {
      try {
        await contentRpc("saveCategorySettings", { category, config });
      } catch (_err) {
        dbg("saveCategorySettings failed", _err);
      }
      catCfgRef.value = null;
      resolve({ cancelled: false });
    },
    onContinueOnly: (config) => {
      catCfgRef.value = config;
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
      createCategoryDialogCallbacks(category, catCfgRef, resolve),
    );
  });
}

// --- Download pipeline (gates → quickDownload RPC) ---
async function handleDownloadClick(button, lcscId, overrides = {}) {
  dbg("handleDownloadClick", lcscId, overrides);
  let status;
  try {
    status = await contentRpc("getState", {}, { retries: 2, delay: 200 });
    if (!status?.ok || !status.data) {
      throw new Error(status?.error || "Unable to reach extension backend.");
    }
    if (!status.data.connected) {
      setButtonOfflineNoBackend(button);
      return;
    }
  } catch (_error) {
    setButtonOfflineNoBackend(button);
    return;
  }

  const pageData = extractPageData();
  dbg("extractPageData", pageData);

  /** If part is already in the library and overwrite is off, ask before any category/value-param UI. */
  const partExists = button.dataset.libState === "exists";
  const stateData = status?.data;
  const overwriteOff = stateData
    ? !stateData.overwriteFootprints && !stateData.overwriteModels
    : false;
  const oneTimeOverwrite =
    overrides.overwrite === true || overrides.overwrite_model === true;
  if (partExists && overwriteOff && !oneTimeOverwrite) {
    showOverwriteDialog(button, lcscId, pageData, overrides);
    return;
  }

  /** "Continue only" mapping for this job; also accepts initial value from `overrides`. */
  const catCfg = { value: overrides.categoryConfigOverride ?? null };

  /** True after the "new category" dialog (unknown category). */
  let categoryDialogShown = false;

  if (pageData.category) {
    try {
      const knownResponse = await contentRpc(
        "checkCategoryKnown",
        { category: pageData.category },
        { retries: 2, delay: 200 },
      );
      const isKnown = knownResponse?.ok && knownResponse.data?.known;
      if (!isKnown) {
        categoryDialogShown = true;
        const { cancelled } = await openCategoryDialogPromise(pageData.category, pageData, catCfg);
        if (abortPreDownloadIf(button, lcscId, cancelled)) return;
      }
    } catch (_err) {
      dbg("checkCategoryKnown failed", _err);
    }
  }

  if (needsValueParamFromPage(pageData) && !categoryDialogShown) {
    const fallbackResult = await promiseValueParamFallback();
    if (abortPreDownloadIf(button, lcscId, fallbackResult.mode === "cancel")) return;
    if (fallbackResult.mode === "configure") {
      const catLabel = pageData.category || "Uncategorized";
      const { cancelled } = await openCategoryDialogPromise(catLabel, pageData, catCfg);
      if (abortPreDownloadIf(button, lcscId, cancelled)) return;
    }
  }

  if (
    pageData.category
    && !needsValueParamFromPage(pageData)
    && !categoryDialogShown
  ) {
    try {
      const cfgResp = await contentRpc(
        "getCategorySettings",
        { category: pageData.category },
        { retries: 2, delay: 200 },
      );
      if (cfgResp?.ok) {
        const saved = cfgResp.data;
        const vp = saved && typeof saved.valueParam === "string" ? saved.valueParam.trim() : "";
        if (vp && !isConfiguredValueParamPresentOnPage(pageData, vp)) {
          const mismatchResult = await promiseValueParamMismatch(vp);
          if (abortPreDownloadIf(button, lcscId, mismatchResult.mode === "cancel")) return;
          if (mismatchResult.mode === "configure") {
            const { cancelled } = await openCategoryDialogPromise(pageData.category, pageData, catCfg);
            if (abortPreDownloadIf(button, lcscId, cancelled)) return;
          }
        }
      }
    } catch (_err) {
      dbg("getCategorySettings / value param mismatch flow failed", _err);
    }
  }

  updateButtonState(button, "pending", { progress: 0, message: formatStatusColon("Conversion", "submitting job") });
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
        useTemplate: overrides.useTemplate || false,
        templateName: overrides.templateName || null,
        templateLibPath: overrides.templateLibPath || null,
        forceTemplate: overrides.forceTemplate || false,
        overwrite: overrides.overwrite,
        overwrite_model: overrides.overwrite_model,
        categoryConfigOverride: catCfg.value || null,
      },
      { retries: 4, delay: 300 },
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
        clearJobWatcher(prevWatch);
        forgetJobUi(prevWatch);
      }
      forgetJobUi(jobId);
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
  if (terminalJobHandled.has(jobId)) return;
  terminalJobHandled.add(jobId);
  setTimeout(() => terminalJobHandled.delete(jobId), 180000);
  forgetJobUi(jobId);
  clearJobWatcher(jobId);
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
    clearJobWatcher(prevBtnJob);
    forgetJobUi(prevBtnJob);
  }
  button.dataset.k2cWatchJobId = jobId;
  jobWatchers.set(jobId, true);
  dbg("startJobWatcher(ws push)", jobId);
}

function registerObserver(observer) {
  activeObservers.add(observer);
}

function cleanupObservers() {
  activeObservers.forEach((observer) => observer.disconnect());
  activeObservers.clear();
}

function cleanupInjectedUi() {
  const productRow = document.getElementById(`${BUTTON_ID}-row`);
  if (productRow?.parentElement) {
    productRow.parentElement.removeChild(productRow);
  }
  const progressRow = document.getElementById(PRODUCT_PROGRESS_ROW_ID);
  if (progressRow?.parentElement) {
    progressRow.parentElement.removeChild(progressRow);
  }
  jobWatchers.forEach((_, jobId) => clearJobWatcher(jobId));
  jobUiMonotone.clear();
  terminalJobHandled.clear();
  confettiDoneForJobId.clear();
  if (backendOnlineMonitorTimer) {
    clearInterval(backendOnlineMonitorTimer);
    backendOnlineMonitorTimer = null;
  }
  backendOnlineMonitorLcscId = null;
  backendOnlineMonitorGroupDiv = null;
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

    if (attachButton(lcscId)) {
      dbg("product button inserted immediately");
      return;
    }

    const observer = new MutationObserver(() => {
      if (attachButton(lcscId)) {
        observer.disconnect();
        activeObservers.delete(observer);
        dbg("product MutationObserver inserted button");
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    registerObserver(observer);

    setTimeout(() => {
      observer.disconnect();
      activeObservers.delete(observer);
    }, 10000);
    return;
  }
}

function scheduleRouteCheck() {
  const url = window.location.href;
  if (url === currentUrl) {
    return;
  }
  currentUrl = url;
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
  initDebug();
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "stateUpdate" && message.state) {
      const previous = debugEnabled;
      debugEnabled = Boolean(message.state.debugLogs);
      if (!previous && debugEnabled) {
        console.log("[easyeda2kicad] debug logs enabled");
      } else if (previous && !debugEnabled) {
        console.log("[easyeda2kicad] debug logs disabled");
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
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
