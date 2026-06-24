"use strict";

/**
 * V3 **Phase 2 progress UI** — a lovingly-designed inline progress surface for
 * the on-page conversion: a real progress BAR with a small caption beneath it
 * ("what is happening right now"), plus a spectacular completion animation
 * (fill-to-100 + shimmer, a popping ✓ with a pulse ring, and a confetti burst).
 *
 * It wraps the existing single-line status node (kept as the caption so the
 * Phase-1/Phase-2 text contract and tests are unchanged) inside a small column:
 *
 *   [data-k2c-phase2-progress]              ← container (column)
 *     ├ [data-k2c-phase2-bar]   .k2c-p2-track   ← track
 *     │   └ [data-k2c-phase2-fill] .k2c-p2-fill ← fill (width = percent)
 *     │   └ [data-k2c-phase2-fx]               ← completion FX layer
 *     └ <status node> (the caption text)
 *
 * Self-contained: one injected <style> (keyframes + theme via prefers-color-scheme
 * + prefers-reduced-motion). No page-style clobbering — everything is scoped to
 * the ``k2c-p2-*`` class prefix / ``data-k2c-phase2-*`` attributes.
 */

export const PHASE2_PROGRESS_ATTR = "data-k2c-phase2-progress";
export const PHASE2_BAR_ATTR = "data-k2c-phase2-bar";
export const PHASE2_FILL_ATTR = "data-k2c-phase2-fill";
export const PHASE2_FX_ATTR = "data-k2c-phase2-fx";

const STYLE_ID = "k2c-phase2-progress-style";

const PARTICLE_COLORS = [
  "#22c55e", "#4ade80", "#facc15", "#38bdf8", "#f472b6", "#a78bfa", "#fb923c",
];

const STYLE_TEXT = `
[${PHASE2_PROGRESS_ATTR}] {
  display: block;
  width: 100%;
  max-width: 300px;
  margin-top: 8px;
  box-sizing: border-box;
  font-family: system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
}
.k2c-p2-track {
  position: relative;
  width: 100%;
  height: 8px;
  border-radius: 999px;
  background: rgba(148,163,184,0.28);
  overflow: hidden;
}
.k2c-p2-fill {
  position: relative;
  height: 100%;
  width: 100%;
  transform: scaleX(0);
  transform-origin: left;
  border-radius: 999px;
  background: linear-gradient(90deg,#60a5fa,#2563eb);
  transition: transform 0.35s cubic-bezier(0.22,1,0.36,1), background 0.3s ease;
}
/* moving sheen on the fill while loading */
.k2c-p2-fill::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent);
  transform: translateX(-100%);
}
[${PHASE2_PROGRESS_ATTR}][data-state="loading"] .k2c-p2-fill::after {
  animation: k2c-p2-sheen 1.1s linear infinite;
}
[${PHASE2_PROGRESS_ATTR}][data-state="ok"] .k2c-p2-fill {
  background: linear-gradient(90deg,#4ade80,#16a34a);
}
[${PHASE2_PROGRESS_ATTR}][data-state="error"] .k2c-p2-fill {
  background: linear-gradient(90deg,#f87171,#dc2626);
}
/* Indeterminate: a segment slides across the track while the backend works but
   has not reported a determinate percent yet. Transform-only (no layout). */
.k2c-p2-track.is-indeterminate .k2c-p2-fill { opacity: 0; }
.k2c-p2-track.is-indeterminate::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 40%;
  border-radius: 999px;
  background: linear-gradient(90deg,#60a5fa,#2563eb);
  animation: k2c-p2-indet 1.3s ease-in-out infinite;
}
.k2c-p2-fx {
  position: absolute;
  top: 50%;
  left: 0;
  width: 100%;
  height: 0;
  pointer-events: none;
}
.k2c-p2-check {
  position: absolute;
  right: -2px;
  top: 50%;
  width: 22px;
  height: 22px;
  margin-top: -11px;
  border-radius: 50%;
  background: #16a34a;
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  line-height: 22px;
  text-align: center;
  box-shadow: 0 2px 10px rgba(22,163,74,0.55);
  /* Bounce comes from the keyframe scale (1.45), not the easing — keeps the
     impeccable bounce-easing rule happy. After the pop, two slow glow breaths. */
  animation: k2c-p2-pop 0.5s cubic-bezier(0.22,1,0.36,1) both,
             k2c-p2-glow 1.5s ease-in-out 0.5s 2 both;
}
.k2c-p2-ring {
  position: absolute;
  right: 9px;
  top: 50%;
  width: 22px;
  height: 22px;
  margin: -11px -11px 0 0;
  border-radius: 50%;
  border: 2px solid #4ade80;
  animation: k2c-p2-ring 1.15s ease-out both;
}
.k2c-p2-particle {
  position: absolute;
  left: 50%;
  top: 0;
  width: 7px;
  height: 7px;
  border-radius: 2px;
  animation: k2c-p2-particle 1.35s cubic-bezier(0.16,0.7,0.3,1) both;
}
.k2c-p2-cap {
  display: block;
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.35;
  color: #475569;
  word-break: break-word;
}
@keyframes k2c-p2-sheen { to { transform: translateX(220%); } }
@keyframes k2c-p2-indet {
  0%   { transform: translateX(-120%); }
  100% { transform: translateX(310%); }
}
@keyframes k2c-p2-pop {
  0%   { transform: scale(0) rotate(-45deg); opacity: 0; }
  45%  { transform: scale(1.45) rotate(12deg); opacity: 1; }
  70%  { transform: scale(0.9) rotate(-4deg); opacity: 1; }
  100% { transform: scale(1) rotate(0); opacity: 1; }
}
@keyframes k2c-p2-glow {
  0%, 100% { box-shadow: 0 2px 10px rgba(22,163,74,0.45); transform: scale(1); }
  50%      { box-shadow: 0 5px 20px rgba(22,163,74,0.78); transform: scale(1.08); }
}
@keyframes k2c-p2-ring {
  0%   { transform: scale(0.4); opacity: 0.7; }
  100% { transform: scale(3.4); opacity: 0; }
}
@keyframes k2c-p2-particle {
  0%   { transform: translate(0,0) scale(1) rotate(0); opacity: 1; }
  100% { transform: translate(var(--dx,0), var(--dy,0)) scale(0.2) rotate(var(--rot,180deg)); opacity: 0; }
}
@media (prefers-color-scheme: dark) {
  .k2c-p2-track { background: rgba(148,163,184,0.22); }
  .k2c-p2-cap { color: #cbd5e1; }
}
@media (prefers-reduced-motion: reduce) {
  .k2c-p2-fill { transition: none; }
  .k2c-p2-fill::after,
  [${PHASE2_PROGRESS_ATTR}][data-state="loading"] .k2c-p2-fill::after { animation: none; }
  .k2c-p2-track.is-indeterminate::before { animation: none; left: 30%; }
  .k2c-p2-check { animation: none; }
  .k2c-p2-ring, .k2c-p2-particle { display: none; }
}
`;

