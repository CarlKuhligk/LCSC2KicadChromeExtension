"use strict";

import {
  CS_DIALOG,
  CSS_MODAL_OVERLAY_STANDARD,
  cssModalPanelLight,
  categoryBreadcrumbBtnStyle,
  dialogButtonStyle,
  dismissCsModalById,
  lockOverlayPageScroll,
} from "./dialog.js";
import { CATEGORY_DIALOG_ID } from "./constants.js";
import { normalizeCategoryPath } from "./categoryNormalize.js";
import { getDefaultValueParamKey } from "./lcscValueParamDialogs.js";

/**
 * "New category detected" LCSC modal (see CONTEXT.md). Mounted when an
 * import sees an LCSC breadcrumb that has no matching Category Rule yet.
 *
 * The user can:
 *   - **Skip** the dialog → proceed with the import, no rule saved.
 *   - **Save & continue** → persist a Category Rule under the chosen
 *     breadcrumb path, with the Value-Param mapping and pin-visibility flags.
 *   - **Continue** → use the form values for this one import only.
 *   - **Cancel** → close and abort the download.
 *
 * Unlike the Value-Param dialogs (see {@link ./lcscValueParamDialogs.js}),
 * this modal builds its own overlay element rather than using
 * `mountCsModal`. The shape is preserved verbatim from the original
 * extraction; consolidation onto `mountCsModal` is a follow-up.
 */

/** Dismiss the modal if it is currently mounted (idempotent). */
export function removeCategoryDialog() {
  dismissCsModalById(CATEGORY_DIALOG_ID);
}

/**
 * @typedef {{
 *   category: string,
 *   hidePinNumbers: boolean,
 *   hidePinNames: boolean,
 *   valueParam: string | null,
 * }} CategoryDialogPayload
 */

/**
 * @param {string} category Full LCSC path from the product page (slash-separated).
 * @param {string[]} paramKeys LCSC attribute names available on the page.
 * @param {{
 *   onSaveAndContinue: (payload: CategoryDialogPayload) => void | Promise<void>,
 *   onContinueOnly: (payload: CategoryDialogPayload) => void,
 *   onSkip: () => void,
 *   onCancel: () => void,
 * }} actions
 */
