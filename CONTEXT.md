# CONTEXT.md — Domain language

Reference for terms used in code, commit messages, and architecture
discussions. When a new domain concept shows up, add it here **before** it
becomes a module or class name. Names in this file are load‑bearing — they
should be used verbatim in code, not paraphrased.

> **V2 vs V3 (read first).** The **Surfaces**, **Content‑script concepts**,
> **Backend concepts**, and **Shared utilities** sections below describe the
> **V2** model (WebSocket backend, Job‑Queue, separate dialogs) and are kept as
> legacy reference. **V3 (current, on `master`)** supersedes them — see
> **V3 vocabulary** at the bottom: the **Native Host** (Native Messaging)
> replaces the WebSocket backend, streamed `progress` replaces the Job‑Queue,
> and the **Import‑Editor** replaces the separate Category/Value/Pin↔Pad
> dialogs. (Note: some extension code is still mid‑migration and uses the V2
> job/enqueue style — see ADR‑0004.)

---

## Surfaces _(V2 legacy — see V3 vocabulary below)_

- **Backend** — local Python process started by `run_server.py`. Imports parts
  from LCSC/EasyEDA and writes KiCad library files. Speaks WebSocket
  JSON‑RPC at `/ws/extension`.
- **Extension** — the Chrome/MV3 extension. Three surfaces share one backend
  socket: the **service worker** (`background.js`), the **popup**
  (`popup.html`/`popup.js`), and the **LCSC content script** (`src/content/`).
- **LCSC product page** — third‑party page at
  `lcsc.com/product-detail/...` augmented by the content script.

---

## Content‑script concepts

- **Product Button Group** — Shadow‑DOM‑wrapped row of download buttons
  injected next to LCSC's cart controls on a product page. One per page.
  Two sub‑buttons: **EasyEDA** (standard conversion) and **Template** (user
  template symbol).
- **Datasheet Panel** — extension‑origin iframe (`pdf_viewer.html`) that
  renders LCSC datasheet PDFs via PDF.js. Owns its own resize observer and
  postMessage protocol with the content script. Bytes are fetched by the
  backend and streamed into the panel.
- **Job Progress UI** — overlay row plus per‑button status updates that
  reflect a running **Conversion Job**. Subscribes to `task_update` pushes
  from the backend (via the service worker) and drives the Product Button
  Group through its `markBusy` / `markDone` / `markError` API. Owns the
  cross‑cutting job‑state maps (`jobWatchers`, `terminalJobHandled`,
  `confettiDoneForJobId`, `jobUiMonotone`).
- **LCSC Dialog** — modal dialog shown on the product page. Five flavors,
  all sharing the styling primitives in `dialog.js`:
  - **Category Dialog** — first‑time category‑rule setup.
  - **Value‑Param Fallback Dialog** — page has no recognizable Value
    parameter.
  - **Value‑Param Mismatch Dialog** — saved Value‑Param is absent on this
    page.
  - **Overwrite Dialog** — part already exists in the active library.
  - **Pin↔Pad Dialog** — see **Pin↔Pad Map** below.
- **Template Gallery** — picker shown when the user clicks
  **Download → Template**. Lists symbol names from libraries marked as
  **Template Libraries**; on hover, shows an SVG preview fetched from the
  backend.
- **Pin↔Pad Map** — user‑confirmed mapping of symbol pin numbers to
  footprint pad numbers. Sent to the backend as `template_pin_map`. Built
  interactively inside the Template Gallery using the footprint preview
  SVG with clickable pad labels.
- **Download Pipeline** — the ordered sequence of gates that runs before
  the `quickDownload` RPC is submitted:
  1. Backend online?
  2. Active library selected?
  3. Part already in library → Overwrite Dialog?
  4. Category resolved → Category Dialog if new?
  5. Value‑Param resolved → Value‑Param dialogs if missing/mismatched?
  6. Template branch only: pin‑count check → Pin↔Pad Dialog?
- **LCSC Page Snapshot** — frozen view of the DOM data needed for an
  import: LCSC ID, breadcrumb **Category Path**, attribute‑table param
  keys/values, datasheet URL. Re‑extracted per gate; the content script
  does not subscribe to DOM mutations for snapshot data.
- **Backend Status Monitor** — subscribes to backend connection state from
  the service worker and toggles the Product Button Group between
  "online" and "offline" presentation.

---

## Backend concepts

- **Active library** — the single library marked active in the popup. All
  imports write into its on‑disk paths.
- **Template library** — a library flagged as template‑mode. Its symbols
  populate the **Template Gallery** picker.
- **Category Rule** — popup‑stored row keyed by a normalized LCSC
  **Category Path** (e.g. `Passives/Resistors/SMD`) with **Value Param**
  and pin‑visibility flags. Matched per **deepest‑prefix** rule: among all
  rules, the longest key that equals the product path or is a strict
  prefix (`key + "/"`) wins.
