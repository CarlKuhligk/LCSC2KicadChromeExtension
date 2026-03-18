"use strict";

const BUTTON_ID = "easyeda2kicad-download-btn";
const BTN_GROUP_ID = "easyeda2kicad-btn-group";
const BUTTON_WRAPPER_ID = "easyeda2kicad-download-wrapper";
const LIST_BUTTON_CLASS = "easyeda2kicad-list-download-btn";
const LIST_CONTAINER_CLASS = "easyeda2kicad-list-container";
const CATEGORY_DIALOG_ID = "easyeda2kicad-category-dialog";
const INIT_ATTR = "easyeda2kicadInitialized";
const SVG_NS = "http://www.w3.org/2000/svg";
const PRODUCT_REGEX = /\/product-detail\/(C\d+)(?:\.html)?/i;
const LIST_REGEX = /\/list\/list\?.*/i;

const COLORS = {
  primary: "#1f6feb",
  success: "#15803d",
  error: "#b91c1c",
  warning: "#d97706",
  spinner: "#1f6feb",
};

const jobWatchers = new Map();
const activeObservers = new Set();
let spinnerStyleInjected = false;
let debugEnabled = false;
let currentUrl = window.location.href;
const listValidationQueue = new Map();
let listValidationTimer = null;

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

const ICONS = {
  download: "M5 20h14v-2H5v2zm7-18v12h4l-5 5-5-5h4V2h2z",
  check: "M9 16.17 5.53 12.7 4.47 13.76 9 18.29 20 7.29 18.93 6.23 9 16.17z",
  spinner: "M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1 -8 -8V2z",
};

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

    #${BTN_GROUP_ID} {
      display: inline-flex;
      gap: 5px;
      align-items: center;
      flex-wrap: wrap;
    }

    .easyeda2kicad-dl-btn .dl-sub {
      display: block;
      font-size: 10px;
      font-weight: 400;
      opacity: 0.78;
      line-height: 1.1;
      margin-top: 1px;
      text-align: center;
    }

    .easyeda2kicad-dl-btn:disabled {
      opacity: 0.5 !important;
      cursor: default !important;
      transform: none !important;
      filter: none !important;
    }

    #easyeda2kicad-progress-track {
      width: 100%;
      height: 3px;
      background: rgba(255,255,255,0.12);
      border-radius: 0 0 4px 4px;
      overflow: hidden;
      transition: opacity 0.3s ease;
    }

    #easyeda2kicad-progress-bar {
      height: 100%;
      width: 0%;
      border-radius: 4px;
      background: linear-gradient(90deg, #38bdf8, #2563eb);
      transition: width 0.4s ease, background 0.3s ease;
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

    #easyeda2kicad-status-text {
      font-size: 11px;
      line-height: 1.3;
      margin-top: 5px;
      color: rgba(255,255,255,0.65);
      text-align: center;
      min-height: 0;
      transition: color 0.3s ease, opacity 0.3s ease;
      word-break: break-word;
    }

    #easyeda2kicad-status-text:empty {
      display: none;
    }

    #easyeda2kicad-status-text.status-error {
      color: #fca5a5;
    }

    #easyeda2kicad-status-text.status-success {
      color: #86efac;
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
      border: 1px solid rgba(248,113,113,0.45);
      background: rgba(248,113,113,0.1);
      color: #fca5a5;
      cursor: pointer;
      vertical-align: middle;
      transition: background 0.15s ease, border-color 0.15s ease;
      white-space: nowrap;
    }

    #easyeda2kicad-status-text .easyeda2kicad-copy-btn:hover {
      background: rgba(248,113,113,0.22);
      border-color: rgba(248,113,113,0.7);
    }

    #easyeda2kicad-status-text .easyeda2kicad-copy-btn.copied {
      border-color: rgba(134,239,172,0.5);
      background: rgba(134,239,172,0.12);
      color: #86efac;
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
    const response = await sendRuntimeMessage({ type: "getState" }, { retries: 5, delay: 300 });
    if (response?.ok && response.data) {
      debugEnabled = Boolean(response.data.debugLogs);
      dbg("debug flag initial", debugEnabled);
    }
  } catch (_error) {
    // ignore
  }
}

function clearJobWatcher(jobId) {
  const timer = jobWatchers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    jobWatchers.delete(jobId);
  }
}

function extractLcscIdFromString(str = "") {
  const match = str.match(/C\d+/i);
  return match ? match[0].toUpperCase() : null;
}

