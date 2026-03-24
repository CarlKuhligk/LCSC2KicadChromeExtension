"use strict";

/**
 * Extension ↔ backend WebSocket (`/ws/extension`) client: JSON-RPC multiplex + `task_update` pushes.
 *
 * Loaded via importScripts after {@link ./shared/extensionDefaults.js}. Depends on
 * {@link globalThis.k2cExtensionWsHooks} assigned from background.js before `connectExtensionSocket` runs.
 */

let extWs = null;
const extPending = new Map();
let extRpcSeq = 0;
let extReconnectTimer = null;
let extReconnectDelayMs =
  typeof globalThis.K2C_EXT_RECONNECT_INITIAL_MS === "number"
    ? globalThis.K2C_EXT_RECONNECT_INITIAL_MS
    : 800;
let extWsUnreachableNotified = false;

function wsHooks() {
  return globalThis.k2cExtensionWsHooks;
}

function reconnectInitialMs() {
  return typeof globalThis.K2C_EXT_RECONNECT_INITIAL_MS === "number"
    ? globalThis.K2C_EXT_RECONNECT_INITIAL_MS
    : 800;
}

function reconnectMaxMs() {
  return typeof globalThis.K2C_EXT_RECONNECT_MAX_MS === "number"
    ? globalThis.K2C_EXT_RECONNECT_MAX_MS
    : 30000;
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
  const H = wsHooks();
  if (!H || !H.extConnectIntent || !H.extConnectIntent()) {
    return;
  }
  if (extReconnectTimer) {
    return;
  }
  extReconnectTimer = setTimeout(() => {
    extReconnectTimer = null;
    connectExtensionSocket();
  }, extReconnectDelayMs);
  extReconnectDelayMs = Math.min(extReconnectDelayMs * 2, reconnectMaxMs());
}

function scheduleExtensionReconnectIfIdle() {
  const H = wsHooks();
  if (!H || !H.extConnectIntent || !H.extConnectIntent()) {
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

function connectExtensionSocket() {
  const H = wsHooks();
  if (!H) {
    return;
  }
  if (!H.extConnectIntent || !H.extConnectIntent()) {
    return;
  }
  if (extWs && (extWs.readyState === WebSocket.OPEN || extWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  closeExtensionSocket();
  const url = globalThis.k2cExtensionWsUrlFromBase(H.getServerUrl());
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    H.setConnected(false);
    H.updateBadge();
    H.broadcastState();
    scheduleExtensionReconnect();
    return;
  }
  extWs = ws;

  ws.onopen = async () => {
    extReconnectDelayMs = reconnectInitialMs();
    extWsUnreachableNotified = false;
    H.setConnectionHint(null);
    H.setConnected(true);
    H.updateBadge();
    H.broadcastState();
    try {
      await sendExtensionRpc("ping", {}, 5000);
    } catch (e) {
      if (H.getDebugLogs()) {
        console.warn("extension WS ping after open failed", e);
      }
    }
    try {
      await H.inventoryLibraries();
    } catch (error) {
      console.warn("Library inventory failed after WS connect", error);
    }
    try {
      await H.refreshTemplateStatus();
    } catch (error) {
      if (H.getDebugLogs()) {
        console.warn("Template status refresh failed after WS connect", error);
      }
    }
    try {
      await H.syncExistingTasks();
    } catch (error) {
      console.warn("syncExistingTasks failed after WS connect", error);
    }
    H.broadcastState();
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
        H.kpiJobLog("← RPC error", msg.id, errText);
        pending.reject(new Error(errText));
      } else {
        H.kpiJobVerbose("← RPC ok", msg.id, msg.result);
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.type === "task_update" && msg.task_id && msg.payload) {
      void H.handleExtensionTaskPush(msg.task_id, msg.payload);
      return;
    }
    H.kpiJobVerbose("ws inbound (ignored shape)", Object.keys(msg));
  };

  ws.onerror = () => {
    /* onclose will run */
  };

  ws.onclose = () => {
    extWs = null;
    H.setConnected(false);
    if (H.extConnectIntent && H.extConnectIntent()) {
      H.setConnectionHint(
        "Cannot reach the backend (connection refused or closed). Start the easyeda2kicad API or check Backend URL in Settings.",
      );
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
    H.updateBadge();
    H.broadcastState();
    scheduleExtensionReconnect();
  };
}

function sendExtensionRpc(method, params, timeoutMs = 45000) {
  const H = wsHooks();
  return new Promise((resolve, reject) => {
    if (!H) {
      reject(new Error("Extension not initialized."));
      return;
    }
    if (!extWs || extWs.readyState !== WebSocket.OPEN) {
      H.kpiJobLog("sendExtensionRpc: socket not open", method, {
        readyState: extWs ? extWs.readyState : null,
      });
      reject(new Error("Backend not connected."));
      return;
    }
    const id = `r-${Date.now()}-${++extRpcSeq}`;
    H.kpiJobVerbose("→ RPC", method, "id=", id, params);
    const timer = setTimeout(() => {
      if (extPending.has(id)) {
        extPending.delete(id);
        H.kpiJobLog("sendExtensionRpc: timeout", method, id, timeoutMs);
        reject(new Error("Request timeout."));
      }
    }, timeoutMs);
    extPending.set(id, { resolve, reject, timer });
    try {
      extWs.send(JSON.stringify({ id, method, params: params || {} }));
    } catch (e) {
      clearTimeout(timer);
      extPending.delete(id);
      H.kpiJobLog("sendExtensionRpc: send failed", method, e);
      reject(e);
    }
  });
}

globalThis.k2cExtensionWs = {
  closeExtensionSocket,
  scheduleExtensionReconnect,
  scheduleExtensionReconnectIfIdle,
  connectExtensionSocket,
  sendExtensionRpc,
  isOpen() {
    return Boolean(extWs && extWs.readyState === WebSocket.OPEN);
  },
  resetReconnectDelay() {
    extReconnectDelayMs = reconnectInitialMs();
  },
};
