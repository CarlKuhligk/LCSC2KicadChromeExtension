"""Regression tests for ``extract_symbol_from_lib`` brace-balancing.

The old indent-anchored regex (``(?P=indent)\\)``) silently returned ``None``
when a KiCad-saved / hand-edited library had inconsistent indentation (symbol
opening at 2 spaces, closing at 4) or CRLF line endings — which made the
template merge fail with "Template '…' not found or merge failed". The
paren-balanced implementation must handle those.
"""

from pathlib import Path

from easyeda2kicad.helpers import extract_symbol_from_lib


# Reproduces the real failing file: tab-indented header, 2-space symbol open,
# 4-space symbol close, CRLF throughout, hyphen in the name (imported MPN symbol),
# plus a nested sub-symbol whose ``)`` must not end the parent block early.
INCONSISTENT_SYM = (
    "(kicad_symbol_lib\r\n"
    "\t(version 20251024)\r\n"
    '\t(generator "kicad_symbol_editor")\r\n'
    "\r\n"
    '  (symbol "RC0603FR-071KL"\r\n'
    '      (property "Reference" "R" (at 0 0 0))\r\n'
    '      (symbol "RC0603FR-071KL_0_1"\r\n'
    "        (pin passive line (at 0 0 0) (length 1))\r\n"
    "      )\r\n"
    "    )\r\n"
    ")\r\n"
)


def test_extract_handles_inconsistent_indent_crlf_and_hyphen(tmp_path: Path) -> None:
    f = tmp_path / "TEMPLATE_TEST.kicad_sym"
    f.write_bytes(INCONSISTENT_SYM.encode("utf-8"))
    block = extract_symbol_from_lib(str(f), "RC0603FR-071KL")
    assert block is not None
    assert block.startswith('(symbol "RC0603FR-071KL"')
    assert block.rstrip().endswith(")")
    # Paren-balanced: includes the nested sub-symbol, ends at the symbol's own
    # close — NOT the library close.
    assert block.count("(") == block.count(")")
    assert "RC0603FR-071KL_0_1" in block


def test_extract_quoted_paren_does_not_end_block_early(tmp_path: Path) -> None:
    """A ``)`` inside a quoted string must not terminate the symbol block."""
    sym = (
        "(kicad_symbol_lib\n"
        '  (symbol "X"\n'
        '    (property "Description" "a value (with parens)" (at 0 0 0))\n'
        "  )\n"
        ")\n"
    )
    f = tmp_path / "X.kicad_sym"
    f.write_text(sym, encoding="utf-8")
    block = extract_symbol_from_lib(str(f), "X")
    assert block is not None
    assert "(with parens)" in block
    assert block.count("(") == block.count(")")


def test_extract_missing_symbol_returns_none(tmp_path: Path) -> None:
    f = tmp_path / "X.kicad_sym"
    f.write_text('(kicad_symbol_lib\n  (symbol "X")\n)\n', encoding="utf-8")
    assert extract_symbol_from_lib(str(f), "NotThere") is None
