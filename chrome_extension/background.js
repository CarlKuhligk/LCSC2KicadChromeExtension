"use strict";

importScripts("categoryPath.js");
importScripts("confidenceState.js");
importScripts("shared/extensionDefaults.js");
importScripts("extensionWsClient.js");
importScripts("nativeHostPort.js");

// Normalize common LCSC parameter label variations to consistent KiCad field names
const LCSC_PARAMS_MAP = {
  "Power(Watts)": "Power",
  "Rated Power": "Power",
  "Power Dissipation": "Power",
  "Rated Power (Watts)": "Power",
  "Tolerance (±)": "Tolerance",
  "Resistance Tolerance": "Tolerance",
  "Capacitance Tolerance": "Tolerance",
  "Temperature Coefficient": "Temp. Coefficient",
  "Operating Temperature": "Operating Temp.",
  "Storage Temperature": "Storage Temp.",
  "Voltage Rating - DC": "Voltage Rating",
  "Voltage - Rated": "Voltage Rating",
  "Voltage Rating DC": "Voltage Rating",
  "Rated Voltage": "Voltage Rating",
  "Voltage Rating (Max)": "Voltage Rating",
  "DC Resistance (DCR) (Max)": "DCR",
  "DC Resistance": "DCR",
  "Saturation Current (Isat)": "Sat. Current",
  "Saturation Current": "Sat. Current",
  "Self Resonant Frequency": "Self Res. Freq.",
  "Manufacturer Part Number": "MPN",
  "Mounting Type": "Mounting",
};

function mapParamKey(key) {
  return LCSC_PARAMS_MAP[key] ?? key;
}

function normalizeSymbolValue(value, valueParam) {
  if (!value || typeof value !== "string") return value;
  // Resistor values: strip the Ohm symbol — "10kΩ" → "10k", "1MΩ" → "1M"
  if (valueParam === "Resistance") {
    return value.replace(/Ω/g, "").trim();
  }
  return value;
}

/**
 * Deepest match: longest stored key K with pagePath === K or pagePath.startsWith(K + "/").
 * Keys are normalized the same way as LCSC paths (see categoryPath.js).
 */
function resolveCategorySettings(pagePathRaw, categorySettings) {
  const pagePath = normalizeCategoryPath(pagePathRaw);
  if (!pagePath || !categorySettings || typeof categorySettings !== "object") {
    return null;
  }

  const entries = Object.entries(categorySettings).filter(
    ([k, v]) => k && v && typeof v === "object",
  );

  let bestKey = null;
  let bestLen = -1;

  const bumpPrefixWinner = (storageKey, kNorm) => {
    if (!kNorm || kNorm.length <= bestLen) return;
    bestLen = kNorm.length;
    bestKey = storageKey;
  };

  for (const [keyRaw] of entries) {
    const K = normalizeCategoryPath(keyRaw);
    if (!K) continue;
    if (pagePath === K || pagePath.startsWith(`${K}/`)) {
      bumpPrefixWinner(keyRaw, K);
    }
  }

  if (bestKey != null) {
    return { key: bestKey, config: categorySettings[bestKey] };
  }

  return null;
}

const HISTORY_LIMIT = 30;

/** Hosts where the LCSC product content script runs (align with manifest `content_scripts` / `host_permissions`). */
function isLcscImporterHostUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return (
      h === "lcsc.com"
      || h.endsWith(".lcsc.com")
      || h.endsWith(".szlcsc.com")
      || h.endsWith(".lcsiglobal.com")
    );
  } catch {
    return false;
  }
}

const DEFAULT_STATE = {
  serverUrl:
    typeof globalThis.K2C_DEFAULT_SERVER_URL === "string"
      ? globalThis.K2C_DEFAULT_SERVER_URL
      : "http://localhost:8087",
  libraries: [],
  jobHistory: [],
  jobMeta: {},
  overwriteFootprints: false,
  overwriteModels: false,
  debugLogs: false,
  projectRelative: false,
  projectRelativePath: "",
  /**
   * V3 Issue #31 — 🟡 Low-Confidence Setting (ADR-0006, KONZEPT.md §3.5).
   * Controls what the Override Panel does when ``matchResult.state ===
   * "yellow"`` (Heuristik-Match ohne registrierte Rule, oder registrierte
   * Rule mit einem fehlenden MVP-Faktor):
   *   - ``"openEditor"`` (default): proactively opens the Import-Editor
   *     with the heuristic suggestion pre-filled. User edits or saves
   *     and runs Phase 2.
   *   - ``"keepEasyeda"``: surfaces a small Hinweis-Panel with an
   *     EasyEDA-default Confirm + an "Editor öffnen" escape hatch.
   */
  lowConfidenceBehaviour: "openEditor",
  libraryTotals: { symbols: 0, footprints: 0, models: 0 },
  /** V3 Issue #24: user-added picker roots (Q-PICK-1). Persisted client-side
   *  so the Native Host stays stateless; every picker RPC forwards the list
   *  as ``extraRoots`` to widen the whitelist beyond Documents + KiCad paths. */
  userAddedRoots: [],
  categorySettings: {
    // Prefix of typical LCSC resistor breadcrumbs (deepest-prefix match); adjust in popup if your tree differs.
    "Passives/Resistors": { hidePinNumbers: true, hidePinNames: true, valueParam: "Resistance" },
  },
};

let state = {
  ...DEFAULT_STATE,
  connected: false,
  /** Short message for popup when the API WebSocket is down; cleared on connect. */
  connectionHint: null,
  jobs: {},
  selectedLibraryPath: "",
  selectedLibraryName: "",
  templateLibraryPath: null,
  templateSymbols: [],
  templateSymbolsByLib: {},
  templateFootprintsByLib: {},
  templateCategoriesByLib: {},
};

let healthTimer = null;
let initialized = false;

// WebSocket transport: {@link ./extensionWsClient.js} + {@link globalThis.k2cExtensionWsHooks} (assigned in init).

let extConnectIntent = true;

/** Avoid duplicate finalize when multiple terminal pushes arrive. */
const extensionTerminalHandled = new Set();

/**
 * When false, `[KPI jobs]` logs only run if Settings → Debug logs is enabled.
 * Set to true temporarily for deep job/WebSocket tracing without opening the popup.
 */
const KPI_JOB_TRACE = false;

/** Conversion / WebSocket trace (service worker console). Filter: `[KPI jobs]` */
function kpiJobLog(...args) {
  if (!KPI_JOB_TRACE && !state.debugLogs) {
    return;
  }
  console.log("[KPI jobs]", ...args);
}

