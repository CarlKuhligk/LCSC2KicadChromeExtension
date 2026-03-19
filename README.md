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
  ext <--> api[Local backend API]
  api --> easyeda[EasyEDA API]
  api --> disk[KiCad libraries on disk]
```

## Contents

- [Quick start](#quick-start)
- [How downloading works](#how-downloading-works)
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

3. Open [lcsc.com](https://www.lcsc.com/), pick a library in the extension, and use **Download** on product or list pages.

## How downloading works

Rough order on a **product page** (details in [Features](#features-in-detail)):

1. **Backend reachable** — otherwise the UI shows offline.
2. **Already in library?** If global overwrite is off, **Overwrite?** is asked **first** (Override / Permanent override / Cancel).
3. **Category & value field** — new category, missing LCSC table data, or mismatched saved “Value parameter” → dialogs (Skip / Save & continue / Continue / Cancel, etc.).
4. **Template path** (optional) — choose **EasyEDA** (LCSC) or **Template**; template libraries can expose a dropdown. If EasyEDA and template pin counts differ, a **pin mismatch** flow can appear (continue with template constraints or fall back to EasyEDA).
5. **Conversion** — job runs; success state and optional confetti on the in-page progress UI.

List pages use a compact download button with the same backend checks where applicable.

## Features in detail

### Per-category symbol settings (extension Settings)

| Setting | Meaning |
| --- | --- |
| **Hide Num** | Hide pin numbers on the generated symbol |
| **Hide Name** | Hide pin names on the generated symbol |
| **Value Param** | Which LCSC attribute fills KiCad **Value** (e.g. `Resistance`, `Capacitance`) |

When a **new LCSC category** appears, a dialog offers **Skip**, **Save & continue** (persist for that category), **Continue** (this import only), or **Cancel**.

If the product **attributes table** cannot be read, you get **Use EasyEDA default** or **Configure value source…** (same options as above).  
If the table was read but your saved **Value Param** does not match any row → **Use EasyEDA default**, **Change value parameter…**, or **Cancel**.

Default rows ship for **Resistors**, **Capacitors**, **Inductors** (hide num/name + typical value fields). Template names are **not** fixed per category in storage; template choice happens at download time when templates are available.

### LCSC metadata → KiCad properties

The content script merges **`table.tableInfoWrap`**, **`v-data-table.common-table-v7`**, and **`paramsItem`** data. Typical mapped fields include **Datasheet**, **Description**, **Manufacturer**, **LCSC Part**, **Package**, plus parameters normalized through a label map (Power, Tolerance, voltage ratings, DCR, etc.) — same idea as in the extension’s parameter mapping tables.

### Template symbols (`Templates.kicad_sym`)

You can place **`Templates.kicad_sym`** next to your symbol library and define symbols such as `Template_Resistor`, `Template_Capacitor`, `Template_Capacitor_Polarized`, `Template_Inductor` (names configurable when picking a template at download).

- **Multiple libraries** can be marked as template libraries; the backend/extension aggregate template symbol lists.
- **Merge behaviour:** the importer aligns the template’s **pin table** with EasyEDA (adds missing pins at the origin, removes template-only pins) so electrical pin sets stay consistent.
- **API:** `POST /templates/pin-check` compares EasyEDA vs template pin counts before conversion; `force_template` on conversion tasks avoids falling back to the raw EasyEDA symbol when you explicitly require the template path.

Required properties on templates include at least **Reference**, **Value**, **Footprint**, **Datasheet**, **Description**; manufacturer/LCSC/JLC and scraped params are appended as hidden fields.

### Network resilience

EasyEDA fetches (component CAD, 3D OBJ/STEP) use **timeouts and retries** with user-visible status where possible.

## UI and LCSC website integration

| Extension settings | Library management |
| --- | --- |
| ![Extension settings](img/extension_settings.png) | ![Library management](img/extension_library.png) |
| Backend URL, overwrite defaults, project-relative paths, categories. | Libraries, counts, status. |

| Add a library | Fetch new parts |
| --- | --- |
| ![Add a library](img/extension_add_library.png) | ![Fetch new parts](img/extension_get_new_parts.png) |

| LCSC product page | After download |
| --- | --- |
| ![LCSC part download button](img/browser_part_download.png) | ![LCSC part downloaded](img/browser_part_dowloaded.png) |

| LCSC listing |
| --- |
| ![LCSC list download buttons](img/browser_parts_download.png) |

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

Load the extension from `chrome_extension/` as **unpacked** and point it at your local server URL.

## Credits

Based on [easyeda2kicad](https://github.com/uPesy/easyeda2kicad.py) by uPesy.

## License

> [!NOTE]
> This repository includes code from the original **AGPL-3.0** project; that license continues to apply to those parts. New contributions are intended to remain **free to use, non-commercial** where separately noted; this does not change AGPL terms for upstream code.

See `LICENSE` (AGPL-3.0).
