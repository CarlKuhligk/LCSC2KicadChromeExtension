import { describe, it, expect, beforeEach } from "vitest";
import {
  injectPhase2ProgressStyles,
  ensurePhase2ProgressUi,
  setPhase2Progress,
  setPhase2State,
  playPhase2Completion,
  PHASE2_PROGRESS_ATTR,
  PHASE2_BAR_ATTR,
  PHASE2_FILL_ATTR,
  PHASE2_FX_ATTR,
} from "./phase2Progress.js";

function scaffold() {
  const cell = document.createElement("div");
  const status = document.createElement("span");
  status.setAttribute("data-k2c-phase1-status", "idle");
  cell.appendChild(status);
  document.body.appendChild(cell);
  return { cell, status };
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("injectPhase2ProgressStyles", () => {
  it("injects the scoped stylesheet exactly once", () => {
    injectPhase2ProgressStyles(document);
    injectPhase2ProgressStyles(document);
    expect(document.querySelectorAll("#k2c-phase2-progress-style")).toHaveLength(1);
  });
});

describe("ensurePhase2ProgressUi", () => {
  it("builds a bar + fill + fx and adopts the status node as the caption", () => {
    const { cell, status } = scaffold();
    const ui = ensurePhase2ProgressUi(cell, document, status);
    expect(ui).toBeTruthy();
    const container = cell.querySelector(`[${PHASE2_PROGRESS_ATTR}]`);
    expect(container).toBeTruthy();
    expect(container.querySelector(`[${PHASE2_BAR_ATTR}]`)).toBeTruthy();
    expect(container.querySelector(`[${PHASE2_FILL_ATTR}]`)).toBeTruthy();
    expect(container.querySelector(`[${PHASE2_FX_ATTR}]`)).toBeTruthy();
    // status node is now the caption INSIDE the container, below the bar
    expect(container.contains(status)).toBe(true);
    expect(status.classList.contains("k2c-p2-cap")).toBe(true);
    expect(container.getAttribute("data-state")).toBe("loading");
  });

  it("is idempotent and resets state + fill + fx on re-run", () => {
    const { cell, status } = scaffold();
    const ui1 = ensurePhase2ProgressUi(cell, document, status);
    setPhase2Progress(ui1, 80);
    playPhase2Completion(ui1, document);
    expect(cell.querySelectorAll(`[${PHASE2_PROGRESS_ATTR}]`)).toHaveLength(1);

    const ui2 = ensurePhase2ProgressUi(cell, document, status);
    expect(cell.querySelectorAll(`[${PHASE2_PROGRESS_ATTR}]`)).toHaveLength(1); // reused
    expect(ui2.container.getAttribute("data-state")).toBe("loading"); // reset
    expect(ui2.fill.style.width).toBe("0%"); // reset
    expect(ui2.fx.children.length).toBe(0); // FX cleared
  });
});

describe("setPhase2Progress", () => {
  it("sets the fill width and clamps to 0..100", () => {
    const { cell, status } = scaffold();
    const ui = ensurePhase2ProgressUi(cell, document, status);
    setPhase2Progress(ui, 42.6);
    expect(ui.fill.style.width).toBe("43%");
    expect(ui.track.getAttribute("aria-valuenow")).toBe("43");
    setPhase2Progress(ui, 250);
    expect(ui.fill.style.width).toBe("100%");
    setPhase2Progress(ui, -10);
    expect(ui.fill.style.width).toBe("0%");
  });

  it("ignores non-finite progress (keeps the last width)", () => {
    const { cell, status } = scaffold();
    const ui = ensurePhase2ProgressUi(cell, document, status);
    setPhase2Progress(ui, 30);
    setPhase2Progress(ui, NaN);
    setPhase2Progress(ui, null);
    expect(ui.fill.style.width).toBe("30%");
  });
});

describe("setPhase2State", () => {
  it("drives the container data-state", () => {
    const { cell, status } = scaffold();
    const ui = ensurePhase2ProgressUi(cell, document, status);
    setPhase2State(ui, "error");
    expect(ui.container.getAttribute("data-state")).toBe("error");
  });
});

describe("playPhase2Completion", () => {
  it("fills to 100, flips to ok, and spawns the ✓ + ring + confetti burst", () => {
    const { cell, status } = scaffold();
    const ui = ensurePhase2ProgressUi(cell, document, status);
    playPhase2Completion(ui, document);
    expect(ui.container.getAttribute("data-state")).toBe("ok");
    expect(ui.fill.style.width).toBe("100%");
    expect(ui.fx.querySelector(".k2c-p2-check")).toBeTruthy();
    expect(ui.fx.querySelector(".k2c-p2-check").textContent).toBe("✓");
    expect(ui.fx.querySelector(".k2c-p2-ring")).toBeTruthy();
    expect(ui.fx.querySelectorAll(".k2c-p2-particle").length).toBeGreaterThanOrEqual(12);
    // particles carry their own trajectory custom properties
    const p = ui.fx.querySelector(".k2c-p2-particle");
    expect(p.style.getPropertyValue("--dx")).not.toBe("");
    expect(p.style.getPropertyValue("--dy")).not.toBe("");
  });

  it("does not throw on a null ui", () => {
    expect(() => playPhase2Completion(null, document)).not.toThrow();
  });
});
