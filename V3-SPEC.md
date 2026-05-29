# V3-SPEC.md — KiCad Parts Importer V3

**Status:** decisions locked · 2026-05-29 · post-grilling
**Author:** theautomatist (idea owner) + Claude (drafter)
**Sibling docs:** [CONTEXT.md](CONTEXT.md) (domain language), [REFACTOR-PLAN.md](REFACTOR-PLAN.md) (V2 hand-off — now mostly archive), [docs/adr/](docs/adr/) (load-bearing decisions)

---

## Pitch

A simpler, smaller, more self-sufficient version of the KiCad Parts Importer.
Same job (LCSC → KiCad library), fewer moving parts, **one** import mode,
**no manual backend juggling**, **DOM integration that doesn't break when LCSC
repaints**.

V3 is the rewrite-from-experience: every part of V2 is examined under the rule
**"keep it stupid simple"** and either kept, simplified, or struck.

## Why V3

V2 grew incrementally. Each historical decision was right at the time:

- Two import modes (EasyEDA + Template) because Template was added later.
- A WebSocket backend because that was the simplest filesystem write path from a browser.
- Table-DOM selectors because the legacy LCSC page had a stable table.
- Job queue + task-update messages because early conversions felt slow.

None is the simplest solution today. V3 picks the simplest version of each.

---

## The workflow (V3 user journey, two-phase)

User opens an LCSC product page:

1. The **Anchor Card** in the LCSC product header gets a new `<tr>` containing
   the **Download** button and a small **Customize** button. (When the anchor
   walk fails, a floating-fixed panel is shown as fallback.)
2. User clicks **Download**.
3. **Phase 1 Fetch** runs (~1 s): backend pulls LCSC metadata — Category Path,
   pin count, datasheet URL.
4. Category Rule matches against the Category Path.
   - If the Rule **fully resolves** both Symbol source and Footprint source
     (no Pin↔Pad ambiguity), the Override Panel is **skipped** ("Skip-Panel Flow").
   - Otherwise the **Override Panel** renders inline with Rule defaults pre-filled:
     - Symbol: keep EasyEDA / replace with Template-X
     - Footprint: keep EasyEDA / replace with Template-Y
     - Pin↔Pad Map: auto, or confirm/remap if symbol/footprint disagree
5. **Phase 2 Conversion** runs (~5–10 s): EasyEDA pipeline with the resolved
   sources baked in (no wasted symbol-gen when Template is chosen). The
   **3D Layer** is always pulled when available and the `(model "${KIPRJMOD}/<lib>.3dshapes/...")`
   reference is applied to whichever Footprint ends up in the library.
6. Backend writes to the active library. Browser shows success.

Power-user with greifender Category Rule + Skip-Panel = **effective one-click flow**.
Edge-case (new Category, pin-map ambiguity, or clicked Customize) = one extra panel.

---

## Architectural decisions (post-grilling, all RESOLVED)

### 1. One import mode with overrides — **ACCEPTED**

There is **no** EasyEDA-vs-Template button choice. Overrides happen **after
Phase 1** as part of the Override Panel, before Phase 2.

Phase 2 has two execution modes that are an emergent consequence of the user's
source choices, not a UI toggle:

- **EasyEDA Pipeline** — at least one layer (Symbol or Footprint) is EasyEDA.
  Runs the EasyEDA conversion as in V2, then applies the user-resolved
  overrides on top.
- **Template-Assembly** — both Symbol and Footprint are Template **and** the
  Template Footprint carries its own 3D reference. EasyEDA's API is not
  called in Phase 2 at all. LCSC metadata from Phase 1 (Value / Manufacturer
  / MPN / LCSC-Nr.) is written into the symbol properties. This is the
  path that lets a user import an LCSC part for which EasyEDA has neither
  Symbol nor Footprint, as long as the user has both Template layers ready.

### 2. Template Library entries are two independent layers + 3D — **ACCEPTED with refinement**

A V3 Template Library is **two independent override layers**, persisted as:

```
MyTemplates.kicad_sym         ← Symbol layer (V2-compatible)
MyTemplates.pretty/X.kicad_mod ← Footprint layer
MyTemplates/pin_maps/<sym>__<fp>.json ← Pin-Map Sidecar (when needed)
```

"Symbol + Footprint together" is **not a compound entry** — it is the combination
of: Category Rule references both layers + a Pin-Map Sidecar resolves the
pairing. Each layer can be edited with native KiCad tooling.

The **3D Layer** is a third, **never-user-overridable** layer that **follows
the Footprint** (ADR-0005). Resolution at Phase 2 time:

