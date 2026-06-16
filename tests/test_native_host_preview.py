"""Tests for native_host.preview.lcsc_footprint_preview (UI Etappe B).

The renderer itself (``footprint_preview_bundle``) has its own tests; here we
exercise the RPC wrapper: cad fetch, soft-failure shapes, validation, and the
host dispatch branch. ``footprint_preview_bundle`` is monkeypatched so the
tests do not need a full EasyEDA CAD fixture.
"""
from __future__ import annotations

from typing import Any

import pytest

from easyeda2kicad.service import lcsc_preview as lcsc_preview_mod
from easyeda2kicad.service.lcsc_preview import FootprintPreviewBundle
from native_host import host, preview


def _fake_bundle(svg: str | None = "<svg id='fp'></svg>") -> FootprintPreviewBundle:
    return FootprintPreviewBundle(
        footprint_svg=svg, footprint_name="R_0603", pads=[{"number": "1"}]
    )


def test_returns_svg_name_pads(monkeypatch) -> None:
    monkeypatch.setattr(
        lcsc_preview_mod, "footprint_preview_bundle", lambda *a, **k: _fake_bundle()
    )
    res = preview.lcsc_footprint_preview(
        {"lcscId": "C123"}, cad_fetcher=lambda _id: {"x": 1}
    )
    assert res["svg"] == "<svg id='fp'></svg>"
    assert res["name"] == "R_0603"
    assert res["pads"] == [{"number": "1"}]


def test_empty_cad_is_soft_error() -> None:
    res = preview.lcsc_footprint_preview({"lcscId": "C123"}, cad_fetcher=lambda _id: {})
    assert res["svg"] is None
    assert res["error"] == "no_cad_data"


def test_fetch_exception_is_soft_error() -> None:
    def _boom(_id: str) -> dict[str, Any]:
        raise RuntimeError("network down")

    res = preview.lcsc_footprint_preview({"lcscId": "C123"}, cad_fetcher=_boom)
    assert res["svg"] is None
    assert res["error"].startswith("fetch_failed")


def test_render_failure_is_soft_error(monkeypatch) -> None:
    monkeypatch.setattr(
        lcsc_preview_mod,
        "footprint_preview_bundle",
        lambda *a, **k: _fake_bundle(svg=None),
    )
    res = preview.lcsc_footprint_preview(
        {"lcscId": "C123"}, cad_fetcher=lambda _id: {"x": 1}
    )
    assert res["svg"] is None
    assert res["error"] == "render_failed"


@pytest.mark.parametrize("payload", [{}, {"lcscId": ""}, {"lcscId": "bad"}])
def test_validation_errors(payload) -> None:
    with pytest.raises(ValueError):
        preview.lcsc_footprint_preview(payload, cad_fetcher=lambda _id: {"x": 1})


def test_host_dispatches_lcsc_footprint_preview_verb(monkeypatch) -> None:
    from easyeda2kicad.easyeda import easyeda_api

    monkeypatch.setattr(
        easyeda_api.EasyedaApi,
        "get_cad_data_of_component",
        lambda _self, _lcsc: {"x": 1},
    )
    monkeypatch.setattr(
        lcsc_preview_mod, "footprint_preview_bundle", lambda *a, **k: _fake_bundle()
    )
    response = host.handle({
        "id": 11,
        "verb": "lcscFootprintPreview",
        "params": {"lcscId": "C123"},
    })
    assert response["id"] == 11
    assert response["ok"] is True
    assert response["result"]["svg"] == "<svg id='fp'></svg>"


def test_host_lcsc_footprint_preview_validation_error() -> None:
    response = host.handle({
        "id": "x",
        "verb": "lcscFootprintPreview",
        "params": {"lcscId": "bad"},
    })
    assert response["ok"] is False
    assert "lcscId" in response["error"]
