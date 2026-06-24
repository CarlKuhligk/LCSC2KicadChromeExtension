"""
Template-based KiCad symbol generation.

Merges LCSC component metadata into a user-defined KiCad template symbol,
preserving the template's graphical elements (pins, body shape) and all
property positions / font sizes / visibility — only field *values* are updated.
The template's **Reference** prefix (e.g. R, C, D) is kept; EasyEDA's prefix is not applied.

Pin table is driven by the EasyEDA model: missing pins are added at (0,0),
template-only pins are removed, so the final symbol always matches EasyEDA pin set.
If template pin *numbers* are disjoint from LCSC but the pin *count* matches, template
``(pin …)`` blocks are left unchanged so the gallery PAD map (template pin numbers as keys)
stays aligned with the merged symbol before ``apply_pin_number_map``.
"""
from __future__ import annotations

import logging
import re
import textwrap
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING

from easyeda2kicad.kicad.kicad_text_normalize import (
    lcsc_param_matches_any_template_field,
    normalize_for_kicad_text,
    normalize_property_key_for_match,
    normalized_match_keys_for_lcsc_param,
)
from easyeda2kicad.kicad.parameters_kicad_symbol import STANDARD_SYMBOL_PROPERTY_KEYS

if TYPE_CHECKING:
    from easyeda2kicad.kicad.parameters_kicad_symbol import KiSymbolInfo, KiSymbolPin

TEMPLATE_LIB_FILENAME = "Templates.kicad_sym"

KNOWN_TEMPLATE_NAMES = [
    "Template_Resistor",
    "Template_Capacitor",
    "Template_Capacitor_Polarized",
    "Template_Inductor",
]


def get_template_lib_path(symbol_lib_path: str) -> Path | None:
    """Return the Templates.kicad_sym path next to the configured symbol library."""
    lib = Path(symbol_lib_path)
    candidate = lib.parent / TEMPLATE_LIB_FILENAME
    return candidate if candidate.is_file() else None


def _collect_sexpr_block(text: str, start: int) -> tuple[str, int]:
    """
    Extract a balanced S-expression block starting at `start`.
    Returns (block_text, index_after_block).
    """
    depth = 0
    i = start
    in_str = False
    while i < len(text):
        c = text[i]
        if c == '"' and not (i > 0 and text[i - 1] == "\\"):
            in_str = not in_str
        elif not in_str:
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    return text[start : i + 1], i + 1
        i += 1
    return text[start:], len(text)


def _replace_property_value(text: str, prop_name: str, new_value: str) -> str:
    """
    Replace the value-string of a named property in a KiCad S-expression block.
    Only the second quoted argument on the (property ...) line is changed;
    position, effects, and all other attributes are left intact.
    """
    safe = str(new_value).replace('"', "'")
    pattern = r'(\(property\s+"' + re.escape(prop_name) + r'"\s+)"[^"]*"'
    return re.sub(pattern, r'\g<1>"' + safe + '"', text)


def _list_property_names(symbol_str: str) -> list[str]:
    """Top-level property names in declaration order, unique."""
    return list(dict.fromkeys(re.findall(r'\(property\s+"([^"]+)"', symbol_str)))


_PROP_AT_Y_RE = re.compile(r'\(property\s+"[^"]*"\s+"[^"]*"\s*\(at\s+-?[\d.]+\s+(-?[\d.]+)')


def _min_property_y(symbol_str: str) -> float:
    """Lowest Y among existing property positions — the anchor for stacking new
    injected fields beneath them. Returns ``0.0`` when none are positioned."""
    ys = [float(m.group(1)) for m in _PROP_AT_Y_RE.finditer(symbol_str)]
    return min(ys) if ys else 0.0


def _rename_property_key(text: str, old_name: str, new_name: str) -> str:
    """Rename the quoted key in ``(property "KEY" ...)`` declarations."""
    if old_name == new_name:
        return text
    safe_new = new_name.replace("\\", "\\\\").replace('"', '\\"')
    pattern = r'(\(property\s+")' + re.escape(old_name) + r'(")'
    return re.sub(pattern, r"\g<1>" + safe_new + r"\g<2>", text)


