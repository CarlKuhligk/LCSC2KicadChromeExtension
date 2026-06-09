"""Tests for native_host.fs — V3 picker FS verbs (Issue #24).

The picker calls `fsRoots`, `fsList`, `fsCheck`, `validateLibrary` via
Native Messaging. The allowed-roots whitelist (Q-PICK-1) is the security
contract — every test here pins one boundary case so a regression that
widens access fails loudly.

Real platform-default roots (Documents, /usr/share/kicad) are dodged in
favour of `tmp_path` to keep the suite hermetic; the platform-defaults
branch gets one dedicated test that only asserts shape.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from native_host import fs, host


# ---------------------------------------------------------------------------
# list_roots
# ---------------------------------------------------------------------------


def test_list_roots_returns_dict_with_roots_list() -> None:
    result = fs.list_roots(None)
    assert isinstance(result, dict)
    assert "roots" in result
    assert isinstance(result["roots"], list)
    for entry in result["roots"]:
        assert entry["kind"] == "default"


def test_list_roots_includes_user_added_directory(tmp_path: Path) -> None:
    user_dir = tmp_path / "my-libs"
    user_dir.mkdir()
    result = fs.list_roots([str(user_dir)])
    paths = {entry["path"]: entry for entry in result["roots"]}
    assert str(user_dir.resolve()) in paths
    assert paths[str(user_dir.resolve())]["kind"] == "user"


def test_list_roots_drops_nonexistent_user_paths(tmp_path: Path) -> None:
    phantom = tmp_path / "does-not-exist"
    result = fs.list_roots([str(phantom)])
    for entry in result["roots"]:
        assert entry["path"] != str(phantom.resolve())


def test_list_roots_drops_user_paths_that_are_files(tmp_path: Path) -> None:
    f = tmp_path / "file.kicad_sym"
    f.write_text("(kicad_symbol_lib)", encoding="utf-8")
    result = fs.list_roots([str(f)])
    for entry in result["roots"]:
        assert entry["path"] != str(f.resolve())


def test_list_roots_dedupes_when_user_path_matches_default() -> None:
    home = Path.home()
    if not home.is_dir():
        pytest.skip("home dir missing")
    result = fs.list_roots([str(home)])
    paths = [entry["path"] for entry in result["roots"]]
    # Should not have the same path twice in the list.
    assert len(paths) == len(set(paths))


def test_list_roots_ignores_non_list_extra_roots() -> None:
    # SW could mis-encode; verb must not crash.
    result = fs.list_roots("not a list")  # type: ignore[arg-type]
    assert isinstance(result["roots"], list)


# ---------------------------------------------------------------------------
# list_directory — boundary enforcement
# ---------------------------------------------------------------------------


def test_list_directory_lists_dirs_and_kicad_sym_files(tmp_path: Path) -> None:
    (tmp_path / "subdir").mkdir()
    (tmp_path / "Lib.kicad_sym").write_text("(kicad_symbol_lib)", encoding="utf-8")
    (tmp_path / "Lib.pretty").mkdir()
    (tmp_path / "README.txt").write_text("hi", encoding="utf-8")

    result = fs.list_directory(str(tmp_path), [str(tmp_path)])

    types = {entry["name"]: entry["type"] for entry in result["entries"]}
    # Dirs sorted first, then files; .txt is filtered out (MVP picker = dirs + .kicad_sym only).
    assert "subdir" in types and types["subdir"] == "dir"
    assert "Lib.pretty" in types and types["Lib.pretty"] == "dir"
    assert "Lib.kicad_sym" in types and types["Lib.kicad_sym"] == "file"
    assert "README.txt" not in types


def test_list_directory_rejects_path_outside_allowed_roots(tmp_path: Path) -> None:
    inside = tmp_path / "allowed"
    inside.mkdir()
    outside = tmp_path / "denied"
    outside.mkdir()

    with pytest.raises(ValueError, match="outside allowed roots"):
        fs.list_directory(str(outside), [str(inside)])


def test_list_directory_rejects_parent_traversal(tmp_path: Path) -> None:
    inside = tmp_path / "allowed"
    inside.mkdir()
    sibling = tmp_path / "denied"
    sibling.mkdir()

    # ``allowed/../denied`` canonicalises to ``denied`` which is NOT inside allowed.
    with pytest.raises(ValueError, match="outside allowed roots"):
        fs.list_directory(str(inside / ".." / "denied"), [str(inside)])


def test_list_directory_allows_descendant_of_allowed_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    nested = root / "child" / "grand"
    nested.mkdir(parents=True)
    (nested / "Lib.kicad_sym").write_text("()", encoding="utf-8")

    result = fs.list_directory(str(nested), [str(root)])
    names = [entry["name"] for entry in result["entries"]]
    assert names == ["Lib.kicad_sym"]


def test_list_directory_parent_is_empty_when_walking_up_escapes_whitelist(
    tmp_path: Path,
) -> None:
    root = tmp_path / "allowed"
    root.mkdir()
    result = fs.list_directory(str(root), [str(root)])
    # ``root``'s parent is ``tmp_path`` — outside the whitelist → parent suppressed.
    assert result["parent"] == ""


def test_list_directory_parent_is_present_for_nested_path(tmp_path: Path) -> None:
    root = tmp_path / "root"
    child = root / "child"
    child.mkdir(parents=True)
    result = fs.list_directory(str(child), [str(root)])
    assert result["parent"] == str(root.resolve())


def test_list_directory_breadcrumbs_descend_from_deepest_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    nested = root / "a" / "b"
    nested.mkdir(parents=True)
    result = fs.list_directory(str(nested), [str(root)])
    names = [crumb["name"] for crumb in result["breadcrumbs"]]
    assert names == ["root", "a", "b"]


def test_list_directory_breadcrumbs_pick_deepest_matching_root(tmp_path: Path) -> None:
    outer = tmp_path / "outer"
    inner = outer / "inner"
    inner.mkdir(parents=True)
    nested = inner / "child"
    nested.mkdir()
    result = fs.list_directory(str(nested), [str(outer), str(inner)])
    # Deepest matching root wins so the breadcrumbs aren't bloated by ``outer``.
    names = [crumb["name"] for crumb in result["breadcrumbs"]]
    assert names == ["inner", "child"]


def test_list_directory_empty_path_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="path is required"):
        fs.list_directory("", [str(tmp_path)])


def test_list_directory_rejects_when_target_is_a_file(tmp_path: Path) -> None:
    f = tmp_path / "Lib.kicad_sym"
    f.write_text("()", encoding="utf-8")
    with pytest.raises(ValueError, match="not a directory"):
        fs.list_directory(str(f), [str(tmp_path)])


# ---------------------------------------------------------------------------
# check_path
# ---------------------------------------------------------------------------


def test_check_path_existing_directory(tmp_path: Path) -> None:
    sub = tmp_path / "sub"
    sub.mkdir()
    result = fs.check_path(str(sub), [str(tmp_path)])
    assert result["exists"] is True
    assert result["isDir"] is True
    assert result["isFile"] is False
    assert result["writable"] is True


def test_check_path_existing_file(tmp_path: Path) -> None:
    f = tmp_path / "Lib.kicad_sym"
    f.write_text("()", encoding="utf-8")
    result = fs.check_path(str(f), [str(tmp_path)])
    assert result["isFile"] is True
    assert result["isDir"] is False


def test_check_path_missing_path_uses_parent_writability(tmp_path: Path) -> None:
    missing = tmp_path / "future.kicad_sym"
    result = fs.check_path(str(missing), [str(tmp_path)])
    assert result["exists"] is False
    # tmp_path is writable so the picker can greenlight the future path.
    assert result["writable"] is True


def test_check_path_rejects_outside_whitelist(tmp_path: Path) -> None:
    allowed = tmp_path / "a"
    allowed.mkdir()
    denied = tmp_path / "b"
    denied.mkdir()
    with pytest.raises(ValueError, match="outside allowed roots"):
        fs.check_path(str(denied), [str(allowed)])


# ---------------------------------------------------------------------------
# validate_library
# ---------------------------------------------------------------------------


def test_validate_library_full_layout(tmp_path: Path) -> None:
    prefix = tmp_path / "MyLib"
    (tmp_path / "MyLib.kicad_sym").write_text("()", encoding="utf-8")
    (tmp_path / "MyLib.pretty").mkdir()

    result = fs.validate_library(str(prefix), [str(tmp_path)])

    assert result["exists"] is True
    assert result["symbol"]["exists"] is True
    assert result["footprintDir"]["exists"] is True
    assert result["writable"] is True
    assert result["parentExists"] is True
    assert result["symbolPath"].endswith("MyLib.kicad_sym")
    assert result["prettyPath"].endswith("MyLib.pretty")


def test_validate_library_accepts_kicad_sym_file_directly(tmp_path: Path) -> None:
    sym = tmp_path / "MyLib.kicad_sym"
    sym.write_text("()", encoding="utf-8")
    result = fs.validate_library(str(sym), [str(tmp_path)])
    assert result["exists"] is True
    # The reported prefix path strips the suffix even though the user typed the file.
    assert result["path"].endswith("MyLib")


def test_validate_library_for_not_yet_existing_prefix(tmp_path: Path) -> None:
    # New library prefix: parent dir is writable, lib files don't exist yet.
    prefix = tmp_path / "Future"
    result = fs.validate_library(str(prefix), [str(tmp_path)])
    assert result["exists"] is False
    assert result["symbol"]["exists"] is False
    assert result["footprintDir"]["exists"] is False
    assert result["writable"] is True
    assert result["parentExists"] is True


def test_validate_library_rejects_when_parent_outside_whitelist(tmp_path: Path) -> None:
    inside = tmp_path / "allowed"
    inside.mkdir()
    outside_prefix = tmp_path / "denied" / "Lib"
    outside_prefix.parent.mkdir()
    with pytest.raises(ValueError, match="outside allowed roots"):
        fs.validate_library(str(outside_prefix), [str(inside)])


def test_validate_library_empty_path_raises(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="path is required"):
        fs.validate_library("", [str(tmp_path)])


def test_scaffold_library_creates_symbol_and_dirs(tmp_path: Path) -> None:
    result = fs.scaffold_library(str(tmp_path), "NewLib", extra_roots=[str(tmp_path)])
    sym = tmp_path / "NewLib.kicad_sym"
    assert sym.is_file()
    assert (tmp_path / "NewLib.pretty").is_dir()
    assert (tmp_path / "NewLib.3dshapes").is_dir()
    assert result["exists"] is True
    assert result["resolvedLibraryPrefix"].endswith("NewLib")
    # Empty symbol-lib header, with our own generator string (not uPesy).
    head = sym.read_text(encoding="utf-8")
    assert head.startswith("(kicad_symbol_lib")
    assert "theautomatist/KiCad-Parts-Importer" in head


def test_scaffold_library_idempotent_does_not_clobber(tmp_path: Path) -> None:
    sym = tmp_path / "Keep.kicad_sym"
    sym.write_text("(kicad_symbol_lib PRECIOUS)", encoding="utf-8")
    fs.scaffold_library(str(tmp_path), "Keep", extra_roots=[str(tmp_path)])
    # An existing symbol file must survive a re-scaffold untouched.
    assert sym.read_text(encoding="utf-8") == "(kicad_symbol_lib PRECIOUS)"


def test_scaffold_library_rejects_base_outside_whitelist(tmp_path: Path) -> None:
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    denied = tmp_path / "denied"
    denied.mkdir()
    with pytest.raises(ValueError, match="outside allowed roots"):
        fs.scaffold_library(str(denied), "X", extra_roots=[str(allowed)])


def test_scaffold_library_rejects_name_with_separators(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="invalid library name"):
        fs.scaffold_library(str(tmp_path), "evil/../esc", extra_roots=[str(tmp_path)])


def test_scaffold_library_symbol_only(tmp_path: Path) -> None:
    fs.scaffold_library(
        str(tmp_path), "SymOnly", footprint=False, model=False, extra_roots=[str(tmp_path)]
    )
    assert (tmp_path / "SymOnly.kicad_sym").is_file()
    assert not (tmp_path / "SymOnly.pretty").exists()
    assert not (tmp_path / "SymOnly.3dshapes").exists()


# ---------------------------------------------------------------------------
# host.handle — RPC dispatcher branches
# ---------------------------------------------------------------------------


def test_host_dispatches_fs_roots_verb(tmp_path: Path) -> None:
    extra = tmp_path / "user-added"
    extra.mkdir()
    response = host.handle(
        {"id": 1, "verb": "fsRoots", "params": {"extraRoots": [str(extra)]}}
    )
    assert response["id"] == 1
    assert response["ok"] is True
    paths = {entry["path"] for entry in response["result"]["roots"]}
    assert str(extra.resolve()) in paths


def test_host_dispatches_fs_list_verb(tmp_path: Path) -> None:
    (tmp_path / "child").mkdir()
    response = host.handle(
        {
            "id": "list-1",
            "verb": "fsList",
            "params": {"path": str(tmp_path), "extraRoots": [str(tmp_path)]},
        }
    )
    assert response["ok"] is True
    names = [entry["name"] for entry in response["result"]["entries"]]
    assert "child" in names


def test_host_dispatches_fs_check_verb(tmp_path: Path) -> None:
    response = host.handle(
        {
            "id": "chk",
            "verb": "fsCheck",
            "params": {"path": str(tmp_path), "extraRoots": [str(tmp_path)]},
        }
    )
    assert response["ok"] is True
    assert response["result"]["exists"] is True


def test_host_dispatches_validate_library_verb(tmp_path: Path) -> None:
    sym = tmp_path / "Lib.kicad_sym"
    sym.write_text("()", encoding="utf-8")
    response = host.handle(
        {
            "id": 7,
            "verb": "validateLibrary",
            "params": {
                "path": str(tmp_path / "Lib"),
                "extraRoots": [str(tmp_path)],
            },
        }
    )
    assert response["ok"] is True
    assert response["result"]["exists"] is True
    assert response["result"]["symbol"]["exists"] is True


def test_host_fs_verbs_surface_validation_errors(tmp_path: Path) -> None:
    inside = tmp_path / "allowed"
    inside.mkdir()
    outside = tmp_path / "denied"
    outside.mkdir()
    response = host.handle(
        {
            "id": "boundary",
            "verb": "fsList",
            "params": {"path": str(outside), "extraRoots": [str(inside)]},
        }
    )
    assert response["ok"] is False
    assert "outside allowed roots" in response["error"]


def test_host_fs_list_rejects_missing_path(tmp_path: Path) -> None:
    response = host.handle(
        {"id": "x", "verb": "fsList", "params": {"extraRoots": [str(tmp_path)]}}
    )
    assert response["ok"] is False
    assert "path is required" in response["error"]
