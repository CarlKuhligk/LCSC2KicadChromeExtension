"""
Template-based KiCad symbol generation.

Merges LCSC component metadata into a user-defined KiCad template symbol,
preserving the template's graphical elements (pins, body shape) and all
property positions / font sizes / visibility — only field *values* are updated.

Any LCSC fields absent from the template are appended as hidden properties.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from easyeda2kicad.kicad.parameters_kicad_symbol import KiSymbolInfo

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


class TemplateMerger:
    """
    Merges LCSC data from a KiSymbolInfo object into a template symbol string.

    The template's graphical body, property positions, font sizes, and visibility
    flags are preserved intact.  Only property *values* are replaced with the
    freshly-scraped LCSC data.  Extra LCSC fields not present in the template
    are injected as hidden properties at the end of the symbol.
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
        vmap: dict[str, str] = {
            "Reference": ki_info.prefix or "",
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
                if v is not None and str(v).strip():
                    vmap[k] = str(v)
        return vmap

    @staticmethod
    def _make_hidden_property(key: str, value: str) -> str:
        """Return a tab-indented hidden KiCad property S-expression block."""
        safe = str(value).replace('"', "'")
        return (
            f'\t\t(property "{key}" "{safe}"\n'
            f"\t\t\t(at 0 0 0)\n"
            f"\t\t\t(effects\n"
            f"\t\t\t\t(font\n"
            f"\t\t\t\t\t(size 1.27 1.27)\n"
            f"\t\t\t\t)\n"
            f"\t\t\t\t(hide yes)\n"
            f"\t\t\t)\n"
            f"\t\t)"
        )

    def merge(
        self,
        template_sym_str: str,
        template_name: str,
        ki_info: "KiSymbolInfo",
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

        # -- 2. Update existing property values in-place ---------------------
        for prop_name, new_val in value_map.items():
            if new_val:  # skip empty values — preserve template placeholders
                result = _replace_property_value(result, prop_name, new_val)

        # -- 3. Discover which properties are already in the template --------
        existing_props = set(re.findall(r'\(property\s+"([^"]+)"', result))

        # -- 4. Append extra LCSC fields not already present as hidden props -
        extra = [(k, v) for k, v in value_map.items() if k not in existing_props and v]
        if extra:
            extra_block = (
                "\n"
                + "\n".join(self._make_hidden_property(k, v) for k, v in extra)
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

        # -- 5. Rename sub-symbol blocks: TemplateName_N_M → ComponentName_N_M
        result = re.sub(
            r'"' + re.escape(template_name) + r'(_\d+_\d+)"',
            f'"{component_name}\\1"',
            result,
        )

        # -- 6. Rename the outer symbol declaration --------------------------
        result = re.sub(
            r'\(symbol\s+"' + re.escape(template_name) + r'"',
            f'(symbol "{component_name}"',
            result,
            count=1,
        )

        # -- 7. Normalise tab indentation to 2-space (KiCad standard) --------
        # Template files commonly use tabs; the library writer expects spaces.
        result = result.replace("\t", "  ")

        # -- 8. Add leading newline expected by add_component_in_symbol_lib_file
        return "\n" + result.strip()
