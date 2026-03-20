"use strict";

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

/** LCSC category breadcrumb → canonical `A/B/C`. Keep in sync with contentScript `normalizeCategoryPath`. */
function normalizeCategoryPath(raw) {
  if (raw == null || typeof raw !== "string") return "";
  return raw
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}

/**
 * Deepest match: longest stored key K with pagePath === K or pagePath.startsWith(K + "/").
 * Legacy: slashless keys match the old 2nd segment (index 1), like built-in Resistors/Capacitors.
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

  const segments = pagePath.split("/");
  if (segments.length >= 2) {
    const seg1 = segments[1];
    bestLen = -1;
    bestKey = null;
    for (const [keyRaw] of entries) {
      const K = normalizeCategoryPath(keyRaw);
      if (!K || K.includes("/")) continue;
      if (seg1 === K) {
        bumpPrefixWinner(keyRaw, K);
      }
    }
  }

  if (bestKey != null) {
    return { key: bestKey, config: categorySettings[bestKey] };
  }

  return null;
}

const HISTORY_LIMIT = 30;
/** Tabs whose URL starts with one of these receive `stateUpdate` / `jobTerminal` (matches host_permissions). */
const LCSC_PAGE_URL_PREFIXES = ["https://www.lcsc.com", "https://lcsc.com"];
const HEALTH_INTERVAL = 3000;
const EXT_RECONNECT_MAX_MS = 30000;
const EXT_RECONNECT_INITIAL_MS = 800;

