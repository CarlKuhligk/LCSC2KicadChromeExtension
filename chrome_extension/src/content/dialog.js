"use strict";

/** @param {string[]} parts */
export function cssJoin(parts) {
  return parts.join(";");
}

/** Single source for modal/backdrop/button colors (category, value-param, overwrite). */
export const CS_DIALOG = {
  overlayDim: "rgba(0,0,0,0.4)",
  fontUi: 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
  panelBg: "#ffffff",
  panelText: "#1c1f23",
  panelMuted: "rgba(102,102,102,0.88)",
  panelMuted2: "rgba(102,102,102,0.82)",
  labelStrong: "#4a4d52",
  panelBorder: "#dedede",
  panelShadow: "0 1px 3px rgba(0,0,0,0.06), 0 12px 40px rgba(0,0,0,0.1)",
  btnNeutralBorder: "#dedede",
  btnSecondaryBg: "#f0f2f5",
  btnOutlineBg: "#ffffff",
  primaryBg: "#1166dd",
  primaryColor: "#ffffff",
  outlineAccentBorder: "#1166dd",
  outlineAccentColor: "#1166dd",
  radius: "8px",
  radiusSm: "4px",
  inputBorder: "#dedede",
  inputFocusRing: "rgba(17,102,221,0.2)",
  dangerBg: "rgba(235,69,38,0.08)",
  dangerBorder: "rgba(235,69,38,0.4)",
  dangerText: "#c2410c",
  slate900: "#1c1f23",
};

/**
 * Native {@code <select>} chrome aligned with category / value-parameter dialogs ({@link CS_DIALOG}).
 * @param {HTMLSelectElement} sel
 */
export function applyDialogStyleSelect(sel) {
  const chevron = `url("data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  )}")`;
  const idle = cssJoin([
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
    `background-image:${chevron}`,
    "box-shadow:0 1px 2px rgba(0,0,0,0.05)",
    "outline:none",
    "transition:border-color 0.12s ease, box-shadow 0.12s ease, background-color 0.12s ease",
  ]);
  const hover = cssJoin([
    idle,
    "border-color:#cbd5e1",
    "background-color:#f8fafc",
    "box-shadow:0 1px 3px rgba(15,23,42,0.07)",
  ]);
  const focusStyle = cssJoin([
    idle,
    `border-color:${CS_DIALOG.primaryBg}`,
    `box-shadow:0 0 0 3px ${CS_DIALOG.inputFocusRing}, 0 1px 2px rgba(0,0,0,0.05)`,
  ]);
  sel.style.cssText = idle;
  sel.addEventListener("focus", () => {
    sel.style.cssText = focusStyle;
  });
  sel.addEventListener("blur", () => {
    sel.style.cssText = idle;
  });
  sel.addEventListener("mouseenter", () => {
    if (document.activeElement !== sel) {
      sel.style.cssText = hover;
    }
  });
  sel.addEventListener("mouseleave", () => {
    if (document.activeElement !== sel) {
      sel.style.cssText = idle;
    }
  });
}

export function cssModalPanelLight(maxWidthPx) {
  return cssJoin([
    `background:${CS_DIALOG.panelBg}`,
    `border:1px solid ${CS_DIALOG.panelBorder}`,
    `border-radius:${CS_DIALOG.radius}`,
    "padding:18px 20px",
    `max-width:${Number(maxWidthPx)}px`,
    "width:min(90vw,100%)",
    `box-shadow:${CS_DIALOG.panelShadow}`,
    `color:${CS_DIALOG.panelText}`,
    `font-family:${CS_DIALOG.fontUi}`,
    "box-sizing:border-box",
  ]);
}

/**
 * @param {"secondary"|"outline"|"primary"} variant
 * @param {"wide"|"dense"} density
 */
export function dialogButtonStyle(variant, density) {
  const padH = density === "dense" ? "12px" : "16px";
  const fs = density === "dense" ? "12px" : "13px";
  const base = [
    `padding:7px ${padH}`,
    `border-radius:${CS_DIALOG.radiusSm}`,
    "cursor:pointer",
    `font-size:${fs}`,
    "white-space:nowrap",
    "flex-shrink:0",
    "box-sizing:border-box",
    `font-family:${CS_DIALOG.fontUi}`,
  ];
  if (variant === "secondary") {
    return cssJoin([
      ...base,
      `border:1px solid ${CS_DIALOG.btnNeutralBorder}`,
      `background:${CS_DIALOG.btnSecondaryBg}`,
      `color:${CS_DIALOG.panelText}`,
    ]);
  }
  if (variant === "outline") {
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
    "border:none",
    `background:${CS_DIALOG.primaryBg}`,
    `color:${CS_DIALOG.primaryColor}`,
    "font-weight:600",
  ]);
}

