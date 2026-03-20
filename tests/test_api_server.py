import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi.testclient import TestClient

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
                if msg.get("type") == "task_update" and msg.get("payload", {}).get("status") == "completed":
                    detail = msg["payload"]
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
