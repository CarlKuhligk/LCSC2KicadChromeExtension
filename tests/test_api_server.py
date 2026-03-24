import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi.testclient import TestClient

from easyeda2kicad.api.models import TaskCreatePayload
from easyeda2kicad.api.server import create_app
from easyeda2kicad.service import ConversionRequest, ConversionResult, ConversionStage


def _dummy_runner(
    request: ConversionRequest, progress_cb
) -> ConversionResult:  # pragma: no cover - exercised through API
    result = ConversionResult(symbol_path=str(Path(request.output_prefix).resolve()))
    if progress_cb:
        progress_cb(ConversionStage.FETCHING, 50, "Fetching")
        progress_cb(ConversionStage.COMPLETED, 100, "Done")
    result.messages.append("ok")
    return result


def _ws_rpc(ws, req_id: str, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    ws.send_json({"id": req_id, "method": method, "params": params or {}})
    while True:
        msg = ws.receive_json()
        if msg.get("id") == req_id:
            if msg.get("error"):
                raise AssertionError(msg["error"])
            return msg["result"]
        # Ignore task_update pushes while waiting for RPC reply
        if msg.get("type") == "task_update":
            continue


class TaskApiTest(unittest.TestCase):
    def test_enqueue_and_complete(self) -> None:
        app = create_app(conversion_runner=_dummy_runner)
        with TestClient(app) as client, client.websocket_connect("/ws/extension") as ws:
            ws.send_json(
                {
                    "id": "1",
                    "method": "enqueue_task",
                    "params": {
                        "lcsc_id": "C1234",
                        "output_path": "./tmp/testlib",
                        "symbol": True,
                    },
                }
            )
            task_id: Optional[str] = None
            detail: Optional[dict] = None
            deadline = time.time() + 5.0
            while time.time() < deadline and (not task_id or not detail):
                msg = ws.receive_json()
                if msg.get("id") == "1":
                    task_id = msg["result"]["id"]
                # Final broadcast may follow a brief "completed" snapshot without result filled — wait for both.
                if msg.get("type") == "task_update" and msg.get("payload", {}).get("status") == "completed":
                    pl = msg["payload"]
                    if pl.get("result") is not None:
                        detail = pl
            self.assertIsNotNone(task_id)
            self.assertIsNotNone(detail)
            assert detail is not None
            self.assertEqual(detail["status"], "completed")
            expected_path = str(Path("./tmp/testlib").resolve())
            self.assertEqual(detail["result"]["symbol_path"], expected_path)

    def test_filesystem_helpers(self) -> None:
        app = create_app(conversion_runner=_dummy_runner)
        with TestClient(app) as client, client.websocket_connect("/ws/extension") as ws:
            data = _ws_rpc(ws, "a", "fs_roots")
            self.assertIsInstance(data, list)
            self.assertGreater(len(data), 0)

            first_root = data[0]["path"]
            listing_data = _ws_rpc(ws, "b", "fs_list", {"path": first_root})
            self.assertEqual(listing_data["path"], str(Path(first_root).resolve()))

            check_data = _ws_rpc(ws, "c", "fs_check", {"path": first_root})
            self.assertTrue(check_data["resolved"])

    def test_overwrite_model_forwarded(self) -> None:
        captured = {}

        def runner(request: ConversionRequest, progress_cb) -> ConversionResult:
            captured["overwrite_model"] = request.overwrite_model
            if progress_cb:
                progress_cb(ConversionStage.FETCHING, 50, "Fetching")
                progress_cb(ConversionStage.COMPLETED, 100, "Done")
            result = ConversionResult(symbol_path=str(Path("./tmp/testlib").resolve()))
            result.messages.append("ok")
            return result

        app = create_app(conversion_runner=runner)
        with TestClient(app) as client, client.websocket_connect("/ws/extension") as ws:
            ws.send_json(
                {
                    "id": "1",
                    "method": "enqueue_task",
                    "params": {
                        "lcsc_id": "C5678",
                        "output_path": "./tmp/testlib",
                        "symbol": True,
                        "model": True,
                        "overwrite_model": True,
                    },
                }
            )
            deadline = time.time() + 5.0
            while time.time() < deadline:
                msg = ws.receive_json()
                if msg.get("type") == "task_update" and msg.get("payload", {}).get("status") == "completed":
                    break
            self.assertTrue(captured.get("overwrite_model"))

    def test_library_scaffold_and_validate(self) -> None:
        app = create_app(conversion_runner=_dummy_runner)
        with tempfile.TemporaryDirectory() as tmpdir, TestClient(app) as client, client.websocket_connect(
            "/ws/extension"
        ) as ws:
            payload = {
                "base_path": tmpdir,
                "library_name": "TestLib",
                "symbol": True,
                "footprint": True,
                "model": True,
            }
            data = _ws_rpc(ws, "s", "libraries_scaffold", payload)
            self.assertTrue(Path(data["symbol_path"]).is_file())
            self.assertTrue(Path(data["footprint_dir"]).is_dir())
            self.assertTrue(Path(data["model_dir"]).is_dir())

            validation = _ws_rpc(ws, "v1", "libraries_validate", {"path": data["resolved_library_prefix"]})
            self.assertTrue(validation["exists"])
            self.assertTrue(validation["is_dir"])
            self.assertTrue(validation["assets"]["symbol"])
            self.assertTrue(validation["assets"]["footprint"])
            self.assertTrue(validation["assets"]["model"])
            self.assertGreaterEqual(validation["counts"].get("symbol"), 0)
            self.assertIsInstance(validation["counts"].get("footprint"), int)
            self.assertIsInstance(validation["counts"].get("model"), int)

            validation_file = _ws_rpc(ws, "v2", "libraries_validate", {"path": data["symbol_path"]})
            self.assertEqual(
                Path(validation_file["resolved_path"]).resolve(),
                Path(data["symbol_path"]).resolve(),
            )
            self.assertTrue(validation_file["exists"])
            self.assertFalse(validation_file["is_dir"])
            self.assertTrue(validation_file["assets"]["symbol"])
            self.assertGreaterEqual(validation_file["counts"].get("symbol"), 0)

            chk = _ws_rpc(
                ws,
                "chk",
                "libraries_component",
                {"path": data["symbol_path"], "lcsc_id": "C40404"},
            )
            self.assertIsInstance(chk.get("messages"), list)
            self.assertTrue(any("not found" in m.lower() for m in chk["messages"]))

    def test_symbol_counts_multiple_entries(self) -> None:
        app = create_app(conversion_runner=_dummy_runner)
        with tempfile.TemporaryDirectory() as tmpdir, TestClient(app) as client, client.websocket_connect(
            "/ws/extension"
        ) as ws:
            sym_path = Path(tmpdir) / "multi.kicad_sym"
            sym_path.write_text(
                """
(kicad_symbol_lib (version 20211014) (generator test)
  (symbol "Device:R" (property "Reference" "R" (id 0)) )
  (symbol "Device:C" (property "Reference" "C" (id 0)) )
)
""".strip(),
                encoding="utf-8",
            )

            data = _ws_rpc(ws, "v", "libraries_validate", {"path": str(sym_path)})
            self.assertTrue(data["assets"]["symbol"])
            self.assertEqual(data["counts"].get("symbol"), 2)

    def test_symbol_counts_ignore_nested_kicad_graphics(self) -> None:
        """KiCad nests (symbol "Name_N_M") inside each part; only top-level parts should count."""
        app = create_app(conversion_runner=_dummy_runner)
        with tempfile.TemporaryDirectory() as tmpdir, TestClient(app) as client, client.websocket_connect(
            "/ws/extension"
        ) as ws:
            sym_path = Path(tmpdir) / "nested.kicad_sym"
            sym_path.write_text(
                """
(kicad_symbol_lib (version 20211014) (generator test)
  (symbol "Device:R" (property "Reference" "R" (id 0))
    (symbol "Device:R_0_0" (rectangle (start -1 -1) (end 1 1)))
    (symbol "Device:R_1_1" (rectangle (start -1 -1) (end 1 1)))
  )
  (symbol "Device:C" (property "Reference" "C" (id 0))
    (symbol "Device:C_0_0" (rectangle (start -1 -1) (end 1 1)))
  )
)
""".strip(),
                encoding="utf-8",
            )

            data = _ws_rpc(ws, "v", "libraries_validate", {"path": str(sym_path)})
            self.assertTrue(data["assets"]["symbol"])
            self.assertEqual(data["counts"].get("symbol"), 2)

    def test_model_counts_includes_step_and_wrl(self) -> None:
        app = create_app(conversion_runner=_dummy_runner)
        with tempfile.TemporaryDirectory() as tmpdir, TestClient(app) as client, client.websocket_connect(
            "/ws/extension"
        ) as ws:
            root = Path(tmpdir) / "Mixed3D"
            root.mkdir()
            (root.with_suffix(".kicad_sym")).write_text(
                "(kicad_symbol_lib (version 20211014) (generator test)\n)",
                encoding="utf-8",
            )
            shapes = root.with_suffix(".3dshapes")
            shapes.mkdir()
            for i in range(3):
                (shapes / f"a{i}.wrl").write_text("#", encoding="utf-8")
            for i in range(4):
                (shapes / f"b{i}.step").write_bytes(b"")

            data = _ws_rpc(ws, "v", "libraries_validate", {"path": str(root)})
            self.assertTrue(data["assets"]["model"])
            self.assertEqual(data["counts"].get("model"), 7)

    def test_conversion_request_from_task_create_payload(self) -> None:
        payload = TaskCreatePayload(
            lcsc_id="C9999",
            output_path="/tmp/lib",
            symbol=True,
            footprint=True,
            template_pin_map={"1": "A"},
        )
        req = ConversionRequest.from_task_create_payload(payload)
        self.assertEqual(req.lcsc_id, "C9999")
        self.assertEqual(req.output_prefix, str(Path("/tmp/lib")))
        self.assertTrue(req.generate_symbol)
        self.assertTrue(req.generate_footprint)
        self.assertEqual(req.template_pin_map, {"1": "A"})
