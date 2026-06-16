"""Library whitespace report (validate_library) + opt-in fix (clean_library).

The read-only report rides along in ``validate_library``; ``clean_library`` is
the explicitly-invoked fix that backs the file up, trims, and re-validates.
"""
from pathlib import Path

import pytest

from native_host import fs

_DIRTY_LIB = (
    "(kicad_symbol_lib\n"
    "  (version 20211014)\n"
    "  (generator kicad_symbol_editor)\n"
    '  (symbol "R"\n'
    '    (property "Reference" "R" (at 0 0 0))\n'
    '    (property "Value" " 10k " (at 0 0 0))\n'
    '    (property " Tolerance " "1%" (at 0 0 0))\n'
    '    (symbol "R_0_1"\n'
    '      (pin passive line (at 0 0 0) (length 2.54)\n'
    '        (name "~" (effects (font (size 1.27 1.27))))\n'
    '        (number "1" (effects (font (size 1.27 1.27))))\n'
    "      )\n"
    "    )\n"
    "  )\n"
    ")\n"
)

_CLEAN_LIB = _DIRTY_LIB.replace('" 10k "', '"10k"').replace('" Tolerance "', '"Tolerance"')


def _write(tmp_path: Path, content: str, name: str = "WS.kicad_sym") -> Path:
    p = tmp_path / name
    p.write_text(content, encoding="utf-8")
    return p


# ---- validate_library report -------------------------------------------------

def test_validate_reports_dirty_fields(tmp_path: Path):
    p = _write(tmp_path, _DIRTY_LIB)
    res = fs.validate_library(str(p), [str(tmp_path)])
    ws = res["whitespace"]
    assert ws["clean"] is False
    fields = {f["field"]: f["kind"] for s in ws["symbols"] for f in s["fields"]}
    assert fields == {"Value": "value", "Tolerance": "key"}
    assert ws["symbols"][0]["symbol"] == "R"


def test_validate_reports_clean(tmp_path: Path):
    p = _write(tmp_path, _CLEAN_LIB)
    res = fs.validate_library(str(p), [str(tmp_path)])
    assert res["whitespace"] == {"clean": True, "symbols": []}


def test_validate_missing_symbol_file_is_clean(tmp_path: Path):
    # Greenlight a not-yet-created prefix: no file → nothing to scan.
    res = fs.validate_library(str(tmp_path / "DoesNotExist"), [str(tmp_path)])
    assert res["whitespace"] == {"clean": True, "symbols": []}


# ---- clean_library fix -------------------------------------------------------

def test_clean_trims_and_backs_up(tmp_path: Path):
    p = _write(tmp_path, _DIRTY_LIB)
    res = fs.clean_library(str(p), [str(tmp_path)])

    assert res["changed"] == 2
    assert res["symbolPath"] == str(p)
    backup = Path(res["backup"])
    assert backup.name == "WS.kicad_sym.bak"
    assert backup.read_text(encoding="utf-8") == _DIRTY_LIB  # original preserved

    cleaned = p.read_text(encoding="utf-8")
    assert '(property "Value" "10k"' in cleaned
    assert '(property "Tolerance" "1%"' in cleaned
    assert '" 10k "' not in cleaned
    assert '" Tolerance "' not in cleaned


def test_clean_is_idempotent(tmp_path: Path):
    p = _write(tmp_path, _DIRTY_LIB)
    fs.clean_library(str(p), [str(tmp_path)])
    res2 = fs.clean_library(str(p), [str(tmp_path)])
    assert res2["changed"] == 0
    assert res2["backup"] is None
    assert res2["symbols"] == []


def test_clean_accepts_bare_prefix(tmp_path: Path):
    _write(tmp_path, _DIRTY_LIB)
    prefix = str(tmp_path / "WS")  # no .kicad_sym suffix
    res = fs.clean_library(prefix, [str(tmp_path)])
    assert res["changed"] == 2


def test_clean_rejects_path_outside_allowed_roots(tmp_path: Path):
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    denied = tmp_path / "denied"
    denied.mkdir()
    _write(denied, _DIRTY_LIB)
    with pytest.raises(ValueError):
        fs.clean_library(str(denied / "WS.kicad_sym"), [str(allowed)])


def test_clean_missing_file_raises(tmp_path: Path):
    with pytest.raises(ValueError):
        fs.clean_library(str(tmp_path / "Nope.kicad_sym"), [str(tmp_path)])
