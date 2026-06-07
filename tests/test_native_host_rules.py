"""Tests for the V3 Native-Host Category-Rule store (Issues #25, #28).

Covers ``native_host.rules.get_rule`` (the read-side wired in #25),
``native_host.rules.set_rule`` (the write-side wired in #28) and both
verbs dispatched through ``native_host.host.handle``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from native_host import host
from native_host.rules import (
    STORE_VERSION,
    default_store_path,
    get_rule,
    set_rule,
)


def _write_store(path: Path, rules: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"version": STORE_VERSION, "rules": rules}),
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# get_rule — read path against a tmp_path store
# ---------------------------------------------------------------------------


def test_get_rule_returns_none_when_store_does_not_exist(tmp_path: Path) -> None:
    store = tmp_path / "missing.json"
    assert get_rule("Passives/Resistors", store_path=store) is None


def test_get_rule_returns_none_when_no_prefix_matches(tmp_path: Path) -> None:
    store = tmp_path / "rules.json"
    _write_store(store, {"Capacitors": {"categoryPath": "Capacitors"}})
    assert get_rule("Passives/Resistors", store_path=store) is None


def test_get_rule_returns_exact_match(tmp_path: Path) -> None:
    store = tmp_path / "rules.json"
    rule = {"categoryPath": "Passives/Resistors", "symbolSource": {"source": "easyeda"}}
    _write_store(store, {"Passives/Resistors": rule})
    assert get_rule("Passives/Resistors", store_path=store) == rule


def test_get_rule_uses_deepest_prefix(tmp_path: Path) -> None:
    """Longest matching key wins — same rule as resolveCategorySettings."""
    store = tmp_path / "rules.json"
    shallow = {"categoryPath": "Passives"}
    deep = {"categoryPath": "Passives/Resistors"}
    _write_store(store, {"Passives": shallow, "Passives/Resistors": deep})
    assert get_rule("Passives/Resistors/SMD", store_path=store) == deep


def test_get_rule_normalizes_input_category_path(tmp_path: Path) -> None:
    """Caller does not have to pre-normalize — get_rule mirrors normalizeCategoryPath."""
    store = tmp_path / "rules.json"
    rule = {"categoryPath": "Passives/Resistors"}
    _write_store(store, {"Passives/Resistors": rule})
    assert get_rule("  /Passives//Resistors/  ", store_path=store) == rule


def test_get_rule_returns_none_for_blank_input(tmp_path: Path) -> None:
    store = tmp_path / "rules.json"
    _write_store(store, {"Passives": {"categoryPath": "Passives"}})
    assert get_rule("", store_path=store) is None
    assert get_rule(None, store_path=store) is None
    assert get_rule(42, store_path=store) is None


def test_get_rule_returns_none_for_corrupt_store(tmp_path: Path) -> None:
    """A corrupt rules.json must not crash the host — Register-Prompt is the fallback."""
    store = tmp_path / "rules.json"
    store.write_text("{not json", encoding="utf-8")
    assert get_rule("Passives", store_path=store) is None


def test_get_rule_strict_prefix_does_not_match_partial_segment(tmp_path: Path) -> None:
    """``Passives/Resistor`` should not match a stored ``Passives/Resistors``."""
    store = tmp_path / "rules.json"
    _write_store(store, {"Passives/Resistors": {"categoryPath": "Passives/Resistors"}})
    assert get_rule("Passives/Resistor", store_path=store) is None


def test_default_store_path_is_user_scoped() -> None:
    """Sanity check: the default store path lives under the user's home tree."""
    path = default_store_path()
    assert path.name == "rules.json"
    assert path.parent.name == "kicad-parts-importer"


# ---------------------------------------------------------------------------
# host.handle — getRule RPC dispatch
# ---------------------------------------------------------------------------


def test_handle_getrule_returns_null_rule_when_store_empty(monkeypatch) -> None:
    """No store on disk → ``{ok: True, result: {rule: None}}``."""
    monkeypatch.setattr(
        host, "get_rule", lambda category_path: None,
    )
    response = host.handle({
        "id": 7,
        "verb": "getRule",
        "params": {"categoryPath": "Passives/Resistors"},
    })
    assert response == {"id": 7, "ok": True, "result": {"rule": None}}


