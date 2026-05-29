"""
V3 Native Host — minimal walking-skeleton implementation.

Speaks Chrome's Native Messaging protocol on stdin/stdout: each message is a
little-endian uint32 length prefix followed by that many bytes of UTF-8 JSON.
Returns one response per request. Exits when stdin closes (Chrome disconnect).

This walking-skeleton version handles a single RPC verb — ``ping`` — to
validate ADR-0001 (Native Messaging as the V3 backend transport). Real RPCs
(``fetchMetadata`` in Issue #3, ``convert`` in Issue #4) build on this loop.

Run directly for dev: ``python native_host/host.py`` (Chrome invokes it via
``native_host/kicad-host.bat`` on Windows; see ``install.py`` for the
Native-Host-Manifest setup).
"""

from __future__ import annotations

import json
import struct
import sys
from typing import Any

HOST_VERSION = "0.0.1"


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


def handle(request: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to its RPC handler. Walking skeleton: only ``ping``."""
    verb = request.get("verb")
    request_id = request.get("id")
    if verb == "ping":
        return {"id": request_id, "ok": True, "version": HOST_VERSION}
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
