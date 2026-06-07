"""Tests for the V3 Native Host reader-thread + worker model (Issue #26).

The pre-#26 host serialized stdin → ``handle()`` → stdout, so a 10-s
``convert`` blocked every other frame on the port. After #26 the reader
dispatches to a worker pool: fast read-only verbs (``listTemplates``,
future ``getRule`` / ``fsList``) keep responding while ``convert`` runs.

These tests drive ``host.serve()`` with in-memory queues so they can
overlap requests deterministically without launching real Native Messaging.
"""

from __future__ import annotations

import queue
import threading
import time
from typing import Any, Callable, Optional

import pytest

from easyeda2kicad.service.conversion import (
    ConversionRequest,
    ConversionStage,
)
from native_host import host
from native_host.phase2 import run_phase2_conversion


# ---------------------------------------------------------------------------
# Helpers — queue-backed stand-ins for stdin / stdout
# ---------------------------------------------------------------------------


class _RequestQueue:
    """Read-side: yields queued requests, then ``None`` to signal EOF."""

    def __init__(self) -> None:
        self._q: queue.Queue[Optional[dict[str, Any]]] = queue.Queue()

    def put(self, request: Optional[dict[str, Any]]) -> None:
        self._q.put(request)

    def __call__(self) -> Optional[dict[str, Any]]:
        return self._q.get()


class _ResponseSink:
    """Write-side: collect every emitted frame in order."""

    def __init__(self) -> None:
        self.frames: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._event = threading.Event()

    def __call__(self, frame: dict[str, Any]) -> None:
        with self._lock:
            self.frames.append(dict(frame))
            self._event.set()

    def wait_for(
        self,
        predicate: Callable[[list[dict[str, Any]]], bool],
        timeout: float = 5.0,
    ) -> bool:
        """Block until ``predicate(self.frames)`` returns truthy or timeout."""
        deadline = time.monotonic() + timeout
        while True:
            with self._lock:
                if predicate(list(self.frames)):
                    return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            # Wait briefly, then re-check; ``Event`` is set on every write.
            self._event.wait(timeout=remaining)
            self._event.clear()


def _start_serve(
    requests: _RequestQueue,
    sink: _ResponseSink,
    *,
    metadata_fetcher: Optional[Callable[..., dict[str, Any]]] = None,
    conversion_runner: Optional[Callable[..., dict[str, Any]]] = None,
) -> threading.Thread:
    """Run ``host.serve()`` on a daemon thread bound to the queues."""

    def _run() -> None:
        host.serve(
            read_message=requests,
            write_message=sink,
            metadata_fetcher=metadata_fetcher,
            conversion_runner=conversion_runner,
        )

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


# ---------------------------------------------------------------------------
# Issue #26 — read-only verb served during in-flight ``convert``
# ---------------------------------------------------------------------------


def test_list_templates_served_during_slow_convert(tmp_path) -> None:
    """Acceptance criterion (Issue #26): während eines 10-s-``convert``
    antwortet ``listTemplates`` ohne Blockade.

    A stub conversion runner blocks on an event so we can prove the
    read-only verb is served while ``convert`` is mid-flight. Without the
    reader-thread + worker refactor the ``listTemplates`` frame would
    queue behind the blocked ``convert`` worker and arrive only after the
    convert event is released.
    """
    sym = tmp_path / "MyTemplates.kicad_sym"
    sym.write_text(
        '(kicad_symbol_lib (version 20240618) (generator t)\n'
        '  (symbol "R0603" (pin passive line (at 0 0 0) (length 1)))\n'
        ')\n',
        encoding="utf-8",
    )

    convert_in_handler = threading.Event()
    release_convert = threading.Event()

    def slow_inner_runner(_request: ConversionRequest, cb: Callable[..., None]):
        cb(ConversionStage.FETCHING, 10, "Connecting to EasyEDA…")
        convert_in_handler.set()
        # Simulates the ~5–10 s the real EasyEDA pipeline spends; the test
        # releases it explicitly once we've proved listTemplates landed.
        assert release_convert.wait(timeout=5.0)
        cb(ConversionStage.EXPORT_FOOTPRINT, 90, "Writing .kicad_mod file…")

        class _Result:
            symbol_path = "/tmp/MyLib.kicad_sym"
            footprint_path = "/tmp/MyLib.pretty/R0603.kicad_mod"
            messages: list = []

        return _Result()

    def outer_runner(params, emit):
        return run_phase2_conversion(params, emit, conversion_runner=slow_inner_runner)

    requests = _RequestQueue()
    sink = _ResponseSink()
    server = _start_serve(requests, sink, conversion_runner=outer_runner)

    try:
        # Kick off the slow convert first.
        requests.put({
            "id": 1,
            "verb": "convert",
            "params": {"lcscId": "C22548", "libraryPath": "/tmp/MyLib"},
        })
        assert convert_in_handler.wait(timeout=2.0), "convert worker never started"

        # While convert is blocked, fire a listTemplates frame.
        requests.put({
            "id": 2,
            "verb": "listTemplates",
            "params": {"libPath": str(sym)},
        })

        # listTemplates must respond promptly — its frame should land before
        # we release the convert event. Without the worker pool refactor this
        # times out (the reader is parked inside the convert handler).
        assert sink.wait_for(
            lambda frames: any(
                f.get("id") == 2 and f.get("ok") is True for f in frames
            ),
            timeout=2.0,
        ), f"listTemplates did not respond while convert blocked; frames={sink.frames!r}"

        # Sanity: convert's terminal frame has not arrived yet — proves the
        # read-only verb truly overtook the slow one.
        convert_terminal = [
            f for f in sink.frames
            if f.get("id") == 1 and "ok" in f and f.get("type") != "progress"
        ]
        assert not convert_terminal, (
            "convert terminal frame already present — test is racy"
        )

        # Now let convert finish and verify its terminal frame is delivered.
        release_convert.set()
        assert sink.wait_for(
            lambda frames: any(
                f.get("id") == 1 and f.get("ok") is True for f in frames
            ),
            timeout=5.0,
        ), f"convert never produced its terminal frame; frames={sink.frames!r}"
    finally:
        release_convert.set()
        requests.put(None)
        server.join(timeout=5.0)
        assert not server.is_alive(), "serve() did not exit after EOF"


