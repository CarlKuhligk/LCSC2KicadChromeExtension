# V3-SPEC.md — KiCad Parts Importer V3

**Status:** working draft · 2026-05-29 · subject to review
**Author:** theautomatist (idea owner) + Claude (drafter)
**Sibling docs:** [CONTEXT.md](CONTEXT.md) (domain language), [REFACTOR-PLAN.md](REFACTOR-PLAN.md) (V2 hand-off)

---

## Pitch

A simpler, smaller, more self-sufficient version of the KiCad Parts Importer. Same
job (LCSC → KiCad library), fewer moving parts, **one** import mode, **no manual
backend juggling**, **DOM integration that doesn't break when LCSC repaints**.

V3 is the rewrite-from-experience: every part of V2 is examined under the rule
**"keep it stupid simple"** and either kept, simplified, or struck.

## Why V3

V2 grew incrementally. Each historical decision was right at the time:

- Two import modes (EasyEDA + Template) because Template was added later, separately.
- A WebSocket backend because at the start that was the simplest way to do
  filesystem writes from a browser.
- Table-DOM selectors because the LCSC product page had a stable table.
- Job queue + task-update messages because the early conversions felt slow.

None of these is the simplest solution today. V3 picks the simplest version
of each.

---

## The workflow (single user journey)

User opens an LCSC product page:

1. KiCad Importer button is visible. **(No table integration — anchored to a
   stable landmark or floating-fixed.)**
2. User clicks **Download**.
3. Backend converts the LCSC part via the EasyEDA pipeline → produces a
   candidate **Symbol + Footprint + 3D model**.
4. **Optional override panel** appears when:
   - the matching Category Rule specifies overrides, **or**
   - the user clicks "Customize".

   Choices in the panel:
   - Symbol: keep EasyEDA / replace with template
   - Footprint: keep EasyEDA / replace with template
   - Pin↔Pad map: auto, or confirm/remap if symbol/footprint disagree
5. User confirms. Backend writes to active library. Browser shows success.

That is the entire UX. **One button, one optional panel, one confirm.**

---

## Architectural decisions

### 1. One import mode, with overrides

There is **no** EasyEDA-vs-Template button choice. The default flow always runs
the EasyEDA conversion. Overrides happen **after** the candidate is generated,
not before — the user swaps Symbol or Footprint (or both) for a Template Library
entry without changing the conversion path.

> Why this is simpler than V2: it deletes the entire `useTemplate: true/false`
> branch from the backend, the dual buttons from the page UI, and the
> "EasyEDA vs Template flow" mental model. Templates become **edit operations
> on a known-good candidate**, not a parallel pipeline.

### 2. Template Library entries are partial

A Template Library entry can be:

- Symbol only (most common — your standardized resistor schematic-symbol)
- Footprint only (less common — your standardized 0603 pad geometry)
- Symbol + Footprint together (the "complete part" case, e.g. for a specific
  IC where both EasyEDA assets are bad)

Category Rules can name a **default override** per category:
`Passives/Resistors → use my "R-symbol", keep EasyEDA footprint`.

### 3. Backend invocation — **open question**

V3 must eliminate the "I have to start the backend manually" pain. Three options:

| Option | Mechanism | Pro | Con | Effort |
|---|---|---|---|---|
| **A. Chrome Native Messaging** | Extension declares native host JSON manifest; Chrome launches the Python process when extension calls `connectNative`, kills it on disconnect | True zero-start; no localhost; no firewall; Chrome handles lifecycle | One-time native host installer per OS; stdin/stdout JSON protocol replaces WebSocket | Medium |
| **B. KiCad Action Plugin** | Plugin in `~/.kicad/plugins/`; KiCad launches it via its Python bridge | "Starts when I open KiCad" matches mental model | KiCad plugins are PCB-editor scripts, not daemons; lifecycle is tied to pcbnew; non-trivial robustness | High |
| **C. System tray app** | OS autostart entry (Windows Run key / macOS LaunchAgent / Linux systemd user service); always-on background | Familiar pattern; user can see "is it running" | Always-on RAM; user-visible tray; installer per OS | Medium |

**My recommendation: Option A (Chrome Native Messaging).** It is the only one
that *removes* the backend lifecycle as a user concern entirely — the user never
sees the backend at all. Trade-offs to confirm in review.

### 4. DOM injection — anchored, with float as fallback

