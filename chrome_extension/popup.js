"use strict";

/* normalizeCategoryPath is defined in categoryPath.js (loaded before this module). */

function createSimpleBootstrap(scope) {
  const doc = scope.document;
  let activeModalCount = 0;

  class SimpleModal {
    constructor(element) {
      this.element = element;
      this.visible = false;
      this.backdrop = null;
      this._handleDismiss = (event) => {
        const trigger = event.target.closest('[data-bs-dismiss="modal"]');
        if (trigger) {
          event.preventDefault();
          this.hide();
        }
      };
      this._handleKeydown = (event) => {
        if (event.key === "Escape") {
          this.hide();
        }
      };
      this._maybeDismiss = false;
      this.element.addEventListener("click", this._handleDismiss);
      this.element.addEventListener("mousedown", (event) => {
        this._maybeDismiss = event.target === this.element;
      });
      this.element.addEventListener("mouseup", (event) => {
        if (this._maybeDismiss && event.target === this.element) {
          this.hide();
        }
        this._maybeDismiss = false;
      });
    }

    show() {
      if (this.visible) return;
      this.visible = true;
      activeModalCount += 1;
      doc.body.classList.add("modal-open");
	  doc.body.style.minHeight = "536px";
      this.element.style.display = "block";
      this.element.removeAttribute("aria-hidden");
      this.element.classList.add("show");
      doc.addEventListener("keydown", this._handleKeydown);
      this.element.dispatchEvent(new CustomEvent("shown.bs.modal", { bubbles: true }));
    }

    hide() {
      if (!this.visible) return;
      this.visible = false;
      activeModalCount = Math.max(0, activeModalCount - 1);
      if (activeModalCount === 0) {
        doc.body.classList.remove("modal-open");
	  	doc.body.style.minHeight = null;
      }
      this.element.classList.remove("show");
      this.element.setAttribute("aria-hidden", "true");
      this.element.style.display = "none";
      doc.removeEventListener("keydown", this._handleKeydown);
      this.element.dispatchEvent(new CustomEvent("hidden.bs.modal", { bubbles: true }));
    }

  }

  class SimpleToast {
    constructor(element, options = {}) {
      this.element = element;
      this.delay = typeof options.delay === "number" ? options.delay : 5000;
      this.timer = null;
      this._handleDismiss = (event) => {
        const trigger = event.target.closest('[data-bs-dismiss="toast"]');
        if (trigger) {
          event.preventDefault();
          this.hide();
        }
      };
      this.element.addEventListener("click", this._handleDismiss);
    }

    show() {
      clearTimeout(this.timer);
      this.element.classList.add("show");
      this.element.classList.remove("hide");
      this.element.style.display = "block";
      this.element.setAttribute("aria-hidden", "false");
      if (this.delay > 0) {
        this.timer = setTimeout(() => this.hide(), this.delay);
      }
    }

    hide() {
      clearTimeout(this.timer);
      this.element.classList.remove("show");
      this.element.style.display = "none";
      this.element.setAttribute("aria-hidden", "true");
      this.element.dispatchEvent(new CustomEvent("hidden.bs.toast", { bubbles: true }));
    }
  }

  class SimpleTab {
    constructor(element) {
      this.element = element;
    }

    show() {
      const selector = this.element.getAttribute("data-bs-target") || this.element.getAttribute("href");
      if (!selector) return;
      const target = doc.querySelector(selector);
      if (!target) return;

      const nav = this.element.closest("[role=\"tablist\"]");
      if (nav) {
        nav.querySelectorAll(".nav-link").forEach((btn) => {
          if (btn !== this.element) {
            btn.classList.remove("active");
            btn.setAttribute("aria-selected", "false");
          }
        });
      }

      this.element.classList.add("active");
      this.element.setAttribute("aria-selected", "true");

      const container = target.parentElement;
      if (container) {
        Array.from(container.children).forEach((pane) => {
          if (pane !== target) {
            pane.classList.remove("show", "active");
          }
        });
      }
      target.classList.add("show", "active");
      this.element.dispatchEvent(new CustomEvent("shown.bs.tab", { bubbles: true }));
    }
  }

  return { Modal: SimpleModal, Toast: SimpleToast, Tab: SimpleTab };
}

const globalScope = typeof window !== "undefined" ? window : globalThis;
const bootstrap = globalScope.bootstrap || (globalScope.bootstrap = createSimpleBootstrap(globalScope));

const UI_STORAGE_KEY = "popupUiState";
const TAB_IDS = ["categories", "libraries", "settings"];

const DEFAULT_SETTINGS_SERVER_URL =
  typeof globalThis.K2C_DEFAULT_SERVER_URL === "string"
    ? globalThis.K2C_DEFAULT_SERVER_URL
    : "http://localhost:8087";

function extensionWsEndpointKeyFromBaseUrl(baseUrl) {
  return globalThis.k2cExtensionSocketEndpointKey(baseUrl);
}

/** Library row IDs with the read-only details panel open (session only; cleared on reload). */
const libraryDetailExpandedIds = new Set();

function toggleLibraryEntryDetails(id) {
  if (!id) return;
  if (libraryDetailExpandedIds.has(id)) {
    libraryDetailExpandedIds.delete(id);
  } else {
    libraryDetailExpandedIds.add(id);
  }
  renderLibraries();
}

const state = {
  activeTab: "categories",
  /** @type {"light"|"dark"} */
  uiTheme: "light",
  connected: false,
  // V3: the library picker gates on the Native Host (Native Messaging), not the
  // dead V2 WebSocket `connected` flag. Set by refreshNativeHostStatus().
  nativeHostOnline: false,
  connectionHint: null,
  libraries: [],
  libraryTotals: { symbols: 0, footprints: 0, models: 0 },
  libraryFilter: "",
  selectedLibraryPath: "",
  selectedLibraryName: "",
  settings: {
    serverUrl: DEFAULT_SETTINGS_SERVER_URL,
    overwrite: false,
    overwriteModel: false,
    debug: false,
    projectRelative: false,
    projectRelativePath: "",
    categorySettings: {},
    lowConfidenceBehaviour: "openEditor",
  },
  templateSymbols: [],
  ready: false,
  picker: {
    mode: null,
    callback: null,
    roots: [],
    currentPath: "",
    selectedPath: "",
    parentPath: "",
    selectedType: "",
    filterExtension: null,
    requireFile: false,
    breadcrumbs: [],
  },
};

const elements = {};
const modals = {};
let pickerManualTimer = null;
let _lastCategorySettingsJson = null;
/** @type {(() => void) | null} */
let popupConfirmAcceptCallback = null;

function popupConfirmEscHandler(event) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closePopupConfirm();
}

/**
 * @param {{ title: string, message: string, acceptLabel?: string, danger?: boolean, onAccept?: () => void }} opts
 */
function openPopupConfirm(opts) {
  const overlay = elements.popupConfirmOverlay;
  if (!overlay || !opts?.title) return;
  popupConfirmAcceptCallback = typeof opts.onAccept === "function" ? opts.onAccept : null;
  if (elements.popupConfirmTitle) elements.popupConfirmTitle.textContent = opts.title;
  if (elements.popupConfirmMessage) elements.popupConfirmMessage.textContent = opts.message || "";
  const acceptBtn = elements.popupConfirmAccept;
  if (acceptBtn) {
    acceptBtn.textContent = opts.acceptLabel || "Remove";
    const danger = opts.danger !== false;
    acceptBtn.className = danger ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm";
  }
  overlay.hidden = false;
  overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  document.body.style.minHeight = "536px";
  document.addEventListener("keydown", popupConfirmEscHandler, true);
  requestAnimationFrame(() => acceptBtn?.focus());
}

function closePopupConfirm() {
  const overlay = elements.popupConfirmOverlay;
  if (!overlay) return;
  overlay.hidden = true;
  overlay.setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", popupConfirmEscHandler, true);
  document.body.classList.remove("modal-open");
  document.body.style.minHeight = null;
  popupConfirmAcceptCallback = null;
}

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  initModals();
  bindEvents();
  toggleSettingsProjectPath();
  updateBackendControls();
  await loadUiPreferences();
  await hydrate();
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  refreshNativeHostStatus();
}

async function refreshNativeHostStatus() {
  const textEl = document.getElementById("native-host-status-text");
  if (!textEl) return;
  try {
    // SW dispatcher wraps handler results: { ok: true, data } on success,
    // { ok: false, error } on dispatcher-side failure (see background.js).
    const response = await chrome.runtime.sendMessage({ type: "pingNativeHost" });
    const payload = response?.ok ? response.data : null;
    if (payload?.online) {
      state.nativeHostOnline = true;
      textEl.textContent = `online · v${payload.version || "?"}`;
      textEl.style.color = "var(--bs-success, #198754)";
    } else {
      state.nativeHostOnline = false;
      const err = payload?.error || response?.error || "no host";
      textEl.textContent = `offline — ${err} (run the installer?)`;
      textEl.style.color = "var(--bs-danger, #dc3545)";
    }
  } catch (e) {
    state.nativeHostOnline = false;
    textEl.textContent = `offline — ${e?.message || "ping failed"}`;
    textEl.style.color = "var(--bs-danger, #dc3545)";
  }
  // Library picker buttons gate on the Native Host being reachable.
  updateBackendControls();
}

