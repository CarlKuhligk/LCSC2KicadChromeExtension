"""Tests for the V3 Native Host **Phase 1 Fetch** (Issue #3).

Two layers:
- ``native_host.phase1.fetch_metadata`` — the resolver. Drives an injected
  ``cad_fetcher`` stub so we never hit the real EasyEDA API.
- ``native_host.host.handle`` — RPC dispatch + busy guard. Verifies the JSON
  shape Chrome's Native Messaging frames carry on the wire.

The category-path corpus is intentionally identical to the JS-side fixture
in ``chrome_extension/src/content/lcscPageSnapshot.test.mjs`` so the Python
mirror stays drift-free with the JS scraper output.
"""

from __future__ import annotations

import threading
from typing import Any

import pytest

from native_host import host
from native_host.phase1 import fetch_metadata


# ---------------------------------------------------------------------------
# Sample LCSC C22548 (YAGEO 1kΩ 0603 resistor) EasyEDA component-API payload
# ---------------------------------------------------------------------------
# Minimal-but-realistic fragment: head + a couple of PIN/RECT shape entries.
# The exact dataStr.shape lines matter because pin counting scans for ``PIN~``.
SAMPLE_C22548_CAD = {
    "lcsc": {
        "number": "C22548",
        "url": "https://www.lcsc.com/product-detail/C22548.html",
    },
    "dataStr": {
        "head": {
            "x": 0,
            "y": 0,
            "c_para": {
                "name": "RC0603FR-071KL",
                "pre": "R?",
                "package": "R0603",
                "Manufacturer": "YAGEO",
            },
        },
        "shape": [
            "PIN~show~...~M -7.5 0 h 5.08~#000000~~0~0~Pin1~gge1~0~^^",
            "PIN~show~...~M 7.5 0 h -5.08~#000000~~0~0~Pin2~gge2~0~^^",
            "R~-7.5~-2.5~~~15~5~#000000~1~0~none~gge3~0",
        ],
    },
}


# ---------------------------------------------------------------------------
# fetch_metadata resolver
# ---------------------------------------------------------------------------


def _stub_fetcher(payload: dict[str, Any]):
    def _inner(_lcsc_id: str) -> dict[str, Any]:
        return payload
    return _inner


def test_fetch_metadata_returns_normalized_lcsc_id() -> None:
    result = fetch_metadata("c22548", cad_fetcher=_stub_fetcher(SAMPLE_C22548_CAD))
    assert result["lcscId"] == "C22548"


def test_fetch_metadata_counts_pins_from_data_str_shape() -> None:
    result = fetch_metadata("C22548", cad_fetcher=_stub_fetcher(SAMPLE_C22548_CAD))
    assert result["pinCount"] == 2


def test_fetch_metadata_returns_zero_pin_count_when_cad_empty() -> None:
    result = fetch_metadata("C99999", cad_fetcher=_stub_fetcher({}))
    assert result["pinCount"] == 0


def test_fetch_metadata_falls_back_to_easyeda_datasheet_when_no_hint() -> None:
    result = fetch_metadata("C22548", cad_fetcher=_stub_fetcher(SAMPLE_C22548_CAD))
    assert result["datasheetUrl"] == "https://www.lcsc.com/product-detail/C22548.html"


def test_fetch_metadata_prefers_page_hint_datasheet_over_easyeda() -> None:
    result = fetch_metadata(
        "C22548",
        {"datasheetUrl": "https://datasheet.lcsc.com/lcsc/C22548.pdf"},
        cad_fetcher=_stub_fetcher(SAMPLE_C22548_CAD),
    )
    assert result["datasheetUrl"] == "https://datasheet.lcsc.com/lcsc/C22548.pdf"


def test_fetch_metadata_returns_none_datasheet_when_neither_side_has_one() -> None:
    result = fetch_metadata(
        "C99999",
        {"categoryPath": "Passives/Resistors"},
        cad_fetcher=_stub_fetcher({}),
    )
    assert result["datasheetUrl"] is None


def test_fetch_metadata_normalizes_category_path_from_page_hint() -> None:
    """Drives the same normalization used by ``lcscPageSnapshot.js`` —
    duplicate slashes are collapsed, segments are trimmed."""
    result = fetch_metadata(
        "C22548",
        {"categoryPath": "  Passives  //  Resistors  /  SMD  "},
        cad_fetcher=_stub_fetcher(SAMPLE_C22548_CAD),
    )
    assert result["categoryPath"] == "Passives/Resistors/SMD"


def test_fetch_metadata_returns_none_category_when_no_hint() -> None:
    result = fetch_metadata("C22548", cad_fetcher=_stub_fetcher(SAMPLE_C22548_CAD))
    assert result["categoryPath"] is None