def _normalize_property_declaration_names(symbol_str: str) -> str:
    """
    Rewrite property names to KiCad-friendly Unicode (e.g. ℃ → °C) when unambiguous.
    Skips a rename if the target name already exists on another property.
    """
    names = _list_property_names(symbol_str)
    existing = set(names)
    result = symbol_str
    for name in names:
        new_name = normalize_for_kicad_text(name)
        if new_name == name:
            continue
        if new_name in existing:
            continue
        result = _rename_property_key(result, name, new_name)
        existing.discard(name)
        existing.add(new_name)
    return result


def _find_pin_blocks(text: str) -> list[tuple[str, str, int, int]]:
    """
    Find all (pin ...) blocks in a KiCad symbol string.
    Returns list of (block_text, pin_number, start_index, end_index).
    """
    result: list[tuple[str, str, int, int]] = []
    i = 0
    pattern = re.compile(r'\(\s*pin\s+')
    while True:
        m = pattern.search(text, i)
        if not m:
            break
        start = m.start()
        block, end = _collect_sexpr_block(text, start)
        num_m = re.search(r'\(\s*number\s+"([^"]*)"', block)
        pin_number = num_m.group(1) if num_m else ""
        result.append((block, pin_number, start, end))
        i = end
    return result


# KiCad v6 root-level pin visibility (same strings as ``KiSymbol.export_v6``).
_PIN_NUMBERS_HIDE_YES = "\n    (pin_numbers\n      (hide yes)\n    )"
_PIN_NAMES_HIDE_YES = "\n    (pin_names\n      (hide yes)\n    )"


def _strip_root_pin_visibility_prefix(body: str) -> str:
    """
    Remove leading ``(pin_numbers ...)`` / ``(pin_names ...)`` blocks at the start of
    the root symbol body (before properties / inner ``symbol \"Name_0_1\"``).
    """
    s = body
    while True:
        u = s.lstrip()
        lead = len(s) - len(u)
        if not u.startswith("("):
            break
        if u.startswith("(pin_numbers") or u.startswith("(pin_names"):
            start = lead + u.index("(")
            _block, end = _collect_sexpr_block(s, start)
            s = s[:start] + s[end:]
            continue
        break
    return s


def _apply_root_symbol_pin_visibility(
    symbol_text: str, hide_pin_numbers: bool, hide_pin_names: bool
) -> str:
    """
    Apply category / request flags for symbol-level pin name and number visibility.

    EasyEDA-only export builds a fresh ``KiSymbol`` with ``(pin_numbers (hide yes))`` /
    ``(pin_names (hide yes))`` on the root ``(symbol \"…\"`` block. Template merge
    previously kept the template S-expression only, so hide flags from the extension
    were ignored for template imports.
    """
    t = symbol_text.strip()
    # Optional ``power`` / other keyword after the symbol name (e.g. power symbols).
    m = re.match(r'^(\(\s*symbol\s+"[^"]*"(?:\s+\w+)?\s*\n)', t)
    if not m:
        return symbol_text
    head = m.group(1)
    rest = t[m.end() :]
    rest = _strip_root_pin_visibility_prefix(rest)
    extra = ""
    if hide_pin_numbers:
        extra += _PIN_NUMBERS_HIDE_YES
    if hide_pin_names:
        extra += _PIN_NAMES_HIDE_YES
    return head + extra + rest


def _find_primary_unit_pins_region(text: str) -> tuple[int, int] | None:
    """
    Find the span of the first graphical unit (symbol "Name_0_1" or similar)
    that contains pins. Returns (unit_start, unit_end) for the inner unit block,
    or None if no such unit found.
    """
    # Match (symbol "Anything_0_1" or (symbol "Anything_1_1" etc.
    m = re.search(r'\(\s*symbol\s+"[^"]+_\d+_\d+"', text)
    if not m:
        return None
    unit_start = m.start()
    _, unit_end = _collect_sexpr_block(text, unit_start)
    return (unit_start, unit_end)