function cacheElements() {
  elements.tabButtons = Array.from(document.querySelectorAll(".tab-button"));
  elements.panels = TAB_IDS.reduce((acc, id) => {
    acc[id] = document.getElementById(`tab-panel-${id}`);
    return acc;
  }, {});
  elements.connectionStatus = document.getElementById("connection-status");
  elements.connectionStatusDot = document.getElementById("connection-status-dot");
  elements.connectionHint = document.getElementById("connection-hint");
  elements.headerActive = document.getElementById("header-active");
  elements.toastContainer = document.getElementById("toast-container");

  // Libraries tab
  elements.libraryList = document.getElementById("library-list");
  elements.libraryEmpty = document.getElementById("library-empty");
  elements.libraryAdd = document.getElementById("library-add");
  elements.libraryModal = document.getElementById("library-modal");
  elements.libraryModalTabs = document.getElementById("library-modal-tabs");
  elements.libraryModalSubmit = document.getElementById("library-modal-submit");
  elements.libraryImportForm = document.getElementById("library-import-form");
  elements.libraryImportPath = "";
  elements.libraryImportInfo = document.getElementById("library-import-info");
  elements.librarySummary = document.getElementById("library-summary");
  elements.librarySearch = document.getElementById("library-search");
  elements.libraryCreateForm = document.getElementById("library-create-form");
  elements.libraryCreateName = document.getElementById("library-create-name");
  elements.libraryCreatePath = document.getElementById("library-create-path");
  elements.libraryCreateSymbol = document.getElementById("library-create-symbol");
  elements.libraryCreateFootprint = document.getElementById("library-create-footprint");
  elements.libraryCreateModel = document.getElementById("library-create-model");
  elements.pickerButtons = Array.from(document.querySelectorAll("[data-picker]"));

  // Categories tab
  elements.categoryList = document.getElementById("category-list");
  elements.categoryAdd = document.getElementById("category-add");

  // Settings
  elements.settingsForm = document.getElementById("settings-form");
  elements.settingsServer = document.getElementById("settings-server");
  elements.settingsTest = document.getElementById("settings-test");
  elements.settingsOverwrite = document.getElementById("settings-overwrite");
  elements.settingsOverwriteModel = document.getElementById("settings-overwrite-model");
  elements.settingsDebug = document.getElementById("settings-debug");
  elements.settingsProjectRelative = document.getElementById("settings-project-relative");
  elements.settingsProjectRelativePathGroup = document.getElementById("settings-project-relative-path-group");
  elements.settingsProjectRelativePath = document.getElementById("settings-project-relative-path");
  elements.settingsLowConfidence = document.getElementById("settings-low-confidence");
  elements.themeOptions = Array.from(document.querySelectorAll(".theme-option"));

  // Modals shared
  elements.libraryRequiredModal = document.getElementById("library-required-modal");
  elements.pickerModal = document.getElementById("picker-modal");
  elements.pickerModalTitle = document.getElementById("picker-modal-title");
  elements.pickerManual = document.getElementById("picker-manual");
  elements.pickerPathBreadcrumb = document.getElementById("picker-path-breadcrumb");
  elements.pickerList = document.getElementById("picker-list");
  elements.pickerApply = document.getElementById("picker-apply");
  elements.popupConfirmOverlay = document.getElementById("popup-confirm-overlay");
  elements.popupConfirmTitle = document.getElementById("popup-confirm-title");
  elements.popupConfirmMessage = document.getElementById("popup-confirm-message");
  elements.popupConfirmAccept = document.getElementById("popup-confirm-accept");
  elements.popupConfirmCancel = document.getElementById("popup-confirm-cancel");
}

function initModals() {
  modals.libraryRequired = elements.libraryRequiredModal ? new bootstrap.Modal(elements.libraryRequiredModal) : null;
  modals.library = elements.libraryModal ? new bootstrap.Modal(elements.libraryModal) : null;
  modals.picker = elements.pickerModal ? new bootstrap.Modal(elements.pickerModal) : null;

  elements.popupConfirmAccept?.addEventListener("click", () => {
    const fn = popupConfirmAcceptCallback;
    closePopupConfirm();
    if (typeof fn === "function") fn();
  });

  elements.popupConfirmCancel?.addEventListener("click", () => {
    closePopupConfirm();
  });

  elements.popupConfirmOverlay?.addEventListener("click", (e) => {
    if (e.target === elements.popupConfirmOverlay) closePopupConfirm();
  });

  if (elements.libraryModal) {
    elements.libraryModal.addEventListener("hidden.bs.modal", () => {
      clearLibraryCreateValidation();
      elements.libraryImportForm?.reset();
      elements.libraryCreateForm?.reset();
      if (elements.libraryImportInfo) {
        elements.libraryImportInfo.textContent = "";
        elements.libraryImportInfo.className = "form-text";
      }
    });
  }
}

function bindEvents() {
  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  });

  elements.pickerButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.nativeHostOnline) {
        showToast("Native Host is offline — run the installer / reload.", "warning");
        return;
      }
      const mode = button.dataset.picker;
      openDirectoryPicker({
        mode,
        applyLabel: mode === "import" ? "Import library" : "Use this folder",
        initialPath: mode === "import" ? elements.libraryImportPath : elements.libraryCreatePath.value,
        onSelect: (selectedPath) => {
          if (mode === "import") {
            elements.libraryImportPath = selectedPath;
			submitImportLibrary();
          } else {
            elements.libraryCreatePath.value = selectedPath;
            elements.libraryCreatePath.classList.remove("is-invalid");
          }
        },
      });
    });
  });

  elements.libraryAdd?.addEventListener("click", () => {
    setLibraryModalTab("import");
    modals.library?.show();
  });
  elements.librarySearch?.addEventListener("input", handleLibrarySearch);

  elements.libraryModalTabs?.addEventListener("click", (event) => {
    const trigger = event.target.closest('[data-bs-toggle="pill"]');
    if (!trigger) return;
    event.preventDefault();
    const tab = new bootstrap.Tab(trigger);
    tab.show();
  });
  elements.libraryModalSubmit?.addEventListener("click", submitCreateLibrary);
  elements.libraryCreateName?.addEventListener("input", () => {
    if (elements.libraryCreateName.value.trim()) {
      elements.libraryCreateName.classList.remove("is-invalid");
    }
  });

  elements.libraryList?.addEventListener("change", handleLibraryListChange);
  elements.libraryList?.addEventListener("click", handleLibraryListClick);

  elements.settingsForm?.addEventListener("change", debounce(handleSettingsChange, 250));
  elements.settingsTest?.addEventListener("click", testServerConnection);
  elements.settingsProjectRelative?.addEventListener("change", toggleSettingsProjectPath);
  elements.categoryAdd?.addEventListener("click", addCategoryRow);

  elements.themeOptions?.forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-theme-value");
      if (value !== "light" && value !== "dark") return;
      state.uiTheme = value;
      applyPopupTheme(value);
      syncThemeSegmentButtons();
      void saveUiPreferences();
    });
  });

  elements.pickerManual?.addEventListener("input", handlePickerManualInput);
  elements.pickerManual?.addEventListener("change", handlePickerManualChange);
  elements.pickerManual?.addEventListener("keydown", handlePickerManualKeydown);

  elements.pickerApply?.addEventListener("click", applyPickerSelection);

  elements.pickerList?.addEventListener("click", handlePickerListClick);
  elements.pickerList?.addEventListener("dblclick", handlePickerListDoubleClick);
  elements.pickerList?.addEventListener("keydown", handlePickerListKeydown);

  elements.libraryRequiredModal?.addEventListener("click", (event) => {
    const target = event.target.closest("[data-focus-tab]");
    if (target) {
      const tab = target.dataset.focusTab;
      if (tab) {
        requestAnimationFrame(() => setActiveTab(tab));
      }
    }
  });
}

function applyPopupTheme(theme) {
  const t = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = t;
}

function syncThemeSegmentButtons() {
  const t = state.uiTheme === "dark" ? "dark" : "light";
  elements.themeOptions?.forEach((btn) => {
    const v = btn.getAttribute("data-theme-value");
    const on = v === t;
    btn.classList.toggle("btn-primary", on);
    btn.classList.toggle("btn-outline-primary", !on);
  });
}

async function loadUiPreferences() {
  try {
    const stored = await chrome.storage.local.get(UI_STORAGE_KEY);
    const data = stored?.[UI_STORAGE_KEY];
    let tab = data?.activeTab;
    if (tab === "parts") {
      tab = "libraries";
    }
    if (data && typeof data === "object" && tab && TAB_IDS.includes(tab)) {
      state.activeTab = tab;
    }
    if (data && typeof data.projectRelative === "boolean") {
      state.settings.projectRelative = data.projectRelative;
    }
    if (data && (data.theme === "light" || data.theme === "dark")) {
      state.uiTheme = data.theme;
    }
  } catch (error) {
    console.warn("Failed to read UI preferences", error);
  }
  applyPopupTheme(state.uiTheme);
  syncThemeSegmentButtons();
  setActiveTab(state.activeTab, { silent: true });
}

