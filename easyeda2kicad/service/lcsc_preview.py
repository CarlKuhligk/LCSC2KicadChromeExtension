"""
Shared LCSC CAD → schematic pin list + KiCad footprint preview (SVG + pad table).

Used by template gallery and pin-map context endpoints so footprint/pad logic lives in one place.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from easyeda2kicad.easyeda.easyeda_importer import EasyedaFootprintImporter
from easyeda2kicad.helpers import lcsc_primary_and_sub_symbols
from easyeda2kicad.kicad.export_kicad_footprint import ExporterFootprintKicad
from easyeda2kicad.kicad.footprint_preview_svg import ki_footprint_to_preview_svg
from easyeda2kicad.kicad.parameters_kicad_footprint import KiFootprint

log = logging.getLogger(__name__)


def easyeda_pins_from_cad(cad_data: dict) -> list[dict[str, str]]:
    """Merged primary symbol pin numbers/names (same resolver as ``run_conversion``)."""
    primary, _ = lcsc_primary_and_sub_symbols(cad_data)
    out: list[dict[str, str]] = []
    for p in primary.pins:
        num = (p.settings.spice_pin_number or "").replace(" ", "")
        name = (p.name.text or "").replace(" ", "")
        out.append({"number": num, "name": name})
    return out


def _pads_dict_list_from_ki(ki: KiFootprint) -> list[dict[str, Any]]:
    pads_out: list[dict[str, Any]] = []
    for pad in ki.pads:
        if not str(pad.number).strip():
            continue
        pads_out.append(
            {
                "number": str(pad.number),
                "x": pad.pos_x,
                "y": pad.pos_y,
                "width": pad.width,
                "height": pad.height,
                "shape": pad.shape,
                "type": pad.type,
                "roundrect_rratio": float(getattr(pad, "roundrect_rratio", 0) or 0),
                "chamfer_tl": float(getattr(pad, "chamfer_tl", 0) or 0),
                "chamfer_tr": float(getattr(pad, "chamfer_tr", 0) or 0),
                "chamfer_br": float(getattr(pad, "chamfer_br", 0) or 0),
                "chamfer_bl": float(getattr(pad, "chamfer_bl", 0) or 0),
            }
        )
    return pads_out


@dataclass(frozen=True)
class FootprintPreviewBundle:
    """KiCad footprint preview derived from EasyEDA ``cad_data``."""

    footprint_svg: str | None
    footprint_name: str
    pads: list[dict[str, Any]]

    @property
    def ok(self) -> bool:
        return self.footprint_svg is not None


def footprint_preview_bundle(
    cad_data: dict,
    *,
    width_px: int = 220,
    height_px: int = 220,
    lcsc_id: str = "",
) -> FootprintPreviewBundle:
    """
    Import footprint, export to KiCad model, render SVG + pad list for APIs/UI.

    On failure logs a warning and returns empty pads / no SVG (callers may still use pins).
    """
    footprint_svg: str | None = None
    footprint_name = ""
    pads_out: list[dict[str, Any]] = []
    try:
        fp_importer = EasyedaFootprintImporter(easyeda_cp_cad_data=cad_data, api=None)
        ee_fp = fp_importer.get_footprint()
        footprint_name = ee_fp.info.name or ""
        exporter = ExporterFootprintKicad(ee_fp)
        ki = exporter.get_ki_footprint()
        fp_svg, _meta = ki_footprint_to_preview_svg(
            ki, width_px=width_px, height_px=height_px
        )
        footprint_svg = fp_svg
        pads_out = _pads_dict_list_from_ki(ki)
    except Exception as exc:
        log.warning(
            "Footprint preview failed for %s: %s", lcsc_id or "(unknown)", exc
        )
    return FootprintPreviewBundle(
        footprint_svg=footprint_svg,
        footprint_name=footprint_name,
        pads=pads_out,
    )


def suggested_pad_to_symbol_map(
    easyeda_pins: list[dict[str, str]], pads: list[dict[str, Any]]
) -> dict[str, str]:
    """1:1 hint when LCSC pin id exists as a footprint pad name (else still keyed by pin id)."""
    pad_numbers = {p["number"] for p in pads}
    suggested: dict[str, str] = {}
    for ep in easyeda_pins:
        n = ep["number"]
        if not n:
            continue
        suggested[n] = n if n in pad_numbers else n
    return suggested
