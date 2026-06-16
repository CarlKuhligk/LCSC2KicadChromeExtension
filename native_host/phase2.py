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

- ``labelMapping`` — optional, the Register slice's metadata projection
  (Issue #28). ``{LcscParamKey: KiCadPropertyName}``. Combined with
  ``pageParams`` (the LCSC params snapshot the content script lifts from
  the product page) the runner builds ``symbol_params`` so the Template
  symbol's properties get the part-specific LCSC values written into the
  KiCad symbol — the demoable for "Symbol stammt aus Template, Properties
  gefüllt".
- ``pageParams`` — optional, the LCSC parameter snapshot
  (``{label: value}``) the content script extracted with
  ``extractPageData``. Used only when ``labelMapping`` is set; ignored
  otherwise.

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


def _normalize_symbol_value(value: str, value_param: str) -> str:
    """Clean a raw LCSC param value for the KiCad Value field.

    Mirrors the V2 background.js ``normalizeSymbolValue``: strip the Ohm symbol
    from Resistance values ("10kΩ" -> "10k"); every other param passes through
    verbatim (Capacitance / Inductance / Voltage keep their units). Kept here as
    the single V3 home for this logic (the JS copy is V2-only and dies with it).
    """
    v = value.strip() if isinstance(value, str) else ""
    if isinstance(value_param, str) and value_param.strip().lower() == "resistance":
        v = v.replace("Ω", "").strip()
    return v


def _resolve_value_override(value_param: Any, page_params: Any) -> str | None:
    """Look up ``value_param`` in the scraped params and normalize it into the
    Value-field string. Returns ``None`` when no param is chosen or the chosen
    key is absent/blank (mismatch-tolerant — never crashes Phase 2)."""
    if not isinstance(value_param, str) or not value_param.strip():
        return None
    if not isinstance(page_params, dict):
        return None
    raw = page_params.get(value_param)
    if not isinstance(raw, str) or not raw.strip():
        return None
    return _normalize_symbol_value(raw, value_param) or None


def _build_symbol_params(
    page_params: Any, exclude_key: Any = None
) -> dict[str, str] | None:
    """Project ALL scraped LCSC params into ``symbol_params`` (auto-upsert).

    ADR-0006 (refined 2026-06-09): no manual label mapping. Every spec-table
    parameter the content script scraped from the product page becomes a KiCad
    symbol Property — the property name is the LCSC label itself, the value is
    the part's value. Stock / price / quantity columns are already filtered out
    by the page scraper (``lcscPageSnapshot``), so what arrives here are the
    technical specs + standard meta (MPN, Manufacturer, Datasheet, …).

    The template merger upserts these: a Property already on the template gets
    its value replaced; a missing one is injected as a hidden Property. Blank
    values are skipped so we never write empty fields. ``exclude_key`` (the
    chosen Value-Param) is dropped so it does not land BOTH as the Value field
    and as a duplicate Property.

    Returns ``None`` when there is nothing to write — keeps the default-path
    behavior (no Property injection).
    """
    if not isinstance(page_params, dict) or not page_params:
        return None
    skip = (
        exclude_key.strip().lower()
        if isinstance(exclude_key, str) and exclude_key.strip()
        else None
    )
    out: dict[str, str] = {}
    for label, value in page_params.items():
        if not isinstance(label, str) or not isinstance(value, str):
            continue
        k = label.strip()
        v = value.strip()
        if not k or not v:
            continue
        if skip and k.lower() == skip:
            continue  # the Value-Param fills the Value field, not a Property
        out[k] = v
    return out or None


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

    # Value-Param: the one scraped param whose value fills the KiCad Value field
    # (e.g. Resistance -> 10k). Resolve + normalize it (Ω-strip for Resistance),
    # then exclude its key from symbol_params so it doesn't ALSO land as a
    # duplicate Property. value_override is the engine hook (both symbol paths).
    page_params = params.get("pageParams")
    value_param = params.get("valueParam")
    value_override = _resolve_value_override(value_param, page_params)

    # Metadata-as-Properties (ADR-0006, refined 2026-06-09): project ALL
    # scraped LCSC params into symbol_params; the template merger upserts them
    # onto the symbol (existing Property -> value replaced, missing -> injected).
    # No manual label mapping — the part's full spec table flows into the symbol.
    symbol_params = _build_symbol_params(page_params, exclude_key=value_param)

    # Pin-label visibility (Category Rule / ≤2-pin auto-heuristic): hide pin
    # numbers / names in the written symbol. The SW forwards them off the matched
    # rule (like labelMapping). Both symbol paths apply them — the template
    # merger and the EasyEDA exporter — via these ConversionRequest fields.
    hide_pin_numbers = bool(params.get("hidePinNumbers"))
    hide_pin_names = bool(params.get("hidePinNames"))

    # Pin↔Pad map (gallery / template pin remap): rename the merged symbol's pin
    # NUMBERS so they line up with the EasyEDA footprint's pad numbers. Only
    # meaningful for a template symbol; the engine (conversion._coerce_template_pin_map
    # + symbol_pin_remap.apply_pin_number_map) coerces + applies it. Footprint pads
    # are never renamed. Lets the gallery's footprint flow run over V3 convert.
    template_pin_map_raw = params.get("templatePinMap")
    template_pin_map = (
        template_pin_map_raw
        if use_template
        and isinstance(template_pin_map_raw, dict)
        and template_pin_map_raw
        else None
    )

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
        template_pin_map=template_pin_map,
        symbol_params=symbol_params,
        hide_pin_numbers=hide_pin_numbers,
        hide_pin_names=hide_pin_names,
        symbol_value_override=value_override,
        symbol_value_param_key=value_param if value_override else None,
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
