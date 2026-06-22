"""Re-import / overwrite safety for symbol libraries.

Regression for the duplicate-on-re-import bug found by the library-safety test:
``id_already_in_symbol_lib`` + ``update_component_in_symbol_lib_file`` used the
indent-anchored ``sym_lib_regex_kicad_sym`` (``(?P=indent)\\)``), which does NOT
match a TEMPLATE-merged symbol whose opening ``(symbol`` and closing ``)`` sit at
different indentation. The "exists" check then returned False, so a re-import
APPENDED a duplicate instead of replacing in place — corrupting libraries (a real
lib was found with one symbol duplicated 8×). The functions are now
paren-balanced (indentation-agnostic) and the updater removes ALL copies before
re-adding one (self-healing existing duplicates).
"""

from __future__ import annotations

import re
from pathlib import Path

from easyeda2kicad.helpers import (
    extract_symbol_from_lib,
    id_already_in_symbol_lib,
    list_symbols_in_lib,
    update_component_in_symbol_lib_file,
)

# "TPL1": opening (symbol at 2 spaces, OUTER close at 4 spaces — the indent
# mismatch a template merge + add_component produce. "R1": normal/consistent.
_LIB = (
    "(kicad_symbol_lib (version 20240618) (generator x)\n"
    '\t(symbol "R1"\n'
    '\t\t(property "Value" "1k" (at 0 0 0) (effects (font (size 1.27 1.27))))\n'
    '\t\t(symbol "R1_0_1"\n'
    "\t\t\t(pin passive line (at 0 0 0) (length 1)\n"
    '\t\t\t\t(name "1" (effects (font (size 1.27 1.27))))\n'
    '\t\t\t\t(number "1" (effects (font (size 1.27 1.27)))))\n'
    "\t\t)\n"
    "\t)\n"
    '  (symbol "TPL1"\n'
    '    (property "Value" "OLD" (at 0 0 0) (effects (font (size 1.27 1.27))))\n'
    '    (symbol "TPL1_0_1"\n'
    '      (pin passive line (at 0 0 0) (length 1)\n'
    '        (name "1" (effects (font (size 1.27 1.27))))\n'
    '        (number "1" (effects (font (size 1.27 1.27)))))\n'
    "    )\n"
    "    )\n"  # <-- outer close at 4 spaces, while the open above is at 2
    ")\n"
)

_NEW_TPL1 = (
    '(symbol "TPL1"\n'
    '  (property "Value" "NEW" (at 0 0 0) (effects (font (size 1.27 1.27))))\n'
    '  (symbol "TPL1_0_1"\n'
    '    (pin passive line (at 0 0 0) (length 1)\n'
    '      (name "1" (effects (font (size 1.27 1.27))))\n'
    '      (number "1" (effects (font (size 1.27 1.27)))))\n'
    "  )\n"
    ")"
)


def _top_count(text: str, name: str) -> int:
    return len(
        [
            m
            for m in re.finditer(rf'\(symbol\s+"{re.escape(name)}"', text)
        ]
    )


def _write(tmp_path: Path) -> str:
    p = tmp_path / "Lib.kicad_sym"
    p.write_text(_LIB, encoding="utf-8")
    return str(p)


def test_id_already_finds_indent_mismatched_symbol(tmp_path: Path) -> None:
    lib = _write(tmp_path)
    # The bug: this returned False for the indent-mismatched TPL1.
    assert id_already_in_symbol_lib(lib, "TPL1") is True
    assert id_already_in_symbol_lib(lib, "R1") is True
    assert id_already_in_symbol_lib(lib, "DoesNotExist") is False


def test_extract_finds_indent_mismatched_symbol(tmp_path: Path) -> None:
    lib = _write(tmp_path)
    blk = extract_symbol_from_lib(lib, "TPL1")
    assert blk is not None and '"OLD"' in blk
    # The trailing-quote needle must not match the sub-symbol.
    assert extract_symbol_from_lib(lib, "TPL1_0_1") is not None  # sub IS a real block too
    # but the parent extraction is the full block (contains its sub-unit)
    assert "TPL1_0_1" in blk


def test_update_replaces_in_place_no_duplicate(tmp_path: Path) -> None:
    lib = _write(tmp_path)
    update_component_in_symbol_lib_file(lib, "TPL1", _NEW_TPL1)
    text = Path(lib).read_text(encoding="utf-8")
    assert _top_count(text, "TPL1") == 1  # NOT duplicated
    assert '"NEW"' in text and '"OLD"' not in text  # replaced
    assert _top_count(text, "R1") == 1  # untouched
    assert text.count("(") == text.count(")")  # structurally sound
    assert set(list_symbols_in_lib(lib)) == {"R1", "TPL1"}


def test_update_dedups_preexisting_duplicates(tmp_path: Path) -> None:
    """A library already damaged with duplicate symbols self-heals: the updater
    removes EVERY copy before re-adding one."""
    # Seed three copies of TPL1 (simulating prior buggy re-imports).
    triple = _LIB.replace(
        '  (symbol "TPL1"',
        '  (symbol "TPL1"\n    (property "x" "1"))\n  (symbol "TPL1"\n    (property "x" "2"))\n  (symbol "TPL1"',
        1,
    )
    p = tmp_path / "Lib.kicad_sym"
    p.write_text(triple, encoding="utf-8")
    lib = str(p)
    assert _top_count(triple, "TPL1") >= 3
    update_component_in_symbol_lib_file(lib, "TPL1", _NEW_TPL1)
    text = p.read_text(encoding="utf-8")
    assert _top_count(text, "TPL1") == 1  # collapsed to one
    assert '"NEW"' in text
    assert text.count("(") == text.count(")")