1. **Footprint = Template:** parse the Template `.kicad_mod` for
   `(model "...")` references.
   - References resolving inside the Template Library → file is **carried
     over** to `<ActiveLib>.3dshapes/<basename>` (idempotent, deduplicated
     by content hash — multiple Template Footprints may share a single
     `.step`), and the reference is rewritten to `${KIPRJMOD}/<ActiveLib>.3dshapes/...`.
   - References using a KiCad system variable (e.g. `${KICAD9_3DMODEL_DIR}`,
     `${KISYS3DMOD}`) or any absolute path outside the Template Library
     → reference left verbatim, no file copy. The KiCad user is assumed
     to have these resolvable in their environment.
2. **Footprint = Template, no `(model ...)` reference found:** fall back
   to EasyEDA 3D. EasyEDA-3D is downloaded (if available) and the
   reference is appended to the Template Footprint. Geometric alignment
   is the user's responsibility.
3. **Footprint = EasyEDA:** EasyEDA-3D is downloaded as in V2, stored
   at `<ActiveLib>.3dshapes/X.step`, reference applied.
4. **No 3D from any source:** Phase 2 emits a `no 3D` progress message
   and writes the Footprint without a model reference. Not an error.

### 3. Backend invocation: **Chrome Native Messaging** — **ACCEPTED**

See [ADR-0001](docs/adr/0001-backend-via-chrome-native-messaging.md).

Installer is a PyInstaller single-file binary that **Self-Registers** the
Native-Host Manifest on first launch at the OS-specific Native-Messaging-host
path (Windows registry, macOS `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`,
Linux `~/.config/google-chrome/NativeMessagingHosts/`). MSI/PKG/signed-installer
is a Phase-2 polish.

**Cold-start mitigation: Pre-Warm on LCSC navigation.** Content script wakes
the Service Worker on page load; SW opens the Native-Host port; Python is hot
by the time the user clicks. 25-second `chrome.alarms` heartbeat as
belt-and-suspenders.

### 4. DOM injection: Anchored Card first, Float fallback — **ACCEPTED**

V3 injects the Download/Customize controls as a new `<tr>` inside the LCSC
**Anchor Card** (the header table containing "LCSC-Nr.", "Hersteller", etc.).
Detection walks `<table>` elements; matches by multilingual label list
("LCSC-Nr.", "LCSC#", "LCSC Part #", "LCSC编号") with a `/^C\d+$/` cell pattern
as fallback heuristic.

When the walk returns null (LCSC ships an unanticipated layout), the existing
**Float Fallback** (`buildFloatHostStyle()`) kicks in. The existing
`extractPageData()` walk in `lcscPageSnapshot.js` already iterates every table
and is the natural seam for the anchor detector.

### 5. Job model: Streamed Progress, no Job state — **ACCEPTED**

See [ADR-0004](docs/adr/0004-streamed-progress-no-job-state.md).

One RPC per click. Backend streams free-form `progress` messages on the same
Native-Host port until `done` / `error`. No queue, no job IDs, no cancellation,
no multi-subscriber bus. Concurrent imports across tabs return `busy`.

### 6. No standalone server, no API base URL — **ACCEPTED**

Direct consequence of #3. Popup loses "Backend URL + Test".

### 7. Settings simplified — **ACCEPTED**

Three popup tabs:

- **Categories** — same model as V2 (deepest-prefix), extended to optionally
  reference Template Library entries as Symbol / Footprint defaults plus an
  "auto-confirm" flag enabling Skip-Panel Flow per Rule.
- **Library** — active KiCad library + Template Libraries list.
- **Settings** — theme, debug logs, overwrite policies, "Always show Override
  Panel" master toggle (default OFF).

Removed: API base URL + Test.

---

## Resolved open questions

| # | Question | Resolution |
|---|---|---|
| 1 | Backend deployment: A / B / C? | **A — Chrome Native Messaging** with self-registering installer. See ADR-0001. |
| 2 | Categories: folders or tags? | **Folders (slash-paths).** Matches LCSC breadcrumb structure, enables deepest-prefix-match. |
| 3 | Template version pinning? | **Always Re-Resolve at import time.** Category Rule stores only the template name; file is read fresh on every conversion. |
| 4 | Chrome Web Store identity? | **New listing.** V2 unpublished at V3 release. See ADR-0003. |
| 5 | EasyEDA-only legacy mode? | **No.** Skip-Panel Flow + Customize button covers the use case without a dedicated toggle. |

---

## In scope — features V3 has

