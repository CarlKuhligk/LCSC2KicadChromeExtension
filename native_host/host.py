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

Concurrent ``fetchMetadata`` / future ``convert`` calls return ``busy`` per
ADR-0004 (no Job state, no queue). The guard lives here so future RPCs
(``convert`` in Issue #4) inherit it without having to re-implement.

Run directly for dev: ``python native_host/host.py`` (Chrome invokes it via
``native_host/kicad-host.bat`` on Windows; see ``install.py`` for the
Native-Host-Manifest setup).
"""

from __future__ import annotations

import json
import struct
import sys
import threading
from typing import Any, Callable

from native_host.phase1 import fetch_metadata

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
) -> dict[str, Any]:
    """Dispatch one request to its RPC handler.

    Args:
        request: Decoded JSON request frame.
        metadata_fetcher: Optional override for the LCSC metadata resolver — tests
            inject a stub to avoid hitting the EasyEDA API. When ``None``, the
            default ``native_host.phase1.fetch_metadata`` is used.
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
            response = handle(request)
        except Exception as exc:
            response = {
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }
        _write_message(response)


if __name__ == "__main__":
    sys.exit(main())
