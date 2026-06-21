"""Tests for the V3 Native Host **Phase 2 Conversion** default-path (Issue #4).

Two layers:

- ``native_host.phase2.run_phase2_conversion`` — the runner. Drives an injected
  ``conversion_runner`` stub so the suite never hits the real EasyEDA pipeline.
- ``native_host.host.handle`` — RPC dispatch for the ``convert`` verb,
  progress-emit wiring, busy guard, and error envelope.

The ``conversion_runner`` stub plays back the inner-pipeline contract: it
calls the supplied progress callback at least twice (matching the
``Mindestens 2 progress-Messages werden gestreamed`` acceptance criterion)
before returning a ``ConversionResult``-shaped object the runner can pluck
``symbol_path`` / ``footprint_path`` off of.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import pytest

from easyeda2kicad.service.conversion import (
    ConversionError,
    ConversionRequest,
    ConversionStage,
)
from native_host import host
from native_host.phase2 import run_phase2_conversion


# ---------------------------------------------------------------------------
# Stub conversion runner — mirrors ``run_conversion``'s callback contract
# ---------------------------------------------------------------------------


@dataclass
class _StubResult:
    """Minimal stand-in for ``easyeda2kicad.service.conversion.ConversionResult``.

    The runner only reads ``symbol_path``, ``footprint_path`` and ``messages``,
    so we keep the surface tiny — adding ``model_paths`` would only invite
    drift with the real pipeline.
    """

    symbol_path: Optional[str] = None
    footprint_path: Optional[str] = None
    messages: list = field(default_factory=list)


def _stub_runner(
    progress_steps: Optional[list[tuple[ConversionStage, int, str]]] = None,
    result: Optional[_StubResult] = None,
) -> Callable[[ConversionRequest, Callable[..., None]], _StubResult]:
    """Build a fake ``run_conversion`` that emits the given progress steps."""

    steps = progress_steps or [
        (ConversionStage.FETCHING, 10, "Connecting to EasyEDA…"),
        (ConversionStage.EXPORT_SYMBOL, 55, "Writing symbol into .kicad_sym…"),
        (ConversionStage.EXPORT_FOOTPRINT, 90, "Writing .kicad_mod file…"),
    ]
    out = result or _StubResult(
        symbol_path="/tmp/lib.kicad_sym",
        footprint_path="/tmp/lib.pretty/R0603.kicad_mod",
        messages=[],
    )

    def _inner(_request: ConversionRequest, cb: Callable[..., None]) -> _StubResult:
        for stage, pct, msg in steps:
            cb(stage, pct, msg)
        return out

    return _inner


# ---------------------------------------------------------------------------
# run_phase2_conversion — params validation
# ---------------------------------------------------------------------------


def test_rejects_missing_lcsc_id() -> None:
    with pytest.raises(ValueError, match="lcscId"):
        run_phase2_conversion(
            {"libraryPath": "/tmp/lib"}, emit=lambda *_: None, conversion_runner=_stub_runner()
        )


def test_rejects_invalid_lcsc_id_pattern() -> None:
    with pytest.raises(ValueError, match="invalid lcscId"):
        run_phase2_conversion(
            {"lcscId": "X42", "libraryPath": "/tmp/lib"},
            emit=lambda *_: None,
            conversion_runner=_stub_runner(),
        )


def test_rejects_missing_library_path() -> None:
    with pytest.raises(ValueError, match="libraryPath"):
        run_phase2_conversion(
            {"lcscId": "C22548"}, emit=lambda *_: None, conversion_runner=_stub_runner()
        )


def test_strips_kicad_sym_suffix_from_library_path() -> None:
    """Callers (SW) may send either the prefix or the full .kicad_sym path —
    the runner normalizes both onto the prefix the inner pipeline expects.
    """
    seen: dict[str, Any] = {}

    def runner(request: ConversionRequest, _cb: Callable[..., None]) -> _StubResult:
        seen["output_prefix"] = request.output_prefix
        return _StubResult(symbol_path=f"{request.output_prefix}.kicad_sym")

    result = run_phase2_conversion(
        {"lcscId": "C22548", "libraryPath": "/tmp/MyLib.kicad_sym"},
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    assert seen["output_prefix"].endswith("MyLib")
    assert not seen["output_prefix"].endswith(".kicad_sym")
    assert result["libraryPath"] == "/tmp/MyLib"


# ---------------------------------------------------------------------------
# run_phase2_conversion — progress fan-out
# ---------------------------------------------------------------------------


def test_emits_at_least_two_progress_messages() -> None:
    """ADR-0004 + Issue #4 acceptance: 'Mindestens 2 progress-Messages
    werden gestreamed und im Button-UI sichtbar.'"""
    seen: list[tuple[str, Optional[int]]] = []
    run_phase2_conversion(
        {"lcscId": "C22548", "libraryPath": "/tmp/MyLib"},
        emit=lambda msg, pct: seen.append((msg, pct)),
        conversion_runner=_stub_runner(),
    )
    assert len(seen) >= 2, f"expected ≥2 progress emits, got {seen!r}"


