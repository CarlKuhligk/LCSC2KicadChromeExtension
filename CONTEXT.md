# CONTEXT.md — Domain language

Reference for terms used in code, commit messages, and architecture
discussions. When a new domain concept shows up, add it here **before** it
becomes a module or class name. Names in this file are load‑bearing — they
should be used verbatim in code, not paraphrased.

---

## Surfaces

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