async function saveUiPreferences() {
  try {
    await chrome.storage.local.set({
      [UI_STORAGE_KEY]: {
        activeTab: state.activeTab,
        projectRelative: state.settings.projectRelative,
        theme: state.uiTheme === "dark" ? "dark" : "light",
      },
    });
  } catch (error) {
    console.warn("Failed to persist UI preferences", error);
  }
}

async function hydrate() {
  try {
    const snapshot = await sendMessage("getState");
    applyState(snapshot);
  } catch (error) {
    console.error("Failed to load state", error);
    showToast(error.message || "Failed to load state", "danger");
  }
}

function handleRuntimeMessage(message) {
  if (message?.type === "stateUpdate") {
    applyState(message.state);
  }
}

function applyState(snapshot = {}) {
  state.connected = Boolean(snapshot.connected);
  state.libraries = Array.isArray(snapshot.libraries)
    ? snapshot.libraries.map((item) => ({
        ...item,
        counts: {
          symbol: Number(item?.counts?.symbol) || 0,
          footprint: Number(item?.counts?.footprint) || 0,
          model: Number(item?.counts?.model) || 0,
        },
      }))
    : [];
  state.libraryTotals = {
    symbols: Number(snapshot.libraryTotals?.symbols) || 0,
    footprints: Number(snapshot.libraryTotals?.footprints) || 0,
    models: Number(snapshot.libraryTotals?.models) || 0,
  };
  state.selectedLibraryPath = typeof snapshot.selectedLibraryPath === "string" ? snapshot.selectedLibraryPath : "";
  state.selectedLibraryName = typeof snapshot.selectedLibraryName === "string" ? snapshot.selectedLibraryName : "";

  const serverUrl = typeof snapshot.serverUrl === "string" && snapshot.serverUrl.trim().length
    ? snapshot.serverUrl.trim()
    : state.settings.serverUrl;

  state.settings.serverUrl = serverUrl;
  state.settings.overwrite = Boolean(snapshot.overwriteFootprints);
  state.settings.overwriteModel = Boolean(snapshot.overwriteModels);
  state.settings.debug = Boolean(snapshot.debugLogs);

  if (typeof snapshot.projectRelative === "boolean") {
    state.settings.projectRelative = snapshot.projectRelative;
  }
  if (typeof snapshot.projectRelativePath === "string") {
    state.settings.projectRelativePath = snapshot.projectRelativePath;
  }
  if (typeof snapshot.lowConfidenceBehaviour === "string") {
    state.settings.lowConfidenceBehaviour =
      snapshot.lowConfidenceBehaviour === "keepEasyeda" ? "keepEasyeda" : "openEditor";
  }
  if (snapshot.categorySettings && typeof snapshot.categorySettings === "object") {
    state.settings.categorySettings = dedupeCategorySettings({ ...snapshot.categorySettings });
  }
  if (Array.isArray(snapshot.templateSymbols)) {
    state.templateSymbols = snapshot.templateSymbols.slice();
  }

  renderConnectionStatus();
  renderLibraries();
  renderSettings();
  updateBackendControls();

  state.ready = true;
}

function renderConnectionStatus() {
  if (!elements.connectionStatus) return;
  elements.connectionStatusDot.classList.toggle("badge-online", state.connected);
  elements.connectionStatusDot.classList.toggle("badge-offline", !state.connected);
  if (elements.connectionHint) {
    if (!state.connected && state.connectionHint) {
      elements.connectionHint.textContent = state.connectionHint;
      elements.connectionHint.classList.remove("d-none");
    } else {
      elements.connectionHint.textContent = "";
      elements.connectionHint.classList.add("d-none");
    }
  }
}

function updateBackendControls() {
  if (!elements.pickerButtons?.length) return;
  const disabled = !state.nativeHostOnline;
  elements.pickerButtons.forEach((button) => {
    button.disabled = disabled;
    if (disabled) {
      button.setAttribute("title", "Native Host offline — run the installer / reload.");
      button.setAttribute("aria-disabled", "true");
    } else {
      button.removeAttribute("title");
      button.setAttribute("aria-disabled", "false");
    }
  });
}


function renderLibraries() {
  if (!elements.libraryList) return;

  elements.libraryList.innerHTML = "";
  const sortedLibraries = state.libraries
    .slice()
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
  const totalLibraries = sortedLibraries.length;

  if (elements.librarySearch && elements.librarySearch.value !== state.libraryFilter) {
    elements.librarySearch.value = state.libraryFilter;
  }

  const query = state.libraryFilter.trim().toLowerCase();
  let libraries = sortedLibraries;
  if (query) {
    libraries = sortedLibraries.filter((library) => {
      const name = (library.name || "").toLowerCase();
      const symbolPath = (library.symbolPath || "").toLowerCase();
      const basePath = (library.path || library.resolvedPrefix || "").toLowerCase();
      return name.includes(query) || symbolPath.includes(query) || basePath.includes(query);
    });
  }

  const visibleCount = libraries.length;

  const totals = state.libraryTotals || { symbols: 0, footprints: 0, models: 0 };
  if (elements.librarySummary) {
    if (!totalLibraries) {
      elements.librarySummary.textContent = "No libraries available yet.";
    } else {
      let summary = `Symbol: ${totals.symbols} · Footprints: ${totals.footprints} · 3D: ${totals.models}`;
      if (query) {
        summary += ` · Matches: ${visibleCount}/${totalLibraries}`;
      }
      elements.librarySummary.textContent = summary;
    }
  }

  if (elements.headerActive) {
    const active = sortedLibraries.find((item) => item.active)
      || sortedLibraries.find((item) => !item.missing)
      || sortedLibraries[0];
    if (active) {
      elements.headerActive.innerHTML = `
        <span class="header-active-arrow">➜</span>
        <span class="header-active-label">Active library</span>
        <span class="header-active-name">${escapeHtml(active.name || "Untitled library")}</span>
      `;
    } else {
      elements.headerActive.innerHTML = "";
    }
  }

  if (!totalLibraries) {
    if (elements.libraryEmpty) {
      elements.libraryEmpty.textContent = "No libraries yet. Add one to get started.";
      elements.libraryEmpty.classList.remove("d-none");
    }
    return;
  }

  if (!visibleCount) {
    if (elements.libraryEmpty) {
      elements.libraryEmpty.textContent = "No libraries matched your search.";
      elements.libraryEmpty.classList.remove("d-none");
    }
    elements.libraryList.innerHTML = "";
    return;
  }

  if (elements.libraryEmpty) {
    elements.libraryEmpty.classList.add("d-none");
    elements.libraryEmpty.textContent = "No libraries yet. Add one to get started.";
  }

  syncSelectedLibrary();

  libraries.forEach((library) => {
    const item = document.createElement("div");
    item.className = "library-entry";
    if (library.active) item.className += " active";
    if (library.missing) item.className += " missing";
    if (library.isTemplateLibrary) item.className += " template-lib";
    item.dataset.id = library.id;

    const info = document.createElement("div");
    info.className = "library-info library-entry-summary";

    const titleRow = document.createElement("div");
    titleRow.className = "d-flex align-items-center gap-2 library-entry-title-row";

    const expanded = libraryDetailExpandedIds.has(library.id);
    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "library-expand-btn";
    expandBtn.dataset.id = library.id;
    expandBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    expandBtn.setAttribute(
      "aria-controls",
      `library-details-${library.id}`,
    );
    expandBtn.setAttribute(
      "title",
      expanded ? "Hide library details" : "Show library details",
    );
    expandBtn.setAttribute(
      "aria-label",
      expanded ? "Hide library details" : "Show library details",
    );
    const chevron = document.createElement("span");
    chevron.className = "library-expand-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "▾";
    expandBtn.appendChild(chevron);
    titleRow.appendChild(expandBtn);

    const title = document.createElement("span");
    title.className = "fw-semibold fs-6";
    title.textContent = library.name || "Untitled library";
    titleRow.appendChild(title);

    if (library.isTemplateLibrary) {
      const badge = document.createElement("span");
      badge.className = "library-template-badge";
      badge.textContent = "TEMPLATE";
      titleRow.appendChild(badge);
    }

    const actionWrapper = document.createElement("div");
    actionWrapper.className = "flex-fill d-flex flex-row-reverse align-items-center gap-2";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "cat-remove library-remove";
    removeBtn.innerHTML = "&times;";
    removeBtn.setAttribute("aria-label", `Remove library ${library.name || ""}`.trim());
    removeBtn.setAttribute("title", "Remove library");
    removeBtn.dataset.id = library.id;
    actionWrapper.appendChild(removeBtn);

    if (!library.isTemplateLibrary) {
      if (library.active) {
        const pill = document.createElement("span");
        pill.className = "library-status-pill library-status-pill--active";
        pill.setAttribute("role", "status");
        pill.setAttribute("aria-label", "Active library");
        const dot = document.createElement("span");
        dot.className = "library-status-pill-dot badge-online";
        dot.setAttribute("aria-hidden", "true");
        pill.appendChild(dot);
        pill.appendChild(document.createTextNode("Active"));
        actionWrapper.appendChild(pill);
      } else if (library.missing) {
        const pill = document.createElement("span");
        pill.className = "library-status-pill library-status-pill--missing";
        pill.setAttribute("role", "status");
        pill.setAttribute("aria-label", "Library missing on disk");
        const dot = document.createElement("span");
        dot.className = "library-status-pill-dot badge-offline";
        dot.setAttribute("aria-hidden", "true");
        pill.appendChild(dot);
        pill.appendChild(document.createTextNode("Missing"));
        actionWrapper.appendChild(pill);
      } else {
        const toggle = document.createElement("input");
        toggle.type = "button";
        toggle.className = "library-toggle library-status-pill--activate";
        toggle.value = "Activate";
        toggle.dataset.id = library.id;
        toggle.setAttribute(
          "aria-label",
          `Activate library ${library.name || ""}`.trim(),
        );
        toggle.onclick = (event) => {
          toggle.disabled = true;
          handleLibraryListChange(event);
        };
        actionWrapper.appendChild(toggle);
      }
    }

    titleRow.appendChild(actionWrapper);
    info.appendChild(titleRow);

    const assets = document.createElement("div");
    assets.className = "library-assets mb-1 mt-1 d-flex align-items-center gap-1";
    assets.appendChild(renderAssetBadge("Symbol", library.assets?.symbol, library.counts?.symbol));
    assets.appendChild(renderAssetBadge("Footprint", library.assets?.footprint, library.counts?.footprint));
    assets.appendChild(renderAssetBadge("3D", library.assets?.model, library.counts?.model));

    // Template toggle switch — placed inline with the asset badges
    const switchLabel = document.createElement("label");
    switchLabel.className = "template-switch ms-auto";
    switchLabel.title = library.isTemplateLibrary
      ? "Disable template mode for this library"
      : "Enable template mode — symbols in this library can be used as templates on LCSC. Use numeric pin numbers matching EasyEDA; on LCSC, verify against the part pin diagram or EasyEDA symbol (README: Templates & metadata).";

    const switchInput = document.createElement("input");
    switchInput.type = "checkbox";
    switchInput.className = "template-switch-input library-template-toggle";
    switchInput.checked = Boolean(library.isTemplateLibrary);
    switchInput.dataset.id = library.id;

    const switchTrack = document.createElement("span");
    switchTrack.className = "template-switch-track";
    switchTrack.innerHTML = `<span class="template-switch-thumb"></span>`;

    const switchText = document.createElement("span");
    switchText.className = "template-switch-label";
    switchText.textContent = "Template";

    switchLabel.appendChild(switchInput);
    switchLabel.appendChild(switchTrack);
    switchLabel.appendChild(switchText);
    assets.appendChild(switchLabel);

    info.appendChild(assets);
	
    const path = document.createElement("div");
    path.className = "library-meta";
    path.textContent = library.symbolPath || library.path || library.resolvedPrefix || "";
    info.appendChild(path);

    if (library.missing) {
      const warning = document.createElement("div");
      warning.className = "library-warning";
      warning.textContent = "Library missing on disk.";
      info.appendChild(warning);
    }

    const details = document.createElement("div");
    details.className = "library-details";
    details.id = `library-details-${library.id}`;
    details.hidden = !expanded;
    details.setAttribute("role", "region");
    details.setAttribute(
      "aria-label",
      `Paths and settings for ${library.name || "library"}`,
    );
    if (expanded) {
      details.appendChild(buildLibraryDetailsPanel(library));
    }

    item.appendChild(info);
    item.appendChild(details);
    elements.libraryList.appendChild(item);
  });
}

