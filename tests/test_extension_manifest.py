"""Guard rail for chrome_extension/manifest.json.

Chrome MV3 blocks dynamic ES module imports from chrome-extension:// URLs
unless the file is listed in `web_accessible_resources`. The Vitest harness
and `node --check` do NOT catch this — Vitest mocks module resolution and
Node has no concept of the manifest. The only way to discover the
omission is to actually load the extension in Chrome.

This test mirrors what Chrome enforces at runtime: every JS/MJS module in
chrome_extension/src/content/ and chrome_extension/shared/ that production
code may dynamically import must match at least one
`web_accessible_resources.resources` entry.

If you add a new module file and don't update the manifest, this test
fails and tells you exactly what to add (or, more often, that the existing
glob already covers it).
"""

from __future__ import annotations

import fnmatch
import json
from pathlib import Path

import pytest

EXT_ROOT = Path(__file__).resolve().parent.parent / "chrome_extension"


def _load_manifest() -> dict:
    with (EXT_ROOT / "manifest.json").open(encoding="utf-8") as f:
        return json.load(f)


def _allowed_resource_patterns() -> list[str]:
    manifest = _load_manifest()
    patterns: list[str] = []
    for entry in manifest.get("web_accessible_resources", []):
        patterns.extend(entry.get("resources", []))
    return patterns


def _matches_any(path_rel: str, patterns: list[str]) -> bool:
    # Chrome's web_accessible_resources globbing uses `*` for wildcards.
    # fnmatch is close enough for our flat directory layout.
    return any(fnmatch.fnmatch(path_rel, p) for p in patterns)


def _shipped_modules_in(subdir: str, suffixes: tuple[str, ...]) -> list[str]:
    """Return relative posix paths of production module files under EXT_ROOT/subdir.

    Test files (`*.test.js`, `*.test.mjs`) are excluded because they are
    never imported by production content scripts.
    """
    root = EXT_ROOT / subdir
    if not root.is_dir():
        return []
    return [
        f"{subdir}/{p.name}"
        for p in sorted(root.iterdir())
        if p.is_file()
        and p.suffix in suffixes
        and not p.name.endswith(".test.js")
        and not p.name.endswith(".test.mjs")
    ]


def test_every_content_script_module_is_web_accessible() -> None:
    """src/content/*.js — must be reachable, else Chrome blocks dynamic import()."""
    patterns = _allowed_resource_patterns()
    modules = _shipped_modules_in("src/content", (".js",))
    if not modules:
        pytest.skip("no src/content/*.js modules present")

    missing = [m for m in modules if not _matches_any(m, patterns)]
    assert not missing, (
        "The following content-script modules are NOT covered by "
        "chrome_extension/manifest.json web_accessible_resources. Chrome will "
        "block dynamic import() of these from the LCSC page, leaving the "
        "extension silently broken at runtime:\n  - "
        + "\n  - ".join(missing)
        + "\nFix: add 'src/content/*.js' to the resources glob, or list each "
        "file individually."
    )


def test_every_shared_esm_module_is_web_accessible() -> None:
    """shared/*.mjs — ES modules used by content scripts must be web-accessible.

    `.js` files in shared/ are classic scripts (loaded by background.js via
    importScripts and by popup.html via <script src>) and are deliberately
    NOT checked: same-origin extension contexts don't need
    web_accessible_resources.
    """
    patterns = _allowed_resource_patterns()
    modules = _shipped_modules_in("shared", (".mjs",))
    if not modules:
        pytest.skip("no shared/*.mjs modules present")

    missing = [m for m in modules if not _matches_any(m, patterns)]
    assert not missing, (
        "The following shared ES modules are NOT covered by "
        "chrome_extension/manifest.json web_accessible_resources:\n  - "
        + "\n  - ".join(missing)
    )


def test_manifest_is_valid_mv3() -> None:
    manifest = _load_manifest()
    assert manifest.get("manifest_version") == 3
    assert "web_accessible_resources" in manifest
    for entry in manifest["web_accessible_resources"]:
        assert isinstance(entry.get("resources"), list)
        assert isinstance(entry.get("matches"), list)
        assert len(entry["matches"]) > 0
