# REFACTOR-PLAN.md

Hand-off document for the ongoing architectural deepening of this codebase.
Audience: a coding agent (or human) picking up where the previous session
left off. Read [CONTEXT.md](CONTEXT.md) first for domain language.

The plan has three phases:

- **Phase A — Content-script split** (`chrome_extension/src/content/app.js`).
  Four PRs done (PR #0 BackendStatusMonitor, PR #1 DatasheetPanel, PR #2
  JobStateStore, PR #3 Value-Param dialogs). Six PRs left (#3b, #3c, #4,
  #5, #6, #7).
- **Phase B — Backend deepening** (`easyeda2kicad/`). Four candidates from
  the architecture review.
- **Phase C — Cross-cutting** (service worker, popup, shared utilities).
  Three candidates.

> A self-contained HTML view of the original architecture review lives at
> `C:\Users\Carl\AppData\Local\Temp\architecture-review-20260528-110007.html`
> (Windows temp dir on the original author's machine — likely no longer
> present). The eight candidates are mirrored below.

---

## Table of contents

1. [Status snapshot](#status-snapshot)
2. [Process (the pattern that worked)](#process-the-pattern-that-worked)
3. [Conventions & cross-env gotchas](#conventions--cross-env-gotchas)
4. [Phase A — Content-script split](#phase-a--content-script-split)
   - [PR #3b · Category Dialog](#pr-3b--category-dialog)
   - [PR #3c · Overwrite Dialog](#pr-3c--overwrite-dialog)
   - [PR #4 · Template Gallery](#pr-4--template-gallery)
   - [PR #5 · Product Button Group + Job Progress UI residual](#pr-5--product-button-group--job-progress-ui-residual)
   - [PR #6 · Download Pipeline](#pr-6--download-pipeline)
   - [PR #7 · LCSC Page Snapshot](#pr-7--lcsc-page-snapshot)
   - [Composer cleanup](#composer-cleanup)
5. [Phase B — Backend candidates](#phase-b--backend-candidates)
   - [B-K3 · `api/server.py` resource split](#b-k3--apiserverpy-resource-split)
   - [B-K4 · `service/conversion.py` step objects](#b-k4--serviceconversionpy-step-objects)
   - [B-K5 · `kicad/template_merger.py` AST](#b-k5--kicadtemplate_mergerpy-ast)
   - [B-K6 · `easyeda/easyeda_api.py` typed fetcher](#b-k6--easyedaeasyeda_apipy-typed-fetcher)
6. [Phase C — Cross-cutting](#phase-c--cross-cutting)
   - [C-K2 · `background.js` service-worker split](#c-k2--backgroundjs-service-worker-split)
   - [C-K7 · `popup.js` per-tab modules](#c-k7--popupjs-per-tab-modules)
   - [C-K8 · Category Path single source of truth](#c-k8--category-path-single-source-of-truth)
7. [Verified non-issues](#verified-non-issues)
8. [What is NOT in this plan](#what-is-not-in-this-plan)

---

## Status snapshot

Last update: **2026-05-29**. Master branch is at commit `70a1d3c`.

| Metric | At session start | Now | Δ |
| --- | --- | --- | --- |
| `chrome_extension/src/content/app.js` | 6 510 LOC | **5 981 LOC** | **-529** |
| Cross-cutting module globals in `app.js` (job maps, PDF expandos) | 9 | **0** | -9 |
| JS unit tests (Vitest + jsdom) | 0 | **52** | +52 |
| New content-script modules | 0 | 4 | +4 |
| CONTEXT.md | absent | present | — |

Modules already extracted (all in `chrome_extension/src/content/`):

1. `backendStatusMonitor.js` (74 LOC, 5 tests) — polling loop for backend connectivity.
2. `datasheetPanel.js` (294 LOC, 9 tests) — PDF.js iframe + postMessage + stall timer.
3. `jobStateStore.js` (193 LOC, 22 tests) — cross-cutting job state.
4. `lcscValueParamDialogs.js` (264 LOC, 16 tests) — two LCSC modal dialogs.

Each commit on `master` describes its move precisely; read those before
starting (`git log --oneline -10`).

---

## Process (the pattern that worked)

Every PR followed the same five-step loop. Stick to it:

1. **Map the targeted concern.** Grep for landmark names (functions,
   module globals, DOM expandos). Read enough lines to know what stays
   and what moves.
2. **Write the new module first**, with a clean API. Aim for a deep
   module: small interface, real behavior behind it. Inject dependencies
   (e.g. `rpc`, `getExtensionUrl`) at construction.
3. **Write tests immediately** in `*.test.js` next to the module. Pin
   the current behavior — these tests are the safety net for the rewire.
4. **Rewire `app.js`** — import the new module, delete the old code,
   update call sites, remove now-orphaned imports. Run
   `npm test --prefix chrome_extension` + `node --check` on every
   touched JS file.
5. **Commit with a precise message** describing what moved, what
   stayed, why, and any cross-env quirks discovered. Use the established
   format (`refactor(extension): …` lower-case scope).

PR sizes so far have been ~200–300 LOC out of `app.js` plus a new module
of ~200–300 LOC plus 10–25 tests. Don't try to merge two extractions in
one PR; the value of small, reversible steps is the whole point.

---

## Conventions & cross-env gotchas

The previous PRs discovered three Node/jsdom vs browser differences that
**will bite again** if you forget them. Each is documented in the
commit that hit it; here they are consolidated:

| Pitfall | Browser shape | Node/jsdom shape | Mitigation in PRs so far |
| --- | --- | --- | --- |
| `new URL("chrome-extension://...").origin` | `"chrome-extension://abc"` | `"null"` (string) — chrome-extension isn't a WHATWG "special" scheme in Node | Inject the origin via constructor (`extensionOrigin` param) and fall back to `new URL(...).origin` only when the host gives you no string. See `datasheetPanel.js`. |
| `URL.revokeObjectURL` | exists | missing in jsdom 26 | Don't `vi.spyOn` a missing method. Stub it directly in `beforeEach`: `URL.revokeObjectURL = (u) => calls.push(u);`. See `datasheetPanel.test.js`. |
| `setTimeout(...)` return | `number` | `Timeout` object | App code uses `typeof entry === "number"` to detect timer handles. Keep it (browser-shape). In tests, use a numeric sentinel + spy on `clearTimeout`. See `jobStateStore.test.js`. |

Other conventions worth keeping:

- **Module style.** ES modules, classes when the module owns state,
  bare exports when it's pure helpers. `.js` extension throughout
  (matches existing content-script files; ESM via `<script type="module">`
  is wired through `inject.js → main.js`).
- **Constructor DI.** Inject `rpc`, `log`, `getExtensionUrl`,
  `extensionOrigin`, time-related constants. Default values mean
  production code calls `new Foo()` and tests call `new Foo({ rpc:
  fake, log: vi.fn() })`.
- **Private fields with `#`.** Used in all four extracted modules. Node
  24 supports them; the bundler tooling isn't in the picture (the
  extension ships raw ES modules).
- **One adapter today, real seam tomorrow.** When a module needs
  something that will become a real other module later (e.g. JobProgressUi
  needs a button-update API that will become ProductButtonGroup), inject
  a plain object adapter from `app.js`. The adapter is replaced by the
  real module when its PR lands.
- **`dialog.js` is shared infrastructure**, not a god module. Reuse
  `mountCsModal`, `dismissCsModalById`, `dialogButtonStyle`,
  `CS_DIALOG`, `cssJoin` directly. Don't reinvent them.
- **Commits go to `master` directly.** This project ships through Chrome
  Web Store and follows a single-trunk workflow. Don't open feature
  branches unless asked.

---

## Phase A — Content-script split

`chrome_extension/src/content/app.js` is the focus. Order is the one
agreed at session start; deviating is fine if there's a reason, but the
ButtonGroup PR specifically benefits from JobProgressUi residual already
being separated (i.e. PR #5 finishes the work PR #2 started).

### PR #3b · Category Dialog

**Status:** Pending. Recommendation: **Strong** — biggest remaining
single DOM-heavy function in `app.js` and clean to extract.

**Files**
- Source: `chrome_extension/src/content/app.js`
- Target: new module `chrome_extension/src/content/lcscCategoryDialog.js`
- Tests: new `chrome_extension/src/content/lcscCategoryDialog.test.js`

**Current location in `app.js` (commit `70a1d3c`)**
- `removeCategoryDialog()` — L878
- `showCategoryDialog(category, paramKeys, actions)` — L942 (extends to
  roughly L1500; the function is ~550 lines because it builds the full
  modal DOM, manages keyboard navigation, and wires Save/Continue/Skip/
  Cancel)
- Constants used: `CATEGORY_DIALOG_ID` (from `constants.js`), `CS_DIALOG`,
  `dialogButtonStyle`, `categoryBreadcrumbBtnStyle`, `applyDialogStyleSelect`
  (all from `dialog.js`)
- Helpers used: `getDefaultValueParamKey` (already in
  `lcscValueParamDialogs.js`), `normalizeCategoryPath` (from
  `categoryNormalize.js`), `formatStatusColon` (from `jobStateStore.js`)

**Goal**

Move both functions into a single module. The category dialog is unlike
the Value-Param dialogs in that it does **not** use `mountCsModal` — it
builds its own overlay element with `overlay.id = CATEGORY_DIALOG_ID`.
That's a known inconsistency; you can either:

- **(A) Lift-and-shift** — move as-is; same overlay shape, same `id`.
  Recommended for a single-PR move.
- **(B) Lift-and-shift + use `mountCsModal`** — replace the bespoke
  overlay with `mountCsModal(...)` for consistency with the Value-Param
  dialogs. Only do this if you can verify in a real browser that the
  category dialog still works identically — it has complex inner layout
  (breadcrumb buttons, Value-Param `<select>`, pin-visibility
  checkboxes) that may depend on the existing overlay structure.

**Default: do (A).** Option (B) is a candidate for a follow-up PR after
the bigger split is done.

**Suggested API**

```js
// lcscCategoryDialog.js
export function removeCategoryDialog() { ... }

/** @returns {Promise<CategoryDialogChoice>} or use callback shape */
export function showCategoryDialog(category, paramKeys, actions) { ... }
```

`actions` is the existing shape:

```js
{
  onSaveAndContinue: (payload) => void | Promise<void>,
  onContinueOnly: (payload) => void,
  onSkip: () => void,
  onCancel: () => void,
}
```

Payload shape (already documented in the JSDoc at L1148–1156):

```js
{ category: string, hidePinNumbers: boolean, hidePinNames: boolean, valueParam: string | null }
```

**Scope in / out**

In:
- Both functions, all their DOM construction, keyboard navigation
  (Escape, Enter), focus management, and the breadcrumb chip rendering.
- Imports the helpers it needs (`getDefaultValueParamKey`,
  `normalizeCategoryPath`, `formatStatusColon`).

Out:
- `resumeDownloadUiAfterCategoryAbort` and `abortPreDownloadIf` (L884
  and L919 in current `app.js`) — these are post-dialog orchestration,
  not the dialog itself. They belong with PR #6 (Download Pipeline).

**Tests to write**

In jsdom, the dialog mounts and reads `document` directly. Test:

1. `showCategoryDialog` mounts an overlay with `id = CATEGORY_DIALOG_ID`.
2. Clicking "Save & Continue" calls `actions.onSaveAndContinue` with
   the right payload shape.
3. Clicking "Continue without saving" calls `onContinueOnly`.
4. Clicking "Skip" calls `onSkip` and dismisses the dialog.
5. Clicking "Cancel" calls `onCancel` and dismisses.
6. Escape key dismisses (verify by dispatching a keyboard event).
7. The Value-Param `<select>` defaults to `getDefaultValueParamKey(paramKeys)`.
8. Pin-visibility checkboxes default to OFF (the documented "new
   category" behavior — see README).
9. Toggling a pin-visibility checkbox flips the payload's
   `hidePinNumbers` / `hidePinNames` boolean.
10. `removeCategoryDialog()` is idempotent (calling twice doesn't throw).

Aim for ~10–12 tests.

**Expected delta**: `app.js` -550 LOC (the function is bigger than it
looked from the outside). The new module will be ~600 LOC including
imports and JSDoc.

**Dependencies / blockers:** None. Standalone PR.

---

### PR #3c · Overwrite Dialog

**Status:** Pending. Recommendation: **Worth exploring** — smaller win
than #3b but cleans up a special-cased dialog shape.

**Files**
- Source: `chrome_extension/src/content/app.js`
- Target: new module `chrome_extension/src/content/lcscOverwriteDialog.js`
- Tests: new `chrome_extension/src/content/lcscOverwriteDialog.test.js`

**Current location**
- `showOverwriteDialog(button, lcscId, pageData, existingOverrides, dialogOptions)` — L5050

**Goal**

Extract the function. Unlike the other LCSC dialogs, this one **does not
mount a modal overlay** — it inserts a `<div class="easyeda2kicad-overwrite-dialog">`
into the product page row. The shape is intentional (it's prompting next
to the buttons, not blocking the page), so the extraction is just a
lift-and-shift.

**Suggested API**

```js
// lcscOverwriteDialog.js
export function showOverwriteDialog(button, lcscId, pageData, existingOverrides, dialogOptions) {
  // returns nothing; uses callbacks in dialogOptions
}
```

`dialogOptions.onResumeAfterOverwrite(merged)` is the existing callback;
keep its shape.

**Tests to write**

1. The dialog inserts a `.easyeda2kicad-overwrite-dialog` element in
   the page row.
2. Clicking "Override this download" calls
   `onResumeAfterOverwrite({ overwrite: true, overwrite_model: true })`
   (or whatever the current behavior is — read the source carefully).
3. Clicking "Override + remember" calls `contentRpc("updateSettings", ...)`
   with the right payload. Inject `rpc` as a constructor param so tests
   can pass a `vi.fn()`.
4. Clicking "Cancel" removes the dialog and does NOT call any callback.
5. Re-showing on the same row is idempotent (no duplicate dialogs).

Aim for ~5–6 tests.

**Expected delta**: `app.js` -140 LOC.

**Dependencies / blockers:** Touches `contentRpc` directly. Inject it.

---

### PR #4 · Template Gallery

**Status:** Pending. Recommendation: **Strong** — biggest remaining
piece. Plan for a half-day to a day of focused work; consider breaking
into 4a / 4b if it gets unwieldy.

**Files**
- Source: `chrome_extension/src/content/app.js`
- Target: new module `chrome_extension/src/content/templateGallery.js`
  (and possibly a sibling `pinPadMap.js` if the Pin↔Pad logic warrants
  its own module)
- Tests: new `chrome_extension/src/content/templateGallery.test.js`

**Current location**
- `closeTemplateGalleryModal()` — L2713
- `buildTemplateListItems(templateSymbolsByLib)` — L3195
- `openTemplateGallery(anchorButton, groupDiv, lcscId, state, galleryOptions)` — L3266
- `onTemplateSelected(button, lcscId, templateName, templateLibPath, flowOpts)` — L4985

Plus all the Pin↔Pad sub-system: `normalizeGalleryPadLabel`,
`buildTemplatePinMapFromGalleryPadMap`, `mountInteractiveFootprintSvg`,
`layoutFpPadInnerLabels`, `syncFpPadAssignmentLabels`,
`renderFootprintPadMapTable`, the hover-preview SVG fetcher, the gallery
keyframe CSS injection, and the datasheet fetch orchestration that
remains in app.js (see "Goal" below).

Roughly **L2700–L5050 in `app.js`** is gallery + Pin↔Pad + datasheet fetch.

**Goal**

Create a `TemplateGallery` class that owns:

- The overlay element and its lifecycle.
- The template list rendering and selection state.
- The hover preview SVG fetching and caching.
- The footprint preview SVG mounting with interactive pad labels.
- The Pin↔Pad map table.
- The Continue/Cancel buttons and the resolution flow.
- The datasheet fetch orchestration (RPC, large-PDF approval dialog,
  progress UI). This was deferred from PR #1 (`DatasheetPanel`) because
  the fetch flow lives inside the gallery's render function. PR #4 is
  the right time to lift it — the `DatasheetPanel` API
  (`mountViewer(host, bytes, { gen, onShown })`) is ready to be called.

The class consumes:

- A `DatasheetPanel` instance (already singleton in `app.js`).
- `rpc` (`contentRpc` + `k2cRpc` helper).
- The `JobStateStore` is **not** needed here — gallery state is
  per-instance, not job-wide.

**Suggested API**

```js
// templateGallery.js
export class TemplateGallery {
  constructor({ rpc, datasheetPanel, log }) { ... }

  /**
   * Opens the gallery modal. Returns a Promise that resolves with the
   * user's selection (template + pad map) or rejects on cancel.
   */
  async open(anchorButton, groupDiv, lcscId, state, galleryOptions) { ... }

  /** Close + tear down. Idempotent. */
  close() { ... }
}
```

The fetch-bytes-and-approve flow becomes a private method, calling
`this.#datasheetPanel.mountViewer(...)` once bytes are in hand.

**Scope in / out**

In:
- All the functions named above.
- The two module-level caches and CSS-injection helpers
  (`templateSvgPreviewCache`, `K2C_TPL_GALLERY_STYLE_ID`,
  `injectTemplateGalleryKeyframes`).
- The `k2cActiveDatasheetDownloadUi` progress-sink global (it belongs
  with the fetch flow that consumes it). Move this into a private field
  on the gallery. The `chrome.runtime.onMessage` listener at L6244 (the
  `"k2c-datasheet-fetch-progress"` branch) needs to dispatch to the
  current gallery instance — keep a module-level `currentGallery`
  reference in `app.js` for that.

Out:
- The Product Button Group integration — when the user confirms in the
  gallery, the result is handed back to `app.js` via the Promise. The
  gallery doesn't call `refreshButtonGroup` directly.

**Tests to write**

This is the hardest module to test because it composes multiple
sub-systems. Focus on the pure pieces and on key flows:

1. `buildTemplateListItems` produces the right structure for a mixed
   single-lib / multi-lib input.
2. `normalizeGalleryPadLabel` round-trips the "NC" sentinel correctly.
3. `buildTemplatePinMapFromGalleryPadMap` produces the wire format
   expected by the backend (`template_pin_map`).
4. Opening the gallery mounts an overlay with the right id.
5. Selecting a template enables the Continue button.
6. Cancel rejects/resolves with a cancel result.
7. The footprint preview's `padPick` callback updates the internal map.

Aim for ~10–15 tests. Skip tests for the SVG layout math (it's pixel-
accurate by intent; visual regression would need real-browser
screenshots, which Vitest can't do).

**Expected delta**: `app.js` -2 200 to -2 400 LOC. New module
~2 500 LOC (might justify a sub-split).

**Dependencies / blockers:**
- Depends on PR #1 (`DatasheetPanel`) ✅ done.
- The `chrome.runtime.onMessage` `"k2c-datasheet-fetch-progress"`
  routing needs adjustment to find the active gallery instance. Plan
  for this; it's the trickiest rewire in the PR.

**If it gets too big**, split:

- **PR #4a** — `TemplateGallery` shell + template list + hover preview.
- **PR #4b** — Footprint preview + Pin↔Pad interactive UI.
- **PR #4c** — Datasheet fetch flow folds into `TemplateGallery`.

---

### PR #5 · Product Button Group + Job Progress UI residual

**Status:** Pending. Recommendation: **Strong** — closes the loop on
PR #2 (`JobStateStore`).

**Files**
- Source: `chrome_extension/src/content/app.js`
- Target: new module `chrome_extension/src/content/productButtonGroup.js`
- Tests: new `chrome_extension/src/content/productButtonGroup.test.js`
- Optional sibling: `chrome_extension/src/content/jobProgressUi.js` for
  the residual job dispatch logic (could fold into ProductButtonGroup;
  judgment call).

**Current location in `app.js`**
- Shadow-DOM setup: `ensureProductBtnGroupShadow` — L309 (and related
  helpers `getBtnGroupMount`, `btnGroupHostContains`,
  `queryProductGroupButtons`, `ensureSpinnerStyle` — L297–520)
- Stylesheet builder: `getProductBtnShadowStylesheet` — earlier in file
- Button-state machine: `setIcon`, `setBtnLabel`, `setGroupEnabled`,
  `markGroupExists`, `setBtnTheme`, `setDlButtonHoverShadow`,
  `setGroupBackendOffline`, `setGroupNoImportLibrary`,
  `showBackendOfflineUIForButton`, `setButtonDisabledPlaceholder`,
  `setSpin`, `updateButtonState`, `applyComponentState`,
  `createDlButtonIconWrap`, `createDlButton`, `buildDlOptions` — L1547
  through L1850 roughly
- Progress overlay row: `ensureProductProgressRow`, `getProgressElements`,
  `setProgressUI` — L1890–2100
- Confetti: `triggerConfetti` — L1566
- `refreshButtonGroup` — L2103
- Job dispatch residual: `applyJobStatusToButton` — L536,
  `applyTerminalJobUI` — L5667, `startJobWatcher` — L5704
- The `chrome.runtime.onMessage` listener that routes `task_update` and
  `jobTerminal` to the button group — near L6244

**Goal**

Two cleanly-separated modules behind a narrow ButtonGroup API:

1. **`ProductButtonGroup`** — owns the Shadow DOM, the buttons, all
   state transitions (idle, pending, busy, success, partial, error,
   exists, no-library, backend-offline), the progress overlay row, and
   the confetti trigger.
2. **`JobProgressUi`** *(optional separate module)* — owns the dispatch:
   `applyJobStatusToButton`, `applyTerminalJobUI`, `startJobWatcher`,
   and the `chrome.runtime.onMessage` handler for `task_update` /
   `jobTerminal` / `stateUpdate`. Uses `JobStateStore` (PR #2) and calls
   `ProductButtonGroup.markBusy/markDone/markError`.

The "ButtonGroup adapter" promised in PR #2 becomes the real class
here. The narrow API:

```js
class ProductButtonGroup {
  // construction / lifecycle
  constructor({ rpc, log, jobState, datasheetPanel }) { ... }
  attach(host, lcscId) { ... }    // injects buttons into a product page row
  detach() { ... }

  // refresh from server state
  async refresh(options = {}) { ... }

  // narrow state API used by JobProgressUi
  markBusy(lcscId, { progress, message, phase }) { ... }
  markDone(lcscId, conversionResult) { ... }
  markError(lcscId, message) { ... }

  // for the Backend Status Monitor
  setBackendOnline(state) { ... }
}
```

**Scope in / out**

In `ProductButtonGroup`:
- Everything in the "Current location" list above EXCEPT the job
  dispatch trio (`applyJobStatusToButton`, `applyTerminalJobUI`,
  `startJobWatcher`) and the `chrome.runtime.onMessage` listener.

In `JobProgressUi`:
- The trio above plus the `chrome.runtime.onMessage` listener for
  job-related messages (still uses `JobStateStore`).

Out:
- The dialogs (already extracted in PR #3, #3b, #3c).
- The Template Gallery (PR #4).
- The Download Pipeline (PR #6).
- The Backend Status Monitor (already extracted in PR #0; just wires
  `setBackendOnline` to its `onTick`).

**The active-product-page TODO from PR #0.** The two globals
`backendOnlineMonitorLcscId` and `backendOnlineMonitorGroupDiv` (L93–94
in `app.js`) carry the "which page do we have a button group on"
context. PR #5 should remove them — the `ProductButtonGroup` instance
itself is that context.

**Tests to write**

1. `attach()` mounts a Shadow DOM and renders the two buttons.
2. `markBusy(lcscId, { progress: 42, message, phase: "running" })`
   updates the button's visible text / progress bar.
3. `markDone(lcscId, result)` flips to success state and the message
   reflects partial-vs-complete based on `result.missing`.
4. `markError(lcscId, message)` flips to error state.
5. `setBackendOnline(false)` disables both buttons and shows the
   offline message.
6. `detach()` removes the Shadow DOM and is idempotent.
7. `refresh()` calls `rpc.checkComponentExists` and applies the result
   to the buttons. Inject a fake rpc.

For `JobProgressUi`:

1. `task_update` for a known job calls `buttonGroup.markBusy` with the
   right shape.
2. `task_update` for an unknown job is ignored.
3. Stale-queued-after-running is dropped (this is `JobStateStore`'s
   logic; verify the dispatch respects it).
4. Terminal events fire `markDone` / `markError` exactly once even if
   both `task_update(completed)` and `jobTerminal` arrive.

Aim for ~12–18 tests across both modules.

**Expected delta**: `app.js` -1 500 to -1 800 LOC.

**Dependencies / blockers:**
- Depends on PR #4 ideally, because the Template Gallery's
  Pin↔Pad confirmation feeds back into the button states. If PR #4 is
  not done first, the gallery code in `app.js` still calls the local
  button helpers — that's fine, the gallery just keeps calling the
  helpers (now methods on `ProductButtonGroup`).

---

### PR #6 · Download Pipeline

**Status:** Pending. Recommendation: **Worth exploring** — concentrates
the gates flow that's spread across `handleDownloadClick` and
`runTemplatePostOverwritePhase`.

**Files**
- Source: `chrome_extension/src/content/app.js`
- Target: new module `chrome_extension/src/content/downloadPipeline.js`
- Tests: new `chrome_extension/src/content/downloadPipeline.test.js`

**Current location**
- `handleDownloadClick(button, lcscId, overrides)` — L5515
- `runTemplatePostOverwritePhase(...)` — earlier (around L5413)
- The pre-download gates: backend-online, library-active, overwrite
  needed, category-dialog needed, value-param resolution. Mostly inside
  `handleDownloadClick`.
- `resumeDownloadUiAfterCategoryAbort` — L884
- `abortPreDownloadIf` — L919

**Goal**

Express the gate sequence as data. From CONTEXT.md:

> Download Pipeline — the ordered sequence of gates that runs before
> the `quickDownload` RPC is submitted:
>
> 1. Backend online?
> 2. Active library selected?
> 3. Part already in library → Overwrite Dialog?
> 4. Category resolved → Category Dialog if new?
> 5. Value-Param resolved → Value-Param dialogs if missing/mismatched?
> 6. Template branch only: pin-count check → Pin↔Pad Dialog?

A `DownloadPipeline` class accepts dependencies (rpc, dialogs,
buttonGroup, datasheetPanel/templateGallery for the template branch)
and exposes:

```js
class DownloadPipeline {
  constructor({ rpc, buttonGroup, categoryDialog, valueParamDialogs,
                overwriteDialog, templateGallery, log }) { ... }

  /** Returns a Promise that resolves to { submitted: jobId } or { cancelled: reason }. */
  async run(lcscId, { useTemplate, overrides }) { ... }
}
```

Internally, the run is a sequence of awaited gate functions, each
returning `{ proceed, mergedFlags }` or `{ cancelled }`. The pipeline
short-circuits on cancel.

**Tests to write**

With every dialog and rpc injected as a fake, the pipeline is fully
testable:

1. All gates pass → submits with the right `quickDownload` payload.
2. Backend offline → does not submit; calls `buttonGroup.markError`.
3. No active library → does not submit; shows the placeholder.
4. Part exists + Overwrite cancelled → does not submit.
5. Category needed + Cancel → does not submit; calls resume.
6. Value-Param mismatch + default → submits with default Value.
7. Template branch + Pin↔Pad cancel → does not submit.

Aim for ~8–10 tests.

**Expected delta**: `app.js` -500 to -700 LOC.

**Dependencies / blockers:**
- Depends on PR #3 ✅, #3b, #3c, #4 (so all the dialogs and the
  gallery are real modules to inject).
- Depends on PR #5 (`ProductButtonGroup` for the markError calls).
- This is the natural **last** content-script PR before the LCSC Page
  Snapshot.

---

### PR #7 · LCSC Page Snapshot

**Status:** Pending. Recommendation: **Worth exploring** — small win;
mostly about isolating the LCSC DOM dependency.

**Files**
- Source: `chrome_extension/src/content/app.js`
- Target: new module `chrome_extension/src/content/lcscPageSnapshot.js`
- Tests: new `chrome_extension/src/content/lcscPageSnapshot.test.js`

**Current location**
- `extractLcscId()` — L708
- `extractLcscIdFromString(str)` — L547
- `extractInfoTableRow(label)` — earlier
- `getCellDisplayValue(td)` — earlier
- `extractTableInfoWrapSpecs()`, `extractVDataTableSpecs()` — earlier
- `extractPageData()` — L785

**Goal**

One module that takes a `Document`-like host and returns a frozen
**LCSC Page Snapshot** (CONTEXT.md term). All LCSC-DOM-knowledge lives
here.

```js
// lcscPageSnapshot.js
export function snapshot(doc = document) {
  return {
    lcscId,
    category,        // breadcrumb path
    datasheetUrl,
    params,          // { key: value, ... }
    valueParamOptions, // string[]
  };
}
```

**Tests to write**

Build minimal jsdom documents that resemble LCSC product page
structure and verify extraction. The hard part is having representative
HTML fixtures.

1. `snapshot()` returns LCSC ID from URL pattern + page elements.
2. Empty page → snapshot has empty strings / arrays, not undefined.
3. Breadcrumb extraction returns normalized category path.
4. Params from `.table-info` and `v-data-table` flavors both work.

Aim for ~6–10 tests. **Worth investing in a small HTML fixture** —
real LCSC pages are big, but a stripped-down `<script>` + `<table>`
fragment is enough.

**Expected delta**: `app.js` -250 LOC.

**Dependencies / blockers:** None. Can be done in parallel with PR #6.

---

### Composer cleanup

After PRs #3b – #7 land, `app.js` should be ~1 000 LOC or less and
look like a **composer**:

- Imports all the modules.
- Wires them together at page-init time
  (`new ProductButtonGroup(...)`, `new TemplateGallery(...)`, etc.).
- Holds the `MutationObserver` that re-attaches the button group on
  LCSC SPA re-renders.
- Contains the `chrome.runtime.onMessage` registry (delegating to
  `JobProgressUi`, `DatasheetPanel` progress, etc.).

If `app.js` is still > 1 500 LOC at that point, look for one more
extraction. Likely candidates: the SPA re-attach observer logic, or the
init-time orchestration.

---

## Phase B — Backend candidates

The backend has decent Python unit tests already (`tests/`). The
candidates below are **lower priority** than Phase A — Phase A unlocked
testability for the JS half, which was the bigger gap. But each backend
candidate matches a real friction point.

### B-K3 · `api/server.py` resource split

**Status:** Pending. Recommendation: **Strong**.

**Files**
- `easyeda2kicad/api/server.py` (1 286 LOC)
- `easyeda2kicad/api/models.py`

**Problem**

One file holds:

1. FastAPI app construction.
2. The `/ws/extension` WebSocket endpoint.
3. JSON-RPC dispatch (`_extension_ws_rpc` dict + `handle_call`).
4. Library scaffolding (`_scaffold_library`, `_inspect_library`,
   `_check_component_in_library`).
5. Filesystem browser RPCs (`_fs_roots`, `_fs_list`, `_fs_check`).
6. Task queue + worker loop + progress broadcast.

RPC handlers are closures over shared app state — the dependencies are
invisible. The single Python test
(`tests/test_api_server.py`) has to spin up the whole app.

**Goal**

Split into modules with explicit dependencies; `server.py` becomes a
thin endpoint + dispatch registry.

```text
easyeda2kicad/api/
  server.py            # FastAPI app, WS endpoint, dispatch table
  library_service.py   # scaffold, inspect, check-component
  fs_browser.py        # roots, list, check
  task_queue.py        # queue, worker loop, progress subscriptions
  models.py            # unchanged
```

**Scope in / out**

In:
- Each new module exports plain functions or a small dataclass-keyed
  class. No FastAPI imports outside `server.py`.
- The task queue's `_ConversionProgress` mechanism becomes a
  `TaskQueue` class with `submit()`, `subscribe(callback)`, `tick()`.

Out:
- The conversion orchestration itself stays in `service/conversion.py`
  (its own candidate, K4).

**Tests to write**

- `LibraryService.scaffold(path, options)` against a `tmp_path`.
- `FilesystemBrowser.list(root)` with path-traversal denied.
- `TaskQueue` lifecycle: submit → tick → progress event → completion.

**Expected delta**: `server.py` 1 286 → ~250 LOC.

**Dependencies / blockers:** None. Pure backend refactor.

---

### B-K4 · `service/conversion.py` step objects

**Status:** Pending. Recommendation: **Worth exploring**.

**File**
- `easyeda2kicad/service/conversion.py` (671 LOC)

**Problem**

`run_conversion()` is an imperative pipeline: fetch (CAD + 3D) →
symbol → maybe template-merge → footprint → 3D. Each segment carries
its own retry, progress callback, overwrite check. Template path is
inline.

**Goal**

Introduce a `ConversionStep` protocol:

```python
class ConversionStep(Protocol):
    name: str
    def execute(self, ctx: ConversionContext) -> StepResult: ...
```

Concrete: `SymbolStep`, `TemplateSymbolStep`, `FootprintStep`,
`Model3DStep`. The orchestrator holds an ordered list of steps and
aggregates progress.

**Tests to write**

- Each step in isolation with a mock `ConversionContext` (fake API,
  fake FS).
- Pipeline with a step that fails — verify upstream steps' artifacts
  don't get torn down (current behavior is "partial-success success").

**Expected delta**: `conversion.py` 671 → ~300 LOC + ~80 LOC per step
module.

**Dependencies / blockers:** Depends on K6 (typed fetcher) being done
first — the steps want clean exceptions, not the current `on_retry`
callback dance.

---

### B-K5 · `kicad/template_merger.py` AST

**Status:** Pending. Recommendation: **Worth exploring** but
non-trivial.

**File**
- `easyeda2kicad/kicad/template_merger.py` (490 LOC)

**Problem**

Nine sequential regex-based S-expression rewrites of a `.kicad_sym`
text. Pin-set merge has an undocumented heuristic ("disjoint labels +
matching count → keep template pins"). Partial failures leave the
symbol half-modified.

**Goal**

Parse the template into a small `KiSymbolAst` (Property blocks, Pins,
Graphics as data), apply transformations as pure functions, serialize
at the end. Same public API.

```python
def merge_template(template_str: str, ee_symbol: EeSymbol, rule: CategoryRule) -> str:
    ast = parse_ki_symbol(template_str)
    ast = update_properties(ast, ee_symbol)
    ast = sync_pin_set(ast, ee_symbol.pins)
    ast = apply_category_rules(ast, rule)
    return serialize_ki_symbol(ast)
```

**Trade-off:** writing a focused S-expression parser is non-trivial.
Don't aim for sexpdata replacement — only support the subset of
KiCad-symbol features the codebase emits.

**Tests to write**

- Per-transformation: each function operates on AST nodes only.
- Round-trip parse → serialize is a no-op (for representative
  `.kicad_sym` fixtures).
- The "disjoint labels + matching count" heuristic is documented and
  has its own test.

**Expected delta**: `template_merger.py` 490 LOC → ~350 LOC + new
`ki_symbol_ast.py` (~250 LOC).

**Dependencies / blockers:** None.

---

### B-K6 · `easyeda/easyeda_api.py` typed fetcher

**Status:** Pending. Recommendation: **Worth exploring**.

**File**
- `easyeda2kicad/easyeda/easyeda_api.py` (200 LOC)

**Problem**

Retry logic duplicated between `get_info_from_easyeda_api()` and
`_get_with_retry()`. HTTP status codes (429, 5xx, empty JSON) leak via
the `on_retry` callback. Callers thread an `on_retry` lambda just to
get progress.

**Goal**

```python
class ComponentDataFetcher:
    def __init__(self, *, transport: HttpTransport, retry_policy: RetryPolicy,
                 progress: ProgressReporter | None = None): ...

    def fetch_cad(self, lcsc_id: str) -> CadData:
        # Raises ComponentNotFound | RateLimited | NetworkError

    def fetch_3d_model(self, key: str) -> bytes:
        # Same exception hierarchy
```

**Tests to write**

- 429 → `RateLimited` after policy-exhausted retries.
- Empty JSON → `ComponentNotFound`.
- Network error → `NetworkError`.
- Progress reporter is called on each retry with attempt number.

**Expected delta**: `easyeda_api.py` 200 → ~150 LOC + ~80 LOC for
exceptions / policy.

**Dependencies / blockers:** K4 wants this before its steps refactor.

---

## Phase C — Cross-cutting

### C-K2 · `background.js` service-worker split

**Status:** Pending. Recommendation: **Strong** — biggest single source
of friction in the extension half outside `app.js`.

**File**
- `chrome_extension/background.js` (2 355 LOC)

**Problem**

The MV3 service worker holds in a global `state` object:

- WebSocket lifecycle + health monitor.
- Job queue + task-push routing.
- Library inventory + validation.
- Settings persistence + sync.
- The runtime-message dispatch table.

Content scripts and popup reach in via `chrome.runtime.onMessage`, so
the SW *is* the API. Every change is a change to shared mutable state.

**Goal**

Three deep stores behind narrow seams:

- `JobOrchestrator` — `submit`, `onUpdate`, `cancel`. Owns task-push
  subscription and terminal-finalization.
- `LibraryStore` — `list`, `activate`, `validate`,
  `refreshInventory`.
- `SettingsSync` — chrome.storage ↔ backend in one direction.

`background.js` becomes the message-dispatch table.

This work *parallels* `JobStateStore` (PR #2) and `ProductButtonGroup`
(PR #5) on the content-script side. The job state lives in two places
(SW for cross-tab persistence; content for per-page UI); that's
intentional.

**Tests to write**

Vitest + jsdom + a fake `chrome.runtime`. Each store testable against
fake WebSocket adapter.

**Expected delta**: `background.js` 2 355 → ~400 LOC.

**Dependencies / blockers:** None — independent of Phase A. Could run
in parallel.

---

### C-K7 · `popup.js` per-tab modules

**Status:** Pending. Recommendation: **Speculative** — real but not
acute. Do after Phase A and C-K2.

**File**
- `chrome_extension/popup.js` (2 102 LOC)

**Problem**

Three tabs (Categories, Library, Settings) in one file with interleaved
render/handler code.

**Goal**

`CategoriesPanel`, `LibraryPanel`, `SettingsPanel` modules with
`mount(container) / unmount()` interfaces. `popup.js` becomes a
composer.

**Expected delta**: `popup.js` 2 102 → ~250 LOC + three ~600 LOC
panels.

**Dependencies / blockers:** Benefits from C-K2 being done first so
the popup uses a stable `JobOrchestrator` / `LibraryStore` API.

---

### C-K8 · Category Path single source of truth

**Status:** Pending. Recommendation: **Worth exploring** — small but
deletes drift risk.

**Files**
- `chrome_extension/categoryPath.js` (75 LOC; popup + background)
- `chrome_extension/src/content/categoryNormalize.js` (19 LOC; content)
- `easyeda2kicad/helpers.py` (Python mirror)

**Problem**

The Category Path normalization rule lives in two JavaScript files plus
a Python mirror. Drift has caused matching bugs before.

**Goal**

Single `chrome_extension/shared/categoryPath.mjs` imported by all three
JS surfaces. Python keeps its mirror, with paired tests (`tests/`) that
pin the matching to verify drift is detectable.

**Expected delta**: net -50 LOC across JS; paired tests add coverage.

**Dependencies / blockers:** None. Trivial PR.

---

## Verified non-issues

Things that *look* like easy wins but aren't:

- **`chrome_extension/contentScript.js` referenced in `.github/workflows/ci.yml`
  was removed in PR #0** — the file already did not exist; the CI check
  was dead. Don't re-add a `node --check` for that path.
- **`_k2cPdfResizeObserver` and `_k2cPdfROTimer` on the gallery overlay
  were dead code** — removed in PR #1. If you see references in old
  git history, ignore.
- **The `dialog.js` module is intentionally a low-level toolkit.** It
  is not a god module despite being large; do not try to split it.

---

## What is NOT in this plan

- **Rewriting** anything from scratch. The earlier session explicitly
  rejected a greenfield rewrite — the hidden bug fixes in comments
  alone ("Vue/Dark Reader Shadow DOM isolation", "PDF.js can't load in
  isolated world", "LCSC drops our row on re-render") would be
  rediscovered the hard way. Refactor only.
- **Changing public-facing behavior** (LCSC integration, KiCad output
  formats, popup workflow). Every PR so far is lift-and-shift; keep
  that discipline.
- **TypeScript migration.** Not in scope. The JSDoc comments give 80%
  of the value with 0 build-step cost.
- **Adding features** disguised as refactors. If you find yourself
  writing new behavior, that's a separate PR with the user's
  explicit OK.
- **Removing tests.** The 52 vitest cases pin current behavior. If a
  test fails during a refactor, that means the rewrite changed behavior,
  not that the test is wrong.

---

## Quick start for the next agent

1. Run `git log --oneline -6` to see the four refactor commits and
   their messages.
2. Read [CONTEXT.md](CONTEXT.md) for domain language.
3. Read one of the existing extracted modules end-to-end to absorb the
   style (`backendStatusMonitor.js` is the shortest, ~75 LOC).
4. Pick a PR — recommended next is **PR #3b (Category Dialog)** since
   it is the largest remaining single-function extraction and has no
   blockers.
5. Follow the five-step process from
   [Process](#process-the-pattern-that-worked).
6. Confirm with `npm test --prefix chrome_extension` before each
   commit. All 52 tests must stay green.