function extractLcscIdFromElement(element) {
  if (!element) {
    return null;
  }
  if (element.dataset && element.dataset.lcscId) {
    return element.dataset.lcscId.toUpperCase();
  }
  if (element.getAttribute) {
    const fromTitle = extractLcscIdFromString(element.getAttribute("title") || "");
    if (fromTitle) {
      return fromTitle;
    }
  }
  if (element.href) {
    const fromHref = extractLcscIdFromString(element.href);
    if (fromHref) {
      return fromHref;
    }
  }
  return extractLcscIdFromString(element.textContent || "");
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

function computeOutputAnalysis(job = {}) {
  const requested = {
    symbol: Boolean(job.outputs && job.outputs.symbol),
    footprint: Boolean(job.outputs && job.outputs.footprint),
    model: Boolean(job.outputs && job.outputs.model),
  };
  const result = job.result || {};
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

function formatMissingTooltip(missing = []) {
  if (!missing.length) {
    return "Partially imported";
  }
  const labels = missing.map(mapMissingLabel);
  if (labels.length === 1) {
    return `Incomplete: ${labels[0]} missing`;
  }
  const head = labels.slice(0, -1).join(", ");
  const tail = labels[labels.length - 1];
  return `Incomplete: ${head} and ${tail} missing`;
}

function buildSuccessTooltip(analysis, messages) {
  const parts = [];
  if (Array.isArray(messages) && messages.length) {
    parts.push(messages.join(" • "));
  }
  if (analysis && analysis.missing && analysis.missing.length) {
    parts.push(formatMissingTooltip(analysis.missing));
  }
  return parts.length ? parts.join(" | ") : null;
}

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

function extractPageData() {
  try {
    const categoryCell = document.getElementById("category_id");
    const categoryRaw = categoryCell?.nextElementSibling
      ?.querySelector("a")?.textContent?.trim() ?? null;
    const category = categoryRaw ? (categoryRaw.split("/")[1] ?? categoryRaw).trim() : null;

    const packageCell = document.getElementById("package_id");
    const pkg = packageCell?.nextElementSibling?.textContent?.trim() ?? null;

    const params = {};
    document.querySelectorAll("td[id^='paramsItem']").forEach((td) => {
      const label = td.textContent.trim();
      const value = td.nextElementSibling?.textContent?.trim();
      if (label && value) {
        params[label] = value;
      }
    });

    // Scrape Description and Datasheet PDF URL from the product info table
    const descriptionTd = extractInfoTableRow("Description");
    const description = descriptionTd
      ? descriptionTd.querySelector("span")?.textContent?.trim()
        ?? descriptionTd.textContent?.trim()
        ?? null
      : null;

    const datasheetTd = extractInfoTableRow("Datasheet");
    const datasheetUrl = datasheetTd?.querySelector("a")?.href ?? null;

    return { category, package: pkg, params, description, datasheetUrl };
  } catch (_err) {
    return { category: null, package: null, params: {}, description: null, datasheetUrl: null };
  }
}

function removeCategoryDialog() {
  const existing = document.getElementById(CATEGORY_DIALOG_ID);
  if (existing) {
    existing.remove();
  }
}

function showCategoryDialog(category, paramKeys, onConfirm, onSkip) {
  removeCategoryDialog();

  const overlay = document.createElement("div");
  overlay.id = CATEGORY_DIALOG_ID;
  overlay.style.cssText = [
    "position:fixed", "top:0", "left:0", "width:100%", "height:100%",
    "background:rgba(0,0,0,0.45)", "z-index:2147483647",
    "display:flex", "align-items:center", "justify-content:center",
    "font-family:sans-serif",
  ].join(";");

  const box = document.createElement("div");
  box.style.cssText = [
    "background:#fff", "border-radius:8px", "padding:24px 28px",
    "max-width:420px", "width:90%", "box-shadow:0 8px 32px rgba(0,0,0,0.18)",
    "color:#1a1a1a",
  ].join(";");

  const title = document.createElement("h3");
  title.style.cssText = "margin:0 0 6px 0;font-size:15px;font-weight:700;";
  title.textContent = "New category detected";

  const subtitle = document.createElement("p");
  subtitle.style.cssText = "margin:0 0 16px 0;font-size:13px;color:#555;";
  subtitle.textContent = `Configure symbol settings for: ${category}`;

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

  const valueRow = document.createElement("div");
  valueRow.style.cssText = "margin-bottom:16px;";
  const valueLabel = document.createElement("label");
  valueLabel.style.cssText = "display:block;font-size:13px;margin-bottom:4px;";
  valueLabel.textContent = "Value parameter (optional)";
  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.id = "easyeda2kicad-value-param";
  valueInput.placeholder = "e.g. Resistance";
  valueInput.list = "easyeda2kicad-param-list";
  valueInput.style.cssText = [
    "width:100%", "box-sizing:border-box", "padding:6px 8px",
    "border:1px solid #ccc", "border-radius:4px", "font-size:13px",
  ].join(";");

  const datalist = document.createElement("datalist");
  datalist.id = "easyeda2kicad-param-list";
  paramKeys.forEach((key) => {
    const opt = document.createElement("option");
    opt.value = key;
    datalist.appendChild(opt);
  });

  valueRow.appendChild(valueLabel);
  valueRow.appendChild(valueInput);
  valueRow.appendChild(datalist);

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:10px;justify-content:flex-end;margin-top:4px;";

  const skipBtn = document.createElement("button");
  skipBtn.textContent = "Skip";
  skipBtn.style.cssText = [
    "padding:7px 16px", "border:1px solid #ccc", "border-radius:4px",
    "background:#f5f5f5", "cursor:pointer", "font-size:13px",
  ].join(";");

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save & Download";
  saveBtn.style.cssText = [
    "padding:7px 16px", "border:none", "border-radius:4px",
    "background:#1f6feb", "color:#fff", "cursor:pointer", "font-size:13px",
    "font-weight:600",
  ].join(";");

  skipBtn.addEventListener("click", () => {
    removeCategoryDialog();
    onSkip();
  });

  saveBtn.addEventListener("click", () => {
    const hidePinNumbers = document.getElementById("easyeda2kicad-hide-num")?.checked ?? true;
    const hidePinNames = document.getElementById("easyeda2kicad-hide-name")?.checked ?? true;
    const valueParam = document.getElementById("easyeda2kicad-value-param")?.value?.trim() || null;
    removeCategoryDialog();
    onConfirm({ hidePinNumbers, hidePinNames, valueParam });
  });

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) {
      removeCategoryDialog();
      onSkip();
    }
  });

  btnRow.appendChild(skipBtn);
  btnRow.appendChild(saveBtn);
  box.appendChild(title);
  box.appendChild(subtitle);
  box.appendChild(hideNumRow);
  box.appendChild(hideNameRow);
  box.appendChild(valueRow);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  setTimeout(() => valueInput.focus(), 50);
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

