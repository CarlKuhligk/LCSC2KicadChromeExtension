"""Tests for the V3 Native-Host Category-Rule store (Issue #25).

Covers ``native_host.rules.get_rule`` (the read-side wired in this slice)
and the ``getRule`` RPC dispatched through ``native_host.host.handle``.
The write-side (``set_rule``) lands with the Register slice (#28).
"""

from __future__ import annotations

import json
from pathlib import Path

from native_host import host
from native_host.rules import (
    STORE_VERSION,
    default_store_path,
    get_rule,
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