- **Category Path** — canonical normalized form of an LCSC breadcrumb.
  Slashes separate segments, segments are trimmed, Unicode NFC, no leading
  or trailing slash. Same normalization on both extension and backend.
- **Conversion Job** — backend task submitted via the `quickDownload`
  RPC. Emits progress through `task_update` pushes until terminal
  (`done` / `error` / `cancelled`).
- **Template Merger** — combines a user‑drawn template `.kicad_sym` with
  LCSC/EasyEDA part data: keeps the template's geometry and property
  layout, syncs the symbol pin set to EasyEDA's pin set for the specific
  part, rewrites property values.

---

## Shared utilities

- **Category Path normalization** — the domain rule that turns an LCSC
  breadcrumb into a canonical **Category Path**. Currently implemented
  twice in JavaScript (`categoryPath.js` for popup + service worker,
  `src/content/categoryNormalize.js` for content script) and mirrored in
  Python (`helpers.py`). Pending consolidation; see architecture review
  Candidate 8.

---

## V3 vocabulary (current — implemented on `master`)

Terms locked during V3 grilling (2026-05-29), now largely in code on
`master`. See `V3-SPEC.md` for the broader spec, `docs/adr/` for the
load-bearing decisions. Use these names verbatim, not paraphrases.

- **Native Host** — Python process Chrome launches on-demand via Chrome
  Native Messaging. Replaces V2's standalone "Backend" / `run_server.py`
  server. Singleton per Chrome profile (one Service Worker → one host).
  _Avoid:_ "Backend", "server", "daemon" in V3 contexts.
- **Native-Host Manifest** — JSON file at the OS-specific Native-Messaging-host
  path (Windows registry / macOS `~/Library/...` / Linux `~/.config/...`)
  that tells Chrome where to find the **Native Host** binary. Written
  by the installer on first launch (Self-Register).
- **Phase 1 Fetch** — fast metadata RPC (~1 s) that pulls LCSC Category
  Path, pin count, datasheet URL. Returns enough to render the
  **Override Panel** with sensible defaults but does no Symbol / Footprint /
  3D work.
- **Phase 2 Conversion** — slow RPC (~5–10 s) that runs the EasyEDA
  pipeline with the user-resolved override sources baked in. Streams
  `progress` events on the same port until terminal `done` / `error`.
- **Override Panel** — V3's single inline UI shown between **Phase 1**
  and **Phase 2**. Lets the user pick Symbol source, Footprint source,
  and (when needed) confirm/remap the **Pin↔Pad Map**. Replaces V2's
  Template Gallery, Category Dialog, Value-Param dialogs, and Pin↔Pad
  Dialog as separate surfaces. Also the **Import-Editor** (ADR-0006): the
  one reusable surface for Register / Modify / low-confidence. Never fully
  skipped — in the 🟢 state it renders as a one-click confirm-preview.
- **Import-Editor** — conceptual name for the **Override Panel** in its
  three call contexts (Register / Modify / low-confidence). The code name
  stays `overridePanel.js`; "Import-Editor" is the role, not a second module.