V2 finds an insertion point via `table.tableInfoWrap tbody`. LCSC layout
changes break this. The first attempt for V3 (commit `e54a5b9`) replaced the
table selector with a **pure float-fixed panel** in the bottom-right corner.
Empirical test on the live LCSC C22548 page (2026-05-29): the panel renders
correctly but is **a noticeably worse UX** than V2's in-table integration.
The user has to move the mouse across the page to reach it; the import
action no longer reads as "part of the product info".

**Revised decision: anchored-first, float as fallback.**

- **Primary**: inject as a new row in the product **header card**
  (Table 0 in the live dump — `w-full text-sm text-[#1C1F23] table-fixed`,
  the table containing "Hersteller / Herst.-Teilenr. / LCSC-Nr. / …"). Add
  a new `<tr>` labeled "KiCad" so it sits alongside the existing rows. This
  matches V2's UX precisely.
- **Fallback**: the float panel (already implemented) when the header card
  can't be located. Robust against any future LCSC restructure.

Detection strategy for the anchor: find any `<table>` whose first
non-header row contains a cell with text matching the LCSC ID pattern
(`C\d+`) OR a localized "Hersteller" / "Manufacturer" / "Mfr." label —
both are stable across LCSC locales. The header card is the highest match.

Implementation note: the existing `extractPageData()` from
`lcscPageSnapshot.js` already iterates every table; the anchor detector
can reuse that walk to identify the right `<tbody>` without a second pass.

### 5. Job model — synchronous-ish

A single-user single-component import takes 1-10 s. V2's queue + push-message
model is overkill. V3: user clicks → backend converts → result returns on the
same connection.

> "Queue" disappears. `task_update` push disappears. The
> service-worker-to-content-script message bridge disappears (Native Messaging
> bypasses the service worker for the data path).

### 6. No standalone server, no API base URL setting

Backend is invoked by Chrome (A) / discovered at well-known path (B) / connects
to a tray endpoint (C). The popup loses the "Backend URL + Test" settings.

### 7. Settings simplified

Three popup tabs survive:

- **Categories** — same model as V2 (deepest-prefix), extended to optionally
  reference Template Library entries as defaults.
- **Library** — active KiCad library, plus Template Libraries.
- **Settings** — theme, debug logs, overwrite policies, project-relative 3D paths.

Removed: API base URL + Test.

---

## In scope — features V3 has

- LCSC product page → KiCad library import.
- EasyEDA conversion as the default pipeline (Symbol + Footprint + 3D model).
- Template Library entries (Symbol-only / Footprint-only / both).
- Category Rules (deepest-prefix match, as V2) **extended with default-overrides**.
- Pin↔Pad map override UI when an overriding Symbol and overriding Footprint disagree.
- Datasheet PDF preview during override picker (kept — it works well).
- LCSC parameter table → KiCad symbol properties (kept).
- Overwrite-existing-part handling.

## Out of scope — what V3 strikes from V2

- The "EasyEDA mode" button. Default behavior covers it.
- The separate Template-mode flow. Templates become overrides.
- Manual backend URL + Test connection.
- The 5-dialog cascade (Category, Value-Param-Fallback, Value-Param-Mismatch,
  Overwrite, Pin↔Pad). Targeted reduction: Category + Value-Param merge into
  one inline override panel; Pin↔Pad is inline; Overwrite stays simple.
- Two-step pin-count check followed by Pin↔Pad modal. One inline step instead.
- Job queue + task_update messages. Synchronous flow.
- WebSocket transport (if Option A is chosen).
- Three-layered fallback for the 3D path. One setting.
- LCSC table-DOM selectors. Anchor or float.

---

## Migration from V2

- **Category Rules** — V2 schema is mostly compatible. A small migrator adds
  the new "default override" fields with `null` defaults.
- **Template libraries** — directly compatible. V2 has them as `Templates.kicad_sym`
  next to a library; V3 keeps that location.
- **Popup settings** — backward-compatible subset; "API base URL" silently
  dropped.
- **V2 stops shipping** after V3 release. Chrome Web Store receives V3 as a
  new version of the same extension (carries forward chrome.storage data, so
  users keep their Categories and Library list).

---

## What V3 explicitly is NOT

- **Not a TypeScript / framework rewrite.** Vanilla ES modules + Python stays.
- **Not a fork of EasyEDA.** We rely on EasyEDA's strengths (correct pin labels,
  pad coordinates) and only swap when the user has a better local version.
- **Not a marketplace** for templates. They're files on the user's disk.
- **Not multi-user / multi-machine.**
- **Not all LCSC variants.** Anchor strategy targets robustness, not completeness.
  If LCSC ships a layout the anchor can't find, the floating fallback covers it.

---

## Open questions for V3 review

