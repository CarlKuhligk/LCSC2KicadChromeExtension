"""Tests for the V3 Native Host walking skeleton.

Covers:
- `host.handle()` — RPC dispatch for the `ping` verb and unknown-verb fallback.
- `install.build_manifest()` — shape of the Native-Host-Manifest JSON.
- `install.write_manifest()` — idempotence (no write when content matches).
- `install.install()` — end-to-end (with Windows registry mocked) returns
  the expected result shape.

Windows-registry writes are mocked via ``unittest.mock`` so the suite is
cross-OS safe even though the actual installer is Windows-only for now.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest import mock

import pytest

from native_host import host, install


# ---------------------------------------------------------------------------
# host.handle — RPC dispatch
# ---------------------------------------------------------------------------


def test_ping_returns_ok_and_version() -> None:
    response = host.handle({"id": 42, "verb": "ping"})
    assert response == {"id": 42, "ok": True, "version": host.HOST_VERSION}


def test_unknown_verb_returns_error_with_request_id() -> None:
    response = host.handle({"id": "abc", "verb": "fetchSomething"})
    assert response["id"] == "abc"
    assert response["ok"] is False
    assert "fetchSomething" in response["error"]


def test_missing_verb_returns_error_without_crashing() -> None:
    response = host.handle({"id": 1})
    assert response["ok"] is False


# ---------------------------------------------------------------------------
# install.build_manifest — manifest shape
# ---------------------------------------------------------------------------


def test_build_manifest_has_required_chrome_native_messaging_fields(tmp_path: Path) -> None:
    host_path = tmp_path / "kicad-host.bat"
    manifest = install.build_manifest(host_path, "abcdef0123456789abcdef0123456789")
    assert manifest["name"] == install.HOST_NAME
    assert manifest["type"] == "stdio"
    assert manifest["path"] == str(host_path.resolve())
    assert manifest["allowed_origins"] == [
        "chrome-extension://abcdef0123456789abcdef0123456789/"
    ]
    assert "description" in manifest


def test_manifest_path_uses_absolute_form(tmp_path: Path) -> None:
    relative_host = Path("native_host/kicad-host.bat")
    manifest = install.build_manifest(relative_host, "x")
    assert Path(manifest["path"]).is_absolute()


# ---------------------------------------------------------------------------
# install.write_manifest — idempotence
# ---------------------------------------------------------------------------


def test_write_manifest_returns_true_on_first_write(tmp_path: Path) -> None:
    manifest_path = tmp_path / "out.json"
    changed = install.write_manifest(manifest_path, {"name": "x"})
    assert changed is True
    assert json.loads(manifest_path.read_text(encoding="utf-8")) == {"name": "x"}


def test_write_manifest_returns_false_when_content_unchanged(tmp_path: Path) -> None:
    manifest_path = tmp_path / "out.json"
    install.write_manifest(manifest_path, {"name": "x"})
    changed_second = install.write_manifest(manifest_path, {"name": "x"})
    assert changed_second is False


def test_write_manifest_returns_true_when_content_differs(tmp_path: Path) -> None:
    manifest_path = tmp_path / "out.json"
    install.write_manifest(manifest_path, {"name": "x"})
    changed = install.write_manifest(manifest_path, {"name": "y"})
    assert changed is True


# ---------------------------------------------------------------------------
# install.install — end-to-end with mocked registry
# ---------------------------------------------------------------------------


def test_install_returns_expected_result_shape(tmp_path: Path) -> None:
    (tmp_path / "native_host").mkdir()
    (tmp_path / "native_host" / "host.py").write_text("# stub")

    with mock.patch.object(install, "register_in_windows_registry", return_value=True):
        with mock.patch("sys.platform", "win32"):
            result = install.install("abcdef" * 5 + "ab", tmp_path)

    assert result["host_name"] == install.HOST_NAME
    assert result["manifest_changed"] is True
    assert result["bat_changed"] is True
    assert result["registry_changed"] is True
    assert Path(result["manifest_path"]).exists()
    assert Path(result["host_path"]).exists()
    manifest = json.loads(Path(result["manifest_path"]).read_text(encoding="utf-8"))
    assert manifest["name"] == install.HOST_NAME
    assert manifest["allowed_origins"] == [
        f"chrome-extension://{'abcdef' * 5 + 'ab'}/"
    ]
    # Manifest must point at the generated runtime bat, not the committed shim.
    assert manifest["path"] == str(Path(result["host_path"]).resolve())
    bat_text = Path(result["host_path"]).read_text(encoding="utf-8")
    assert sys.executable in bat_text
    assert "host.py" in bat_text


def test_install_is_idempotent_on_second_run(tmp_path: Path) -> None:
    (tmp_path / "native_host").mkdir()
    (tmp_path / "native_host" / "host.py").write_text("# stub")

    with mock.patch.object(install, "register_in_windows_registry", return_value=False):
        with mock.patch("sys.platform", "win32"):
            install.install("a" * 32, tmp_path)
            result_second = install.install("a" * 32, tmp_path)

    assert result_second["manifest_changed"] is False
    assert result_second["bat_changed"] is False
    assert result_second["registry_changed"] is False


def test_install_skips_registry_on_non_windows(tmp_path: Path) -> None:
    (tmp_path / "native_host").mkdir()
    (tmp_path / "native_host" / "host.py").write_text("# stub")

    with mock.patch("sys.platform", "linux"):
        result = install.install("a" * 32, tmp_path)

    assert result["registry_changed"] is None
    assert result["manifest_changed"] is True
    assert result["bat_changed"] is True


def test_write_runtime_bat_writes_quoted_paths(tmp_path: Path) -> None:
    bat = tmp_path / "_generated" / "host-launcher.bat"
    host_py = tmp_path / "native_host" / "host.py"
    python_exe = r"C:\path with spaces\python.exe"
    changed = install.write_runtime_bat(bat, python_exe, host_py)
    assert changed is True
    text = bat.read_text(encoding="utf-8")
    assert f'"{python_exe}"' in text
    assert f'"{host_py}"' in text


def test_write_runtime_bat_is_idempotent(tmp_path: Path) -> None:
    bat = tmp_path / "_generated" / "host-launcher.bat"
    install.write_runtime_bat(bat, "py.exe", tmp_path / "host.py")
    changed_second = install.write_runtime_bat(bat, "py.exe", tmp_path / "host.py")
    assert changed_second is False
