"use strict";

/**
 * Cross-cutting state for the Job Progress UI (see CONTEXT.md):
 *
 *   - **jobWatchers** — jobId → { button, … } (entries may also be `setTimeout`
 *     handles used as fall-back watchdogs; `clearWatcher` clears both shapes).
 *   - **terminalHandled** — jobs whose terminal UI (done/error) already ran;
 *     prevents duplicate finalization when both `task_update(done)` and a
 *     polled snapshot arrive.
 *   - **confettiDone** — jobs that already triggered the success confetti.
 *   - **uiMonotone** — per-job high-water mark for status tier (queued < running
 *     < terminal) and progress %. Prevents UI regression when snapshots arrive
 *     out of order (e.g. a delayed `queued` after `running`).
 *
 * Pure data + pure logic — no DOM, no chrome.runtime. The DOM dispatch
 * (markBusy/markDone/markError on the Product Button Group, the progress
 * overlay row, confetti) stays in the caller for now and migrates with the
 * upcoming Product Button Group split.
 */
export class JobStateStore {
  #jobWatchers = new Map();
  #terminalHandled = new Set();
  #confettiDone = new Set();
  #uiMonotone = new Map();
  #log;

  constructor({ log } = {}) {
    this.#log = log ?? (() => {});
  }

  // ---------- watcher map ----------

  setWatcher(jobId, watcher) {
    this.#jobWatchers.set(jobId, watcher);
  }

  getWatcher(jobId) {
    return this.#jobWatchers.get(jobId);
  }

  hasWatcher(jobId) {
    return this.#jobWatchers.has(jobId);
  }

  /** Clears the watcher entry. If the entry is a setTimeout handle, clears the timer too. */
  clearWatcher(jobId) {
    const entry = this.#jobWatchers.get(jobId);
    if (typeof entry === "number") {
      clearTimeout(entry);
    }
    this.#jobWatchers.delete(jobId);
  }

  watchedJobIds() {
    return [...this.#jobWatchers.keys()];
  }

  // ---------- terminal-once ----------

  markTerminal(jobId) {
    if (jobId) this.#terminalHandled.add(jobId);
  }

  isTerminalHandled(jobId) {
    return this.#terminalHandled.has(jobId);
  }

  /** Caller-driven expiration so the set does not grow unboundedly. */
  forgetTerminal(jobId) {
    if (jobId) this.#terminalHandled.delete(jobId);
  }

  // ---------- confetti-once ----------

  markConfetti(jobId) {
    if (jobId) this.#confettiDone.add(jobId);
  }

  hadConfetti(jobId) {
    return this.#confettiDone.has(jobId);
  }

  /** Caller-driven expiration so the set does not grow unboundedly. */
  forgetConfetti(jobId) {
    if (jobId) this.#confettiDone.delete(jobId);
  }

  // ---------- monotone UI ----------

  /**
   * Returns `false` if the update should be skipped (stale / regressive).
   * Skips:
   *   - `queued` snapshots that arrive after we already saw `running`.
   *   - `running` snapshots reporting 0 % after a meaningful (≥ 5 %) progress
   *     reading.
   * Otherwise updates the high-water mark and returns `true`.
   */
  shouldApplyUpdate(jobId, job) {
    if (!this.#uiMonotone.has(jobId)) {
      this.#uiMonotone.set(jobId, { maxTier: 0, maxProgress: 0 });
    }
    const st = this.#uiMonotone.get(jobId);
    const tier = classifyJobTier(job);
    if (tier === 1 && st.maxTier >= 2) {
      this.#log("jobUi: skip stale queued after running", jobId);
      return false;
    }
    const prog = normalizeJobProgressValue(job) ?? 0;
    if (tier === 2 && st.maxProgress >= 5 && prog === 0) {
      this.#log("jobUi: skip running 0% after meaningful progress", jobId);
      return false;
    }
    st.maxTier = Math.max(st.maxTier, tier);
    if (tier === 2) st.maxProgress = Math.max(st.maxProgress, prog);
    return true;
  }

  forgetUi(jobId) {
    if (jobId) this.#uiMonotone.delete(jobId);
  }

  // ---------- full reset (page detach) ----------

  reset() {
    for (const jobId of [...this.#jobWatchers.keys()]) {
      this.clearWatcher(jobId);
    }
    this.#uiMonotone.clear();
    this.#terminalHandled.clear();
    this.#confettiDone.clear();
  }
}

// ---------- pure helpers (exported for use by the dispatch code) ----------

/** Clamps to [0, 100]; returns null when no usable progress is present. */
export function normalizeJobProgressValue(job) {
  const p = job?.progress ?? job?.Progress;
  if (typeof p === "number" && Number.isFinite(p)) return Math.max(0, Math.min(100, p));
  const n = Number(p);
  if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
  return null;
}

/** 0 unknown · 1 queued · 2 running · 3 terminal (completed/failed). */
export function classifyJobTier(job) {
  const s = String(job?.status || "").toLowerCase();
  if (s === "completed" || s === "failed") return 3;
  if (s === "running") return 2;
  if (s === "queued") return 1;
  return 0;
}

/** "Lead: detail" — degrades to just "Lead" when detail is empty. */
export function formatStatusColon(lead, detail) {
  const d = detail != null ? String(detail).trim() : "";
  return d ? `${lead}: ${d}` : lead;
}

/** Status-line text for queued / running / other jobs. */
export function formatJobStatusMessage(job) {
  const s = String(job?.status || "").toLowerCase();
  const qp = job?.queue_position != null ? Number(job.queue_position) : null;
  const prog = normalizeJobProgressValue(job);
  if (s === "queued") {
    if (Number.isFinite(qp) && qp > 1) return formatStatusColon("In queue", `position ${qp}`);
    return formatStatusColon("In queue", "waiting");
  }
  if (s === "running") {
    const serverMsg = typeof job.message === "string" && job.message.trim() ? job.message.trim() : "";
    const pctKnown = prog != null && Number.isFinite(prog);
    const pct = pctKnown ? Math.round(Math.max(0, Math.min(100, prog))) : null;
    if (pct != null) {
      if (serverMsg) return formatStatusColon("Converting", `${serverMsg} (${pct}%)`);
      return formatStatusColon("Converting", `${pct}%`);
    }
    return serverMsg ? formatStatusColon("Converting", serverMsg) : formatStatusColon("Converting", "waiting");
  }
  return formatStatusColon("Status", "working");
}

/** `{ progress: number }` derived from job state — always 0..100. */
export function progressBarFieldsFromJob(job) {
  const s = String(job?.status || "").toLowerCase();
  const prog = normalizeJobProgressValue(job);
  if (s === "queued") return { progress: 0 };
  if (s === "running") {
    const p = prog ?? 0;
    return { progress: Math.max(0, Math.min(100, p)) };
  }
  return { progress: prog ?? 0 };
}
