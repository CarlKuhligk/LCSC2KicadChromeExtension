import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CS_DIALOG,
  getDialogTheme,
  setDialogTheme,
  getDialogTokens,
  resolveDialogTheme,
  installDialogThemeStorageListener,
  buildModalHeader,
  mountCsModal,
  cssModalPanelLight,
  dialogButtonStyle,
  applyDialogStyleSelect,
  DIALOG_SPACING,
  DIALOG_TYPE,
  DIALOG_RADIUS,
} from "./dialog.js";

/**
 * Issue #43 — Design tokens (light + dark maps), theme resolver, modal
 * shell upgrades (focus trap, focus restore, header ✕, reduced-motion).
 * The legacy ``CS_DIALOG`` export keeps shipping the light-theme values so
 * the older category / value-param dialogs that import constants directly
 * continue to render unchanged.
 */

/**
 * JSDOM normalizes CSS color strings (``#1e293b`` becomes ``rgb(30, 41, 59)``,
 * ``rgba(146,64,14,0.32)`` keeps the alpha but mangles the comma spacing).
 * To keep the assertions robust we round-trip each expected color through
 * a throwaway element so we compare apples to apples — the helper returns
 * exactly the form JSDOM will store after parsing.
 */
function jsdomColor(value) {
  const probe = document.createElement("div");
  probe.style.background = value;
  return probe.style.background;
}

beforeEach(() => {
  document.body.innerHTML = "";
  setDialogTheme("light");
});

afterEach(() => {
  setDialogTheme("light");
});

describe("design tokens", () => {
  it("exposes a spacing scale, a type scale, and radii", () => {
    expect(DIALOG_SPACING.xs).toBe("4px");
    expect(DIALOG_SPACING.sm).toBe("8px");
    expect(DIALOG_SPACING.md).toBe("12px");
    expect(DIALOG_SPACING.lg).toBe("16px");
    expect(DIALOG_TYPE.micro).toBe("11px");
    expect(DIALOG_TYPE.small).toBe("12px");
    expect(DIALOG_TYPE.base).toBe("13px");
    expect(DIALOG_RADIUS.sm).toBe("4px");
    expect(DIALOG_RADIUS.md).toBe("8px");
  });

  it("exposes semantic color tokens on both light and dark maps", () => {
    const light = getDialogTokens("light");
    const dark = getDialogTokens("dark");
    for (const t of [light, dark]) {
      for (const key of [
        "surface", "surface2", "border", "text", "textMuted",
        "primary", "primaryFg", "success", "warning", "danger", "accent",
        "overlayDim", "panelShadow", "fontUi", "radius", "radiusSm",
      ]) {
        expect(t[key], `${key} missing`).toBeTruthy();
      }
    }
  });

  it("light and dark tokens have distinct surface + text colors", () => {
    const light = getDialogTokens("light");
    const dark = getDialogTokens("dark");
    expect(light.surface).not.toBe(dark.surface);
    expect(light.text).not.toBe(dark.text);
  });

  it("CS_DIALOG aliases the light token map for back-compat", () => {
    const light = getDialogTokens("light");
    expect(CS_DIALOG.panelBg).toBe(light.surface);
    expect(CS_DIALOG.panelText).toBe(light.text);
    expect(CS_DIALOG.primaryBg).toBe(light.primary);
  });
});

describe("setDialogTheme / getDialogTheme / getDialogTokens", () => {
  it("defaults to light", () => {
    expect(getDialogTheme()).toBe("light");
  });

  it("setDialogTheme('dark') switches the cached theme", () => {
    setDialogTheme("dark");
    expect(getDialogTheme()).toBe("dark");
    expect(getDialogTokens().surface).toBe(getDialogTokens("dark").surface);
  });

  it("setDialogTheme falls back to light on garbage input", () => {
    setDialogTheme("dark");
    setDialogTheme("neon"); // not a real theme
    expect(getDialogTheme()).toBe("light");
  });

  it("getDialogTokens(theme) overrides the cache without mutating it", () => {
    setDialogTheme("light");
    const dark = getDialogTokens("dark");
    expect(dark.surface).not.toBe(CS_DIALOG.panelBg);
    // cache still reads light
    expect(getDialogTheme()).toBe("light");
  });
});

