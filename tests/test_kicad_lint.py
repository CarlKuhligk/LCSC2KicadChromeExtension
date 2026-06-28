"""Tests for scripts/kicad_lint.py — the cross-file KiCad property-hygiene checker.

Covers the things the unit-level normalizer tests do NOT: file walking + the
EOL-preserving byte round-trip (KiCad projects in the wild are often CRLF, and a
naive text write would rewrite every line), BOM handling, collision refusal, and
the exit-code contract.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

# Load the script as a module (it lives in tools/, not on the package path).
# It must be registered in sys.modules *before* exec so the @dataclass bodies can
# resolve their (PEP 563 stringized) annotations against the module's globals.
_SCRIPT = Path(__file__).resolve().parent.parent / "tools" / "kicad_lint.py"
_spec = importlib.util.spec_from_file_location("kicad_lint", _SCRIPT)
assert _spec and _spec.loader
kicad_lint = importlib.util.module_from_spec(_spec)
sys.modules["kicad_lint"] = kicad_lint
_spec.loader.exec_module(kicad_lint)


# A minimal but realistic schematic snippet: one dirty key, one clean sibling.
_SCH = (
    "(kicad_sch (version 20231120) (generator eeschema)\n"
    '  (symbol (lib_id "lib:NTC") (at 100 100 0)\n'
    '    (property "Reference" "TH1" (at 0 0 0))\n'
    '    (property "B Constant (25°C/85°C) " "4310K" (at 0 -2 0))\n'
    '    (property "B Constant (25°C/50°C)" "4250K" (at 0 -4 0))\n'
    "  )\n"
    ")\n"
)


def _write(tmp_path: Path, name: str, text: str, *, crlf: bool = False, bom: bool = False) -> Path:
    data = text.encode("utf-8")
    if crlf:
        data = text.replace("\n", "\r\n").encode("utf-8")
    if bom:
        data = b"\xef\xbb\xbf" + data
    p = tmp_path / name
    p.write_bytes(data)
    return p


def test_scan_flags_only_the_dirty_key() -> None:
    issues = kicad_lint.scan_text(_SCH)
    ws = [i for i in issues if i.kind == "property-whitespace"]
    assert len(ws) == 1
    assert ws[0].field == "B Constant (25°C/85°C)"  # reported trimmed
    # The clean (25°C/50°C) sibling is NOT flagged.
    assert all("50°C" not in i.field for i in ws)


def test_fix_preserves_crlf_byte_for_byte(tmp_path: Path) -> None:
    p = _write(tmp_path, "Board.kicad_pcb", _SCH, crlf=True)
    before = p.read_bytes()
    assert before.count(b"\r\n") > 0 and b"\n" not in before.replace(b"\r\n", b"")

    report = kicad_lint.fix_file(p)
    assert report.fixed == 1

    after = p.read_bytes()
    # Every newline is still CRLF — no line was rewritten.
    assert after.count(b"\r\n") == before.count(b"\r\n")
    assert b"\n" not in after.replace(b"\r\n", b"")
    text = after.decode("utf-8")
    assert '"B Constant (25°C/85°C)"' in text  # trailing space gone
    assert '"B Constant (25°C/85°C) "' not in text
    assert '"B Constant (25°C/50°C)"' in text  # sibling untouched
    # Only the two whitespace bytes (key space + nothing else) were removed.
    assert len(before) - len(after) == 1


def test_fix_is_idempotent(tmp_path: Path) -> None:
    p = _write(tmp_path, "x.kicad_sym", _SCH)
    kicad_lint.fix_file(p)
    second = kicad_lint.fix_file(p)
    assert second.fixed == 0
    assert second.ok


def test_backup_written_only_when_requested(tmp_path: Path) -> None:
    p = _write(tmp_path, "x.kicad_sch", _SCH)
    kicad_lint.fix_file(p, backup=True)
    assert (tmp_path / "x.kicad_sch.bak").is_file()

    q = _write(tmp_path, "y.kicad_sch", _SCH)
    kicad_lint.fix_file(q, backup=False)
    assert not (tmp_path / "y.kicad_sch.bak").exists()


def test_bom_is_reported_and_stripped_on_fix(tmp_path: Path) -> None:
    p = _write(tmp_path, "b.kicad_sym", _SCH, bom=True)
    rep = kicad_lint.scan_file(p)
    assert any(i.kind == "encoding" for i in rep.issues)
    kicad_lint.fix_file(p)
    assert p.read_bytes()[:3] != b"\xef\xbb\xbf"


def test_collision_blocks_fix(tmp_path: Path) -> None:
    """When a clean field and its whitespace twin coexist, trimming would merge
    them — the file must be refused, not silently corrupted."""
    collide = (
        "(kicad_sch (version 1) (generator x)\n"
        '  (symbol (lib_id "l:N")\n'
        '    (property "Foo " "a" (at 0 0 0))\n'
        '    (property "Foo" "b" (at 0 0 0))\n'
        "  )\n"
        ")\n"
    )
    p = _write(tmp_path, "c.kicad_sch", collide)
    issues = kicad_lint.scan_text(collide)
    assert any(i.kind == "property-collision" for i in issues)
    before = p.read_bytes()
    rep = kicad_lint.fix_file(p)
    assert rep.fixed == 0
    assert p.read_bytes() == before  # untouched


def test_iter_skips_bak_and_history(tmp_path: Path) -> None:
    _write(tmp_path, "real.kicad_sch", _SCH)
    _write(tmp_path, "old.kicad_sch.bak", _SCH)
    hist = tmp_path / ".history"
    hist.mkdir()
    _write(hist, "snap.kicad_sch", _SCH)
    backups = tmp_path / "proj-backups"
    backups.mkdir()
    _write(backups, "b.kicad_pcb", _SCH)

    found = {p.name for p in kicad_lint.iter_kicad_files([tmp_path])}
    assert found == {"real.kicad_sch"}


def test_main_exit_codes(tmp_path: Path, capsys) -> None:
    dirty = _write(tmp_path, "d.kicad_sch", _SCH)
    assert kicad_lint.main([str(dirty)]) == 1  # issues → 1
    capsys.readouterr()
    assert kicad_lint.main([str(dirty), "--fix"]) == 0  # fixed → 0
    capsys.readouterr()
    assert kicad_lint.main([str(dirty)]) == 0  # now clean → 0


# --------------------------------------------------------------------------- #
#  --dedupe: the real FloraSense shape — a placed instance carrying BOTH the    #
#  clean field and its whitespace orphan (KiCad's Update-from-Library leftover). #
# --------------------------------------------------------------------------- #

_ORPHAN = (
    "(kicad_sch (version 20231120) (generator eeschema)\n"
    "  (symbol\n"
    '    (lib_id "lib:NTC")\n'
    '    (property "Reference" "TH1" (at 0 0 0))\n'
    '    (property "B Constant (25°C/85°C) " "4310K"\n'
    "      (at 0 -2 0)\n"
    "      (effects (font (size 1.27 1.27)) (hide yes))\n"
    "    )\n"
    '    (property "B Constant (25°C/85°C)" "4310K"\n'
    "      (at 0 -4 0)\n"
    "      (effects (font (size 1.27 1.27)))\n"
    "    )\n"
    "  )\n"
    ")\n"
)


def test_dedupe_removes_orphan_keeps_clean_twin_crlf(tmp_path: Path) -> None:
    p = _write(tmp_path, "x.kicad_sch", _ORPHAN, crlf=True)
    before = p.read_bytes()
    rep = kicad_lint.fix_file(p, dedupe=True)
    assert rep.removed == 1
    after = p.read_bytes()
    text = after.decode("utf-8")
    # The whitespace orphan is gone; exactly one clean twin remains (no duplicate).
    assert '"B Constant (25°C/85°C) "' not in text
    assert text.count('"B Constant (25°C/85°C)"') == 1
    assert "4310K" in text  # value preserved (lived on the twin)
    assert text.count("(") == text.count(")")  # structurally sound
    # EOL preserved: the 4-line orphan block is gone (−4 CRLF) and NO lone LF
    # was introduced — every remaining newline is still CRLF.
    assert after.count(b"\r\n") == before.count(b"\r\n") - 4
    assert b"\n" not in after.replace(b"\r\n", b"")
    # No blank line left where the orphan block was removed.
    assert "\n\n" not in text.replace("\r\n", "\n")


def test_dedupe_text_counts_and_balance() -> None:
    out, removed, trimmed = kicad_lint.dedupe_text(_ORPHAN)
    assert removed == 1
    assert out.count('(property "B Constant (25°C/85°C)"') == 1
    assert out.count("(") == out.count(")")


def test_dedupe_strips_orphan_without_twin(tmp_path: Path) -> None:
    """An orphan with NO clean twin must NOT be removed (that would lose data) —
    it falls through to a plain trim instead."""
    txt = (
        "(kicad_sch (version 1) (generator x)\n"
        '  (symbol (lib_id "l:N")\n'
        '    (property "Lone Field " "v" (at 0 0 0))\n'
        "  )\n"
        ")\n"
    )
    p = _write(tmp_path, "y.kicad_sch", txt)
    rep = kicad_lint.fix_file(p, dedupe=True)
    assert rep.removed == 0
    assert rep.fixed == 1
    text = p.read_text(encoding="utf-8")
    assert '"Lone Field"' in text and '"Lone Field "' not in text
    assert '"v"' in text  # value kept


def test_main_dedupe_resolves_collision_exit_zero(tmp_path: Path, capsys) -> None:
    p = _write(tmp_path, "z.kicad_sch", _ORPHAN)
    # Plain scan sees the collision → exit 1.
    assert kicad_lint.main([str(p)]) == 1
    capsys.readouterr()
    # Plain --fix refuses the collision (would merge) → file unchanged, exit 1.
    assert kicad_lint.main([str(p), "--fix"]) == 1
    capsys.readouterr()
    # --fix --dedupe removes the orphan → exit 0, and a re-scan is clean.
    assert kicad_lint.main([str(p), "--fix", "--dedupe"]) == 0
    capsys.readouterr()
    assert kicad_lint.main([str(p)]) == 0
