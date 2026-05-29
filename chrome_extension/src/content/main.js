"use strict";

import "./app.js";
import { prewarmNativeHost } from "./nativeHostStatusButton.js";
import { contentRpc, k2cRpc } from "./rpc.js";

/**
 * V3 Pre-Warm trigger (V3-SPEC.md §3) — fire the Native-Host wake-up as the
 * very first thing the content script does on LCSC page load. The service
 * worker opens the Native-Messaging port; Python is hot by the time the user
 * clicks Download. The promise is unawaited — `attachNativeHostStatus` on the
 * Anchor Card button will run its own prewarm and observe the cached result.
 */
prewarmNativeHost((payload) => contentRpc(payload.type, payload, k2cRpc(2, 200)))
  .catch(() => { /* status update arrives via the broadcast listener */ });
