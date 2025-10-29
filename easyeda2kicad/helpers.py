# Global imports
import json
import logging
import math
import os
import re
import textwrap
from datetime import datetime

from easyeda2kicad import __version__
from easyeda2kicad.kicad.parameters_kicad_symbol import KicadVersion

sym_lib_regex_pattern = {
    "v5": r"(#\n# {component_name}\n#\n.*?ENDDEF\n)",
    "v6": r'\n  \(symbol "{component_name}".*?\n  \)',
    "v6_99": r"",
}


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
                logging.warning(
                    "This id is already in %s (matched name: %s)", lib_path, variant
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
    for variant in _component_name_variants(component_name):
        candidate_pattern = pattern_template.format(
            component_name=sanitize_for_regex(variant)
        )
        updated_lib = re.sub(
            candidate_pattern,
            component_content,
            current_lib,
            flags=re.DOTALL,
        )
        if updated_lib != current_lib:
            new_lib = updated_lib
            break
    else:
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


def get_local_config() -> dict:
    if not os.path.isfile("easyeda2kicad_config.json"):
        with open(file="easyeda2kicad_config.json", mode="w", encoding="utf-8") as conf:
            json.dump(
                {"updated_at": datetime.utcnow().timestamp(), "version": __version__},
                conf,
                indent=4,
                ensure_ascii=False,
            )
        logging.info("Create easyeda2kicad_config.json config file")

    with open(file="easyeda2kicad_config.json", encoding="utf-8") as conf:
        local_conf: dict = json.load(conf)

    return local_conf


def get_arc_center(start_x, start_y, end_x, end_y, rotation_direction, radius):
    arc_distance = math.sqrt(
        (end_x - start_x) * (end_x - start_x) + (end_y - start_y) * (end_y - start_y)
    )

    m_x = (start_x + end_x) / 2
    m_y = (start_y + end_y) / 2
    u = (end_x - start_x) / arc_distance
    v = (end_y - start_y) / arc_distance
    h = math.sqrt(radius * radius - (arc_distance * arc_distance) / 4)

    center_x = m_x - rotation_direction * h * v
    center_y = m_y + rotation_direction * h * u

    return center_x, center_y


def get_arc_angle_end(
    center_x: float, end_x: float, radius: float, flag_large_arc: bool
):
    theta = math.acos((end_x - center_x) / radius) * 180 / math.pi
    return 180 + theta if flag_large_arc else 180 + theta


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