/** Inject the scoped stylesheet once per document. */
export function injectPhase2ProgressStyles(doc = document) {
  if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  doc.head.appendChild(style);
}

/**
 * Build (idempotently) the progress container around the existing status node.
 * The status node becomes the caption beneath the bar. Re-running resets any
 * leftover completion FX + state so a re-import starts clean.
 *
 * @param {HTMLElement} actionsCell
 * @param {Document} doc
 * @param {HTMLElement} statusNode  the shared Phase-1/2 status <span> (caption)
 * @returns {{container: HTMLElement, track: HTMLElement, fill: HTMLElement, fx: HTMLElement, caption: HTMLElement}|null}
 */
export function ensurePhase2ProgressUi(actionsCell, doc = document, statusNode = null) {
  if (!actionsCell) return null;
  injectPhase2ProgressStyles(doc);
  let container = actionsCell.querySelector(`[${PHASE2_PROGRESS_ATTR}]`);
  let track, fill, fx;
  if (!container) {
    container = doc.createElement("div");
    container.setAttribute(PHASE2_PROGRESS_ATTR, "true");
    container.setAttribute("data-state", "loading");
    track = doc.createElement("div");
    track.setAttribute(PHASE2_BAR_ATTR, "true");
    track.className = "k2c-p2-track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    fill = doc.createElement("div");
    fill.setAttribute(PHASE2_FILL_ATTR, "true");
    fill.className = "k2c-p2-fill";
    fx = doc.createElement("div");
    fx.setAttribute(PHASE2_FX_ATTR, "true");
    fx.className = "k2c-p2-fx";
    track.appendChild(fill);
    track.appendChild(fx);
    container.appendChild(track);
    actionsCell.appendChild(container);
  } else {
    track = container.querySelector(`[${PHASE2_BAR_ATTR}]`);
    fill = container.querySelector(`[${PHASE2_FILL_ATTR}]`);
    fx = container.querySelector(`[${PHASE2_FX_ATTR}]`);
    container.setAttribute("data-state", "loading");
    if (fx) fx.innerHTML = "";
    if (fill) fill.style.transform = "scaleX(0)";
  }
  // Adopt the status node as the caption (move it under the bar + restyle).
  if (statusNode) {
    statusNode.classList.add("k2c-p2-cap");
    statusNode.style.cssText = "";
    container.appendChild(statusNode);
  }
  return { container, track, fill, fx, caption: statusNode };
}

