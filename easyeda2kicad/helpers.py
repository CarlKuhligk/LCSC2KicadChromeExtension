import logging
import math
import os
import re
import textwrap
from typing import TYPE_CHECKING

from easyeda2kicad.kicad.parameters_kicad_symbol import KicadVersion

if TYPE_CHECKING:
    from easyeda2kicad.easyeda.parameters_easyeda import EeSymbol

sym_lib_regex_pattern = {
    "v5": r"(#\n# {component_name}\n#\n.*?ENDDEF\n)",
    "v6": r'\n(?P<indent>[ \t]*)\(symbol "{component_name}".*?\n(?P=indent)\)',
}


def symbol_is_empty(symbol: "EeSymbol") -> bool:
    """Return True if the EasyEDA symbol has no graphical content."""
    return not any((
        symbol.pins,
        symbol.rectangles,
        symbol.circles,
        symbol.arcs,
        symbol.ellipses,
        symbol.polylines,
        symbol.polygons,
        symbol.paths,
    ))


def set_logger(log_file: str, log_level: int) -> None:

    root_log = logging.getLogger()
    root_log.setLevel(log_level)

    if log_file:
        file_handler = logging.FileHandler(
            filename=log_file, mode="w", encoding="utf-8"
        )
        file_handler.setLevel(log_level)
        file_handler.setFormatter(
            logging.Formatter(
                fmt="[{asctime}][{levelname}][{funcName}] {message}", style="{"
            )
        )
        root_log.addHandler(file_handler)

    stream_handler = logging.StreamHandler()
    stream_handler.setLevel(log_level)
    stream_handler.setFormatter(
        logging.Formatter(fmt="[{levelname}] {message}", style="{")
    )
    root_log.addHandler(stream_handler)


def sanitize_for_regex(field: str):
    return re.escape(field)


def _component_name_variants(component_name: str) -> list[str]:
    """
    Yield possible symbol identifiers used across tool versions.
    Historically colons were left untouched; newer releases encode them
    as {colon}. We must handle both to keep overwrite behaviour intact.
    """
    variants = [component_name]
    legacy_variant = (
        component_name.replace("{colon}", ":").replace("{COLON}", ":")
    )
    if legacy_variant not in variants:
        variants.append(legacy_variant)
    return variants


def list_symbols_in_lib(lib_path: str) -> list:
    """Return all top-level symbol names from a .kicad_sym file."""
    try:
        with open(lib_path, encoding="utf-8", errors="ignore") as f:
            content = f.read()
        all_names = re.findall(r'\(symbol\s+"([^"]+)"', content)
        # Sub-symbols have a _N_N suffix (e.g. MyPart_0_1) — filter those out
        return [n for n in all_names if not re.search(r"_\d+_\d+$", n)]
    except OSError:
        return []


def extract_symbol_from_lib(lib_path: str, symbol_name: str) -> str | None:
    """Extract a single symbol block from a .kicad_sym library file by name."""
    try:
        with open(lib_path, encoding="utf-8") as f:
            content = f.read()
    except OSError:
        return None
    pattern = sym_lib_regex_pattern["v6"].format(
        component_name=sanitize_for_regex(symbol_name)
    )
    # re.findall with a named group returns only the captured text (the indent),
    # not the full match.  Use re.search + .group(0) to get the whole block.
    m = re.search(pattern, content, flags=re.DOTALL)
    return m.group(0).strip() if m else None


def id_already_in_symbol_lib(
    lib_path: str, component_name: str, kicad_version: KicadVersion
) -> bool:
    with open(lib_path, encoding="utf-8") as lib_file:
        current_lib = lib_file.read()
        for variant in _component_name_variants(component_name):
            component = re.findall(
                sym_lib_regex_pattern[kicad_version.name].format(
                    component_name=sanitize_for_regex(variant)
                ),
                current_lib,
                flags=re.DOTALL,
            )
            if component:
                logging.info(
                    "Symbol '%s' already exists in %s", variant, lib_path
                )
                return True
    return False