function createButton(variant = "product") {
  ensureSpinnerStyle();
  const button = document.createElement("button");
  if (variant === "product") {
    button.id = BUTTON_ID;
  } else {
    button.classList.add(LIST_BUTTON_CLASS);
  }
  button.type = "button";
  button.setAttribute("title", "Download KiCad files");

  const iconSvg = document.createElementNS(SVG_NS, "svg");
  iconSvg.setAttribute("viewBox", "0 0 24 24");
  iconSvg.style.flexShrink = "0";
  iconSvg.id = "easyeda2kicad-icon";

  const iconPath = document.createElementNS(SVG_NS, "path");
  iconPath.setAttribute("d", ICONS.download);
  iconPath.setAttribute("fill", "currentColor");
  iconPath.setAttribute("id", "easyeda2kicad-icon-path");
  iconSvg.appendChild(iconPath);

  if (variant === "product") {
    // Full pill button with icon + label text
    Object.assign(button.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      padding: "7px 16px",
      borderRadius: "999px",
      border: "none",
      background: "linear-gradient(135deg, #1d4ed8, #2563eb)",
      color: "#fff",
      fontFamily: "inherit",
      fontSize: "13px",
      fontWeight: "600",
      letterSpacing: "0.01em",
      cursor: "pointer",
      transition: "filter 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease",
      boxShadow: "0 2px 8px rgba(37,99,235,0.35)",
      position: "relative",
      userSelect: "none",
      marginLeft: "0",
    });

    iconSvg.setAttribute("width", "15");
    iconSvg.setAttribute("height", "15");

    const label = document.createElement("span");
    label.id = "easyeda2kicad-btn-label";
    label.textContent = "Download";

    button.appendChild(iconSvg);
    button.appendChild(label);

    button.addEventListener("mouseenter", () => {
      if (!button.disabled) {
        button.style.filter = "brightness(1.12)";
        button.style.boxShadow = "0 4px 14px rgba(37,99,235,0.45)";
        button.style.transform = "translateY(-1px)";
      }
    });
    button.addEventListener("mouseleave", () => {
      button.style.filter = "";
      button.style.boxShadow = "0 2px 8px rgba(37,99,235,0.35)";
      button.style.transform = "";
    });
  } else {
    // Compact icon-only circle for list view
    Object.assign(button.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "32px",
      height: "32px",
      padding: "4px",
      borderRadius: "999px",
      border: "1px solid transparent",
      background: "transparent",
      cursor: "pointer",
      transition: "transform 0.2s ease",
      position: "relative",
      marginLeft: "8px",
    });

    iconSvg.setAttribute("width", "24");
    iconSvg.setAttribute("height", "24");
    iconPath.setAttribute("fill", COLORS.primary);

    button.appendChild(iconSvg);

    button.addEventListener("mouseenter", () => {
      if (!button.disabled) button.style.transform = "scale(1.08)";
    });
    button.addEventListener("mouseleave", () => {
      button.style.transform = "scale(1)";
    });
  }

  return button;
}

function setIcon(button, color, type = "download") {
  const path = button.querySelector("#easyeda2kicad-icon-path");
  if (!path) return;
  const isProductBtn = button.id === BUTTON_ID;
  const iconPath = ICONS[type] || ICONS.download;
  path.setAttribute("d", iconPath);
  if (isProductBtn) {
    // Product button uses currentColor via CSS; control color through button text color
    path.setAttribute("fill", "currentColor");
    path.setAttribute("opacity", "1");
  } else {
    const resolvedColor = typeof color === "string" && color ? color : COLORS.primary;
    path.setAttribute("fill", resolvedColor);
    path.setAttribute("opacity", resolvedColor === "transparent" ? "0" : "1");
  }
  button.dataset.iconType = type;
}

function setBtnLabel(button, text) {
  const label = button.querySelector("#easyeda2kicad-btn-label");
  if (label) label.textContent = text;
}

