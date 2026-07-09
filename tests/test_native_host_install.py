"""Self-Register: the release binary and the source checkout resolve differently.

The frozen binary *is* the host, so Chrome must be pointed at ``sys.executable``
and the manifest must live somewhere stable (``%LOCALAPPDATA%``) rather than
beside an executable that may sit in Downloads. A source checkout instead needs
a generated ``.bat`` pinning the venv interpreter, because Chrome's subprocess
PATH usually lacks the project's dependencies.

Getting this wrong is silent: Chrome reports "host not found" (or a launcher
that cannot import the engine) and every import fails.

The Windows registry is never touched here — ``install()`` only writes it on
win32, and these tests drive the pure path resolution and the manifest writer.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from native_host import install as install_mod


@pytest.fixture
def frozen(monkeypatch: pytest.MonkeyPatch):
    """Pretend we are a PyInstaller bundle whose executable is `exe_path`."""

    def _apply(exe_path: Path, localappdata: Path) -> None:
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setattr(sys, "executable", str(exe_path))
        monkeypatch.setenv("LOCALAPPDATA", str(localappdata))

    return _apply


@pytest.fixture(autouse=True)
def _not_frozen_by_default(monkeypatch: pytest.MonkeyPatch):
    """`sys.frozen` leaks across tests otherwise — pytest itself is not frozen."""
    monkeypatch.delattr(sys, "frozen", raising=False)


def test_source_checkout_points_chrome_at_the_generated_launcher(tmp_path: Path) -> None:
    assert install_mod.is_frozen() is False
    host_path = install_mod.host_command_path(tmp_path)
    assert host_path == tmp_path / "native_host" / "_generated" / "host-launcher.bat"
    assert install_mod.manifest_target_path(tmp_path).parent == host_path.parent


def test_frozen_binary_points_chrome_at_itself(tmp_path: Path, frozen) -> None:
    exe = tmp_path / "dist" / "KiCadPartsImporterHost.exe"
    frozen(exe, tmp_path / "AppData")

    assert install_mod.is_frozen() is True
    # The binary is the host: no launcher indirection.
    assert install_mod.host_command_path() == exe


def test_frozen_manifest_lives_outside_the_executable_directory(tmp_path: Path, frozen) -> None:
    exe = tmp_path / "Downloads" / "KiCadPartsImporterHost.exe"
    appdata = tmp_path / "AppData"
    frozen(exe, appdata)

    manifest_path = install_mod.manifest_target_path()
    assert manifest_path == appdata / "KiCadPartsImporter" / f"{install_mod.HOST_NAME}.json"
    # Must not be written next to a binary that may move or be read-only.
    assert exe.parent not in manifest_path.parents


def test_frozen_install_writes_no_launcher_bat(tmp_path: Path, frozen, monkeypatch) -> None:
    exe = tmp_path / "KiCadPartsImporterHost.exe"
    frozen(exe, tmp_path / "AppData")
    monkeypatch.setattr(sys, "platform", "linux")  # skip the registry branch

    result = install_mod.install()

    assert result["frozen"] is True
    assert result["bat_changed"] is None, "a frozen build must not generate a .bat"
    assert not list(tmp_path.rglob("*.bat"))


def test_manifest_names_the_host_command_and_pinned_origin(tmp_path: Path, frozen, monkeypatch) -> None:
    exe = tmp_path / "KiCadPartsImporterHost.exe"
    frozen(exe, tmp_path / "AppData")
    monkeypatch.setattr(sys, "platform", "linux")

    result = install_mod.install()
    manifest = json.loads(Path(result["manifest_path"]).read_text(encoding="utf-8"))

    assert manifest["name"] == install_mod.HOST_NAME
    assert manifest["type"] == "stdio"
    assert manifest["path"] == str(exe.resolve())
    assert manifest["allowed_origins"] == [
        f"chrome-extension://{install_mod.DEFAULT_EXTENSION_ID}/"
    ]
    assert "walking skeleton" not in manifest["description"].lower()


def test_install_is_idempotent(tmp_path: Path, frozen, monkeypatch) -> None:
    frozen(tmp_path / "host.exe", tmp_path / "AppData")
    monkeypatch.setattr(sys, "platform", "linux")

    first = install_mod.install()
    second = install_mod.install()

    assert first["manifest_changed"] is True
    assert second["manifest_changed"] is False, "re-running must be a no-op"


def test_manifest_rewritten_when_extension_id_changes(tmp_path: Path, frozen, monkeypatch) -> None:
    frozen(tmp_path / "host.exe", tmp_path / "AppData")
    monkeypatch.setattr(sys, "platform", "linux")

    install_mod.install()
    changed = install_mod.install(extension_id="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")

    assert changed["manifest_changed"] is True


def test_source_install_generates_an_idempotent_launcher(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")

    first = install_mod.install(repo_root=tmp_path)
    second = install_mod.install(repo_root=tmp_path)

    bat = Path(first["host_path"])
    assert bat.exists() and bat.suffix == ".bat"
    assert sys.executable in bat.read_text(encoding="utf-8")
    assert first["bat_changed"] is True
    assert second["bat_changed"] is False


def test_self_register_refuses_non_windows(monkeypatch, capsys) -> None:
    """Windows-only for now (#13). Say so instead of silently writing a dead manifest."""
    monkeypatch.setattr(sys, "platform", "darwin")

    rc = install_mod.self_register()

    assert rc == 1
    assert "Windows only" in capsys.readouterr().err


# --- host.main(): serve Chrome, or install when double-clicked -----------------


@pytest.fixture
def spy_host(monkeypatch: pytest.MonkeyPatch):
    """Record which branch host.main() takes without running either for real."""
    from native_host import host

    calls: list[str] = []
    monkeypatch.setattr(host, "serve", lambda: calls.append("serve") or 0)
    monkeypatch.setattr(install_mod, "self_register", lambda *a, **k: calls.append("register") or 0)
    return host, calls


def test_chrome_launch_serves(spy_host) -> None:
    """Chrome passes the caller's origin, and --parent-window on Windows."""
    host, calls = spy_host
    argv = [f"chrome-extension://{install_mod.DEFAULT_EXTENSION_ID}/", "--parent-window=12345"]

    assert host.main(argv) == 0
    assert calls == ["serve"]


def test_frozen_chrome_launch_serves_rather_than_registering(spy_host, monkeypatch) -> None:
    """The release binary must serve when Chrome starts it — not reinstall itself."""
    host, calls = spy_host
    monkeypatch.setattr(sys, "frozen", True, raising=False)

    assert host.main([f"chrome-extension://{install_mod.DEFAULT_EXTENSION_ID}/"]) == 0
    assert calls == ["serve"]


def test_frozen_double_click_registers(spy_host, monkeypatch) -> None:
    """No arguments + frozen means a human ran the binary, not Chrome."""
    host, calls = spy_host
    monkeypatch.setattr(sys, "frozen", True, raising=False)

    assert host.main([]) == 0
    assert calls == ["register"]


def test_source_run_without_args_still_serves(spy_host) -> None:
    """`python native_host/host.py` must stay a server, per the README smoke test."""
    host, calls = spy_host
    assert not getattr(sys, "frozen", False)

    assert host.main([]) == 0
    assert calls == ["serve"]


def test_explicit_register_flag_registers_from_source(spy_host) -> None:
    host, calls = spy_host

    assert host.main(["--register"]) == 0
    assert calls == ["register"]
