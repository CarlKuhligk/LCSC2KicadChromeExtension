"""
V3 **Phase 2 Conversion** runner (Issue #4).

Default-path slice: drives the existing EasyEDA → KiCad pipeline
(``easyeda2kicad.service.conversion.run_conversion``) without user overrides
and without the 3D Layer (lands in #6). Writes Symbol + Footprint into the
**Active library** the user picked in Settings.

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


_VALID_SOURCES = frozenset({"easyeda", "template"})


def _parse_layer_override(layer_name: str, raw: Any) -> dict[str, Any]:
    """Validate and normalize a single layer's override entry.

    Accepts:

    - ``None`` / missing → ``{"source": "easyeda"}`` (no-op, EasyEDA default).
    - ``{"source": "easyeda"}`` → same.
    - ``{"source": "template", "libPath": "...", "name": "..."}`` → template
      override; both ``libPath`` and ``name`` required.

    Raises ``ValueError`` with a layer-prefixed message so the SW relay's
    error envelope tells the user exactly which dropdown produced the bad
    state (much easier to debug than a bare "invalid override").
    """
    if raw is None:
        return {"source": "easyeda"}
    if not isinstance(raw, dict):
        raise ValueError(f"overrides.{layer_name} must be an object")
    source = raw.get("source")
    if source not in _VALID_SOURCES:
        raise ValueError(
            f"overrides.{layer_name}.source must be one of {sorted(_VALID_SOURCES)!r}"
        )
    if source == "easyeda":
        return {"source": "easyeda"}
    lib_path = raw.get("libPath")
    name = raw.get("name")
    if not isinstance(lib_path, str) or not lib_path.strip():
        raise ValueError(f"overrides.{layer_name}.libPath is required for template source")
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"overrides.{layer_name}.name is required for template source")
    return {"source": "template", "libPath": lib_path.strip(), "name": name.strip()}


def _normalize_overrides(raw: Any) -> dict[str, dict[str, Any]]:
    """Parse the ``overrides`` payload into a uniform two-layer dict.

    Missing payload → both layers default to EasyEDA so the Native Host can
    skip the Override Panel logic entirely and fall through to the Issue #4
    default path.
    """
    if raw is None:
        return {"symbol": {"source": "easyeda"}, "footprint": {"source": "easyeda"}}
    if not isinstance(raw, dict):
        raise ValueError("overrides must be an object")
    return {
        "symbol": _parse_layer_override("symbol", raw.get("symbol")),
        "footprint": _parse_layer_override("footprint", raw.get("footprint")),
    }


def run_phase2_conversion(
    params: Any,
    emit: ProgressEmitter,
    *,
    conversion_runner: ConversionRunner = run_conversion,
) -> dict[str, Any]:
    """Execute the Phase 2 conversion for ``params``.

    Args:
        params: ``{"lcscId", "libraryPath", "overrides"?}``. ``overrides`` is
            the Override Panel's (#5) per-layer source choice; defaults to
            ``{symbol: easyeda, footprint: easyeda}`` when missing — the
            Issue #4 default-path.
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
    overrides = _normalize_overrides(params.get("overrides"))

    # Footprint=template flows depend on the **3D Layer** (#6) and the
    # **Pin-Map Sidecar** (#9) so we refuse the path here until both land —
    # surfacing a clear, actionable error beats silently dropping the user's
    # selection back to EasyEDA. Symbol=template can land standalone because
    # the existing TemplateMerger already covers that case in V2.
    if overrides["footprint"]["source"] == "template":
        raise ValueError(
            "footprint template override is not yet wired "
            "(needs Pin-Map Sidecar #9 + 3D follows Footprint #6)"
        )

    symbol_override = overrides["symbol"]
    use_template_symbol = symbol_override["source"] == "template"

    request = ConversionRequest(
        lcsc_id=lcsc_id,
        output_prefix=output_prefix,
        overwrite=True,
        # Default-path slice: Symbol + Footprint only. 3D Layer ships with #6.
        generate_symbol=True,
        generate_footprint=True,
        generate_model=False,
        use_template=use_template_symbol,
        template_name=symbol_override.get("name") if use_template_symbol else None,
        template_lib_path=symbol_override.get("libPath") if use_template_symbol else None,
        # If the user picked a Template symbol we must NOT silently fall back
        # to EasyEDA when the template fails to load — that would write a
        # different file than the user asked for. Surface the failure instead.
        force_template=use_template_symbol,
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
