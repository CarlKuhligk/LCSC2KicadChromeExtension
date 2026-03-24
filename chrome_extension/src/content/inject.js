"use strict";

/**
 * LCSC content script bootstrap: load the real entry as a module via `import()`.
 * Some Chromium builds ignore `content_scripts[].type: "module"`, which yields
 * "Cannot use import statement outside a module" on `main.js`.
 */
try {
  if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function") {
    const url = chrome.runtime.getURL("src/content/main.js");
    import(url).catch((err) => {
      console.error("[KiCad Importer] content module load failed:", err);
    });
  }
} catch (e) {
  console.error("[KiCad Importer] content bootstrap error:", e);
}
