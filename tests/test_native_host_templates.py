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
from typing import Any

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


# ---------------------------------------------------------------------------
# template_pin_check — V3 Confidence-Pipeline 🟡 driver (Issue #31)
# ---------------------------------------------------------------------------


_TWO_PIN_CAD = {
    "lcsc": {"number": "C22548"},
    "dataStr": {
        "shape": [
            "P~show~...~M -7.5 0 h 5.08~#000000~~0~0~Pin1~gge1~0~^^",
            "P~show~...~M 7.5 0 h -5.08~#000000~~0~0~Pin2~gge2~0~^^",
            "R~-7.5~-2.5~~~15~5~#000000~1~0~none~gge3~0",
        ],
    },
}


def _stub_cad(payload: dict[str, Any]):
    def _inner(_lcsc_id: str) -> dict[str, Any]:
        return payload
    return _inner


def test_template_pin_check_matching_counts(tmp_path: Path) -> None:
    sym = _write_lib(tmp_path)
    result = templates.template_pin_check(
        {
            "lcscId": "C22548",
            "templateName": "Resistor_SMT_0603",
            "templateLibPath": str(sym),
        },
        cad_fetcher=_stub_cad(_TWO_PIN_CAD),
    )
    # The Resistor_SMT_0603 sample symbol has 1 pin; EasyEDA C22548 stub has 2.
    assert result["easyedaPinCount"] == 2
    assert result["templatePinCount"] == 1
    assert result["match"] is False


def test_template_pin_check_match_flag_true_when_counts_align(tmp_path: Path) -> None:
    # A 2-pin template + 2-pin EasyEDA payload → ``match=True``.
    sym = tmp_path / "TwoPinLib.kicad_sym"
    sym.write_text(
        "(kicad_symbol_lib\n"
        "  (symbol \"Resistor_Std\"\n"
        "    (pin passive line (at -2.54 0 0) (length 1.27))\n"
        "    (pin passive line (at 2.54 0 0) (length 1.27))\n"
        "  )\n"
        ")\n",
        encoding="utf-8",
    )
    result = templates.template_pin_check(
        {
            "lcscId": "C22548",
            "templateName": "Resistor_Std",
            "templateLibPath": str(sym),
        },
        cad_fetcher=_stub_cad(_TWO_PIN_CAD),
    )
    assert result["templatePinCount"] == 2
    assert result["easyedaPinCount"] == 2
    assert result["match"] is True


def test_template_pin_check_handles_missing_template(tmp_path: Path) -> None:
    sym = _write_lib(tmp_path)
    result = templates.template_pin_check(
        {
            "lcscId": "C22548",
            "templateName": "DoesNotExist",
            "templateLibPath": str(sym),
        },
        cad_fetcher=_stub_cad(_TWO_PIN_CAD),
    )
    assert result["templatePinCount"] == 0
    # match is False whenever either side is zero — protects callers from
    # treating a 0/0 coincidence as a confidence boost.
    assert result["match"] is False


def test_template_pin_check_handles_empty_cad(tmp_path: Path) -> None:
    sym = _write_lib(tmp_path)
    result = templates.template_pin_check(
        {
            "lcscId": "C22548",
            "templateName": "Resistor_SMT_0603",
            "templateLibPath": str(sym),
        },
        cad_fetcher=_stub_cad({}),
    )
    assert result["easyedaPinCount"] == 0
    assert result["match"] is False


@pytest.mark.parametrize(
    "payload, message_substr",
    [
        ({"templateName": "X", "templateLibPath": "x"}, "lcscId"),
        ({"lcscId": "bad"}, "lcscId"),
        ({"lcscId": "C22548", "templateLibPath": "x"}, "templateName"),
        ({"lcscId": "C22548", "templateName": "X"}, "templateLibPath"),
    ],
)
def test_template_pin_check_validation_errors(payload, message_substr) -> None:
    with pytest.raises(ValueError, match=message_substr):
        templates.template_pin_check(payload, cad_fetcher=_stub_cad({}))


def test_host_dispatches_template_pin_check_verb(tmp_path: Path, monkeypatch) -> None:
    sym = _write_lib(tmp_path)

    # Patch the EasyedaApi fetcher so the dispatcher path doesn't hit the real
    # network. We rely on the fetcher fallback inside ``template_pin_check`` —
    # the host doesn't accept a ``cad_fetcher`` injection in production paths.
    from easyeda2kicad.easyeda import easyeda_api

    monkeypatch.setattr(
        easyeda_api.EasyedaApi,
        "get_cad_data_of_component",
        lambda _self, _lcsc: _TWO_PIN_CAD,
    )

    response = host.handle({
        "id": 7,
        "verb": "templatePinCheck",
        "params": {
            "lcscId": "C22548",
            "templateName": "Resistor_SMT_0603",
            "templateLibPath": str(sym),
        },
    })

    assert response["id"] == 7
    assert response["ok"] is True
    assert response["result"]["easyedaPinCount"] == 2
    assert response["result"]["templatePinCount"] == 1
    assert response["result"]["match"] is False


def test_host_template_pin_check_returns_validation_error() -> None:
    response = host.handle({
        "id": "v",
        "verb": "templatePinCheck",
        "params": {"templateName": "X", "templateLibPath": "y"},
    })
    assert response["id"] == "v"
    assert response["ok"] is False
    assert "lcscId" in response["error"]