- **Modify Button** (de: „Modifizieren") — small always-visible secondary
  action next to the V3 **Import** button. Opens the full **Import-Editor**
  for the special case. Supersedes the former "Customize Button" / `forcePanel`
  (ADR-0006): there is no panel to force open — the preview is always visible;
  in the 🟢 state Modify swaps the one-click confirm-preview for the full editor.
- **Confidence State** — `computeConfidenceState(rule, symbol, footprint, factors)`
  → `green | yellow | white`, the driver of the apply UX (ADR-0006; supersedes
  the former "Skip-Panel Flow"). 🟢 green = registered **Category Rule** + all
  MVP factors (symbol-template resolvable + category recognised) + high
  confidence → one-click **Import** (+ **Modify**); metadata is always
  auto-upserted, so "labels mapped" is not a separate 🟢 factor (ADR-0006 refined);
  🟡 yellow = anything in between → user setting (keep-EasyEDA + hint vs open
  Import-Editor); ⚪ white = no rule / no usable match → active **Register**
  prompt. One-click is derived from confidence, never from a rule flag; there
  is no zero-click write and no countdown.
- **Register** (de: „Registrieren") — the learning act in the **Import-Editor**:
  pick the Symbol source for a Category (+ **Value-Param** + **Pin-Visibility**;
  footprint/3D in a later slice), save a **Category Rule**, and raise confidence
  for future like parts. Metadata is auto-upserted (below), not mapped by hand.
- **Metadata Auto-Upsert** — V3 writes ALL LCSC spec-table params as symbol
  Properties on import (existing → value replaced, missing → added; stock/price
  pre-filtered by the scraper). Replaces V2's manual Label-Mapping / Metadata-
  Mapper UI (ADR-0006 refined): no per-rule editable mapping; the Import-Editor
  shows a **read-only property preview**. `ComponentRule` carries no `labelMapping`.
- **Value-Param** — the LCSC spec-table column name (e.g. "Resistance") whose
  value fills the KiCad symbol **Value** field. Per-rule (`valueParam`), chosen
  via a dropdown in the Import-Editor; auto-detected by priority
  (Resistance > Capacitance > Inductance > Voltage; `shared/valueParam.mjs`).
  The engine sets `symbol_value_override` (Ω-stripped for Resistance) and
  excludes that key from the auto-upserted Properties (no duplicate).
- **Category-Property Match** — a template symbol carries a KiCad `Category`
  property; at import the LCSC **Category Path** is matched against it
  (segment/prefix, case-insensitive). A UNIQUE hit self-registers a rule → 🟢
  one-click WITHOUT manual **Register**. Self-describing templates replace the
  earlier curated/seeded default-rules idea. (`matchTemplateByCategory` in
  confidenceState.mjs; `list_symbol_categories` in helpers.py.)
- **Pin-Visibility** — `hidePinNumbers` / `hidePinNames` on the rule hide pin
  numbers/names in the written symbol (≤2-pin parts R/C/L/D clutter schematics).
  The Import-Editor auto-pre-checks both for ≤2-pin parts; user can override.
  Applied on both symbol paths (template merger + EasyEDA exporter).
- **Anchor Card** — the LCSC product-page header table (the one
  containing "Hersteller", "Herst.-Teilenr.", "LCSC-Nr.") into which V3
  injects its **Download** + **Customize** controls as a new `<tr>`.
  Located by walking `<table>` elements and matching the LCSC-Nr. label
  multilingually, with a `/^C\d+$/` cell pattern as fallback.
- **Anchored / Float fallback** — the two DOM-injection modes. V3 tries
  **Anchored Card** injection first; falls back to a floating fixed-position
  panel only when the anchor walk returns null.
- **Pre-Warm** — Service-Worker keep-alive scheme triggered by the
  content script on LCSC page load. Opens the Native-Host port early so
  Python is hot by the time the user clicks. Backed by a 25-second
  `chrome.alarms` heartbeat against future Chrome lifecycle changes.
- **Warm-Port** — the single persistent `chrome.runtime.connectNative`
  port the service worker reuses for every RPC (ping, **Phase 1 Fetch**,
  **Phase 2 Conversion**, **Override Panel** reads). Replaces the
  pre-#26 connect-per-RPC model: because Chrome keeps a Native Host
  alive as long as any extension port references it, the **Pre-Warm**
  ping piggybacking on this port also holds the Python process warm
  across the whole session. Concurrent in-flight RPCs share the port
  via the Native-Messaging `id` field; the host's reader-thread +
  worker model serves fast read-only verbs while a slow `convert` runs.
- **3D Layer** — the implicit third override layer. **Follows the Footprint**:
  if the chosen Footprint is from a Template Library, the Template's
  `(model "...")` reference is the primary 3D source; if no reference
  exists on the Template Footprint, the EasyEDA 3D model is used as a
  fallback. EasyEDA Footprints always get the EasyEDA 3D. Not
  user-overridable in the panel. See **Template-3D Carry-Over** for the
  copy mechanics and ADR-0005 for the rationale.
- **Template-3D Carry-Over** — mechanic that lifts a 3D model file
  referenced by a Template Footprint into the active library so the
  written Footprint stands on its own. Steps: parse the Template
  `.kicad_mod` for `(model "...")` references; for each, if the path
  resolves inside the Template Library, copy the file to
  `<ActiveLib>.3dshapes/<basename>` (idempotent, deduplicated by content
  hash) and rewrite the reference to `${KIPRJMOD}/<ActiveLib>.3dshapes/...`;
  if the path uses a KiCad system variable (e.g. `${KICAD9_3DMODEL_DIR}`,
  `${KISYS3DMOD}`) or is otherwise outside the Template Library, leave
  the reference verbatim — no file copy.
- **Template-Assembly** — Phase 2 variant that runs when both Symbol
  Source and Footprint Source are Template (and the Template Footprint
  has a 3D reference, so no EasyEDA fallback is needed). No EasyEDA API
  call is made; the Phase 1 LCSC metadata supplies Value / Manufacturer
  / MPN / LCSC-Nr. for the symbol properties. The Template-only path that
  lets a user import an LCSC part for which EasyEDA has no Symbol and no
  Footprint at all.
- **Pin-Map Sidecar** — JSON file at `<TemplateLibrary>/pin_maps/<symbol>__<footprint>.json`
  that persists the pin↔pad mapping for a known (template-symbol,
  template-footprint) pair. Resolved at import time; user only remaps
  once per combination.
- **Self-Register** — first-run behaviour of the V3 installer binary:
  if the Native-Host Manifest is not present at the OS-specific path,
  write it and exit. Self-healing if the extension ID changes between
  Web Store releases.
- **Always Re-Resolve** — V3's template-version policy. Category Rules
  store only the template *name*. Every import reads the template file
  fresh from disk. No snapshotting, no per-Rule pinning.