/** Set the bar fill to ``pct`` (0..100). Out-of-range / non-finite is ignored. */
export function setPhase2Progress(ui, pct) {
  if (!ui || !ui.fill) return;
  if (pct == null) return; // null/undefined progress → keep the current width
  const n = Number(pct);
  if (!Number.isFinite(n)) return;
  const clamped = Math.max(0, Math.min(100, Math.round(n)));
  // A real percent means we can show determinate progress — drop indeterminate.
  if (ui.track) ui.track.classList.remove("is-indeterminate");
  // transform:scaleX (not width) so the fill animates on the GPU — no layout
  // thrash (impeccable layout-transition rule).
  ui.fill.style.transform = `scaleX(${clamped / 100})`;
  if (ui.track) ui.track.setAttribute("aria-valuenow", String(clamped));
}

/**
 * Toggle the indeterminate (sliding-segment) bar — used while the backend is
 * working but has not reported a determinate percent yet, so the bar is always
 * visibly "doing something". The first real {@link setPhase2Progress} call (or
 * completion) clears it automatically.
 */
export function setPhase2Indeterminate(ui, on) {
  if (!ui || !ui.track) return;
  ui.track.classList.toggle("is-indeterminate", Boolean(on));
}

/** ``"loading" | "ok" | "error"`` — drives the fill color via the container. */
export function setPhase2State(ui, state) {
  if (!ui || !ui.container) return;
  ui.container.setAttribute("data-state", state);
}

/**
 * Spectacular finish: fill to 100% in the success color, then pop a ✓ with a
 * pulse ring and a short confetti burst. Reduced-motion users get the fill +
 * color only (the burst/ring are hidden via CSS). FX nodes self-remove.
 *
 * @param {{container: HTMLElement, fill: HTMLElement, fx: HTMLElement}} ui
 * @param {Document} doc
 */
export function playPhase2Completion(ui, doc = document) {
  if (!ui || !ui.container) return;
  setPhase2State(ui, "ok");
  setPhase2Progress(ui, 100);
  const fx = ui.fx;
  if (!fx) return;
  fx.innerHTML = "";

  const ring = doc.createElement("span");
  ring.className = "k2c-p2-ring";
  fx.appendChild(ring);

  // A second, staggered ring makes the finish read as a richer pulse.
  const ring2 = doc.createElement("span");
  ring2.className = "k2c-p2-ring";
  ring2.style.animationDelay = "0.22s";
  fx.appendChild(ring2);

  const check = doc.createElement("span");
  check.className = "k2c-p2-check";
  check.textContent = "✓";
  fx.appendChild(check);

  const COUNT = 24;
  for (let i = 0; i < COUNT; i += 1) {
    const p = doc.createElement("span");
    p.className = "k2c-p2-particle";
    const angle = (Math.PI * (0.15 + 0.7 * (i / COUNT))) * -1; // fan upward
    const dist = 30 + Math.random() * 42;
    const dx = Math.cos(angle) * dist * (i % 2 ? 1 : -1);
    const dy = Math.sin(angle) * dist - 6;
    p.style.setProperty("--dx", `${dx.toFixed(1)}px`);
    p.style.setProperty("--dy", `${dy.toFixed(1)}px`);
    p.style.setProperty("--rot", `${Math.round(Math.random() * 540 - 270)}deg`);
    p.style.background = PARTICLE_COLORS[i % PARTICLE_COLORS.length];
    p.style.animationDelay = `${(i % 4) * 25}ms`;
    fx.appendChild(p);
  }

  // FX self-cleanup so a later re-import starts from a clean layer.
  const root = (doc.defaultView || (typeof window !== "undefined" ? window : null));
  const timer = root && typeof root.setTimeout === "function" ? root.setTimeout : setTimeout;
  timer(() => {
    // Keep the ✓ (it's a nice persistent "done" badge); drop the transient burst.
    fx.querySelectorAll(".k2c-p2-particle, .k2c-p2-ring").forEach((n) => n.remove());
  }, 2600);
}