function renderAssetBadge(label, active, count = 0) {
  const badge = document.createElement("span");
  const hasEntries = active && count > 0;
  const displayCount = typeof count === "number" && count >= 0 ? ` (${count})` : "";
  badge.className = `badge rounded-pill ${hasEntries ? "text-bg-success" : "text-bg-secondary"}`;
  badge.innerHTML = `<span class="badge-label">${escapeHtml(label)}</span><span class="badge-count">${escapeHtml(displayCount.trim())}</span>`;
  return badge;
}

function libraryStoragePrefix(lib) {
  return (lib.path || lib.resolvedPrefix || "").trim();
}

function libraryFootprintFolderDisplay(lib) {
  const p = libraryStoragePrefix(lib);
  return p ? `${p}.pretty` : "—";
}

function libraryShapesFolderDisplay(lib) {
  const p = libraryStoragePrefix(lib);
  return p ? `${p}.3dshapes` : "—";
}

function formatLibraryDetailTimestamp(iso) {
  if (!iso || typeof iso !== "string") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function libraryDetailYesNo(v) {
  return v ? "Yes" : "No";
}

function buildLibraryDetailRow(label, valueText) {
  const row = document.createElement("div");
  row.className = "library-detail-row";
  const dt = document.createElement("dt");
  dt.className = "library-detail-label";
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.className = "library-detail-value";
  const text = valueText != null && String(valueText).trim() !== "" ? String(valueText) : "—";
  dd.textContent = text;
  row.appendChild(dt);
  row.appendChild(dd);
  return row;
}

function buildLibraryDetailsPanel(library) {
  const wrap = document.createElement("div");
  wrap.className = "library-details-inner";

  const dl = document.createElement("dl");
  dl.className = "library-details-dl";

  const prefix = libraryStoragePrefix(library);
  const sym = (library.symbolPath || "").trim();

  dl.appendChild(buildLibraryDetailRow("Library prefix", prefix || "—"));
  dl.appendChild(buildLibraryDetailRow("Symbol file", sym || "—"));
  dl.appendChild(buildLibraryDetailRow("Footprint folder (.pretty)", libraryFootprintFolderDisplay(library)));
  dl.appendChild(buildLibraryDetailRow("3D shapes folder (.3dshapes)", libraryShapesFolderDisplay(library)));
  const modelPath = (library.modelPath || "").trim();
  if (modelPath) {
    dl.appendChild(buildLibraryDetailRow("3D path (from footprints)", modelPath));
  }
  dl.appendChild(buildLibraryDetailRow("Template library", libraryDetailYesNo(library.isTemplateLibrary)));
  const basePath = (library.basePath || "").trim();
  if (basePath) {
    dl.appendChild(buildLibraryDetailRow("Created under base folder", basePath));
  }
  dl.appendChild(buildLibraryDetailRow("Created", formatLibraryDetailTimestamp(library.createdAt)));
  dl.appendChild(buildLibraryDetailRow("Last validated", formatLibraryDetailTimestamp(library.lastValidation)));

  const counts = library.counts || {};
  dl.appendChild(
    buildLibraryDetailRow(
      "Counts (indexed)",
      `Symbols ${Number(counts.symbol) || 0} · Footprints ${Number(counts.footprint) || 0} · 3D ${Number(counts.model) || 0}`,
    ),
  );

  wrap.appendChild(dl);

  const warnings = Array.isArray(library.warnings) ? library.warnings.filter((w) => w && String(w).trim()) : [];
  if (warnings.length) {
    const wTitle = document.createElement("p");
    wTitle.className = "library-detail-warnings-title";
    wTitle.textContent = "Warnings";
    wrap.appendChild(wTitle);
    const ul = document.createElement("ul");
    ul.className = "library-detail-warnings";
    warnings.forEach((w) => {
      const li = document.createElement("li");
      li.textContent = String(w);
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
  }

  return wrap;
}

function renderSettings() {
  if (!elements.settingsServer) return;
  if (!elements.settingsServer.matches(":focus")) {
    elements.settingsServer.value = state.settings.serverUrl;
  }
  elements.settingsOverwrite.checked = state.settings.overwrite;
  elements.settingsOverwriteModel.checked = state.settings.overwriteModel;
  elements.settingsDebug.checked = state.settings.debug;
  elements.settingsProjectRelative.checked = state.settings.projectRelative;
  if (elements.settingsProjectRelativePath && !elements.settingsProjectRelativePath.matches(":focus")) {
    elements.settingsProjectRelativePath.value = state.settings.projectRelativePath || "";
  }
  if (elements.settingsLowConfidence) {
    elements.settingsLowConfidence.value =
      state.settings.lowConfidenceBehaviour === "keepEasyeda" ? "keepEasyeda" : "openEditor";
  }
  toggleSettingsProjectPath();
  renderCategoryTable();
}

function renderCategoryTable() {
  if (!elements.categoryList) return;
  const raw = state.settings.categorySettings || {};
  const cats = dedupeCategorySettings(raw);
  if (JSON.stringify(cats) !== JSON.stringify(raw)) {
    state.settings.categorySettings = cats;
    sendMessage("updateSettings", { categorySettings: cats }).catch((err) =>
      console.warn("Failed to persist deduplicated categories", err),
    );
  }
  const json = JSON.stringify(cats);
  if (json === _lastCategorySettingsJson) return; // unchanged — don't disturb open accordions
  _lastCategorySettingsJson = json;
  elements.categoryList.innerHTML = "";
  Object.entries(cats)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .forEach(([category, cfg]) => {
      elements.categoryList.appendChild(buildCategoryItem(category, cfg));
    });
}

/**
 * Renders a wrapping breadcrumb trail for the LCSC category path (full path visible without expanding).
 */
function syncCatPathBreadcrumbs(item) {
  const wrap = item.querySelector(".cat-path-breadcrumbs");
  if (!wrap) return;
  const raw = item.querySelector("[data-field='category']")?.value?.trim() || "";
  const norm = normalizeCategoryPath(raw);
  wrap.replaceChildren();
  if (!norm) {
    wrap.title = "";
    const ph = document.createElement("span");
    ph.className = "cat-path-placeholder";
    ph.textContent = "Add LCSC category path…";
    wrap.appendChild(ph);
    return;
  }
  wrap.title = norm;
  const parts = norm.split("/").filter(Boolean);
  parts.forEach((seg, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "cat-path-sep";
      sep.textContent = "/";
      wrap.appendChild(sep);
    }
    const span = document.createElement("span");
    span.className = "cat-path-segment";
    span.textContent = seg;
    wrap.appendChild(span);
  });
}

/** After expanding a category row, scroll so the full block is visible inside #categories-card-body. */
function scrollCategoryItemIntoView(item) {
  if (!item) return;
  const scroller = document.getElementById("categories-card-body");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (scroller?.contains(item)) {
        const pad = 8;
        const cr = scroller.getBoundingClientRect();
        const ir = item.getBoundingClientRect();
        if (ir.top < cr.top + pad) {
          scroller.scrollTop += ir.top - cr.top - pad;
        } else if (ir.bottom > cr.bottom - pad) {
          scroller.scrollTop += ir.bottom - cr.bottom + pad;
        }
      } else {
        item.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      }
    });
  });
}

