"""
V3 Template-Listing resolver (Issue #5 follow-up).

Lists symbol names and footprint names of a Template Library so the
**Override Panel** can populate its Symbol / Footprint Source dropdowns.
In V2 this came from the WebSocket backend's ``templates_symbols`` RPC;
V3 talks Native Messaging directly, so the SW asks the Native Host to do
the on-disk listing.

A Template Library is a ``.kicad_sym`` file plus (optionally) a sibling
``.pretty/`` directory of ``.kicad_mod`` footprints, by KiCad convention:

    MyTemplates.kicad_sym         ← symbol layer
    MyTemplates.pretty/X.kicad_mod ← footprint layer (one file per FP)

Either layer may be missing; the resolver returns the layers it found.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

from easyeda2kicad.helpers import (
    count_pins_in_symbol_string,
    extract_symbol_from_lib,
    list_symbol_categories,
    list_symbols_in_lib,
)

_LCSC_ID_RE = re.compile(r"^C\d+$")


def _list_footprints_in_pretty(pretty_dir: Path) -> list[str]:
    """Return footprint names (no ``.kicad_mod`` suffix) sorted alphabetically.

    Quiet on missing directories — that just means no Footprint layer.
    """
    if not pretty_dir.is_dir():
        return []
    return sorted(
        p.stem for p in pretty_dir.iterdir() if p.suffix == ".kicad_mod" and p.is_file()
    )


def _resolve_pretty_dir(symbol_lib_path: Path) -> Path:
    """Pair ``Foo.kicad_sym`` with the sibling ``Foo.pretty/`` directory."""
    return symbol_lib_path.with_suffix(".pretty")


def _count_pins_in_data_str(data_str: dict[str, Any]) -> int:
    """Mirror of ``native_host.phase1._count_pins_in_data_str`` — kept local to
    avoid a circular import on the Phase 1 module."""
    shape = data_str.get("shape") if isinstance(data_str, dict) else None
    if not isinstance(shape, list):
        return 0
    return sum(1 for line in shape if isinstance(line, str) and line.startswith("P~"))


def _easyeda_pin_count(cad: dict[str, Any]) -> int:
    if not isinstance(cad, dict):
        return 0
    data_str = cad.get("dataStr")
    if not isinstance(data_str, dict):
        return 0
    return _count_pins_in_data_str(data_str)


def _validate_lcsc_id(raw: Any) -> str:
    if not isinstance(raw, str):
        raise ValueError("lcscId must be a string")
    candidate = raw.strip().upper()
    if not candidate:
        raise ValueError("lcscId is required")
    if not _LCSC_ID_RE.match(candidate):
        raise ValueError(f"invalid lcscId: {raw!r}")
    return candidate


def template_gallery_pin_summary(
    payload: Any,
    *,
    cad_fetcher: Callable[[str], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """V3 **TemplateGalleryPinSummary** RPC — batch pin-count compare for the gallery.

    Fetches the EasyEDA pin count ONCE for ``lcscId``, then compares it against
    each requested template symbol's pin count so the gallery can flag
    pin-compatible templates. The V3-native replacement for the V2 WebSocket
    ``templates_gallery_pin_summary`` endpoint.

    Args:
        payload: ``{"lcscId", "templates": [{"templateName", "templateLibPath"}]}``.
        cad_fetcher: optional EasyEDA fetch override (tests inject a stub).

    Returns:
        ``{"easyeda_pin_count", "entries": [{"template_name", "template_lib_path",
        "template_pin_count", "match"}]}`` — snake_case to match the gallery
        consumer. ``match`` is True iff both counts are positive and equal.

    Raises:
        ValueError: on missing/invalid ``lcscId``.
    """
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    lcsc_id = _validate_lcsc_id(payload.get("lcscId"))
    raw_templates = payload.get("templates")
    templates = raw_templates if isinstance(raw_templates, list) else []

    if cad_fetcher is None:
        from easyeda2kicad.easyeda.easyeda_api import EasyedaApi

        cad_fetcher = EasyedaApi().get_cad_data_of_component
    try:
        cad = cad_fetcher(lcsc_id) or {}
    except Exception:  # noqa: BLE001 — read-only summary, never crash the gallery
        cad = {}
    easyeda_pin_count = _easyeda_pin_count(cad)

    entries: list[dict[str, Any]] = []
    for t in templates:
        if not isinstance(t, dict):
            continue
        name = t.get("templateName") or t.get("template_name")
        lib = t.get("templateLibPath") or t.get("template_lib_path")
        if not isinstance(name, str) or not name.strip():
            continue
        if not isinstance(lib, str) or not lib.strip():
            continue
        name = name.strip()
        lib = lib.strip()
        block = extract_symbol_from_lib(lib, name)
        tpl_count = (
            count_pins_in_symbol_string(block) if isinstance(block, str) else 0
        )
        entries.append(
            {
                "template_name": name,
                "template_lib_path": lib,
                "template_pin_count": tpl_count,
                "match": easyeda_pin_count > 0
                and tpl_count > 0
                and easyeda_pin_count == tpl_count,
            }
        )
    return {"easyeda_pin_count": easyeda_pin_count, "entries": entries}


def template_pin_check(
    payload: Any,
    *,
    cad_fetcher: Callable[[str], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """V3 **TemplatePinCheck** RPC (Issue #31).

    Compares the pin count of a Template-Library symbol against the
    EasyEDA-side pin count for ``lcscId``. Used by the Confidence-Pipeline's
    ``autoTemplateMatch`` heuristic so an MCU symbol with 32 pins doesn't
    "win" against a resistor with 2 pins on a name-token coincidence alone.

    Args:
        payload: dict with ``lcscId``, ``templateName``, ``templateLibPath``.
        cad_fetcher: optional override for the EasyEDA component-data fetch;
            tests inject a stub. Defaults to ``EasyedaApi().get_cad_data_of_component``.

    Returns:
        ``{"easyedaPinCount", "templatePinCount", "match"}``. ``match`` is
        ``True`` when both counts are positive AND equal; the SW caches the
        result per ``(libPath, templateName)`` so subsequent imports of
        like parts skip this RPC.

    Raises:
        ValueError: on missing/invalid ``lcscId``, ``templateName``, or
        ``templateLibPath``.
    """
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    lcsc_id = _validate_lcsc_id(payload.get("lcscId"))
    template_name_raw = payload.get("templateName")
    if not isinstance(template_name_raw, str) or not template_name_raw.strip():
        raise ValueError("templateName is required")
    template_name = template_name_raw.strip()
    template_lib_raw = payload.get("templateLibPath")
    if not isinstance(template_lib_raw, str) or not template_lib_raw.strip():
        raise ValueError("templateLibPath is required")
    template_lib_path = template_lib_raw.strip()

    symbol_block = extract_symbol_from_lib(template_lib_path, template_name)
    template_pin_count = (
        count_pins_in_symbol_string(symbol_block) if isinstance(symbol_block, str) else 0
    )

    if cad_fetcher is None:
        from easyeda2kicad.easyeda.easyeda_api import EasyedaApi

        cad_fetcher = EasyedaApi().get_cad_data_of_component

    cad: dict[str, Any]
    try:
        cad = cad_fetcher(lcsc_id) or {}
    except Exception:
        cad = {}
    easyeda_pin_count = _easyeda_pin_count(cad)

    match = (
        easyeda_pin_count > 0
        and template_pin_count > 0
        and easyeda_pin_count == template_pin_count
    )
    return {
        "easyedaPinCount": easyeda_pin_count,
        "templatePinCount": template_pin_count,
        "match": match,
    }


def _coerce_preview_dim(value: Any, default: int) -> int:
    """Clamp a requested SVG dimension to a sane px range (defends the renderer)."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(60, min(1200, n))


def template_symbol_preview(payload: Any) -> dict[str, Any]:
    """V3 **TemplateSymbolPreview** RPC (UI Etappe B).

    Render a Template-Library symbol as an inline SVG so the Import-Editor can
    show the user the symbol they are about to assign — the symbol-side analogue
    of the footprint preview. Read-only.

    Args:
        payload: dict with ``templateLibPath``, ``templateName`` and optional
            ``theme`` ("light"|"dark"), ``labelPins`` / ``drawPinNames`` (bool),
            ``width`` / ``height`` (px).

    Returns:
        ``{"svg": str, "meta": {...}}`` on success, or ``{"svg": None,
        "error": str}`` when the symbol is missing or unrenderable — the editor
        falls back to a text label, so a preview never hard-fails an import.

    Raises:
        ValueError: on missing/invalid ``templateLibPath`` or ``templateName``.
    """
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    template_lib_raw = payload.get("templateLibPath")
    if not isinstance(template_lib_raw, str) or not template_lib_raw.strip():
        raise ValueError("templateLibPath is required")
    template_name_raw = payload.get("templateName")
    if not isinstance(template_name_raw, str) or not template_name_raw.strip():
        raise ValueError("templateName is required")
    template_lib_path = template_lib_raw.strip()
    template_name = template_name_raw.strip()
    theme = "dark" if str(payload.get("theme") or "").strip().lower() == "dark" else "light"

    symbol_block = extract_symbol_from_lib(template_lib_path, template_name)
    if not isinstance(symbol_block, str) or not symbol_block:
        return {"svg": None, "error": "symbol_not_found"}

    # Lazy import: the heavy renderer only loads when a preview is actually
    # requested, keeping the common listTemplates / pin-check paths light.
    from easyeda2kicad.kicad.symbol_preview_svg import symbol_block_to_svg

    svg, meta = symbol_block_to_svg(
        symbol_block,
        label_pins=bool(payload.get("labelPins", True)),
        draw_pin_names=bool(payload.get("drawPinNames", True)),
        width_px=_coerce_preview_dim(payload.get("width"), 300),
        height_px=_coerce_preview_dim(payload.get("height"), 225),
        preview_theme=theme,
    )
    if svg is None:
        return {"svg": None, "error": str(meta.get("error", "render_failed"))}
    return {"svg": svg, "meta": meta}


def _resolve_footprint_mod_file(lib_path: str, name: str) -> Path | None:
    """Locate a template footprint ``.kicad_mod`` for preview.

    Mirrors ``easyeda2kicad.service.conversion._resolve_template_footprint_file``
    (kept local so native_host does not import an engine private). ``lib_path``
    may be a ``.kicad_sym`` (sibling ``.pretty`` resolved), a ``.pretty`` dir,
    or a direct ``.kicad_mod`` file.
    """
    src = Path(lib_path)
    suffix = src.suffix.lower()
    if suffix == ".kicad_mod":
        candidate = src
    elif suffix == ".kicad_sym":
        candidate = _resolve_pretty_dir(src) / f"{name}.kicad_mod"
    else:
        candidate = src / f"{name}.kicad_mod"
    return candidate if candidate.is_file() else None


def template_footprint_preview(payload: Any) -> dict[str, Any]:
    """V3 **TemplateFootprintPreview** RPC (footprint slice, #9).

    Render a template ``.kicad_mod`` as an inline SVG so the Import-Editor can
    show the footprint the user is about to assign — the footprint-side analogue
    of :func:`template_symbol_preview`. Read-only.

    Args:
        payload: dict with ``templateLibPath`` (a ``.kicad_sym`` whose sibling
            ``.pretty`` holds the footprint, a ``.pretty`` dir, or a direct
            ``.kicad_mod``), ``templateName`` (footprint name / file stem), and
            optional ``width`` / ``height`` (px).

    Returns:
        ``{"svg": str, "meta": {...}}`` on success, or ``{"svg": None,
        "error": str}`` when the footprint is missing or unrenderable — the
        editor falls back to a text label so a preview never hard-fails.

    Raises:
        ValueError: on missing/invalid ``templateLibPath`` or ``templateName``.
    """
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    template_lib_raw = payload.get("templateLibPath")
    if not isinstance(template_lib_raw, str) or not template_lib_raw.strip():
        raise ValueError("templateLibPath is required")
    template_name_raw = payload.get("templateName")
    if not isinstance(template_name_raw, str) or not template_name_raw.strip():
        raise ValueError("templateName is required")
    template_lib_path = template_lib_raw.strip()
    template_name = template_name_raw.strip()

    mod_file = _resolve_footprint_mod_file(template_lib_path, template_name)
    if mod_file is None:
        return {"svg": None, "error": "footprint_not_found"}
    try:
        mod_text = mod_file.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return {"svg": None, "error": "footprint_unreadable"}

    # Lazy import: the renderer only loads when a preview is actually requested.
    from easyeda2kicad.kicad.footprint_mod_preview_svg import kicad_mod_to_preview_svg

    svg, meta = kicad_mod_to_preview_svg(
        mod_text,
        width_px=_coerce_preview_dim(payload.get("width"), 300),
        height_px=_coerce_preview_dim(payload.get("height"), 225),
    )
    if svg is None:
        return {"svg": None, "error": str(meta.get("error", "render_failed"))}
    return {"svg": svg, "meta": meta}


def list_templates(lib_path: Any) -> dict[str, Any]:
    """List symbols + footprints belonging to a Template Library.

    Args:
        lib_path: Filesystem path to the ``.kicad_sym`` file. Required.

    Returns:
        ``{"libPath": str, "symbols": [...], "symbolCategories": {name: cat},
        "footprints": [...]}``. ``symbolCategories`` maps the subset of symbols
        that declare a KiCad ``Category`` property to that value (used for
        auto-matching against the LCSC category). Lists/maps may be empty when
        the file is missing or the layer doesn't exist.

    Raises:
        ValueError: when ``lib_path`` is missing or empty.
    """
    raw = lib_path if isinstance(lib_path, str) else ""
    candidate = raw.strip()
    if not candidate:
        raise ValueError("libPath is required")
    sym = Path(candidate)
    is_file = sym.is_file()
    symbols = list_symbols_in_lib(str(sym)) if is_file else []
    symbol_categories = list_symbol_categories(str(sym)) if is_file else {}
    footprints = _list_footprints_in_pretty(_resolve_pretty_dir(sym))
    return {
        "libPath": candidate,
        "symbols": list(symbols),
        "symbolCategories": dict(symbol_categories),
        "footprints": list(footprints),
    }
