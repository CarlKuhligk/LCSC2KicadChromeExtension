# KiCad Parts Importer

Chrome extension for [LCSC](https://www.lcsc.com/) plus a local Python backend: import components into a selected KiCad library using EasyEDA-sourced data (symbol, footprint, 3D) and optional **your own KiCad symbol templates**.

> [!WARNING]
> EasyEDA source data can contain issues. **Always verify pins and footprints** before using converted parts in production.

<p align="center">
  <img src="/img/store_images/store-card.jpg" alt="KiCad Parts Importer" />
</p>

```mermaid
flowchart LR
  lcsc[LCSC website] <--> ext[Chrome extension]
  ext <-->|WebSocket JSON-RPC plus task push| api[Local backend API]
  api --> easyeda[EasyEDA API]
  api --> disk[KiCad libraries on disk]
```

The extension service worker talks to the backend only over **`/ws/extension`** (`ws://` or `wss://`, same host/port as the configured server URL). Job progress is **pushed** (`task_update`); there is **no HTTP polling** for tasks. The Python app exposes **no HTTP REST API**—only this WebSocket.

## Contents

- [Quick start](#quick-start)
- [How downloading works](#how-downloading-works)
- [Product-page flow (diagrams)](#product-page-flow-diagrams)
- [Extension popup reference](#extension-popup-reference)
- [Features in detail](#features-in-detail)
- [UI screenshots](#ui-and-lcsc-website-integration)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Credits & license](#credits)

## Quick start

1. **Extension**
   - [Chrome Web Store](https://chromewebstore.google.com/detail/ojkpgmndjlkghmaccanfophkcngdkpmi), or  
   - Load unpacked: `chrome://extensions` → Developer mode → **Load unpacked** → select `chrome_extension/`.

2. **Backend** (required for import) — from [Releases](../../releases):
   - macOS/Linux: `chmod +x "./<version>-KiCad Parts Importer-<OS>"` then run the binary.
   - macOS Gatekeeper: `xattr -dr com.apple.quarantine "./<version>-KiCad Parts Importer-Mac"`
   - Windows: run `"<version>-KiCad Parts Importer-Windows.exe"`

3. Open [lcsc.com](https://www.lcsc.com/), pick a library in the extension, and use **Download / EasyEDA** or **Download / Template** on **product detail** pages (`/product-detail/...`).

## How downloading works

Rough order on a **product page** (details in [Features](#features-in-detail)):

1. **Backend reachable** (WebSocket to `/ws/extension`) — otherwise the UI shows offline. If the backend is up but the extension stays offline, check **proxies or security software blocking WebSockets** to `localhost`.
2. **Already in library?** If global overwrite is off, **Overwrite?** is asked **first** (Override / Permanent override / Cancel).
3. **Category & value field** — new category, missing LCSC table data, or mismatched saved “Value parameter” → dialogs (Skip / Save & continue / Continue / Cancel, etc.).
4. **Template path** (optional) — choose **EasyEDA** (LCSC) or **Template**; template libraries can expose a dropdown. If EasyEDA and template pin counts differ, a **pin mismatch** flow can appear (continue with template constraints or fall back to EasyEDA).
5. **Conversion** — job runs; success state and optional confetti on the in-page progress UI.

List pages use a compact download button with the same backend checks where applicable (no separate **Template** dropdown — **EasyEDA** path only).

### Product-page flow (diagrams)

Below: **(1)** how you enter the shared download pipeline from the grouped buttons, **(2)** what happens inside that pipeline until a job starts. Cancelling any modal returns to a **ready-to-click** state (green “in library”, blue “download”, or partial — see table).

#### 1 — Entry: EasyEDA vs Template (pin gate)

```mermaid
flowchart TB
  idle(["Starting state: button group idle<br/>EasyEDA + Template visible"])
  idle -->|Click EasyEDA| pipe["Enter pipeline: handleDownloadClick()"]
  idle -->|Click Template → choose symbol| pin{"Backend:<br/>templatesPinCheck"}
  pin -->|counts match| pipe
  pin -->|counts differ| mis["Pin mismatch bar<br/>(product page progress row)"]
  mis -->|Continue with template| pipeFT["Enter pipeline with<br/>useTemplate + forceTemplate"]
  mis -->|Download EasyEDA model| pipe
  pipeFT --> pipe
  idle -.->|Close dropdown without pick| idle
```

#### 2 — Pipeline inside `handleDownloadClick` (after entry)

Order is fixed: **backend check → optional overwrite → category/value dialogs → job**.

```mermaid
flowchart TB
  start(["Enter handleDownloadClick"])
  start --> be{"Backend<br/>connected?"}
  be -->|no| off["Offline styling"]
  be -->|yes| ow{"Part in library<br/>overwrite off in settings<br/>no one-shot overwrite?"}
  ow -->|yes| od["Overwrite dialog"]
  od -->|Cancel| rs["Restore green exists"]
  od -->|Override| once["One-shot overwrite"]
  od -->|Permanent| perm["Overwrite on in settings"]
  dlg["Category and value dialogs"]
  once --> dlg
  perm --> dlg
  ow -->|no| dlg
  dlg --> nc{"LCSC category<br/>unknown?"}
  nc -->|no| vp{"No LCSC params<br/>on page?"}
  nc -->|yes| cat["New category dialog"]
  cat -->|Cancel| ab["Abort → refresh group"]
  cat -->|Skip or Save or Continue| mm
  vp -->|yes| fb["No parameters dialog"]
  fb -->|Cancel| ab
  fb -->|EasyEDA default| mm
  fb -->|Configure| cat2["Category dialog"]
  cat2 -->|Cancel| ab
  cat2 -->|done| mm
  vp -->|no| mm
  mm{"Saved Value Param<br/>not on page?"}
  mm -->|yes| vm["Value param mismatch"]
  vm -->|Cancel| ab
  vm -->|EasyEDA default| job
  vm -->|Change| cat3["Category dialog"]
  cat3 -->|Cancel| ab
  cat3 -->|done| job
  mm -->|no| job
  job["Pending → quickDownload → job UI"]
```

\*After **New category** completes, the **No LCSC params** dialog is **skipped** (`needsValueParamFromPage && !categoryDialogShown`); flow goes straight to the **Value param mismatch** check (`mm`).

#### 3 — State / phase reference

| Phase | When it appears | User choices | Where you land after |
| --- | --- | --- | --- |
| **Idle (group)** | Default on product page | — | EasyEDA = LCSC import; Template opens searchable list. |
| **Template dropdown** | Template clicked, templates exist | Pick symbol / filter / click outside | **Pick** → pin check; **outside click** → same idle as before. |
| **Pin check** | After template symbol chosen | — (automatic) | Match → pipeline; mismatch → pin mismatch bar. |
| **Pin mismatch** | EasyEDA pin count ≠ template pin count | **Continue (incompatible…)** → forced template import; **Download EasyEDA model** → LCSC symbol path | Enters pipeline with `forceTemplate` or plain EasyEDA. |
| **Backend offline** | `getState` not connected | — | Grey/offline buttons until backend returns. |
| **Overwrite** | `libState === exists` and both overwrite toggles off and not already a one-shot overwrite | **Override** (once) · **Permanent override** · **Cancel** | **Cancel** → green exists, idle. **Override/Permanent** → continue pipeline (Permanent turns overwrite on for later). |
| **New category** | No saved row matches this product’s **full LCSC path** (deepest-prefix rules + legacy short keys) | Skip · Save & continue · Continue · Cancel | **Cancel** → abort, refresh group (skip idle reset flash). Others → next checks. |
| **No parameters** | LCSC table empty / unread and new-category dialog did not already run | Cancel · Use EasyEDA default · Configure… | **Cancel** → abort. **Configure** → category dialog. |
| **Value param mismatch** | Saved Value Param not on page | Cancel · EasyEDA default · Change… | **Cancel** → abort. **Change** → category dialog. |
| **Job** | All gates passed | — | Progress bar → success (confetti) → auto-switch to exists, or error message. |

> **Note:** After **Cancel** on any blocking dialog, the extension calls `resumeDownloadUiAfterCategoryAbort`: buttons re-enable and library state is re-checked (`refreshButtonGroup` with `skipIdleReset` on the product group) so the UI matches “already in library” when applicable.

## Extension popup reference

The popup talks to the **local backend** over **WebSocket** (`/ws/extension`). Everything below is configured here unless noted (imports themselves run from **LCSC product pages**).

### Header

| UI | What it does |
| --- | --- |
| **LCSC Parts** | Popup title. |
| **Active library** | Subtitle under the title: which library is **active** — EasyEDA / Template downloads write into that library’s folder. |
| **Backend:** | Status next to the title: whether the WebSocket to the configured API base URL is up. If offline, a red **connection hint** below the tabs may explain a missing URL or unreachable server. |

### Library tab

| UI | What it does |
| --- | --- |
| **Add** | Opens **Add library** (see below). |
| **Search libraries…** | Filters the list by name or path text. |
| **Summary line** | Total symbol / footprint / 3D counts; filter shows “matches / total”. |
| **Each library row** | **Name** and on-disk path; **Active** badge or **Activate** to make it the import target; **Missing** if the folder is gone; **TEMPLATE** badge when that library is a **template library**. |
| **Template** switch | Marks the library as a **template library** (symbols in it can be chosen as templates on the LCSC page). |
| **Remove (×)** | Removes the library from the extension list only (does not delete files). |

### Add library (modal)

| Field / control | What it does |
| --- | --- |
| **Library name** | Name for this KiCad library (required). |
| **Base folder** | Root directory on disk (required for **Create**). Use **Browse…** to open the folder picker (requires backend connection). |
| **Create symbol library (.kicad_sym)** | Create a `.kicad_sym` in that tree when using **Create**. |
| **Create footprint folder (.pretty)** | Create a `.pretty` footprint folder. |
| **Create 3D folder (.3dshapes)** | Create a `.3dshapes` folder for STEP/OBJ. |
| **Project relative 3D paths** | When on, 3D model paths in KiCad use **`${KIPRJMOD}`** plus the **3D base path** (folder relative to the board project). |
| **3D base path** | Shown when project-relative is on; appended after `${KIPRJMOD}/` (e.g. `../../library`). |
| **Import library** (footer) | Opens the file picker to select an existing **`.kicad_sym`**; the backend registers it as a library in the list (requires backend connection). |
| **Create** | Creates the selected structure under **Base folder** and registers the library. |
| **Cancel** | Closes without saving. |

**3D path mode for imports:** Each library stores **Project relative 3D paths** and **3D base path** from **Create** (or from the backend when importing). When you run an import, the extension uses the **active library**’s flags and path, and if the library’s **3D base path** is empty it falls back to **Settings → Import defaults** (`projectRelativePath`). Changing **Import defaults** updates global state and pre-fills the Add-library modal; it does not rewrite existing libraries’ stored paths.

### Settings — Backend

| Setting | What it does |
| --- | --- |
| **API base URL** | Base URL of the easyeda2kicad server (same host/port as `run_server.py`), e.g. `http://localhost:8087`. Used for HTTP health checks and the **WebSocket** connection. |
| **Test** | Checks that the backend is reachable (does not run a full conversion). |

### Settings — Appearance

| Setting | What it does |
| --- | --- |
| **Light / Dark** | **Popup-only** theme (LCSC pages and in-page import UI are unchanged). Stored in Chrome local storage. |

### Settings — Import defaults

Defaults apply to **LCSC imports** from the product page unless you choose a one-off override there (e.g. temporary overwrite).

| Setting | What it does |
| --- | --- |
| **Overwrite footprints & symbols by default** | If a part already exists in the library, replace symbol/footprint files without asking each time (you can still get the overwrite dialog when both overwrites are off). |
| **Overwrite 3D models by default** | Same for 3D model files. |
| **Enable debug logging** | Extra **service worker** logging (`[KPI jobs]`, verbose RPC). See [Debug logging](#debug-logging-jobs--websocket). |
| **Project relative 3D paths by default** | When enabled, **3D base path** is shown: path relative to the KiCad project, combined with `${KIPRJMOD}` in generated model references. |

### Settings — Categories & templates

| UI | What it does |
| --- | --- |
| **Add** | Adds a new expandable **category row**. |

Each **category row**: click the **header** (name + chevron) to expand or collapse. **×** removes that row after confirmation (clears saved Value / pin options for that key).

When expanded:

| Field | What it does |
| --- | --- |
| **Category name** | Text field in the row **header** (always visible). **Lookup key** for LCSC’s category breadcrumb: use a **full path** with `/` (e.g. `Passives/Resistors/SMD`), normalized when saved. The extension picks the **longest stored key** that equals the product path or is a **prefix** of it (deeper row beats a parent). **Legacy:** a key **without** `/` still matches the **second** segment of the LCSC path (e.g. built-in `Resistors`, `Capacitors`, `Inductors`). |
| **Value Param** | Name of the LCSC **parameter column** whose value becomes the KiCad symbol **Value** (e.g. `Resistance`, `Capacitance`). Must match a label on the product page tables. |
| **Hide pin numbers** | Passed to conversion: omit pin numbers on the generated symbol. |
| **Hide pin names** | Omit pin names on the generated symbol. |

**Templates:** Which **template symbol** to use is chosen on the **LCSC product page** (Template dropdown), not in this table. Here you only maintain **template libraries** on the Library tab.

Category rows save as you edit (debounced). They are merged into extension + backend **categorySettings** used for category checks and each import job.

### Category / value dialogs (on LCSC)

When the product path has **no** matching category row → **New category** dialog (**Skip**, **Save & continue**, **Continue**, **Cancel**).  
If the attributes table is empty/unreadable → **No parameters** dialog.  
If the saved **Value Param** is missing on the page → **Value param mismatch** dialog.  
Details remain in the [flow diagram](#2--pipeline-inside-handledownloadclick-after-entry) and table above it.

### Where settings live

Libraries, global settings (URL, overwrites, theme, import defaults, category table), and the active library selection are kept in **Chrome extension storage** and mirrored in the **service worker** while the extension runs. The backend receives updates when connected (e.g. **updateSettings**, **updateLibraries**).

## Features in detail

### Per-category symbol settings (summary)

The popup **Categories** table is the single place to edit per-path **Value Param** and **hide pin** options. Matching uses **full LCSC path + longest-prefix** rules and **legacy second-segment** keys — see [Settings — Categories & templates](#settings--categories--templates).

Default rows ship for **Resistors**, **Capacitors**, **Inductors** (typical value fields + pin hiding). Add rows for finer paths (e.g. `…/SMD`) when you need different **Value** sources under the same parent category.

### LCSC metadata → KiCad properties

The content script merges **`table.tableInfoWrap`**, **`v-data-table.common-table-v7`**, and **`paramsItem`** data. Typical mapped fields include **Datasheet**, **Description**, **Manufacturer**, **LCSC Part**, **Package**, plus parameters normalized through a label map (Power, Tolerance, voltage ratings, DCR, etc.) — same idea as in the extension’s parameter mapping tables.

### Template symbols (`Templates.kicad_sym`)

You can place **`Templates.kicad_sym`** next to your symbol library and define symbols such as `Template_Resistor`, `Template_Capacitor`, `Template_Capacitor_Polarized`, `Template_Inductor` (names configurable when picking a template at download).

- **Multiple libraries** can be marked as template libraries; the backend/extension aggregate template symbol lists.
- **Merge behaviour:** the importer aligns the template’s **pin table** with EasyEDA (adds missing pins at the origin, removes template-only pins) so electrical pin sets stay consistent.
- **WebSocket RPC** `templates_pin_check` compares EasyEDA vs template pin counts before conversion; `force_template` on conversion tasks avoids falling back to the raw EasyEDA symbol when you explicitly require the template path.

Required properties on templates include at least **Reference**, **Value**, **Footprint**, **Datasheet**, **Description**; manufacturer/LCSC/JLC and scraped params are appended as hidden fields.

### Network resilience

EasyEDA fetches (component CAD, 3D OBJ/STEP) use **timeouts and retries** with user-visible status where possible.

## UI and LCSC website integration

| Extension settings | Library management |
| --- | --- |
| ![Extension settings](img/extension_settings.png) | ![Library management](img/extension_library.png) |
| Backend URL, overwrite defaults, project-relative paths, categories. | Libraries, counts, status. |

| Add a library |
| --- |
| ![Add a library](img/extension_add_library.png) |

Part import (templates, LCSC details, outputs) is done from **LCSC product pages** via the in-page controls, not the extension popup.

| LCSC product page | After download |
| --- | --- |
| ![LCSC part download button](img/browser_part_download.png) | ![LCSC part downloaded](img/browser_part_dowloaded.png) |

## Repository layout

| Path | Role |
| --- | --- |
| `chrome_extension/` | Manifest V3 extension (content script, service worker, popup). |
| `easyeda2kicad/` | Conversion core: EasyEDA parsing, KiCad export, `template_merger.py`. |
| `easyeda2kicad/api/` | FastAPI app (`server.py`) — tasks, library checks, `templates/pin-check`, etc. |
| `easyeda2kicad/service/` | Orchestration (`conversion.py`). |
| `run_server.py` | Entry point to run the API locally. |
| `tests/` | Pytest (API, template merger, …). |
| `docs/` | Design notes (e.g. template dropdown / pin-check plan). |

## Development

```bash
# Python env with dev dependencies, then:
python -m pytest tests/

# Run API (default port often 8087 — see extension settings / run_server.py)
python run_server.py
```

Load the extension from `chrome_extension/` as **unpacked** and point it at your local backend URL.

**Extension architecture & refactor playbook:** [docs/extension-refactor-strategy.md](docs/extension-refactor-strategy.md) (data flow, design tokens, **manual regression checklist**, optional ESLint/bundler notes).

### Debug logging (jobs / WebSocket)

- **Extension:** With **Settings → Debug logs** enabled, the service worker logs **`[KPI jobs]`** (enqueue, `task_update`, merge) and **`[KPI jobs verbose]`** (RPC params/results, `list_tasks`). To trace jobs without the popup, set **`KPI_JOB_TRACE = true`** at the top of `chrome_extension/background.js` (remember to turn it off). Open the worker via `chrome://extensions` → **Service worker**.
- **Backend:** Set `EASYEDA2KICAD_WS_JOB_TRACE=1` when starting the API to log **`[ws-job]`** lines (enqueue, worker pickup, `broadcast` push counts, completion). Example (PowerShell):  
  `$env:EASYEDA2KICAD_WS_JOB_TRACE='1'; python run_server.py`

## Credits

Based on [easyeda2kicad](https://github.com/uPesy/easyeda2kicad.py) by uPesy.

## License

> [!NOTE]
> This repository includes code from the original **AGPL-3.0** project; that license continues to apply to those parts. New contributions are intended to remain **free to use, non-commercial** where separately noted; this does not change AGPL terms for upstream code.

See `LICENSE` (AGPL-3.0).
