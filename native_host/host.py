"""
V3 Native Host — Native-Messaging request/response loop on stdin/stdout.

Speaks Chrome's Native Messaging protocol: each message is a little-endian
uint32 length prefix followed by that many bytes of UTF-8 JSON. Exits when
stdin closes (Chrome disconnect).

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
- ``getRule`` — V3 **Category Rule** read (Issue #25). Resolves a Category
  Path against the on-disk Rule store using deepest-prefix-match and
  returns the (possibly ``None``) Rule. ``None`` is the signal that drives
  ``computeConfidenceState`` → ``"white"`` → Register-Prompt in the
  Override Panel. See ``native_host.rules`` for the store layout.
- ``setRule`` — V3 **Category Rule** write (Issue #28). Persists the Rule
  the user just authored in the Import-Editor (Category Path +
  ``symbolSource`` + ``labelMapping``) into the same on-disk store
  ``getRule`` reads back. ADR-0006 dropped ``autoApply`` / ``autoConfirm``
  / ``action`` — ``setRule`` rejects those fields so legacy clients
  cannot smuggle them back in.
- ``listTemplates`` — read-only Template Library listing. Used by the
  Override Panel; stays responsive even while a ``convert`` is running.
- ``templatePinCheck`` — V3 Confidence-Pipeline 🟡 driver (Issue #31).
  Returns ``{easyedaPinCount, templatePinCount, match}`` for a single
  ``(lcscId, templateName, templateLibPath)`` tuple. Drives the
  Auto-Template-Match heuristic's pin-count score; the SW caches the
  result per ``(libPath, templateName)`` so re-imports skip the RPC.

Concurrency (Issue #26): the reader loop dispatches each request to a
thread-pool worker so fast read-only verbs (``ping``, ``listTemplates``,
future ``getRule`` / ``fsList``) are served during a 10-s ``convert``.
The single-flight ``_busy_lock`` still serializes the slow verbs
(``fetchMetadata`` + ``convert``) — ADR-0004: no Job state, no queue, a
second slow RPC returns ``busy`` immediately. Stdout writes are protected
by ``_write_lock`` so concurrent responders cannot interleave bytes mid-
frame (the Native-Messaging protocol has no resynchronization marker).

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
from concurrent.futures import ThreadPoolExecutor
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
from native_host.rules import get_rule, set_rule  # noqa: E402
from native_host.templates import list_templates, template_pin_check  # noqa: E402

HOST_VERSION = "0.0.1"

# Single-flight guard shared across slow RPCs (fetchMetadata, convert).
# ADR-0004: concurrent imports across two LCSC tabs return ``busy``.
_busy_lock = threading.Lock()
_busy = False

# Issue #26: with a reader-thread + worker-pool design multiple responses
# may be ready to ship at the same instant — a streaming ``convert``
# progress frame plus a fresh ``listTemplates`` reply, for instance. The
# Native-Messaging frame format has no resync marker, so interleaved bytes
# would desync the SW reader. Serialize every stdout write through one
# lock to keep frames atomic.
_write_lock = threading.Lock()

# Bound the worker pool. The thread count only caps concurrent in-flight
# verbs (one ``convert`` plus a handful of fast read-only verbs); each
# worker mostly sleeps inside the inner pipeline / filesystem call.
_DEFAULT_MAX_WORKERS = 8


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
    """Write one length-prefixed JSON frame to stdout.

    Thread-safe: holds ``_write_lock`` while emitting the length prefix and
    payload so concurrent workers cannot interleave bytes (Issue #26).
    """
    encoded = json.dumps(msg).encode("utf-8")
    with _write_lock:
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

    if verb == "getRule":
        raw_params = request.get("params")
        params = raw_params if isinstance(raw_params, dict) else {}
        try:
            rule = get_rule(params.get("categoryPath"))
        except ValueError as exc:
            return {"id": request_id, "ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001
            return {
                "id": request_id,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }
        return {"id": request_id, "ok": True, "result": {"rule": rule}}

    if verb == "setRule":
        raw_params = request.get("params")
        params = raw_params if isinstance(raw_params, dict) else {}
        try:
            written = set_rule(params.get("categoryPath"), params.get("rule"))
        except ValueError as exc:
            return {"id": request_id, "ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001
            return {
                "id": request_id,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }
        return {"id": request_id, "ok": True, "result": {"rule": written}}

    if verb == "templatePinCheck":
        raw_params = request.get("params")
        params = raw_params if isinstance(raw_params, dict) else {}
        try:
            result = template_pin_check(params)
        except ValueError as exc:
            return {"id": request_id, "ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001
            return {
                "id": request_id,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }
        return {"id": request_id, "ok": True, "result": result}

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


def _dispatch_one(
    request: dict[str, Any],
    write_message: Callable[[dict[str, Any]], None],
    *,
    metadata_fetcher: Callable[..., dict[str, Any]] | None = None,
    conversion_runner: Callable[..., dict[str, Any]] | None = None,
) -> None:
    """Run ``handle()`` for one request and write its terminal response.

    Exception handling mirrors the pre-#26 ``main()`` loop: any uncaught
    error becomes a structured ``{ok: False, error}`` envelope so the SW
    side can render it without the port dying.
    """
    try:
        response = handle(
            request,
            metadata_fetcher=metadata_fetcher,
            conversion_runner=conversion_runner,
            emit=write_message,
        )
    except Exception as exc:  # noqa: BLE001 — never let a worker kill the host
        response = {
            "id": request.get("id") if isinstance(request, dict) else None,
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
        }
    write_message(response)


def serve(
    *,
    read_message: Callable[[], dict[str, Any] | None] | None = None,
    write_message: Callable[[dict[str, Any]], None] | None = None,
    max_workers: int = _DEFAULT_MAX_WORKERS,
    metadata_fetcher: Callable[..., dict[str, Any]] | None = None,
    conversion_runner: Callable[..., dict[str, Any]] | None = None,
) -> int:
    """Run the Native-Messaging request/response loop until EOF.

    Issue #26 — reader-thread + worker pool. The caller thread reads frames
    from ``read_message`` (defaults to stdin) and submits each request to a
    ``ThreadPoolExecutor`` so a slow ``convert`` does NOT block follow-on
    read-only verbs (``listTemplates``, future ``getRule`` / ``fsList``)
    that the Override Panel fires while Phase 2 runs. The ``_busy_lock``
    still serializes the two slow verbs themselves (ADR-0004 — second slow
    RPC returns ``busy`` immediately, no queue).

    Returns 0 once ``read_message`` reports EOF (``None``). The executor is
    drained before return so in-flight responses still reach the writer.
    """
    reader = read_message or _read_message
    writer = write_message or _write_message
    executor = ThreadPoolExecutor(max_workers=max_workers)
    try:
        while True:
            request = reader()
            if request is None:
                return 0
            executor.submit(
                _dispatch_one,
                request,
                writer,
                metadata_fetcher=metadata_fetcher,
                conversion_runner=conversion_runner,
            )
    finally:
        # ``wait=True`` so workers can publish their terminal frames before
        # the host exits. Chrome will close the port if we shutdown early.
        executor.shutdown(wait=True)


def main() -> int:
    return serve()


if __name__ == "__main__":
    sys.exit(main())
