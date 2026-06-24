import logging
import math
import re
import textwrap
import unicodedata
from typing import TYPE_CHECKING, Any, List, Tuple

from easyeda2kicad.kicad.kicad_text_normalize import strip_property_whitespace

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


def _find_symbol_span(content: str, symbol_name: str) -> "tuple[int, int] | None":
    """Return ``(start, end)`` of the top-level ``(symbol "name" … )`` block.

    Paren-balanced + string-aware (a ``)`` inside quoted text doesn't count) and
    **indentation-agnostic** — the robust replacement for the brittle
    indent-anchored ``sym_lib_regex_kicad_sym`` (``(?P=indent)\\)``), which fails
    when a symbol's opening and closing parens carry different indentation (e.g.
    template-merged symbols open at 2 spaces but close at 4). The trailing quote
    in the needle means a sub-symbol ``"Name_0_1"`` never matches the parent
    ``"Name"``. ``start`` is the index of ``(symbol``; ``end`` is just past the
    matching ``)``. Returns ``None`` when the symbol is absent.
    """
    needle = f'(symbol "{symbol_name}"'
    start = content.find(needle)
    if start == -1:
        return None
    depth = 0
    in_string = False
    for i in range(start, len(content)):
        c = content[i]
        if in_string:
            if c == '"' and content[i - 1] != "\\":
                in_string = False
        elif c == '"':
            in_string = True
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return start, i + 1
    return None


def _iter_top_level_symbol_spans(content: str):
    """Yield ``(name, start, end)`` for each TOP-LEVEL ``(symbol "name" …)``
    block (paren-balanced + string-aware). Iteration resumes past each block's
    closing paren, so nested unit sub-symbols are not re-yielded."""
    name_re = re.compile(r'\(symbol\s+"([^"]+)"')
    n = len(content)
    i = 0
    while True:
        m = name_re.search(content, i)
        if not m:
            return
        start = m.start()
        depth = 0
        in_string = False
        end = None
        j = start
        while j < n:
            c = content[j]
            if in_string:
                if c == '"' and content[j - 1] != "\\":
                    in_string = False
            elif c == '"':
                in_string = True
            elif c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    end = j + 1
                    break
            j += 1
        if end is None:
            return
        yield m.group(1), start, end
        i = end


_LCSC_PART_PROP_RE = re.compile(r'\(property\s+"LCSC Part"\s+"([^"]*)"')


def _find_symbol_span_by_lcsc(content: str, lcsc_id: str) -> "tuple[int, int] | None":
    """Span of the top-level symbol whose ``(property "LCSC Part" "<id>")``
    matches ``lcsc_id`` (case-insensitive). A name-independent re-import anchor:
    the part is found (and thus overwritten) even if its symbol was renamed —
    e.g. an older import named by the LCSC id, re-imported under the MPN."""
    want = str(lcsc_id).strip().upper() if isinstance(lcsc_id, str) else ""
    if not want:
        return None
    for _name, start, end in _iter_top_level_symbol_spans(content):
        m = _LCSC_PART_PROP_RE.search(content[start:end])
        if m and m.group(1).strip().upper() == want:
            return start, end
    return None


def extract_symbol_from_lib(lib_path: str, symbol_name: str) -> str | None:
    """Extract a single top-level symbol block from a .kicad_sym file by name.

    Paren-balanced (see :func:`_find_symbol_span`) rather than indent-anchored,
    so KiCad-saved or hand-edited libraries with inconsistent indentation or
    CRLF line endings still resolve.
    """
    try:
        with open(lib_path, encoding="utf-8") as f:
            content = f.read()
    except OSError:
        return None
    span = _find_symbol_span(content, symbol_name)
    if span is None:
        return None
    return content[span[0] : span[1]].strip()


def id_already_in_symbol_lib(
    lib_path: str, component_name: str, lcsc_id: str | None = None
) -> bool:
    with open(lib_path, encoding="utf-8") as lib_file:
        current_lib = lib_file.read()
    # Prefer the stable LCSC Part property so a re-import finds the part even when
    # its symbol was renamed (LCSC id → MPN) — matches the popup's "in library"
    # badge, which also keys on LCSC Part.
    if lcsc_id and _find_symbol_span_by_lcsc(current_lib, lcsc_id) is not None:
        logging.info("Symbol with LCSC Part '%s' already exists in %s", lcsc_id, lib_path)
        return True
    # Paren-balanced lookup (indentation-agnostic): the old indent-anchored regex
    # missed template-merged symbols (open/close at different indents), so a
    # re-import saw "not present" and APPENDED a duplicate instead of updating.
    for variant in _component_name_variants(component_name):
        if _find_symbol_span(current_lib, variant) is not None:
            logging.info("Symbol '%s' already exists in %s", variant, lib_path)
            return True
    return False


def update_component_in_symbol_lib_file(
    lib_path: str,
    component_name: str,
    component_content: str,
    lcsc_id: str | None = None,
) -> None:
    with open(file=lib_path, encoding="utf-8") as lib_file:
        current_lib = lib_file.read()

    # Remove every existing copy of the symbol (paren-balanced, indentation-agnostic)
    # then re-add one fresh below. Removing ALL occurrences also self-heals a library
    # that a previous (buggy, indent-anchored) re-import had already duplicated.
    new_lib = current_lib
    match_found = False

    def _drop(span: "tuple[int, int]") -> None:
        nonlocal new_lib
        start, end = span
        # Drop the symbol's own leading indentation + one trailing newline so
        # no blank/indented line is left behind.
        line_start = new_lib.rfind("\n", 0, start) + 1
        seg_end = end + 1 if end < len(new_lib) and new_lib[end] == "\n" else end
        new_lib = new_lib[:line_start] + new_lib[seg_end:]

    # 1) Remove the symbol matched by the stable LCSC Part property first — this
    #    catches a prior import under a DIFFERENT name (e.g. the LCSC id before
    #    MPN naming) so the re-import overwrites it instead of leaving a duplicate.
    if lcsc_id:
        while True:
            span = _find_symbol_span_by_lcsc(new_lib, lcsc_id)
            if span is None:
                break
            _drop(span)
            match_found = True

    # 2) Remove every copy matched by name (self-heals prior name duplicates too).
    for variant in _component_name_variants(component_name):
        while True:
            span = _find_symbol_span(new_lib, variant)
            if span is None:
                break
            _drop(span)
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
        "(generator https://github.com/theautomatist/KiCad-Parts-Importer)",
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
    # Single convergence point for every symbol write (EasyEDA + template, fresh
    # + update). Strip leading/trailing whitespace from all property key/values
    # so KiCad never warns about padded fields — covers our own fields *and*
    # any whitespace inherited verbatim from a template symbol.
    component_content = strip_property_whitespace(component_content)
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
                "(generator https://github.com/theautomatist/KiCad-Parts-Importer)",
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
        "(generator https://github.com/theautomatist/KiCad-Parts-Importer)",
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
