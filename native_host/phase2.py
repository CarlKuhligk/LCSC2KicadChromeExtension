"""
V3 **Phase 2 Conversion** runner (Issues #4, #6).

Default-path slice: drives the existing EasyEDA → KiCad pipeline
(``easyeda2kicad.service.conversion.run_conversion``) without user overrides
but **with the 3D Layer enabled** (#6) — the EasyEDA-Footprint path of
ADR-0005 "3D follows the Footprint" reduces to V2-behavior here. Writes
Symbol + Footprint + 3D into the **Active library** the user picked in
Settings.

The runner is invoked by the Native Host's ``convert`` RPC dispatcher
(``native_host.host.handle``). It receives an ``emit`` callable that the
host wires to ``_write_message`` so each progress notification ships as a
fresh Native-Messaging frame on the same port until the terminal ``done`` /
``error`` arrives (ADR-0004: streamed progress, no Job state).

Inputs (``params`` dict, validated below):

- ``lcscId`` — required, ``^C\\d+$``.
- ``libraryPath`` — required, the library prefix without the ``.kicad_sym``
  suffix. Symbol writes go to ``<libraryPath>.kicad_sym``; footprints to
  ``<libraryPath>.pretty/*.kicad_mod``.

Progress frames are intentionally free-form strings ("Connecting to
EasyEDA…", "Writing .kicad_mod file…") plus an integer ``progress`` 0–100.
The button UI renders the latest message verbatim.

Tests inject a ``conversion_runner`` stub so the suite never hits the real
EasyEDA API.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Optional

from easyeda2kicad.service.conversion import (
    ConversionError,
    ConversionRequest,
    ConversionStage,
    run_conversion,
)

_LCSC_ID_RE = re.compile(r"^C\d+$")

ProgressEmitter = Callable[[str, Optional[int]], None]
"""``(message, percent)`` — host wraps each call as one Native-Messaging frame."""

ConversionRunner = Callable[[ConversionRequest, Callable[[Any, int, Optional[str]], None]], Any]
"""Signature matching :func:`easyeda2kicad.service.conversion.run_conversion`.

Tests inject a stub here so the suite stays offline. Production passes the
real ``run_conversion``.
"""


def _validate_lcsc_id(raw: Any) -> str:
    if not isinstance(raw, str):
        raise ValueError("lcscId must be a string")
    candidate = raw.strip().upper()
    if not candidate:
        raise ValueError("lcscId is required")
    if not _LCSC_ID_RE.match(candidate):
        raise ValueError(f"invalid lcscId: {raw!r}")
    return candidate


def _validate_library_path(raw: Any) -> str:
    if not isinstance(raw, str):
        raise ValueError("libraryPath must be a string")
    candidate = raw.strip()
    if not candidate:
        raise ValueError("libraryPath is required")
    # Drop a trailing .kicad_sym so callers can pass either the prefix or the
    # full symbol-file path. The conversion pipeline always re-attaches the
    # extension internally.
    if candidate.lower().endswith(".kicad_sym"):
        candidate = candidate[: -len(".kicad_sym")]
    return candidate


def run_phase2_conversion(
    params: Any,
    emit: ProgressEmitter,
    *,
    conversion_runner: ConversionRunner = run_conversion,
) -> dict[str, Any]:
    """Execute the default-path Phase 2 conversion for ``params``.

    Args:
        params: ``{"lcscId", "libraryPath", "libraryName"?}``. Other override
            fields are ignored in this slice — overrides land with the
            Override Panel (#5) and Category Rules (#8).
        emit: Called for every progress notification. The host wires this to
            its Native-Messaging writer so each call becomes one wire frame.
            Receives ``(message, percent)`` where ``percent`` may be ``None``
            for messages without a pct (terminal-adjacent finalising step).
        conversion_runner: Override for ``run_conversion`` — tests pass a stub
            that records the progress callback invocations.

    Returns:
        ``{"lcscId", "libraryPath", "symbolPath", "footprintPath", "messages"}``
        on success — terminal-frame payload the host wraps as ``{ok: True, result: ...}``.

    Raises:
        ValueError: on malformed params (becomes ``{ok: False, error: ...}``).
        ConversionError: from the underlying pipeline (becomes RPC error).
    """
    if not isinstance(params, dict):
        params = {}

    lcsc_id = _validate_lcsc_id(params.get("lcscId"))
    output_prefix = _validate_library_path(params.get("libraryPath"))

    request = ConversionRequest(
        lcsc_id=lcsc_id,
        output_prefix=output_prefix,
        overwrite=True,
        # Default path (#6): 3D follows the Footprint. With EasyEDA as the
        # footprint source — the only mode the default path exercises — that
        # collapses to V2's "download EasyEDA-3D + write the (model ...) ref"
        # behaviour. Template-Footprint carry-over (the other branch of
        # ADR-0005) plugs in once the Override Panel (#5) supplies a
        # ``templateFootprintPath`` to feed into ``three_d_resolver``.
        generate_symbol=True,
        generate_footprint=True,
        generate_model=True,
    )

    def _progress_cb(_stage: ConversionStage, pct: int, message: Optional[str]) -> None:
        # ConversionStage drives the percentage; the human-readable message is
        # what the Anchor Card button surfaces. Forward both verbatim so we
        # never lose detail the inner pipeline already framed nicely.
        text = message if isinstance(message, str) and message else f"progress {pct}%"
        emit(text, int(pct))

    emit("Starting Phase 2 conversion…", 0)
    result = conversion_runner(request, _progress_cb)
    emit("Conversion finished.", 100)

    return {
        "lcscId": lcsc_id,
        "libraryPath": output_prefix,
        "symbolPath": getattr(result, "symbol_path", None),
        "footprintPath": getattr(result, "footprint_path", None),
        "messages": list(getattr(result, "messages", []) or []),
    }
