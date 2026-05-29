import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  JobStateStore,
  normalizeJobProgressValue,
  classifyJobTier,
  formatStatusColon,
  formatJobStatusMessage,
  progressBarFieldsFromJob,
} from "./jobStateStore.js";

describe("JobStateStore", () => {
  let store;
  let log;

  beforeEach(() => {
    log = vi.fn();
    store = new JobStateStore({ log });
  });

  describe("watcher map", () => {
    it("set/has/get/clear round-trip", () => {
      const watcher = { button: {} };
      store.setWatcher("J1", watcher);
      expect(store.hasWatcher("J1")).toBe(true);
      expect(store.getWatcher("J1")).toBe(watcher);
      store.clearWatcher("J1");
      expect(store.hasWatcher("J1")).toBe(false);
    });

    it("clearWatcher calls clearTimeout on numeric handle entries", () => {
      // Browsers return a number from setTimeout; the store treats those as
      // fall-back watchdog timers and forwards them to clearTimeout. (Node /
      // jsdom returns a Timeout object, which is why we use a sentinel here.)
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      store.setWatcher("J1", 42);
      store.clearWatcher("J1");
      expect(clearSpy).toHaveBeenCalledWith(42);
      clearSpy.mockRestore();
    });

    it("watchedJobIds reflects all live entries", () => {
      store.setWatcher("J1", {});
      store.setWatcher("J2", {});
      expect(store.watchedJobIds().sort()).toEqual(["J1", "J2"]);
    });
  });

  describe("terminal-once", () => {
    it("markTerminal / isTerminalHandled", () => {
      expect(store.isTerminalHandled("J1")).toBe(false);
      store.markTerminal("J1");
      expect(store.isTerminalHandled("J1")).toBe(true);
    });

    it("ignores falsy jobIds", () => {
      store.markTerminal("");
      store.markTerminal(null);
      expect(store.isTerminalHandled("")).toBe(false);
      expect(store.isTerminalHandled(null)).toBe(false);
    });
  });

  describe("confetti-once", () => {
    it("markConfetti / hadConfetti", () => {
      expect(store.hadConfetti("J1")).toBe(false);
      store.markConfetti("J1");
      expect(store.hadConfetti("J1")).toBe(true);
    });
  });

  describe("shouldApplyUpdate (monotone)", () => {
    it("allows queued → running → completed", () => {
      expect(store.shouldApplyUpdate("J1", { status: "queued" })).toBe(true);
      expect(store.shouldApplyUpdate("J1", { status: "running", progress: 10 })).toBe(true);
      expect(store.shouldApplyUpdate("J1", { status: "completed" })).toBe(true);
    });

    it("skips queued snapshot arriving after running", () => {
      store.shouldApplyUpdate("J1", { status: "running", progress: 20 });
      expect(store.shouldApplyUpdate("J1", { status: "queued" })).toBe(false);
      expect(log).toHaveBeenCalledWith("jobUi: skip stale queued after running", "J1");
    });

    it("skips running 0% after a meaningful (≥5%) progress reading", () => {
      store.shouldApplyUpdate("J1", { status: "running", progress: 30 });
      expect(store.shouldApplyUpdate("J1", { status: "running", progress: 0 })).toBe(false);
      expect(log).toHaveBeenCalledWith(
        "jobUi: skip running 0% after meaningful progress",
        "J1",
      );
    });

    it("does NOT skip running 0% before any meaningful progress", () => {
      store.shouldApplyUpdate("J1", { status: "queued" });
      expect(store.shouldApplyUpdate("J1", { status: "running", progress: 0 })).toBe(true);
    });
  });

  describe("reset", () => {
    it("clears every map and any pending timers", () => {
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      store.setWatcher("timer", 42); // numeric watchdog handle (browser shape)
      store.setWatcher("J1", { button: {} });
      store.markTerminal("J1");
      store.markConfetti("J1");
      store.shouldApplyUpdate("J1", { status: "running", progress: 10 });

      store.reset();

      expect(store.hasWatcher("J1")).toBe(false);
      expect(store.hasWatcher("timer")).toBe(false);
      expect(store.isTerminalHandled("J1")).toBe(false);
      expect(store.hadConfetti("J1")).toBe(false);
      expect(clearSpy).toHaveBeenCalledWith(42);
      clearSpy.mockRestore();
    });
  });

  describe("forgetUi", () => {
    it("clears the monotone entry so a fresh job can start over", () => {
      store.shouldApplyUpdate("J1", { status: "running", progress: 50 });
      store.forgetUi("J1");
      // After forgetUi, a queued snapshot is no longer regressive.
      expect(store.shouldApplyUpdate("J1", { status: "queued" })).toBe(true);
    });
  });
});

describe("pure helpers", () => {
  describe("normalizeJobProgressValue", () => {
    it("clamps to [0,100] and accepts numeric strings", () => {
      expect(normalizeJobProgressValue({ progress: 42 })).toBe(42);
      expect(normalizeJobProgressValue({ progress: -5 })).toBe(0);
      expect(normalizeJobProgressValue({ progress: 150 })).toBe(100);
      expect(normalizeJobProgressValue({ progress: "37" })).toBe(37);
      expect(normalizeJobProgressValue({})).toBe(null);
      expect(normalizeJobProgressValue({ Progress: 5 })).toBe(5);
    });
  });

  describe("classifyJobTier", () => {
    it("returns expected tiers", () => {
      expect(classifyJobTier({ status: "queued" })).toBe(1);
      expect(classifyJobTier({ status: "running" })).toBe(2);
      expect(classifyJobTier({ status: "completed" })).toBe(3);
      expect(classifyJobTier({ status: "failed" })).toBe(3);
      expect(classifyJobTier({ status: "weird" })).toBe(0);
      expect(classifyJobTier({})).toBe(0);
    });
  });

  describe("formatStatusColon", () => {
    it("joins with ': ' and degrades when detail is blank", () => {
      expect(formatStatusColon("Lead", "detail")).toBe("Lead: detail");
      expect(formatStatusColon("Lead", "  ")).toBe("Lead");
      expect(formatStatusColon("Lead", null)).toBe("Lead");
    });
  });

  describe("formatJobStatusMessage", () => {
    it("queued without queue position", () => {
      expect(formatJobStatusMessage({ status: "queued" })).toBe("In queue: waiting");
    });

    it("queued with queue position > 1", () => {
      expect(formatJobStatusMessage({ status: "queued", queue_position: 3 })).toBe(
        "In queue: position 3",
      );
    });

    it("running with progress and server message", () => {
      expect(
        formatJobStatusMessage({ status: "running", progress: 42, message: "fetching" }),
      ).toBe("Converting: fetching (42%)");
    });

    it("running with progress only", () => {
      expect(formatJobStatusMessage({ status: "running", progress: 42 })).toBe(
        "Converting: 42%",
      );
    });

    it("running with no progress and no message", () => {
      expect(formatJobStatusMessage({ status: "running" })).toBe("Converting: waiting");
    });
  });

  describe("progressBarFieldsFromJob", () => {
    it("queued is 0", () => {
      expect(progressBarFieldsFromJob({ status: "queued", progress: 50 })).toEqual({
        progress: 0,
      });
    });

    it("running uses clamped progress", () => {
      expect(progressBarFieldsFromJob({ status: "running", progress: 42 })).toEqual({
        progress: 42,
      });
      expect(progressBarFieldsFromJob({ status: "running" })).toEqual({ progress: 0 });
    });
  });
});
