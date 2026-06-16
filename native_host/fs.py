"""V3 Native Host FS verbs (Issue #24).

Filesystem RPCs used by the popup's library picker — `list_roots`,
`list_directory`, `check_path`, `validate_library`. In V2 these lived on
the WebSocket backend; in V3 the popup talks Native Messaging directly so
the verbs move into the Native Host (Q-PICK-1 in docs/ENTSCHEIDUNGEN.md,
ADR-0001 for the transport rationale).

Boundary: the resolver only answers for paths inside the *allowed roots*
— the union of `_default_roots()` (Documents, common KiCad library
locations) and the optional `extra_roots` list the caller passes in (the
extension persists user-added folders client-side). Anything outside the
whitelist raises `ValueError`. The picker therefore never lets the user
browse arbitrary disk locations without first explicitly adding the
parent as a root.

Q-PICK-1 (docs/ENTSCHEIDUNGEN.md, Runde 2) limits the MVP picker to a
flat dropdown: directories plus `.kicad_sym` files. A future slice
widens this to a full hierarchical file explorer.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any

from easyeda2kicad.helpers import extract_symbol_from_lib, list_symbols_in_lib
from easyeda2kicad.kicad.kicad_text_normalize import (
    find_property_whitespace,
    strip_property_whitespace,
)


def _expand(path: str | Path) -> Path:
    """Canonical absolute path — expand `~`, resolve symlinks where possible."""
    p = Path(path).expanduser()
    try:
        return p.resolve(strict=False)
    except OSError:
        return p.absolute()


def _default_root_candidates() -> list[tuple[str, Path]]:
    """Best-effort cross-platform default roots — Documents + KiCad install dir."""
    home = Path.home()
    candidates: list[tuple[str, Path]] = [
        ("Documents", home / "Documents"),
    ]
    if sys.platform.startswith("win"):
        candidates.append(("KiCad libraries", Path("C:/Program Files/KiCad")))
    elif sys.platform == "darwin":
        candidates.append(("KiCad libraries", Path("/Applications/KiCad")))
    else:
        candidates.append(("KiCad libraries", Path("/usr/share/kicad")))
    return candidates


def _default_roots() -> list[dict[str, str]]:
    """Roots every user gets without opt-in. Quiet on missing candidates."""
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for label, raw in _default_root_candidates():
        p = _expand(raw)
        if not p.exists() or not p.is_dir():
            continue
        key = str(p)
        if key in seen:
            continue
        seen.add(key)
        out.append({"path": key, "label": label, "kind": "default"})
    return out


def _normalize_extra(extra_roots: Any) -> list[dict[str, str]]:
    """Filter user-added roots to the directories that actually exist on disk."""
    if not isinstance(extra_roots, list):
        return []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in extra_roots:
        if not isinstance(raw, str) or not raw.strip():
            continue
        p = _expand(raw)
        if not p.exists() or not p.is_dir():
            continue
        key = str(p)
        if key in seen:
            continue
        seen.add(key)
        out.append({"path": key, "label": p.name or key, "kind": "user"})
    return out


def _allowed_paths(extra_roots: Any) -> list[Path]:
    """The whitelist used for boundary checks — default + user-added, deduped."""
    out: list[Path] = []
    seen: set[str] = set()
    for entry in _default_roots():
        if entry["path"] in seen:
            continue
        seen.add(entry["path"])
        out.append(Path(entry["path"]))
    for entry in _normalize_extra(extra_roots):
        if entry["path"] in seen:
            continue
        seen.add(entry["path"])
        out.append(Path(entry["path"]))
    return out


def _assert_inside(target: Path, allowed: list[Path]) -> None:
    """Raise `ValueError` when `target` is not equal to or under any allowed root.

    Both sides are canonicalised first so `..` traversal cannot escape the
    whitelist. The error message names the offending path so the SW can
    surface a helpful toast.
    """
    target_norm = _expand(target)
    for root in allowed:
        root_norm = _expand(root)
        try:
            target_norm.relative_to(root_norm)
            return
        except ValueError:
            continue
    raise ValueError(f"path outside allowed roots: {target!s}")


def _require_path(path: Any) -> Path:
    raw = path if isinstance(path, str) else ""
    candidate = raw.strip()
    if not candidate:
        raise ValueError("path is required")
    return _expand(candidate)


def _breadcrumbs(target: Path, allowed: list[Path]) -> list[dict[str, str]]:
    """Crumbs from the deepest containing allowed root down to `target`."""
    target_norm = _expand(target)
    best: tuple[Path, Path] | None = None
    for root in allowed:
        root_norm = _expand(root)
        try:
            rel = target_norm.relative_to(root_norm)
        except ValueError:
            continue
        if best is None or len(str(root_norm)) > len(str(best[0])):
            best = (root_norm, rel)
    if best is None:
        return []
    root, rel = best
    crumbs: list[dict[str, str]] = [{"name": root.name or str(root), "path": str(root)}]
    accum = root
    for part in rel.parts:
        accum = accum / part
        crumbs.append({"name": part, "path": str(accum)})
    return crumbs


def list_roots(extra_roots: Any = None) -> dict[str, Any]:
    """Return the picker root list — defaults + user-added folders.

    Args:
        extra_roots: Optional list of paths the user has explicitly added
            (the extension persists this list client-side and passes it in
            on every call). Non-existent or non-directory entries are
            silently dropped.

    Returns:
        ``{"roots": [{"path": str, "label": str, "kind": "default"|"user"}, ...]}``.
    """
    roots = _default_roots()
    seen = {entry["path"] for entry in roots}
    for entry in _normalize_extra(extra_roots):
        if entry["path"] in seen:
            continue
        roots.append(entry)
        seen.add(entry["path"])
    return {"roots": roots}


def list_directory(path: Any, extra_roots: Any = None) -> dict[str, Any]:
    """List one directory's child folders and `.kicad_sym` files.

    Q-PICK-1 limits the MVP picker to a flat folder/file dropdown — entries
    are filtered to directories plus `.kicad_sym` files (the symbol-layer
    sentinel for a KiCad library). A future slice can widen this to a full
    file explorer when the broader picker UX lands.

    Args:
        path: Directory to list. Must be inside an allowed root.
        extra_roots: Optional user-added roots (see `list_roots`).

    Returns:
        ``{"path", "parent", "breadcrumbs", "entries": [{"name", "path", "type"}, ...]}``.
        ``parent`` is empty when the parent dir would escape the whitelist.

    Raises:
        ValueError: when `path` is empty, outside the allowed roots, or not
            a readable directory.
    """
    target = _require_path(path)
    allowed = _allowed_paths(extra_roots)
    _assert_inside(target, allowed)
    if not target.is_dir():
        raise ValueError(f"not a directory: {target!s}")
    try:
        children = sorted(
            target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())
        )
    except PermissionError as exc:
        raise ValueError(f"cannot read directory: {exc}") from exc
    entries: list[dict[str, str]] = []
    for child in children:
        try:
            if child.is_dir():
                entries.append(
                    {"name": child.name, "path": str(child), "type": "dir"}
                )
            elif child.is_file() and child.suffix == ".kicad_sym":
                entries.append(
                    {"name": child.name, "path": str(child), "type": "file"}
                )
        except OSError:
            # Broken symlink or transient permission error — skip the entry.
            continue
    parent = target.parent
    parent_str = ""
    if parent != target:
        try:
            _assert_inside(parent, allowed)
            parent_str = str(parent)
        except ValueError:
            parent_str = ""
    return {
        "path": str(target),
        "parent": parent_str,
        "breadcrumbs": _breadcrumbs(target, allowed),
        "entries": entries,
    }


def check_path(path: Any, extra_roots: Any = None) -> dict[str, Any]:
    """Existence + writability snapshot for an arbitrary picker path.

    Returns shape: ``{"path", "exists", "isDir", "isFile", "writable"}``.
    ``writable`` falls back to the parent directory when the target itself
    does not yet exist (a brand-new library prefix the user is about to
    create) — matches the picker's intent of "can I write here".
    """
    target = _require_path(path)
    allowed = _allowed_paths(extra_roots)
    _assert_inside(target, allowed)
    exists = target.exists()
    return {
        "path": str(target),
        "exists": exists,
        "isDir": target.is_dir(),
        "isFile": target.is_file(),
        "writable": os.access(
            str(target if exists else target.parent), os.W_OK
        ),
    }


def validate_library(path: Any, extra_roots: Any = None) -> dict[str, Any]:
    """Validate that `path` looks like a KiCad library prefix.

    Accepts either a bare prefix (``/foo/bar/MyLib``) or the symbol file
    itself (``/foo/bar/MyLib.kicad_sym``). The library may not exist yet —
    the popup uses this verb both to vet existing libs and to greenlight a
    newly-typed prefix before scaffolding writes the files. The verb
    therefore requires only the *parent directory* to be inside the
    allowed roots, not the prefix itself.

    Returns:
        ``{"path", "symbolPath", "prettyPath", "exists", "symbol", "footprintDir",
           "writable", "parentExists"}`` — the popup uses ``exists`` for the
        "library already present" badge, ``writable`` to enable the Active
        Library button, and the layer dicts to render symbol/footprint
        indicators.
    """
    target = _require_path(path)
    if target.suffix == ".kicad_sym":
        prefix = target.with_suffix("")
    else:
        prefix = target
    allowed = _allowed_paths(extra_roots)
    _assert_inside(prefix.parent, allowed)
    symbol_path = prefix.with_suffix(".kicad_sym")
    pretty_dir = prefix.with_suffix(".pretty")
    model_dir = prefix.with_suffix(".3dshapes")
    parent_dir = prefix.parent
    parent_exists = parent_dir.is_dir()
    # Read-only whitespace report (only when the symbol file exists; the popup
    # also calls this verb to greenlight a not-yet-created prefix). ``cleanLibrary``
    # is the opt-in fix that acts on what this surfaces.
    whitespace_symbols = (
        _scan_symbol_whitespace(symbol_path) if symbol_path.is_file() else []
    )
    counts = _count_library_assets(symbol_path, pretty_dir, model_dir)
    return {
        "path": str(prefix),
        "symbolPath": str(symbol_path),
        "prettyPath": str(pretty_dir),
        "modelDir": str(model_dir),
        "exists": symbol_path.exists(),
        "symbol": {"exists": symbol_path.is_file()},
        "footprintDir": {"exists": pretty_dir.is_dir()},
        "counts": counts,
        "assets": {
            "symbol": counts["symbol"] > 0,
            "footprint": counts["footprint"] > 0,
            "model": counts["model"] > 0,
        },
        "writable": os.access(str(parent_dir), os.W_OK) if parent_exists else False,
        "parentExists": parent_exists,
        "whitespace": {
            "clean": not whitespace_symbols,
            "symbols": whitespace_symbols,
        },
    }


def _count_library_assets(
    symbol_path: Path, pretty_dir: Path, model_dir: Path
) -> dict[str, int]:
    """Count symbols / footprints / 3D models for the popup inventory display.

    Replaces the per-library counts the V2 ``libraries_validate`` WS endpoint
    used to return. Quiet on read errors (a layer that can't be read counts 0).
    """
    symbol = 0
    if symbol_path.is_file():
        try:
            symbol = len(list_symbols_in_lib(str(symbol_path)))
        except OSError:
            symbol = 0
    footprint = 0
    if pretty_dir.is_dir():
        try:
            footprint = sum(
                1 for p in pretty_dir.iterdir()
                if p.suffix == ".kicad_mod" and p.is_file()
            )
        except OSError:
            footprint = 0
    model = 0
    if model_dir.is_dir():
        try:
            model = sum(
                1 for p in model_dir.iterdir()
                if p.is_file() and p.suffix.lower() in (".wrl", ".step", ".stp")
            )
        except OSError:
            model = 0
    return {"symbol": symbol, "footprint": footprint, "model": model}


def library_component(
    path: Any, lcsc_id: Any, extra_roots: Any = None
) -> dict[str, Any]:
    """V3 component-presence check (replaces the V2 WS ``libraries_component``).

    Offline: scans the symbol library for a top-level symbol carrying
    ``(property "LCSC Part" "<lcscId>")`` — the LCSC id every imported symbol
    records — so "does this part already exist here?" needs no EasyEDA fetch.

    ``path`` may be a bare prefix or the ``.kicad_sym`` file. Returns
    ``{symbol_path, footprint_path, model_paths, messages}`` matching the shape
    ``buildComponentStatus`` consumes (``symbol_path`` set ⇒ present). When the
    matched symbol names a footprint that exists in the sibling ``.pretty``,
    ``footprint_path`` is filled too.

    Raises:
        ValueError: on missing/invalid ``lcsc_id`` or a path outside the roots.
    """
    target = _require_path(path)
    symbol_path = (
        target if target.suffix == ".kicad_sym" else target.with_suffix(".kicad_sym")
    )
    allowed = _allowed_paths(extra_roots)
    _assert_inside(symbol_path.parent, allowed)
    lcsc = lcsc_id.strip().upper() if isinstance(lcsc_id, str) else ""
    if not lcsc:
        raise ValueError("lcscId is required")

    empty = {
        "symbol_path": None,
        "footprint_path": None,
        "model_paths": {},
        "messages": [],
    }
    if not symbol_path.is_file():
        return empty

    sp = str(symbol_path)
    matched_block: str | None = None
    for name in list_symbols_in_lib(sp):
        block = extract_symbol_from_lib(sp, name)
        if not block:
            continue
        m = re.search(r'\(property\s+"LCSC Part"\s+"([^"]*)"', block)
        if m and m.group(1).strip().upper() == lcsc:
            matched_block = block
            break
    if matched_block is None:
        return empty

    footprint_path = None
    fpm = re.search(r'\(property\s+"Footprint"\s+"([^"]*)"', matched_block)
    if fpm:
        fp_ref = fpm.group(1).strip()
        fp_name = fp_ref.split(":", 1)[1] if ":" in fp_ref else fp_ref
        if fp_name:
            candidate = symbol_path.with_suffix(".pretty") / f"{fp_name}.kicad_mod"
            if candidate.is_file():
                footprint_path = str(candidate)
    return {
        "symbol_path": sp,
        "footprint_path": footprint_path,
        "model_paths": {},
        "messages": [],
    }


def _top_level_symbol_names(content: str) -> list[str]:
    """Top-level symbol names from raw library text (mirrors
    ``helpers.list_symbols_in_lib`` but works on an in-memory string so the
    cleanup safety check can compare before/after without disk round-trips)."""
    names = re.findall(r'\(symbol\s+"([^"]+)"', content)
    return [n for n in names if not re.search(r"_\d+_\d+$", n)]


def _scan_symbol_whitespace(symbol_path: Path) -> list[dict[str, Any]]:
    """Per-symbol report of property fields with leading/trailing whitespace.

    Read-only: walks each top-level symbol and collects the property fields
    :func:`find_property_whitespace` flags. Quiet on read errors (empty report)
    so it can ride along in ``validate_library`` without ever raising.
    """
    sp = str(symbol_path)
    out: list[dict[str, Any]] = []
    for name in list_symbols_in_lib(sp):
        block = extract_symbol_from_lib(sp, name)
        if not block:
            continue
        fields = find_property_whitespace(block)
        if fields:
            out.append({"symbol": name, "fields": fields})
    return out


def clean_library(path: Any, extra_roots: Any = None) -> dict[str, Any]:
    """Trim leading/trailing whitespace from every symbol property in a library.

    Opt-in counterpart to ``validate_library``'s read-only ``whitespace`` report.
    ``path`` may be a bare prefix or the ``.kicad_sym`` file. Flow:

    1. Resolve + whitelist-check the symbol file's parent (same boundary as the
       other FS verbs).
    2. Strip the whole file with :func:`strip_property_whitespace`.
    3. No-op fast path when nothing changes.
    4. Safety re-validation — trimming only removes whitespace *inside* quoted
       property text, so the parenthesis balance and the top-level symbol set
       must be invariant; if either changed the regex misfired on an unexpected
       file shape, so we refuse to write and raise (nothing on disk is touched).
    5. Back the original up to ``<file>.bak`` then write the cleaned content.

    Returns ``{"symbolPath", "changed", "symbols", "backup"}`` where ``changed``
    is the number of property fields trimmed.
    """
    target = _require_path(path)
    symbol_path = (
        target if target.suffix == ".kicad_sym" else target.with_suffix(".kicad_sym")
    )
    allowed = _allowed_paths(extra_roots)
    _assert_inside(symbol_path.parent, allowed)
    if not symbol_path.is_file():
        raise ValueError(f"symbol library not found: {symbol_path!s}")

    before = symbol_path.read_text(encoding="utf-8")
    after = strip_property_whitespace(before)
    changed = len(find_property_whitespace(before))
    affected = _scan_symbol_whitespace(symbol_path)

    if after == before:
        return {
            "symbolPath": str(symbol_path),
            "changed": 0,
            "symbols": [],
            "backup": None,
        }

    if before.count("(") != after.count("(") or before.count(")") != after.count(")"):
        raise ValueError(
            "whitespace cleanup changed the parenthesis balance; aborted, file untouched"
        )
    if _top_level_symbol_names(before) != _top_level_symbol_names(after):
        raise ValueError(
            "whitespace cleanup altered the symbol set; aborted, file untouched"
        )

    backup_path = symbol_path.parent / (symbol_path.name + ".bak")
    backup_path.write_text(before, encoding="utf-8")
    symbol_path.write_text(after, encoding="utf-8")
    return {
        "symbolPath": str(symbol_path),
        "changed": changed,
        "symbols": affected,
        "backup": str(backup_path),
    }


def scaffold_library(
    base_path: Any,
    name: Any,
    symbol: bool = True,
    footprint: bool = True,
    model: bool = False,
    extra_roots: Any = None,
) -> dict[str, Any]:
    """Create an empty KiCad library under an allowed root.

    Writes ``<base>/<name>.kicad_sym`` (empty symbol-lib header) plus the
    ``.pretty`` (and, when requested, ``.3dshapes``) sibling directories. The
    base folder must be inside the allowed roots (Q-PICK-1). Idempotent: an
    existing symbol file is left untouched so re-scaffolding never clobbers a
    populated library. Mirrors ``service.conversion._ensure_output_scaffold``
    but stands alone so the popup can create a target before the first import.

    Returns the camelCase shape the SW's ``handleCreateLibrary`` consumes.
    """
    base = _require_path(base_path)
    lib_name = name.strip() if isinstance(name, str) else ""
    if not lib_name:
        raise ValueError("library name is required")
    if any(sep in lib_name for sep in ("/", "\\")) or lib_name in (".", ".."):
        raise ValueError(f"invalid library name: {lib_name!r}")
    allowed = _allowed_paths(extra_roots)
    _assert_inside(base, allowed)
    if not base.is_dir():
        raise ValueError(f"base folder is not a directory: {base!s}")

    prefix = base / lib_name
    symbol_path = prefix.with_suffix(".kicad_sym")
    pretty_dir = prefix.with_suffix(".pretty")
    model_dir = prefix.with_suffix(".3dshapes")
    try:
        if footprint:
            pretty_dir.mkdir(exist_ok=True)
        if model or footprint:
            model_dir.mkdir(exist_ok=True)
        if symbol and not symbol_path.exists():
            symbol_path.write_text(
                "(kicad_symbol_lib\n"
                "  (version 20211014)\n"
                "  (generator https://github.com/theautomatist/KiCad-Parts-Importer)\n"
                ")\n",
                encoding="utf-8",
            )
    except PermissionError as exc:
        raise ValueError(f"cannot create library under {base!s}: {exc}") from exc

    return {
        "resolvedLibraryPrefix": str(prefix),
        "symbolPath": str(symbol_path) if symbol else "",
        "footprintDir": str(pretty_dir) if footprint else "",
        "modelDir": str(model_dir) if (model or footprint) else "",
        "exists": symbol_path.is_file(),
    }
