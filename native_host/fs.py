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
import sys
from pathlib import Path
from typing import Any


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
    parent_dir = prefix.parent
    parent_exists = parent_dir.is_dir()
    return {
        "path": str(prefix),
        "symbolPath": str(symbol_path),
        "prettyPath": str(pretty_dir),
        "exists": symbol_path.exists(),
        "symbol": {"exists": symbol_path.is_file()},
        "footprintDir": {"exists": pretty_dir.is_dir()},
        "writable": os.access(str(parent_dir), os.W_OK) if parent_exists else False,
        "parentExists": parent_exists,
    }