def test_progress_messages_carry_inner_pipeline_text() -> None:
    """The inner pipeline already labels each step ('Writing symbol into …').
    The runner forwards that text verbatim — UI shows what the pipeline says.
    """
    seen: list[tuple[str, Optional[int]]] = []
    run_phase2_conversion(
        {"lcscId": "C22548", "libraryPath": "/tmp/MyLib"},
        emit=lambda msg, pct: seen.append((msg, pct)),
        conversion_runner=_stub_runner(
            progress_steps=[
                (ConversionStage.EXPORT_SYMBOL, 50, "Writing symbol into .kicad_sym…"),
                (ConversionStage.EXPORT_FOOTPRINT, 95, "Writing .kicad_mod file…"),
            ]
        ),
    )
    inner_texts = [m for m, _ in seen]
    assert "Writing symbol into .kicad_sym…" in inner_texts
    assert "Writing .kicad_mod file…" in inner_texts


def test_returns_result_with_symbol_and_footprint_paths() -> None:
    out = run_phase2_conversion(
        {"lcscId": "C22548", "libraryPath": "/tmp/MyLib"},
        emit=lambda *_: None,
        conversion_runner=_stub_runner(
            result=_StubResult(
                symbol_path="/tmp/MyLib.kicad_sym",
                footprint_path="/tmp/MyLib.pretty/R0603.kicad_mod",
            )
        ),
    )
    assert out["lcscId"] == "C22548"
    assert out["libraryPath"] == "/tmp/MyLib"
    assert out["symbolPath"] == "/tmp/MyLib.kicad_sym"
    assert out["footprintPath"] == "/tmp/MyLib.pretty/R0603.kicad_mod"