function buildCategoryItem(category, cfg, openByDefault = false) {
  const item = document.createElement("div");
  item.className = "cat-item";
  item.dataset.open = openByDefault ? "1" : "0";

  // ── Header ──────────────────────────────────────────────────────────────
  const header = document.createElement("div");
  header.className = "cat-header";

  // Left: name on top, chips below
  const headerLeft = document.createElement("div");
  headerLeft.className = "cat-header-left";

  const pathBreadcrumbs = document.createElement("div");
  pathBreadcrumbs.className = "cat-path-breadcrumbs";
  pathBreadcrumbs.setAttribute("role", "group");
  pathBreadcrumbs.setAttribute(
    "aria-label",
    category ? `Category path: ${normalizeCategoryPath(category)}` : "Category path",
  );

  const nameInput = document.createElement("textarea");
  nameInput.className = "cat-name-input";
  nameInput.rows = 2;
  nameInput.value = category;
  nameInput.placeholder = "Passives/Resistors/…";
  nameInput.dataset.field = "category";
  nameInput.setAttribute("aria-label", "LCSC category path (slash-separated)");
  const fitCategoryPathTextarea = () => {
    if (item.dataset.open !== "1") return;
    nameInput.style.height = "auto";
    nameInput.style.height = `${Math.max(nameInput.scrollHeight, 40)}px`;
  };

  nameInput.addEventListener("input", () => {
    syncCatPathBreadcrumbs(item);
    pathBreadcrumbs.setAttribute(
      "aria-label",
      nameInput.value.trim()
        ? `Category path: ${normalizeCategoryPath(nameInput.value)}`
        : "Category path",
    );
    fitCategoryPathTextarea();
  });
  nameInput.addEventListener(
    "input",
    debounce(() => {
      updateCatSummary(item);
      saveCategoryTableState();
    }, 400),
  );

  const summaryRow = document.createElement("div");
  summaryRow.className = "cat-summary";

  headerLeft.appendChild(pathBreadcrumbs);
  headerLeft.appendChild(nameInput);
  headerLeft.appendChild(summaryRow);

  // Right: chevron + remove
  const headerRight = document.createElement("div");
  headerRight.className = "cat-header-right";

  const chevron = document.createElement("span");
  chevron.className = "cat-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "▾";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "cat-remove";
  removeBtn.innerHTML = "&times;";
  removeBtn.setAttribute("aria-label", `Remove ${category || "category"}`);
  removeBtn.setAttribute("title", "Remove category");
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const rawName = String(nameInput.value || "").trim();
    openPopupConfirm({
      title: "Remove category",
      message: rawName
        ? `Remove "${rawName}" and its saved Value parameter and pin options? This cannot be undone.`
        : "Remove this empty category row? Unsaved details will be lost.",
      acceptLabel: "Remove",
      onAccept: () => {
        if (item.isConnected) {
          item.remove();
          saveCategoryTableState();
        }
      },
    });
  });

  headerRight.appendChild(chevron);
  headerRight.appendChild(removeBtn);

  header.appendChild(headerLeft);
  header.appendChild(headerRight);

  header.addEventListener("click", (e) => {
    // When already open, clicking inside the path editor focuses it — don't collapse
    if (item.dataset.open === "1" && nameInput.contains(e.target)) {
      nameInput.focus();
      return;
    }
    const wasOpen = item.dataset.open === "1";
    item.dataset.open = wasOpen ? "0" : "1";
    body.hidden = wasOpen;
    chevron.style.transform = wasOpen ? "" : "rotate(-90deg)";
    if (!wasOpen) {
      requestAnimationFrame(() => {
        nameInput.style.height = "auto";
        nameInput.style.height = `${Math.max(nameInput.scrollHeight, 40)}px`;
        nameInput.focus();
        const len = nameInput.value.length;
        try {
          nameInput.setSelectionRange(len, len);
        } catch (_e) {
          /* ignore */
        }
      });
      scrollCategoryItemIntoView(item);
    }
  });

  // ── Body ────────────────────────────────────────────────────────────────
  const body = document.createElement("div");
  body.className = "cat-body";
  body.hidden = !openByDefault;
  if (openByDefault) chevron.style.transform = "rotate(-90deg)";

  // Value Param
  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.className = "form-control form-control-sm";
  valueInput.value = cfg.valueParam || "";
  valueInput.placeholder = "e.g. Resistance";
  valueInput.dataset.field = "valueParam";
  body.appendChild(makeCatField("Value Param", valueInput,
    "LCSC parameter used as the symbol Value (e.g. Resistance, Capacitance)"));

  // Hide pin numbers — small Bootstrap switch
  const cbHideNum = document.createElement("input");
  cbHideNum.type = "checkbox";
  cbHideNum.className = "form-check-input cat-switch";
  cbHideNum.setAttribute("role", "switch");
  cbHideNum.checked = Boolean(cfg.hidePinNumbers);
  cbHideNum.dataset.field = "hidePinNumbers";
  body.appendChild(makeCatSwitch("Hide pin numbers", cbHideNum));

  // Hide pin names — small Bootstrap switch
  const cbHideName = document.createElement("input");
  cbHideName.type = "checkbox";
  cbHideName.className = "form-check-input cat-switch";
  cbHideName.setAttribute("role", "switch");
  cbHideName.checked = Boolean(cfg.hidePinNames);
  cbHideName.dataset.field = "hidePinNames";
  body.appendChild(makeCatSwitch("Hide pin names", cbHideName));

  // Wire up live-save on checkboxes / value input
  [cbHideNum, cbHideName].forEach((cb) => cb.addEventListener("change", () => {
    updateCatSummary(item);
    saveCategoryTableState();
  }));
  valueInput.addEventListener("input", debounce(() => {
    updateCatSummary(item);
    saveCategoryTableState();
  }, 400));

  item.appendChild(header);
  item.appendChild(body);

  // Populate summary chips + path breadcrumbs after DOM is ready
  requestAnimationFrame(() => {
    syncCatPathBreadcrumbs(item);
    updateCatSummary(item);
    if (item.dataset.open === "1") {
      nameInput.style.height = "auto";
      nameInput.style.height = `${Math.max(nameInput.scrollHeight, 40)}px`;
    }
  });
  return item;
}

function makeCatField(label, control, hint = null) {
  const row = document.createElement("div");
  row.className = "cat-field cat-field-stack";
  if (!control.id) {
    control.id = `cat-field-${Math.random().toString(36).slice(2, 10)}`;
  }
  const lbl = document.createElement("label");
  lbl.className = "cat-field-label";
  lbl.htmlFor = control.id;
  lbl.textContent = label;
  if (hint) lbl.title = hint;
  row.appendChild(lbl);
  row.appendChild(control);
  return row;
}

