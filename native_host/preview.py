"""V3 LCSC footprint preview RPC (UI Etappe B).

Renders the EasyEDA footprint of an LCSC part as an inline SVG so the
register/import editor (and the gallery) can show the footprint that will be
imported — the footprint-side analogue of ``templates.template_symbol_preview``.
Read-only: fetches the EasyEDA component CAD data, then reuses the shared
``service.lcsc_preview.footprint_preview_bundle`` renderer. Replaces the V2
WebSocket ``lcsc_footprint_preview`` server endpoint.
"""
from __future__ import annotations

import re
from typing import Any, Callable

_LCSC_ID_RE = re.compile(r"^C\d+$")


def _validate_lcsc_id(raw: Any) -> str:
    if not isinstance(raw, str):
        raise ValueError("lcscId must be a string")
    candidate = raw.strip().upper()
    if not candidate:
        raise ValueError("lcscId is required")
    if not _LCSC_ID_RE.match(candidate):
        raise ValueError(f"invalid lcscId: {raw!r}")
    return candidate


def _coerce_preview_dim(value: Any, default: int) -> int:
    """Clamp a requested SVG dimension to a sane px range (defends the renderer)."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(60, min(1200, n))


def lcsc_footprint_preview(
    payload: Any,
    *,
    cad_fetcher: Callable[[str], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Render an LCSC part's EasyEDA footprint as SVG.

    Args:
        payload: dict with ``lcscId`` and optional ``width`` / ``height`` (px).
        cad_fetcher: optional override for the EasyEDA component-data fetch
            (tests inject a stub). Defaults to
            ``EasyedaApi().get_cad_data_of_component``.

    Returns:
        ``{"svg", "name", "pads"}`` on success, or ``{"svg": None, "error"}``
        when the footprint cannot be fetched or built — a soft failure so the
        editor falls back to a text label rather than aborting.

    Raises:
        ValueError: on missing/invalid ``lcscId``.
    """
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    lcsc_id = _validate_lcsc_id(payload.get("lcscId"))

    if cad_fetcher is None:
        from easyeda2kicad.easyeda.easyeda_api import EasyedaApi

        cad_fetcher = EasyedaApi().get_cad_data_of_component

    try:
        cad = cad_fetcher(lcsc_id) or {}
    except Exception as exc:  # noqa: BLE001 — never crash a read-only preview
        return {"svg": None, "error": f"fetch_failed: {exc}"}
    if not cad:
        return {"svg": None, "error": "no_cad_data"}

    # Lazy import: the footprint exporter chain only loads when a preview is
    # actually requested, keeping host startup and the metadata path light.
    from easyeda2kicad.service.lcsc_preview import footprint_preview_bundle

    bundle = footprint_preview_bundle(
        cad,
        width_px=_coerce_preview_dim(payload.get("width"), 220),
        height_px=_coerce_preview_dim(payload.get("height"), 220),
        lcsc_id=lcsc_id,
    )
    if not bundle.ok:
        return {"svg": None, "error": "render_failed"}
    return {
        "svg": bundle.footprint_svg,
        "name": bundle.footprint_name,
        "pads": bundle.pads,
    }
