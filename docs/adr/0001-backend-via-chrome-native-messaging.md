# Backend via Chrome Native Messaging

V3 invokes the Python backend through Chrome Native Messaging instead of a long-running localhost WebSocket server. Chosen over a KiCad Action Plugin (lifecycle tied to pcbnew, not a daemon) and a system-tray app (always-on RAM, OS-specific tray UI) because Native Messaging is the only option that removes the backend lifecycle as a user concern entirely — Chrome launches the Python process on demand and kills it on disconnect.

## Consequences

- The backend has no listening port and no API base URL. The popup loses "Backend URL + Test".
- Installer ships a PyInstaller binary that **self-registers the Native-Host JSON manifest** at the OS-specific paths (Windows registry, macOS `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`, Linux `~/.config/google-chrome/NativeMessagingHosts/`) on first launch.
- Service Worker is the only context that may call `connectNative`; popup and content script funnel through SW message passing.
- Cold-start mitigation: see [0002](0002-two-phase-backend-conversion.md) and pre-warm-on-LCSC-page-load behaviour documented in V3-SPEC.md.