function makeCatSwitch(label, input) {
  const uid = `cat-sw-${Math.random().toString(36).slice(2)}`;
  input.id = uid;
  const wrap = document.createElement("div");
  wrap.className = "form-check form-switch cat-switch-row";
  const lbl = document.createElement("label");
  lbl.className = "form-check-label cat-switch-label";
  lbl.htmlFor = uid;
  lbl.textContent = label;
  wrap.appendChild(input);
  wrap.appendChild(lbl);
  return wrap;
}

function updateCatSummary(item) {
  const summaryRow = item.querySelector(".cat-summary");
  if (!summaryRow) return;
  summaryRow.innerHTML = "";

  const valueParam = item.querySelector("[data-field='valueParam']")?.value?.trim();
  const hideNum = item.querySelector("[data-field='hidePinNumbers']")?.checked;
  const hideName = item.querySelector("[data-field='hidePinNames']")?.checked;

  if (valueParam) {
    const chip = document.createElement("span");
    chip.className = "cat-chip chip-value";
    chip.textContent = valueParam;
    summaryRow.appendChild(chip);
  }
  if (hideNum || hideName) {
    const chip = document.createElement("span");
    chip.className = "cat-chip chip-hidden";
    chip.textContent = "Pins hidden";
    summaryRow.appendChild(chip);
  }
}

function addCategoryRow() {
  if (!elements.categoryList) return;
  const item = buildCategoryItem("", { hidePinNumbers: false, hidePinNames: false, valueParam: "" }, true);
  elements.categoryList.appendChild(item);
  item.querySelector("[data-field='category']")?.focus();
  scrollCategoryItemIntoView(item);
}

function readCategoryTableState() {
  if (!elements.categoryList) return {};
  /** @type {Map<string, { displayKey: string, cfg: object }>} */
  const byCanon = new Map();
  Array.from(elements.categoryList.querySelectorAll(".cat-item")).forEach((item) => {
    const raw = item.querySelector("[data-field='category']")?.value?.trim() || "";
    const displayKey = normalizeCategoryPath(raw);
    const canon = canonicalCategoryKey(raw);
    if (!canon) return;
    const cfg = {
      hidePinNumbers: Boolean(item.querySelector("[data-field='hidePinNumbers']")?.checked),
      hidePinNames: Boolean(item.querySelector("[data-field='hidePinNames']")?.checked),
      valueParam: item.querySelector("[data-field='valueParam']")?.value?.trim() || null,
    };
    const prev = byCanon.get(canon);
    if (!prev) {
      byCanon.set(canon, { displayKey, cfg });
    } else {
      prev.cfg = mergeCategoryConfig(prev.cfg, cfg);
      if (displayKey.length > prev.displayKey.length) {
        prev.displayKey = displayKey;
      }
    }
  });
  const merged = {};
  for (const { displayKey, cfg } of byCanon.values()) {
    merged[displayKey] = cfg;
  }
  return dedupeCategorySettings(merged);
}

function saveCategoryTableState() {
  const rowCount = elements.categoryList?.querySelectorAll(".cat-item").length ?? 0;
  const categorySettings = readCategoryTableState();
  const keyCount = Object.keys(categorySettings).length;
  state.settings.categorySettings = categorySettings;
  // Pre-mark as rendered so the echoed state broadcast doesn't collapse open accordions
  _lastCategorySettingsJson = JSON.stringify(categorySettings);
  sendMessage("updateSettings", { categorySettings })
    .then(() => {})
    .catch((error) => console.warn("Failed to save category settings", error));
  if (rowCount > keyCount) {
    _lastCategorySettingsJson = null;
    renderCategoryTable();
  }
}

function setActiveTab(tab, options = {}) {
  if (tab === "parts") {
    tab = "libraries";
  }
  if (!TAB_IDS.includes(tab)) {
    tab = TAB_IDS[0];
  }
  state.activeTab = tab;
  elements.tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === tab;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  TAB_IDS.forEach((id) => {
    const panel = elements.panels[id];
    if (panel) {
      panel.classList.toggle("active", id === tab);
    }
  });
  if (!options.silent) {
    saveUiPreferences();
  }
}

function handleLibrarySearch(event) {
  const value = event?.target?.value ?? "";
  if (state.libraryFilter === value) {
    return;
  }
  state.libraryFilter = value;
  renderLibraries();
}

function handleLibraryListChange(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;

  if (input.classList.contains("library-template-toggle")) {
    const id = input.dataset.id;
    if (!id) return;
    const library = state.libraries.find((item) => item.id === id);
    if (!library) return;
    const nowTemplate = input.checked;
    state.libraries = state.libraries.map((item) => ({
      ...item,
      isTemplateLibrary: item.id === id ? nowTemplate : (nowTemplate ? false : item.isTemplateLibrary),
    }));
    renderLibraries();
    persistLibraries();
    const msg = nowTemplate
      ? `"${library.name}" set as template library.`
      : "Template mode disabled.";
    showToast(msg, "success");
    return;
  }

  if (!input.classList.contains("library-toggle")) return;
  const id = input.dataset.id;
  if (!id) return;
  const library = state.libraries.find((item) => item.id === id);
  if (!library) return;

  // Template libraries cannot be activated as the working library
  if (library.isTemplateLibrary) return;

  if (input.disabled) {
    state.libraries = state.libraries.map((item) => ({
      ...item,
      active: item.id === id,
    }));
  } else {
    const otherActive = state.libraries.some((item) => item.id !== id && item.active);
    if (!otherActive) {
      input.disabled = true;
      showToast("At least one library must remain active.", "warning");
      return;
    }
    state.libraries = state.libraries.map((item) => ({
      ...item,
      active: item.id === id ? false : item.active,
    }));
  }

  syncSelectedLibrary();
  renderLibraries();
  persistLibraries();
}

function handleLibraryListClick(event) {
  const expandBtn = event.target.closest(".library-expand-btn");
  if (expandBtn) {
    event.preventDefault();
    event.stopPropagation();
    const eid = expandBtn.dataset.id;
    if (!eid) return;
    toggleLibraryEntryDetails(eid);
    return;
  }

  const entry = event.target.closest(".library-entry");
  const summary = event.target.closest(".library-entry-summary");
  if (entry && summary && entry.contains(summary)) {
    const hitControl = event.target.closest(
      "button, input.library-toggle, label.template-switch",
    );
    if (!hitControl) {
      const rowId = entry.dataset.id;
      if (rowId) {
        toggleLibraryEntryDetails(rowId);
      }
      return;
    }
  }

  const button = event.target.closest("button");
  if (!button) return;
  const id = button.dataset.id;
  if (!id) return;
  const library = state.libraries.find((item) => item.id === id);
  if (!library) return;
  if (button.classList.contains("library-remove")) {
    event.preventDefault();
    const libId = id;
    const libName = library.name || "Untitled library";
    openPopupConfirm({
      title: "Remove library",
      message:
        `Remove "${libName}" from this extension? Only the list entry is removed; files on disk are not deleted.`
        + (library.active && state.libraries.filter((x) => x.id !== libId).length > 0
          ? " Another library will become active if needed."
          : ""),
      acceptLabel: "Remove",
      onAccept: () => {
        libraryDetailExpandedIds.delete(libId);
        state.libraries = state.libraries.filter((item) => item.id !== libId);
        if (!state.libraries.some((item) => item.active) && state.libraries.length) {
          state.libraries[0].active = true;
        }
        syncSelectedLibrary();
        renderLibraries();
        persistLibraries();
        showToast("Library removed", "success");
      },
    });
  }
}

function submitImportLibrary() {
  const path = (elements.libraryImportPath || "").trim();
  if (!path) {
    setLibraryModalError("Please choose a file.");
    return;
  }
  if (!path.toLowerCase().endsWith(".kicad_sym")) {
    setLibraryModalError("Please select a .kicad_sym file.");
    return;
  }
  elements.libraryModalSubmit.disabled = true;
  sendMessage("importLibrary", { path })
    .then((record) => {
      state.libraries = upsertLibrary(record, true);
      syncSelectedLibrary();
      renderLibraries();
      persistLibraries();
      showToast(`Library "${record.name}" imported.`, "success");
      modals.library?.hide();
    })
    .catch((error) => setLibraryModalError(error.message || "Import failed."))
    .finally(() => {
      elements.libraryModalSubmit.disabled = false;
    });
}

function submitCreateLibrary() {
  clearLibraryCreateValidation();
  const name = elements.libraryCreateName.value.trim();
  const basePath = elements.libraryCreatePath.value.trim();
  let hasError = false;
  if (!name) {
    elements.libraryCreateName.classList.add("is-invalid");
    hasError = true;
  }
  if (!basePath) {
    elements.libraryCreatePath.classList.add("is-invalid");
    hasError = true;
  }
  if (hasError) {
    setLibraryModalError("Name and base folder are required.");
    return;
  }
  const payload = {
    name,
    basePath,
    symbol: elements.libraryCreateSymbol.checked,
    footprint: elements.libraryCreateFootprint.checked,
    model: elements.libraryCreateModel.checked,
  };

  elements.libraryModalSubmit.disabled = true;
  sendMessage("createLibrary", payload)
    .then((record) => {
      state.libraries = upsertLibrary(record, true);
      syncSelectedLibrary();
      renderLibraries();
      persistLibraries();
      showToast(`Library "${record.name}" created.`, "success");
      modals.library?.hide();
    })
    .catch((error) => setLibraryModalError(error.message || "Creation failed."))
    .finally(() => {
      elements.libraryModalSubmit.disabled = false;
    });
}

