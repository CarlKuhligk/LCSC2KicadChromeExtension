"use strict";

import {
  CS_DIALOG,
  PREFERRED_VALUE_PARAM_KEYS,
  dialogButtonStyle,
  mountCsModal,
  dismissCsModalById,
} from "./dialog.js";
import {
  VALUE_PARAM_FALLBACK_DIALOG_ID,
  VALUE_PARAM_MISMATCH_DIALOG_ID,
} from "./constants.js";

/**
 * Two LCSC modal dialogs and their resolution helpers (see CONTEXT.md):
 *
 *   - **Value-Param Fallback** — the LCSC attribute table could not be read /
 *     is empty. User picks: default Value (EasyEDA), open Category-rule
 *     configuration, or cancel.
 *   - **Value-Param Mismatch** — the saved Category-rule names a Value
 *     parameter that is missing on this page. Same three outcomes.
 *
 * Plus pure helpers that the orchestration in app.js uses to decide whether
 * either dialog is needed.
 */

// ---------- pure helpers ----------

/** First match against {@link PREFERRED_VALUE_PARAM_KEYS} (case-insensitive); else `paramKeys[0]`; else "". */
export function getDefaultValueParamKey(paramKeys) {
  if (!Array.isArray(paramKeys) || paramKeys.length === 0) return "";
  const keyLower = (k) => (k || "").toLowerCase();
  const preferredLower = PREFERRED_VALUE_PARAM_KEYS.map(keyLower);
  const match = paramKeys.find((k) => preferredLower.includes(keyLower(k)));
  return match != null ? match : paramKeys[0];
}

/**
 * No usable LCSC attribute table data: empty params **and** empty value-param
 * dropdown options. In that case the user must choose EasyEDA-default Value
 * versus configuring the value-parameter mapping.
 */
export function needsValueParamFromPage(pageData) {
  const params = pageData?.params && typeof pageData.params === "object" ? pageData.params : {};
  const hasAnyParam = Object.entries(params).some(([, v]) => v != null && String(v).trim() !== "");
  const opts = Array.isArray(pageData?.valueParamOptions) ? pageData.valueParamOptions : [];
  return !hasAnyParam && opts.length === 0;
}

/** True when the saved Category-rule "Value parameter" key exists on the page with a non-empty value. */
export function isConfiguredValueParamPresentOnPage(pageData, valueParamKey) {
  const key = (valueParamKey || "").trim();
  if (!key) return true;
  const params = pageData?.params && typeof pageData.params === "object" ? pageData.params : {};
  const raw = params[key];
  return raw != null && String(raw).trim() !== "";
}

// ---------- dialog dismiss ----------

export function removeValueParamFallbackDialog() {
  dismissCsModalById(VALUE_PARAM_FALLBACK_DIALOG_ID);
}

export function removeValueParamMismatchDialog() {
  dismissCsModalById(VALUE_PARAM_MISMATCH_DIALOG_ID);
}

// ---------- dialogs ----------

/**
 * @typedef {{ mode: "default" | "configure" | "cancel" }} ValueParamChoice
 */

/**
 * Shows the "no product parameters found" dialog.
 * @param {(result: ValueParamChoice) => void} onDone
 */
export function showValueParamFallbackDialog(onDone) {
  removeValueParamFallbackDialog();

  let settled = false;
  const finish = (mode) => {
    if (settled) return;
    settled = true;
    dismissCsModalById(VALUE_PARAM_FALLBACK_DIALOG_ID);
    if (typeof onDone === "function") onDone({ mode });
  };

  const title = document.createElement("h3");
  title.style.cssText = `margin:0 0 6px 0;font-size:15px;font-weight:600;letter-spacing:-0.015em;color:${CS_DIALOG.panelText};`;
  title.textContent = "No product parameters found";

  const subtitle = document.createElement("p");
  subtitle.style.cssText = `margin:0 0 18px 0;font-size:13px;color:${CS_DIALOG.panelMuted};line-height:1.45;`;
  subtitle.textContent =
    "The LCSC attributes table could not be read (or it is empty). "
    + "You can keep the KiCad Value field as in EasyEDA (usually the part name), "
    + "or open the same settings as for a new category to choose which LCSC field maps to Value when data is available.";

  const btnRow = document.createElement("div");
  btnRow.style.cssText = [
    "display:flex",
    "gap:10px",
    "justify-content:flex-end",
    "flex-wrap:wrap",
    "margin-top:16px",
    "padding-top:14px",
    `border-top:1px solid ${CS_DIALOG.panelBorder}`,
  ].join(";");

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

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(configureBtn);
  btnRow.appendChild(defaultBtn);

  mountCsModal({
    id: VALUE_PARAM_FALLBACK_DIALOG_ID,
    maxWidthPx: 440,
    header: title,
    children: [subtitle],
    footer: btnRow,
    onDismiss: () => {
      if (!settled && typeof onDone === "function") {
        settled = true;
        onDone({ mode: "cancel" });
      }
    },
  });
}

