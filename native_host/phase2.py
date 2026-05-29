"""
V3 **Phase 2 Conversion** runner (Issue #4, extended in #5).

Drives the existing EasyEDA → KiCad pipeline
(``easyeda2kicad.service.conversion.run_conversion``) with the optional
**Override Panel** (#5) source choices baked in. Writes Symbol + Footprint
into the **Active library** the user picked in Settings. 3D Layer lands in
#6; Pin↔Pad Map in #9; full footprint-template path also #9.

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
- ``overrides`` — optional, the Override Panel payload:

    {
      "symbol":    {"source": "easyeda"} | {"source": "template", "libPath": str, "name": str},
      "footprint": {"source": "easyeda"} | {"source": "template", "libPath": str, "name": str}
    }

  Missing / null ``overrides`` ⇒ default-path EasyEDA pipeline (#4 behavior).
  ``symbol.source == "template"`` flows into the existing ``TemplateMerger``
  via ``use_template`` / ``template_name`` / ``template_lib_path``;
  **Always Re-Resolve** is honored because ``TemplateMerger`` reads the
  template file fresh from disk on every conversion — no caching layer.
  ``footprint.source == "template"`` is rejected for now: the full
  footprint-template path needs the Pin-Map Sidecar (#9) and the 3D Layer
  follow-the-Footprint logic (#6) to land first.

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


def _validate_layer_override(raw: Any, *, layer: str) -> dict[str, Any]:
    """Normalize one Override Panel layer entry.

    Returns ``{"source": "easyeda"}`` when ``raw`` is missing / ``None``;
    raises ``ValueError`` on a malformed shape so the RPC envelope carries
    the explanation back to the user (instead of crashing the host port).
    """
    if raw is None:
        return {"source": "easyeda"}
    if not isinstance(raw, dict):
        raise ValueError(f"overrides.{layer} must be an object")
    source = raw.get("source")
    if source == "easyeda" or source is None:
        return {"source": "easyeda"}
    if source != "template":
        raise ValueError(
            f"overrides.{layer}.source must be 'easyeda' or 'template' (got {source!r})"
        )
    lib_path = raw.get("libPath")
    name = raw.get("name")
    if not isinstance(lib_path, str) or not lib_path.strip():
        raise ValueError(f"overrides.{layer}.libPath is required for template source")
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"overrides.{layer}.name is required for template source")
    return {"source": "template", "libPath": lib_path.strip(), "name": name.strip()}


def _validate_overrides(raw: Any) -> dict[str, dict[str, Any]]:
    """Normalize the full Override Panel payload (or default to both EasyEDA).

    Footprint-template overrides are explicitly rejected for now — the full
    footprint-template assembly path needs the Pin-Map Sidecar (#9) plus
    the 3D Layer follow-the-Footprint logic (#6) to land first. Until then
    the panel UI may still send the choice, but Phase 2 surfaces a clear
    RPC error instead of silently producing EasyEDA output the user did
    not pick.
    """
    if raw is None:
        return {"symbol": {"source": "easyeda"}, "footprint": {"source": "easyeda"}}
    if not isinstance(raw, dict):
        raise ValueError("overrides must be an object")
    symbol = _validate_layer_override(raw.get("symbol"), layer="symbol")
    footprint = _validate_layer_override(raw.get("footprint"), layer="footprint")
    if footprint["source"] == "template":
        raise ValueError(
            "footprint template override is not yet wired "
            "(needs Pin-Map Sidecar #9 + 3D follows Footprint #6)"
        )
    return {"symbol": symbol, "footprint": footprint}


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
    overrides = _validate_overrides(params.get("overrides"))

    symbol_override = overrides["symbol"]
    use_template = symbol_override["source"] == "template"

    request = ConversionRequest(
        lcsc_id=lcsc_id,
        output_prefix=output_prefix,
        overwrite=True,
        # Default-path slice: Symbol + Footprint only. 3D Layer ships with #6.
        generate_symbol=True,
        generate_footprint=True,
        generate_model=False,
        # Override Panel (#5): Symbol = Template flows the user's template
        # name + lib path into the existing TemplateMerger. ``force_template``
        # surfaces a clear error if the template is missing instead of
        # silently falling back to the EasyEDA symbol the user did not pick.
        use_template=use_template,
        template_name=symbol_override.get("name") if use_template else None,
        template_lib_path=symbol_override.get("libPath") if use_template else None,
        force_template=use_template,
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