def test_handle_getrule_passes_category_path_through(monkeypatch) -> None:
    captured: dict = {}

    def fake_get_rule(category_path):
        captured["arg"] = category_path
        return {"categoryPath": category_path}

    monkeypatch.setattr(host, "get_rule", fake_get_rule)
    response = host.handle({
        "id": "x",
        "verb": "getRule",
        "params": {"categoryPath": " Passives/Resistors "},
    })
    assert captured["arg"] == " Passives/Resistors "
    assert response["ok"] is True
    assert response["result"]["rule"] == {"categoryPath": " Passives/Resistors "}


def test_handle_getrule_returns_error_on_unexpected_exception(monkeypatch) -> None:
    def boom(_):
        raise RuntimeError("disk full")

    monkeypatch.setattr(host, "get_rule", boom)
    response = host.handle({"id": 1, "verb": "getRule", "params": {"categoryPath": "X"}})
    assert response["ok"] is False
    assert "disk full" in response["error"]


def test_handle_getrule_handles_missing_params() -> None:
    """Calling ``getRule`` without params resolves an empty category → ``None``."""
    response = host.handle({"id": 2, "verb": "getRule"})
    assert response["ok"] is True
    assert response["result"]["rule"] is None


# ---------------------------------------------------------------------------
# set_rule — write path (Issue #28)
# ---------------------------------------------------------------------------


def test_set_rule_persists_easyeda_symbol_source(tmp_path: Path) -> None:
    """Minimal rule: Symbol = EasyEDA, no mapping — still a valid Register save.

    Even when the user picks „Keep EasyEDA" in the Import-Editor the act of
    registering raises future confidence for this Category (ADR-0006), so
    the write must succeed and ``get_rule`` must read back the same body.
    """
    store = tmp_path / "rules.json"
    written = set_rule(
        "Passives/Resistors",
        {"symbolSource": {"source": "easyeda"}},
        store_path=store,
    )
    assert written == {
        "categoryPath": "Passives/Resistors",
        "symbolSource": {"source": "easyeda"},
        "labelMapping": {},
    }
    assert get_rule("Passives/Resistors", store_path=store) == written


def test_set_rule_persists_template_symbol_source_and_label_mapping(
    tmp_path: Path,
) -> None:
    """Full Register save: Symbol = Template + LCSC-label-mapping."""
    store = tmp_path / "rules.json"
    written = set_rule(
        "Passives/Resistors/SMD",
        {
            "symbolSource": {
                "source": "template",
                "libPath": "/home/user/templates/MyTemplates.kicad_sym",
                "name": "R0603",
            },
            "labelMapping": {
                "Resistance": "Value",
                "Tolerance": "Tolerance",
                "Power(Watts)": "Power",
            },
        },
        store_path=store,
    )
    assert written["symbolSource"] == {
        "source": "template",
        "libPath": "/home/user/templates/MyTemplates.kicad_sym",
        "name": "R0603",
    }
    assert written["labelMapping"] == {
        "Resistance": "Value",
        "Tolerance": "Tolerance",
        "Power(Watts)": "Power",
    }
    # And round-trips through get_rule.
    assert get_rule("Passives/Resistors/SMD", store_path=store) == written


def test_set_rule_normalizes_category_path(tmp_path: Path) -> None:
    """Storage key is the normalized form so case-/spacing-variants collide."""
    store = tmp_path / "rules.json"
    set_rule(
        " /Passives//Resistors/  ",
        {"symbolSource": {"source": "easyeda"}},
        store_path=store,
    )
    # Stored key is the normalized form — get_rule can find it from either side.
    data = json.loads(store.read_text(encoding="utf-8"))
    assert "Passives/Resistors" in data["rules"]
    assert data["rules"]["Passives/Resistors"]["categoryPath"] == "Passives/Resistors"


def test_set_rule_overwrites_existing_entry_without_dropping_others(
    tmp_path: Path,
) -> None:
    """A second save at the same key replaces the body but preserves siblings."""
    store = tmp_path / "rules.json"
    set_rule("Passives", {"symbolSource": {"source": "easyeda"}}, store_path=store)
    set_rule(
        "Capacitors",
        {"symbolSource": {"source": "easyeda"}},
        store_path=store,
    )
    set_rule(
        "Passives",
        {
            "symbolSource": {
                "source": "template",
                "libPath": "/tmp/T.kicad_sym",
                "name": "X",
            }
        },
        store_path=store,
    )
    passives = get_rule("Passives", store_path=store)
    capacitors = get_rule("Capacitors", store_path=store)
    assert passives is not None and passives["symbolSource"]["source"] == "template"
    assert capacitors is not None and capacitors["symbolSource"]["source"] == "easyeda"