- LCSC product page → KiCad library import.
- EasyEDA conversion as the default pipeline (Symbol + Footprint + 3D).
- Template Library entries as two independent layers (Symbol-only, Footprint-only,
  or both via Rule + Sidecar).
- **Template-Assembly path** — import an LCSC part using only Template
  Symbol + Template Footprint + Template 3D when EasyEDA has nothing
  to offer for that part. Phase 1 LCSC metadata fills the symbol
  properties; no EasyEDA call in Phase 2.
- **Template-3D Carry-Over** — Template Footprints with their own
  `(model "...")` references have those references and the underlying
  files lifted into the active library automatically (deduplicated, system
  paths preserved).
- Category Rules (deepest-prefix match) **extended with Symbol/Footprint
  defaults + auto-confirm flag**.
- Pin↔Pad map override UI when sources disagree; persisted as Pin-Map Sidecar.
- Datasheet PDF preview inside the Override Panel.
- LCSC parameter table → KiCad symbol properties.
- Overwrite-existing-part handling (one inline confirmation, not a separate dialog).

## Out of scope — what V3 strikes from V2

- The "EasyEDA mode" button. Default behavior covers it.
- The separate Template-mode flow. Templates are override layers.
- Manual backend URL + Test connection.
- The 5-dialog cascade. Override Panel + inline Overwrite confirmation replace
  the Category / Value-Param / Pin↔Pad / Template-Gallery dialogs.
- Two-step pin-count check followed by Pin↔Pad modal. Inline in panel.
- Job queue + task_update bus. Streamed progress on the same port.
- WebSocket transport. Native Messaging stdin/stdout.
- Three-layered fallback for the 3D path. Library-relative single convention.
- LCSC table-DOM selectors via class names. Structural anchor walk.
- `chrome.storage` migration from V2. Clean break.

---

## Migration from V2 — **none (clean break)**

See [ADR-0003](docs/adr/0003-clean-break-from-v2.md).

V3 is a new Web Store listing with a new extension ID. V2 is unpublished at V3
release. **No `chrome.storage` carryover, no compat shims.** V3 codebase reads
no V2 state. Existing V2 installs continue working with their V2 backend but
receive no further updates.

Documentation will include a "Coming from V2" page explaining how to translate
old Categories / Template-Library settings into the V3 onboarding flow — but
this is a human-readable note, not a code path.

---

## What V3 explicitly is NOT

- Not a TypeScript / framework rewrite. Vanilla ES modules + Python stays.
- Not a fork of EasyEDA. We rely on EasyEDA's strengths and only swap when
  the user has a better local version.
- Not a marketplace for templates. They're files on the user's disk.
- Not multi-user / multi-machine.
- Not all LCSC variants. Anchor strategy targets robustness on the common
  layouts; floating fallback covers the rest.

---

## Effort estimate

Part-time pace (~2 evenings per week):

| Phase | Scope | Estimate |
|---|---|---|
| R2 diagnose+fix in V2 | Click regression, most likely "backend not running" → backend-online state | 1 h |
| V3 walking skeleton | Native Messaging hello-world + Self-Register installer + dummy template-override conversion | 2 evenings |
| V3 backend | Phase 1 / Phase 2 RPC, override applier, Pin-Map Sidecar resolution, 3D layer integration | 1–2 weeks |
| V3 extension | Anchor Card injection, Override Panel, Pre-Warm wiring, Skip-Panel logic | 1–2 weeks |
| Installer hardening | Self-Register correctness across Windows / macOS / Linux, Chrome Web Store packaging | 3–5 days |
| V3 launch + V2 unpublish | Store submission, V2 unpublish, "Coming from V2" doc | 1–2 days |

**Total: ~5–7 weeks part-time.**

---

## Current state of the V2 codebase (snapshot 2026-05-29, commit `84df7ab`)

Already in place that V3 can reuse / reference:

- **Domain language** — `CONTEXT.md` has the V3 vocabulary appended after the
  V2 section. Names will be used verbatim in V3 code.
- **Single source of truth for Category Path** — `shared/categoryPath.mjs`,
  consumed by content / popup / SW; Python mirror in `helpers.py`. Paired
  drift-detection tests on both sides.
- **Tailwind-era LCSC scraper** — `lcscPageSnapshot.js`, structural detection,
  18 Vitest cases against the live C22548 DE dump. V3 reuses the table-walk
  as the anchor detector.
- **Web-accessible-resources guard rail** — `tests/test_extension_manifest.py`
  prevents silent-broken-extension regressions. V3 keeps this pattern.
- **52 → 108 Vitest cases** pinning cross-cutting state. Useful as
  reference; not all will port to V3's simpler model.

