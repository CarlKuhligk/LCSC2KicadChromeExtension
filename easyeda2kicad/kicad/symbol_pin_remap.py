"""
Rewrite KiCad symbol pin numbers after template merge (schematic ↔ footprint alignment).

KiCad has **no** separate “connection table” in the symbol: the electrical link to the PCB
footprint is **only** that each ``(pin … (number "N"))`` must match a ``(pad "N" …)`` on the
assigned ``.kicad_mod``. Template import keeps **footprint pad names unchanged** (EasyEDA)
and rewrites **only** symbol ``(pin … (number "…"))`` — **never** ``(name "…")`` on pins.

See ``easyeda2kicad.service.conversion._export_symbol_from_template`` where this runs after
``TemplateMerger.merge``.
"""

from __future__ import annotations

import logging
import re
from typing import Mapping

from easyeda2kicad.kicad.footprint_pad_remap import _normalize_pad_label
from easyeda2kicad.kicad.template_merger import _find_pin_blocks

log = logging.getLogger(__name__)

_PIN_NUM_RE = re.compile(r'(\(\s*number\s+)"[^"]*"')


def _sanitize_pin_number_label(s: str) -> str:
    return str(s).replace('"', "'").strip()


def _replace_one_pin_block_number(block: str, new_num: str) -> str:
    safe = _sanitize_pin_number_label(new_num)

    def _repl(m: re.Match[str]) -> str:
        return m.group(1) + f'"{safe}"'

    return _PIN_NUM_RE.sub(_repl, block, count=1)


def _pin_number_matches(symbol_num: str, map_key: str) -> bool:
    """True if KiCad (number …) text matches map key (LCSC / gallery), incl. 01 vs 1."""
    a = symbol_num.strip()
    b = map_key.strip()
    if a == b:
        return True
    if a.isdigit() and b.isdigit():
        return int(a) == int(b)
    return False


def _symbol_has_pin_matching_key(symbol_str: str, map_key: str) -> bool:
    mk = map_key.strip()
    if not mk:
        return False
    for _, num, _, _ in _find_pin_blocks(symbol_str):
        if _pin_number_matches(num, mk):
            return True
    return False


def _filter_pin_map_to_symbol(symbol_str: str, pin_map: dict[str, str]) -> dict[str, str]:
    """Drop map entries that do not match any ``(pin … (number …))`` on this symbol."""
    return {k: v for k, v in pin_map.items() if _symbol_has_pin_matching_key(symbol_str, k)}


def _apply_rename_all_instances(symbol_str: str, old: str, new: str) -> tuple[str, int]:
    """
    Replace every ``(pin …)`` whose ``(number …)`` equals ``old`` with ``new``.

    Multi-unit symbols repeat the same logical pin number in several ``(symbol "…_0_1")``
    blocks; KiCad expects those instances to stay consistent, so we must update all matches.
    """
    old_s = old.strip()
    out = symbol_str
    count = 0
    while True:
        blocks = _find_pin_blocks(out)
        replaced_here = False
        for block, num, start, end in reversed(blocks):
            if not _pin_number_matches(num, old_s):
                continue
            new_block = _replace_one_pin_block_number(block, new)
            out = out[:start] + new_block + out[end:]
            count += 1
            replaced_here = True
            break
        if not replaced_here:
            break
    return out, count


def _normalize_pin_map(pin_map: Mapping[str, str]) -> dict[str, str]:
    """
    Strip keys/values; normalize pad labels on values.

    Pure-digit keys collapse to ``str(int(k))`` so ``"01"`` and ``"1"`` do not split one pin.
    """
    out: dict[str, str] = {}
    for k, v in pin_map.items():
        sk = str(k).strip()
        sv = _normalize_pad_label(str(v))
        if not sk or not sv:
            continue
        ck = str(int(sk)) if sk.isdigit() else sk
        out[ck] = sv
    return out


def apply_pin_number_map(symbol_str: str, pin_map: Mapping[str, str]) -> str:
    """
    Replace (number "old") inside each (pin ...) when old is a key in pin_map.

    Final pin numbers (values) must be unique. Renaming uses a two-phase temporary
    label so swaps and different-length pad names cannot corrupt string offsets.
    """
    nmap = _normalize_pin_map(dict(pin_map))
    if not nmap:
        return symbol_str
    nmap = _filter_pin_map_to_symbol(symbol_str, nmap)
    if not nmap:
        log.warning(
            "apply_pin_number_map: no map keys matched any (pin …) on symbol; map=%s",
            dict(pin_map),
        )
        return symbol_str
    targets = list(nmap.values())
    if len(targets) != len(set(targets)):
        log.warning(
            "apply_pin_number_map: duplicate target numbers in map, skipping: %s",
            nmap,
        )
        return symbol_str

    prefix = "__K2C_PINNUM_"
    temps = {old: f"{prefix}{i}__" for i, old in enumerate(nmap.keys())}

    out = symbol_str
    for old in nmap:
        temp = temps[old]
        out, n_hit = _apply_rename_all_instances(out, old, temp)
        if n_hit == 0:
            log.warning(
                "apply_pin_number_map: no (pin ...) with number %r; keys on symbol may "
                "differ from LCSC (check PAD map). Map=%s",
                old,
                nmap,
            )
            return symbol_str

    for old, new in nmap.items():
        temp = temps[old]
        out, n_hit = _apply_rename_all_instances(out, temp, new)
        if n_hit == 0:
            log.warning(
                "apply_pin_number_map: phase-2 failed %r -> %r",
                temp,
                new,
            )
            return symbol_str

    return out


def list_pins_from_symbol_block(symbol_block: str) -> list[dict[str, str]]:
    """Extract pin number and visible name from a KiCad v6 symbol string."""
    result: list[dict[str, str]] = []
    for block, num, _, _ in _find_pin_blocks(symbol_block):
        nm = re.search(r'\(\s*name\s+"([^"]*)"', block)
        name = nm.group(1) if nm else ""
        result.append({"number": num.strip(), "name": name.strip()})
    return result
