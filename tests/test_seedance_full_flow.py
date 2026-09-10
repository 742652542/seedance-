import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from fastapi.testclient import TestClient

import seedance_task_server as server


class FakeArkHandler(BaseHTTPRequestHandler):
    created_payload = None

    def _send_json(self, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length).decode("utf-8")
        FakeArkHandler.created_payload = json.loads(raw)
        print(f"[fake-ark] POST {self.path} body={json.dumps(FakeArkHandler.created_payload, ensure_ascii=False)}", flush=True)
        self._send_json({"id": "cgt-flow-123", "status": "queued"})

    def do_GET(self):
        print(f"[fake-ark] GET {self.path}", flush=True)
        self._send_json({
            "total": 1,
            "items": [
                {
                    "id": "cgt-flow-123",
                    "model": "doubao-seedance-2-0-fast-260128",
                    "status": "succeeded",
                    "content": {"video_url": "https://example.com/cgt-flow-123.mp4"},
                    "resolution": "720p",
                    "ratio": "16:9",
                    "duration": 10,
                    "framespersecond": 24,
                    "service_tier": "default",
                    "generate_audio": False,
                    "output_format": "mp4",
                }
            ],
        })

    def log_message(self, format, *args):
        return


class SeedanceFullFlowTest(unittest.TestCase):
    def tearDown(self):
        for directory in [server.RUNNING_DIR, server.RESULTS_DIR]:
            for pattern in ["task_*.json", "cgt-*.json"]:
                for path in Path(directory).glob(pattern):
                    path.unlink(missing_ok=True)

    def test_ask_to_result_flow(self):
        fake_ark = ThreadingHTTPServer(("127.0.0.1", 0), FakeArkHandler)
        thread = threading.Thread(target=fake_ark.serve_forever, daemon=True)
        thread.start()

        original_base_url = server.ARK_BASE_URL
        server.ARK_BASE_URL = f"http://127.0.0.1:{fake_ark.server_port}/api/v3"
        try:
            client = TestClient(server.app)
            payload = {
                "model": "doubao-seedance-2-0-fast-260128",
                "apiKey": "test-key",
                "prompt": "基于上传的任意主体参考图，节奏快速的Y2K波普商业广告短片。",
                "resolution": "720P",
                "ratio": "16:9",
                "duration": "10",
                "seed": -1,
                "output_format": "mp4",
                "framespersecond": 24,
                "service_tier": "default",
                "generate_audio": False,
                "watermark": False,
                "camera_fixed": False,
                "images": [
                    {"type": "reference_image", "url": "https://cdn.ixspy.cn/aliexpress/aiTool/demo/video/3-1.png"},
                    {"type": "reference_image", "url": "https://cdn.ixspy.cn/aliexpress/aiTool/demo/video/3-2.png"},
                    {"type": "reference_image", "url": "https://cdn.ixspy.cn/aliexpress/aiTool/demo/video/3-3.png"},
                ],
            }

            print(f"[test] POST /api/ask payload={json.dumps(payload, ensure_ascii=False)}", flush=True)
            ask_response = client.post("/api/ask", json=payload)
            print(f"[test] POST /api/ask status={ask_response.status_code} body={json.dumps(ask_response.json(), ensure_ascii=False)}", flush=True)
            self.assertEqual(ask_response.status_code, 200)

            ask_result = ask_response.json()
            self.assertEqual(ask_result["status"], "processing")
            self.assertEqual(ask_result["task_id"], "cgt-flow-123")
            self.assertEqual(ask_result["completion_response"], {"id": "cgt-flow-123", "status": "queued"})

            print("[test] upstream create payload summary=" + json.dumps({
                "model": FakeArkHandler.created_payload.get("model"),
                "resolution": FakeArkHandler.created_payload.get("resolution"),
                "ratio": FakeArkHandler.created_payload.get("ratio"),
                "duration": FakeArkHandler.created_payload.get("duration"),
                "content_count": len(FakeArkHandler.created_payload.get("content", [])),
                "image_roles": [item.get("role") for item in FakeArkHandler.created_payload.get("content", []) if item.get("type") == "image_url"],
            }, ensure_ascii=False), flush=True)

            result_url = f"/api/result/{ask_result['task_id']}"
            print(f"[test] GET {result_url}?model={payload['model']}&apiKey=***", flush=True)
            result_response = client.get(result_url, params={"model": payload["model"], "apiKey": payload["apiKey"]})
            print(f"[test] GET {result_url} status={result_response.status_code} body={json.dumps(result_response.json(), ensure_ascii=False)}", flush=True)
            self.assertEqual(result_response.status_code, 200)

            result = result_response.json()
            self.assertEqual(result["status"], "completed")
            self.assertNotIn("task_id", result)
            self.assertEqual(result["result"]["task_id"], ask_result["task_id"])
            self.assertEqual(result["result"]["data"]["content"]["video_url"], "https://example.com/cgt-flow-123.mp4")
            self.assertEqual(result["completion_response"]["items"][0]["id"], "cgt-flow-123")

            files_url = f"/api/files/{ask_result['task_id']}"
            print(f"[test] GET {files_url}", flush=True)
            files_response = client.get(files_url)
            print(f"[test] GET {files_url} status={files_response.status_code} body={json.dumps(files_response.json(), ensure_ascii=False)}", flush=True)
            self.assertEqual(files_response.status_code, 200)
            files_result = files_response.json()
            self.assertEqual(files_result["status"], "completed")
            self.assertEqual(files_result["result"]["type"], "download_complete")
            self.assertEqual(files_result["result"]["cdn_url"], "https://example.com/cgt-flow-123.mp4")
        finally:
            server.ARK_BASE_URL = original_base_url
            fake_ark.shutdown()
            fake_ark.server_close()


if __name__ == "__main__":
    unittest.main()
