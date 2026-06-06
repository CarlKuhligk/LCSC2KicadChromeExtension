"""
V3 Native-Host **Category Rule** store (Issue #25, extended in #28).

Persists the per-Category-Path **Category Rule** rows the V3 Confidence
state machine reads (ADR-0006). Lives on disk under a stable user-config
path so a rule the user creates in the **Import-Editor** survives a Chrome
restart, an extension reload, or a host re-launch.

This slice (Issue #25 — `white` state + Register-Prompt) wires the
read-side only: ``get_rule(category_path)`` resolves a Category Path
against the stored rules using the deepest-prefix rule (longest key K with
``path == K`` or ``path.startswith(K + "/")`` wins, same rule as
``resolveCategorySettings`` in ``background.js:50``). Returns ``None`` when
no rule matches — which feeds ``computeConfidenceState`` → ``"white"`` →
Register-Prompt in the Override Panel.

The write-side (``set_rule``) lands in Issue #28 once the **Register** UI
in the Import-Editor exists; for now the file is read-only and the
``getRule`` RPC always returns ``None`` until the user has registered
something via a future slice. The file format is stable so that future
writers can extend it without a migration:

    {
      "version": 1,
      "rules": {
        "Passives/Resistors": {
          "categoryPath": "Passives/Resistors",
          "symbolSource": { ... },
          "footprintSource": { ... },
          "labelMapping": { ... }
        }
      }
    }
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from easyeda2kicad.helpers import normalize_category_path

STORE_VERSION = 1
STORE_FILENAME = "rules.json"


def _platform_config_dir() -> Path:
    """Return the OS-specific user-config base directory.

    Windows uses ``%APPDATA%`` (per-user roaming), macOS uses
    ``~/Library/Application Support``, every other platform falls back to
    XDG-style ``~/.config``. Matches where the Native-Host-Manifest lives
    on each OS so the Rule store sits in the same neighborhood.
    """
    if sys.platform.startswith("win"):
        base = os.environ.get("APPDATA")
        if base:
            return Path(base)
        return Path.home() / "AppData" / "Roaming"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    base = os.environ.get("XDG_CONFIG_HOME")
    if base:
        return Path(base)
    return Path.home() / ".config"


def default_store_path() -> Path:
    """Default on-disk path for the Rule store."""
    return _platform_config_dir() / "kicad-parts-importer" / STORE_FILENAME


def _load_store(store_path: Path) -> dict[str, Any]:
    """Read the on-disk store. Missing / unreadable files return an empty store.

    The Native Host is meant to be resilient — a corrupt store should not
    crash the import flow; the user just sees ``white`` (Register-Prompt)
    on every part until they fix or remove the file.
    """
    if not store_path.is_file():
        return {"version": STORE_VERSION, "rules": {}}
    try:
        raw = store_path.read_text(encoding="utf-8")
    except OSError:
        return {"version": STORE_VERSION, "rules": {}}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {"version": STORE_VERSION, "rules": {}}
    if not isinstance(data, dict):
        return {"version": STORE_VERSION, "rules": {}}
    rules = data.get("rules")
    if not isinstance(rules, dict):
        rules = {}
    return {"version": data.get("version", STORE_VERSION), "rules": rules}


def _resolve_deepest_prefix(category_path: str, rules: dict[str, Any]) -> str | None:
    """Return the storage key whose normalized form is the deepest prefix of ``category_path``.

    Mirrors ``resolveCategorySettings`` in ``background.js:50``:

    - longest key ``K`` (after normalization) wins
    - either ``category_path == K`` or ``category_path.startswith(K + "/")``
    - keys that do not normalize to a non-empty string are ignored

    Returns the original (un-normalized) storage key so the caller can read
    the rule body verbatim from the store.
    """
    best_key: str | None = None
    best_len = -1
    for key in rules.keys():
        if not isinstance(key, str):
            continue
        normalized = normalize_category_path(key)
        if not normalized:
            continue
        if (
            category_path == normalized
            or category_path.startswith(normalized + "/")
        ) and len(normalized) > best_len:
            best_len = len(normalized)
            best_key = key
    return best_key


def get_rule(
    category_path: Any,
    *,
    store_path: Path | None = None,
) -> dict[str, Any] | None:
    """Resolve a Category Path against the on-disk Rule store.

    Args:
        category_path: LCSC Category Path — normalized via the Python mirror
            of ``normalizeCategoryPath`` so callers do not have to pre-normalize.
        store_path: Optional override for the store location. Tests inject a
            ``tmp_path``-based file so they do not touch the user's real config.

    Returns:
        The stored Rule dict, or ``None`` when the path normalizes to an
        empty string or no rule prefix-matches. ``None`` is the signal that
        drives ``computeConfidenceState`` → ``"white"`` in the SW.
    """
    path = store_path if store_path is not None else default_store_path()
    normalized = normalize_category_path(category_path)
    if not normalized:
        return None
    store = _load_store(path)
    rules = store["rules"]
    key = _resolve_deepest_prefix(normalized, rules)
    if key is None:
        return None
    rule = rules.get(key)
    return rule if isinstance(rule, dict) else None
