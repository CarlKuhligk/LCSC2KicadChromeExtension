# Privacy Policy

This extension adds import controls to LCSC.com product pages and talks to a **Native Host** — a small program running on your own machine — to write KiCad library files. The Native Host is required for the extension to function.

## Data Collection
We do not collect, store, or transmit personal data to the developer or any third parties. There are no analytics or tracking services.

## Local Processing
The extension stores its settings locally (overwrite options, the selected library, import rules, theme, and debug logging) using Chrome's extension storage. These settings never leave your device.

The Native Host performs all file operations on your machine. When you import a part, it may fetch component data from LCSC/EasyEDA to complete the conversion. Those requests are initiated by you and carry no personal data.

The extension reads the LCSC product page you are viewing in order to extract the part's specifications. That data stays on your device.

## Data Sharing
No user data is shared with the developer or third parties. The extension communicates only with the Native Host on your machine, over Chrome's Native Messaging channel — no network port is opened. The Native Host in turn contacts only the component data sources needed for the part you requested.

## Data Retention & Control
All data remains on your device. You can remove it by uninstalling the extension, clearing extension storage, and deleting the Native Host manifest (`%LOCALAPPDATA%\KiCadPartsImporter\`) together with its registry entry under `HKCU\Software\Google\Chrome\NativeMessagingHosts\`.

## Contact
If you have questions about this policy, please contact the maintainer via the repository issues page.
