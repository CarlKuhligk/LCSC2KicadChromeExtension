"""
V3 Native-Host **Category Rule** store (Issue #25, extended in #28).

Persists the per-Category-Path **Category Rule** rows the V3 Confidence
state machine reads (ADR-0006). Lives on disk under a stable user-config
path so a rule the user creates in the **Import-Editor** survives a Chrome
restart, an extension reload, or a host re-launch.

Issue #25 wired the read-side (``get_rule``) so the SW could drive the
white-state Register-Prompt. Issue #28 adds the write-side (``set_rule``)
behind the new ``setRule`` Native-Host verb: when the user clicks
„Übernehmen" in the **Import-Editor** the SW relays the resolved Rule
shape — Category Path + ``symbolSource`` + ``labelMapping`` (and a
reserved ``footprintSource`` slot for the follow-up slice) — to the host
and the rule is persisted to the same on-disk store ``get_rule`` reads
back on every subsequent Phase 1 Fetch. ADR-0006 removed
``autoApply``/``autoConfirm``/``action``; ``set_rule`` rejects unknown
fields so old callers cannot smuggle them back in.

The file format is stable so that future slices can extend it without a
migration:

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


_ALLOWED_RULE_FIELDS: frozenset[str] = frozenset(
    {
        "categoryPath",
        "symbolSource",
        "footprintSource",
        "labelMapping",
        "hidePinNumbers",
        "hidePinNames",
    }
)
"""ADR-0006 ComponentRule fields persisted by the Register slice.

Anything outside this set raises ``ValueError`` in ``_normalize_rule`` —
including the V2-era ``autoApply`` / ``autoConfirm`` / ``action`` triplet
ADR-0006 removed — so legacy clients cannot smuggle them back in. The
companion JS shape lives in ``chrome_extension/src/content/overridePanel.js``
(``buildRegisterImportEditor``); both sides keep the same field list so
the RPC round-trip is lossless.
"""

_LEGACY_REMOVED_FIELDS: frozenset[str] = frozenset(
    {"autoApply", "autoConfirm", "action"}
)
"""V2-era / pre-ADR-0006 fields that must disappear from any rule body the
Rule store hands back.

