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
  identical once trimmed (a trailing-space orphan left behind when KiCad's
  Update-from-Library renamed the clean twin but kept the old field). Plain
  ``--fix`` refuses these (a trim would merge them); ``--dedupe`` removes the
  orphan, keeping the clean twin.
* ``encoding`` — file is not valid UTF-8, or carries a UTF-8 BOM (report only).

Fixing is EOL-preserving: the file is read and written as bytes and only the text
*inside* the quoted property strings is touched, so CRLF/LF and everything else
survive byte-for-byte. A safety re-check refuses to write if the parenthesis
balance changed (which would mean the regex misfired on an unexpected shape).

Usage
-----
    python tools/kicad_lint.py PATH [PATH ...]        # report; exit 1 if issues
    python tools/kicad_lint.py PATH --fix             # trim whitespace in place
    python tools/kicad_lint.py PATH --fix --dedupe    # also remove orphan-twin fields
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
    removed: int = 0        # number of orphan property blocks removed (when --dedupe)
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


def _balanced_end(text: str, open_idx: int) -> int:
    """Index just past the ``)`` that closes the ``(`` at ``open_idx`` (quote-aware).
    Returns -1 if unbalanced."""
    depth = 0
    i = open_idx
    in_str = False
    while i < len(text):
        c = text[i]
        if c == '"' and not (i > 0 and text[i - 1] == "\\"):
            in_str = not in_str
        elif not in_str:
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    return i + 1
        i += 1
    return -1


def _remove_named_property_blocks(text: str, raw_name: str) -> tuple[str, int]:
    """Remove every ``(property "raw_name" …)`` block (with its line indent and
    trailing newline) so no blank line is left behind. EOL-agnostic."""
    needle = '(property "' + raw_name + '"'
    removed = 0
    while True:
        pos = text.find(needle)
        if pos == -1:
            break
        end = _balanced_end(text, pos)
        if end == -1:
            break  # malformed — leave the rest untouched
        # Swallow the leading indentation on the property's own line…
        line_start = text.rfind("\n", 0, pos) + 1
        start = line_start if text[line_start:pos].strip() == "" else pos
        # …and the trailing newline (CRLF or LF) after the closing paren.
        if text[end : end + 2] == "\r\n":
            end += 2
        elif end < len(text) and text[end] == "\n":
            end += 1
        text = text[:start] + text[end:]
        removed += 1
    return text, removed


def dedupe_text(text: str) -> tuple[str, int, int]:
    """Resolve whitespace/clean property collisions, then trim the rest.

    Returns ``(new_text, removed, trimmed)``.

    KiCad matches symbol fields by NAME. When a library field is renamed (e.g. a
    trailing space stripped), KiCad does NOT rename it on already-placed instances
    — it adds the clean-named field alongside the old one, orphaning the
    whitespace-named copy. ``--fix`` (strip) cannot help: stripping would collapse
    the two into a duplicate. ``--dedupe`` removes the orphan whose stripped name
    already exists *as a clean field at least as often* (so an orphan without a
    clean twin is never silently dropped — it falls through to a plain trim).
    """
    names = re.findall(r'\(property\s+"([^"]*)"', text)
    clean_counts = Counter(n for n in names if n == n.strip())
    orphan_raw = sorted({n for n in names if n != n.strip()})
    removed = 0
    for raw in orphan_raw:
        stripped = raw.strip()
        orphan_count = sum(1 for n in names if n == raw)
        # Only drop the orphan when a clean twin exists in at least equal number.
        if clean_counts.get(stripped, 0) >= orphan_count:
            text, n = _remove_named_property_blocks(text, raw)
            removed += n
    # Anything still carrying edge whitespace had no clean twin → plain trim.
    trimmed = len(find_property_whitespace(text))
    text = strip_property_whitespace(text)
    return text, removed, trimmed


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