function setGroupEnabled(enabled) {
  const group = document.getElementById(BTN_GROUP_ID);
  if (!group) return;
  group.querySelectorAll("button").forEach((btn) => {
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

function markGroupExists(excludeBtn, tooltip) {
  const group = document.getElementById(BTN_GROUP_ID);
  if (!group) return;
  const msg = tooltip || "Already in library – click to update";
  group.querySelectorAll("button").forEach((b) => {
    if (b !== excludeBtn) {
      setBtnTheme(b, "exists");
      b.dataset.libState = "exists";
      b.setAttribute("title", msg);
    }
  });
}

function setBtnTheme(button, theme) {
  const themes = {
    primary: {
      background: "linear-gradient(135deg, #1d4ed8, #2563eb)",
      boxShadow: "0 2px 8px rgba(37,99,235,0.35)",
      color: "#fff",
      opacity: "1",
    },
    success: {
      background: "linear-gradient(135deg, #15803d, #16a34a)",
      boxShadow: "0 2px 8px rgba(22,163,74,0.35)",
      color: "#fff",
      opacity: "1",
    },
    warning: {
      background: "linear-gradient(135deg, #b45309, #d97706)",
      boxShadow: "0 2px 8px rgba(217,119,6,0.3)",
      color: "#fff",
      opacity: "1",
    },
    error: {
      background: "linear-gradient(135deg, #b91c1c, #dc2626)",
      boxShadow: "0 2px 8px rgba(220,38,38,0.35)",
      color: "#fff",
      opacity: "1",
    },
    disabled: {
      background: "linear-gradient(135deg, #1e3a6e, #1d4ed8)",
      boxShadow: "none",
      color: "rgba(255,255,255,0.65)",
      opacity: "0.8",
    },
    exists: {
      background: "linear-gradient(135deg, #0d6b5e, #0f766e)",
      boxShadow: "0 2px 8px rgba(15,118,110,0.35)",
      color: "#fff",
      opacity: "1",
    },
  };
  const t = themes[theme] || themes.primary;
  Object.assign(button.style, t);
}

function setSpin(button, enable) {
  const svg = button.querySelector("#easyeda2kicad-icon");
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
    case "exists":
      button.disabled = false;
      setSpin(button, false);
      setIcon(button, "#d1fae5", "download");
      setBtnLabel(button, "Download");
      setBtnTheme(button, "exists");
      button.dataset.libState = "exists";
      button.style.cursor = "pointer";
      button.setAttribute("title", options.message || "Already in library – click to update");
      setProgressUI({ visible: false });
      setGroupEnabled(true);
      break;
    case "pending":
      setGroupEnabled(false);
      button.disabled = true;
      setSpin(button, true);
      setIcon(button, COLORS.spinner, "spinner");
      setBtnLabel(button, "Starting…");
      setBtnTheme(button, "disabled");
      button.style.cursor = "default";
      button.setAttribute("title", options.message || "Conversion is starting…");
      setProgressUI({
        visible: true,
        barClass: "indeterminate",
        message: options.message || "Sending to backend…",
      });
      break;
    case "progress": {
      setGroupEnabled(false);
      const pct = options.progress ?? 0;
      button.disabled = true;
      setSpin(button, true);
      setIcon(button, COLORS.spinner, "spinner");
      setBtnLabel(button, pct > 0 ? `${Math.round(pct)} %` : "Converting…");
      setBtnTheme(button, "disabled");
      button.style.cursor = "default";
      button.setAttribute("title", options.message || `Conversion in progress… ${Math.round(pct)}%`);
      setProgressUI({
        visible: true,
        barClass: pct > 0 ? "" : "indeterminate",
        widthPct: pct > 0 ? pct : null,
        message: options.message || `Converting… ${Math.round(pct)} %`,
      });
      break;
    }
    case "success":
      button.disabled = false;
      setSpin(button, false);
      setIcon(button, COLORS.success, "check");
      setBtnLabel(button, "Done");
      setBtnTheme(button, "success");
      button.style.cursor = "pointer";
      button.setAttribute("title", options.message || "Available in library");
      setProgressUI({
        visible: true,
        barClass: "success",
        widthPct: 100,
        message: options.message || "Added to library",
        messageClass: "status-success",
      });
      setGroupEnabled(true);
      setTimeout(() => {
        updateButtonState(button, "exists", { message: "In library – click to update" });
        markGroupExists(button, "In library – click to update");
      }, 4000);
      break;
    case "partial":
      button.disabled = false;
      setSpin(button, false);
      setIcon(button, COLORS.warning, options.iconType || "download");
      setBtnLabel(button, "Partial");
      setBtnTheme(button, "warning");
      button.style.cursor = "pointer";
      button.setAttribute("title", options.message || "Incomplete – partially imported");
      setProgressUI({
        visible: true,
        barClass: "success",
        widthPct: 100,
        message: options.message || "Partially imported",
        messageClass: "status-success",
      });
      setGroupEnabled(true);
      setTimeout(() => {
        setBtnLabel(button, "Download");
        setBtnTheme(button, "primary");
        setIcon(button, COLORS.primary, "download");
        setProgressUI({ visible: false });
        setGroupEnabled(true);
      }, 6000);
      break;
    case "error":
      button.disabled = false;
      setSpin(button, false);
      setIcon(button, COLORS.error, "download");
      setBtnLabel(button, "Retry");
      setBtnTheme(button, "error");
      button.style.cursor = "pointer";
      button.setAttribute("title", options.message || "Download failed");
      setProgressUI({
        visible: true,
        barClass: "error",
        widthPct: 100,
        message: options.message || "Download failed",
        messageClass: "status-error",
        copyText: options.copyText || options.message || null,
      });
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
        message: messages.join(" • ") || formatMissingTooltip(analysis.missing),
        iconType: "download",
      });
    } else {
      const tooltip = buildSuccessTooltip(analysis, messages);
      updateButtonState(button, "exists", {
        message: tooltip || "Already in library – click to update",
      });
      markGroupExists(button);
    }
    button.dataset[INIT_ATTR] = "true";
    return;
  }

  if (data.inProgress && data.jobId) {
    updateButtonState(button, "progress", {
      progress: 0,
      message: "Conversion in progress…",
    });
    startJobWatcher(button, data.jobId);
    button.dataset[INIT_ATTR] = "true";
    return;
  }

  updateButtonState(button, "idle");
  button.dataset[INIT_ATTR] = "true";
}

