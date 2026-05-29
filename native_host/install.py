"""
V3 Native Host installer — Self-Register implementation (Windows only for now).

Writes the Native-Host-Manifest JSON to disk plus a registry entry that
points Chrome at it. Idempotent: re-running on an installed system is a
no-op when the manifest content matches.

Cross-OS (macOS, Linux) lands in Issue #13; this walking-skeleton version
covers Windows because that's the ADR-0001 risk-validation target.

Usage:

    python native_host/install.py --extension-id <chrome-extension-id>

Pass the extension's ID (find it in ``chrome://extensions`` after loading
the unpacked extension). The ID is required because Chrome only allows
Native Messaging from origins explicitly listed in the manifest's
``allowed_origins``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HOST_NAME = "com.kicad_parts_importer.host"
REGISTRY_KEY_PATH = rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"


def build_manifest(host_path: Path, extension_id: str) -> dict[str, object]:
    """Build the Native-Host-Manifest dict per the Chrome Native Messaging spec."""
    return {
        "name": HOST_NAME,
        "description": "KiCad Parts Importer V3 native host (walking skeleton)",
        "path": str(host_path.resolve()),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }


def manifest_target_path(repo_root: Path) -> Path:
    """The on-disk location of the Native-Host-Manifest JSON file."""
    return repo_root / "native_host" / "_generated" / f"{HOST_NAME}.json"


def host_executable_path(repo_root: Path) -> Path:
    """The path Chrome invokes — a .bat shim on Windows that runs host.py."""
    return repo_root / "native_host" / "kicad-host.bat"


def write_manifest(manifest_path: Path, manifest: dict[str, object]) -> bool:
    """Write the manifest JSON. Returns True if changed, False if already up to date."""
    new_content = json.dumps(manifest, indent=2)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    if manifest_path.exists() and manifest_path.read_text(encoding="utf-8") == new_content:
        return False
    manifest_path.write_text(new_content, encoding="utf-8")
    return True


def register_in_windows_registry(manifest_path: Path) -> bool:
    """Write the registry key under HKCU. Returns True if changed, False if already correct."""
    import winreg

    target = str(manifest_path.resolve())
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY_KEY_PATH, 0, winreg.KEY_READ) as key:
            current, _ = winreg.QueryValueEx(key, "")
            if current == target:
                return False
    except FileNotFoundError:
        pass

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REGISTRY_KEY_PATH) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, target)
    return True


def install(extension_id: str, repo_root: Path) -> dict[str, object]:
    """Self-Register entry point. Returns a result dict for callers / tests."""
    manifest_path = manifest_target_path(repo_root)
    host_path = host_executable_path(repo_root)
    manifest = build_manifest(host_path, extension_id)
    manifest_changed = write_manifest(manifest_path, manifest)

    registry_changed: bool | None = None
    if sys.platform == "win32":
        registry_changed = register_in_windows_registry(manifest_path)

    return {
        "manifest_path": str(manifest_path),
        "manifest_changed": manifest_changed,
        "registry_changed": registry_changed,
        "host_name": HOST_NAME,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--extension-id",
        required=True,
        help="Chrome extension ID (find it on chrome://extensions after loading the unpacked extension)",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    result = install(args.extension_id, repo_root)

    print(f"Native Host Manifest: {result['manifest_path']}")
    print(f"Manifest changed:     {result['manifest_changed']}")
    if result["registry_changed"] is not None:
        print(f"Registry changed:     {result['registry_changed']}")
    print(f"Host name:            {result['host_name']}")
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