1. **Backend deployment: A, B, or C?** Highest-impact decision. Lean A.
2. **Should categories be folders (slash-paths) or tags (flat with chips)?**
   V2 is slash-paths; that's working. Likely keep.
3. **Template version pinning** — if a template file changes on disk after a
   Category Rule references it, should subsequent imports use the new version
   automatically, or stay pinned to the saved snapshot?
4. **Chrome Web Store identity** — same listing (smooth upgrade for users) or
   new listing (clean break, easier name change)?
5. **EasyEDA-only legacy mode** — do you want a hidden "raw EasyEDA, no
   override panel" flag for parts where you know you don't want to override?
   Probably no — KISS.

---

## Effort estimate

Realistic timeline at part-time pace (~2 evenings per week), assuming:

- The V2 codebase + tests + REFACTOR-PLAN.md serve as reference and edge-case
  source.
- The CONTEXT.md vocabulary is reused.
- The Vitest + pytest harnesses carry over.

| Phase | Scope | Estimate |
|---|---|---|
| Spec finalize + open-question decisions | This document, reviewed | 1-2 sessions |
| Architectural spike | Native Messaging hello-world; template-override prototype | 2 evenings |
| V3 backend | One-mode conversion, override applier, native-host wiring | 1-2 weeks |
| V3 extension | Single download button + override panel, floating/anchored DOM | 1-2 weeks |
| Migration + Chrome Web Store release | Settings carryover, release flow | 3-5 days |

**Total: ~5-8 weeks part-time** if the open questions resolve cleanly.
Compare to "continue REFACTOR-PLAN.md" which is roughly 4-5 weeks part-time
to reach a clean but functionally-identical V2.

The difference is what you get at the end: V3 has the new features and the
simplified workflow; refactored-V2 still has the dual-mode UI and the manual
backend.

---

## Decision needed before any code

Review this spec. Note in writing or in our next session:

- Each architectural decision (1–7): **accept / change / strike**.
- Each in-scope feature: **keep / remove**.
- Each open question (1–5): **answer**.

Once decisions are recorded, the next deliverable is a **walking skeleton**:
a minimal end-to-end V3 (anchored button on a fake LCSC page → native host
hello → template override applied → file written). That spike either proves
the architecture in ~2 days or surfaces blockers early.

---

## Current state of the V2 codebase (snapshot 2026-05-29, commit `84df7ab`)

What is **already in place** from V3's vocabulary or architecture:

- **Domain language** — `CONTEXT.md` reflects the V3 mental model: Product
  Button Group, Datasheet Panel, Job Progress UI, LCSC Dialog,
  Template Gallery, Pin↔Pad Map, LCSC Page Snapshot, Backend Status
  Monitor, Category Path.
- **Single source of truth for Category Path** — `shared/categoryPath.mjs`,
  consumed by content / popup / SW; Python mirror in `helpers.py`. Paired
  drift-detection tests on both sides.
- **Tailwind-era LCSC scraper** — `lcscPageSnapshot.js`, structural
  detection, 18 Vitest cases against the live C22548 DE dump. Decouples
  V3 from any specific LCSC class names.
- **Float panel infrastructure** — `attachButton` builds a fixed-position
  Shadow-DOM host (commit `e54a5b9`). Will be downgraded from "default
  position" to "fallback" once the anchored-injection lands (see
  Decision #4 above).
- **Web-accessible-resources guard rail** —
  `tests/test_extension_manifest.py` (commit `84df7ab`). Catches the class
  of bug where a newly-extracted content-script module is forgotten in
  `manifest.json`. Prevents the silent-broken-extension regression that
  hit PRs #0–#3b retroactively.
- **52→108 Vitest cases** pinning the cross-cutting state and module
  boundaries: BackendStatusMonitor, DatasheetPanel, JobStateStore,
  LcscValueParamDialogs, LcscCategoryDialog, LcscPageSnapshot, plus
  shared CategoryPath.

What is **NOT yet there** (open from REFACTOR-PLAN.md, mostly V2 internal):

