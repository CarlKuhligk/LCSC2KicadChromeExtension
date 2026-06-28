#!/usr/bin/env python3
"""kicad_lint — hygiene checker for KiCad project files.

Scans ``.kicad_sch`` / ``.kicad_pcb`` / ``.kicad_sym`` / ``.kicad_mod`` for issues
KiCad complains about but that are tedious to chase by hand, above all
**leading/trailing whitespace in property field names and values** — the
"symbol fields with leading/trailing whitespace" infobar warning. Such padding
sneaks in from scraped vendor parameters (e.g. an LCSC field ``"B Constant (25°C/85°C) "``)
and rides along into every schematic and board the part is placed on.

It reuses the importer's own single source of truth
(:mod:`easyeda2kicad.kicad.kicad_text_normalize`) so the lint and the import
write-path can never disagree on what "clean" means.

Reported checks
---------------
* ``property-whitespace`` — a ``(property "KEY" "VALUE")`` whose key or value has
  edge whitespace (fixable).
* ``property-collision`` — two property names in the same container that become
  identical once trimmed (report only; trimming would merge two fields, so it is
  flagged for a human instead of silently fixed).
* ``encoding`` — file is not valid UTF-8, or carries a UTF-8 BOM (report only).

Fixing is EOL-preserving: the file is read and written as bytes and only the text
*inside* the quoted property strings is touched, so CRLF/LF and everything else
survive byte-for-byte. A safety re-check refuses to write if the parenthesis
balance changed (which would mean the regex misfired on an unexpected shape).

Usage
-----
    python tools/kicad_lint.py PATH [PATH ...]        # report; exit 1 if issues
    python tools/kicad_lint.py PATH --fix             # trim in place
    python tools/kicad_lint.py PATH --fix --backup    # write <file>.bak first
    python tools/kicad_lint.py PATH --json            # machine-readable report

PATH may be a file or a directory (directories are walked). Backup files (``*.bak``),
``*-backups`` folders and ``.history`` folders are skipped by default.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

# Make the package importable when run as a bare script from anywhere.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from easyeda2kicad.kicad.kicad_text_normalize import (  # noqa: E402
    find_property_whitespace,
    strip_property_whitespace,
)

KICAD_SUFFIXES = (".kicad_sch", ".kicad_pcb", ".kicad_sym", ".kicad_mod")
_SKIP_DIR_SUFFIXES = ("-backups",)
_SKIP_DIR_NAMES = {".history", ".git"}

# Same property head the normalizer trims, used here to locate collisions.
_PROPERTY_KEY_RE = re.compile(r'\(property\s+"([^"]*)"')
# Top-level container heads, to scope the collision check to one symbol/footprint.
_CONTAINER_RE = re.compile(r'\(\s*(symbol|footprint)\s+"')


@dataclass
class Issue:
    kind: str          # "property-whitespace" | "property-collision" | "encoding"
    detail: str        # human-readable description
    field: str = ""    # the offending field name, when applicable


@dataclass
class FileReport:
    path: Path
    issues: list[Issue] = field(default_factory=list)
    fixed: int = 0          # number of whitespace fields trimmed (when --fix)
    backed_up: Path | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return not self.issues and self.error is None


def iter_kicad_files(paths: Iterable[Path]) -> list[Path]:
    """Expand the given files/directories into the KiCad files to scan, sorted,
    skipping backup and editor-history locations."""
    out: list[Path] = []
    seen: set[Path] = set()

    def _consider(p: Path) -> None:
        rp = p.resolve()
        if rp in seen:
            return
        if p.suffix in KICAD_SUFFIXES and p.name.endswith(".bak") is False:
            seen.add(rp)
            out.append(p)

    for raw in paths:
        if raw.is_file():
            _consider(raw)
            continue
        if not raw.is_dir():
            continue
        for child in raw.rglob("*"):
            if child.is_dir():
                continue
            parts = set(child.parts)
            if parts & _SKIP_DIR_NAMES:
                continue
            if any(
                seg.endswith(_SKIP_DIR_SUFFIXES) for seg in child.parts
            ):
                continue
            _consider(child)
    out.sort()
    return out


def _find_property_collisions(text: str) -> list[str]:
    """Property names that collide *after* trimming, within the same top-level
    container. Trimming such a pair would merge two distinct fields, so these are
    reported for a human rather than auto-fixed."""
    collisions: list[str] = []
    container_starts = [m.start() for m in _CONTAINER_RE.finditer(text)]
    if not container_starts:
        spans = [(0, len(text))]
    else:
        bounds = container_starts + [len(text)]
        spans = list(zip(bounds, bounds[1:]))
    for start, end in spans:
        block = text[start:end]
        names = [m.group(1) for m in _PROPERTY_KEY_RE.finditer(block)]
        trimmed = Counter(n.strip() for n in names)
        for raw_name in names:
            t = raw_name.strip()
            # Collision only matters when trimming actually changes a name AND the
            # trimmed form already exists as a separate field.
            if raw_name != t and trimmed[t] > 1 and t not in collisions:
                collisions.append(t)
    return collisions


def scan_text(text: str) -> list[Issue]:
    """Pure-string analysis used by both the file scan and the tests."""
    issues: list[Issue] = []
    for w in find_property_whitespace(text):
        kind = w["kind"]
        issues.append(
            Issue(
                kind="property-whitespace",
                field=w["field"],
                detail=f'field "{w["field"]}" has whitespace in its {kind}',
            )
        )
    for name in _find_property_collisions(text):
        issues.append(
            Issue(
                kind="property-collision",
                field=name,
                detail=(
                    f'field "{name}" exists both with and without edge whitespace '
                    "— trimming would merge them; resolve by hand"
                ),
            )
        )
    return issues


def fix_text(text: str) -> tuple[str, int]:
    """Return ``(cleaned_text, fields_trimmed)``. Never merges colliding fields:
    if trimming would collapse two names into one, that container is left as-is
    is *not* attempted here — collisions are surfaced by :func:`scan_text` and
    must be resolved by a human first."""
    trimmed = len(
        [w for w in find_property_whitespace(text) if w["kind"] != "collision"]
    )
    return strip_property_whitespace(text), trimmed


def scan_file(path: Path) -> FileReport:
    report = FileReport(path=path)
    try:
        data = path.read_bytes()
    except OSError as exc:
        report.error = f"cannot read: {exc}"
        return report
    if data[:3] == b"\xef\xbb\xbf":
        report.issues.append(
            Issue(kind="encoding", detail="file carries a UTF-8 BOM (KiCad writes none)")
        )
        data = data[3:]
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        report.issues.append(Issue(kind="encoding", detail=f"not valid UTF-8: {exc}"))
        return report
    report.issues.extend(scan_text(text))
    return report


def fix_file(path: Path, *, backup: bool = False) -> FileReport:
    """Scan, then trim property whitespace in place (EOL-preserving). Collisions
    block the fix for the whole file so a human can resolve them first."""
    report = scan_file(path)
    if report.error:
        return report
    collisions = [i for i in report.issues if i.kind == "property-collision"]
    if collisions:
        return report  # refuse to touch a file with ambiguous field merges
    try:
        raw = path.read_bytes()
    except OSError as exc:
        report.error = f"cannot read: {exc}"
        return report
    had_bom = raw[:3] == b"\xef\xbb\xbf"
    body = raw[3:] if had_bom else raw
    text = body.decode("utf-8")
    cleaned, trimmed = fix_text(text)
    if cleaned == text:
        return report  # nothing to do
    # Safety: trimming only removes whitespace inside quotes; structure is invariant.
    if cleaned.count("(") != text.count("(") or cleaned.count(")") != text.count(")"):
        report.error = "aborted: paren balance changed (regex misfired) — file untouched"
        return report
    if backup:
        bak = path.with_name(path.name + ".bak")
        bak.write_bytes(raw)
        report.backed_up = bak
    path.write_bytes(cleaned.encode("utf-8"))  # drops the BOM if there was one
    report.fixed = trimmed
    return report


def _print_report(reports: list[FileReport], *, fixing: bool) -> None:
    total_issues = 0
    total_fixed = 0
    for r in reports:
        rel = r.path
        if r.error:
            print(f"  ERROR  {rel}: {r.error}")
            continue
        if not r.issues:
            continue
        total_issues += len(r.issues)
        print(f"\n{rel}")
        by_kind: Counter[str] = Counter(i.kind for i in r.issues)
        for kind, n in by_kind.items():
            print(f"  {n:>4} × {kind}")
        # show the distinct offending fields once
        fields = sorted({i.field for i in r.issues if i.field})
        for f in fields:
            print(f"        · {f!r}")
        if fixing and r.fixed:
            total_fixed += r.fixed
            extra = f"  (backup: {r.backed_up.name})" if r.backed_up else ""
            print(f"  FIXED  trimmed {r.fixed} field(s){extra}")
    print()
    scanned = len(reports)
    if total_issues == 0:
        print(f"✓ {scanned} file(s) scanned — clean.")
    elif fixing:
        print(f"Fixed {total_fixed} field(s); {total_issues} issue(s) found across {scanned} file(s).")
    else:
        print(f"✗ {total_issues} issue(s) found across {scanned} file(s). Re-run with --fix to trim.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Lint/fix KiCad property hygiene.")
    parser.add_argument("paths", nargs="+", type=Path, help="files or directories")
    parser.add_argument("--fix", action="store_true", help="trim whitespace in place")
    parser.add_argument("--backup", action="store_true", help="with --fix, write <file>.bak first")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args(argv)

    files = iter_kicad_files(args.paths)
    if not files:
        print("No KiCad files found.", file=sys.stderr)
        return 2

    reports = [fix_file(f, backup=args.backup) if args.fix else scan_file(f) for f in files]

    if args.json:
        payload = [
            {
                "path": str(r.path),
                "error": r.error,
                "fixed": r.fixed,
                "backup": str(r.backed_up) if r.backed_up else None,
                "issues": [
                    {"kind": i.kind, "field": i.field, "detail": i.detail}
                    for i in r.issues
                ],
            }
            for r in reports
        ]
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        _print_report(reports, fixing=args.fix)

    any_unfixed = any(
        r.error or (not args.fix and r.issues) or
        (args.fix and any(i.kind == "property-collision" for i in r.issues))
        for r in reports
    )
    return 1 if any_unfixed else 0


if __name__ == "__main__":
    raise SystemExit(main())
