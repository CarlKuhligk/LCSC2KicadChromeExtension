"""
Utilities for **renaming EasyEDA footprint pad labels** in memory.

.. warning::

    **Template import and ``run_conversion`` do not use this module for PAD mapping.**
    The Chrome extension / API send ``template_pin_map`` only to adjust **symbol**
    ``(number …)`` fields (see ``symbol_pin_remap.apply_pin_number_map``). Footprint
    ``(pad "…")`` names are always exported **unchanged** from EasyEDA.

``apply_template_pin_map_to_footprint`` remains for **unit tests** and any future
optional tooling; it must **not** be wired back into template import without an
explicit product decision.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Mapping

if TYPE_CHECKING:
    from easyeda2kicad.easyeda.parameters_easyeda import EeFootprint

_TEMP_PREFIX = "__K2C_PADTMP_"
_TMP_RE = re.compile(rf"^{re.escape(_TEMP_PREFIX)}(\d+)__(.+)$")
# EasyEDA / LCSC sometimes wrap the logical pad id, e.g. ``$PAD(1)`` or ``$EP$``.
_RE_PAD_WRAPPER = re.compile(r"^\$PAD\(([^)]+)\)", re.IGNORECASE)
_RE_DOLLAR_WRAPPED = re.compile(r"^\$([^$]+)\$$")


def normalize_easyeda_pad_number(s: str) -> str:
    """
    Normalize a footprint pad identifier from EasyEDA ``PAD~`` data to the string written
    in KiCad ``(pad "…")`` and returned in ``lcsc_footprint_preview`` / the extension UI.

    Keeps plain labels (``1``, ``EP``, ``A1``) unchanged; unwraps common ``$…`` / bracket
    encodings. Used by the footprint exporter and by ``template_pin_map`` handling so
    gallery labels match the merged footprint file.
    """
    t = str(s).strip()
    if not t:
        return t
    for _ in range(6):
        prev = t
        m = _RE_PAD_WRAPPER.match(t)
        if m:
            inner = m.group(1).strip()
            if inner:
                t = inner
                continue
        m = _RE_DOLLAR_WRAPPED.match(t)
        if m:
            inner = m.group(1).strip()
            if inner and "(" not in inner:
                t = inner
                continue
        if "(" in t and ")" in t:
            try:
                inner = t.split("(", 1)[1].split(")", 1)[0].strip()
                if inner and inner != t:
                    t = inner
                    continue
            except (IndexError, ValueError):
                pass
        if t == prev:
            break
    return t


def _normalize_pad_label(s: str) -> str:
    return normalize_easyeda_pad_number(s)


def apply_template_pin_map_to_footprint(
    footprint: EeFootprint,
    pin_to_pad: Mapping[str, str],
) -> None:
    """
    Mutates ``footprint.pads[*].number`` in place (tests / non-default tooling only).

    **Not used** by production template import — see module docstring.

    ``pin_to_pad`` maps schematic pin number → package pad label; pads whose current
    number matches a map *value* are renamed to the map *key*. Two-phase rename avoids
    swap collisions.
    """
    if not pin_to_pad:
        return
    pads = getattr(footprint, "pads", None) or []
    if not pads:
        return

    ren: dict[str, str] = {}
    for pin_k, pad_v in pin_to_pad.items():
        pk = str(pin_k).strip()
        pv = _normalize_pad_label(str(pad_v))
        if pk and pv:
            ren[pv] = pk

    if not ren:
        return

    for i, p in enumerate(pads):
        key = _normalize_pad_label(p.number)
        if key in ren:
            p.number = f"{_TEMP_PREFIX}{i}__{key}"

    for p in pads:
        m = _TMP_RE.match(str(p.number))
        if not m:
            continue
        old_key = m.group(2)
        if old_key in ren:
            p.number = ren[old_key]
