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
