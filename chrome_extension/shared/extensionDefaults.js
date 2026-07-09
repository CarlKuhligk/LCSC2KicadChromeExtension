"use strict";

(function (g) {
  /** How often the service worker pings the Native Host for its status. */
  g.K2C_HEALTH_INTERVAL_MS = 3000;
})(typeof globalThis !== "undefined" ? globalThis : this);
