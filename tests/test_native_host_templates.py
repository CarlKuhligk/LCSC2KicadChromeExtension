"""Tests for native_host.templates.list_templates (Issue #5 follow-up).

Covers:
- Happy path: a real ``.kicad_sym`` file plus a sibling ``.pretty/`` directory
  → returns both layer lists.
- Symbol-only library: no ``.pretty/`` directory → empty footprints list.
- Footprint-only library: ``.pretty/`` exists but ``.kicad_sym`` is missing
  → empty symbols list (a Template can be FP-only by design).
- Missing library entirely → both lists empty, no exception.
- Invalid / empty ``libPath`` → ``ValueError`` (host.py turns it into a
  validation error response).
- Sub-symbols (``Name_0_1``) are filtered (mirrors V2 behaviour in
  ``helpers.list_symbols_in_lib``).

Tests also indirectly exercise the host dispatcher's ``listTemplates``
branch via ``host.handle``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from native_host import host, templates


SAMPLE_KICAD_SYM = """(kicad_symbol_lib (version 20240618) (generator kicad_symbol_editor)
  (symbol "Resistor_SMT_0603"
    (pin passive line (at -2.54 0 0) (length 1.27))
  )
  (symbol "Resistor_SMT_0603_0_1"
    (pin passive line (at -2.54 0 0) (length 1.27))
  )
  (symbol "Capacitor_SMT_0402"
    (pin passive line (at -2.54 0 0) (length 1.27))
  )
)
"""


def _write_lib(tmp_path: Path, name: str = "MyTemplates") -> Path:
    """Write a sample ``.kicad_sym`` and return its path."""
    sym = tmp_path / f"{name}.kicad_sym"
    sym.write_text(SAMPLE_KICAD_SYM, encoding="utf-8")
    return sym


def _write_pretty(tmp_path: Path, name: str, footprints: list[str]) -> Path:
    """Create a ``<name>.pretty/`` dir with stub footprint files."""
    pretty = tmp_path / f"{name}.pretty"
    pretty.mkdir()
    for fp in footprints:
        (pretty / f"{fp}.kicad_mod").write_text("(module stub)", encoding="utf-8")
    return pretty


# ---------------------------------------------------------------------------
# list_templates — happy paths
# ---------------------------------------------------------------------------


def test_lists_both_symbols_and_footprints(tmp_path: Path) -> None:
    sym = _write_lib(tmp_path)
    _write_pretty(tmp_path, "MyTemplates", ["SOT-23-3", "SMD_0603"])

    result = templates.list_templates(str(sym))

    assert result["libPath"] == str(sym)
    # Sub-symbol Resistor_SMT_0603_0_1 must be filtered out
    assert result["symbols"] == ["Resistor_SMT_0603", "Capacitor_SMT_0402"]
    assert result["footprints"] == ["SMD_0603", "SOT-23-3"]  # sorted


def test_returns_empty_footprints_when_pretty_dir_missing(tmp_path: Path) -> None:
    sym = _write_lib(tmp_path)
    result = templates.list_templates(str(sym))
    assert result["symbols"]
    assert result["footprints"] == []


def test_returns_empty_symbols_when_sym_file_missing(tmp_path: Path) -> None:
    # FP-only template: just a .pretty/ dir, no .kicad_sym file
    _write_pretty(tmp_path, "FootprintsOnly", ["SMD_0402"])
    missing_sym = tmp_path / "FootprintsOnly.kicad_sym"
    result = templates.list_templates(str(missing_sym))
    assert result["symbols"] == []
    assert result["footprints"] == ["SMD_0402"]


def test_returns_empty_lists_when_nothing_exists(tmp_path: Path) -> None:
    missing = tmp_path / "NotThere.kicad_sym"
    result = templates.list_templates(str(missing))
    assert result["symbols"] == []
    assert result["footprints"] == []
    assert result["libPath"] == str(missing)


# ---------------------------------------------------------------------------
# list_templates — validation
# ---------------------------------------------------------------------------


def test_empty_lib_path_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="libPath"):
        templates.list_templates("")


def test_whitespace_lib_path_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="libPath"):
        templates.list_templates("   ")


def test_non_string_lib_path_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="libPath"):
        templates.list_templates(None)


def test_only_kicad_mod_files_count(tmp_path: Path) -> None:
    """A `.pretty/` dir may contain non-`.kicad_mod` files (README, .bak, …) —
    those must not appear in the footprint list."""
    _write_lib(tmp_path)
    pretty = _write_pretty(tmp_path, "MyTemplates", ["RealFP"])
    (pretty / "README.md").write_text("ignore me", encoding="utf-8")
    (pretty / "RealFP.kicad_mod.bak").write_text("ignore me", encoding="utf-8")

    result = templates.list_templates(str(tmp_path / "MyTemplates.kicad_sym"))
    assert result["footprints"] == ["RealFP"]


# ---------------------------------------------------------------------------
# host.handle — listTemplates dispatcher branch
# ---------------------------------------------------------------------------


def test_host_dispatches_list_templates_verb(tmp_path: Path) -> None:
    sym = _write_lib(tmp_path)
    _write_pretty(tmp_path, "MyTemplates", ["FP1"])

    response = host.handle({
        "id": 42,
        "verb": "listTemplates",
        "params": {"libPath": str(sym)},
    })

    assert response["id"] == 42
    assert response["ok"] is True
    assert response["result"]["symbols"]
    assert response["result"]["footprints"] == ["FP1"]


def test_host_list_templates_returns_validation_error_for_empty_path() -> None:
    response = host.handle({
        "id": "abc",
        "verb": "listTemplates",
        "params": {"libPath": ""},
    })
    assert response["id"] == "abc"
    assert response["ok"] is False
    assert "libPath" in response["error"]