function getProgressElements() {
  return {
    track: document.getElementById("easyeda2kicad-progress-track"),
    bar: document.getElementById("easyeda2kicad-progress-bar"),
    text: document.getElementById("easyeda2kicad-status-text"),
    row: document.getElementById("easyeda2kicad-progress-row"),
  };
}

function setProgressUI({ visible = true, barClass = "", widthPct = null, message = "", messageClass = "", copyText = null } = {}) {
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

function createDlButton(subLabel, { primary = false } = {}) {
  ensureSpinnerStyle();
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("easyeda2kicad-dl-btn");
  if (primary) button.id = BUTTON_ID;

  Object.assign(button.style, {
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "5px 12px",
    borderRadius: "999px",
    border: "none",
    background: "linear-gradient(135deg, #1d4ed8, #2563eb)",
    color: "#fff",
    fontFamily: "inherit",
    cursor: "pointer",
    transition: "filter 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease",
    boxShadow: "0 2px 8px rgba(37,99,235,0.35)",
    userSelect: "none",
    position: "relative",
  });

  const mainRow = document.createElement("div");
  mainRow.style.cssText = "display:flex;align-items:center;gap:4px;";

  const iconSvg = document.createElementNS(SVG_NS, "svg");
  iconSvg.setAttribute("viewBox", "0 0 24 24");
  iconSvg.setAttribute("width", "13");
  iconSvg.setAttribute("height", "13");
  iconSvg.style.flexShrink = "0";
  if (primary) iconSvg.id = "easyeda2kicad-icon";

  const iconPath = document.createElementNS(SVG_NS, "path");
  iconPath.setAttribute("d", ICONS.download);
  iconPath.setAttribute("fill", "currentColor");
  iconPath.setAttribute("opacity", "1");
  if (primary) iconPath.id = "easyeda2kicad-icon-path";
  iconSvg.appendChild(iconPath);

  const mainTextSpan = document.createElement("span");
  mainTextSpan.style.cssText = "font-size:12px;font-weight:600;line-height:1.3;letter-spacing:0.01em;";
  mainTextSpan.textContent = "Download";
  if (primary) mainTextSpan.id = "easyeda2kicad-btn-label";

  mainRow.appendChild(iconSvg);
  mainRow.appendChild(mainTextSpan);

  const subSpan = document.createElement("span");
  subSpan.className = "dl-sub";
  subSpan.textContent = subLabel;

  button.appendChild(mainRow);
  button.appendChild(subSpan);

  button.addEventListener("mouseenter", () => {
    if (!button.disabled) {
      button.style.filter = "brightness(1.12)";
      button.style.transform = "translateY(-1px)";
      button.style.boxShadow = button.dataset.libState === "exists"
        ? "0 4px 14px rgba(15,118,110,0.45)"
        : "0 4px 14px rgba(37,99,235,0.45)";
    }
  });
  button.addEventListener("mouseleave", () => {
    button.style.filter = "";
    button.style.transform = "";
    button.style.boxShadow = button.dataset.libState === "exists"
      ? "0 2px 8px rgba(15,118,110,0.35)"
      : "0 2px 8px rgba(37,99,235,0.35)";
  });

  return button;
}

function buildDlOptions(catConfig, templateStatus) {
  const templateName = catConfig?.templateName;
  if (!templateName) {
    return [{ subLabel: "LCSC", useTemplate: false, templateName: null }];
  }

  // Detect a polarized companion: any template named "{base}_Polarized" qualifies.
  // This handles both "C"/"C_Polarized" and legacy "Template_Capacitor"/"Template_Capacitor_Polarized".
  const polarizedName = templateName + "_Polarized";
  const hasPolarized = Boolean(templateStatus?.[polarizedName]);
  const hasBase = Boolean(templateStatus?.[templateName]);

  if (hasPolarized) {
    const options = [];
    options.push({ subLabel: "Polarized", useTemplate: true, templateName: polarizedName });
    if (hasBase) {
      options.push({ subLabel: "Non-Polar.", useTemplate: true, templateName });
    }
    options.push({ subLabel: "LCSC", useTemplate: false, templateName: null });
    return options;
  }

  if (hasBase) {
    return [
      { subLabel: "Template", useTemplate: true, templateName },
      { subLabel: "LCSC", useTemplate: false, templateName: null },
    ];
  }

  return [{ subLabel: "LCSC", useTemplate: false, templateName: null }];
}

async function refreshButtonGroup(lcscId, groupDiv) {
  try {
    const pageData = extractPageData();
    if (!pageData.category) return;

    const catResp = await sendRuntimeMessage(
      { type: "getCategorySettings", category: pageData.category },
      { retries: 2, delay: 200 },
    );
    const catConfig = catResp?.ok ? catResp.data : null;
    if (!catConfig?.templateName) return;

    const tmplResp = await sendRuntimeMessage(
      { type: "getTemplateStatus" },
      { retries: 2, delay: 200 },
    );
    const templateStatus = tmplResp?.ok ? tmplResp.data : {};

    const dlOptions = buildDlOptions(catConfig, templateStatus);
    if (dlOptions.length <= 1) return;

    // Preserve current primary button state before rebuild
    const oldPrimary = groupDiv.querySelector(`#${BUTTON_ID}`);
    const wasDisabled = oldPrimary?.disabled ?? false;

    groupDiv.innerHTML = "";

    let newPrimary = null;
    dlOptions.forEach((opt) => {
      const isPrimary = !opt.useTemplate && !newPrimary;
      const btn = createDlButton(opt.subLabel, { primary: isPrimary });
      if (isPrimary) newPrimary = btn;

      btn.addEventListener("click", () => {
        handleDownloadClick(btn, lcscId, {
          useTemplate: opt.useTemplate,
          templateName: opt.templateName,
        });
      });

      groupDiv.appendChild(btn);
    });

    if (newPrimary) {
      if (wasDisabled) {
        updateButtonState(newPrimary, "pending");
      } else {
        // Check existence once and apply state to ALL buttons in the rebuilt group
        try {
          const existResp = await sendRuntimeMessage(
            { type: "checkComponentExists", lcscId },
            { retries: 3, delay: 300 },
          );
          if (existResp?.ok) {
            const d = existResp.data || {};
            const msgs = Array.isArray(d.messages) ? d.messages : [];
            const analysis = d.outputAnalysis
              || computeOutputAnalysis({ outputs: d.outputs, result: d.result });
            if (d.completed && !analysis.partial) {
              const tooltip = buildSuccessTooltip(analysis, msgs);
              updateButtonState(newPrimary, "exists", {
                message: tooltip || "Already in library – click to update",
              });
              markGroupExists(newPrimary);
            } else if (d.completed && analysis.partial) {
              updateButtonState(newPrimary, "partial", {
                message: msgs.join(" • ") || formatMissingTooltip(analysis.missing),
                iconType: "download",
              });
            } else if (d.inProgress && d.jobId) {
              updateButtonState(newPrimary, "progress", {
                progress: 0,
                message: "Conversion in progress…",
              });
              startJobWatcher(newPrimary, d.jobId);
            } else {
              updateButtonState(newPrimary, "idle");
            }
          } else {
            updateButtonState(newPrimary, "idle");
          }
        } catch (e) {
          dbg("refreshButtonGroup: checkComponentExists failed", e);
          updateButtonState(newPrimary, "idle");
        }
        newPrimary.dataset[INIT_ATTR] = "true";
      }
    }
  } catch (err) {
    dbg("refreshButtonGroup failed", err);
  }
}

function attachButton(lcscId) {
  const tbody = findInsertionPoint();
  if (!tbody) {
    dbg("attachButton: no tbody found");
    return false;
  }

  if (document.getElementById(BUTTON_ID)) {
    dbg("attachButton: product button already present");
    return true;
  }

  // Create button group wrapper
  const groupDiv = document.createElement("div");
  groupDiv.id = BTN_GROUP_ID;

  // Start with a single LCSC button; refreshButtonGroup may add template buttons
  const button = createDlButton("LCSC", { primary: true });
  button.dataset.lcscId = lcscId;
  updateButtonState(button, "idle");
  button.addEventListener("click", () => handleDownloadClick(button, lcscId));
  button.dataset[INIT_ATTR] = "false";
  groupDiv.appendChild(button);

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
  progressRow.id = "easyeda2kicad-progress-row";
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

  initialiseButtonState(button, lcscId);
  // Async: add template buttons if templates are configured for this category
  refreshButtonGroup(lcscId, groupDiv);
  dbg("attachButton: inserted product button", lcscId);
  return true;
}

function insertListButton(container, lcscId) {
  if (!container) {
    dbg("insertListButton: missing container", lcscId);
    return;
  }

  const existingHolder = container.querySelector(`.${LIST_CONTAINER_CLASS}`);
  if (existingHolder) {
    const existingId = existingHolder.dataset.lcscId;
    const button = existingHolder.querySelector("button");
    if (existingId === lcscId) {
      dbg("insertListButton: holder already bound to", lcscId);
      if (button && button.dataset[INIT_ATTR] !== "true") {
        updateButtonState(button, "idle");
        button.dataset[INIT_ATTR] = "false";
        queueListValidation(button, lcscId);
      }
      return;
    }
    dbg("insertListButton: reusing holder, old id", existingId, "new id", lcscId);
    existingHolder.dataset.lcscId = lcscId;
    existingHolder.innerHTML = "";
    const newButton = createButton("list");
    newButton.dataset.lcscId = lcscId;
    updateButtonState(newButton, "idle");
    newButton.dataset[INIT_ATTR] = "false";
    newButton.addEventListener("click", () => handleDownloadClick(newButton, lcscId));
    existingHolder.appendChild(newButton);
    queueListValidation(newButton, lcscId);
    return;
  }

  const button = createButton("list");
  button.dataset.lcscId = lcscId;
  updateButtonState(button, "idle");
  button.dataset[INIT_ATTR] = "false";
  button.addEventListener("click", () => handleDownloadClick(button, lcscId));

  const holder = document.createElement("span");
  holder.className = LIST_CONTAINER_CLASS;
  holder.dataset.lcscId = lcscId;
  holder.style.display = "inline-flex";
  holder.style.alignItems = "center";
  holder.style.marginLeft = "6px";
  holder.appendChild(button);
  container.appendChild(holder);

  queueListValidation(button, lcscId);
  dbg("insertListButton: added", lcscId);
}

function attachListButtons() {
  const tableBody = document.querySelector(".tableContentTable > tbody");
  if (!tableBody) {
    dbg("attachListButtons: no table body");
    return false;
  }
  dbg("attachListButtons: row count", tableBody.children.length);
  let inserted = false;
  Array.from(tableBody.children).forEach((row, index) => {
    if (!row || !row.children || row.children.length < 2) {
      dbg("attachListButtons: skip row", index, "unexpected structure");
      return;
    }
    const cell = row.children[1];
    const wrapper = cell?.children?.[0];
    if (!wrapper) {
      dbg("attachListButtons: skip row", index, "missing wrapper");
      return;
    }
    const targetSlot = wrapper.children && wrapper.children[1] ? wrapper.children[1] : wrapper;
    const anchor = wrapper.querySelector("span > a") || wrapper.querySelector("a");
    const lcscId = extractLcscIdFromElement(anchor);
    if (!lcscId) {
      dbg("attachListButtons: skip row", index, "no LCSC id");
      return;
    }
    insertListButton(targetSlot, lcscId);
    inserted = true;
  });
  dbg("attachListButtons: inserted?", inserted);
  return inserted;
}

async function handleDownloadClick(button, lcscId, overrides = {}) {
  dbg("handleDownloadClick", lcscId, overrides);
  try {
    const status = await sendRuntimeMessage({ type: "getState" }, { retries: 2, delay: 200 });
    if (!status?.ok || !status.data) {
      throw new Error(status?.error || "Unable to reach extension backend.");
    }
    if (!status.data.connected) {
      updateButtonState(button, "error", { message: "Backend not reachable. Start the backend." });
      return;
    }
  } catch (error) {
    updateButtonState(button, "error", { message: error.message || "Backend not reachable." });
    return;
  }

  const pageData = extractPageData();
  dbg("extractPageData", pageData);

  if (pageData.category) {
    try {
      const knownResponse = await sendRuntimeMessage(
        { type: "checkCategoryKnown", category: pageData.category },
        { retries: 2, delay: 200 },
      );
      const isKnown = knownResponse?.ok && knownResponse.data?.known;
      if (!isKnown) {
        await new Promise((resolve) => {
          showCategoryDialog(
            pageData.category,
            Object.keys(pageData.params || {}),
            async (config) => {
              try {
                await sendRuntimeMessage({
                  type: "saveCategorySettings",
                  category: pageData.category,
                  config,
                });
              } catch (_err) {
                dbg("saveCategorySettings failed", _err);
              }
              resolve();
            },
            () => resolve(),
          );
        });
      }
    } catch (_err) {
      dbg("checkCategoryKnown failed", _err);
    }
  }

  updateButtonState(button, "pending", { progress: 0, message: "Conversion is starting…" });
  try {
    const response = await sendRuntimeMessage(
      {
        type: "quickDownload",
        lcscId,
        source: "contentScript",
        category: pageData.category,
        componentPackage: pageData.package,
        params: pageData.params,
        description: pageData.description,
        datasheetUrl: pageData.datasheetUrl,
        useTemplate: overrides.useTemplate || false,
        templateName: overrides.templateName || null,
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
      updateButtonState(button, "progress", { progress: 0, message: "Conversion in progress…" });
      startJobWatcher(button, jobId);
    } else {
      updateButtonState(button, "success", { message: "Job queued" });
    }
  } catch (error) {
    console.error("easyeda2kicad quick download failed", error);
    updateButtonState(button, "error", {
      message: error.message || "Failed to start conversion",
      copyText: `Error: ${error.message || "Unknown error"}\n\nLCSC: ${lcscId}\n${error.stack || ""}`.trim(),
    });
    dbg("handleDownloadClick: failed", lcscId, error);
  }
}

async function initialiseButtonState(button, lcscId) {
  try {
    const response = await sendRuntimeMessage(
      {
        type: "checkComponentExists",
        lcscId,
      },
      { retries: 4, delay: 300 },
    );
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to check library status");
    }
    const data = response.data || {};
    dbg("initialiseButtonState", lcscId, data);
    applyComponentState(button, data);
  } catch (error) {
    dbg("checkComponentExists failed", error);
    const message = error?.message || "";
    if (/backend/i.test(message) || /reach/i.test(message)) {
      updateButtonState(button, "partial", {
        message: "Backend offline. Status unknown.",
        iconType: "download",
      });
    } else {
      updateButtonState(button, "idle");
    }
    button.dataset[INIT_ATTR] = "true";
  }
}

function queueListValidation(button, lcscId) {
  if (!button || !lcscId) {
    return;
  }
  if (button.dataset[INIT_ATTR] === "true") {
    return;
  }
  const normalized = lcscId.toUpperCase();
  const entry = listValidationQueue.get(normalized) || new Set();
  entry.add(button);
  listValidationQueue.set(normalized, entry);
  scheduleListValidation();
}

function scheduleListValidation(delay = 300) {
  if (listValidationTimer) {
    clearTimeout(listValidationTimer);
  }
  listValidationTimer = setTimeout(runListValidation, delay);
}

async function runListValidation() {
  if (!listValidationQueue.size) {
    return;
  }
  const queued = new Map(listValidationQueue);
  listValidationQueue.clear();
  listValidationTimer = null;

  const lcscIds = Array.from(queued.keys());
  try {
    const response = await sendRuntimeMessage(
      {
        type: "checkComponentsExists",
        lcscIds,
      },
      { retries: 3, delay: 300 },
    );
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to check library status");
    }
    const results = response.data?.results || {};
    lcscIds.forEach((lcscId) => {
      const data = results[lcscId] || {};
      const buttons = queued.get(lcscId);
      if (!buttons) {
        return;
      }
      buttons.forEach((button) => {
        applyComponentState(button, data);
      });
    });
  } catch (error) {
    dbg("checkComponentsExists failed", error);
    const message = error?.message || "";
    lcscIds.forEach((lcscId) => {
      const buttons = queued.get(lcscId);
      if (!buttons) {
        return;
      }
      buttons.forEach((button) => {
        if (/backend/i.test(message) || /reach/i.test(message)) {
          updateButtonState(button, "partial", {
            message: "Backend offline. Status unknown.",
            iconType: "download",
          });
        } else {
          updateButtonState(button, "idle");
        }
        button.dataset[INIT_ATTR] = "true";
      });
    });
  }
}

