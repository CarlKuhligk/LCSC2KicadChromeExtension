import logging
import math
import re
import textwrap
import unicodedata
from typing import TYPE_CHECKING, Any, List, Tuple

if TYPE_CHECKING:
    from easyeda2kicad.easyeda.parameters_easyeda import EeSymbol


def normalize_category_path(raw: Any) -> str:
    """Python mirror of the JavaScript Category Path normalization rule.

    Canonical implementation:
    ``chrome_extension/shared/categoryPath.mjs::normalizeCategoryPath``.

    Rule (in order):
        1. Non-string or ``None`` input → ``""``.
        2. Convert backslashes to forward slashes (``\\`` → ``/``).
        3. Collapse runs of slashes (``//+`` → ``/``), then strip
           leading/trailing whitespace.
        4. Apply Unicode NFC normalization.
        5. Split on ``/``, trim each segment, drop empty segments, rejoin
           with ``/``.

    Drift between the two sides is detected by
    ``tests/test_category_path_mirror.py``, which exercises the same corpus as
    ``chrome_extension/shared/categoryPath.test.mjs``.
    """
    if not isinstance(raw, str):
        return ""
    s = raw.replace("\\", "/")
    s = re.sub(r"/+", "/", s).strip()
    s = unicodedata.normalize("NFC", s)
    return "/".join(seg for seg in (part.strip() for part in s.split("/")) if seg)


def canonical_category_key(raw: Any) -> str:
    """Python mirror of ``canonicalCategoryKey`` (categoryPath.mjs).

    Stable key for de-duplicating paths that differ only by letter case; used
    as the object-key identity for the per-Category-Path settings store.
    """
    n = normalize_category_path(raw)
    return n.lower() if n else ""


def _clean_source_layer(raw: Any) -> dict[str, Any] | None:
    """Permissive coerce of a ``symbolSource`` / ``footprintSource`` entry to
    the ADR-0006 shape, or ``None`` when the input is not recognisable.

    Mirrors ``chrome_extension/shared/categoryPath.mjs::cleanSourceLayer``.
    Unlike ``native_host/rules.py::_normalize_source_layer`` this helper
    **drops** malformed layers instead of raising — the persistence helpers
    must never crash on a single bad row pulled out of storage.
    """
    if not isinstance(raw, dict):
        return None
    source = raw.get("source")
    if source == "easyeda":
        return {"source": "easyeda"}
    if source != "template":
        return None
    lib_path = raw.get("libPath")
    name = raw.get("name")
    if not isinstance(lib_path, str) or not lib_path.strip():
        return None
    if not isinstance(name, str) or not name.strip():
        return None
    return {"source": "template", "libPath": lib_path.strip(), "name": name.strip()}


def _clean_label_mapping(raw: Any) -> dict[str, str]:
    """Permissive normalizer for the LCSC-label → KiCad-property map.

    Mirrors ``chrome_extension/shared/categoryPath.mjs::cleanLabelMapping``.
    Drops non-string and blank entries so a half-filled Import-Editor row in
    storage cannot poison the rule downstream.
    """
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in raw.items():
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        kk = k.strip()
        vv = v.strip()
        if not kk or not vv:
            continue
        out[kk] = vv
    return out


