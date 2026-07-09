# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] — unreleased

V3 is a rewrite of how the extension talks to KiCad. It is a **clean break**
from V2: a new install ceremony, no settings carried over, no migration path.

### Changed — architecture

- **The local server is gone.** V2 ran a FastAPI process that the extension
  reached over HTTP and a WebSocket on port 8087. V3 launches a Python **Native
  Host** on demand through Chrome Native Messaging. There is no server to start,
  no port to configure, and no "API base URL" setting.
- **Two-phase import.** A fast `fetchMetadata` renders the panel within about a
  second; the slower `convert` streams progress while it runs.
- Conversion progress is streamed on the port instead of being polled from a
  job queue.

### Added — import experience

- **Anchor Card** on the LCSC product page, with an inline progress bar, a
  completion animation, and an "already in library" badge that turns Download
  into Re-Import.
- **Confidence-driven import.** A part with a registered rule imports in one
  click (green); an uncertain match opens the editor or keeps EasyEDA data,
  depending on a setting (yellow); an unknown category prompts you to register
  it (white).
- **Import-Editor** in a four-column layout: symbol list, symbol preview,
  footprint preview, footprint list — with search, live SVG previews rendered
  from the actual KiCad files, and a Pin↔Pad mapper.
- **Category-Property Match.** A template symbol carrying a KiCad `Category`
  property registers itself, so curated templates reach one-click import
  without any manual mapping.
- **Metadata auto-upsert.** Every parameter from the LCSC specification table
  is written as a symbol property. The manual label mapper is gone.
- **Value-Param.** Choose which scraped parameter fills KiCad's `Value` field.
- **Pin visibility** per rule, with an automatic default for parts of two pins
  or fewer.
- **Template footprints.** Import your own curated `.kicad_mod` instead of the
  EasyEDA one; the template's own 3D model reference rides along.
- **Template-only import.** Parts that EasyEDA has no CAD data for can still be
  imported entirely from your templates plus the scraped page metadata. The
  extension detects this ahead of time and steers you there instead of failing.
- Datasheet preview, dark theme across all dialogs, and a warning when the LCSC
  page is not in English (which would otherwise corrupt scraped metadata).

### Added — library handling

- Library management moved to the Native Host: create, validate, and inspect
  libraries from the popup, with symbol/footprint/3D counts.
- **Property whitespace is normalised automatically.** Leading and trailing
  spaces in property names and values are stripped on every write, and existing
  libraries are cleaned in place when a validation finds padding.
- `tools/kicad_lint.py` reports and repairs whitespace-named field orphans in
  `.kicad_sch` and `.kicad_pcb` files.

### Fixed

- Re-importing a template-merged symbol appended a duplicate instead of
  updating it, because the symbol lookup was anchored on indentation. Lookups
  are now parenthesis-balanced, and the updater removes every stale copy — so
  the next re-import of an affected symbol heals it.
- `extract_symbol_from_lib` failed on libraries saved by newer KiCad versions
  that mix indentation styles and use CRLF.
- Symbol previews rendered IC bodies as solid black; KiCad's three fill modes
  are now honoured.

### Removed

- The V2 WebSocket transport, its job queue, and the `easyeda2kicad/api/`
  FastAPI application. `fastapi` and `uvicorn` are no longer dependencies.
- The `http://localhost:8087/*` host permission.

### Known limitations

- **Windows only.** The Native Host self-registers on Windows. macOS and Linux
  registration is not implemented yet (issue #13).
- EasyEDA 3D models are not downloaded on the convert path. A template
  footprint's own 3D reference is carried over, but there is no EasyEDA
  fallback yet (issue #6).
- Re-import overwrites without asking (issue #10).
- No bundled standard library ships yet; bring your own templates (issue #32).

## [2.0.0] — 2026-04-17

Last release of the WebSocket-backend architecture. See the git history for
details.