describe("resolveDialogTheme", () => {
  let chromeBackup;
  let matchMediaBackup;

  beforeEach(() => {
    chromeBackup = globalThis.chrome;
    matchMediaBackup = window.matchMedia;
  });

  afterEach(() => {
    globalThis.chrome = chromeBackup;
    window.matchMedia = matchMediaBackup;
    setDialogTheme("light");
  });

  it("resolves to 'dark' when popupUiState.theme === 'dark'", async () => {
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({ popupUiState: { theme: "dark" } })),
        },
      },
    };
    const theme = await resolveDialogTheme();
    expect(theme).toBe("dark");
    expect(getDialogTheme()).toBe("dark");
  });

  it("resolves to 'light' when popupUiState.theme === 'light'", async () => {
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({ popupUiState: { theme: "light" } })),
        },
      },
    };
    setDialogTheme("dark");
    const theme = await resolveDialogTheme();
    expect(theme).toBe("light");
    expect(getDialogTheme()).toBe("light");
  });

  it("falls back to prefers-color-scheme: dark when no popup setting", async () => {
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
        },
      },
    };
    window.matchMedia = vi.fn(() => ({ matches: true }));
    const theme = await resolveDialogTheme();
    expect(theme).toBe("dark");
  });

  it("falls back to 'light' when neither popup setting nor OS dark", async () => {
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
        },
      },
    };
    window.matchMedia = vi.fn(() => ({ matches: false }));
    const theme = await resolveDialogTheme();
    expect(theme).toBe("light");
  });

  it("swallows chrome.storage errors and falls through to media query", async () => {
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async () => {
            throw new Error("disconnected");
          }),
        },
      },
    };
    window.matchMedia = vi.fn(() => ({ matches: true }));
    const theme = await resolveDialogTheme();
    expect(theme).toBe("dark");
  });
});

describe("installDialogThemeStorageListener", () => {
  it("subscribes to chrome.storage.onChanged and updates the cache on popup theme change", () => {
    const listeners = [];
    globalThis.chrome = {
      storage: {
        onChanged: {
          addListener: (fn) => listeners.push(fn),
        },
      },
    };
    setDialogTheme("light");
    installDialogThemeStorageListener();
    expect(listeners.length).toBe(1);
    listeners[0]({ popupUiState: { newValue: { theme: "dark" } } }, "local");
    expect(getDialogTheme()).toBe("dark");
  });

  it("is idempotent — calling twice does not double-register", () => {
    const listeners = [];
    globalThis.chrome = {
      storage: {
        onChanged: {
          addListener: (fn) => listeners.push(fn),
        },
      },
    };
    installDialogThemeStorageListener();
    installDialogThemeStorageListener();
    // Either both calls noop after the first install, or only the first runs.
    expect(listeners.length).toBeLessThanOrEqual(1);
  });
});

describe("token-driven style helpers", () => {
  it("cssModalPanelLight uses dark surface + dark shadow when theme=dark", () => {
    const dark = getDialogTokens("dark");
    const css = cssModalPanelLight(520, { theme: "dark" });
    expect(css).toContain(`background:${dark.surface}`);
    expect(css).toContain(`color:${dark.text}`);
  });

  it("dialogButtonStyle primary uses theme.primary background", () => {
    const dark = getDialogTokens("dark");
    const css = dialogButtonStyle("primary", "dense", { theme: "dark" });
    expect(css).toContain(`background:${dark.primary}`);
    expect(css).toContain(`color:${dark.primaryFg}`);
  });

  it("dialogButtonStyle outline uses theme.primary border + color", () => {
    const dark = getDialogTokens("dark");
    const css = dialogButtonStyle("outline", "wide", { theme: "dark" });
    expect(css).toContain(`border:1px solid ${dark.primary}`);
    expect(css).toContain(`color:${dark.primary}`);
  });

  it("applyDialogStyleSelect paints a <select> with theme surface + text", () => {
    const dark = getDialogTokens("dark");
    const sel = document.createElement("select");
    applyDialogStyleSelect(sel, { theme: "dark" });
    expect(sel.style.backgroundColor).toBe(jsdomColor(dark.surface));
    expect(sel.style.color).toBe(jsdomColor(dark.text));
  });
});