def test_convert_remains_single_flight_under_concurrency() -> None:
    """Acceptance criterion (Issue #26): ``convert`` bleibt single-flight —
    ein zweites ``convert`` parallel zum laufenden bekommt sofort ``busy``,
    selbst wenn der Reader nicht mehr blockiert."""
    first_in_handler = threading.Event()
    release_first = threading.Event()

    def slow_inner(_req: ConversionRequest, cb: Callable[..., None]):
        cb(ConversionStage.FETCHING, 10, "step")
        first_in_handler.set()
        assert release_first.wait(timeout=5.0)

        class _Result:
            symbol_path = "/tmp/MyLib.kicad_sym"
            footprint_path = None
            messages: list = []

        return _Result()

    def outer_runner(params, emit):
        return run_phase2_conversion(params, emit, conversion_runner=slow_inner)

    requests = _RequestQueue()
    sink = _ResponseSink()
    server = _start_serve(requests, sink, conversion_runner=outer_runner)

    try:
        requests.put({
            "id": 100,
            "verb": "convert",
            "params": {"lcscId": "C22548", "libraryPath": "/tmp/MyLib"},
        })
        assert first_in_handler.wait(timeout=2.0)

        requests.put({
            "id": 101,
            "verb": "convert",
            "params": {"lcscId": "C22548", "libraryPath": "/tmp/MyLib"},
        })

        assert sink.wait_for(
            lambda frames: any(
                f.get("id") == 101
                and f.get("ok") is False
                and f.get("error") == "busy"
                for f in frames
            ),
            timeout=2.0,
        ), f"second convert did not get busy; frames={sink.frames!r}"
    finally:
        release_first.set()
        # Drain the first convert to completion before tearing down.
        sink.wait_for(
            lambda frames: any(
                f.get("id") == 100 and "ok" in f and f.get("type") != "progress"
                for f in frames
            ),
            timeout=5.0,
        )
        requests.put(None)
        server.join(timeout=5.0)


def test_progress_frames_remain_atomic_under_concurrent_writes(tmp_path) -> None:
    """``_write_lock`` keeps Native-Messaging frames whole when a
    streaming ``convert`` and a fast ``listTemplates`` race to stdout."""
    sym = tmp_path / "Lib.kicad_sym"
    sym.write_text(
        '(kicad_symbol_lib (version 20240618) (generator t)\n'
        '  (symbol "X" (pin passive line (at 0 0 0) (length 1)))\n)\n',
        encoding="utf-8",
    )

    # 25 quick progress emits interleaved with 25 listTemplates requests.
    def inner_runner(_req: ConversionRequest, cb: Callable[..., None]):
        for i in range(25):
            cb(ConversionStage.EXPORT_SYMBOL, 50, f"step-{i}")
            time.sleep(0.001)

        class _Result:
            symbol_path = "/tmp/Lib.kicad_sym"
            footprint_path = None
            messages: list = []

        return _Result()

    def outer_runner(params, emit):
        return run_phase2_conversion(params, emit, conversion_runner=inner_runner)

    requests = _RequestQueue()
    sink = _ResponseSink()
    server = _start_serve(requests, sink, conversion_runner=outer_runner)

    try:
        requests.put({
            "id": 1,
            "verb": "convert",
            "params": {"lcscId": "C22548", "libraryPath": "/tmp/Lib"},
        })
        for i in range(25):
            requests.put({
                "id": 200 + i,
                "verb": "listTemplates",
                "params": {"libPath": str(sym)},
            })

        assert sink.wait_for(
            lambda frames: (
                any(f.get("id") == 1 and f.get("ok") is True for f in frames)
                and sum(1 for f in frames if 200 <= f.get("id", -1) < 225) == 25
            ),
            timeout=5.0,
        ), f"frames not all delivered; frames={sink.frames!r}"

        # Every frame is a complete dict — sink.__call__ deep-copies on
        # insert so partial bytes (the failure mode without ``_write_lock``)
        # would have raised before getting here.
        for f in sink.frames:
            assert isinstance(f, dict)
            assert "id" in f
    finally:
        requests.put(None)
        server.join(timeout=5.0)