NOT yet there (open from REFACTOR-PLAN.md — will likely **not** be done since
V2 is being unpublished at V3 release):

- Overwrite Dialog still inline in `app.js` (PR #3c).
- Template Gallery still inline in `app.js` (PR #4).
- Product Button Group still inline in `app.js` (PR #5).
- Download Pipeline still inline (PR #6).
- Backend candidates B-K3 / B-K4 / B-K5 / B-K6 not started.

`chrome_extension/src/content/app.js`: **5 404 LOC**.

---

## Known regressions / pending fixes

### R1 — Float button has the wrong UX (won't fix in V2)

**Status:** V2 will not get an anchored-injection fix. V3's
Anchor-Card-first injection (Decision #4) is the resolution. V2 stays
float-only until unpublish.

### R2 — Click on the float button does nothing (urgent, fix in next session)

**Symptom:** float panel renders, but clicking Download triggers no observable
action.

**Hypotheses, ranked:**

1. **Backend not running.** Button stays in "Backend: checking" placeholder
   state because `refreshButtonGroup` never resolves the backend-online check.
   Verify by running `python run_server.py` from the repo and re-clicking.
   First diagnostic: `chrome://extensions` → service worker console → look
   for `[easyeda2kicad]` errors / WebSocket failures.
2. **`handleDownloadClick` references deleted findInsertionPoint / tbody
   chain.** Step in DevTools.
3. **Shadow-DOM event propagation broken** because the fixed-position
   container sits at `z-index: 2147483646` and LCSC may have an overlay
   intercepting clicks.
4. **`onclick` assignment timing** — placeholder button had
   `setButtonDisabledPlaceholder`; the real onclick is set in
   `refreshButtonGroup`. If that never runs, button stays a no-op.

**Affected files:** `chrome_extension/src/content/app.js` —
`refreshButtonGroup`, `handleDownloadClick`, `attachButton`.

**Estimated effort:** 1 hour to diagnose, less to fix.

### R3 — Module manifest oversight (mitigated)

PRs #0–#3b shipped six new content-script modules without adding them to
`web_accessible_resources`. Commit `84df7ab` fixed with a glob + Pytest guard.
Mitigated, no further action.

---

## What to do next (post-grilling, sequenced)

1. **Fix R2.** Diagnose via service-worker console. Likely cause: backend
   wasn't running. Confirm by starting `run_server.py` and clicking.
2. **V3 Walking Skeleton (2 evenings).** Spike validates the riskiest V3
   decision (Native Messaging) before committing to the full build:
   - Native-Host Manifest written by a hand-rolled installer script (one OS
     to start — Windows since you're on Windows 11).
   - Service Worker opens a Native-Host port with a placeholder
     `kicad_importer_host` binary.
   - Binary responds to a dummy `fetchMetadata` RPC with synthetic data and
     a dummy `convert` RPC that writes a synthetic file.
   - LCSC content script (fake fixture, not the real page) calls through and
     renders an Override Panel skeleton.
3. **If the spike clears (no Python cold-start blocker, no install-pathology):**
   commit to the full V3 backend + extension build per the Effort table.
4. **If the spike surfaces a blocker:** revisit Decision #3 (Native Messaging).
   The next-best path is Option C (system-tray app); Option B (KiCad plugin)
   stays rejected.
5. **Skip everything in REFACTOR-PLAN.md.** Clean break means V2 cleanup is
   wasted effort.

---

## Process lessons from this session

- **"Tests green" is not "shipped working"** when the test harness mocks the
  production loading environment. Vitest + jsdom does not enforce Chrome MV3's
  `web_accessible_resources` contract. Six PRs in a row were green and broken.
  Fix: never claim "done" on an extension PR without `chrome://extensions` →
  reload → page refresh → user-visible action triggered. Sixty seconds, and it
  catches an entire class of bug Vitest never will.
- **Empirical UX beats abstract elegance.** The float-panel decision was
  defensible in theory (zero DOM dependency, future-proof). It was worse in
  practice the moment the user moved a mouse. V3 returns to anchored-first
  on empirical grounds.
- **CI guards earn their keep when the cost of the bug they prevent exceeds
  the cost of writing them.** `test_extension_manifest.py` is 30 lines and
  prevents a class of silent breakage. Apply the same calculus before any V3
  module extraction.
- **Clean breaks remove huge classes of decisions.** Once V3 was scoped as
  "new listing, no migration code," half a dozen design questions collapsed
  to "do what's right for V3, ignore V2." Worth doing whenever the cost of
  in-place compat exceeds the cost of a one-time discovery push to users.
