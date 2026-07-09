# Native Host

The V3 backend. Chrome launches it on demand through **Native Messaging**
(ADR-0001) and talks to it over stdin/stdout: each message is a little-endian
`uint32` length prefix followed by that many bytes of UTF-8 JSON. The host
exits when Chrome closes the pipe.

There is no server, no port, and no URL. `convert` streams free-form
`progress` frames on the same port until a terminal `done` or `error`
(ADR-0004 — no job queue, no job state).

## What's here

| File | Role |
|---|---|
| `host.py` | The frame loop, verb dispatch, and worker pool. Also the PyInstaller entry point. |
| `install.py` | Self-Register: writes the Native-Host Manifest and the Windows registry pointer. |
| `phase1.py` | `fetchMetadata` — the fast phase (category path, pin count, datasheet, EasyEDA availability). |
| `phase2.py` | `convert` — the slow phase, driving the conversion engine. |
| `rules.py` | The on-disk Category Rule store (ADR-0006). |
| `fs.py` | Library filesystem verbs, restricted to whitelisted roots. |
| `templates.py`, `preview.py` | Template listing and SVG previews of symbols and footprints. |
| `kicad-host.bat` | Fallback shim for manual smoke tests inside an activated venv. |
| `_generated/` | Manifest and launcher written by `install.py`. Gitignored. |

## Verbs

`ping` · `fetchMetadata` · `convert` · `getRule` · `setRule` · `listTemplates` ·
`templatePinCheck` · `templateSymbolPreview` · `templateFootprintPreview` ·
`templateGalleryPinSummary` · `lcscSymbolPreview` · `lcscFootprintPreview` ·
`fsRoots` · `fsList` · `fsCheck` · `validateLibrary` · `scaffoldLibrary` ·
`cleanLibrary` · `libraryComponent`

An unknown verb returns a structured error rather than crashing the port.

## Registration

Chrome only launches a host that is registered for the calling extension's
exact ID. `chrome_extension/manifest.json` pins a `key`, so that ID is the same
on every machine (`ajbbipncafmnckigkalhbhpnmjldniao`) and the installer needs no
arguments.

**Release binary.** Run `KiCadPartsImporterHost.exe` once. It registers itself
and exits. The manifest points straight at the executable and is written to
`%LOCALAPPDATA%\KiCadPartsImporter\`.

**From source.**

```powershell
python native_host/install.py
```

This writes `native_host/_generated/com.kicad_parts_importer.host.json` plus a
generated `host-launcher.bat`, and a registry entry at
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.kicad_parts_importer.host`
pointing at the JSON. The launcher exists because Chrome's subprocess inherits
the system `PATH` with no venv activation, so an unqualified `python` would
usually be an interpreter without this project's dependencies.

Re-running is idempotent. Afterwards, reload the extension in
`chrome://extensions`; the popup should report "Native Host: online · v3.0.0".

## Running it directly

`host.py` serves whenever it is started from a checkout, so you can pipe frames
at it by hand. Use `--register` to install instead.

A **frozen** binary started with no arguments assumes it was double-clicked and
registers itself; started with an origin argument — the way Chrome does it — it
serves. `tests/test_native_host_install.py` covers both branches.

## Cross-OS

Windows only. `install.py` writes a Windows registry key; on macOS and Linux it
refuses rather than writing a manifest nothing would read. Tracked as
[issue #13](https://github.com/theautomatist/KiCad-Parts-Importer/issues/13).