def fix_file(path: Path, *, backup: bool = False, dedupe: bool = False) -> FileReport:
    """Scan, then clean property whitespace in place (EOL-preserving).

    Default (``dedupe=False``): plain trim; a file with a whitespace/clean
    collision is refused so a human resolves the ambiguous merge first.
    ``dedupe=True``: first remove orphaned whitespace-named fields that have a
    clean twin, then trim the rest — so collisions are resolved, not refused.
    """
    report = scan_file(path)
    if report.error:
        return report
    collisions = [i for i in report.issues if i.kind == "property-collision"]
    if collisions and not dedupe:
        return report  # refuse to touch a file with ambiguous field merges
    try:
        raw = path.read_bytes()
    except OSError as exc:
        report.error = f"cannot read: {exc}"
        return report
    had_bom = raw[:3] == b"\xef\xbb\xbf"
    body = raw[3:] if had_bom else raw
    text = body.decode("utf-8")

    if dedupe:
        cleaned, removed, trimmed = dedupe_text(text)
        if cleaned == text:
            return report  # nothing to do
        # Removal deletes whole balanced (property …) blocks, so the paren count
        # drops — but the file must stay globally balanced, and only property
        # declarations may disappear (count drops by exactly `removed`).
        if cleaned.count("(") - cleaned.count(")") != 0:
            report.error = "aborted: result not paren-balanced — file untouched"
            return report
        before_props = text.count("(property ")
        after_props = cleaned.count("(property ")
        if before_props - after_props != removed:
            report.error = "aborted: removed more than the orphan blocks — file untouched"
            return report
        report.removed = removed
        report.fixed = trimmed
    else:
        cleaned, trimmed = fix_text(text)
        if cleaned == text:
            return report  # nothing to do
        # Trim only removes whitespace inside quotes; structure is invariant.
        if cleaned.count("(") != text.count("(") or cleaned.count(")") != text.count(")"):
            report.error = "aborted: paren balance changed (regex misfired) — file untouched"
            return report
        report.fixed = trimmed

    if backup:
        bak = path.with_name(path.name + ".bak")
        bak.write_bytes(raw)
        report.backed_up = bak
    path.write_bytes(cleaned.encode("utf-8"))  # drops the BOM if there was one
    return report


def _print_report(reports: list[FileReport], *, fixing: bool) -> None:
    total_issues = 0
    total_fixed = 0
    total_removed = 0
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
        if fixing and (r.fixed or r.removed):
            total_fixed += r.fixed
            total_removed += r.removed
            extra = f"  (backup: {r.backed_up.name})" if r.backed_up else ""
            bits = []
            if r.removed:
                bits.append(f"removed {r.removed} orphan field(s)")
            if r.fixed:
                bits.append(f"trimmed {r.fixed} field(s)")
            print(f"  FIXED  {', '.join(bits)}{extra}")
    print()
    scanned = len(reports)
    if total_issues == 0:
        print(f"✓ {scanned} file(s) scanned — clean.")
    elif fixing:
        print(
            f"Removed {total_removed} orphan field(s), trimmed {total_fixed} field(s); "
            f"{total_issues} issue(s) found across {scanned} file(s)."
        )
    else:
        print(f"✗ {total_issues} issue(s) found across {scanned} file(s). Re-run with --fix to trim.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Lint/fix KiCad property hygiene.")
    parser.add_argument("paths", nargs="+", type=Path, help="files or directories")
    parser.add_argument("--fix", action="store_true", help="trim whitespace in place")
    parser.add_argument(
        "--dedupe",
        action="store_true",
        help="with --fix, also remove orphan whitespace-named fields that have a clean twin",
    )
    parser.add_argument("--backup", action="store_true", help="with --fix, write <file>.bak first")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args(argv)

    fixing = args.fix or args.dedupe

    files = iter_kicad_files(args.paths)
    if not files:
        print("No KiCad files found.", file=sys.stderr)
        return 2

    reports = [
        fix_file(f, backup=args.backup, dedupe=args.dedupe) if fixing else scan_file(f)
        for f in files
    ]

    if args.json:
        payload = [
            {
                "path": str(r.path),
                "error": r.error,
                "fixed": r.fixed,
                "removed": r.removed,
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
        _print_report(reports, fixing=fixing)

    # A report's issues come from the PRE-fix scan. With --dedupe a collision is
    # resolved (the file was rewritten), so it no longer counts as unfixed; a
    # plain --fix still leaves collisions unfixed by design.
    def _unfixed(r: FileReport) -> bool:
        if r.error:
            return True
        if not fixing:
            return bool(r.issues)
        if args.dedupe:
            return False  # collisions resolved; whitespace trimmed
        return any(i.kind == "property-collision" for i in r.issues)

    return 1 if any(_unfixed(r) for r in reports) else 0


if __name__ == "__main__":
    raise SystemExit(main())
