"use strict";

export const BUTTON_ID = "easyeda2kicad-download-btn";
/** Modifier on the EasyEDA button; template uses TEMPLATE_DL_BTN_CLASS — layout is the same (see shadow CSS). */
export const EASYEDA_DL_BTN_CLASS = "easyeda2kicad-dl-btn--easyeda";
export const TEMPLATE_DL_BTN_CLASS = "easyeda2kicad-dl-btn--template";
/** Second-line label under "Download". */
export const DL_SUB_EASYEDA = "EasyEDA";
/** Sub-label under “Download” (reads as “Download Template” with the main line). */
export const DL_SUB_TEMPLATE = "From template";
export const BTN_GROUP_ID = "easyeda2kicad-btn-group";
/** Inner flex container inside the product button group's ShadowRoot (buttons mount here). */
export const BTN_GROUP_MOUNT_CLASS = "easyeda2kicad-btn-mount";
export const BUTTON_WRAPPER_ID = "easyeda2kicad-download-wrapper";
export const CATEGORY_DIALOG_ID = "easyeda2kicad-category-dialog";
export const VALUE_PARAM_FALLBACK_DIALOG_ID = "easyeda2kicad-value-param-fallback-dialog";
export const VALUE_PARAM_MISMATCH_DIALOG_ID = "easyeda2kicad-value-param-mismatch-dialog";
export const INIT_ATTR = "easyeda2kicadInitialized";
export const PRODUCT_PROGRESS_ROW_ID = "easyeda2kicad-progress-row";

export const SVG_NS = "http://www.w3.org/2000/svg";
/**
 * LCSC uses both short URLs (`/product-detail/C12345.html`) and long slugs ending in `_C12345.html`.
 * Use a greedy prefix so we capture the last `C`+digits segment before `.html` / query / end.
 */
export const PRODUCT_REGEX = /\/product-detail\/.*(C\d+)(?:\.html)?(?:[?#]|$)/i;

export const EXT_RELOAD_BANNER_ID = "easyeda2kicad-ext-reload-banner";