function upsertLibrary(record, activate = false) {
  const libraries = state.libraries.slice();
  const index = libraries.findIndex((item) => item.id === record.id);
  const normalized = {
    ...record,
    active: activate ? true : Boolean(record.active),
    isTemplateLibrary: Boolean(record.isTemplateLibrary),
    counts: {
      symbol: Number(record?.counts?.symbol) || 0,
      footprint: Number(record?.counts?.footprint) || 0,
      model: Number(record?.counts?.model) || 0,
    },
  };
  if (activate) {
    libraries.forEach((item) => {
      item.active = item.id === record.id;
    });
  }
  if (index >= 0) {
    libraries[index] = { ...libraries[index], ...normalized };
  } else {
    if (activate) {
      libraries.forEach((item) => (item.active = false));
    }
    libraries.push(normalized);
  }
  return libraries;
}

function persistLibraries() {
  sendMessage("updateLibraries", { libraries: state.libraries })
    .then((snapshot) => {
      if (snapshot) {
        applyState(snapshot);
      }
    })
    .catch((error) => showToast(error.message || "Saving failed", "danger"));
}

function handleSettingsChange() {
  const rawProjectPath = elements.settingsProjectRelativePath?.value.trim() || "";
  const projectRelativePath = elements.settingsProjectRelative.checked
    ? rawProjectPath
    : (state.settings.projectRelativePath || rawProjectPath);
  const categorySettings = readCategoryTableState();
  const trimmedServerUrl = elements.settingsServer.value.trim();
  const resolvedServerUrl = trimmedServerUrl || DEFAULT_SETTINGS_SERVER_URL;
  const serverUrlPayload =
    extensionWsEndpointKeyFromBaseUrl(resolvedServerUrl)
    !== extensionWsEndpointKeyFromBaseUrl(state.settings.serverUrl)
      ? { serverUrl: resolvedServerUrl }
      : {};
  const lowConfidenceBehaviour =
    elements.settingsLowConfidence?.value === "keepEasyeda" ? "keepEasyeda" : "openEditor";
  const payload = {
    ...serverUrlPayload,
    overwriteFootprints: elements.settingsOverwrite.checked,
    overwriteModels: elements.settingsOverwriteModel.checked,
    debugLogs: elements.settingsDebug.checked,
    projectRelative: elements.settingsProjectRelative.checked,
    projectRelativePath,
    lowConfidenceBehaviour,
    categorySettings,
  };
  state.settings.projectRelative = payload.projectRelative;
  state.settings.projectRelativePath = projectRelativePath;
  state.settings.lowConfidenceBehaviour = lowConfidenceBehaviour;
  state.settings.categorySettings = categorySettings;
  saveUiPreferences();
  sendMessage("updateSettings", payload)
    .then((snapshot) => {
      applyState(snapshot);
      setSettingsFeedback("Saved", "text-success");
    })
    .catch((error) => {
      setSettingsFeedback(error.message || "Saving failed", "text-danger");
    });
}

function toggleSettingsProjectPath() {
  if (!elements.settingsProjectRelativePathGroup || !elements.settingsProjectRelative) {
    return;
  }
  const show = elements.settingsProjectRelative.checked;
  elements.settingsProjectRelativePathGroup.hidden = !show;
}

function testServerConnection() {
  setSettingsFeedback("Checking backend…", "text-muted");
  sendMessage("updateSettings", {
    serverUrl: elements.settingsServer.value.trim() || DEFAULT_SETTINGS_SERVER_URL,
  })
    .then((status) => {
      if (status.connected) setSettingsFeedback("Backend reachable", "text-success");
      else setSettingsFeedback("Backend not reachable", "text-danger");
    });
}

function setSettingsFeedback(message, cls) {
  if (!message) return;
  let variant = "primary";
  let delay = 4000;
  if (cls === "text-danger") {
    variant = "danger";
    delay = 4500;
  } else if (cls === "text-success") {
    variant = "success";
    delay = 2200;
  } else if (cls === "text-muted") {
    variant = "secondary";
    delay = 2000;
  }
  showToast(message, variant, delay, { slot: TOAST_SLOT_SETTINGS });
}


function clearLibraryCreateValidation() {
  elements.libraryCreateName?.classList.remove("is-invalid");
  elements.libraryCreatePath?.classList.remove("is-invalid");
}

function setLibraryModalError(message) {
  if (!message) return;
  showToast(message, "danger");
}

function setLibraryModalTab(mode) {
  const targetId = mode === "create" ? "library-modal-create" : "library-modal-import";
  const tabTrigger = elements.libraryModalTabs?.querySelector(`[data-bs-target="#${targetId}"]`);
  if (tabTrigger) {
    const tab = new bootstrap.Tab(tabTrigger);
    tab.show();
  }
}

function openDirectoryPicker({ mode, onSelect, applyLabel, initialPath }) {
  if (!state.nativeHostOnline) {
    showToast("Native Host is offline — run the installer / reload.", "warning");
    return;
  }
  state.picker.mode = mode;
  state.picker.callback = onSelect;
  state.picker.selectedPath = "";
  state.picker.parentPath = "";
  state.picker.currentPath = initialPath || "";
  state.picker.selectedType = "";
  state.picker.filterExtension = mode === "import" ? ".kicad_sym" : null;
  state.picker.requireFile = mode === "import";
  state.picker.breadcrumbs = [];
  elements.pickerModalTitle.innerHTML = mode === "import" ? "Select file" : "Select folder";
  elements.pickerManual.value = initialPath || "";
  elements.pickerApply.textContent = applyLabel || "Select";

  loadRoots()
    .then((roots) => {
      state.picker.roots = roots;
      const trimmedInitial = initialPath && initialPath.trim() ? initialPath.trim() : "";
      const extension = state.picker.filterExtension ? state.picker.filterExtension.toLowerCase() : null;
      let startPath = trimmedInitial;
      if (state.picker.requireFile && extension && trimmedInitial.toLowerCase().endsWith(extension)) {
        state.picker.selectedPath = trimmedInitial;
        state.picker.selectedType = "file";
        startPath = trimmedInitial.replace(/[\\/][^\\/]*$/, "");
        elements.pickerManual.value = trimmedInitial;
      }
      if (!startPath) {
        startPath = roots[0]?.path || "";
      }
      if (startPath) {
        const shouldRetain = state.picker.requireFile && state.picker.selectedType === "file";
        return loadDirectory(startPath, { retainSelection: shouldRetain });
      }
      renderPickerList([]);
      modals.picker?.show();
      return null;
    })
    .catch((error) => {
      showToast(error.message || "Failed to load folders.", "danger");
      renderPickerList([]);
      modals.picker?.show();
    });
}

function loadRoots() {
  if (state.picker.roots.length) {
    return Promise.resolve(state.picker.roots);
  }
  return sendMessage("fs:listRoots");
}

function loadDirectory(path, options = {}) {
  const { retainSelection = false } = options;
  const previousSelection = retainSelection ? state.picker.selectedPath : "";
  const previousType = retainSelection ? state.picker.selectedType : "";
  return sendMessage("fs:listDirectory", { path })
    .then((data) => {
      state.picker.currentPath = data.path;
      state.picker.parentPath = data.parent || "";
      if (retainSelection) {
        state.picker.selectedPath = previousSelection;
        state.picker.selectedType = previousType;
      } else {
        state.picker.selectedPath = "";
        state.picker.selectedType = "";
      }
      state.picker.breadcrumbs = Array.isArray(data.breadcrumbs) ? data.breadcrumbs : [];
      elements.pickerManual.value = data.path;
      renderPickerPathBreadcrumb();
      renderPickerList(data.entries || []);
      if (retainSelection && state.picker.selectedPath) {
        if (state.picker.selectedType === "file") {
          elements.pickerManual.value = state.picker.selectedPath;
        }
        const match = Array.from(elements.pickerList.querySelectorAll("li[data-path]"))
          .find((node) => node.dataset.path === state.picker.selectedPath);
        match?.classList.add("active");
      }
      modals.picker?.show();
      return data;
    })
    .catch((error) => {
      showToast(error.message || "Failed to load path.", "danger");
      renderPickerPathBreadcrumb();
      renderPickerList([]);
      modals.picker?.show();
      return null;
    });
}