def merge_category_config(a: Any, b: Any) -> dict[str, Any]:
    """Python mirror of ``mergeCategoryConfig`` (categoryPath.mjs).

    Pin-visibility flags OR (either side hiding wins); ``valueParam`` keeps
    ``a``'s preference over ``b``'s. The ADR-0006 ``ComponentRule`` fields
    (``symbolSource``, ``footprintSource``, ``labelMapping``) are preserved:
    source layers prefer ``a`` when both are set; ``labelMapping`` is unioned
    with ``a``'s keys overriding ``b``'s on conflict. Fields removed by
    ADR-0006 (``autoApply``, ``autoConfirm``, ``action``) are silently dropped.

    New fields are only emitted when at least one side carries a usable value,
    matching the JS shape so the JS↔Python parity test stays meaningful.
    """
    def vp(x: Any) -> str:
        if isinstance(x, dict):
            v = x.get("valueParam")
            if isinstance(v, str) and v.strip():
                return v.strip()
        return ""

    def flag(x: Any, name: str) -> bool:
        return bool(isinstance(x, dict) and x.get(name))

    out: dict[str, Any] = {
        "hidePinNumbers": flag(a, "hidePinNumbers") or flag(b, "hidePinNumbers"),
        "hidePinNames": flag(a, "hidePinNames") or flag(b, "hidePinNames"),
        "valueParam": vp(a) or vp(b) or None,
    }
    sym_a = _clean_source_layer(a.get("symbolSource") if isinstance(a, dict) else None)
    sym_b = _clean_source_layer(b.get("symbolSource") if isinstance(b, dict) else None)
    if sym_a or sym_b:
        out["symbolSource"] = sym_a or sym_b
    fp_a = _clean_source_layer(a.get("footprintSource") if isinstance(a, dict) else None)
    fp_b = _clean_source_layer(b.get("footprintSource") if isinstance(b, dict) else None)
    if fp_a or fp_b:
        out["footprintSource"] = fp_a or fp_b
    label_b = _clean_label_mapping(b.get("labelMapping") if isinstance(b, dict) else None)
    label_a = _clean_label_mapping(a.get("labelMapping") if isinstance(a, dict) else None)
    if label_a or label_b:
        merged = dict(label_b)
        merged.update(label_a)
        out["labelMapping"] = merged
    return out


def _clean_rule_entry(v: Any) -> dict[str, Any] | None:
    """Python mirror of ``cleanRuleEntry`` (categoryPath.mjs).

    Projects a raw storage value onto the surviving rule shape. V2 keys are
    always emitted (with defaults) for stable shape; V3 keys are only emitted
    when present. Fields removed by ADR-0006 are silently dropped.
    """
    if not isinstance(v, dict):
        return None
    cfg: dict[str, Any] = {
        "hidePinNumbers": bool(v.get("hidePinNumbers")),
        "hidePinNames": bool(v.get("hidePinNames")),
        "valueParam": (
            v["valueParam"].strip()
            if isinstance(v.get("valueParam"), str) and v["valueParam"].strip()
            else None
        ),
    }
    sym = _clean_source_layer(v.get("symbolSource"))
    if sym:
        cfg["symbolSource"] = sym
    fp = _clean_source_layer(v.get("footprintSource"))
    if fp:
        cfg["footprintSource"] = fp
    labels = _clean_label_mapping(v.get("labelMapping"))
    if labels:
        cfg["labelMapping"] = labels
    return cfg


def dedupe_category_settings(raw: Any) -> dict[str, dict[str, Any]]:
    """Python mirror of ``dedupeCategorySettings`` (categoryPath.mjs).

    Collapses entries that differ only by letter case (longer display key
    wins), strips entries whose key normalizes to empty, and doubles as a
    load-time sanitizer for the Rule schema: V2-era
    ``autoApply`` / ``autoConfirm`` / ``action`` fields (removed by ADR-0006)
    are silently stripped, while ``symbolSource`` / ``footprintSource`` /
    ``labelMapping`` ride through intact.
    """
    if not isinstance(raw, dict):
        return {}
    # Map canonical-key → {displayKey, cfg}; Python 3.7+ dicts preserve
    # insertion order so JS↔Python output ordering matches.
    bucket: dict[str, dict[str, Any]] = {}
    for k, v in raw.items():
        cfg = _clean_rule_entry(v)
        if cfg is None:
            continue
        display_key = normalize_category_path(k)
        canon = canonical_category_key(k)
        if not canon:
            continue
        prev = bucket.get(canon)
        if prev is None:
            bucket[canon] = {"displayKey": display_key, "cfg": cfg}
        else:
            prev["cfg"] = merge_category_config(prev["cfg"], cfg)
            if len(display_key) > len(prev["displayKey"]):
                prev["displayKey"] = display_key
    return {entry["displayKey"]: entry["cfg"] for entry in bucket.values()}

sym_lib_regex_kicad_sym = (
    r'\n(?P<indent>[ \t]*)\(symbol "{component_name}".*?\n(?P=indent)\)'
)


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