def test_request_passed_to_runner_omits_3d_layer() -> None:
    """Issue #4: 'default-path: EasyEDA-Pipeline ohne 3D-Layer (kommt in #6).'

    Verify the ConversionRequest the runner sees has ``generate_model=False``.
    Symbol + Footprint must be enabled so the conversion writes both files.
    """
    seen: dict[str, ConversionRequest] = {}

    def runner(request: ConversionRequest, _cb: Callable[..., None]) -> _StubResult:
        seen["req"] = request
        return _StubResult()

    run_phase2_conversion(
        {"lcscId": "C22548", "libraryPath": "/tmp/MyLib"},
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    req = seen["req"]
    assert req.generate_symbol is True
    assert req.generate_footprint is True
    assert req.generate_model is False
    assert req.lcsc_id == "C22548"


# ---------------------------------------------------------------------------
# Issue #28 — Register slice: labelMapping × pageParams → symbol_params
# ---------------------------------------------------------------------------


def _capturing_runner() -> tuple[dict[str, ConversionRequest], Callable[..., _StubResult]]:
    """Return a runner that records the ConversionRequest it sees + the seen dict."""
    seen: dict[str, ConversionRequest] = {}

    def runner(request: ConversionRequest, _cb: Callable[..., None]) -> _StubResult:
        seen["req"] = request
        return _StubResult(
            symbol_path="/tmp/MyLib.kicad_sym",
            footprint_path="/tmp/MyLib.pretty/R0603.kicad_mod",
        )

    return seen, runner


def test_all_page_params_become_symbol_properties() -> None:
    """ADR-0006 (refined): Phase 2 upserts ALL scraped LCSC params as symbol
    Properties — property name is the LCSC label, no manual mapping.

    Demoable: registered part → Symbol from Template, Properties populated
    from the full LCSC spec table.
    """
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {
            "lcscId": "C22548",
            "libraryPath": "/tmp/MyLib",
            "overrides": {
                "symbol": {
                    "source": "template",
                    "libPath": "/tmp/MyTemplates.kicad_sym",
                    "name": "R0603",
                },
                "footprint": {"source": "easyeda"},
            },
            "pageParams": {
                "Resistance": "10k",
                "Tolerance": "1%",
                "Power(Watts)": "0.25W",
                "Mfr. Part #": "RC0603FR-0710KL",
            },
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    req = seen["req"]
    assert req.use_template is True
    assert req.template_name == "R0603"
    # Every param flows through; the property name is the LCSC label verbatim.
    assert req.symbol_params == {
        "Resistance": "10k",
        "Tolerance": "1%",
        "Power(Watts)": "0.25W",
        "Mfr. Part #": "RC0603FR-0710KL",
    }


def test_template_pin_map_flows_into_conversion_request() -> None:
    """Gallery/template Pin↔Pad map reaches ConversionRequest.template_pin_map so
    V3 convert can run the gallery's symbol-pin remap (footprint stays EasyEDA)."""
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {
            "lcscId": "C22548",
            "libraryPath": "/tmp/MyLib",
            "overrides": {
                "symbol": {
                    "source": "template",
                    "libPath": "/tmp/MyTemplates.kicad_sym",
                    "name": "R0603",
                },
                "footprint": {"source": "easyeda"},
            },
            "templatePinMap": {"1": "A", "2": "K"},
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    assert seen["req"].template_pin_map == {"1": "A", "2": "K"}


def test_template_pin_map_ignored_without_template_symbol() -> None:
    """A pin map only applies to a template symbol; EasyEDA symbol → ignored."""
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {
            "lcscId": "C22548",
            "libraryPath": "/tmp/MyLib",
            "overrides": {
                "symbol": {"source": "easyeda"},
                "footprint": {"source": "easyeda"},
            },
            "templatePinMap": {"1": "A"},
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    assert seen["req"].template_pin_map is None


def test_missing_page_params_skips_symbol_params_injection() -> None:
    """A registered rule with mapping but no page snapshot → no symbol_params."""
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {
            "lcscId": "C22548",
            "libraryPath": "/tmp/MyLib",
            "labelMapping": {"Resistance": "Value"},
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    assert seen["req"].symbol_params is None


def test_no_page_params_leaves_symbol_params_none() -> None:
    """No pageParams at all → no Property injection (default-path unchanged)."""
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {
            "lcscId": "C22548",
            "libraryPath": "/tmp/MyLib",
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    assert seen["req"].symbol_params is None


def test_blank_page_param_values_are_skipped() -> None:
    """A param with a blank value is silently skipped (no empty Property)."""
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {
            "lcscId": "C22548",
            "libraryPath": "/tmp/MyLib",
            "pageParams": {"Resistance": "10k", "Tolerance": "  "},
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    assert seen["req"].symbol_params == {"Resistance": "10k"}


# ---------------------------------------------------------------------------
# host.handle — convert RPC dispatch + progress streaming
# ---------------------------------------------------------------------------


def _convert_request(req_id: Any = 7, lcsc_id: str = "C22548") -> dict[str, Any]:
    return {
        "id": req_id,
        "verb": "convert",
        "params": {"lcscId": lcsc_id, "libraryPath": "/tmp/MyLib"},
    }


def _outer_runner_with(
    inner: Callable[[ConversionRequest, Callable[..., None]], _StubResult],
) -> Callable[..., dict[str, Any]]:
    """Wrap an inner-pipeline stub as the outer ``run_phase2_conversion``
    runner ``host.handle`` expects (``(params, emit) -> dict``).

    Tests that drive ``host.handle`` directly route the inner pipeline through
    the real ``run_phase2_conversion`` so validation + outer progress framing
    are exercised end-to-end.
    """

    def _outer(params: Any, emit: Callable[..., None]) -> dict[str, Any]:
        return run_phase2_conversion(params, emit, conversion_runner=inner)

    return _outer


def test_handle_convert_streams_progress_before_terminal_done() -> None:
    """Each ``emit`` call from the runner becomes one Native-Messaging frame
    on the same port — verifies the wiring for the streamed-progress contract
    from ADR-0004.
    """
    emitted: list[dict[str, Any]] = []

    response = host.handle(
        _convert_request(),
        conversion_runner=_outer_runner_with(_stub_runner()),
        emit=emitted.append,
    )

    # Terminal frame returned from handle() itself (host main() then writes it).
    assert response["id"] == 7
    assert response["ok"] is True
    assert response["result"]["symbolPath"]

    # Streamed frames arrived before the terminal one — each carries the
    # same request id and the ``progress`` type marker the SW filters on.
    assert len(emitted) >= 2
    for frame in emitted:
        assert frame["id"] == 7
        assert frame["type"] == "progress"
        assert isinstance(frame["message"], str) and frame["message"]
    # progress percentages forwarded through as integers.
    pct_values = [f.get("progress") for f in emitted if "progress" in f]
    assert all(isinstance(p, int) for p in pct_values)


def test_handle_convert_returns_validation_error_for_bad_lcsc_id() -> None:
    """Invalid LCSC ID → ``error`` envelope, no busy bleed."""
    response = host.handle(
        {
            "id": 5,
            "verb": "convert",
            "params": {"lcscId": "X42", "libraryPath": "/tmp/MyLib"},
        },
        conversion_runner=_outer_runner_with(_stub_runner()),
    )
    assert response["id"] == 5
    assert response["ok"] is False
    assert "lcscId" in response["error"]


def test_handle_convert_propagates_pipeline_error_as_rpc_error() -> None:
    """A ConversionError from the inner pipeline becomes a clear RPC error
    the button UI can render — not an exception crash on the port."""

    def boom(_request: ConversionRequest, _cb: Callable[..., None]) -> _StubResult:
        raise ConversionError("Failed to fetch data for C22548: HTTP 404")

    response = host.handle(
        _convert_request(),
        conversion_runner=_outer_runner_with(boom),
    )
    assert response["ok"] is False
    assert "C22548" in response["error"]
    assert "404" in response["error"]


def test_handle_convert_busy_when_phase1_in_flight() -> None:
    """A ``convert`` call while a ``fetchMetadata`` is mid-flight returns
    ``busy`` — same lock per ADR-0004, no overlap between phases.
    """
    in_handler = threading.Event()
    release = threading.Event()

    def slow_fetcher(_lcsc_id: str, _hints: Optional[dict[str, Any]]) -> dict[str, Any]:
        in_handler.set()
        release.wait(timeout=2)
        return {"lcscId": "C22548", "categoryPath": None, "pinCount": 0, "datasheetUrl": None}

    results: dict[str, Any] = {}

    def first() -> None:
        results["first"] = host.handle(
            {"id": 1, "verb": "fetchMetadata", "params": {"lcscId": "C22548"}},
            metadata_fetcher=slow_fetcher,
        )

    t = threading.Thread(target=first)
    t.start()
    assert in_handler.wait(timeout=2), "first handler did not start"

    second = host.handle(
        _convert_request(req_id=2),
        conversion_runner=_outer_runner_with(_stub_runner()),
    )
    assert second["ok"] is False
    assert second["error"] == "busy"
    assert second["id"] == 2

    release.set()
    t.join(timeout=2)
    assert results["first"]["ok"] is True


def test_handle_convert_releases_busy_lock_after_terminal_done() -> None:
    """First conversion completes, second one (same lock) must proceed."""
    first = host.handle(
        _convert_request(req_id=1),
        conversion_runner=_outer_runner_with(_stub_runner()),
    )
    assert first["ok"] is True
    second = host.handle(
        _convert_request(req_id=2),
        conversion_runner=_outer_runner_with(_stub_runner()),
    )
    assert second["ok"] is True


def test_handle_convert_releases_busy_lock_after_error() -> None:
    """Even when the inner pipeline raises, the lock must clear — otherwise
    the host would wedge after a single transient failure."""

    def boom(_request: ConversionRequest, _cb: Callable[..., None]) -> _StubResult:
        raise ConversionError("transient")

    failing = host.handle(
        _convert_request(req_id=1),
        conversion_runner=_outer_runner_with(boom),
    )
    assert failing["ok"] is False
    follow_up = host.handle(
        _convert_request(req_id=2),
        conversion_runner=_outer_runner_with(_stub_runner()),
    )
    assert follow_up["ok"] is True


def test_handle_convert_tolerates_missing_emit_for_unit_tests() -> None:
    """When the host is driven from a test that doesn't care about progress
    frames (no ``emit`` supplied), the convert RPC still completes and just
    drops the progress notifications on the floor.
    """
    response = host.handle(
        _convert_request(req_id=42),
        conversion_runner=_outer_runner_with(_stub_runner()),
        # no ``emit`` argument
    )
    assert response["ok"] is True
    assert response["id"] == 42


# ---------------------------------------------------------------------------
# Issue #5 — Override Panel: symbol/footprint source override
# ---------------------------------------------------------------------------


def test_default_path_omits_template_fields() -> None:
    """No ``overrides`` ⇒ pre-#5 default-path: EasyEDA symbol + footprint."""
    seen: dict[str, ConversionRequest] = {}

    def runner(request: ConversionRequest, _cb: Callable[..., None]) -> _StubResult:
        seen["req"] = request
        return _StubResult(symbol_path=f"{request.output_prefix}.kicad_sym")

    run_phase2_conversion(
        {"lcscId": "C22548", "libraryPath": "/tmp/MyLib"},
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    req = seen["req"]
    assert req.use_template is False
    assert req.template_name is None
    assert req.template_lib_path is None
    assert req.force_template is False


def test_symbol_template_override_flows_into_request() -> None:
    """Override Panel symbol=Template-X ⇒ ConversionRequest carries the
    template name + lib path so the existing TemplateMerger pipeline writes
    the user-picked symbol instead of the EasyEDA one.

    Acceptance criterion (Issue #5): 'Python convert mit overrides.symbol=
    Template-X schreibt das Template-Symbol (nicht EasyEDA-Symbol) in die
    Library.'
    """
    seen: dict[str, ConversionRequest] = {}

    def runner(request: ConversionRequest, _cb: Callable[..., None]) -> _StubResult:
        seen["req"] = request
        return _StubResult(symbol_path=f"{request.output_prefix}.kicad_sym")

    run_phase2_conversion(
        {
            "lcscId": "C22548",
            "libraryPath": "/tmp/MyLib",
            "overrides": {
                "symbol": {
                    "source": "template",
                    "libPath": "/home/user/Templates.kicad_sym",
                    "name": "R0603_Custom",
                },
                "footprint": {"source": "easyeda"},
            },
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    req = seen["req"]
    assert req.use_template is True
    assert req.template_name == "R0603_Custom"
    assert req.template_lib_path == "/home/user/Templates.kicad_sym"
    # ``force_template`` makes a missing template a hard error rather than a
    # silent EasyEDA fallback the user did not pick.
    assert req.force_template is True


def test_overrides_with_explicit_easyeda_is_equivalent_to_default_path() -> None:
    """``{source: 'easyeda'}`` for both layers is the explicit form of the
    default-path — must not toggle ``use_template`` on."""
    seen: dict[str, ConversionRequest] = {}

    def runner(request: ConversionRequest, _cb: Callable[..., None]) -> _StubResult:
        seen["req"] = request
        return _StubResult(symbol_path=f"{request.output_prefix}.kicad_sym")

    run_phase2_conversion(
        {
            "lcscId": "C22548",
            "libraryPath": "/tmp/MyLib",
            "overrides": {
                "symbol": {"source": "easyeda"},
                "footprint": {"source": "easyeda"},
            },
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    assert seen["req"].use_template is False
    assert seen["req"].template_name is None


def test_symbol_template_override_requires_lib_path() -> None:
    with pytest.raises(ValueError, match="overrides.symbol.libPath"):
        run_phase2_conversion(
            {
                "lcscId": "C22548",
                "libraryPath": "/tmp/MyLib",
                "overrides": {
                    "symbol": {"source": "template", "name": "R0603"},
                    "footprint": {"source": "easyeda"},
                },
            },
            emit=lambda *_: None,
            conversion_runner=_stub_runner(),
        )


def test_symbol_template_override_requires_name() -> None:
    with pytest.raises(ValueError, match="overrides.symbol.name"):
        run_phase2_conversion(
            {
                "lcscId": "C22548",
                "libraryPath": "/tmp/MyLib",
                "overrides": {
                    "symbol": {
                        "source": "template",
                        "libPath": "/home/user/T.kicad_sym",
                    },
                    "footprint": {"source": "easyeda"},
                },
            },
            emit=lambda *_: None,
            conversion_runner=_stub_runner(),
        )


def test_rejects_unknown_source_value() -> None:
    with pytest.raises(ValueError, match="must be 'easyeda' or 'template'"):
        run_phase2_conversion(
            {
                "lcscId": "C22548",
                "libraryPath": "/tmp/MyLib",
                "overrides": {
                    "symbol": {"source": "lcsc-cad"},
                    "footprint": {"source": "easyeda"},
                },
            },
            emit=lambda *_: None,
            conversion_runner=_stub_runner(),
        )


def test_footprint_template_override_flows_into_request() -> None:
    """#9: Override Panel footprint=Template-X ⇒ ConversionRequest carries the
    footprint template fields so the engine copies the curated ``.kicad_mod``
    into the library instead of building the EasyEDA footprint. ``libPath`` is
    the source ``.pretty`` dir. ``force_footprint_template`` makes a missing
    template a hard error, not a silent EasyEDA fallback.
    """
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {
            "lcscId": "C22548",
            "libraryPath": "/tmp/MyLib",
            "overrides": {
                "symbol": {"source": "easyeda"},
                "footprint": {
                    "source": "template",
                    "libPath": "/home/user/Templates.pretty",
                    "name": "R0603_HandSolder",
                },
            },
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    req = seen["req"]
    assert req.use_footprint_template is True
    assert req.footprint_template_name == "R0603_HandSolder"
    assert req.footprint_template_lib_path == "/home/user/Templates.pretty"
    assert req.force_footprint_template is True


def test_footprint_template_and_symbol_template_combine() -> None:
    """The keystone case: both layers from template. The request carries the
    symbol AND footprint template fields so a full curated import lands."""
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {
            "lcscId": "C22548",
            "libraryPath": "/tmp/MyLib",
            "overrides": {
                "symbol": {
                    "source": "template",
                    "libPath": "/home/user/Templates.kicad_sym",
                    "name": "R0603",
                },
                "footprint": {
                    "source": "template",
                    "libPath": "/home/user/Templates.pretty",
                    "name": "R0603",
                },
            },
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    req = seen["req"]
    assert req.use_template is True
    assert req.use_footprint_template is True
    assert req.footprint_template_name == "R0603"
    assert req.footprint_template_lib_path == "/home/user/Templates.pretty"


def test_footprint_template_override_requires_lib_path() -> None:
    with pytest.raises(ValueError, match="overrides.footprint.libPath"):
        run_phase2_conversion(
            {
                "lcscId": "C22548",
                "libraryPath": "/tmp/MyLib",
                "overrides": {
                    "symbol": {"source": "easyeda"},
                    "footprint": {"source": "template", "name": "R0603"},
                },
            },
            emit=lambda *_: None,
            conversion_runner=_stub_runner(),
        )


def test_footprint_template_override_requires_name() -> None:
    with pytest.raises(ValueError, match="overrides.footprint.name"):
        run_phase2_conversion(
            {
                "lcscId": "C22548",
                "libraryPath": "/tmp/MyLib",
                "overrides": {
                    "symbol": {"source": "easyeda"},
                    "footprint": {
                        "source": "template",
                        "libPath": "/home/user/Templates.pretty",
                    },
                },
            },
            emit=lambda *_: None,
            conversion_runner=_stub_runner(),
        )


def test_default_path_omits_footprint_template_fields() -> None:
    """No overrides ⇒ footprint template fields stay off (EasyEDA footprint)."""
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {"lcscId": "C22548", "libraryPath": "/tmp/MyLib"},
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    req = seen["req"]
    assert req.use_footprint_template is False
    assert req.footprint_template_name is None
    assert req.footprint_template_lib_path is None
    assert req.force_footprint_template is False


def test_handle_convert_returns_validation_error_for_bad_overrides() -> None:
    """Bad overrides shape → ``error`` envelope, not a process crash."""
    response = host.handle(
        {
            "id": 9,
            "verb": "convert",
            "params": {
                "lcscId": "C22548",
                "libraryPath": "/tmp/MyLib",
                "overrides": "not-an-object",
            },
        },
        conversion_runner=_outer_runner_with(_stub_runner()),
    )
    assert response["id"] == 9
    assert response["ok"] is False
    assert "overrides" in response["error"]


def test_handle_convert_template_override_round_trip() -> None:
    """End-to-end through ``host.handle``: the overrides payload reaches the
    runner and the request hands the template fields to the inner pipeline.
    """
    seen: dict[str, ConversionRequest] = {}

    def inner(request: ConversionRequest, _cb: Callable[..., None]) -> _StubResult:
        seen["req"] = request
        return _StubResult(symbol_path=f"{request.output_prefix}.kicad_sym")

    response = host.handle(
        {
            "id": 11,
            "verb": "convert",
            "params": {
                "lcscId": "C22548",
                "libraryPath": "/tmp/MyLib",
                "overrides": {
                    "symbol": {
                        "source": "template",
                        "libPath": "/home/user/Templates.kicad_sym",
                        "name": "R0603",
                    },
                    "footprint": {"source": "easyeda"},
                },
            },
        },
        conversion_runner=_outer_runner_with(inner),
    )
    assert response["ok"] is True
    req = seen["req"]
    assert req.use_template is True
    assert req.template_name == "R0603"
    assert req.template_lib_path == "/home/user/Templates.kicad_sym"


def test_pin_visibility_flags_flow_into_conversion_request() -> None:
    """hidePinNumbers/hidePinNames params reach ConversionRequest — the engine
    then hides them on both symbol paths (template merger + EasyEDA exporter)."""
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {
            "lcscId": "C22548",
            "libraryPath": "/tmp/MyLib",
            "hidePinNumbers": True,
            "hidePinNames": True,
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    assert seen["req"].hide_pin_numbers is True
    assert seen["req"].hide_pin_names is True


def test_pin_visibility_flags_default_false() -> None:
    """Omitted pin-visibility params → ConversionRequest defaults to False."""
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {"lcscId": "C22548", "libraryPath": "/tmp/MyLib"},
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    assert seen["req"].hide_pin_numbers is False
    assert seen["req"].hide_pin_names is False


def test_value_param_fills_value_override_and_excludes_property() -> None:
    """valueParam → ConversionRequest.symbol_value_override (Ω-stripped for
    Resistance) AND the chosen key is excluded from symbol_params (no dup)."""
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {
            "lcscId": "C22548",
            "libraryPath": "/tmp/MyLib",
            "valueParam": "Resistance",
            "pageParams": {"Resistance": "10kΩ", "Tolerance": "1%"},
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    req = seen["req"]
    assert req.symbol_value_override == "10k"  # Ω stripped
    assert req.symbol_value_param_key == "Resistance"
    # The Value-Param is NOT also written as a duplicate Property.
    assert req.symbol_params == {"Tolerance": "1%"}


def test_value_param_non_resistance_keeps_unit() -> None:
    """Only Resistance gets the Ω-strip; other params pass through verbatim."""
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {
            "lcscId": "C1",
            "libraryPath": "/tmp/MyLib",
            "valueParam": "Capacitance",
            "pageParams": {"Capacitance": "100nF"},
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    assert seen["req"].symbol_value_override == "100nF"
    assert seen["req"].symbol_value_param_key == "Capacitance"


def test_value_param_missing_key_is_tolerated() -> None:
    """valueParam pointing at an absent key → no override, no crash."""
    seen, runner = _capturing_runner()
    run_phase2_conversion(
        {
            "lcscId": "C1",
            "libraryPath": "/tmp/MyLib",
            "valueParam": "Resistance",
            "pageParams": {"Tolerance": "1%"},
        },
        emit=lambda *_: None,
        conversion_runner=runner,
    )
    assert seen["req"].symbol_value_override is None
    assert seen["req"].symbol_value_param_key is None