def test_fetch_metadata_rejects_missing_lcsc_id() -> None:
    with pytest.raises(ValueError):
        fetch_metadata("")


def test_fetch_metadata_rejects_non_string_lcsc_id() -> None:
    with pytest.raises(ValueError):
        fetch_metadata(22548)  # type: ignore[arg-type]


def test_fetch_metadata_rejects_invalid_lcsc_id_pattern() -> None:
    with pytest.raises(ValueError):
        fetch_metadata("X22548")


def test_fetch_metadata_does_not_propagate_cad_fetcher_errors() -> None:
    """A failing EasyEDA fetch must not break Phase 1 — the panel still wants
    the page-hint metadata. Pin count degrades to 0."""

    def boom(_lcsc_id: str) -> dict[str, Any]:
        raise RuntimeError("EasyEDA unreachable")

    result = fetch_metadata(
        "C22548",
        {"categoryPath": "Passives/Resistors", "datasheetUrl": "https://x/y.pdf"},
        cad_fetcher=boom,
    )
    assert result == {
        "lcscId": "C22548",
        "categoryPath": "Passives/Resistors",
        "pinCount": 0,
        "datasheetUrl": "https://x/y.pdf",
    }


# ---------------------------------------------------------------------------
# host.handle — fetchMetadata RPC dispatch (busy guard, error shape)
# ---------------------------------------------------------------------------


def _ok_response(lcsc_id: str = "C22548") -> dict[str, Any]:
    return {
        "lcscId": lcsc_id,
        "categoryPath": "Passives/Resistors",
        "pinCount": 2,
        "datasheetUrl": "https://example.com/d.pdf",
    }


def test_handle_fetch_metadata_returns_result_envelope() -> None:
    response = host.handle(
        {
            "id": 7,
            "verb": "fetchMetadata",
            "params": {"lcscId": "C22548", "pageHints": {"categoryPath": "Passives/Resistors"}},
        },
        metadata_fetcher=lambda _id, _hints: _ok_response("C22548"),
    )
    assert response["id"] == 7
    assert response["ok"] is True
    assert response["result"]["pinCount"] == 2
    assert response["result"]["categoryPath"] == "Passives/Resistors"


def test_handle_fetch_metadata_propagates_validation_error_as_rpc_error() -> None:
    # No stub — the real ``fetch_metadata`` validator raises before any
    # EasyEDA call, so this test is offline-safe.
    response = host.handle(
        {"id": "bad", "verb": "fetchMetadata", "params": {"lcscId": ""}},
    )
    assert response["ok"] is False
    assert response["id"] == "bad"
    assert "lcscId" in response["error"]


def test_handle_fetch_metadata_busy_when_another_is_in_flight() -> None:
    """A second concurrent ``fetchMetadata`` returns ``busy`` per ADR-0004."""
    in_handler = threading.Event()
    release = threading.Event()

    def slow_fetcher(_lcsc_id: str, _hints: dict[str, Any] | None) -> dict[str, Any]:
        in_handler.set()
        release.wait(timeout=2)
        return _ok_response()

    results: dict[str, Any] = {}

    def first():
        results["first"] = host.handle(
            {"id": 1, "verb": "fetchMetadata", "params": {"lcscId": "C22548"}},
            metadata_fetcher=slow_fetcher,
        )

    t = threading.Thread(target=first)
    t.start()
    assert in_handler.wait(timeout=2), "first handler did not start"

    # Second call while the first is mid-flight.
    second = host.handle(
        {"id": 2, "verb": "fetchMetadata", "params": {"lcscId": "C22548"}},
        metadata_fetcher=lambda _id, _hints: _ok_response(),
    )
    assert second["ok"] is False
    assert second["error"] == "busy"
    assert second["id"] == 2

    release.set()
    t.join(timeout=2)
    assert results["first"]["ok"] is True


def test_handle_busy_lock_releases_after_handler_exception() -> None:
    """A failing handler must not leave the host wedged in busy state."""

    def boom(_lcsc_id: str, _hints: dict[str, Any] | None) -> dict[str, Any]:
        raise RuntimeError("upstream broke")

    first = host.handle(
        {"id": 1, "verb": "fetchMetadata", "params": {"lcscId": "C22548"}},
        metadata_fetcher=boom,
    )
    assert first["ok"] is False  # surfaced as RPC error
    # Subsequent call must succeed (lock released).
    second = host.handle(
        {"id": 2, "verb": "fetchMetadata", "params": {"lcscId": "C22548"}},
        metadata_fetcher=lambda _id, _hints: _ok_response(),
    )
    assert second["ok"] is True
