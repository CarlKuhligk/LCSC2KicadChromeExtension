# V3 Native Host (Walking Skeleton)

Validates ADR-0001 (Native Messaging as the V3 backend transport) with a
single `ping` RPC. Real RPCs (`fetchMetadata`, `convert`) build on this loop.

## What's here

| File | Role |
|---|---|
| `host.py` | Length-prefixed JSON-frame loop over stdin/stdout. Handles `ping`. |
| `install.py` | Self-Register installer — writes the Native-Host-Manifest JSON and the Windows registry pointer. |
| `kicad-host.bat` | Windows shim Chrome invokes; runs `python host.py`. |
| `_generated/` | Holds the manifest JSON written by `install.py`. Gitignored. |

## First-run setup on Windows

1. **Load the extension once** (`chrome://extensions` → Developer mode → Load
   unpacked → pick `chrome_extension/`). Note the Extension-ID that appears
   under the entry — looks like `chmgnncfhlnnogjpmlfnefjjngnjlpok`.
2. **Run the installer with that ID:**

   ```powershell
   python native_host/install.py --extension-id <YOUR-EXTENSION-ID>
   ```

   The installer writes `native_host/_generated/com.kicad_parts_importer.host.json`
   and a registry entry at
   `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.kicad_parts_importer.host`
   that points at the JSON.
3. **Reload the extension** in `chrome://extensions`. The popup should now
   show "Native Host: online · v0.0.1".

Re-running the installer with the same arguments is a no-op (idempotent).

## Cross-OS (macOS, Linux)

Out of scope for this walking skeleton — handled by Issue #13 (Installer
hardening cross-OS). The single-OS Windows validation already covers the
ADR-0001 risk: if Chrome's Native Messaging works on one OS at the latency
we want, the protocol is sound.

## PyInstaller bundling

Out of scope here — handled by Issue #13. `kicad-host.bat → python host.py`
is the dev-time form; production-shipping in a single `.exe` is a separate
slice.
