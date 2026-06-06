"""
V3 Native Host — Native-Messaging request/response loop on stdin/stdout.

Speaks Chrome's Native Messaging protocol: each message is a little-endian
uint32 length prefix followed by that many bytes of UTF-8 JSON. One response
per request. Exits when stdin closes (Chrome disconnect).

Verbs handled:

- ``ping`` — walking-skeleton liveness check (Issue #1). Returns
  ``{ok: True, version: HOST_VERSION}``.
- ``fetchMetadata`` — V3 **Phase 1 Fetch** (Issue #3). Pulls LCSC metadata
  for the given LCSC ID: Category Path (normalized via Python mirror),
  pin count, datasheet URL. See ``native_host.phase1`` for the metadata
  resolver and ``docs/adr/0002-two-phase-backend-conversion.md`` for the
  Phase 1 / Phase 2 split rationale.
- ``convert`` — V3 **Phase 2 Conversion** default-path (Issue #4). Drives
  the EasyEDA pipeline (Symbol + Footprint; 3D Layer follows in #6) and
  streams free-form ``progress`` frames on the same port until the terminal
  ``done`` (``ok=True``) or ``error`` arrives. ADR-0004 — no Job state, no
  queue. See ``native_host.phase2`` for the runner.

Concurrent ``fetchMetadata`` / ``convert`` calls return ``busy`` per ADR-0004
(no Job state, no queue). The single-flight guard lives here so both RPCs
share one lock — a Phase 1 in-flight blocks Phase 2 and vice versa.

Run directly for dev: ``python native_host/host.py`` (Chrome invokes it via
``native_host/kicad-host.bat`` on Windows; see ``install.py`` for the
Native-Host-Manifest setup).
"""

from __future__ import annotations

import json
import os
import struct
import sys
import threading
from typing import Any, Callable

# When Chrome invokes host.py via the .bat shim, CWD is whatever Chrome chose
# and the parent of native_host/ is NOT on sys.path — so `from native_host.X
# import ...` raises ModuleNotFoundError. Insert the repo root explicitly.
# Idempotent: no-op when already importable (e.g. when imported by tests).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from native_host.fs import (  # noqa: E402
    check_path,
    list_directory,
    list_roots,
    validate_library,
)
from native_host.phase1 import fetch_metadata  # noqa: E402  (after sys.path setup)
from native_host.phase2 import run_phase2_conversion  # noqa: E402
from native_host.templates import list_templates  # noqa: E402

HOST_VERSION = "0.0.1"

# Single-flight guard shared across slow RPCs (fetchMetadata, convert).
# ADR-0004: concurrent imports across two LCSC tabs return ``busy``.
_busy_lock = threading.Lock()
_busy = False


def _read_message() -> dict[str, Any] | None:
    """Read one length-prefixed JSON frame from stdin. Returns None on EOF."""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    (length,) = struct.unpack("<I", raw_length)
    if length == 0:
        return {}
    payload = sys.stdin.buffer.read(length)
    if len(payload) < length:
        return None
    return json.loads(payload.decode("utf-8"))


def _write_message(msg: dict[str, Any]) -> None:
    """Write one length-prefixed JSON frame to stdout."""
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _try_acquire_busy() -> bool:
    """Try to mark the host busy. Returns True on success, False if already busy."""
    global _busy
    with _busy_lock:
        if _busy:
            return False
        _busy = True
        return True


def _release_busy() -> None:
    global _busy
    with _busy_lock:
        _busy = False


def _run_with_busy_guard(
    request_id: Any, run: Callable[[], dict[str, Any]]
) -> dict[str, Any]:
    """Wrap a slow RPC: enforce single-flight (return ``busy`` on contention)."""
    if not _try_acquire_busy():
        return {"id": request_id, "ok": False, "error": "busy"}
    try:
        return run()
    finally:
        _release_busy()