``set_rule`` rejects them with a ``ValueError`` (write-side guard, see
``_normalize_rule``). But a user upgrading from a V2 build can have a
``rules.json`` on disk that still carries these fields; loading must
silently strip them (Issue #30) so the Confidence pipeline never sees the
old apply/confirm/action triplet again.
"""


def _sanitize_rule_on_load(rule: Any) -> dict[str, Any] | None:
    """Drop ADR-0006-removed fields from a stored rule body without losing
    the rest.

    Mirrors the JS-side ``cleanRuleEntry`` (``categoryPath.mjs``) for the
    Rule-store shape: only the ADR-0006-removed triplet is stripped here;
    every other field is preserved verbatim so the deepest-prefix lookup
    keeps reading the body the SW expects. Returns ``None`` if the rule is
    not a dict (so callers can ``return None`` on garbage entries).
    """
    if not isinstance(rule, dict):
        return None
    if not any(k in rule for k in _LEGACY_REMOVED_FIELDS):
        return rule
    return {k: v for k, v in rule.items() if k not in _LEGACY_REMOVED_FIELDS}


def _normalize_source_layer(raw: Any, *, field: str) -> dict[str, Any]:
    """Coerce a source-layer entry (``symbolSource`` / ``footprintSource``) into
    the shape Phase 2 expects.

    Accepts the same two shapes the **Override Panel** emits:
    ``{"source": "easyeda"}`` (no template) or
    ``{"source": "template", "libPath": str, "name": str}``. Anything else
    raises ``ValueError`` so the RPC envelope carries the explanation back
    to the user instead of silently writing a half-baked rule. ``field`` is
    inlined into the message so the user sees which layer was wrong.
    """
    if not isinstance(raw, dict):
        raise ValueError(f"rule.{field} must be an object")
    source = raw.get("source")
    if source == "easyeda":
        return {"source": "easyeda"}
    if source != "template":
        raise ValueError(
            f"rule.{field}.source must be 'easyeda' or 'template' (got {source!r})"
        )
    lib_path = raw.get("libPath")
    name = raw.get("name")
    if not isinstance(lib_path, str) or not lib_path.strip():
        raise ValueError(f"rule.{field}.libPath is required for template source")
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"rule.{field}.name is required for template source")
    return {"source": "template", "libPath": lib_path.strip(), "name": name.strip()}


def _normalize_label_mapping(raw: Any) -> dict[str, str]:
    """Validate the LCSC-label → KiCad-property map.

    Keys and values must be non-empty strings; blank entries are dropped
    so a half-filled Import-Editor row does not poison the rule. Returns a
    plain ``dict`` so the JSON serializer below can store it verbatim.
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("rule.labelMapping must be an object")
    out: dict[str, str] = {}
    for key, value in raw.items():
        if not isinstance(key, str):
            raise ValueError("rule.labelMapping keys must be strings")
        if not isinstance(value, str):
            raise ValueError(f"rule.labelMapping[{key!r}] must be a string")
        k = key.strip()
        v = value.strip()
        if not k or not v:
            continue
        out[k] = v
    return out


def _normalize_rule(rule: Any, category_path: str) -> dict[str, Any]:
    """Project ``rule`` onto the ADR-0006 schema; reject unknown fields.

    The ``categoryPath`` stored inside the rule is the normalized form so a
    later ``get_rule`` round-trip yields exactly what was persisted (no
    case / spacing drift between key and body).
    """
    if not isinstance(rule, dict):
        raise ValueError("rule must be an object")
    unknown = set(rule.keys()) - _ALLOWED_RULE_FIELDS
    if unknown:
        raise ValueError(
            f"rule has unsupported field(s): {sorted(unknown)!r} "
            "(ADR-0006 dropped autoApply / autoConfirm / action)"
        )
    if "symbolSource" not in rule:
        raise ValueError("rule.symbolSource is required")
    body: dict[str, Any] = {
        "categoryPath": category_path,
        "symbolSource": _normalize_source_layer(
            rule.get("symbolSource"), field="symbolSource"
        ),
        "labelMapping": _normalize_label_mapping(rule.get("labelMapping")),
        # Pin-label visibility (V2 carry-over): hide pin numbers / names in the
        # written symbol — typical for 2-pin parts (R/C/L/D) where they clutter
        # the schematic. Applied by the engine (template_merger + exporter).
        "hidePinNumbers": bool(rule.get("hidePinNumbers")),
        "hidePinNames": bool(rule.get("hidePinNames")),
    }
    if "footprintSource" in rule and rule["footprintSource"] is not None:
        # Reserved slot for the footprint follow-up slice. Validate with the
        # same grammar as symbolSource so a Register save today does not
        # produce a rule the future footprint slice has to migrate.
        body["footprintSource"] = _normalize_source_layer(
            rule["footprintSource"], field="footprintSource"
        )
    return body


def set_rule(
    category_path: Any,
    rule: Any,
    *,
    store_path: Path | None = None,
) -> dict[str, Any]:
    """Persist a **Category Rule** keyed by ``category_path``.

    Args:
        category_path: LCSC Category Path. Normalized via the Python mirror
            of ``normalizeCategoryPath`` — the storage key is the
            normalized form so ``get_rule`` reads it back verbatim.
        rule: The Rule body. Must carry ``symbolSource`` (the Import-Editor
            always picks one); ``labelMapping`` defaults to ``{}`` when
            missing; ``footprintSource`` is optional until the footprint
            slice ships. Fields outside the ADR-0006 set raise
            ``ValueError`` so V2-era ``autoApply`` / ``autoConfirm`` /
            ``action`` cannot smuggle back in.
        store_path: Optional override for the store location. Tests inject
            a ``tmp_path`` file so they do not touch the user's real
            config.

    Returns:
        The normalized Rule dict as it was written to disk — same shape
        ``get_rule`` will hand back on the next read.

    Raises:
        ValueError: when the Category Path normalizes to empty, the rule
            has unsupported fields, or ``symbolSource`` is malformed.
    """
    normalized_path = normalize_category_path(category_path)
    if not normalized_path:
        raise ValueError("categoryPath is required")
    body = _normalize_rule(rule, normalized_path)
    path = store_path if store_path is not None else default_store_path()
    store = _load_store(path)
    rules = dict(store["rules"]) if isinstance(store.get("rules"), dict) else {}
    rules[normalized_path] = body
    payload = {"version": STORE_VERSION, "rules": rules}
    path.parent.mkdir(parents=True, exist_ok=True)
    # Atomic write: render to a sibling temp file first so a crash mid-write
    # cannot leave the store half-serialized (which ``_load_store`` would
    # treat as corrupt and quietly drop every previously-registered rule).
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return body


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
    return _sanitize_rule_on_load(rules.get(key))
