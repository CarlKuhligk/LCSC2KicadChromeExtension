"use strict";

(function (g) {
  /** Default API base URL — keep in sync with background `DEFAULT_STATE.serverUrl`. */
  g.K2C_DEFAULT_SERVER_URL = "http://localhost:8087";
  g.K2C_EXTENSION_WS_PATH = "/ws/extension";
  g.K2C_HEALTH_INTERVAL_MS = 3000;
  g.K2C_EXT_RECONNECT_MAX_MS = 30000;
  g.K2C_EXT_RECONNECT_INITIAL_MS = 800;

  /**
   * Stable key for the extension WebSocket endpoint.
   * @param {string} [baseUrl]
   * @returns {string}
   */
  g.k2cExtensionSocketEndpointKey = function k2cExtensionSocketEndpointKey(baseUrl) {
    const raw =
      typeof baseUrl === "string" && baseUrl.trim()
        ? baseUrl.trim()
        : g.K2C_DEFAULT_SERVER_URL;
    try {
      const u = new URL(raw.endsWith("/") ? raw : `${raw}/`);
      const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
      return `${wsProto}//${u.host}${g.K2C_EXTENSION_WS_PATH}`;
    } catch {
      return raw.replace(/\/+$/, "");
    }
  };

  /**
   * Full WebSocket URL for the extension client.
   * @param {string} [baseUrl]
   * @returns {string}
   */
  g.k2cExtensionWsUrlFromBase = function k2cExtensionWsUrlFromBase(baseUrl) {
    const raw =
      typeof baseUrl === "string" && baseUrl.trim()
        ? baseUrl.trim()
        : g.K2C_DEFAULT_SERVER_URL;
    let u;
    try {
      u = new URL(raw.endsWith("/") ? raw : `${raw}/`);
    } catch {
      u = new URL(g.K2C_DEFAULT_SERVER_URL);
    }
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProto}//${u.host}${g.K2C_EXTENSION_WS_PATH}`;
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