const DEFAULT_STATE = {
  serverUrl: "http://localhost:8087",
  libraries: [],
  jobHistory: [],
  jobMeta: {},
  overwriteFootprints: false,
  overwriteModels: false,
  debugLogs: false,
  projectRelative: false,
  projectRelativePath: "",
  libraryTotals: { symbols: 0, footprints: 0, models: 0 },
  categorySettings: {
    Resistors: { hidePinNumbers: true, hidePinNames: true, valueParam: "Resistance" },
    Capacitors: { hidePinNumbers: true, hidePinNames: true, valueParam: "Capacitance" },
    Inductors: { hidePinNumbers: true, hidePinNames: true, valueParam: "Inductance" },
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
};

let healthTimer = null;
let initialized = false;

// =============================================================================
// Extension WebSocket client (`/ws/extension`) — JSON-RPC, task_update pushes
// =============================================================================

/** Multiplexed backend WebSocket (`/ws/extension`) — no HTTP polling. */
let extWs = null;
const extPending = new Map();
let extRpcSeq = 0;
let extConnectIntent = true;
let extReconnectTimer = null;
let extReconnectDelayMs = EXT_RECONNECT_INITIAL_MS;
/** Avoid duplicate finalize when multiple terminal pushes arrive. */
const extensionTerminalHandled = new Set();
/** Log one friendly explanation per offline stint (Chrome still logs net::ERR_* per attempt). */
let extWsUnreachableNotified = false;

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
  const projectRelative = normalizeBoolean(
    raw.projectRelative ?? raw.project_relative,
    false
  );
  const projectRelativePath = normalizeProjectRelativePath(
    raw.projectRelativePath ?? raw.project_relative_path ?? ""
  );
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
      libraryTotals: stored.libraryTotals || { symbols: 0, footprints: 0, models: 0 },
      categorySettings:
        stored.categorySettings && typeof stored.categorySettings === "object"
          ? { ...DEFAULT_STATE.categorySettings, ...stored.categorySettings }
          : { ...DEFAULT_STATE.categorySettings },
    };
    recalcLibraryTotals();
    await ensureSelectedLibrary(true);
  } catch (error) {
    console.warn("Failed to load stored state", error);
  }

  extConnectIntent = true;
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
  let u;
  try {
    u = new URL(base);
  } catch {
    u = new URL(DEFAULT_STATE.serverUrl);
  }
  const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${u.host}/ws/extension`;
}

function closeExtensionSocket() {
  if (extReconnectTimer) {
    clearTimeout(extReconnectTimer);
    extReconnectTimer = null;
  }
  if (extWs) {
    try {
      extWs.onclose = null;
      extWs.close();
    } catch (_) {
      /* ignore */
    }
    extWs = null;
  }
  extPending.forEach(({ reject }) => {
    try {
      reject(new Error("WebSocket closed."));
    } catch (_) {
      /* ignore */
    }
  });
  extPending.clear();
}

function scheduleExtensionReconnect() {
  if (!extConnectIntent) {
    return;
  }
  if (extReconnectTimer) {
    return;
  }
  extReconnectTimer = setTimeout(() => {
    extReconnectTimer = null;
    connectExtensionSocket();
  }, extReconnectDelayMs);
  extReconnectDelayMs = Math.min(extReconnectDelayMs * 2, EXT_RECONNECT_MAX_MS);
}

/** Schedule reconnect only if idle (not already connecting and no timer). Avoids piling new sockets on the 3s health tick. */
function scheduleExtensionReconnectIfIdle() {
  if (!extConnectIntent) {
    return;
  }
  if (extWs && (extWs.readyState === WebSocket.OPEN || extWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (extReconnectTimer) {
    return;
  }
  scheduleExtensionReconnect();
}

// --- connect / reconnect / onmessage routing ---
function connectExtensionSocket() {
  if (!extConnectIntent) {
    return;
  }
  if (extWs && (extWs.readyState === WebSocket.OPEN || extWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  closeExtensionSocket();
  const url = extensionWsUrl();
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    state.connected = false;
    updateBadge();
    broadcastState();
    scheduleExtensionReconnect();
    return;
  }
  extWs = ws;

  ws.onopen = async () => {
    extReconnectDelayMs = EXT_RECONNECT_INITIAL_MS;
    extWsUnreachableNotified = false;
    state.connectionHint = null;
    state.connected = true;
    updateBadge();
    broadcastState();
    try {
      await sendExtensionRpc("ping", {}, 5000);
    } catch (e) {
      if (state.debugLogs) {
        console.warn("extension WS ping after open failed", e);
      }
    }
    try {
      await inventoryLibraries();
    } catch (error) {
      console.warn("Library inventory failed after WS connect", error);
    }
    try {
      await refreshTemplateStatus();
    } catch (error) {
      if (state.debugLogs) {
        console.warn("Template status refresh failed after WS connect", error);
      }
    }
    try {
      await syncExistingTasks();
    } catch (error) {
      console.warn("syncExistingTasks failed after WS connect", error);
    }
    broadcastState();
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg == null || typeof msg !== "object") {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(msg, "id") && extPending.has(msg.id)) {
      const pending = extPending.get(msg.id);
      extPending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const errText = msg.error.message || "RPC error";
        kpiJobLog("← RPC error", msg.id, errText);
        pending.reject(new Error(errText));
      } else {
        kpiJobVerbose("← RPC ok", msg.id, msg.result);
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.type === "task_update" && msg.task_id && msg.payload) {
      void handleExtensionTaskPush(msg.task_id, msg.payload);
      return;
    }
    kpiJobVerbose("ws inbound (ignored shape)", Object.keys(msg));
  };

  ws.onerror = () => {
    /* onclose will run */
  };

  ws.onclose = () => {
    extWs = null;
    state.connected = false;
    if (extConnectIntent) {
      state.connectionHint =
        "Cannot reach the backend (connection refused or closed). Start the easyeda2kicad API or check Backend URL in Settings.";
      if (!extWsUnreachableNotified) {
        extWsUnreachableNotified = true;
        console.info(
          "[KiCad Parts Importer] Backend WebSocket unreachable — start the easyeda2kicad API or fix the Backend URL. "
            + "(Chrome may still log net::ERR_CONNECTION_REFUSED for each reconnect attempt.)",
        );
      }
    }
    extPending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      try {
        reject(new Error("WebSocket closed."));
      } catch (_) {
        /* ignore */
      }
    });
    extPending.clear();
    updateBadge();
    broadcastState();
    scheduleExtensionReconnect();
  };
}

function sendExtensionRpc(method, params, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    if (!extWs || extWs.readyState !== WebSocket.OPEN) {
      kpiJobLog("sendExtensionRpc: socket not open", method, {
        readyState: extWs ? extWs.readyState : null,
      });
      reject(new Error("Backend not connected."));
      return;
    }
    const id = `r-${Date.now()}-${++extRpcSeq}`;
    kpiJobVerbose("→ RPC", method, "id=", id, params);
    const timer = setTimeout(() => {
      if (extPending.has(id)) {
        extPending.delete(id);
        kpiJobLog("sendExtensionRpc: timeout", method, id, timeoutMs);
        reject(new Error("Request timeout."));
      }
    }, timeoutMs);
    extPending.set(id, { resolve, reject, timer });
    try {
      extWs.send(JSON.stringify({ id, method, params: params || {} }));
    } catch (e) {
      clearTimeout(timer);
      extPending.delete(id);
      kpiJobLog("sendExtensionRpc: send failed", method, e);
      reject(e);
    }
  });
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

async function refreshTemplateStatus() {
  const libPaths = getTemplateLibraryPaths();
  state.templateLibraryPath = libPaths.length ? libPaths[0] : null;
  state.templateSymbols = [];
  state.templateSymbolsByLib = {};
  if (!libPaths.length) {
    broadcastState();
    return;
  }
  const allNames = new Set();
  try {
    for (const libPath of libPaths) {
      const data = await sendExtensionRpc(
        "templates_symbols",
        { lib_path: libPath },
        60000,
      );
      const symbols = Array.isArray(data.symbols) ? data.symbols : [];
      state.templateSymbolsByLib[libPath] = symbols;
      symbols.forEach((name) => allNames.add(name));
    }
    state.templateSymbols = Array.from(allNames).sort();
    broadcastState();
  } catch (error) {
    state.templateSymbols = [];
    state.templateSymbolsByLib = {};
    if (state.debugLogs) {
      console.warn("Template symbols refresh failed", error);
    }
    broadcastState();
  }
}

async function checkHealth() {
  try {
    if (!extWs || extWs.readyState !== WebSocket.OPEN) {
      connectExtensionSocket();
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const tick = () => {
          if (extWs && extWs.readyState === WebSocket.OPEN) {
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
        if (extWs && extWs.readyState === WebSocket.OPEN) {
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
  }, HEALTH_INTERVAL);
}

async function syncExistingTasks() {
  if (!extWs || extWs.readyState !== WebSocket.OPEN) {
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
    && extWs
    && extWs.readyState === WebSocket.OPEN
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
    overwriteFootprints: state.overwriteFootprints,
    overwriteModels: state.overwriteModels,
    debugLogs: state.debugLogs,
    projectRelative: state.projectRelative,
    projectRelativePath: state.projectRelativePath,
    categorySettings: { ...state.categorySettings },
    templateSymbols: (state.templateSymbols || []).slice(),
    templateSymbolsByLib: state.templateSymbolsByLib ? { ...state.templateSymbolsByLib } : {},
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
        if (!LCSC_PAGE_URL_PREFIXES.some((prefix) => u.startsWith(prefix))) {
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
          .filter(([k, v]) => k !== valueParam && v != null && v !== "")
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
    project_relative: Boolean(payload.projectRelative),
    project_relative_path: normalizeProjectRelativePath(payload.projectRelativePath),
    model_path: typeof payload.modelPath === "string" ? payload.modelPath : "",
    hide_pin_numbers: hidePinNumbers,
    hide_pin_names: hidePinNames,
    ...(symbolValueOverride ? { symbol_value_override: symbolValueOverride } : {}),
    ...(symbolParams && Object.keys(symbolParams).length > 0 ? { symbol_params: symbolParams } : {}),
    ...(payload.description ? { symbol_description: payload.description } : {}),
    ...(payload.datasheetUrl ? { symbol_datasheet_url: payload.datasheetUrl } : {}),
    use_template: Boolean(payload.useTemplate),
    ...(payload.templateName ? { template_name: payload.templateName } : {}),
    ...(payload.useTemplate && (payload.templateLibPath || getTemplateLibraryPath())
      ? { template_lib_path: payload.templateLibPath || getTemplateLibraryPath() }
      : {}),
    force_template: Boolean(payload.forceTemplate),
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
  const scaffold = await scaffoldLibraryOnServer({
    base_path: basePath,
    library_name: name,
    symbol: payload.symbol !== false,
    footprint: payload.footprint !== false,
    model: Boolean(payload.model),
    project_relative: Boolean(payload.projectRelative),
  });
  const projectRelative = normalizeBoolean(payload.projectRelative);
  const projectRelativePath = normalizeProjectRelativePath(
    payload.projectRelativePath || (projectRelative ? state.projectRelativePath : "")
  );
  const now = new Date().toISOString();
  const existing = state.libraries.find(
    (library) => library.path === normalizePath(scaffold.resolved_library_prefix),
  );
  const record = {
    id: existing?.id || createLibraryId(),
    name,
    basePath,
    path: normalizePath(scaffold.resolved_library_prefix),
    resolvedPrefix: normalizePath(scaffold.resolved_library_prefix),
    symbolPath: normalizePath(scaffold.symbol_path || `${scaffold.resolved_library_prefix}.kicad_sym`),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    active: true,
    assets: {
      symbol: Boolean(scaffold.symbol_path),
      footprint: Boolean(scaffold.footprint_dir),
      model: Boolean(scaffold.model_dir),
    },
    counts: {
      symbol: scaffold.symbol_path ? 1 : 0,
      footprint: 0,
      model: 0,
    },
    warnings: [],
    projectId: payload.projectId || existing?.projectId || "default",
    projectRelative,
    projectRelativePath,
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

  const validation = await validateLibraryOnServer(symbolPath);
  if (!validation.exists || !validation.assets?.symbol) {
    throw new Error("The selected file is not a valid library.");
  }

  const resolvedSymbol = normalizePath(validation.resolved_path || symbolPath);
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
  const projectRelative = normalizeBoolean(
    payload.projectRelative ?? existing?.projectRelative,
    false
  );
  const projectRelativePath = normalizeProjectRelativePath(
    payload.projectRelativePath ?? existing?.projectRelativePath ?? ""
  );
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
      symbol: Boolean(validation.assets?.symbol),
      footprint: Boolean(validation.assets?.footprint),
      model: Boolean(validation.assets?.model),
    },
    counts: {
      symbol: Number(validation.counts?.symbol) || (validation.assets?.symbol ? 1 : 0),
      footprint: Number(validation.counts?.footprint) || 0,
      model: Number(validation.counts?.model) || 0,
    },
    warnings: Array.isArray(validation.warnings) ? validation.warnings : [],
    projectId: payload.projectId || existing?.projectId || "default",
    projectRelative,
    projectRelativePath,
    modelPath: typeof validation.model_path === "string" ? validation.model_path.trim() : "",
    missing: !validation.exists,
    lastValidation: now,
  };
  const stored = upsertLibraryRecord(record);
  await ensureSelectedLibrary();
  await persistState(["libraries", "libraryTotals"]);
  broadcastState();
  return stored;
}

async function handleValidateLibrary(payload = {}) {
  const rawPath = typeof payload.path === "string" ? payload.path : "";
  const prefix = normalizePath(rawPath);
  if (!prefix) {
    throw new Error("Please provide a path.");
  }
  return validateLibraryOnServer(prefix);
}

async function fetchRoots() {
  return sendExtensionRpc("fs_roots", {}, 30000);
}

async function fetchDirectory(path) {
  return sendExtensionRpc("fs_list", { path }, 30000);
}

async function checkPath(path) {
  return sendExtensionRpc("fs_check", { path }, 30000);
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
    return snapshotState();
  },
  setServerUrl: async (message) => {
    state.serverUrl = message.url || DEFAULT_STATE.serverUrl;
    await persistState(["serverUrl"]);
    closeExtensionSocket();
    extReconnectDelayMs = EXT_RECONNECT_INITIAL_MS;
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
  updateSettings: async (message) => {
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
    if (message.categorySettings && typeof message.categorySettings === "object") {
      state.categorySettings = { ...message.categorySettings };
    }
    await persistState([
      "serverUrl",
      "overwriteFootprints",
      "overwriteModels",
      "debugLogs",
      "projectRelative",
      "projectRelativePath",
      "categorySettings",
    ]);
    if (typeof message.serverUrl === "string") {
      closeExtensionSocket();
      extReconnectDelayMs = EXT_RECONNECT_INITIAL_MS;
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
    const projectRelative = selectedLibrary
      ? normalizeBoolean(selectedLibrary.projectRelative, false)
      : Boolean(state.projectRelative);
    const projectRelativePath = selectedLibrary
      ? normalizeProjectRelativePath(
          selectedLibrary.projectRelativePath || state.projectRelativePath
        )
      : normalizeProjectRelativePath(state.projectRelativePath);
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
      projectRelative,
      projectRelativePath,
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
    state.categorySettings = {
      ...state.categorySettings,
      [cat]: {
        hidePinNumbers: Boolean(cfg.hidePinNumbers),
        hidePinNames: Boolean(cfg.hidePinNames),
        valueParam: typeof cfg.valueParam === "string" ? cfg.valueParam.trim() || null : null,
      },
    };
    await persistState(["categorySettings"]);
    broadcastState();
    return state.categorySettings[cat];
  },
  getTemplateStatus: async () =>
    Object.fromEntries((state.templateSymbols || []).map((n) => [n, true])),
  templatesPinCheck: async (message) => {
    const lcscId = (message.lcscId || "").trim().toUpperCase();
    const templateName = typeof message.templateName === "string" ? message.templateName.trim() : "";
    const templateLibPath = typeof message.templateLibPath === "string" ? message.templateLibPath.trim() : "";
    if (!lcscId || !lcscId.startsWith("C") || !templateName || !templateLibPath) {
      throw new Error("templatesPinCheck requires lcscId, templateName, and templateLibPath.");
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
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    await ensureInitialized();
    const run = RUNTIME_MESSAGE_HANDLERS[message.type];
    if (typeof run !== "function") {
      return null;
    }
    return run(message);
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