/**
 * Shows the "saved value-parameter not on page" dialog.
 * @param {string} configuredKey
 * @param {(result: ValueParamChoice) => void} onDone
 */
export function showValueParamMismatchDialog(configuredKey, onDone) {
  removeValueParamMismatchDialog();

  let settled = false;
  const finish = (mode) => {
    if (settled) return;
    settled = true;
    dismissCsModalById(VALUE_PARAM_MISMATCH_DIALOG_ID);
    if (typeof onDone === "function") onDone({ mode });
  };

  const title = document.createElement("h3");
  title.style.cssText = `margin:0 0 6px 0;font-size:15px;font-weight:600;letter-spacing:-0.015em;color:${CS_DIALOG.panelText};line-height:1.3;`;
  title.textContent = "Value parameter not found on page";

  const intro = document.createElement("p");
  intro.style.cssText = `margin:0 0 12px 0;font-size:13px;color:${CS_DIALOG.panelMuted};line-height:1.55;`;
  intro.textContent = "Your category uses this LCSC attribute for the KiCad Value field, but it is missing or has no value in the tables on this page:";

  const keyWrap = document.createElement("div");
  keyWrap.style.cssText = [
    "display:block",
    "margin:0 0 14px 0",
    "padding:12px 14px",
    `border-radius:${CS_DIALOG.radius}`,
    `background:${CS_DIALOG.dangerBg}`,
    `border:1px solid ${CS_DIALOG.dangerBorder}`,
  ].join(";");
  const keyEl = document.createElement("span");
  keyEl.textContent = configuredKey && String(configuredKey).trim() ? String(configuredKey).trim() : "(empty)";
  keyEl.style.cssText = [
    "font-weight:700",
    "font-size:14px",
    `color:${CS_DIALOG.dangerText}`,
    "letter-spacing:0.01em",
    "word-break:break-word",
  ].join(";");
  keyWrap.appendChild(keyEl);

  const hint = document.createElement("p");
  hint.style.cssText = `margin:0 0 4px 0;font-size:13px;color:${CS_DIALOG.panelMuted};line-height:1.5;`;
  hint.textContent =
    "You can continue with the EasyEDA default Value (usually the part name) or pick another LCSC field.";

  const btnRow = document.createElement("div");
  btnRow.style.cssText = [
    "display:flex",
    "flex-direction:row",
    "flex-wrap:wrap",
    "align-items:center",
    "gap:10px",
    "margin-top:16px",
    "padding-top:14px",
    `border-top:1px solid ${CS_DIALOG.panelBorder}`,
  ].join(";");

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

  btnRow.appendChild(defaultBtn);
  btnRow.appendChild(configureBtn);
  btnRow.appendChild(cancelBtn);

  mountCsModal({
    id: VALUE_PARAM_MISMATCH_DIALOG_ID,
    maxWidthPx: 460,
    header: title,
    children: [intro, keyWrap, hint],
    footer: btnRow,
    onDismiss: () => {
      if (!settled && typeof onDone === "function") {
        settled = true;
        onDone({ mode: "cancel" });
      }
    },
  });
}

// ---------- Promise-shaped wrappers ----------

/** @returns {Promise<ValueParamChoice>} */
export function promiseValueParamFallback() {
  return new Promise((resolve) => {
    showValueParamFallbackDialog((result) => resolve(result));
  });
}

/** @returns {Promise<ValueParamChoice>} */
export function promiseValueParamMismatch(configuredKey) {
  return new Promise((resolve) => {
    showValueParamMismatchDialog(configuredKey, (result) => resolve(result));
  });
}