def handle(
    request: dict[str, Any],
    *,
    metadata_fetcher: Callable[[str, dict[str, Any] | None], dict[str, Any]] | None = None,
    conversion_runner: Callable[..., dict[str, Any]] | None = None,
    emit: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Dispatch one request to its RPC handler.

    Args:
        request: Decoded JSON request frame.
        metadata_fetcher: Optional override for the LCSC metadata resolver — tests
            inject a stub to avoid hitting the EasyEDA API. When ``None``, the
            default ``native_host.phase1.fetch_metadata`` is used.
        conversion_runner: Optional override for the Phase 2 runner — tests
            inject a stub that records progress callbacks without driving the
            real EasyEDA pipeline. When ``None``, the default
            ``native_host.phase2.run_phase2_conversion`` is used.
        emit: Optional callable that ships a non-terminal frame on the
            Native-Messaging port mid-flight. The ``convert`` RPC uses this to
            stream ``progress`` frames before its terminal ``done``/``error``
            (ADR-0004). When ``None``, progress frames are dropped — fine for
            tests that only care about the terminal response.
    """
    verb = request.get("verb")
    request_id = request.get("id")

    if verb == "ping":
        return {"id": request_id, "ok": True, "version": HOST_VERSION}

    if verb == "fetchMetadata":
        raw_params = request.get("params")
        params = raw_params if isinstance(raw_params, dict) else {}
        lcsc_id = params.get("lcscId")
        raw_hints = params.get("pageHints")
        page_hints = raw_hints if isinstance(raw_hints, dict) else None

        fetcher = metadata_fetcher or fetch_metadata

        def run() -> dict[str, Any]:
            try:
                result = fetcher(lcsc_id, page_hints)
            except ValueError as exc:
                return {"id": request_id, "ok": False, "error": str(exc)}
            except Exception as exc:  # noqa: BLE001 — propagate as RPC error
                return {
                    "id": request_id,
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            return {"id": request_id, "ok": True, "result": result}

        return _run_with_busy_guard(request_id, run)

    if verb == "convert":
        raw_params = request.get("params")
        params = raw_params if isinstance(raw_params, dict) else {}
        runner = conversion_runner or run_phase2_conversion

        def progress_emit(message: str, percent: Any) -> None:
            if emit is None:
                return
            frame: dict[str, Any] = {
                "id": request_id,
                "type": "progress",
                "message": str(message) if message is not None else "",
            }
            if percent is not None:
                try:
                    frame["progress"] = int(percent)
                except (TypeError, ValueError):
                    pass
            try:
                emit(frame)
            except Exception:  # noqa: BLE001 — never let progress kill conversion
                pass

        def run() -> dict[str, Any]:
            try:
                result = runner(params, progress_emit)
            except ValueError as exc:
                return {"id": request_id, "ok": False, "error": str(exc)}
            except Exception as exc:  # noqa: BLE001 — surface as RPC error
                return {
                    "id": request_id,
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            return {"id": request_id, "ok": True, "result": result}

        return _run_with_busy_guard(request_id, run)

    if verb == "listTemplates":
        raw_params = request.get("params")
        params = raw_params if isinstance(raw_params, dict) else {}
        try:
            result = list_templates(params.get("libPath"))
        except ValueError as exc:
            return {"id": request_id, "ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001
            return {
                "id": request_id,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }
        return {"id": request_id, "ok": True, "result": result}

    # V3 FS verbs (Issue #24) — popup library picker via Native Messaging.
    # Allowed-roots whitelist (Q-PICK-1): defaults + extraRoots passed by the
    # extension (it persists the user-added folders client-side and forwards
    # them on every call). All four verbs share the same fast-path try/except
    # so a path-outside-whitelist surfaces as a validation error, not a crash.
    if verb in ("fsRoots", "fsList", "fsCheck", "validateLibrary"):
        raw_params = request.get("params")
        params = raw_params if isinstance(raw_params, dict) else {}
        extra_roots = params.get("extraRoots")
        try:
            if verb == "fsRoots":
                result = list_roots(extra_roots)
            elif verb == "fsList":
                result = list_directory(params.get("path"), extra_roots)
            elif verb == "fsCheck":
                result = check_path(params.get("path"), extra_roots)
            else:
                result = validate_library(params.get("path"), extra_roots)
        except ValueError as exc:
            return {"id": request_id, "ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001
            return {
                "id": request_id,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }
        return {"id": request_id, "ok": True, "result": result}

    return {
        "id": request_id,
        "ok": False,
        "error": f"unknown verb: {verb!r}",
    }


def main() -> int:
    while True:
        request = _read_message()
        if request is None:
            return 0
        try:
            # ``emit`` ships progress frames on the same port mid-call so the
            # ``convert`` RPC can stream Phase 2 progress (ADR-0004) before
            # its terminal ``done``/``error`` arrives below.
            response = handle(request, emit=_write_message)
        except Exception as exc:
            response = {
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }
        _write_message(response)


if __name__ == "__main__":
    sys.exit(main())
