"use strict";

/** @param {string[]} parts */
export function cssJoin(parts) {
  return parts.join(";");
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Design tokens — single source of truth (Issue #43).                     */
/*                                                                          */
/*  Two parallel token maps (LIGHT / DARK) share the SAME shape so any      */
/*  consumer can swap palettes by re-reading `getDialogTokens()`. The       */
/*  legacy `CS_DIALOG` export still aliases the LIGHT map so the older      */
/*  category / value-param / overwrite dialogs (which import constants      */
/*  directly) keep working without a code change.                           */
/*                                                                          */
/*  Spacing scale (4/8/12/16/20/24) + type scale (11/12/13/15/18 px) +      */
/*  radii live alongside the colors so a single import covers the lot.     */
/* ──────────────────────────────────────────────────────────────────────── */

export const DIALOG_SPACING = {
  xs: "4px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "20px",
  xxl: "24px",
};

export const DIALOG_TYPE = {
  micro: "11px",
  small: "12px",
  base: "13px",
  heading: "15px",
  title: "18px",
};

export const DIALOG_RADIUS = {
  sm: "4px",
  md: "8px",
};

const FONT_UI =
  'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';

/**
 * Light-theme palette. The semantic names (`surface`, `surface2`, `border`,
 * `text`, `textMuted`, `primary`, `success`, `warning`, `danger`, `accent`)
 * are the canonical anchors — everything else (legacy `panelBg` etc.) is an
 * alias for back-compat with category / value-param dialogs.
 */
const LIGHT_TOKENS = {
  // Semantic surface + text
  surface: "#ffffff",
  surface2: "#f8fafc",
  surface3: "#f0f2f5",
  border: "#dedede",
  borderSoft: "#e2e8f0",
  borderStrong: "#cbd5e1",
  text: "#1c1f23",
  textStrong: "#0f172a",
  textMuted: "#475569",
  textFaint: "#64748b",
  placeholder: "#94a3b8",
  // Brand + states
  primary: "#1166dd",
  primaryFg: "#ffffff",
  primaryHover: "#0f5cc4",
  primarySoft: "rgba(17,102,221,0.12)",
  accent: "#1e3a8a",
  success: "#166534",
  successBorder: "#bbf7d0",
  successSurface: "#f0fdf4",
  successText: "#14532d",
  warning: "#92400e",
  warningBorder: "#fde68a",
  warningSurface: "#fefce8",
  warningText: "#713f12",
  warningHint: "#78350f",
  danger: "#c2410c",
  dangerBorder: "rgba(235,69,38,0.4)",
  dangerSurface: "rgba(235,69,38,0.08)",
  selectedSurface: "#dbeafe",
  // Modal chrome
  overlayDim: "rgba(0,0,0,0.4)",
  panelShadow: "0 1px 3px rgba(0,0,0,0.06), 0 12px 40px rgba(0,0,0,0.1)",
  inputFocusRing: "rgba(17,102,221,0.25)",
  selectChevron: "#64748b",
  selectHoverBg: "#f8fafc",
  selectHoverBorder: "#cbd5e1",
  // Common
  fontUi: FONT_UI,
  radius: DIALOG_RADIUS.md,
  radiusSm: DIALOG_RADIUS.sm,
};

/**
 * Dark-theme palette. Surface tones come from the slate family so the modal
 * sits on its own elevation instead of disappearing into a `prefers-color-
 * scheme: dark` page. Text colors target WCAG-AA on `surface` and
 * `surface2`. Brand `primary` is lightened so it still reads on dark.
 */
const DARK_TOKENS = {
  surface: "#1e293b",
  surface2: "#0f172a",
  surface3: "#334155",
  border: "#334155",
  borderSoft: "#1f2937",
  borderStrong: "#475569",
  text: "#f1f5f9",
  textStrong: "#f8fafc",
  textMuted: "#cbd5e1",
  textFaint: "#94a3b8",
  placeholder: "#64748b",
  primary: "#60a5fa",
  primaryFg: "#0b1220",
  primaryHover: "#3b82f6",
  primarySoft: "rgba(96,165,250,0.18)",
  accent: "#93c5fd",
  success: "#bbf7d0",
  successBorder: "#166534",
  successSurface: "rgba(22,101,52,0.32)",
  successText: "#dcfce7",
  warning: "#fcd34d",
  warningBorder: "#92400e",
  warningSurface: "rgba(146,64,14,0.32)",
  warningText: "#fef3c7",
  warningHint: "#fde68a",
  danger: "#fca5a5",
  dangerBorder: "rgba(235,69,38,0.6)",
  dangerSurface: "rgba(235,69,38,0.18)",
  selectedSurface: "rgba(96,165,250,0.22)",
  overlayDim: "rgba(0,0,0,0.6)",
  panelShadow:
    "0 1px 3px rgba(0,0,0,0.4), 0 12px 40px rgba(0,0,0,0.55)",
  inputFocusRing: "rgba(96,165,250,0.45)",
  selectChevron: "#cbd5e1",
  selectHoverBg: "#334155",
  selectHoverBorder: "#475569",
  fontUi: FONT_UI,
  radius: DIALOG_RADIUS.md,
  radiusSm: DIALOG_RADIUS.sm,
};

/* Back-compat alias — legacy property names keep working in light mode. */
const LIGHT_LEGACY = {
  panelBg: LIGHT_TOKENS.surface,
  panelText: LIGHT_TOKENS.text,
  panelMuted: "rgba(102,102,102,0.88)",
  panelMuted2: "rgba(102,102,102,0.82)",
  labelStrong: "#4a4d52",
  panelBorder: LIGHT_TOKENS.border,
  btnNeutralBorder: LIGHT_TOKENS.border,
  btnSecondaryBg: LIGHT_TOKENS.surface3,
  btnOutlineBg: LIGHT_TOKENS.surface,
  primaryBg: LIGHT_TOKENS.primary,
  primaryColor: LIGHT_TOKENS.primaryFg,
  outlineAccentBorder: LIGHT_TOKENS.primary,
  outlineAccentColor: LIGHT_TOKENS.primary,
  inputBorder: LIGHT_TOKENS.border,
  dangerBg: LIGHT_TOKENS.dangerSurface,
  dangerText: LIGHT_TOKENS.danger,
  slate900: LIGHT_TOKENS.text,
};

const DARK_LEGACY = {
  panelBg: DARK_TOKENS.surface,
  panelText: DARK_TOKENS.text,
  panelMuted: DARK_TOKENS.textMuted,
  panelMuted2: DARK_TOKENS.textFaint,
  labelStrong: DARK_TOKENS.textStrong,
  panelBorder: DARK_TOKENS.border,
  btnNeutralBorder: DARK_TOKENS.border,
  btnSecondaryBg: DARK_TOKENS.surface3,
  btnOutlineBg: DARK_TOKENS.surface,
  primaryBg: DARK_TOKENS.primary,
  primaryColor: DARK_TOKENS.primaryFg,
  outlineAccentBorder: DARK_TOKENS.primary,
  outlineAccentColor: DARK_TOKENS.primary,
  inputBorder: DARK_TOKENS.border,
  dangerBg: DARK_TOKENS.dangerSurface,
  dangerText: DARK_TOKENS.danger,
  slate900: DARK_TOKENS.text,
};

const LIGHT_FULL = { ...LIGHT_TOKENS, ...LIGHT_LEGACY };
const DARK_FULL = { ...DARK_TOKENS, ...DARK_LEGACY };

/** Single source for modal/backdrop/button colors (category, value-param, overwrite). Light-theme snapshot for back-compat. */
export const CS_DIALOG = LIGHT_FULL;

let _currentTheme = "light";

/**
 * Set the active dialog theme. Synchronous; callers that have already
 * resolved the user setting (e.g. `resolveAndApplyDialogTheme`) push it in.
 * Subsequent `getDialogTokens()` calls return the matching palette.
 *
 * @param {"light"|"dark"} theme
 */
export function setDialogTheme(theme) {
  _currentTheme = theme === "dark" ? "dark" : "light";
}

/** @returns {"light"|"dark"} */
export function getDialogTheme() {
  return _currentTheme;
}

/**
 * @param {"light"|"dark"} [theme] — defaults to the cached active theme.
 * @returns {typeof LIGHT_FULL}
 */
export function getDialogTokens(theme) {
  const t = theme === "dark" || theme === "light" ? theme : _currentTheme;
  return t === "dark" ? DARK_FULL : LIGHT_FULL;
}

/**
 * Resolve the user's preferred dialog theme. Order of precedence:
 *   1. ``chrome.storage.local`` ``popupUiState.theme`` — explicit popup setting.
 *   2. ``window.matchMedia("(prefers-color-scheme: dark)")`` — OS fallback.
 *   3. ``"light"`` — final default.
 *
 * Returns the resolved value AND updates the module cache via
 * ``setDialogTheme`` so subsequent ``getDialogTokens()`` reads see it.
 *
 * @returns {Promise<"light"|"dark">}
 */
export async function resolveDialogTheme() {
  let theme = "light";
  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
      const st = await chrome.storage.local.get("popupUiState");
      const v = st?.popupUiState?.theme;
      if (v === "dark" || v === "light") {
        theme = v;
        setDialogTheme(theme);
        return theme;
      }
    }
  } catch (_e) {
    /* fall through to media-query fallback */
  }
  try {
    if (
      typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      theme = "dark";
    }
  } catch (_e) {
    /* keep light */
  }
  setDialogTheme(theme);
  return theme;
}

