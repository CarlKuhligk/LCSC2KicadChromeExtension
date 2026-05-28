"use strict";

/**
 * Polls the service worker's `getState` RPC until the backend reports
 * `connected` AND the consumer-provided `isStable(state)` predicate returns
 * true (or `maxAttempts` successful polls have elapsed).
 *
 * The monitor itself has no DOM dependencies: any LCSC-page-specific
 * post-connect check (e.g. "wait until the Template button appears") lives
 * in the `isStable` predicate supplied by the caller.
 */
export class BackendStatusMonitor {
  #rpc;
  #intervalMs;
  #maxAttempts;
  #timer = null;
  #attempts = 0;

  /**
   * @param {object} opts
   * @param {{ getState: () => Promise<{ ok: boolean, data?: object }> }} opts.rpc
   * @param {number} [opts.intervalMs=2500]
   * @param {number} [opts.maxAttempts=6]
   */
  constructor({ rpc, intervalMs = 2500, maxAttempts = 6 }) {
    this.#rpc = rpc;
    this.#intervalMs = intervalMs;
    this.#maxAttempts = maxAttempts;
  }

  get running() {
    return this.#timer !== null;
  }

  /**
   * @param {object} opts
   * @param {(state: object) => boolean} opts.isStable
   * @param {(state: object) => void} opts.onTick
   * @returns {() => void} stop function (idempotent).
   */
  start({ isStable, onTick }) {
    if (this.#timer !== null) return () => this.stop();
    this.#attempts = 0;
    this.#timer = setInterval(() => {
      void this.#tick({ isStable, onTick });
    }, this.#intervalMs);
    return () => this.stop();
  }

  stop() {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #tick({ isStable, onTick }) {
    let state;
    try {
      const resp = await this.#rpc.getState();
      if (!resp?.ok || !resp.data?.connected) return;
      state = resp.data;
    } catch (_e) {
      return;
    }
    this.#attempts += 1;
    try {
      onTick(state);
    } catch (_e) {
      /* swallow: UI refresh failure must not stop polling */
    }
    let stable = false;
    try {
      stable = Boolean(isStable(state));
    } catch (_e) {
      stable = true;
    }
    if (stable || this.#attempts >= this.#maxAttempts) {
      this.stop();
    }
  }
}