export function showCategoryDialog(category, paramKeys, actions) {
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
  box.style.cssText = cssModalPanelLight(480);

  const title = document.createElement("h3");
  title.style.cssText = `margin:0 0 6px 0;font-size:15px;font-weight:600;letter-spacing:-0.015em;color:${CS_DIALOG.panelText};`;
  title.textContent = "New category detected";

  const intro = document.createElement("p");
  intro.style.cssText = `margin:0 0 8px 0;font-size:13px;color:${CS_DIALOG.panelMuted};line-height:1.45;`;
  intro.textContent =
    "Navigate the LCSC path like folders: click a segment to set how much of the path is used when you save (bold = end of path). Deeper rows in Settings override shallower ones.";

  const breadcrumbWrap = document.createElement("div");
  breadcrumbWrap.setAttribute("role", "navigation");
  breadcrumbWrap.setAttribute("aria-label", "Category path");
  breadcrumbWrap.style.cssText =
    "margin:0 0 16px 0;display:flex;flex-wrap:wrap;align-items:center;gap:2px 2px;max-width:100%;";

  let segments = normalizeCategoryPath(category).split("/").filter(Boolean);
  if (!segments.length) {
    segments = [(category || "").trim() || "—"];
  }

  let selectedEndIndex = Math.max(0, segments.length - 1);
  let selectedCategoryPath = segments.slice(0, selectedEndIndex + 1).join("/");

  function pathUpTo(i) {
    return segments.slice(0, i + 1).join("/");
  }

  function syncSelectedCategoryPath() {
    selectedCategoryPath = pathUpTo(selectedEndIndex);
  }

  function rebuildCategoryBreadcrumb() {
    breadcrumbWrap.innerHTML = "";
    segments.forEach((seg, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.textContent = "/";
        sep.setAttribute("aria-hidden", "true");
        sep.style.cssText = `color:${CS_DIALOG.panelMuted2};font-weight:600;padding:0 2px;user-select:none;flex-shrink:0;`;
        breadcrumbWrap.appendChild(sep);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = seg;
      btn.title = `Use path ending here: ${pathUpTo(i)}`;
      const isLeaf = i === selectedEndIndex;
      const before = i < selectedEndIndex;
      const after = i > selectedEndIndex;
      btn.style.cssText = categoryBreadcrumbBtnStyle({ isLeaf, before, after });
      btn.addEventListener("click", () => {
        selectedEndIndex = i;
        rebuildCategoryBreadcrumb();
      });
      breadcrumbWrap.appendChild(btn);
    });
    syncSelectedCategoryPath();
  }

  rebuildCategoryBreadcrumb();

  const checkRow = (labelText, id) => {
    const row = document.createElement("label");
    row.style.cssText = `display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;cursor:pointer;color:${CS_DIALOG.panelText};`;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.checked = false;
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
  valueLabel.style.cssText = `display:block;font-size:13px;margin-bottom:4px;font-weight:600;color:${CS_DIALOG.panelText};`;
  valueLabel.textContent = "Value parameter (optional)";
  const valueHint = document.createElement("p");
  valueHint.style.cssText = `margin:0 0 8px 0;font-size:12px;color:${CS_DIALOG.panelMuted2};line-height:1.35;`;
  valueHint.textContent =
    "LCSC attribute name used for the KiCad Value field (from product tables below).";

  /** Chevron so the control reads as a dropdown even if LCSC CSS alters native &lt;select&gt; chrome. */
  const categorySelectChevronBg = `url("data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#666666" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  )}")`;

  const selectDropdownStyle = [
    "display:block",
    "width:100%",
    "max-width:100%",
    "box-sizing:border-box",
    "min-height:40px",
    "padding:8px 40px 8px 12px",
    `border:1px solid ${CS_DIALOG.inputBorder}`,
    `border-radius:${CS_DIALOG.radius}`,
    "font-size:13px",
    "line-height:1.35",
    `font-family:${CS_DIALOG.fontUi}`,
    `background-color:${CS_DIALOG.panelBg}`,
    `color:${CS_DIALOG.panelText}`,
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
      valueSelect.style.borderColor = CS_DIALOG.primaryBg;
      valueSelect.style.boxShadow = `0 0 0 3px ${CS_DIALOG.inputFocusRing}`;
      valueSelect.style.outline = "none";
    });
    valueSelect.addEventListener("blur", () => {
      valueSelect.style.borderColor = CS_DIALOG.inputBorder;
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
      `border:1px solid ${CS_DIALOG.inputBorder}`,
      `border-radius:${CS_DIALOG.radius}`,
      "font-size:13px",
      `font-family:${CS_DIALOG.fontUi}`,
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
      `border:1px solid ${CS_DIALOG.inputBorder}`,
      `border-radius:${CS_DIALOG.radius}`,
      "font-size:13px",
      `font-family:${CS_DIALOG.fontUi}`,
    ].join(";");
    valueLabel.setAttribute("for", "easyeda2kicad-value-param");
    valueRow.appendChild(valueLabel);
    valueRow.appendChild(valueHint);
    valueRow.appendChild(valueInput);
  }

  function collectCategoryFormConfig() {
    const hidePinNumbers = document.getElementById("easyeda2kicad-hide-num")?.checked ?? false;
    const hidePinNames = document.getElementById("easyeda2kicad-hide-name")?.checked ?? false;
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
    return {
      category: selectedCategoryPath,
      hidePinNumbers,
      hidePinNames,
      valueParam,
    };
  }

  const btnRow = document.createElement("div");
  btnRow.style.cssText = [
    "display:flex",
    "flex-direction:row",
    "flex-wrap:wrap",
    "align-items:center",
    "gap:8px",
    "margin-top:16px",
    "padding-top:14px",
    `border-top:1px solid ${CS_DIALOG.panelBorder}`,
    "justify-content:flex-start",
  ].join(";");

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.textContent = "Skip";
  skipBtn.setAttribute(
    "title",
    "Do not save this dialog. Proceed with the import; saved category rows in Settings apply when their path matches.",
  );
  skipBtn.style.cssText = dialogButtonStyle("secondary", "dense");

  const saveContinueBtn = document.createElement("button");
  saveContinueBtn.type = "button";
  saveContinueBtn.textContent = "Save & continue";
  saveContinueBtn.setAttribute(
    "title",
    "Store under the path shown above in Settings → Categories (deepest matching row wins on import).",
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
    const payload = collectCategoryFormConfig();
    removeCategoryDialog();
    if (typeof onSaveAndContinue === "function") {
      await Promise.resolve(onSaveAndContinue(payload));
    }
  });

  continueOnlyBtn.addEventListener("click", () => {
    const payload = collectCategoryFormConfig();
    removeCategoryDialog();
    if (typeof onContinueOnly === "function") onContinueOnly(payload);
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
  box.appendChild(intro);
  box.appendChild(breadcrumbWrap);
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