def update_component_in_symbol_lib_file(
    lib_path: str,
    component_name: str,
    component_content: str,
    kicad_version: KicadVersion,
) -> None:
    with open(file=lib_path, encoding="utf-8") as lib_file:
        current_lib = lib_file.read()
        pattern_template = sym_lib_regex_pattern[kicad_version.name]

    new_lib = current_lib
    match_found = False
    for variant in _component_name_variants(component_name):
        candidate_pattern = pattern_template.format(
            component_name=sanitize_for_regex(variant)
        )
        if re.search(candidate_pattern, new_lib, flags=re.DOTALL):
            new_lib = re.sub(candidate_pattern, "", new_lib, flags=re.DOTALL)
            match_found = True

    if not match_found:
        logging.warning(
            "Unable to locate symbol '%s' in %s for update; appending new entry instead.",
            component_name,
            lib_path,
        )
        add_component_in_symbol_lib_file(
            lib_path=lib_path,
            component_content=component_content,
            kicad_version=kicad_version,
        )
        return

    new_lib = new_lib.replace(
        "(generator kicad_symbol_editor)",
        "(generator https://github.com/uPesy/easyeda2kicad.py)",
    )

    with open(file=lib_path, mode="w", encoding="utf-8") as lib_file:
        lib_file.write(new_lib)

    add_component_in_symbol_lib_file(
        lib_path=lib_path,
        component_content=component_content,
        kicad_version=kicad_version,
    )


def add_component_in_symbol_lib_file(
    lib_path: str, component_content: str, kicad_version: KicadVersion
) -> None:

    if kicad_version == KicadVersion.v5:
        with open(file=lib_path, mode="a+", encoding="utf-8") as lib_file:
            lib_file.write(component_content)
    elif kicad_version == KicadVersion.v6:
        with open(file=lib_path, encoding="utf-8") as lib_file:
            current_lib_data = lib_file.read()

        last_paren_pos = current_lib_data.rfind(")")
        if last_paren_pos == -1:
            raise ValueError(
                "Invalid KiCad library file: unable to locate closing parenthesis"
            )

        component_lines = component_content.split("\n")
        indented_component = "\n".join(
            f"  {line}" if line.strip() else line for line in component_lines
        )

        new_lib_data = (
            current_lib_data[:last_paren_pos]
            + indented_component
            + "\n"
            + current_lib_data[last_paren_pos:]
        )

        with open(file=lib_path, mode="w", encoding="utf-8") as lib_file:
            lib_file.write(
                new_lib_data.replace(
                    "(generator kicad_symbol_editor)",
                    "(generator https://github.com/uPesy/easyeda2kicad.py)",
                )
            )


def add_sub_components_in_symbol_lib_file(
    lib_path: str,
    component_name: str,
    sub_components_content: list[str],
    kicad_version: KicadVersion,
) -> None:
    if kicad_version != KicadVersion.v6:
        logging.error("Multi-unit symbol insertion currently supported only for KiCad v6")
        return

    with open(file=lib_path, encoding="utf-8") as lib_file:
        current_lib = lib_file.read()

    symbol_match = None
    for variant in _component_name_variants(component_name):
        symbol_pattern = sym_lib_regex_pattern[kicad_version.name].format(
            component_name=sanitize_for_regex(variant)
        )
        symbol_match = re.search(symbol_pattern, current_lib, flags=re.DOTALL)
        if symbol_match:
            break
    if not symbol_match:
        logging.warning(
            "Unable to locate base symbol '%s' when adding sub-units", component_name
        )
        return

    symbol_block = symbol_match.group(0)
    unit_pattern = re.compile(
        r'\(symbol "{}_0_1".*?\n\s*\)'.format(
            sanitize_for_regex(component_name)
        ),
        re.DOTALL,
    )

    additional_units = []
    for index, component in enumerate(sub_components_content, start=1):
        unit_match = unit_pattern.search(component)
        if not unit_match:
            logging.warning(
                "Skipping sub-symbol %s: unable to extract KiCad unit payload", index
            )
            continue
        unit_block = unit_match.group(0).replace(
            f"{component_name}_0_1", f"{component_name}_{index}_1"
        )
        dedented_unit = textwrap.dedent(unit_block).strip("\n")
        indented_unit = "\n" + textwrap.indent(dedented_unit, "  ")
        additional_units.append(indented_unit)

    if not additional_units:
        return

    try:
        prefix, suffix = symbol_block.rsplit("\n  )", 1)
    except ValueError:
        logging.error(
            "Malformed symbol block encountered for '%s'; could not append sub-units",
            component_name,
        )
        return

    new_symbol_block = prefix + "".join(additional_units) + "\n  )" + suffix
    new_lib_data = current_lib.replace(symbol_block, new_symbol_block, 1).replace(
        "(generator kicad_symbol_editor)",
        "(generator https://github.com/uPesy/easyeda2kicad.py)",
    )

    with open(file=lib_path, mode="w", encoding="utf-8") as lib_file:
        lib_file.write(new_lib_data)


def get_middle_arc_pos(
    center_x: float,
    center_y: float,
    radius: float,
    angle_start: float,
    angle_end: float,
):
    middle_x = center_x + radius * math.cos((angle_start + angle_end) / 2)
    middle_y = center_y + radius * math.sin((angle_start + angle_end) / 2)
    return middle_x, middle_y