- Overwrite Dialog still inline in `app.js` (PR #3c).
- Template Gallery still inline in `app.js` (PR #4) — the biggest
  remaining chunk.
- Product Button Group still inline in `app.js` (PR #5) — the JobStateStore
  consumer side that PR #2 left for later.
- Download Pipeline still inline (PR #6).
- Backend candidates B-K3 / B-K4 / B-K5 / B-K6 not started.

`chrome_extension/src/content/app.js`: **5 404 LOC** (was 6 510 LOC at
session start; -1 106 LOC after the refactor series + today's fix).

---

## Known regressions / pending fixes

Captured here so they don't get lost in the post-compression pass.

### R1 — Float button has the wrong UX (high priority)

**Symptom:** float panel renders correctly in the bottom-right corner but
sits far from where the user reads product info. V2's in-table integration
was meaningfully better — mouse travel is shorter, the action reads as
part of the product info.

**Fix:** see revised Decision #4. Implement the anchored path against the
header card (Table 0 in the live LCSC layout), keep float as fallback.

**Affected files:** `chrome_extension/src/content/app.js`
(`attachButton`, `buildFloatHostStyle`, `cleanupInjectedUi`). Add an
`findHeaderCardAnchor()` helper that walks tables looking for the LCSC ID
cell. New CSS for the table-row mode (V2 style) plus the float mode.

**Estimated effort:** half a day. One PR.

### R2 — Click on the float button does nothing (urgent, root cause unclear)

**Symptom:** float panel is visible, but clicking the EasyEDA Download
button (or the Template button) triggers no observable action.

**Hypotheses to investigate, ranked by probability:**

1. **The button is still in the "Backend: checking" placeholder state**
   because `refreshButtonGroup` never resolves the backend-online check.
   The backend may not be running on the user's machine right now, or the
   `getState` RPC isn't returning what `refreshButtonGroup` expects.
   First diagnostic: check `chrome://extensions` → service worker
   console for the extension; look for `[easyeda2kicad]` errors and any
   WebSocket connection failures.
2. **`handleDownloadClick` references the deleted `findInsertionPoint` /
   tbody chain somewhere**. Verify by stepping the click handler in
   DevTools.
3. **Shadow DOM event propagation** broken because the float-host's
   `position: fixed` container sits at `z-index: 2147483646`. LCSC may
   have an overlay above it intercepting clicks.
4. **`onclick` assignment timing** — the placeholder button had
   `setButtonDisabledPlaceholder` applied; the real onclick is set in
   `refreshButtonGroup`. If that never runs, the button stays a no-op.

**Affected files:** `chrome_extension/src/content/app.js` —
`refreshButtonGroup`, `handleDownloadClick`, `attachButton`.

**Estimated effort:** 1–3 hours to diagnose, less to fix once root cause
is found.

### R3 — Module manifest oversight (already mitigated)

For the record: PRs #0–#3b shipped six new content-script modules without
adding them to `web_accessible_resources`. Vitest + node --check did not
catch it because both lack the manifest context. The fix in commit
`84df7ab` switches to a glob (`src/content/*.js`) and adds a Pytest
guard. Mitigated; no further action.

---

## What to do next (post-compression checklist)

In a fresh session after context compression:

1. **Fix R2 (the click regression).** Diagnose via service worker console.
   Most likely candidate is that the backend WebSocket isn't connected
   and the buttons stay in the placeholder state — verify by running
   `python run_server.py` from the repo and watching the console.
2. **Fix R1 (anchored injection).** Implement
   `findHeaderCardAnchor()`, fall back to the float panel only when the
   header-card walk returns null. Keep the test fixture in
   `lcscPageSnapshot.test.js` as the reference structure.
3. **Resolve the five open questions** (Backend deployment A/B/C, etc.)
   in a short workshop. The answers shape what V3's walking skeleton
   actually looks like.
4. **Decide phase ordering:** continue the REFACTOR-PLAN.md series to
   finish V2's cleanup, or pivot to a V3 walking skeleton. The current
   data suggests V3 is the better investment, but R1+R2 should be fixed
   regardless.

---

## Process lessons from this session

Documented so the next session doesn't repeat them.

- **"Tests green" is not "shipped working"** when the test harness mocks
  the production loading environment. Vitest with jsdom does not enforce
  Chrome MV3's web_accessible_resources contract. Six PRs in a row were
  green and broken. The fix: never claim "done" on an extension PR
  without `chrome://extensions` → reload → page refresh → user-visible
  action triggered. Sixty seconds, and it catches an entire class of
  bug Vitest never will.
- **Empirical UX beats abstract elegance.** The float-panel decision was
  defensible in theory (zero DOM dependency, future-proof). It was
  worse in practice the moment the user moved a mouse. Decisions that
  sound clean in a spec should still be reality-checked in the first
  feedback session.
- **CI guards earn their keep when the cost of the bug they prevent
  exceeds the cost of writing them.** `test_extension_manifest.py` is
  30 lines and prevents a class of silent breakage that was producing
  shipped PRs. Worth it. Apply the same calculus before any V3 module
  extraction.