/** Breadcrumb segment buttons in the category dialog (file-manager style path). */
export function categoryBreadcrumbBtnStyle({ isLeaf, before, after }) {
  const base = [
    "margin:0",
    "padding:4px 8px",
    `border-radius:${CS_DIALOG.radiusSm}`,
    "font-size:12px",
    `font-family:${CS_DIALOG.fontUi}`,
    "cursor:pointer",
    "max-width:100%",
    "text-align:left",
    "line-height:1.35",
    "word-break:break-word",
    "box-sizing:border-box",
    "transition:background 0.15s ease,border-color 0.15s ease,color 0.15s ease",
  ];
  if (isLeaf) {
    return cssJoin([
      ...base,
      `border:2px solid ${CS_DIALOG.primaryBg}`,
      `background:${CS_DIALOG.primaryBg}`,
      `color:${CS_DIALOG.primaryColor}`,
      "font-weight:700",
    ]);
  }
  if (before) {
    return cssJoin([
      ...base,
      `border:1px solid ${CS_DIALOG.outlineAccentBorder}`,
      `background:${CS_DIALOG.inputFocusRing}`,
      `color:${CS_DIALOG.outlineAccentColor}`,
      "font-weight:600",
    ]);
  }
  return cssJoin([
    ...base,
    `border:1px dashed ${CS_DIALOG.inputBorder}`,
    `background:${CS_DIALOG.btnSecondaryBg}`,
    `color:${CS_DIALOG.panelMuted}`,
    "font-weight:500",
  ]);
}

export const CSS_MODAL_OVERLAY_STANDARD = cssJoin([
  "position:fixed", "top:0", "left:0", "width:100%", "height:100%",
  `background:${CS_DIALOG.overlayDim}`, "z-index:2147483647",
  "display:flex", "align-items:center", "justify-content:center",
  `font-family:${CS_DIALOG.fontUi}`,
  "padding:16px",
  "box-sizing:border-box",
]);

let overlayScrollLockDepth = 0;
let overlayScrollLockSaved = null;

export function lockOverlayPageScroll() {
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

export function unlockOverlayPageScroll() {
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
export const PREFERRED_VALUE_PARAM_KEYS = [
  "Manufacturer Part Number",
  "Mfr. Part #",
  "Part Number",
  "Part #",
  "MPN",
  "Model",
  "Product Name",
  "Name",
];

/**
 * Remove a mounted CS modal by id (Escape handler + scroll lock).
 * @param {string} id
 */
export function dismissCsModalById(id) {
  const existing = document.getElementById(id);
  if (!existing) return;
  for (const key of ["_k2cEscHandler", "_easyeda2kicadEscHandler"]) {
    const esc = existing[key];
    if (typeof esc === "function") {
      document.removeEventListener("keydown", esc, true);
    }
  }
  existing.remove();
  unlockOverlayPageScroll();
}

/**
 * Shared LCSC overlay shell: fixed dim backdrop, centered panel, scroll lock, optional Escape / backdrop close.
 * @param {{
 *   id: string,
 *   maxWidthPx?: number,
 *   header?: HTMLElement | null,
 *   children?: HTMLElement[],
 *   footer?: HTMLElement | null,
 *   closeOnBackdrop?: boolean,
 *   closeOnEscape?: boolean,
 *   onDismiss?: () => void,
 * }} opts
 * @returns {{ overlay: HTMLElement, panel: HTMLElement, dismiss: () => void }}
 */
export function mountCsModal(opts) {
  const {
    id,
    maxWidthPx = 520,
    header = null,
    children = [],
    footer = null,
    closeOnBackdrop = true,
    closeOnEscape = true,
    onDismiss = () => {},
  } = opts;

  dismissCsModalById(id);
  lockOverlayPageScroll();

  const overlay = document.createElement("div");
  overlay.id = id;
  overlay.style.cssText = CSS_MODAL_OVERLAY_STANDARD;

  const panel = document.createElement("div");
  panel.style.cssText = cssModalPanelLight(maxWidthPx);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const dismiss = () => {
    if (!document.getElementById(id)) {
      return;
    }
    dismissCsModalById(id);
    onDismiss();
  };

  if (header) panel.appendChild(header);
  for (const el of children) {
    panel.appendChild(el);
  }
  if (footer) panel.appendChild(footer);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  if (closeOnEscape) {
    const escHandler = (e) => {
      if (e.key !== "Escape") return;
      if (!document.getElementById(id)) return;
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    };
    overlay._k2cEscHandler = escHandler;
    document.addEventListener("keydown", escHandler, true);
  }

  if (closeOnBackdrop) {
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) dismiss();
    });
  }

  return { overlay, panel, dismiss };
}