function startJobWatcher(button, jobId) {
  clearJobWatcher(jobId);
  dbg("startJobWatcher", jobId);

  const poll = async () => {
    try {
      const response = await sendRuntimeMessage(
        {
          type: "getJobStatus",
          jobId,
        },
        { retries: 4, delay: 400 },
      );
      if (!response?.ok) {
        throw new Error(response?.error || "Job status unavailable");
      }
      const job = response.data || {};
      const messages = Array.isArray(job.messages) ? job.messages : [];
      const progress = Number.isFinite(job.progress) ? job.progress : job.status === "queued" ? 5 : 50;

      const analysis = job.outputAnalysis
        || computeOutputAnalysis({ outputs: job.outputs, result: job.result });
      dbg("job status", jobId, job.status, progress, analysis);
      if (job.status === "completed") {
        if (analysis.partial) {
          updateButtonState(button, "partial", {
            message: messages.join(" • ") || formatMissingTooltip(analysis.missing),
          });
        } else {
          const tooltip = buildSuccessTooltip(analysis, messages);
          updateButtonState(button, "success", {
            message: tooltip || "Conversion finished",
          });
        }
        clearJobWatcher(jobId);
        return;
      }
      if (job.status === "failed") {
        updateButtonState(button, "error", {
        message: job.message || "Conversion failed",
        copyText: `Job failed: ${job.message || "Unknown error"}\n\nJob ID: ${jobId}\nStatus: ${job.status}\n${job.error || ""}`.trim(),
      });
        clearJobWatcher(jobId);
        return;
      }

      const message = job.status === "queued"
        ? "Waiting in queue…"
        : `Conversion in progress – ${Math.round(progress)}%`;
      updateButtonState(button, "progress", { progress, message });
      const delay = job.status === "queued" ? 2000 : 1200;
      const timer = setTimeout(poll, delay);
      jobWatchers.set(jobId, timer);
    } catch (error) {
      console.warn("Polling job status failed", error);
      updateButtonState(button, "error", {
        message: error.message || "Failed to fetch job status",
        copyText: `Error: ${error.message || "Unknown error"}\n\nJob ID: ${jobId}\n${error.stack || ""}`.trim(),
      });
      clearJobWatcher(jobId);
      dbg("job watcher error", jobId, error);
    }
  };

  poll();
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
  const progressRow = document.getElementById("easyeda2kicad-progress-row");
  if (progressRow?.parentElement) {
    progressRow.parentElement.removeChild(progressRow);
  }
  document.querySelectorAll(`.${LIST_CONTAINER_CLASS}`).forEach((holder) => {
    holder.remove();
  });
  jobWatchers.forEach((_, jobId) => clearJobWatcher(jobId));
  listValidationQueue.clear();
  if (listValidationTimer) {
    clearTimeout(listValidationTimer);
    listValidationTimer = null;
  }
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

  if (LIST_REGEX.test(path) || document.querySelector(".tableContentTable")) {
    attachListButtons();
    const tableBody = document.querySelector(".tableContentTable > tbody");
    if (!tableBody) {
      return;
    }
    const observer = new MutationObserver(() => {
      attachListButtons();
    });
    observer.observe(tableBody, {
      childList: true,
      subtree: true,
    });
    registerObserver(observer);
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