/**
 * Wire the dialog theme cache to live ``chrome.storage`` updates so a popup
 * theme change is reflected the next time a modal opens (no reload needed).
 * Idempotent — calling more than once does not register duplicate listeners.
 */
let _storageListenerInstalled = false;
export function installDialogThemeStorageListener() {
  if (_storageListenerInstalled) return;
  try {
    if (
      typeof chrome !== "undefined"
      && chrome?.storage?.onChanged?.addListener
    ) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        const next = changes?.popupUiState?.newValue?.theme;
        if (next === "light" || next === "dark") {
          setDialogTheme(next);
        }
      });
      _storageListenerInstalled = true;
    }
  } catch (_e) {
    /* swallow — listener is best-effort */
  }
}

/** True when the user has ``prefers-reduced-motion: reduce`` active. */
export function prefersReducedMotion() {
  try {
    return (
      typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch (_e) {
    return false;
  }
}

/**
 * Native {@code <select>} chrome aligned with category / value-parameter dialogs ({@link CS_DIALOG}).
 * Reads the active theme on each invocation so a dark-theme select picks the dark palette.
 * @param {HTMLSelectElement} sel
 * @param {{ theme?: "light"|"dark" }} [opts]
 */
export function applyDialogStyleSelect(sel, opts = {}) {
  const T = getDialogTokens(opts.theme);
  const chevron = `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${T.selectChevron}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`,
  )}")`;
  const idle = cssJoin([
    "display:block",
    "width:100%",
    "max-width:100%",
    "box-sizing:border-box",
    "min-height:40px",
    "padding:8px 40px 8px 12px",
    `border:1px solid ${T.border}`,
    `border-radius:${T.radius}`,
    `font-size:${DIALOG_TYPE.base}`,
    "line-height:1.35",
    `font-family:${T.fontUi}`,
    `background-color:${T.surface}`,
    `color:${T.text}`,
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
    `border-color:${T.selectHoverBorder}`,
    `background-color:${T.selectHoverBg}`,
    "box-shadow:0 1px 3px rgba(15,23,42,0.07)",
  ]);
  const focusStyle = cssJoin([
    idle,
    `border-color:${T.primary}`,
    `box-shadow:0 0 0 3px ${T.inputFocusRing}, 0 1px 2px rgba(0,0,0,0.05)`,
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

/**
 * @param {number} maxWidthPx
 * @param {{ theme?: "light"|"dark" }} [opts]
 */
export function cssModalPanelLight(maxWidthPx, opts = {}) {
  const T = getDialogTokens(opts.theme);
  return cssJoin([
    `background:${T.surface}`,
    `border:1px solid ${T.border}`,
    `border-radius:${T.radius}`,
    "padding:18px 20px",
    `max-width:${Number(maxWidthPx)}px`,
    "width:min(90vw,100%)",
    `box-shadow:${T.panelShadow}`,
    `color:${T.text}`,
    `font-family:${T.fontUi}`,
    "box-sizing:border-box",
  ]);
}

/**
 * @param {"secondary"|"outline"|"primary"} variant
 * @param {"wide"|"dense"} density
 * @param {{ theme?: "light"|"dark" }} [opts]
 */
export function dialogButtonStyle(variant, density, opts = {}) {
  const T = getDialogTokens(opts.theme);
  const padH = density === "dense" ? "12px" : "16px";
  const fs = density === "dense" ? DIALOG_TYPE.small : DIALOG_TYPE.base;
  const base = [
    `padding:7px ${padH}`,
    `border-radius:${T.radiusSm}`,
    "cursor:pointer",
    `font-size:${fs}`,
    "white-space:nowrap",
    "flex-shrink:0",
    "box-sizing:border-box",
    `font-family:${T.fontUi}`,
    "transition:background 0.12s ease, border-color 0.12s ease, color 0.12s ease, box-shadow 0.12s ease",
  ];
  if (variant === "secondary") {
    return cssJoin([
      ...base,
      `border:1px solid ${T.border}`,
      `background:${T.surface3}`,
      `color:${T.text}`,
    ]);
  }
  if (variant === "outline") {
    return cssJoin([
      ...base,
      `border:1px solid ${T.primary}`,
      `background:${T.surface}`,
      `color:${T.primary}`,
      "font-weight:500",
    ]);
  }
  return cssJoin([
    ...base,
    "border:none",
    `background:${T.primary}`,
    `color:${T.primaryFg}`,
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

/** Theme-aware overlay CSS. Reads the active token map so dark mode dims darker. */
export function cssModalOverlay(opts = {}) {
  const T = getDialogTokens(opts.theme);
  return cssJoin([
    "position:fixed", "top:0", "left:0", "width:100%", "height:100%",
    `background:${T.overlayDim}`, "z-index:2147483647",
    "display:flex", "align-items:center", "justify-content:center",
    `font-family:${T.fontUi}`,
    "padding:16px",
    "box-sizing:border-box",
  ]);
}

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
  // Localized (DE) — modern LCSC ships these on German-locale visitors.
  "Herst.-Teilenr.",
  "Hersteller-Teilenr.",
  "Hersteller Teilenummer",
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
  // Restore focus to the element that was active before the modal opened.
  const restore = existing._k2cFocusRestore;
  if (restore && typeof restore.focus === "function") {
    try { restore.focus(); } catch (_e) { /* swallow */ }
  }
  // Drop a focus trap if one was attached.
  const trap = existing._k2cFocusTrap;
  if (typeof trap === "function") {
    document.removeEventListener("keydown", trap, true);
  }
  existing.remove();
  unlockOverlayPageScroll();
}

/** Selector for elements that focus-trap considers tabbable. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableWithin(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el.getClientRects().length > 0,
  );
}

/**
 * Build the standard modal header row (title + close ✕). The caller passes
 * the dismiss callback; the ✕ button wires it on click. Returns null when
 * neither a title nor a close button is requested.
 *
 * @param {Document} doc
 * @param {{
 *   title?: string,
 *   closeable?: boolean,
 *   onClose?: () => void,
 *   theme?: "light"|"dark",
 * }} [opts]
 */
export function buildModalHeader(doc, opts = {}) {
  const { title = "", closeable = true, onClose, theme } = opts;
  if (!title && !closeable) return null;
  const T = getDialogTokens(theme);
  const row = doc.createElement("div");
  row.setAttribute("data-k2c-modal-header", "true");
  row.style.cssText = cssJoin([
    "display:flex",
    "align-items:center",
    "justify-content:space-between",
    `gap:${DIALOG_SPACING.md}`,
    `margin:0 0 ${DIALOG_SPACING.md} 0`,
  ]);
  const titleEl = doc.createElement("div");
  titleEl.id = "k2c-modal-title";
  titleEl.setAttribute("data-k2c-modal-title", "true");
  titleEl.textContent = title;
  titleEl.style.cssText = cssJoin([
    `font-size:${DIALOG_TYPE.heading}`,
    "font-weight:600",
    "letter-spacing:-0.015em",
    `color:${T.text}`,
    "line-height:1.3",
  ]);
  row.appendChild(titleEl);
  if (closeable) {
    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("data-k2c-modal-close", "true");
    closeBtn.setAttribute("aria-label", "Schließen");
    closeBtn.textContent = "✕"; // ✕
    closeBtn.style.cssText = cssJoin([
      "appearance:none",
      "background:transparent",
      "border:none",
      `color:${T.textMuted}`,
      "font-size:18px",
      "line-height:1",
      "cursor:pointer",
      `padding:${DIALOG_SPACING.xs} ${DIALOG_SPACING.sm}`,
      `border-radius:${T.radiusSm}`,
      "transition:background 0.12s ease, color 0.12s ease",
    ]);
    closeBtn.addEventListener("mouseenter", () => {
      closeBtn.style.background = T.surface3;
      closeBtn.style.color = T.text;
    });
    closeBtn.addEventListener("mouseleave", () => {
      closeBtn.style.background = "transparent";
      closeBtn.style.color = T.textMuted;
    });
    closeBtn.addEventListener("click", () => {
      if (typeof onClose === "function") onClose();
    });
    row.appendChild(closeBtn);
  }
  return row;
}

/**
 * Shared LCSC overlay shell: fixed dim backdrop, centered panel, scroll lock, optional Escape / backdrop close.
 *
 * Theme-aware (Issue #43): the active dialog theme (light / dark) drives
 * overlay + panel surface colors; pass an explicit ``theme`` to override.
 * The shell also installs a focus trap + initial-focus + focus-restore
 * lifecycle so keyboard users stay inside the modal, plus a reduced-motion
 * aware fade/scale transition.
 *
 * @param {{
 *   id: string,
 *   maxWidthPx?: number,
 *   header?: HTMLElement | null,
 *   title?: string,
 *   closeable?: boolean,
 *   children?: HTMLElement[],
 *   footer?: HTMLElement | null,
 *   closeOnBackdrop?: boolean,
 *   closeOnEscape?: boolean,
 *   onDismiss?: () => void,
 *   theme?: "light"|"dark",
 *   ariaLabel?: string,
 *   initialFocus?: HTMLElement | null,
 * }} opts
 * @returns {{ overlay: HTMLElement, panel: HTMLElement, dismiss: () => void }}
 */
export function mountCsModal(opts) {
  const {
    id,
    maxWidthPx = 520,
    header = null,
    title = "",
    closeable = true,
    children = [],
    footer = null,
    closeOnBackdrop = true,
    closeOnEscape = true,
    onDismiss = () => {},
    theme,
    ariaLabel,
    initialFocus = null,
  } = opts;

  dismissCsModalById(id);
  lockOverlayPageScroll();

  const activeBefore =
    typeof document !== "undefined"
      && document.activeElement
      && document.activeElement !== document.body
      ? document.activeElement
      : null;

  const overlay = document.createElement("div");
  overlay.id = id;
  overlay.style.cssText = cssModalOverlay({ theme });

  const panel = document.createElement("div");
  panel.style.cssText = cssModalPanelLight(maxWidthPx, { theme });
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  if (ariaLabel) {
    panel.setAttribute("aria-label", ariaLabel);
  }

  let dismissCalled = false;
  const dismiss = () => {
    if (dismissCalled) return;
    if (!document.getElementById(id)) return;
    dismissCalled = true;
    dismissCsModalById(id);
    onDismiss();
  };

  // Build the explicit header row when the caller asked for one (title /
  // closeable) AND did not pass a pre-built header. The pre-built header
  // path is the back-compat escape hatch.
  let headerEl = header;
  if (!headerEl && (title || closeable)) {
    headerEl = buildModalHeader(document, {
      title,
      closeable,
      onClose: dismiss,
      theme,
    });
    if (headerEl) {
      const titleEl = headerEl.querySelector("[data-k2c-modal-title]");
      if (titleEl && title) {
        panel.setAttribute("aria-labelledby", titleEl.id);
      }
    }
  }
  if (headerEl) panel.appendChild(headerEl);
  for (const el of children) {
    panel.appendChild(el);
  }
  if (footer) panel.appendChild(footer);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Reduced-motion aware fade/scale in. Skipped entirely when the user has
  // ``prefers-reduced-motion: reduce`` so we don't introduce any motion at
  // all (rather than only shortening it).
  if (!prefersReducedMotion()) {
    overlay.style.opacity = "0";
    panel.style.transformOrigin = "center";
    panel.style.transform = "scale(0.98)";
    panel.style.transition = "transform 140ms ease-out";
    overlay.style.transition = "opacity 140ms ease-out";
    // Force a layout flush so the transition kicks in.
    /* eslint-disable no-unused-expressions */
    overlay.offsetWidth;
    /* eslint-enable no-unused-expressions */
    overlay.style.opacity = "1";
    panel.style.transform = "scale(1)";
  }

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

  // Focus trap: Tab + Shift+Tab cycle inside the panel. Stops keyboard
  // users from tabbing into the dimmed LCSC page underneath.
  const trapHandler = (e) => {
    if (e.key !== "Tab") return;
    if (!document.getElementById(id)) return;
    const tabbables = focusableWithin(panel);
    if (tabbables.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = tabbables[0];
    const last = tabbables[tabbables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  overlay._k2cFocusTrap = trapHandler;
  document.addEventListener("keydown", trapHandler, true);

  // Initial focus: caller's choice OR the first primary-looking button OR
  // the first tabbable OR the panel itself (which we make focusable
  // programmatically). The microtask delay lets the panel finish mounting.
  Promise.resolve().then(() => {
    if (!document.getElementById(id)) return;
    if (initialFocus && typeof initialFocus.focus === "function") {
      try { initialFocus.focus(); return; } catch (_e) { /* fall through */ }
    }
    const tabbables = focusableWithin(panel);
    if (tabbables.length) {
      try { tabbables[0].focus(); return; } catch (_e) { /* fall through */ }
    }
    panel.tabIndex = -1;
    try { panel.focus(); } catch (_e) { /* swallow */ }
  });

  // Stash the focus-restore target so dismissCsModalById can find it.
  overlay._k2cFocusRestore = activeBefore;

  return { overlay, panel, dismiss };
}