def lcsc_primary_and_sub_symbols(cad_data: dict) -> Tuple[Any, List[Any]]:
    """
    Resolve the same primary symbol (and extra sub-units) as ``run_conversion``.

    When the root EasyEDA symbol is empty, LCSC uses the first ``subparts`` entry as the
    primary — the template gallery and footprint preview must use that symbol for pin
    numbers or ``template_pin_map`` keys (template symbol pin numbers) never match merged pins.
    """
    from easyeda2kicad.easyeda.easyeda_importer import EasyedaSymbolImporter

    primary = EasyedaSymbolImporter(easyeda_cp_cad_data=cad_data).get_symbol()
    subparts_data = cad_data.get("subparts") or []
    sub_symbols: List[Any] = []
    iterable = list(subparts_data)
    if iterable:
        if symbol_is_empty(primary):
            primary = EasyedaSymbolImporter(
                easyeda_cp_cad_data=iterable[0]
            ).get_symbol()
            iterable = iterable[1:]
        for sp in iterable:
            sub_symbols.append(
                EasyedaSymbolImporter(easyeda_cp_cad_data=sp).get_symbol()
            )
    return primary, sub_symbols


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


def list_symbol_categories(lib_path: str) -> dict:
    """Map each top-level symbol that declares a KiCad ``Category`` property to
    its (trimmed, non-empty) category value.

    The ``Category`` symbol property couples a template symbol to an LCSC
    category for auto-matching: the symbol is self-describing, so no separate
    rule store is needed (a template author sets ``Category = "Resistors"`` on
    the R symbol and any LCSC resistor matches it). Symbols without the property
    are omitted. One symbol -> one category.
    """
    try:
        with open(lib_path, encoding="utf-8", errors="ignore") as f:
            content = f.read()
    except OSError:
        return {}
    # Each top-level symbol block runs from its own ``(symbol "Name"`` token to
    # the next ``(symbol ...`` token (the first sub-symbol or the next part).
    # The Category property lives in that block, before the sub-symbols.
    matches = list(re.finditer(r'\(symbol\s+"([^"]+)"', content))
    out: dict = {}
    for i, m in enumerate(matches):
        name = m.group(1)
        if re.search(r"_\d+_\d+$", name):
            continue  # sub-symbol
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        block = content[start:end]
        cat_m = re.search(r'\(property\s+"Category"\s+"([^"]*)"', block)
        if cat_m:
            cat = cat_m.group(1).strip()
            if cat:
                out[name] = cat
    return out


def count_pins_in_symbol_string(symbol_str: str) -> int:
    """
    Count top-level (pin ...) blocks in a KiCad symbol string.
    Used to compare template pin count with EasyEDA symbol pin count.
    """
    # Match (pin ...) at the top level of the symbol content; avoid matching
    # inside strings by not counting (pin when inside quotes.
    return len(re.findall(r"\(\s*pin\s+", symbol_str))


def extract_symbol_from_lib(lib_path: str, symbol_name: str) -> str | None:
    """Extract a single symbol block from a .kicad_sym library file by name."""
    try:
        with open(lib_path, encoding="utf-8") as f:
            content = f.read()
    except OSError:
        return None
    pattern = sym_lib_regex_kicad_sym.format(
        component_name=sanitize_for_regex(symbol_name)
    )
    # re.findall with a named group returns only the captured text (the indent),
    # not the full match.  Use re.search + .group(0) to get the whole block.
    m = re.search(pattern, content, flags=re.DOTALL)
    return m.group(0).strip() if m else None


def id_already_in_symbol_lib(lib_path: str, component_name: str) -> bool:
    with open(lib_path, encoding="utf-8") as lib_file:
        current_lib = lib_file.read()
        for variant in _component_name_variants(component_name):
            component = re.findall(
                sym_lib_regex_kicad_sym.format(
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
) -> None:
    with open(file=lib_path, encoding="utf-8") as lib_file:
        current_lib = lib_file.read()
        pattern_template = sym_lib_regex_kicad_sym

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
    )


def add_component_in_symbol_lib_file(
    lib_path: str, component_content: str
) -> None:
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
) -> None:
    with open(file=lib_path, encoding="utf-8") as lib_file:
        current_lib = lib_file.read()

    symbol_match = None
    for variant in _component_name_variants(component_name):
        symbol_pattern = sym_lib_regex_kicad_sym.format(
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