class TemplateMerger:
    """
    Merges LCSC data from a KiSymbolInfo object into a template symbol string.

    The template's graphical body, property positions, font sizes, and per-property
    visibility are preserved intact. Only property *values* are replaced with the
    freshly-scraped LCSC data. Symbol-level **pin name / pin number** visibility
    follows ``KiSymbolInfo.hide_pin_names`` / ``hide_pin_numbers`` (category rules),
    by rewriting the root ``(pin_names)`` / ``(pin_numbers)`` blocks. Extra LCSC
    fields not present in the template are injected as hidden properties at the
    end of the symbol.
    """

    @staticmethod
    def _build_value_map(ki_info: "KiSymbolInfo") -> dict[str, str]:
        """Build a prop-name → new-value dict from a KiSymbolInfo."""
        value = ki_info.value_override if ki_info.value_override else ki_info.name
        description = ki_info.symbol_description or (
            ki_info.name
            if (ki_info.value_override and ki_info.value_override != ki_info.name)
            else ""
        )
        # Do not set "Reference" from EasyEDA's prefix (often "U"); keep the template symbol's
        # Reference field (e.g. R, C, L, D) so schematic annotation matches the template library.
        vmap: dict[str, str] = {
            "Value": value,
            "Footprint": ki_info.package or "",
            "Datasheet": ki_info.datasheet or "",
            "Description": description,
        }
        if ki_info.manufacturer:
            vmap["Manufacturer"] = ki_info.manufacturer
        if ki_info.lcsc_id:
            vmap["LCSC Part"] = ki_info.lcsc_id
        if ki_info.jlc_id:
            vmap["JLC Part"] = ki_info.jlc_id
        # Flatten symbol_params: Tolerance, Package, Power, Voltage Rating, …
        if ki_info.symbol_params:
            for k, v in ki_info.symbol_params.items():
                if k in STANDARD_SYMBOL_PROPERTY_KEYS:
                    continue
                if v is not None and str(v).strip():
                    vmap[k] = str(v)
        # Value source param is omitted from symbol_params in the extension so Value is not
        # duplicated — but a template may define a second field with the same name as that
        # parameter (e.g. label for temperature-related resistance); map it to the same text.
        if ki_info.value_param_key and value:
            k = str(ki_info.value_param_key).strip()
            if k and k not in STANDARD_SYMBOL_PROPERTY_KEYS:
                vmap[k] = value
        return vmap

    @staticmethod
    def _make_hidden_property(key: str, value: str, pos_y: float = 0.0) -> str:
        """Return a tab-indented hidden KiCad property S-expression block.

        ``pos_y`` places the field on the Y axis so injected fields stack below
        the symbol instead of piling up at the origin (all unreadable at 0 0).
        """
        safe = str(value).replace('"', "'")
        return (
            f'\t\t(property "{key}" "{safe}"\n'
            f"\t\t\t(at 0 {pos_y:.2f} 0)\n"
            f"\t\t\t(effects\n"
            f"\t\t\t\t(font\n"
            f"\t\t\t\t\t(size 1.27 1.27)\n"
            f"\t\t\t\t)\n"
            f"\t\t\t\t(hide yes)\n"
            f"\t\t\t)\n"
            f"\t\t)"
        )

    def _merge_pin_table(
        self, symbol_str: str, source_pins: list["KiSymbolPin"]
    ) -> tuple[str, int, int, int]:
        """
        Make symbol pin table match EasyEDA: add missing pins at (0,0), remove
        template-only pins. Returns (new_symbol_str, kept_count, added_count, removed_count).
        """

        source_by_number: dict[str, KiSymbolPin] = {}
        for p in source_pins:
            num = getattr(p, "number", None)
            if num is not None and str(num).strip():
                source_by_number[str(num).strip()] = p
        source_numbers = set(source_by_number)

        pin_blocks = _find_pin_blocks(symbol_str)
        template_numbers = {num for _, num, _, _ in pin_blocks}

        to_remove = template_numbers - source_numbers
        to_add_numbers = source_numbers - template_numbers

        def _pin_sort_key(n: str):
            try:
                return (0, int(n))
            except ValueError:
                return (1, n)

        # Template pin *numbers* differ from LCSC (e.g. G/D/S vs 1/2/3) but pin *count*
        # matches: keep template ``(pin …)`` blocks unchanged (geometry + number + name).
        # The gallery PAD map uses template pin numbers as keys; ``apply_pin_number_map``
        # then rewrites only ``(number …)`` to footprint pad labels.
        if (
            pin_blocks
            and len(pin_blocks) == len(source_pins)
            and template_numbers.isdisjoint(source_numbers)
        ):
            logging.info(
                "Template/LCSC pin labels differ but counts match; keeping %d template pins "
                "as-is (PAD map keys = template pin numbers).",
                len(pin_blocks),
            )
            return symbol_str, len(pin_blocks), 0, 0

        to_add = [source_by_number[n] for n in sorted(to_add_numbers, key=_pin_sort_key)]

        # Remove template-only pins (from end to start so indices stay valid)
        remove_set = set(to_remove)
        for block, num, start, end in reversed(pin_blocks):
            if num in remove_set:
                symbol_str = symbol_str[:start] + symbol_str[end:]
        kept = len(pin_blocks) - len(to_remove)

        # Insert new pins into the primary unit (or after last pin if flat structure)
        if to_add:
            region = _find_primary_unit_pins_region(symbol_str)
            insert_global: int | None = None
            if region is not None:
                unit_start, unit_end = region
                unit_content = symbol_str[unit_start:unit_end]
                last_pin = list(_find_pin_blocks(unit_content))
                if last_pin:
                    _, _, _, last_end = last_pin[-1]
                    insert_global = unit_start + last_end
                else:
                    insert_global = unit_start + (unit_content.find("\n") + 1 if "\n" in unit_content else 0)
            if insert_global is None:
                # Flat template: insert after last (pin ...) in whole symbol
                all_pins = _find_pin_blocks(symbol_str)
                if all_pins:
                    _, _, _, insert_global = all_pins[-1]
                else:
                    logging.warning("Template has no (symbol \"Name_0_1\" ...) and no pins; cannot add pins.")
                    insert_global = None

            if insert_global is not None:
                indent_str = "\t\t\t"
                new_pin_lines = []
                for pin in to_add:
                    pin_at_origin = replace(pin, pos_x=0, pos_y=0)
                    raw = pin_at_origin.export_v6().strip()
                    new_pin_lines.append(textwrap.indent(raw, indent_str))
                insertion = "\n" + "\n".join(new_pin_lines) + "\n"
                symbol_str = symbol_str[:insert_global] + insertion + symbol_str[insert_global:]

        # Validate: final pin set must equal source
        final_blocks = _find_pin_blocks(symbol_str)
        final_numbers = {num for _, num, _, _ in final_blocks}
        if final_numbers != source_numbers:
            missing = source_numbers - final_numbers
            extra = final_numbers - source_numbers
            logging.warning(
                "Pin merge validation: expected %s pins, got %s; missing %s; extra %s",
                len(source_numbers), len(final_numbers), missing or "none", extra or "none",
            )

        return symbol_str, kept, len(to_add), len(to_remove)

    def merge(
        self,
        template_sym_str: str,
        template_name: str,
        ki_info: "KiSymbolInfo",
        source_pins: list["KiSymbolPin"] | None = None,
    ) -> str:
        from easyeda2kicad.kicad.parameters_kicad_symbol import sanitize_fields

        component_name = sanitize_fields(ki_info.name)

        # -- Guard: symbols using (extends ...) have no own graphical body ---
        if re.search(r'\(extends\s+"', template_sym_str):
            raise ValueError(
                f"Template '{template_name}' uses KiCad's '(extends ...)' feature to "
                "inherit graphics from another library and has no standalone body units. "
                "Templates must be self-contained symbols. Re-create the template by "
                "drawing it directly in the symbol editor (do not derive it from an "
                "existing symbol)."
            )

        # -- 1. Build value map ----------------------------------------------
        value_map = self._build_value_map(ki_info)

        result = template_sym_str

        # -- 2. Update property values (fuzzy key match: LCSC vs template) ---
        template_prop_names = _list_property_names(result)
        norm_to_tpl: dict[str, list[str]] = {}
        for t in template_prop_names:
            norm_to_tpl.setdefault(normalize_property_key_for_match(t), []).append(t)

        initial_template_norms = {
            normalize_property_key_for_match(t) for t in template_prop_names
        }

        for prop_name, new_val in value_map.items():
            if not new_val:
                continue
            val_out = normalize_for_kicad_text(str(new_val))
            candidates: list[str] = []
            seen_tpl: set[str] = set()
            for nk in normalized_match_keys_for_lcsc_param(prop_name):
                for tpl in norm_to_tpl.get(nk, ()):
                    if tpl not in seen_tpl:
                        seen_tpl.add(tpl)
                        candidates.append(tpl)
            if not candidates and prop_name in template_prop_names:
                candidates = [prop_name]
            for tpl in candidates:
                result = _replace_property_value(result, tpl, val_out)

        # -- 3. Prefer °C / °F spellings in property names (font coverage) ---
        result = _normalize_property_declaration_names(result)

        # -- 4. Append extra LCSC fields not already present as hidden props -
        extra = [
            (normalize_for_kicad_text(k), normalize_for_kicad_text(v))
            for k, v in value_map.items()
            if v and not lcsc_param_matches_any_template_field(k, initial_template_norms)
        ]
        if extra:
            # Stack injected fields beneath the lowest existing field with
            # incremental spacing so they are readable, instead of overlapping
            # at the origin (0 0). Only newly-injected fields are placed; the
            # template's own fields keep their positions.
            base_y = _min_property_y(result)
            inc = 2.54  # standard KiCad field spacing (mm)
            extra_block = (
                "\n"
                + "\n".join(
                    self._make_hidden_property(k, v, base_y - inc * (i + 1))
                    for i, (k, v) in enumerate(extra)
                )
                + "\n"
            )
            # Insert before (embedded_fonts ...) or before the closing ) of symbol
            if re.search(r'\(embedded_fonts\b', result):
                result = re.sub(
                    r'(\t*\(embedded_fonts\b)',
                    extra_block + r'\1',
                    result,
                    count=1,
                )
            else:
                idx = result.rfind("\t)")
                if idx != -1:
                    result = result[:idx] + extra_block + result[idx:]

        # -- 5. Pin table: match EasyEDA exactly ---------------------------------
        # Add missing EasyEDA pins at (0,0); remove template-only pins.
        if source_pins is not None:
            result, kept, added, removed = self._merge_pin_table(result, source_pins)
            logging.info(
                "Template pin merge: kept %s, added %s @ (0,0), removed %s.",
                kept, added, removed,
            )

        # -- 6. Rename sub-symbol blocks: TemplateName_N_M → ComponentName_N_M
        result = re.sub(
            r'"' + re.escape(template_name) + r'(_\d+_\d+)"',
            f'"{component_name}\\1"',
            result,
        )

        # -- 7. Rename the outer symbol declaration --------------------------
        result = re.sub(
            r'\(symbol\s+"' + re.escape(template_name) + r'"',
            f'(symbol "{component_name}"',
            result,
            count=1,
        )

        # -- 8. Normalise tab indentation to 2-space (KiCad standard) --------
        # Template files commonly use tabs; the library writer expects spaces.
        result = result.replace("\t", "  ")

        # -- 8.5 Symbol-level pin visibility (category hide pin name / number) ---
        # Same KiCad directives as ``KiSymbol.export_v6``; template-only path skipped these.
        result = _apply_root_symbol_pin_visibility(
            result,
            ki_info.hide_pin_numbers,
            ki_info.hide_pin_names,
        )

        # -- 9. Add leading newline expected by add_component_in_symbol_lib_file
        return "\n" + result.strip()