/** Verbose RPC/payload logging when Settings → Debug logs is on. */
function kpiJobVerbose(...args) {
  if (state.debugLogs) {
    console.log("[KPI jobs verbose]", ...args);
  }
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

/**
 * V3 Issue #31 — clamp the persisted ``lowConfidenceBehaviour`` to the two
 * supported enum values so a stale ``chrome.storage`` value (or a typo from
 * a future hand-edited settings.json) cannot put the panel into an unknown
 * branch. Anything outside the enum falls back to ``"openEditor"`` (the
 * Default specified in ADR-0006 §3.5 / KONZEPT.md §21).
 */
function normalizeLowConfidenceBehaviour(value) {
  return value === "keepEasyeda" ? "keepEasyeda" : "openEditor";
}

function normalizeProjectRelativePath(value) {
  if (value == null) {
    return "";
  }
  let path = String(value).trim();
  if (!path) {
    return "";
  }
  if (path.startsWith("${KIPRJMOD}")) {
    path = path.slice("${KIPRJMOD}".length);
  }
  path = path.replace(/\\/g, "/");
  return path;
}

function sanitizeLibraryName(name) {
  if (!name) {
    return "";
  }
  return name.trim().replace(/[\\/:*?"<>|]/g, "_");
}

function normalizePath(path) {
  if (!path) {
    return "";
  }
  return path.trim().replace(/[\\\/]+$/, "");
}

/** Compare library paths across Windows/URL-style separators (not case-folded — avoids Unix edge cases). */
function normalizePathKey(path) {
  if (!path || typeof path !== "string") {
    return "";
  }
  return path.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/");
}

function isBackendOfflineError(error) {
  const message = (error && error.message) ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  return normalized.includes("backend not reachable")
    || normalized.includes("failed to fetch")
    || normalized.includes("networkerror");
}

function stripLibrarySuffix(path) {
  if (!path) {
    return "";
  }
  return path.replace(/\.(kicad_sym|lib)$/i, "");
}

function deriveLibraryPrefix(library) {
  if (!library) {
    return "";
  }
  const candidate = library.path || library.resolvedPrefix || "";
  if (candidate) {
    return normalizePath(stripLibrarySuffix(candidate));
  }
  if (library.symbolPath) {
    return normalizePath(stripLibrarySuffix(library.symbolPath));
  }
  return "";
}

function getSelectedLibraryRecord() {
  const selected = normalizePath(state.selectedLibraryPath || "");
  if (selected) {
    const match = state.libraries.find((library) => {
      const prefix = normalizePath(library.path || library.resolvedPrefix || "");
      return prefix && prefix === selected;
    });
    if (match) {
      return match;
    }
  }
  return state.libraries.find((library) => library.active) || null;
}

async function ensureSelectedLibrary(force = false) {
  const previousPath = state.selectedLibraryPath || "";
  const previousName = state.selectedLibraryName || "";

  let nextPath = "";
  let nextName = "";

  if (Array.isArray(state.libraries) && state.libraries.length) {
    const active = state.libraries.find((library) => library.active && !library.missing)
      || state.libraries.find((library) => !library.missing)
      || state.libraries[0];
    if (active) {
      nextPath = deriveLibraryPrefix(active);
      nextName = sanitizeLibraryName(active.name) || deriveLibraryNameFromPath(nextPath) || "";
    }
  }

  if (!force && previousPath === nextPath && previousName === nextName) {
    return;
  }

  state.selectedLibraryPath = nextPath;
  state.selectedLibraryName = nextName;
  await persistState(["selectedLibraryPath", "selectedLibraryName"]);
}

function recalcLibraryTotals() {
  const totals = { symbols: 0, footprints: 0, models: 0 };
  (state.libraries || []).forEach((library) => {
    totals.symbols += Number(library?.counts?.symbol) || 0;
    totals.footprints += Number(library?.counts?.footprint) || 0;
    totals.models += Number(library?.counts?.model) || 0;
  });
  state.libraryTotals = totals;
  return totals;
}

function buildLibraryStatus(library, validation) {
  if (!validation) {
    return library;
  }

  const exists = Boolean(validation.exists);
  const modelPath = typeof validation.model_path === "string" && validation.model_path.trim()
    ? validation.model_path.trim()
    : (library.modelPath || "");
  const counts = exists
    ? {
        symbol: Number(validation.counts?.symbol) || (validation.assets?.symbol ? 1 : 0),
        footprint: Number(validation.counts?.footprint) || 0,
        model: Number(validation.counts?.model) || 0,
      }
    : { symbol: 0, footprint: 0, model: 0 };
  const assets = exists
    ? {
        symbol: Boolean(validation.assets?.symbol),
        footprint: Boolean(validation.assets?.footprint),
        model: Boolean(validation.assets?.model),
      }
    : { symbol: false, footprint: false, model: false };
  const warnings = Array.isArray(validation.warnings) ? validation.warnings.slice() : [];
  if (!exists) {
    warnings.push("Library path missing on disk.");
  }

  return {
    ...library,
    symbolPath: normalizePath(validation.resolved_path || library.symbolPath || ""),
    assets,
    counts,
    warnings,
    missing: !exists,
    modelPath,
    active: exists ? library.active : false,
    updatedAt: new Date().toISOString(),
    lastValidation: new Date().toISOString(),
  };
}

function hasModelOutput(result) {
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

/** Some serializers use PascalCase; normalize onto `result` for the rest of the extension. */
function normalizeWsTaskRow(row) {
  if (!row || typeof row !== "object") {
    return row;
  }
  if (row.result == null && row.Result != null) {
    row.result = row.Result;
  }
  return row;
}

/** Normalize API/WS result shape (snake_case, camelCase, or JSON string). */
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

function analyzeJobOutputs(job = {}) {
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
    model: hasModelOutput(result),
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

  const partial = requestedAny && missing.length > 0;
  const complete = requestedAny ? missing.length === 0 : true;

  return {
    requested,
    actual,
    missing,
    partial,
    complete,
    requestedAny,
  };
}

function buildComponentStatus({ lcscId, check, libraryPrefix, selectedLibrary }) {
  const normalized = check && typeof check === "object" ? check : {};
  const result = {
    symbol_path: normalized.symbol_path || null,
    footprint_path: normalized.footprint_path || null,
    model_paths: normalized.model_paths || {},
  };
  const outputs = { symbol: true, footprint: true, model: true };
  const analysis = analyzeJobOutputs({ outputs, result });
  const completed = Boolean(result.symbol_path);
  return {
    inProgress: false,
    jobId: null,
    status: completed ? "completed" : null,
    libraryName: selectedLibrary?.name || null,
    libraryPath: libraryPrefix,
    completed,
    outputAnalysis: analysis,
    partial: Boolean(analysis && analysis.partial),
    missing: analysis?.missing || [],
    outputs,
    result,
    messages: normalized.messages || [],
  };
}

function buildLibraryPrefix(basePath, libraryName) {
  const normalizedBase = normalizePath(basePath);
  let sanitizedName = sanitizeLibraryName(libraryName);
  if (!sanitizedName) {
    sanitizedName = "easyeda2kicad";
  }
  if (!normalizedBase) {
    return sanitizedName;
  }
  const separator = normalizedBase.includes("\\") && !normalizedBase.includes("/")
    ? "\\"
    : "/";
  const cleanedName = sanitizedName.replace(/^[\\\/]+/, "");
  return `${normalizedBase}${separator}${cleanedName}`;
}

function deriveLibraryNameFromPath(path) {
  if (!path) {
    return "";
  }
  const normalized = stripLibrarySuffix(normalizePath(path));
  if (!normalized) {
    return "";
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (!parts.length) {
    return sanitizeLibraryName(normalized);
  }
  let last = parts[parts.length - 1];
  last = last.replace(/\.(kicad_sym|lib)$/i, "");
  return sanitizeLibraryName(last) || "";
}

function createLibraryId() {
  return `lib_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeLibraryRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const now = new Date().toISOString();
  const existingPath = normalizePath(raw.path || raw.libraryPath || "");
  const prefixPath = stripLibrarySuffix(existingPath);
  const basePath = normalizePath(raw.basePath || raw.libraryBasePath || "");
  const name = sanitizeLibraryName(
    raw.name || raw.libraryName || deriveLibraryNameFromPath(existingPath)
  );
  const resolvedPrefix = normalizePath(stripLibrarySuffix(raw.resolvedPrefix || existingPath));
  const symbolPath = normalizePath(
    raw.symbolPath || raw.symbol_path || (prefixPath ? `${prefixPath}.kicad_sym` : existingPath)
  );
  const counts = {
    symbol: Number(raw?.counts?.symbol) || 0,
    footprint: Number(raw?.counts?.footprint) || 0,
    model: Number(raw?.counts?.model) || 0,
  };
  // Project-relative 3D paths are a global import setting (Settings), not per-library metadata.
  const projectRelative = false;
  const projectRelativePath = "";
  const modelPath = typeof raw.modelPath === "string"
    ? raw.modelPath.trim()
    : (typeof raw.model_path === "string" ? raw.model_path.trim() : "");
  return {
    id: raw.id || createLibraryId(),
    name,
    path: prefixPath,
    basePath,
    resolvedPrefix,
    symbolPath,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now,
    active: raw.active !== false,
    assets: {
      symbol: Boolean(raw.assets && raw.assets.symbol),
      footprint: Boolean(raw.assets && raw.assets.footprint),
      model: Boolean(raw.assets && raw.assets.model),
    },
    counts,
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    projectId: raw.projectId || "default",
    projectRelative,
    projectRelativePath,
    modelPath,
    missing: Boolean(raw.missing),
    lastValidation: raw.lastValidation || null,
    // Auto-detect template: explicit stored value wins; new records with "template" in name default to true
    isTemplateLibrary: raw.isTemplateLibrary !== undefined
      ? Boolean(raw.isTemplateLibrary)
      : /template/i.test(name || ""),
  };
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

async function init() {
  if (initialized) {
    return;
  }
  initialized = true;

  try {
    const stored = await storageGet(Object.keys(DEFAULT_STATE));
    const storedLibraries = Array.isArray(stored.libraries)
      ? stored.libraries
          .map(normalizeLibraryRecord)
          .filter((item) => item && item.name)
      : [];
    state = {
      ...state,
      ...stored,
      libraries: storedLibraries,
      jobHistory: stored.jobHistory || [],
      jobMeta: stored.jobMeta || {},
      selectedLibraryPath: stored.selectedLibraryPath || "",
      selectedLibraryName: stored.selectedLibraryName || "",
      overwriteFootprints: normalizeBoolean(stored.overwriteFootprints),
      overwriteModels: normalizeBoolean(stored.overwriteModels),
      debugLogs: normalizeBoolean(stored.debugLogs),
      projectRelative: normalizeBoolean(stored.projectRelative),
      projectRelativePath: normalizeProjectRelativePath(stored.projectRelativePath),
      lowConfidenceBehaviour: normalizeLowConfidenceBehaviour(stored.lowConfidenceBehaviour),
      libraryTotals: stored.libraryTotals || { symbols: 0, footprints: 0, models: 0 },
      categorySettings:
        stored.categorySettings && typeof stored.categorySettings === "object"
          ? dedupeCategorySettings({
              ...DEFAULT_STATE.categorySettings,
              ...stored.categorySettings,
            })
          : { ...DEFAULT_STATE.categorySettings },
    };
    recalcLibraryTotals();
    await ensureSelectedLibrary(true);
  } catch (error) {
    console.warn("Failed to load stored state", error);
  }

  extConnectIntent = true;
  globalThis.k2cExtensionWsHooks = {
    extConnectIntent: () => extConnectIntent,
    getServerUrl: () => state.serverUrl || DEFAULT_STATE.serverUrl,
    getDebugLogs: () => state.debugLogs,
    kpiJobLog,
    kpiJobVerbose,
    inventoryLibraries,
    refreshTemplateStatus,
    syncExistingTasks,
    broadcastState,
    updateBadge,
    handleExtensionTaskPush,
    setConnected: (v) => {
      state.connected = v;
    },
    setConnectionHint: (h) => {
      state.connectionHint = h;
    },
  };
  connectExtensionSocket();
  startHealthMonitor();
  broadcastState();
}

async function ensureInitialized() {
  if (!initialized) {
    await init();
  }
}

function buildUrl(path) {
  const base = state.serverUrl || DEFAULT_STATE.serverUrl;
  const normalized = base.endsWith("/") ? base : `${base}/`;
  const cleanedPath = path.startsWith("/") ? path.slice(1) : path;
  return new URL(cleanedPath, normalized).toString();
}

function extensionWsUrl() {
  const base = state.serverUrl || DEFAULT_STATE.serverUrl;
  return globalThis.k2cExtensionWsUrlFromBase(base);
}

/** Same key ⇒ same extension WS endpoint — used to avoid reconnect when only other settings changed. */
function extensionSocketEndpointKey(baseUrl) {
  return globalThis.k2cExtensionSocketEndpointKey(
    typeof baseUrl === "string" && baseUrl.trim()
      ? baseUrl.trim()
      : DEFAULT_STATE.serverUrl,
  );
}

/** JSON-RPC WebSocket client from {@link ./extensionWsClient.js} (always load before this script). */
function extensionWsApi() {
  return globalThis.k2cExtensionWs;
}

function extensionWsIsOpen() {
  return Boolean(extensionWsApi()?.isOpen?.());
}

function closeExtensionSocket() {
  extensionWsApi()?.closeExtensionSocket?.();
}

function scheduleExtensionReconnect() {
  extensionWsApi()?.scheduleExtensionReconnect?.();
}

/** Schedule reconnect only if idle (not already connecting and no timer). Avoids piling new sockets on the 3s health tick. */
function scheduleExtensionReconnectIfIdle() {
  extensionWsApi()?.scheduleExtensionReconnectIfIdle?.();
}

function connectExtensionSocket() {
  extensionWsApi()?.connectExtensionSocket?.();
}

function sendExtensionRpc(method, params, timeoutMs = 45000) {
  const api = extensionWsApi();
  if (!api || typeof api.sendExtensionRpc !== "function") {
    return Promise.reject(new Error("Backend transport not ready."));
  }
  return api.sendExtensionRpc(method, params, timeoutMs);
}

async function scaffoldLibraryOnServer(payload) {
  return sendExtensionRpc("libraries_scaffold", payload, 120000);
}

async function validateLibraryOnServer(path) {
  return sendExtensionRpc("libraries_validate", { path }, 60000);
}

async function checkComponentOnServer(path, lcscId) {
  return sendExtensionRpc(
    "libraries_component",
    { path, lcsc_id: lcscId },
    60000,
  );
}

async function refreshLibraryCountsForPrefix(prefix) {
  const normalizedPrefix = stripLibrarySuffix(normalizePath(prefix || ""));
  if (!normalizedPrefix) {
    return;
  }

  const index = state.libraries.findIndex((library) => {
    const candidate = stripLibrarySuffix(
      normalizePath(library.path || library.resolvedPrefix || ""),
    );
    return candidate === normalizedPrefix;
  });

  if (index === -1) {
    return;
  }

  const library = state.libraries[index];
  const symbolPath = library.symbolPath || `${normalizedPrefix}.kicad_sym`;
  if (!symbolPath) {
    return;
  }

  try {
    const validation = await validateLibraryOnServer(symbolPath);
    if (!validation) {
      return;
    }

    state.libraries[index] = buildLibraryStatus(library, validation);

    recalcLibraryTotals();
    await ensureSelectedLibrary();
    await persistState(["libraries", "libraryTotals"]);
  } catch (error) {
    console.warn(`Failed to refresh inventory for ${prefix}`, error);
  }
}

async function inventoryLibraries() {
  if (!state.libraries.length) {
    recalcLibraryTotals();
    return;
  }

  const entries = await Promise.allSettled(
    state.libraries.map((library) => {
      const symbolPath = library.symbolPath || (library.path ? `${library.path}.kicad_sym` : "");
      if (!symbolPath) {
        return Promise.resolve({ library, validation: null });
      }
      return validateLibraryOnServer(symbolPath)
        .then((validation) => ({ library, validation }))
        .catch(() => ({ library, validation: null }));
    })
  );

  const results = new Map();
  entries.forEach((entry) => {
    if (entry.status === "fulfilled" && entry.value?.library) {
      results.set(entry.value.library.id, entry.value.validation);
    }
  });

  state.libraries = state.libraries.map((library) => {
    const validation = results.get(library.id);
    if (!validation) {
      return library;
    }
    return buildLibraryStatus(library, validation);
  });

  recalcLibraryTotals();
  await ensureSelectedLibrary();
  await persistState(["libraries", "libraryTotals"]);
}

function upsertLibraryRecord(record) {
  const normalized = normalizeLibraryRecord(record);
  if (!normalized) {
    throw new Error("Invalid library entry.");
  }
  const index = state.libraries.findIndex((item) => item.id === normalized.id || item.path === normalized.path);
  if (index >= 0) {
    state.libraries[index] = {
      ...state.libraries[index],
      ...normalized,
      symbolPath: normalized.symbolPath || state.libraries[index].symbolPath,
      assets: {
        ...state.libraries[index].assets,
        ...normalized.assets,
      },
      counts: {
        ...state.libraries[index].counts,
        ...normalized.counts,
      },
      warnings: normalized.warnings,
      updatedAt: normalized.updatedAt,
    };
  } else {
    state.libraries.push(normalized);
  }
  recalcLibraryTotals();
  return normalized;
}

function getTemplateLibraryPath() {
  const lib = state.libraries.find((l) => l.isTemplateLibrary);
  return lib ? (lib.symbolPath || lib.path || null) : null;
}

function getTemplateLibraryPaths() {
  return state.libraries
    .filter((l) => l.isTemplateLibrary)
    .map((l) => l.symbolPath || l.path || null)
    .filter(Boolean);
}

/**
 * V3: list a Template Library's symbols + footprints via the Native Host's
 * `listTemplates` RPC. Replaces the V2 WebSocket-backed `templates_symbols`
 * call so the Override Panel (Issue #5) works without the legacy backend.
 * Returns `{ symbols, footprints }` (empty lists on any failure — V3 panel
 * degrades gracefully to "keep EasyEDA"-only).
 *
 * Issue #26: routed over the **Warm-Port** so Override Panel reads do not
 * pay the Python cold-start cost and overlap an in-flight `convert`.
 */
async function nativeHostListTemplates(libPath) {
  let envelope;
  try {
    envelope = await getWarmNativePort().send(
      "listTemplates",
      { libPath },
      { timeoutMs: 5000 },
    );
  } catch (e) {
    return { symbols: [], footprints: [], error: e?.message || String(e) };
  }
  if (envelope && envelope.ok === true && envelope.result && typeof envelope.result === "object") {
    return {
      symbols: Array.isArray(envelope.result.symbols) ? envelope.result.symbols : [],
      footprints: Array.isArray(envelope.result.footprints) ? envelope.result.footprints : [],
    };
  }
  return { symbols: [], footprints: [], error: envelope?.error || "no result" };
}

/**
 * V3 Issue #31 — drive the Native Host's ``templatePinCheck`` verb so the
 * content-script can feed cached ``{libPath: {name: count}}`` entries into
 * ``autoTemplateMatch``'s symbol scorer. Same Warm-Port routing as
 * ``nativeHostListTemplates``; long timeout because the resolver may need
 * a cold EasyEDA-API fetch on its first call for an LCSC id.
 */
async function nativeHostTemplatePinCheck(payload) {
  let envelope;
  try {
    envelope = await getWarmNativePort().send(
      "templatePinCheck",
      {
        lcscId: payload?.lcscId,
        templateName: payload?.templateName,
        templateLibPath: payload?.templateLibPath,
      },
      { timeoutMs: 15000 },
    );
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
  if (envelope && envelope.ok === true && envelope.result && typeof envelope.result === "object") {
    return { ok: true, result: envelope.result };
  }
  return { ok: false, error: envelope?.error || "no result" };
}

/**
 * V3 UI Etappe B — render a Template-Library symbol as an inline SVG via the
 * Native Host's ``templateSymbolPreview`` verb (the symbol-side analogue of the
 * footprint preview). Same Warm-Port routing as the other read-only Override
 * Panel verbs. Resolves ``{ ok, result | error }``; ``result`` is
 * ``{ svg, meta }`` or ``{ svg: null, error }`` for a soft (unrenderable) miss.
 */
async function nativeHostTemplateSymbolPreview(payload) {
  let envelope;
  try {
    envelope = await getWarmNativePort().send(
      "templateSymbolPreview",
      {
        templateLibPath: payload?.templateLibPath,
        templateName: payload?.templateName,
        theme: payload?.theme,
        labelPins: payload?.labelPins,
        drawPinNames: payload?.drawPinNames,
      },
      { timeoutMs: 8000 },
    );
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
  if (envelope && envelope.ok === true && envelope.result && typeof envelope.result === "object") {
    return { ok: true, result: envelope.result };
  }
  return { ok: false, error: envelope?.error || "no result" };
}

/**
 * V3 UI Etappe B — render an LCSC part's EasyEDA footprint as SVG via the
 * Native Host's ``lcscFootprintPreview`` verb (replaces the V2 WebSocket
 * ``lcsc_footprint_preview``). Network-bound (EasyEDA fetch), so a longer
 * timeout than the symbol preview. Resolves ``{ ok, result | error }`` where
 * ``result`` is ``{ svg, name, pads }`` or a soft ``{ svg: null, error }``.
 */
async function nativeHostLcscFootprintPreview(lcscId) {
  let envelope;
  try {
    envelope = await getWarmNativePort().send(
      "lcscFootprintPreview",
      { lcscId },
      { timeoutMs: 30000 },
    );
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
  if (envelope && envelope.ok === true && envelope.result && typeof envelope.result === "object") {
    return { ok: true, result: envelope.result };
  }
  return { ok: false, error: envelope?.error || "no result" };
}

/**
 * V3 Issue #24 — generic Native-Host RPC bridge for the FS picker verbs
 * (`fsRoots`, `fsList`, `fsCheck`, `validateLibrary`). Mirrors the
 * connect-postMessage-await-disconnect pattern in `nativeHostListTemplates`
 * but stays generic so the four picker calls share one timeout/error path.
 * Resolves `{ ok, result | error }` exactly like the Native Host responds.
 *
 * @param {string} verb
 * @param {object} params
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<{ok: true, result: any} | {ok: false, error: string}>}
 */
async function nativeHostFsRpc(verb, params, timeoutMs = 10000) {
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (e) {
    return { ok: false, error: e?.message || "connectNative threw" };
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch (_e) { /* already gone */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    port.onMessage.addListener((msg) => {
      clearTimeout(timer);
      if (msg && msg.ok === true) {
        finish({ ok: true, result: msg.result });
      } else {
        finish({ ok: false, error: (msg && msg.error) || "no result" });
      }
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      finish({ ok: false, error: err?.message || "disconnected" });
    });
    try {
      port.postMessage({ id: Date.now(), verb, params: params || {} });
    } catch (e) {
      finish({ ok: false, error: e?.message || "postMessage threw" });
    }
  });
}

/**
 * Persisted user-added picker roots (Q-PICK-1). The extension owns the list
 * so the Native Host stays stateless; every picker call forwards the array
 * as `extraRoots` and the host enforces the whitelist against
 * `defaults + extraRoots`.
 */
function getUserAddedRoots() {
  return Array.isArray(state.userAddedRoots) ? state.userAddedRoots : [];
}

/** Picker root list. */
async function nativeHostFsRoots() {
  const response = await nativeHostFsRpc("fsRoots", { extraRoots: getUserAddedRoots() }, 10000);
  if (!response.ok) {
    throw new Error(response.error || "Failed to list roots.");
  }
  return response.result;
}

/** Directory listing — folders + ``.kicad_sym`` files (MVP flat picker). */
async function nativeHostFsList(path) {
  const response = await nativeHostFsRpc(
    "fsList",
    { path, extraRoots: getUserAddedRoots() },
    10000,
  );
  if (!response.ok) {
    throw new Error(response.error || "Failed to list directory.");
  }
  return response.result;
}

/** Existence + writability snapshot for an arbitrary picker path. */
async function nativeHostFsCheck(path) {
  const response = await nativeHostFsRpc(
    "fsCheck",
    { path, extraRoots: getUserAddedRoots() },
    10000,
  );
  if (!response.ok) {
    throw new Error(response.error || "Failed to check path.");
  }
  return response.result;
}

/** Library prefix validation (parent must be inside the whitelist). */
async function nativeHostValidateLibrary(path) {
  const response = await nativeHostFsRpc(
    "validateLibrary",
    { path, extraRoots: getUserAddedRoots() },
    10000,
  );
  if (!response.ok) {
    throw new Error(response.error || "Failed to validate library.");
  }
  return response.result;
}

/**
 * Opt-in whitespace cleanup (Native Host ``cleanLibrary``): trims leading/
 * trailing spaces in symbol property keys/values (KiCad warns on those),
 * backing the file up to ``<file>.kicad_sym.bak`` first. Idempotent.
 *
 * @returns {Promise<{symbolPath, changed, symbols, backup}>}
 */
async function nativeHostCleanLibrary(path) {
  const response = await nativeHostFsRpc(
    "cleanLibrary",
    { path, extraRoots: getUserAddedRoots() },
    30000,
  );
  if (!response.ok) {
    throw new Error(response.error || "Failed to clean library.");
  }
  return response.result;
}

/**
 * V3 **Create Library** (Native Host ``scaffoldLibrary``). Writes an empty
 * ``<base>/<name>.kicad_sym`` + ``.pretty``/``.3dshapes`` siblings inside an
 * allowed root. Replaces the V2 WebSocket ``libraries_scaffold`` path.
 *
 * @returns {Promise<{resolvedLibraryPrefix, symbolPath, footprintDir, modelDir, exists}>}
 */
async function nativeHostScaffoldLibrary(payload) {
  const response = await nativeHostFsRpc(
    "scaffoldLibrary",
    {
      basePath: payload.basePath,
      name: payload.name,
      symbol: payload.symbol,
      footprint: payload.footprint,
      model: payload.model,
      extraRoots: getUserAddedRoots(),
    },
    30000,
  );
  if (!response.ok) {
    throw new Error(response.error || "Failed to create library.");
  }
  return response.result;
}

async function refreshTemplateStatus() {
  const libPaths = getTemplateLibraryPaths();
  state.templateLibraryPath = libPaths.length ? libPaths[0] : null;
  state.templateSymbols = [];
  state.templateSymbolsByLib = {};
  state.templateFootprintsByLib = {};
  state.templateCategoriesByLib = {};
  if (!libPaths.length) {
    broadcastState();
    return;
  }
  const allNames = new Set();
  for (const libPath of libPaths) {
    const { symbols, footprints, symbolCategories } =
      await nativeHostListTemplates(libPath);
    state.templateSymbolsByLib[libPath] = symbols;
    state.templateFootprintsByLib[libPath] = footprints;
    // Category-Property index (self-describing templates): {name: category}
    // for the subset of symbols that declare a Category. Drives the
    // category-based auto-match in confidenceState.
    state.templateCategoriesByLib[libPath] =
      symbolCategories && typeof symbolCategories === "object"
        ? symbolCategories
        : {};
    symbols.forEach((name) => allNames.add(name));
  }
  state.templateSymbols = Array.from(allNames).sort();
  broadcastState();
}

async function checkHealth() {
  try {
    if (!extensionWsIsOpen()) {
      connectExtensionSocket();
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const tick = () => {
          if (extensionWsIsOpen()) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            reject(new Error("WebSocket connect timeout"));
            return;
          }
          setTimeout(tick, 80);
        };
        tick();
      });
    }
    await sendExtensionRpc("health", {}, 5000);
    state.connected = true;
    try {
      await inventoryLibraries();
    } catch (error) {
      console.warn("Library inventory failed during health check", error);
    }
    try {
      await refreshTemplateStatus();
    } catch (error) {
      if (state.debugLogs) {
        console.warn("Template status refresh failed during health check", error);
      }
    }
  } catch (error) {
    state.connected = false;
  }
  updateBadge();
  broadcastState();
  return state.connected;
}

function updateBadge() {
  const text = state.connected ? "ON" : "OFF";
  const color = state.connected ? "#1b873f" : "#c0392b";
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

function startHealthMonitor() {
  if (healthTimer) {
    clearInterval(healthTimer);
  }
  healthTimer = setInterval(() => {
    (async () => {
      try {
        if (extensionWsIsOpen()) {
          await sendExtensionRpc("ping", {}, 5000);
          if (!state.connected) {
            state.connected = true;
            updateBadge();
            broadcastState();
          }
        } else {
          state.connected = false;
          updateBadge();
          broadcastState();
          scheduleExtensionReconnectIfIdle();
        }
      } catch {
        state.connected = false;
        updateBadge();
        broadcastState();
        scheduleExtensionReconnectIfIdle();
      }
    })();
  }, globalThis.K2C_HEALTH_INTERVAL_MS || 3000);
}

async function syncExistingTasks() {
  if (!extensionWsIsOpen()) {
    kpiJobVerbose("syncExistingTasks: skip (socket not open)");
    return;
  }
  try {
    const tasks = await sendExtensionRpc("list_tasks", {}, 30000);
    if (!Array.isArray(tasks)) {
      kpiJobLog("syncExistingTasks: list_tasks not an array", typeof tasks);
      return;
    }
    const preservedBefore = { ...state.jobs };
    const active = {};

    for (const task of tasks) {
      const meta = state.jobMeta[task.id] || {};
      const merged = { ...meta, ...task };
      if (task.status === "completed" || task.status === "failed") {
        addHistoryEntry({ ...merged, log: task.log || [] });
      } else {
        try {
          await sendExtensionRpc("subscribe_task", { task_id: task.id }, 15000);
        } catch (e) {
          console.warn("subscribe_task failed", task.id, e);
        }
        active[task.id] = merged;
      }
    }

    const dropped = Object.keys(preservedBefore).filter((id) => !active[id]);
    if (dropped.length) {
      kpiJobLog("syncExistingTasks: replacing jobs; dropped ids (were in UI, not in list_tasks)", dropped);
    }
    kpiJobVerbose("syncExistingTasks: active job ids", Object.keys(active), "count=", tasks.length);

    state.jobs = active;
    broadcastState();
  } catch (error) {
    console.warn("syncExistingTasks failed", error);
    kpiJobLog("syncExistingTasks failed (detail)", error?.message || error);
  }
}

function conversionResultLooksEmpty(coerced) {
  if (!coerced || typeof coerced !== "object") {
    return true;
  }
  return (
    !coerced.symbol_path
    && !coerced.footprint_path
    && !hasModelOutput(coerced)
  );
}

async function finalizeTerminalJob(id, merged, log) {
  if (extensionTerminalHandled.has(id)) {
    kpiJobVerbose("finalizeTerminalJob skip (duplicate push)", id);
    return;
  }
  extensionTerminalHandled.add(id);
  kpiJobLog("job finalized", id, merged.status);
  setTimeout(() => extensionTerminalHandled.delete(id), 300000);
  normalizeWsTaskRow(merged);
  let coercedResult = coerceConversionResult(
    merged.result != null ? merged.result : merged.Result,
  );
  if (
    merged.status === "completed"
    && conversionResultLooksEmpty(coercedResult)
    && extensionWsIsOpen()
  ) {
    try {
      const detail = await sendExtensionRpc("get_task_detail", { task_id: id }, 30000);
      normalizeWsTaskRow(detail);
      const fromDetail = coerceConversionResult(detail?.result ?? detail?.Result);
      if (fromDetail && !conversionResultLooksEmpty(fromDetail)) {
        coercedResult = fromDetail;
        merged.result = fromDetail;
      }
    } catch (e) {
      kpiJobVerbose("get_task_detail fallback after empty result", e);
    }
  }
  const terminalJob = {
    ...merged,
    result: coercedResult,
    log: log || [],
    outputAnalysis: analyzeJobOutputs({
      ...merged,
      result: coercedResult,
    }),
  };
  let terminalPlain = terminalJob;
  try {
    terminalPlain = JSON.parse(JSON.stringify(terminalJob));
  } catch (_) {
    /* keep reference if log/result is not serializable */
  }
  delete state.jobs[id];
  addHistoryEntry(terminalPlain);
  if (state.jobMeta[id]) {
    delete state.jobMeta[id];
    await persistState(["jobMeta"]);
  }
  broadcastToLcscContentTabs({
    type: "jobTerminal",
    jobId: id,
    job: terminalPlain,
  });
  if (merged.status === "completed") {
    const targetPrefix = merged.libraryPath
      || merged.libraryPrefix
      || stripLibrarySuffix(normalizePath(coercedResult?.symbol_path || ""));
    if (targetPrefix) {
      try {
        await refreshLibraryCountsForPrefix(targetPrefix);
      } catch (error) {
        console.warn("Failed to update library inventory", error);
      }
    }
  }
  broadcastState();
}

async function handleExtensionTaskPush(taskId, payload) {
  const meta = state.jobMeta[taskId] || {};
  /* meta first so server payload wins (avoids jobMeta accidentally shadowing result/status). */
  const merged = normalizeWsTaskRow({ ...meta, ...payload });
  if (merged.progress != null) {
    const np = Number(merged.progress);
    if (Number.isFinite(np)) merged.progress = np;
  }
  const st = String(payload.status || "").toLowerCase();
  kpiJobLog("task_update", {
    taskId,
    status: payload.status,
    progress: payload.progress,
    message: payload.message,
    queue_position: payload.queue_position,
    hasMeta: Boolean(meta.lcscId),
  });
  if (st === "completed" || st === "failed") {
    await finalizeTerminalJob(taskId, merged, payload.log || []);
    return;
  }
  const prev = state.jobs[taskId];
  const dSt = st;
  const pSt = prev ? String(prev.status || "").toLowerCase() : "";
  if (prev && pSt === "running" && dSt === "queued") {
    kpiJobLog("task_update ignored (would downgrade running→queued)", taskId);
    broadcastState();
    return;
  }
  state.jobs[taskId] = merged;
  broadcastState();
}

function addHistoryEntry(entry) {
  const clone = JSON.parse(JSON.stringify(entry));
  const filtered = state.jobHistory.filter((item) => item.id !== clone.id);
  state.jobHistory = [clone, ...filtered].slice(0, HISTORY_LIMIT);
  persistState(["jobHistory"]);
}

/** True when a non-template, non-missing library is selected as the EasyEDA import destination. */
function computeImportDestinationReady() {
  const selected = normalizePathKey(state.selectedLibraryPath || "");
  if (!selected) return false;
  const libs = Array.isArray(state.libraries) ? state.libraries : [];
  return libs.some((l) => {
    if (!l || l.isTemplateLibrary || l.missing) return false;
    const prefix = normalizePathKey(deriveLibraryPrefix(l));
    return Boolean(prefix && prefix === selected);
  });
}

function snapshotState() {
  const jobsArray = Object.values(state.jobs || {}).map((job) => ({ ...job }));
  const historyArray = (state.jobHistory || []).map((item) => ({ ...item }));
  return {
    connected: state.connected,
    connectionHint: state.connectionHint || null,
    serverUrl: state.serverUrl,
    libraries: state.libraries.map((library) => ({ ...library })),
    libraryTotals: { ...state.libraryTotals },
    selectedLibraryPath: state.selectedLibraryPath,
    selectedLibraryName: state.selectedLibraryName,
    importDestReady: computeImportDestinationReady(),
    overwriteFootprints: state.overwriteFootprints,
    overwriteModels: state.overwriteModels,
    debugLogs: state.debugLogs,
    projectRelative: state.projectRelative,
    projectRelativePath: state.projectRelativePath,
    lowConfidenceBehaviour: state.lowConfidenceBehaviour,
    categorySettings: { ...state.categorySettings },
    templateSymbols: (state.templateSymbols || []).slice(),
    templateSymbolsByLib: state.templateSymbolsByLib ? { ...state.templateSymbolsByLib } : {},
    templateFootprintsByLib: state.templateFootprintsByLib ? { ...state.templateFootprintsByLib } : {},
    templateCategoriesByLib: state.templateCategoriesByLib ? { ...state.templateCategoriesByLib } : {},
    templateLibraryPath: state.templateLibraryPath || null,
    jobs: jobsArray,
    jobHistory: historyArray,
  };
}

/**
 * Content scripts do not receive chrome.runtime.sendMessage from the service worker.
 * Use tabs.sendMessage on LCSC tabs (host_permissions allow reading matching tab URLs).
 */
function broadcastToLcscContentTabs(message) {
  try {
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime.lastError || !tabs?.length) {
        return;
      }
      for (const tab of tabs) {
        const tid = tab.id;
        const u = tab.url || tab.pendingUrl || "";
        if (tid == null) {
          continue;
        }
        if (!isLcscImporterHostUrl(u)) {
          continue;
        }
        chrome.tabs.sendMessage(tid, message, () => {
          void chrome.runtime.lastError;
        });
      }
    });
  } catch (_) {
    /* ignore */
  }
}

function broadcastState() {
  const snapshot = snapshotState();
  const msg = { type: "stateUpdate", state: snapshot };
  chrome.runtime.sendMessage(msg).catch(() => {
    /* popup / extension pages only */
  });
  broadcastToLcscContentTabs(msg);
}

async function persistState(keys) {
  const payload = {};
  keys.forEach((key) => {
    payload[key] = state[key];
  });
  await storageSet(payload);
}

function jobLifecycleRank(status) {
  const s = String(status || "").toLowerCase();
  if (s === "queued") return 1;
  if (s === "running") return 2;
  if (s === "completed" || s === "failed") return 3;
  return 0;
}

/** Return value for submitJob callers: latest row from state.jobs (task_update may have advanced past RPC summary). */
function jobSummaryForSubmitReturn(jobId, rpcFallback) {
  const j = state.jobs[jobId];
  if (!j) {
    return rpcFallback;
  }
  return {
    id: j.id ?? jobId,
    status: j.status,
    progress: j.progress,
    message: j.message,
    queue_position: j.queue_position,
    error: j.error,
    result: j.result,
    created_at: j.created_at,
    started_at: j.started_at,
    finished_at: j.finished_at,
  };
}

// =============================================================================
// Job pipeline (submitJob, task_update merge, history)
// =============================================================================

function normalizePathKeyForCompare(p) {
  return String(p || "").trim().replace(/\\/g, "/").toLowerCase();
}

/** Allowlist template .kicad_sym paths to registered template libraries (same idea as server). */
function isKnownTemplateLibraryPath(templateLibPath) {
  const want = normalizePathKeyForCompare(templateLibPath);
  if (!want) return false;
  const libs = state.templateSymbolsByLib || {};
  return Object.keys(libs).some((k) => normalizePathKeyForCompare(k) === want);
}

async function submitJob(payload) {
  const providedPrefix = normalizePath(payload.libraryPath || "");
  const fallbackBase = normalizePath(state.selectedLibraryPath || "");
  let targetPath = providedPrefix || fallbackBase;
  if (!targetPath) {
    await ensureSelectedLibrary();
    const ensuredBase = normalizePath(state.selectedLibraryPath || "");
    targetPath = providedPrefix || ensuredBase;
    if (!targetPath) {
      throw new Error("No library path selected.");
    }
  }

  let libraryName = sanitizeLibraryName(
    payload.libraryName
      || state.selectedLibraryName
      || deriveLibraryNameFromPath(providedPrefix || fallbackBase)
      || "easyeda2kicad",
  );
  if (!libraryName) {
    libraryName = "easyeda2kicad";
  }

  const libraryPrefix = providedPrefix || buildLibraryPrefix(targetPath, libraryName);

  let catConfig = {};
  const override = payload.categoryConfigOverride;
  if (override && typeof override === "object") {
    catConfig = {
      hidePinNumbers: Boolean(override.hidePinNumbers),
      hidePinNames: Boolean(override.hidePinNames),
      valueParam:
        typeof override.valueParam === "string"
          ? override.valueParam.trim() || null
          : override.valueParam != null
            ? String(override.valueParam).trim() || null
            : null,
    };
  } else if (payload.category) {
    const resolved = resolveCategorySettings(payload.category, state.categorySettings);
    if (resolved) {
      catConfig = resolved.config;
    }
  }
  const hidePinNumbers = catConfig.hidePinNumbers ?? false;
  const hidePinNames = catConfig.hidePinNames ?? false;
  const valueParam = catConfig.valueParam ?? null;
  const symbolValueOverride = (valueParam && payload.params && payload.params[valueParam])
    ? normalizeSymbolValue(payload.params[valueParam], valueParam)
    : null;

  // Apply mapper to normalize LCSC param label variations, exclude the valueParam key
  const rawParams = (payload.params && typeof payload.params === "object")
    ? Object.fromEntries(
        Object.entries(payload.params)
          .filter(
            ([k, v]) =>
              k !== valueParam
              && v != null
              && v !== ""
              // LCSC "Datasheet" row is link text (often a .pdf name), not the URL — keep symbol_datasheet_url only.
              && mapParamKey(k) !== "Datasheet",
          )
          .map(([k, v]) => [mapParamKey(k), v])
      )
    : {};
  // Inject the package/size (e.g. "0603") as a dedicated "Package" property
  if (payload.componentPackage) {
    rawParams["Package"] = payload.componentPackage;
  }
  const symbolParams = Object.keys(rawParams).length > 0 ? rawParams : null;

  const body = {
    lcsc_id: payload.lcscId,
    output_path: libraryPrefix,
    overwrite: Boolean(payload.overwrite),
    symbol: Boolean(payload.symbol),
    footprint: Boolean(payload.footprint),
    model: Boolean(payload.model),
    overwrite_model: Boolean(payload.overwrite_model),
    project_relative: Boolean(state.projectRelative),
    project_relative_path: normalizeProjectRelativePath(state.projectRelativePath),
    model_path: typeof payload.modelPath === "string" ? payload.modelPath : "",
    hide_pin_numbers: hidePinNumbers,
    hide_pin_names: hidePinNames,
    ...(symbolValueOverride ? { symbol_value_override: symbolValueOverride } : {}),
    ...(valueParam && mapParamKey(valueParam)
      ? { symbol_value_param_key: mapParamKey(valueParam) }
      : {}),
    ...(symbolParams && Object.keys(symbolParams).length > 0 ? { symbol_params: symbolParams } : {}),
    ...(payload.description ? { symbol_description: payload.description } : {}),
    ...(payload.datasheetUrl ? { symbol_datasheet_url: payload.datasheetUrl } : {}),
    use_template: Boolean(payload.useTemplate),
    ...(payload.templateName ? { template_name: payload.templateName } : {}),
    ...(payload.useTemplate && (payload.templateLibPath || getTemplateLibraryPath())
      ? { template_lib_path: payload.templateLibPath || getTemplateLibraryPath() }
      : {}),
    force_template: Boolean(payload.forceTemplate),
    ...(payload.templatePinMap && typeof payload.templatePinMap === "object"
      && Object.keys(payload.templatePinMap).length > 0
      ? { template_pin_map: payload.templatePinMap }
      : {}),
  };

  kpiJobLog("enqueue_task → sending", { lcsc_id: body.lcsc_id, output_path: body.output_path });
  let summary;
  try {
    summary = await sendExtensionRpc("enqueue_task", body, 120000);
  } catch (err) {
    kpiJobLog("enqueue_task RPC threw", err?.message || err);
    throw err;
  }
  if (!summary || typeof summary.id !== "string") {
    kpiJobLog("enqueue_task invalid response (missing id)", summary);
    throw new Error("Invalid enqueue_task response from backend.");
  }
  kpiJobLog("enqueue_task ← RPC summary", {
    id: summary.id,
    status: summary.status,
    progress: summary.progress,
    queue_position: summary.queue_position,
    message: summary.message,
  });
  if (summary && summary.progress != null) {
    const np = Number(summary.progress);
    if (Number.isFinite(np)) summary.progress = np;
  }
  const meta = {
    lcscId: payload.lcscId,
    libraryName,
    libraryBasePath: targetPath,
    libraryPath: libraryPrefix,
    outputs: {
      symbol: Boolean(payload.symbol),
      footprint: Boolean(payload.footprint),
      model: Boolean(payload.model),
    },
  };

  state.jobMeta[summary.id] = meta;
  let merged = { ...meta, ...summary };
  const prev = state.jobs[summary.id];
  if (prev) {
    const pr = jobLifecycleRank(prev.status);
    const nr = jobLifecycleRank(summary.status);
    if (pr > nr) {
      kpiJobLog("submitJob merge: keep higher lifecycle (RPC stale vs state.jobs)", {
        id: summary.id,
        prevStatus: prev.status,
        rpcStatus: summary.status,
      });
      merged = {
        ...merged,
        status: prev.status,
        progress: prev.progress ?? merged.progress,
        message: prev.message ?? merged.message,
        queue_position: prev.queue_position ?? merged.queue_position,
        started_at: prev.started_at ?? merged.started_at,
        finished_at: prev.finished_at ?? merged.finished_at,
        error: prev.error ?? merged.error,
        result: prev.result ?? merged.result,
      };
      if (Array.isArray(prev.log) && prev.log.length > (merged.log?.length || 0)) {
        merged.log = prev.log;
      }
    } else if (pr === 2 && nr === 2) {
      const pp = Number(prev.progress);
      const np = Number(summary.progress);
      if (Number.isFinite(pp) && Number.isFinite(np) && pp > np) {
        kpiJobVerbose("submitJob merge: keep higher progress (both running)", summary.id, pp, np);
        merged.progress = prev.progress;
        merged.message = prev.message ?? merged.message;
      }
    }
  }
  state.jobs[summary.id] = merged;
  kpiJobLog("submitJob stored state.jobs", {
    id: summary.id,
    status: merged.status,
    progress: merged.progress,
    queue_position: merged.queue_position,
  });
  await persistState(["jobMeta"]);
  broadcastState();
  return jobSummaryForSubmitReturn(summary.id, summary);
}

async function handleCreateLibrary(payload = {}) {
  const basePath = normalizePath(payload.basePath || "");
  const rawName = typeof payload.name === "string" ? payload.name : "";
  const name = sanitizeLibraryName(rawName) || deriveLibraryNameFromPath(basePath);
  if (!basePath) {
    throw new Error("Please select a valid base folder.");
  }
  if (!name) {
    throw new Error("Please provide a library name.");
  }
  const scaffold = await nativeHostScaffoldLibrary({
    basePath,
    name,
    symbol: payload.symbol !== false,
    footprint: payload.footprint !== false,
    model: Boolean(payload.model),
  });
  const now = new Date().toISOString();
  const resolvedPrefix = normalizePath(scaffold.resolvedLibraryPrefix);
  const existing = state.libraries.find(
    (library) => library.path === resolvedPrefix,
  );
  const record = {
    id: existing?.id || createLibraryId(),
    name,
    basePath,
    path: resolvedPrefix,
    resolvedPrefix,
    symbolPath: normalizePath(scaffold.symbolPath || `${resolvedPrefix}.kicad_sym`),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    active: true,
    assets: {
      symbol: Boolean(scaffold.symbolPath),
      footprint: Boolean(scaffold.footprintDir),
      model: Boolean(scaffold.modelDir),
    },
    counts: {
      symbol: scaffold.exists ? 1 : 0,
      footprint: 0,
      model: 0,
    },
    warnings: [],
    projectId: payload.projectId || existing?.projectId || "default",
    modelPath: "",
    missing: false,
    lastValidation: now,
  };
  const stored = upsertLibraryRecord(record);
  await ensureSelectedLibrary();
  await persistState(["libraries", "libraryTotals"]);
  broadcastState();
  return stored;
}

async function handleImportLibrary(payload = {}) {
  const rawPath = typeof payload.path === "string" ? payload.path : "";
  const symbolPath = normalizePath(rawPath);
  if (!symbolPath) {
    throw new Error("Please select a library file.");
  }
  if (!symbolPath.toLowerCase().endsWith(".kicad_sym")) {
    throw new Error("Please select a .kicad_sym file.");
  }

  const validation = await nativeHostValidateLibrary(symbolPath);
  if (!validation.exists || !validation.symbol?.exists) {
    throw new Error("The selected file is not a valid library.");
  }

  const resolvedSymbol = normalizePath(validation.symbolPath || symbolPath);
  const name = sanitizeLibraryName(deriveLibraryNameFromPath(resolvedSymbol));
  if (!name) {
    throw new Error("Could not determine library name.");
  }

  const now = new Date().toISOString();
  const existing = state.libraries.find((library) => {
    const existingPrefix = normalizePath(library.path || library.resolvedPrefix || "");
    const existingSymbol = normalizePath(library.symbolPath || `${existingPrefix}.kicad_sym`);
    return existingSymbol === resolvedSymbol || existingPrefix === stripLibrarySuffix(resolvedSymbol);
  });
  const parentPath = normalizePath(resolvedSymbol.replace(/[\\/][^\\/]*$/, ""));
  const record = {
    id: existing?.id || createLibraryId(),
    name,
    basePath: normalizePath(payload.basePath || existing?.basePath || parentPath),
    path: stripLibrarySuffix(resolvedSymbol),
    resolvedPrefix: stripLibrarySuffix(resolvedSymbol),
    symbolPath: resolvedSymbol,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    active: true,
    assets: {
      symbol: Boolean(validation.symbol?.exists),
      footprint: Boolean(validation.footprintDir?.exists),
      model: false,
    },
    counts: {
      // V3 validateLibrary reports existence only, not element counts; the
      // inventory refresh (still V2-WS) backfills real counts in a follow-up.
      symbol: validation.symbol?.exists ? 1 : 0,
      footprint: 0,
      model: 0,
    },
    warnings: [],
    projectId: payload.projectId || existing?.projectId || "default",
    modelPath: "",
    missing: !validation.exists,
    lastValidation: now,
  };
  const stored = upsertLibraryRecord(record);
  await ensureSelectedLibrary();
  await persistState(["libraries", "libraryTotals"]);
  broadcastState();
  return stored;
}

/**
 * V3 Issue #24: popup-side library-prefix validation now goes through the
 * Native Host's `validateLibrary` RPC (Q-PICK-1). The legacy WebSocket-backed
 * `validateLibraryOnServer` is still used by inventory bookkeeping until that
 * subsystem is ported in a follow-up slice — keeping the two paths distinct
 * so the picker stays usable today without dragging the whole inventory
 * pipeline into this slice.
 */
async function handleValidateLibrary(payload = {}) {
  const rawPath = typeof payload.path === "string" ? payload.path : "";
  const prefix = normalizePath(rawPath);
  if (!prefix) {
    throw new Error("Please provide a path.");
  }
  return nativeHostValidateLibrary(prefix);
}

/**
 * V3 Issue #24: the popup library picker now talks to the Native Host via
 * Native Messaging (`fsRoots` / `fsList` / `fsCheck`), not the dropped V2
 * WebSocket backend. ADR-0001 + Q-PICK-1: access stays whitelisted to
 * Documents, KiCad standard paths, and any folder the user explicitly added.
 */
async function fetchRoots() {
  const { roots } = await nativeHostFsRoots();
  return roots;
}

async function fetchDirectory(path) {
  return nativeHostFsList(path);
}

async function checkPath(path) {
  return nativeHostFsCheck(path);
}

// =============================================================================
// V3 walking skeleton — Native Host ping (ADR-0001). Real V3 RPCs land in
// later slices (#3 Phase 1 Fetch, #4 Phase 2 Conversion). Coexists with the
// V2 WebSocket transport above; V3 has its own transport on a separate port.
// =============================================================================

const NATIVE_HOST_NAME = "com.kicad_parts_importer.host";
const NATIVE_HOST_PING_TIMEOUT_MS = 5000;
const NATIVE_HOST_FETCH_METADATA_TIMEOUT_MS = 5000;
/** Phase 2 ceiling: ~5–10 s typical (V3-SPEC.md §1), 60 s envelope for
 *  slow EasyEDA / first-time PDF cache. ADR-0004: one RPC per click, busy
 *  on concurrent attempts — there is no queue. */
const NATIVE_HOST_CONVERT_TIMEOUT_MS = 60000;
/**
 * Pre-Warm heartbeat: every 25 s the service worker re-pings the Native Host.
 * Two jobs: (a) belt-and-suspenders keep-alive against future Chrome
 * service-worker idle thresholds, (b) cheap freshness check so the Anchor
 * Card button can flip to `offline` mid-session if the user stops the host.
 * See V3-SPEC.md §3 (Cold-start mitigation).
 *
 * Issue #26: with the Warm-Port (below) the ping ALSO holds the Native-Host
 * process alive across the session — Chrome only kills the host when no
 * extension port references it. So the 25-s ping is now both keep-alive
 * for the SW (resets idle timer) AND keep-alive for Python (warm process).
 */
const NATIVE_HOST_KEEPALIVE_ALARM = "v3-native-host-keepalive";
const NATIVE_HOST_KEEPALIVE_PERIOD_MIN = 25 / 60;

/**
 * V3 **Warm-Port** singleton (Issue #26). One persistent
 * ``chrome.runtime.connectNative`` port reused for every RPC — Phase 1
 * Fetch, Phase 2 Conversion, Override Panel reads (listTemplates), pings.
 * The Python process stays alive across the whole session because Chrome
 * does not kill a Native Host while an extension port references it; the
 * 25-s keep-alive ping above piggybacks on the same warm port.
 *
 * Lazy: the first ``send()`` triggers ``chrome.runtime.connectNative``.
 * Auto-reconnect: a port disconnect (Python crash, SW wake, manifest
 * reload) is surfaced as a ``disconnected`` reply to in-flight callers;
 * the next ``send()`` opens a fresh port transparently.
 *
 * Single-flight semantics for ``convert`` / ``fetchMetadata`` are still
 * enforced HOST-side by the shared ``_busy_lock`` (ADR-0004); the warm
 * port does NOT serialize sends. SW-side ``nativeHost*InFlight`` flags
 * remain as a fast pre-check that skips a wire round-trip.
 */
let _warmNativePort = null;

function getWarmNativePort() {
  if (_warmNativePort) return _warmNativePort;
  if (typeof globalThis.k2cCreateWarmNativePort !== "function") {
    throw new Error("nativeHostPort.js was not loaded — check importScripts order");
  }
  _warmNativePort = globalThis.k2cCreateWarmNativePort({
    connectNative: () => chrome.runtime.connectNative(NATIVE_HOST_NAME),
    onError: (err) => {
      if (state?.debugLogs) {
        console.warn("[v3 warm port]", err?.message || err);
      }
    },
  });
  return _warmNativePort;
}

async function pingNativeHostOnce() {
  let envelope;
  try {
    envelope = await getWarmNativePort().send(
      "ping",
      undefined,
      { timeoutMs: NATIVE_HOST_PING_TIMEOUT_MS },
    );
  } catch (e) {
    return { online: false, error: e?.message || String(e) };
  }
  if (envelope && envelope.ok === true) {
    return { online: true, version: envelope.version || null };
  }
  return { online: false, error: envelope?.error || "no ok flag" };
}

/**
 * Cached Pre-Warm status. Tri-state matches the Anchor Card button visual:
 * `checking` while a ping is in flight, `online`/`offline` after it settles.
 * Refreshed on every prewarm call and on every keep-alive alarm fire.
 */
let nativeHostStatus = { state: "checking", version: null, error: null, updatedAt: 0 };
let nativeHostPrewarmInFlight = null;

function broadcastNativeHostStatus() {
  const message = { type: "v3NativeHostStatusUpdate", status: { ...nativeHostStatus } };
  try {
    chrome.runtime.sendMessage(message).catch(() => { /* popup / extension pages only */ });
  } catch (_e) { /* ignore */ }
  broadcastToLcscContentTabs(message);
}

function updateNativeHostStatus(next) {
  nativeHostStatus = { ...next, updatedAt: Date.now() };
  broadcastNativeHostStatus();
}

async function prewarmNativeHostInternal() {
  if (nativeHostPrewarmInFlight) return nativeHostPrewarmInFlight;
  updateNativeHostStatus({ state: "checking", version: null, error: null });
  const work = (async () => {
    const result = await pingNativeHostOnce();
    if (result.online) {
      updateNativeHostStatus({ state: "online", version: result.version || null, error: null });
    } else {
      updateNativeHostStatus({ state: "offline", version: null, error: result.error || "offline" });
    }
    return { ...nativeHostStatus };
  })();
  nativeHostPrewarmInFlight = work;
  try {
    return await work;
  } finally {
    nativeHostPrewarmInFlight = null;
  }
}

function ensureNativeHostKeepAliveAlarm() {
  try {
    chrome.alarms.get(NATIVE_HOST_KEEPALIVE_ALARM, (existing) => {
      if (!existing) {
        chrome.alarms.create(NATIVE_HOST_KEEPALIVE_ALARM, {
          periodInMinutes: NATIVE_HOST_KEEPALIVE_PERIOD_MIN,
        });
      }
    });
  } catch (_e) { /* `alarms` permission missing — manifest guards this */ }
}

if (chrome.alarms?.onAlarm?.addListener) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== NATIVE_HOST_KEEPALIVE_ALARM) return;
    prewarmNativeHostInternal().catch(() => { /* status already updated */ });
  });
}

let nativeHostPhase1InFlight = false;

/**
 * V3 **Phase 1 Fetch** RPC bridge (Issue #3). Routed over the Warm-Port
 * (Issue #26): the Native-Host process stays alive across this call and
 * the follow-up Phase 2 click — no Python cold-start per RPC.
 *
 * SW-side single-flight matches the Native-Host busy lock so a second
 * Phase 1 / Phase 2 attempt gets ``busy`` (ADR-0004) without a port
 * round-trip. The host's own ``_busy_lock`` is the source of truth; the
 * SW flag is just a fast pre-check.
 *
 * @param {{ lcscId: string, pageHints?: object }} payload
 * @returns {Promise<{ok: true, result: object} | {ok: false, error: string}>}
 */
async function nativeHostFetchMetadata(payload) {
  if (nativeHostPhase1InFlight) {
    return { ok: false, error: "busy" };
  }
  const lcscId = typeof payload?.lcscId === "string" ? payload.lcscId.trim().toUpperCase() : "";
  if (!lcscId || !/^C\d+$/.test(lcscId)) {
    return { ok: false, error: "invalid lcscId" };
  }
  const pageHints =
    payload?.pageHints && typeof payload.pageHints === "object" ? payload.pageHints : null;

  nativeHostPhase1InFlight = true;
  try {
    const envelope = await getWarmNativePort().send(
      "fetchMetadata",
      { lcscId, pageHints },
      { timeoutMs: NATIVE_HOST_FETCH_METADATA_TIMEOUT_MS },
    );
    if (envelope && envelope.ok === true && envelope.result && typeof envelope.result === "object") {
      return { ok: true, result: envelope.result };
    }
    return { ok: false, error: envelope?.error || "fetchMetadata returned no result" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    nativeHostPhase1InFlight = false;
  }
}

let nativeHostConvertInFlight = false;

/**
 * V3 **Phase 2 Conversion** RPC bridge (Issue #4). Routed over the
 * Warm-Port (Issue #26) so the Python process the Phase 1 call just
 * warmed stays alive for this conversion — no second cold start. Progress
 * frames stream on the same warm channel (ADR-0004) and are broadcast
 * to all LCSC content tabs as ``v3ConvertProgress`` keyed by ``lcscId``.
 *
 * SW-side single-flight matches the Native Host's busy lock so a second
 * tab gets ``busy`` immediately (no wire round-trip). Read-only verbs
 * (``listTemplates``, future ``getRule`` / ``fsList``) overlap this call
 * on the same warm port; the host's reader-thread + worker model (Issue
 * #26) serves them while ``convert`` runs.
 *
 * @param {{ lcscId: string, libraryPath?: string, overrides?: object, labelMapping?: object, pageParams?: object }} payload
 * @returns {Promise<{ok: true, result: object} | {ok: false, error: string}>}
 */
async function nativeHostConvert(payload) {
  if (nativeHostConvertInFlight) {
    return { ok: false, error: "busy" };
  }
  const lcscId = typeof payload?.lcscId === "string" ? payload.lcscId.trim().toUpperCase() : "";
  if (!lcscId || !/^C\d+$/.test(lcscId)) {
    return { ok: false, error: "invalid lcscId" };
  }
  const libraryPath = typeof payload?.libraryPath === "string" && payload.libraryPath.trim()
    ? payload.libraryPath.trim()
    : normalizePath(state.selectedLibraryPath || "");
  if (!libraryPath) {
    return { ok: false, error: "no Active library selected" };
  }
  // V3 Override Panel (Issue #5): pass the user-resolved sources through to
  // the Native Host verbatim. Shape validation happens host-side so the SW
  // does not need to understand the override grammar.
  const overrides = payload && typeof payload.overrides === "object" && payload.overrides !== null
    ? payload.overrides
    : null;

  const params = { lcscId, libraryPath };
  if (overrides) params.overrides = overrides;
  // Issue #28 — Register slice: when the matched Rule carries a
  // ``labelMapping`` the SW forwards it together with the LCSC page-params
  // snapshot the content script lifted from the product page. The host
  // projects ``pageParams`` through ``labelMapping`` into ``symbol_params``
  // so the template Symbol's properties are filled with the part-specific
  // LCSC values.
  if (payload && typeof payload.labelMapping === "object" && payload.labelMapping !== null) {
    params.labelMapping = payload.labelMapping;
  }
  if (payload && typeof payload.pageParams === "object" && payload.pageParams !== null) {
    params.pageParams = payload.pageParams;
  }
  // Pin-label visibility (Category Rule / ≤2-pin auto-heuristic) — forwarded to
  // the host's convert verb; the engine hides pin numbers/names in the symbol.
  if (payload?.hidePinNumbers) params.hidePinNumbers = true;
  if (payload?.hidePinNames) params.hidePinNames = true;
  // Value-Param (Category Rule / auto-detect): the LCSC param whose value fills
  // the KiCad Value field. Host resolves + normalizes it from pageParams.
  if (typeof payload?.valueParam === "string" && payload.valueParam.trim()) {
    params.valueParam = payload.valueParam.trim();
  }

  nativeHostConvertInFlight = true;
  try {
    const envelope = await getWarmNativePort().send("convert", params, {
      timeoutMs: NATIVE_HOST_CONVERT_TIMEOUT_MS,
      onProgress: (msg) => {
        // Match the host frame shape (``type: "progress"`` + ``message`` +
        // ``progress``) so future fields surface naturally to the content
        // tab without touching the SW relay.
        broadcastToLcscContentTabs({
          type: "v3ConvertProgress",
          lcscId,
          message: typeof msg.message === "string" ? msg.message : "",
          progress: typeof msg.progress === "number" ? msg.progress : null,
        });
      },
    });
    if (envelope && envelope.ok === true && envelope.result && typeof envelope.result === "object") {
      return { ok: true, result: envelope.result };
    }
    return { ok: false, error: envelope?.error || "convert returned no result" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    nativeHostConvertInFlight = false;
  }
}

/**
 * V3 **Register** RPC bridge (Issue #28). Persists the user-authored
 * Category Rule via the Native Host's ``setRule`` verb. Fast verb in
 * host-terms — does not contend with the host's ``_busy_lock`` (only
 * ``convert``/``fetchMetadata`` do) so it overlaps an in-flight Phase 2.
 *
 * @param {{ categoryPath: string, rule: object }} payload
 * @returns {Promise<{ok: true, result: object} | {ok: false, error: string}>}
 */
async function nativeHostSetRule(payload) {
  const categoryPath = typeof payload?.categoryPath === "string" ? payload.categoryPath : "";
  const rule = payload && typeof payload.rule === "object" && payload.rule !== null
    ? payload.rule
    : null;
  if (!categoryPath.trim() || !rule) {
    return { ok: false, error: "categoryPath and rule are required" };
  }
  let envelope;
  try {
    envelope = await getWarmNativePort().send(
      "setRule",
      { categoryPath, rule },
      { timeoutMs: 5000 },
    );
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
  if (envelope && envelope.ok === true && envelope.result && typeof envelope.result === "object") {
    return { ok: true, result: envelope.result };
  }
  return { ok: false, error: envelope?.error || "setRule returned no result" };
}

// =============================================================================
// chrome.runtime.onMessage — handler map (popup + content script)
// =============================================================================

const RUNTIME_MESSAGE_HANDLERS = {
  getState: async () => {
    try {
      await inventoryLibraries();
    } catch (error) {
      console.warn("Library inventory failed during getState", error);
    }
    const snap = snapshotState();
    let uiTheme = "light";
    try {
      const stored = await chrome.storage.local.get("popupUiState");
      const ui = stored?.popupUiState;
      if (ui && ui.theme === "dark") {
        uiTheme = "dark";
      }
    } catch (_e) {
      /* ignore */
    }
    return { ...snap, uiTheme };
  },
  setServerUrl: async (message) => {
    state.serverUrl = message.url || DEFAULT_STATE.serverUrl;
    await persistState(["serverUrl"]);
    closeExtensionSocket();
    extensionWsApi()?.resetReconnectDelay?.();
    connectExtensionSocket();
    return snapshotState();
  },
  createLibrary: async (message) => {
    const { type: _t, ...rest } = message;
    return handleCreateLibrary(rest);
  },
  importLibrary: async (message) => {
    const { type: _t, ...rest } = message;
    return handleImportLibrary(rest);
  },
  validateLibrary: async (message) => handleValidateLibrary(message),
  cleanLibrary: async (message) => nativeHostCleanLibrary(message.path),
  updateSettings: async (message) => {
    const previousServerUrl = state.serverUrl;
    if (typeof message.serverUrl === "string") {
      state.serverUrl = message.serverUrl.trim() || DEFAULT_STATE.serverUrl;
    }
    if (typeof message.overwriteFootprints === "boolean") {
      state.overwriteFootprints = message.overwriteFootprints;
    }
    if (typeof message.overwriteModels === "boolean") {
      state.overwriteModels = message.overwriteModels;
    }
    if (typeof message.debugLogs === "boolean") {
      state.debugLogs = message.debugLogs;
    }
    if (typeof message.projectRelative === "boolean") {
      state.projectRelative = message.projectRelative;
    }
    if (typeof message.projectRelativePath === "string") {
      state.projectRelativePath = normalizeProjectRelativePath(message.projectRelativePath);
    }
    if (typeof message.lowConfidenceBehaviour === "string") {
      state.lowConfidenceBehaviour = normalizeLowConfidenceBehaviour(message.lowConfidenceBehaviour);
    }
    if (message.categorySettings && typeof message.categorySettings === "object") {
      state.categorySettings = dedupeCategorySettings({ ...message.categorySettings });
    }
    await persistState([
      "serverUrl",
      "overwriteFootprints",
      "overwriteModels",
      "debugLogs",
      "projectRelative",
      "projectRelativePath",
      "lowConfidenceBehaviour",
      "categorySettings",
    ]);
    if (
      typeof message.serverUrl === "string"
      && extensionSocketEndpointKey(previousServerUrl) !== extensionSocketEndpointKey(state.serverUrl)
    ) {
      closeExtensionSocket();
      extensionWsApi()?.resetReconnectDelay?.();
      connectExtensionSocket();
    }
    return snapshotState();
  },
  updateLibraries: async (message) => {
    if (Array.isArray(message.libraries)) {
      const prevTemplatePath = getTemplateLibraryPath();
      state.libraries = message.libraries
        .map(normalizeLibraryRecord)
        .filter((library) => library);
      recalcLibraryTotals();
      await ensureSelectedLibrary();
      await persistState(["libraries", "libraryTotals"]);
      const newTemplatePath = getTemplateLibraryPath();
      if (state.connected && newTemplatePath !== prevTemplatePath) {
        refreshTemplateStatus().catch(() => {});
      }
    }
    return snapshotState();
  },
  validateLibraryDirectory: async (message) => validateLibraryDirectory(message.path),
  /**
   * V3 Issue #24 (Q-PICK-1): add a user-explicit picker root. Persisted in
   * `state.userAddedRoots` so the SW forwards it on every Native-Host FS
   * call. The full add-folder UI lands in a follow-up; the handler exists
   * now so tests can exercise the persisted-whitelist contract.
   */
  addUserRoot: async (message) => {
    const raw = typeof message.path === "string" ? message.path.trim() : "";
    if (!raw) {
      throw new Error("Please provide a path.");
    }
    const normalized = normalizePath(raw);
    const current = getUserAddedRoots();
    if (!current.includes(normalized)) {
      state.userAddedRoots = [...current, normalized];
      await persistState(["userAddedRoots"]);
      broadcastState();
    }
    return { roots: state.userAddedRoots };
  },
  setSelectedLibrary: async (message) => {
    state.selectedLibraryPath = normalizePath(message.path || "");
    let requestedName = "";
    if (typeof message.name === "string") {
      requestedName = message.name.trim();
    }
    let sanitizedName = sanitizeLibraryName(requestedName);
    if (!sanitizedName) {
      sanitizedName = deriveLibraryNameFromPath(state.selectedLibraryPath)
        || "easyeda2kicad";
    }
    state.selectedLibraryName = sanitizedName;
    await persistState(["selectedLibraryPath", "selectedLibraryName"]);
    broadcastState();
    return {
      path: state.selectedLibraryPath,
      name: state.selectedLibraryName,
    };
  },
  quickDownload: async (message) => {
    kpiJobLog("quickDownload message", { lcscId: message.lcscId, connected: state.connected });
    if (!state.connected) {
      const connected = await checkHealth();
      if (!connected) {
        kpiJobLog("quickDownload aborted: backend not reachable after checkHealth");
        throw new Error("Backend not reachable. Start the backend.");
      }
    }
    const lcscId = (message.lcscId || "").trim().toUpperCase();
    if (!lcscId || !lcscId.startsWith("C")) {
      throw new Error("Invalid LCSC ID.");
    }
    let basePath = normalizePath(state.selectedLibraryPath || "");
    if (!basePath) {
      await ensureSelectedLibrary();
      basePath = normalizePath(state.selectedLibraryPath || "");
    }
    if (!basePath) {
      throw new Error("Please select a library path in the extension first.");
    }

    const libraryName = sanitizeLibraryName(
      state.selectedLibraryName || lcscId,
    );

    const selectedLibrary = getSelectedLibraryRecord();
    const modelPath = selectedLibrary?.modelPath || "";

    const payload = {
      lcscId,
      libraryPath: basePath,
      libraryName: libraryName || lcscId,
      symbol: true,
      footprint: true,
      model: true,
      overwrite: message.overwrite !== undefined ? Boolean(message.overwrite) : Boolean(state.overwriteFootprints),
      overwrite_model: message.overwrite_model !== undefined ? Boolean(message.overwrite_model) : Boolean(state.overwriteModels),
      modelPath,
      category: typeof message.category === "string" ? message.category : null,
      componentPackage: typeof message.componentPackage === "string" ? message.componentPackage : null,
      params: message.params && typeof message.params === "object" ? message.params : {},
      description: typeof message.description === "string" ? message.description : null,
      datasheetUrl: typeof message.datasheetUrl === "string" ? message.datasheetUrl : null,
      useTemplate: Boolean(message.useTemplate),
      templateName: typeof message.templateName === "string" ? message.templateName : null,
      templateLibPath: typeof message.templateLibPath === "string" ? message.templateLibPath : null,
      forceTemplate: Boolean(message.forceTemplate),
      templatePinMap:
        message.templatePinMap && typeof message.templatePinMap === "object"
          ? message.templatePinMap
          : null,
      categoryConfigOverride:
        message.categoryConfigOverride && typeof message.categoryConfigOverride === "object"
          ? message.categoryConfigOverride
          : null,
    };

    const summary = await submitJob(payload);
    kpiJobLog("quickDownload submitJob returned", {
      jobId: summary?.id,
      status: summary?.status,
      progress: summary?.progress,
      queue_position: summary?.queue_position,
    });
    return {
      jobId: summary?.id,
      status: summary?.status,
      progress: summary?.progress,
      message: summary?.message,
      queue_position: summary?.queue_position,
      libraryName: payload.libraryName,
      libraryPath: basePath,
    };
  },
  getJobStatus: async (message) => {
    const jobId = message.jobId;
    if (!jobId) {
      throw new Error("Missing jobId");
    }
    const job = state.jobs[jobId];
    if (job) {
      return {
        ...job,
        outputAnalysis: analyzeJobOutputs(job),
        messages: job.result?.messages || job.messages || [],
      };
    }
    const history = state.jobHistory.find((entry) => entry.id === jobId);
    if (!history) {
      throw new Error("Job not found.");
    }
    return {
      ...history,
      outputAnalysis: analyzeJobOutputs(history),
      messages: history.result?.messages || history.messages || [],
    };
  },
  checkComponentExists: async (message) => {
    if (!state.connected) {
      const connected = await checkHealth();
      if (!connected) {
        throw new Error("Backend not reachable. Start the backend.");
      }
    }
    const lcscId = (message.lcscId || "").trim().toUpperCase();
    if (!lcscId || !lcscId.startsWith("C")) {
      throw new Error("Invalid LCSC ID.");
    }
    const activeJob = Object.values(state.jobs || {}).find((job) => job.lcscId === lcscId);
    if (activeJob) {
      return {
        inProgress: true,
        jobId: activeJob.id,
        status: activeJob.status,
        progress: activeJob.progress,
        message: activeJob.message,
        queue_position: activeJob.queue_position,
        libraryName: activeJob.libraryName,
        libraryPath: activeJob.libraryPath,
        completed: false,
        outputAnalysis: analyzeJobOutputs(activeJob),
        partial: false,
        missing: [],
        outputs: activeJob.outputs,
        result: activeJob.result,
        messages: activeJob.result?.messages || activeJob.messages || [],
      };
    }

    const selectedLibrary = getSelectedLibraryRecord();
    const libraryPrefix = normalizePath(
      deriveLibraryPrefix(selectedLibrary) || state.selectedLibraryPath || ""
    );
    if (!libraryPrefix) {
      throw new Error("Please select a library in the extension.");
    }

    const validation = await validateLibraryOnServer(libraryPrefix);
    const index = state.libraries.findIndex(
      (library) => normalizePath(library.path || library.resolvedPrefix || "") === libraryPrefix
    );
    if (index >= 0) {
      state.libraries[index] = buildLibraryStatus(state.libraries[index], validation);
      recalcLibraryTotals();
      await persistState(["libraries", "libraryTotals"]);
      broadcastState();
    }
    if (!validation.exists) {
      return {
        inProgress: false,
        jobId: null,
        status: null,
        libraryName: selectedLibrary?.name || null,
        libraryPath: libraryPrefix,
        completed: false,
        outputAnalysis: null,
        partial: false,
        missing: ["library"],
        outputs: null,
        result: null,
        messages: ["Library path is missing on disk."],
      };
    }

    const check = await checkComponentOnServer(libraryPrefix, lcscId);
    return buildComponentStatus({
      lcscId,
      check,
      libraryPrefix,
      selectedLibrary,
    });
  },
  checkCategoryKnown: async (message) => {
    const cat = typeof message.category === "string" ? message.category.trim() : "";
    const pagePath = normalizeCategoryPath(cat);
    return {
      known: Boolean(pagePath && resolveCategorySettings(pagePath, state.categorySettings)),
    };
  },
  getCategorySettings: async (message) => {
    const cat = typeof message.category === "string" ? message.category.trim() : "";
    const pagePath = normalizeCategoryPath(cat);
    if (!pagePath) return null;
    const resolved = resolveCategorySettings(pagePath, state.categorySettings);
    return resolved ? resolved.config : null;
  },
  saveCategorySettings: async (message) => {
    const cat = normalizeCategoryPath(typeof message.category === "string" ? message.category : "");
    if (!cat) throw new Error("Category name required.");
    const cfg = message.config && typeof message.config === "object" ? message.config : {};
    state.categorySettings = dedupeCategorySettings({
      ...state.categorySettings,
      [cat]: {
        hidePinNumbers: Boolean(cfg.hidePinNumbers),
        hidePinNames: Boolean(cfg.hidePinNames),
        valueParam: typeof cfg.valueParam === "string" ? cfg.valueParam.trim() || null : null,
      },
    });
    await persistState(["categorySettings"]);
    broadcastState();
    const canon = canonicalCategoryKey(cat);
    const pair = Object.entries(state.categorySettings).find(([k]) => canonicalCategoryKey(k) === canon);
    return pair ? pair[1] : null;
  },
  getTemplateStatus: async () =>
    Object.fromEntries((state.templateSymbols || []).map((n) => [n, true])),
  refreshTemplateSymbols: async () => {
    await refreshTemplateStatus();
    return {
      templateSymbolsByLib: state.templateSymbolsByLib ? { ...state.templateSymbolsByLib } : {},
      templateFootprintsByLib: state.templateFootprintsByLib ? { ...state.templateFootprintsByLib } : {},
      templateCategoriesByLib: state.templateCategoriesByLib ? { ...state.templateCategoriesByLib } : {},
      templateSymbols: (state.templateSymbols || []).slice(),
      // Issue #31 — content-script's Override Panel reads this to pick the
      // 🟡 keepEasyeda vs openEditor branch without a second roundtrip.
      lowConfidenceBehaviour: state.lowConfidenceBehaviour,
    };
  },
  templatesPinCheck: async (message) => {
    const lcscId = (message.lcscId || "").trim().toUpperCase();
    const templateName = typeof message.templateName === "string" ? message.templateName.trim() : "";
    const templateLibPath = typeof message.templateLibPath === "string" ? message.templateLibPath.trim() : "";
    if (!lcscId || !lcscId.startsWith("C") || !templateName || !templateLibPath) {
      throw new Error("templatesPinCheck requires lcscId, templateName, and templateLibPath.");
    }
    if (!isKnownTemplateLibraryPath(templateLibPath)) {
      throw new Error("Template library path is not registered in extension settings.");
    }
    return sendExtensionRpc(
      "templates_pin_check",
      {
        lcsc_id: lcscId,
        template_name: templateName,
        template_lib_path: templateLibPath,
      },
      120000,
    );
  },
  templatesGalleryPinSummary: async (message) => {
    const lcscId = (message.lcscId || "").trim().toUpperCase();
    if (!lcscId || !lcscId.startsWith("C")) {
      throw new Error("templatesGalleryPinSummary requires a valid lcscId.");
    }
    const raw = Array.isArray(message.templates) ? message.templates : [];
    const templates = raw
      .map((t) => ({
        template_name: String(t.templateName || t.template_name || "").trim(),
        template_lib_path: String(t.templateLibPath || t.template_lib_path || "").trim(),
      }))
      .filter(
        (t) =>
          t.template_name
          && t.template_lib_path
          && isKnownTemplateLibraryPath(t.template_lib_path),
      );
    return sendExtensionRpc(
      "templates_gallery_pin_summary",
      { lcsc_id: lcscId, templates },
      180000,
    );
  },
  templatesPreviewSvg: async (message) => {
    const templateName = typeof message.templateName === "string" ? message.templateName.trim() : "";
    const templateLibPath = typeof message.templateLibPath === "string" ? message.templateLibPath.trim() : "";
    const labelPins = Boolean(message.labelPins);
    const drawPinNames = message.drawPinNames !== false;
    const previewTheme = message.previewTheme === "dark" ? "dark" : "light";
    if (!templateName || !templateLibPath) {
      throw new Error("templatesPreviewSvg requires templateName and templateLibPath.");
    }
    if (!isKnownTemplateLibraryPath(templateLibPath)) {
      throw new Error("Template library path is not registered in extension settings.");
    }
    // V3: render via the Native Host (was the V2 WebSocket ``templates_preview_svg``).
    // Adapt to the ``{ ok, svg, error }`` shape app.js already consumes.
    const res = await nativeHostTemplateSymbolPreview({
      templateLibPath,
      templateName,
      theme: previewTheme,
      labelPins,
      drawPinNames,
    });
    if (!res.ok) {
      return { ok: false, svg: null, error: res.error || "Preview unavailable" };
    }
    const result = res.result || {};
    return {
      ok: typeof result.svg === "string",
      svg: typeof result.svg === "string" ? result.svg : null,
      error: result.error,
      meta: result.meta,
    };
  },
  templatesPinMapContext: async (message) => {
    const lcscId = (message.lcscId || "").trim().toUpperCase();
    const templateName = typeof message.templateName === "string" ? message.templateName.trim() : "";
    const templateLibPath = typeof message.templateLibPath === "string" ? message.templateLibPath.trim() : "";
    if (!lcscId || !lcscId.startsWith("C") || !templateName || !templateLibPath) {
      throw new Error("templatesPinMapContext requires lcscId, templateName, and templateLibPath.");
    }
    if (!isKnownTemplateLibraryPath(templateLibPath)) {
      throw new Error("Template library path is not registered in extension settings.");
    }
    return sendExtensionRpc(
      "templates_pin_map_context",
      {
        lcsc_id: lcscId,
        template_name: templateName,
        template_lib_path: templateLibPath,
      },
      120000,
    );
  },
  lcscFootprintPreview: async (message) => {
    const lcscId = (message.lcscId || "").trim().toUpperCase();
    if (!lcscId || !lcscId.startsWith("C")) {
      throw new Error("lcscFootprintPreview requires a valid lcscId.");
    }
    // V3: render via the Native Host (was the V2 WebSocket lcsc_footprint_preview).
    // Map to the snake_case bundle shape the gallery + editor already consume.
    const res = await nativeHostLcscFootprintPreview(lcscId);
    if (!res.ok) {
      return { ok: false, footprint_svg: null, error: res.error || "Footprint preview unavailable" };
    }
    const result = res.result || {};
    return {
      ok: typeof result.svg === "string",
      footprint_svg: typeof result.svg === "string" ? result.svg : null,
      footprint_name: result.name || "",
      pads: Array.isArray(result.pads) ? result.pads : [],
      error: result.error,
    };
  },
  /**
   * Fetch datasheet bytes in the service worker (bypasses page CORS / broken PDF.js-in-iframe).
   * Content script builds a blob: URL for the preview iframe.
   */
  fetchDatasheetBlob: async (message, sender) => {
    const log = (...a) => console.info("[KiCad datasheet SW]", ...a);
    const url = typeof message.url === "string" ? message.url.trim() : "";
    if (!url || !/^https?:\/\//i.test(url)) {
      log("reject: bad URL", url);
      throw new Error("fetchDatasheetBlob requires an http(s) URL.");
    }
    const maxBytes = 24 * 1024 * 1024;
    const LARGE_PDF_BYTES = 5 * 1024 * 1024;
    const confirmedLarge = Boolean(message.confirmedLarge);
    const requestId = message.requestId != null ? Number(message.requestId) : 0;
    const tabId = sender?.tab?.id;

    let lastProgressSent = 0;
    function reportProgress(received, total) {
      if (tabId == null) {
        return;
      }
      const now = Date.now();
      if (now - lastProgressSent < 80 && total != null && received < total) {
        return;
      }
      lastProgressSent = now;
      try {
        chrome.tabs.sendMessage(tabId, {
          type: "k2c-datasheet-fetch-progress",
          requestId,
          received,
          total: total != null && Number.isFinite(total) ? total : null,
        });
      } catch (_e) {
        /* tab closed */
      }
    }

    function bufferLooksLikePdf(buf) {
      if (!buf || buf.byteLength < 5) {
        return false;
      }
      const u = new Uint8Array(buf, 0, 5);
      return u[0] === 0x25 && u[1] === 0x50 && u[2] === 0x44 && u[3] === 0x46 && u[4] === 0x2d; // %PDF-
    }

    function primaryContentType(r) {
      return (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    }

    /** LCSC often responds 200 with `text/html` (Nuxt shell) instead of the PDF — real file is on datasheet.lcsc.com. */
    function extractLcscPdfUrlFromHtml(html) {
      const normalized = html.replace(/\\u002[fF]/g, "/");
      const re = /https?:\/\/[^"'<>\s]+?\.pdf(?:\?[^"'<>\s]*)?/gi;
      const seen = new Set();
      /** @type {string[]} */
      const candidates = [];
      let m;
      while ((m = re.exec(normalized)) !== null) {
        const candidate = m[0].replace(/&amp;/g, "&");
        if (seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);
        try {
          const p = new URL(candidate);
          const h = p.hostname.toLowerCase();
          const onLcsc =
            /(^|\.)lcsc\.com$/i.test(h) || /(^|\.)lcsiglobal\.com$/i.test(h) || /(^|\.)szlcsc\.com$/i.test(h);
          if (!onLcsc) {
            continue;
          }
          if (h === "www.lcsc.com" && /^\/datasheet\/C\d+\.pdf$/i.test(p.pathname)) {
            continue;
          }
          candidates.push(candidate);
        } catch (_e) {
          /* ignore */
        }
      }
      const preferred = candidates.find((u) => /datasheet\.lcsc\.com/i.test(u));
      return preferred || candidates[0] || null;
    }

    function concatChunkBuffers(chunks, totalByteLength) {
      const out = new Uint8Array(totalByteLength);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }
      return out.buffer;
    }

    /**
     * @param {boolean} applyLargeGate When true, PDFs over 5 MiB need {@code confirmedLarge} on a follow-up request.
     */
    async function readResponseBody(r, applyLargeGate) {
      const cl = r.headers.get("content-length");
      const expected = cl ? parseInt(cl, 10) : NaN;
      if (Number.isFinite(expected) && expected > maxBytes) {
        throw new Error("Datasheet too large for in-page preview");
      }

      if (
        applyLargeGate
        && !confirmedLarge
        && Number.isFinite(expected)
        && expected > LARGE_PDF_BYTES
      ) {
        try {
          if (r.body?.cancel) {
            await r.body.cancel();
          }
        } catch (_e) {
          /* ignore */
        }
        return { needsApproval: true, expectedBytes: expected };
      }

      if (!r.body) {
        const buf = await r.arrayBuffer();
        if (buf.byteLength > maxBytes) {
          throw new Error("Datasheet too large for in-page preview");
        }
        if (applyLargeGate && !confirmedLarge && buf.byteLength > LARGE_PDF_BYTES) {
          return { needsApproval: true, expectedBytes: buf.byteLength };
        }
        return { buf };
      }

      const reader = r.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.byteLength) {
          chunks.push(value);
          received += value.byteLength;
        }
        if (Number.isFinite(expected)) {
          reportProgress(received, expected);
        } else {
          reportProgress(received, null);
        }
        if (received > maxBytes) {
          try {
            await reader.cancel();
          } catch (_e) {}
          throw new Error("Datasheet too large for in-page preview");
        }
        if (applyLargeGate && !confirmedLarge && received > LARGE_PDF_BYTES) {
          try {
            await reader.cancel();
          } catch (_e) {}
          return { needsApproval: true, expectedBytes: null, downloadedBytes: received };
        }
      }

      const buf = concatChunkBuffers(chunks, received);
      if (applyLargeGate && !confirmedLarge && buf.byteLength > LARGE_PDF_BYTES) {
        return { needsApproval: true, expectedBytes: buf.byteLength };
      }
      return { buf };
    }

    async function fetchRaw(targetUrl, credentials, applyLargeGate) {
      const headers = {
        Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
      };
      if (/lcsc|lcsiglobal|szlcsc/i.test(targetUrl)) {
        headers.Referer = "https://www.lcsc.com/";
      }
      const res = await fetch(targetUrl, {
        method: "GET",
        redirect: "follow",
        credentials,
        headers,
      });
      if (!res.ok) {
        throw new Error(`Datasheet HTTP ${res.status}`);
      }
      const readResult = await readResponseBody(res, applyLargeGate);
      if (readResult.needsApproval) {
        return readResult;
      }
      return { r: res, buf: readResult.buf };
    }

    function urlLooksLikePdfPath(u) {
      try {
        return /\.pdf$/i.test(new URL(u).pathname);
      } catch (_e) {
        return /\.pdf(\?|$)/i.test(u);
      }
    }

    const isLcscFamily = /lcsc|lcsiglobal|szlcsc/i.test(url);
    const creds = isLcscFamily ? "include" : "omit";

    let fr = await fetchRaw(url, creds, urlLooksLikePdfPath(url));
    if (fr.needsApproval) {
      return {
        needsApproval: true,
        expectedBytes: fr.expectedBytes,
        downloadedBytes: fr.downloadedBytes,
      };
    }
    let { r, buf } = fr;
    let finalUrl = url;
    let ct = primaryContentType(r);

    if (!bufferLooksLikePdf(buf)) {
      log("not a PDF (magic)", "content-type=", ct, "bytes=", buf.byteLength, "url=", url);
      let recovered = false;

      try {
        const noQuery = new URL(url);
        if (noQuery.search) {
          noQuery.search = "";
          const tryUrl = noQuery.href;
          log("retry without query string", tryUrl);
          const second = await fetchRaw(tryUrl, creds, urlLooksLikePdfPath(tryUrl));
          if (second.needsApproval) {
            return {
              needsApproval: true,
              expectedBytes: second.expectedBytes,
              downloadedBytes: second.downloadedBytes,
            };
          }
          if (bufferLooksLikePdf(second.buf)) {
            ({ r, buf } = second);
            finalUrl = tryUrl;
            ct = primaryContentType(second.r);
            recovered = true;
          }
        }
      } catch (e) {
        log("retry without query failed", e?.message || e);
      }

      if (!recovered && /text\/html/i.test(ct)) {
        const html = new TextDecoder("utf-8", { fatal: false }).decode(
          new Uint8Array(buf).subarray(0, Math.min(buf.byteLength, 512 * 1024)),
        );
        const inner = extractLcscPdfUrlFromHtml(html);
        if (inner && inner !== url) {
          log("retry HTML → extracted .pdf URL", inner);
          try {
            const third = await fetchRaw(inner, creds, true);
            if (third.needsApproval) {
              return {
                needsApproval: true,
                expectedBytes: third.expectedBytes,
                downloadedBytes: third.downloadedBytes,
              };
            }
            if (bufferLooksLikePdf(third.buf)) {
              ({ r, buf } = third);
              finalUrl = inner;
              ct = primaryContentType(third.r);
              recovered = true;
            } else {
              log("extracted URL still not PDF", primaryContentType(third.r), third.buf.byteLength);
            }
          } catch (e) {
            log("fetch extracted URL failed", e?.message || e);
          }
        } else {
          log("no .pdf URL found inside HTML");
        }
      }

      if (!bufferLooksLikePdf(buf)) {
        throw new Error(
          "Server returned HTML or non-PDF (LCSC datasheet shell). Use “Open in tab” or try again logged in.",
        );
      }
    }

    const outCt = (r.headers.get("content-type") || "application/pdf").split(";")[0].trim();
    const base64 = await new Promise((resolve, reject) => {
      try {
        const fr = new FileReader();
        fr.onload = () => {
          const s = String(fr.result || "");
          const comma = s.indexOf(",");
          resolve(comma >= 0 ? s.slice(comma + 1) : s);
        };
        fr.onerror = () => reject(fr.error || new Error("datasheet base64 encode failed"));
        fr.readAsDataURL(new Blob([buf], { type: outCt || "application/pdf" }));
      } catch (e) {
        reject(e);
      }
    });
    log("OK PDF", "bytes=", buf.byteLength, "content-type=", outCt, "finalUrl=", finalUrl);
    return { contentType: outCt || "application/pdf", base64, byteLength: buf.byteLength };
  },
  submitJob: async (message) => submitJob(message.payload),
  "fs:listRoots": async () => fetchRoots(),
  "fs:listDirectory": async (message) => fetchDirectory(message.path),
  "fs:check": async (message) => checkPath(message.path),
  clearHistory: async () => {
    state.jobHistory = [];
    await persistState(["jobHistory"]);
    broadcastState();
    return { cleared: true };
  },
  pingNativeHost: async () => pingNativeHostOnce(),
  /**
   * V3 Pre-Warm trigger (V3-SPEC.md §3). Content scripts call this on LCSC
   * page load so the Native Host is hot by the time the user clicks. Idempotent
   * across tabs: a concurrent call coalesces onto the in-flight ping.
   */
  prewarmNativeHost: async () => {
    ensureNativeHostKeepAliveAlarm();
    return prewarmNativeHostInternal();
  },
  /** Latest cached pre-warm status without forcing a fresh ping. */
  getNativeHostStatus: async () => ({ ...nativeHostStatus }),
  /**
   * V3 **Phase 1 Fetch** (Issue #3) + Confidence-Pipeline (Issue #25).
   * Content script calls this from the Anchor Card's Download click; SW
   * relays to the Native Host's ``fetchMetadata`` RPC, then runs
   * ``matchComponentRule`` against the user's registered Category Rules
   * and folds the resulting ``MatchResult{state, confidence}`` into the
   * Phase-1 response. The content script reads ``result.matchResult`` to
   * decide which Override-Panel mode to render (Register-Prompt in ⚪
   * white; 🟢/🟡 in later slices). The bare ``state``/``confidence`` are
   * also lifted to the top level so the content script can branch without
   * destructuring.
   */
  v3FetchMetadata: async (message) => {
    const resp = await nativeHostFetchMetadata({
      lcscId: message.lcscId,
      pageHints: message.pageHints,
    });
    if (!resp || resp.ok !== true || !resp.result) return resp;
    let matchResult;
    try {
      matchResult = matchComponentRule(resp.result, {
        categorySettings: state.categorySettings,
        templateSymbolsByLib: state.templateSymbolsByLib,
        templateCategoriesByLib: state.templateCategoriesByLib,
      });
    } catch (e) {
      // Never let a bug in the matcher knock out Phase 1 itself — the
      // panel can still fall back to a plain EasyEDA import.
      console.warn("[v3] matchComponentRule threw", e);
      matchResult = null;
    }
    return {
      ok: true,
      result: {
        ...resp.result,
        matchResult,
        state: matchResult?.state ?? null,
        confidence: matchResult?.confidence ?? null,
      },
    };
  },
  /**
   * V3 **Phase 2 Conversion** default-path (Issue #4). Content script calls
   * this after Phase 1 succeeds; SW relays to the Native Host's ``convert``
   * RPC and broadcasts the streamed ``progress`` frames to the originating
   * tab as ``v3ConvertProgress``. Returns ``{ok, result|error}`` for the
   * Anchor Card button to render the terminal state.
   */
  v3Convert: async (message) => nativeHostConvert({
    lcscId: message.lcscId,
    libraryPath: message.libraryPath,
    overrides: message.overrides,
    labelMapping: message.labelMapping,
    pageParams: message.pageParams,
    hidePinNumbers: message.hidePinNumbers,
    hidePinNames: message.hidePinNames,
    valueParam: message.valueParam,
  }),
  /**
   * V3 **Register** (Issue #28). Content script's Import-Editor relays the
   * Category Path + ``ComponentRule`` shape; SW forwards to the Native
   * Host's ``setRule`` verb. Returns ``{ok, result|error}`` so the
   * Import-Editor can surface a clear "saved" / "failed" status.
   */
  v3SetRule: async (message) => {
    const res = await nativeHostSetRule({
      categoryPath: message.categoryPath,
      rule: message.rule,
    });
    // Close the Confidence learn-loop (ADR-0006): matchComponentRule (Phase 1)
    // resolves against state.categorySettings, so the just-registered rule must
    // be mirrored there too — not only into the Native-Host store. Without this
    // the next import of the same category never matches and stays ⚪ white.
    const path =
      typeof message.categoryPath === "string" ? message.categoryPath.trim() : "";
    if (res?.ok && res.result?.rule && path) {
      state.categorySettings = dedupeCategorySettings({
        ...state.categorySettings,
        [path]: res.result.rule,
      });
      await persistState(["categorySettings"]);
      broadcastState();
    }
    return res;
  },
  /**
   * V3 **TemplatePinCheck** (Issue #31). Content-side relay to the Native
   * Host verb. Returns ``{ok, result|error}`` with
   * ``result = { easyedaPinCount, templatePinCount, match }``.
   * Used by the Auto-Template-Match heuristic to score Symbol candidates
   * by pin-count; cached client-side per ``(libPath, templateName)``.
   */
  v3TemplatePinCheck: async (message) => nativeHostTemplatePinCheck({
    lcscId: message.lcscId,
    templateName: message.templateName,
    templateLibPath: message.templateLibPath,
  }),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await ensureInitialized();
    const run = RUNTIME_MESSAGE_HANDLERS[message.type];
    if (typeof run !== "function") {
      return null;
    }
    return run(message, sender);
  })()
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((error) => {
      if (state.connected || !isBackendOfflineError(error)) {
        console.error("Message handling failed", error);
      } else if (state.debugLogs) {
        console.warn("Message handling failed (backend offline)", error);
      }
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

self.addEventListener("install", () => {
  if (self.skipWaiting) {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(init());
});

chrome.runtime.onStartup.addListener(() => {
  ensureInitialized();
});

async function validateLibraryDirectory(path) {
  try {
    const validation = await handleValidateLibrary({ path });
    const name = sanitizeLibraryName(deriveLibraryNameFromPath(validation.resolved_path));
    return {
      valid: validation.exists && Boolean(validation.assets?.symbol),
      name: name || "Imported Library",
      path: validation.resolved_path,
      assets: validation.assets,
      counts: validation.counts || { symbol: 0, footprint: 0, model: 0 },
      warnings: validation.warnings,
    };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// Initialize the service worker
ensureInitialized();