function renderPickerPathBreadcrumb() {
  if (!elements.pickerPathBreadcrumb) return;
  const wrapper = document.createElement("div");
  wrapper.className = "picker-breadcrumb-row d-flex flex-wrap align-items-center gap-2";
  const crumbs = Array.isArray(state.picker.breadcrumbs) ? state.picker.breadcrumbs : [];

  if (!crumbs.length) {
    const none = document.createElement("span");
    none.className = "small text-muted";
    none.textContent = "No path";
    wrapper.appendChild(none);
  } else {
    crumbs.forEach((crumb, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-sm btn-secondary";
      button.textContent = crumb?.name || crumb?.label || crumb?.path || "";
      if (index === crumbs.length - 1) {
        button.disabled = true;
        button.classList.add("active");
      } else if (crumb?.path) {
        button.addEventListener("click", () => loadDirectory(crumb.path));
      }
      wrapper.appendChild(button);
    });
  }

  elements.pickerPathBreadcrumb.innerHTML = "";
  elements.pickerPathBreadcrumb.appendChild(wrapper);
}

function renderPickerList(entries) {
  elements.pickerList.innerHTML = "";
  const extension = state.picker.filterExtension ? state.picker.filterExtension.toLowerCase() : null;
  const directories = entries.filter((entry) => entry.type === "dir");
  const files = extension
    ? entries.filter((entry) => entry.type !== "dir" && entry.name.toLowerCase().endsWith(extension))
    : [];

  if (!directories.length && !files.length) {
    const empty = document.createElement("li");
    empty.className = "list-group-item text-muted";
    empty.textContent = state.picker.requireFile
      ? `No ${extension || ""} files`
      : "No entries";
    elements.pickerList.appendChild(empty);
    return;
  }

  const displayEntries = [...directories, ...files];
  displayEntries.forEach((entry) => {
    const isDir = entry.type === "dir";
    const item = document.createElement("li");
    item.className = "list-group-item list-group-item-action d-flex justify-content-between align-items-center";
    item.dataset.path = entry.path;
    item.dataset.type = isDir ? "dir" : "file";
    item.tabIndex = 0;
    const icon = isDir ? "&#128193;" : "&#128196;";
    item.innerHTML = `
      <span>${escapeHtml(entry.name)}</span>
      <span aria-hidden="true">${icon}</span>
    `;
    elements.pickerList.appendChild(item);
    if (state.picker.selectedPath && state.picker.selectedPath === entry.path) {
      item.classList.add("active");
    }
  });
}

function handlePickerListClick(event) {
  const item = event.target.closest("li[data-path]");
  if (!item) return;
  selectPickerItem(item);
}

function handlePickerListDoubleClick(event) {
  const item = event.target.closest("li[data-path]");
  if (!item) return;
  if (item.dataset.type === "file") {
    selectPickerItem(item);
    applyPickerSelection();
  } else {
    loadDirectory(item.dataset.path);
  }
}

function handlePickerListKeydown(event) {
  const items = Array.from(elements.pickerList.querySelectorAll("li[data-path]"));
  if (!items.length) return;
  const currentIndex = items.findIndex((item) => item.classList.contains("active"));

  if (event.key === "ArrowDown") {
    event.preventDefault();
    const next = items[(currentIndex + 1) % items.length];
    selectPickerItem(next);
    next?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    const prev = items[(currentIndex - 1 + items.length) % items.length];
    selectPickerItem(prev);
    prev?.focus();
  } else if (event.key === "Enter" && currentIndex >= 0) {
    event.preventDefault();
    const current = items[currentIndex];
    if (current.dataset.type === "file") {
      selectPickerItem(current);
      applyPickerSelection();
    } else {
      loadDirectory(current.dataset.path);
    }
  }
}

function scheduleManualPathLoad(path, { immediate = false } = {}) {
  clearTimeout(pickerManualTimer);
  if (!path) {
    return;
  }
  const extension = state.picker.filterExtension ? state.picker.filterExtension.toLowerCase() : null;
  if (state.picker.requireFile && extension && path.toLowerCase().endsWith(extension)) {
    state.picker.selectedPath = path;
    state.picker.selectedType = "file";
    return;
  }
  state.picker.selectedPath = "";
  state.picker.selectedType = "";
  const perform = () => loadDirectory(path);
  if (immediate) {
    perform();
    return;
  }
  pickerManualTimer = setTimeout(() => {
    if (elements.pickerManual.value.trim() === path) {
      perform();
    }
  }, 400);
}

function handlePickerManualInput() {
  scheduleManualPathLoad(elements.pickerManual.value.trim());
}

function handlePickerManualChange() {
  scheduleManualPathLoad(elements.pickerManual.value.trim(), { immediate: true });
}

function handlePickerManualKeydown(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  scheduleManualPathLoad(elements.pickerManual.value.trim(), { immediate: true });
}

function selectPickerItem(item) {
  Array.from(elements.pickerList.querySelectorAll("li[data-path]")).forEach((node) => {
    node.classList.remove("active");
  });
  item.classList.add("active");
  state.picker.selectedPath = item.dataset.path;
  state.picker.selectedType = item.dataset.type || "";
  if (item.dataset.type === "file") {
    elements.pickerManual.value = item.dataset.path;
  }
}

function applyPickerSelection() {
  const selected = state.picker.selectedPath || state.picker.currentPath;
  if (!selected) {
    showToast(
      state.picker.requireFile ? "Please select a file." : "Please select a folder.",
      "warning",
    );
    return;
  }
  if (state.picker.requireFile && state.picker.selectedType !== "file") {
    showToast("Please choose a .kicad_sym file.", "warning");
    return;
  }
  state.picker.callback?.(selected);
  modals.picker?.hide();
}

function getActiveLibrary() {
  return state.libraries.find((library) => library.active);
}

function stripLibrarySuffix(path) {
  if (!path) return "";
  return path.replace(/\.(kicad_sym|lib)$/i, "");
}

function deriveLibraryName(path) {
  if (!path) return "";
  const normalized = stripLibrarySuffix(path.trim());
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return "";
  const last = parts[parts.length - 1];
  return last;
}

function getLibraryPrefix(library) {
  if (!library) return "";
  let candidate = library.path || library.resolvedPrefix || "";
  if (!candidate && library.symbolPath) {
    candidate = stripLibrarySuffix(library.symbolPath);
  }
  return stripLibrarySuffix(candidate);
}

function syncSelectedLibrary() {
  const activeLibrary = getActiveLibrary();
  if (!activeLibrary) {
    return;
  }
  const prefix = getLibraryPrefix(activeLibrary);
  if (!prefix) {
    return;
  }
  const currentPath = state.selectedLibraryPath || "";
  const currentName = state.selectedLibraryName || "";
  if (currentPath === prefix && currentName === (activeLibrary.name || "")) {
    return;
  }
  state.selectedLibraryPath = prefix;
  state.selectedLibraryName = activeLibrary.name || "";
  sendMessage("setSelectedLibrary", {
    path: prefix,
    name: activeLibrary.name || "",
  }).catch((error) => {
    console.warn("Failed to sync selected library", error);
  });
}

function debounce(fn, delay = 200) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(null, args), delay);
  };
}

function sendMessage(type, payload = {}) {
  return chrome.runtime
    .sendMessage({ type, ...payload })
    .then((response) => {
      if (!response?.ok) {
        throw new Error(response?.error || "Unknown error");
      }
      return response.data;
    });
}

const TOAST_MAX_VISIBLE = 2;
/** Replaces the previous settings-area toast so rapid saves do not stack. */
const TOAST_SLOT_SETTINGS = "settings";

/**
 * @param {string} message
 * @param {string} [variant]
 * @param {number} [delay]
 * @param {{ slot?: string }} [options] If `slot` is set, replaces any existing toast with the same slot (stops save-spam stacking).
 */
function showToast(message, variant = "primary", delay = 4000, options = {}) {
  if (!elements.toastContainer) return;
  const slot = typeof options.slot === "string" && options.slot ? options.slot : "";

  if (slot) {
    const prev = elements.toastContainer.querySelector(`[data-toast-slot="${CSS.escape(slot)}"]`);
    if (prev) {
      const ctl = prev._toastCtl;
      if (ctl && typeof ctl.hide === "function") {
        ctl.hide();
      } else if (prev.isConnected) {
        prev.remove();
      }
    }
  }

  while (elements.toastContainer.children.length >= TOAST_MAX_VISIBLE) {
    const oldest = elements.toastContainer.firstElementChild;
    if (!oldest) break;
    const ctl = oldest._toastCtl;
    if (ctl && typeof ctl.hide === "function") {
      ctl.hide();
    } else {
      oldest.remove();
    }
  }

  const toastElement = document.createElement("div");
  toastElement.className = `toast align-items-center text-bg-${variant}`;
  if (slot) {
    toastElement.dataset.toastSlot = slot;
  }
  toastElement.setAttribute("role", "status");
  const live = variant === "danger" || variant === "warning" ? "assertive" : "polite";
  toastElement.setAttribute("aria-live", live);
  toastElement.setAttribute("aria-atomic", "true");
  toastElement.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${escapeHtml(message)}</div>
      <button type="button" class="btn-close me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>
  `;
  elements.toastContainer.appendChild(toastElement);
  const toast = new bootstrap.Toast(toastElement, { delay });
  toastElement._toastCtl = toast;
  toast.show();
  toastElement.addEventListener("hidden.bs.toast", () => {
    toastElement.remove();
  });
}

function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