def test_set_rule_rejects_blank_category_path(tmp_path: Path) -> None:
    store = tmp_path / "rules.json"
    with pytest.raises(ValueError, match="categoryPath"):
        set_rule("", {"symbolSource": {"source": "easyeda"}}, store_path=store)
    with pytest.raises(ValueError, match="categoryPath"):
        set_rule(None, {"symbolSource": {"source": "easyeda"}}, store_path=store)


def test_set_rule_rejects_missing_symbol_source(tmp_path: Path) -> None:
    store = tmp_path / "rules.json"
    with pytest.raises(ValueError, match="symbolSource"):
        set_rule("Passives", {"labelMapping": {}}, store_path=store)


def test_set_rule_rejects_legacy_autoapply_field(tmp_path: Path) -> None:
    """ADR-0006 removed autoApply / autoConfirm / action — surface a clear error."""
    store = tmp_path / "rules.json"
    with pytest.raises(ValueError, match="autoApply"):
        set_rule(
            "Passives",
            {
                "symbolSource": {"source": "easyeda"},
                "autoApply": "auto",
            },
            store_path=store,
        )


def test_set_rule_rejects_malformed_template_symbol_source(tmp_path: Path) -> None:
    store = tmp_path / "rules.json"
    with pytest.raises(ValueError, match="symbolSource.libPath"):
        set_rule(
            "Passives",
            {"symbolSource": {"source": "template", "name": "X"}},
            store_path=store,
        )


def test_set_rule_rejects_malformed_template_footprint_source(tmp_path: Path) -> None:
    """Footprint-layer error messages must name ``footprintSource`` — not
    ``symbolSource`` — so the user sees which layer they need to fix.
    """
    store = tmp_path / "rules.json"
    with pytest.raises(ValueError, match="footprintSource.libPath"):
        set_rule(
            "Passives",
            {
                "symbolSource": {"source": "easyeda"},
                "footprintSource": {"source": "template", "name": "X"},
            },
            store_path=store,
        )


def test_set_rule_drops_blank_label_mapping_entries(tmp_path: Path) -> None:
    """A half-filled Import-Editor row (blank key or value) is dropped silently."""
    store = tmp_path / "rules.json"
    written = set_rule(
        "Passives",
        {
            "symbolSource": {"source": "easyeda"},
            "labelMapping": {"Resistance": "Value", "Tolerance": "  ", "": "Drop"},
        },
        store_path=store,
    )
    assert written["labelMapping"] == {"Resistance": "Value"}


# ---------------------------------------------------------------------------
# host.handle — setRule RPC dispatch
# ---------------------------------------------------------------------------


def test_handle_setrule_writes_through(monkeypatch) -> None:
    captured: dict = {}

    def fake_set_rule(category_path, rule):
        captured["categoryPath"] = category_path
        captured["rule"] = rule
        return {
            "categoryPath": "Passives/Resistors",
            "symbolSource": rule["symbolSource"],
            "labelMapping": {},
        }

    monkeypatch.setattr(host, "set_rule", fake_set_rule)
    response = host.handle(
        {
            "id": 9,
            "verb": "setRule",
            "params": {
                "categoryPath": "Passives/Resistors",
                "rule": {"symbolSource": {"source": "easyeda"}},
            },
        }
    )
    assert captured == {
        "categoryPath": "Passives/Resistors",
        "rule": {"symbolSource": {"source": "easyeda"}},
    }
    assert response["ok"] is True
    assert response["result"]["rule"]["categoryPath"] == "Passives/Resistors"


def test_handle_setrule_returns_error_for_invalid_input(monkeypatch) -> None:
    def boom(*_args, **_kw):
        raise ValueError("categoryPath is required")

    monkeypatch.setattr(host, "set_rule", boom)
    response = host.handle({"id": 1, "verb": "setRule", "params": {}})
    assert response == {"id": 1, "ok": False, "error": "categoryPath is required"}


def test_handle_setrule_propagates_unexpected_error(monkeypatch) -> None:
    def boom(*_args, **_kw):
        raise RuntimeError("disk full")

    monkeypatch.setattr(host, "set_rule", boom)
    response = host.handle(
        {
            "id": 1,
            "verb": "setRule",
            "params": {
                "categoryPath": "Passives",
                "rule": {"symbolSource": {"source": "easyeda"}},
            },
        }
    )
    assert response["ok"] is False
    assert "disk full" in response["error"]