describe("buildModalHeader", () => {
  it("renders a title row with a ✕ close button by default", () => {
    const header = buildModalHeader(document, {
      title: "Hello",
      onClose: () => {},
    });
    expect(header).toBeTruthy();
    expect(header.getAttribute("data-k2c-modal-header")).toBe("true");
    expect(header.querySelector("[data-k2c-modal-title]").textContent).toBe(
      "Hello",
    );
    expect(header.querySelector("[data-k2c-modal-close]")).toBeTruthy();
  });

  it("close button fires the onClose callback", () => {
    const calls = [];
    const header = buildModalHeader(document, {
      title: "T",
      onClose: () => calls.push(true),
    });
    header.querySelector("[data-k2c-modal-close]").click();
    expect(calls).toEqual([true]);
  });

  it("returns null when neither title nor closeable is set", () => {
    const header = buildModalHeader(document, { title: "", closeable: false });
    expect(header).toBeNull();
  });
});

describe("mountCsModal — Issue #43 polish", () => {
  it("renders a header with the supplied title and a ✕ close button", () => {
    const { panel, dismiss } = mountCsModal({
      id: "k2c-test-modal-1",
      title: "Import-Editor",
    });
    const header = panel.querySelector("[data-k2c-modal-header]");
    expect(header).toBeTruthy();
    expect(header.querySelector("[data-k2c-modal-title]").textContent).toBe(
      "Import-Editor",
    );
    expect(header.querySelector("[data-k2c-modal-close]")).toBeTruthy();
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-labelledby")).toBe("k2c-modal-title");
    dismiss();
  });

  it("close ✕ button dismisses the modal and fires onDismiss", () => {
    const calls = [];
    mountCsModal({
      id: "k2c-test-modal-2",
      title: "X",
      onDismiss: () => calls.push("dismissed"),
    });
    const overlay = document.getElementById("k2c-test-modal-2");
    overlay.querySelector("[data-k2c-modal-close]").click();
    expect(document.getElementById("k2c-test-modal-2")).toBeNull();
    expect(calls).toEqual(["dismissed"]);
  });

  it("restores focus to the previously active element on dismiss", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "open";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    const { dismiss } = mountCsModal({
      id: "k2c-test-modal-3",
      title: "Focus",
    });
    dismiss();
    expect(document.activeElement).toBe(trigger);
  });

  it("dark theme: panel uses the dark surface color", () => {
    const dark = getDialogTokens("dark");
    const { panel, dismiss } = mountCsModal({
      id: "k2c-test-modal-4",
      title: "Dark",
      theme: "dark",
    });
    expect(panel.style.background).toBe(jsdomColor(dark.surface));
    dismiss();
  });

  it("supplied header opts out of the built-in title/close generator", () => {
    const custom = document.createElement("div");
    custom.setAttribute("data-custom", "true");
    custom.textContent = "Custom";
    const { panel, dismiss } = mountCsModal({
      id: "k2c-test-modal-5",
      header: custom,
    });
    expect(panel.querySelector("[data-custom]")).toBe(custom);
    expect(panel.querySelector("[data-k2c-modal-header]")).toBeNull();
    dismiss();
  });

  it("focus trap is installed and removed cleanly on dismiss", () => {
    const { dismiss } = mountCsModal({
      id: "k2c-test-modal-6",
      title: "Trap",
    });
    const overlay = document.getElementById("k2c-test-modal-6");
    expect(typeof overlay._k2cFocusTrap).toBe("function");
    dismiss();
    expect(document.getElementById("k2c-test-modal-6")).toBeNull();
  });
});
