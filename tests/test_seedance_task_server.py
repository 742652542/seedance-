import unittest
from pathlib import Path

from fastapi.testclient import TestClient

import seedance_task_server as server


class SeedanceTaskServerTest(unittest.TestCase):
    def tearDown(self):
        for directory in [server.RUNNING_DIR, server.RESULTS_DIR]:
            for pattern in ["task_*.json", "cgt-*.json"]:
                for path in Path(directory).glob(pattern):
                    path.unlink(missing_ok=True)

    def test_returns_task_id_immediately_by_default(self):
        calls = []
        upstream_payloads = []

        def fake_ark_request(path, api_key, method="GET", body=None):
            calls.append((method, path))
            upstream_payloads.append(body)
            if method == "POST" and path == "/contents/generations/tasks":
                return {"success": True, "raw": {"id": "cgt-default-123"}}
            raise AssertionError("completion endpoint should not be called")

        original_ark_request = server._ark_request
        server._ark_request = fake_ark_request
        try:
            client = TestClient(server.app)
            response = client.post(
                "/api/ask",
                json={
                    "model": "doubao-seedance-2-0-fast-260128",
                    "apiKey": "test-key",
                    "prompt": "test prompt",
                    "resolution": "720p",
                    "ratio": "16:9",
                    "duration": 10,
                    "images": [
                        {"type": "reference_image", "url": "https://cdn.ixspy.cn/aliexpress/aiTool/demo/video/3-1.png"},
                        {"type": "reference_image", "url": "https://cdn.ixspy.cn/aliexpress/aiTool/demo/video/3-2.png"},
                        {"type": "reference_image", "url": "https://cdn.ixspy.cn/aliexpress/aiTool/demo/video/3-3.png"},
                    ],
                },
            )
        finally:
            server._ark_request = original_ark_request

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "processing")
        self.assertEqual(data["task_id"], "cgt-default-123")
        self.assertEqual(data["completion_response"], {"id": "cgt-default-123"})
        self.assertEqual(calls, [("POST", "/contents/generations/tasks")])
        self.assertNotIn("wait_for_completion", upstream_payloads[0])
        self.assertEqual(len(upstream_payloads[0]["content"]), 4)

    def test_does_not_send_default_service_tier(self):
        body = server.SeedanceTaskRequest(
            model="doubao-seedance-2-0-fast-260128",
            prompt="test prompt",
            resolution="720P",
            ratio="16:9",
            duration=5,
            images=[{"type": "reference_image", "url": "https://example.com/ref.png"}],
        )

        payload = server._body_to_payload(body)

        self.assertNotIn("service_tier", payload)

    def test_does_not_send_explicit_default_service_tier(self):
        body = server.SeedanceTaskRequest(
            model="doubao-seedance-2-0-fast-260128",
            prompt="test prompt",
            resolution="720P",
            ratio="16:9",
            duration=5,
            service_tier="default",
            images=[{"type": "reference_image", "url": "https://example.com/ref.png"}],
        )

        payload = server._body_to_payload(body)

        self.assertNotIn("service_tier", payload)

    def test_returns_task_id_immediately_when_wait_disabled(self):
        calls = []

        def fake_ark_request(path, api_key, method="GET", body=None):
            calls.append((method, path))
            if method == "POST" and path == "/contents/generations/tasks":
                return {"success": True, "raw": {"id": "cgt-test-123"}}
            raise AssertionError("completion endpoint should not be called")

        original_ark_request = server._ark_request
        server._ark_request = fake_ark_request
        try:
            client = TestClient(server.app)
            response = client.post(
                "/api/ask",
                json={
                    "model": "doubao-seedance-2-0-fast-260128",
                    "apiKey": "test-key",
                    "prompt": "test prompt",
                    "resolution": "720p",
                    "ratio": "16:9",
                    "duration": 10,
                    "wait_for_completion": False,
                },
            )
        finally:
            server._ark_request = original_ark_request

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "processing")
        self.assertEqual(data["task_id"], "cgt-test-123")
        self.assertEqual(data["completion_response"], {"id": "cgt-test-123"})
        self.assertEqual(calls, [("POST", "/contents/generations/tasks")])

    def test_result_endpoint_returns_completion_response(self):
        server._write_json(
            server._task_file(server.RUNNING_DIR, "cgt-result-123"),
            {
                "task_id": "cgt-result-123",
                "model": "doubao-seedance-2-0-fast-260128",
                "api_key": "test-key",
                "status": "queued",
            },
        )

        def fake_ark_request(path, api_key, method="GET", body=None):
            self.assertEqual(method, "GET")
            self.assertEqual(path, "/contents/generations/tasks/cgt-result-123")
            return {
                "success": True,
                "raw": {
                    "total": 1,
                    "items": [
                        {
                            "id": "cgt-result-123",
                            "status": "succeeded",
                            "content": {"video_url": "https://example.com/video.mp4"},
                        }
                    ],
                },
            }

        original_ark_request = server._ark_request
        server._ark_request = fake_ark_request
        try:
            client = TestClient(server.app)
            response = client.get(
                "/api/result/cgt-result-123",
                params={
                    "model": "doubao-seedance-2-0-fast-260128",
                    "apiKey": "test-key",
                },
            )
        finally:
            server._ark_request = original_ark_request

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "completed")
        self.assertNotIn("task_id", data)
        self.assertEqual(data["result"]["task_id"], "cgt-result-123")
        self.assertEqual(data["result"]["data"]["content"]["video_url"], "https://example.com/video.mp4")
        self.assertEqual(data["completion_response"]["total"], 1)

    def test_result_endpoint_returns_completed_error_for_failed_task(self):
        server._write_json(
            server._task_file(server.RUNNING_DIR, "cgt-failed-123"),
            {
                "task_id": "cgt-failed-123",
                "model": "doubao-seedance-2-0-fast-260128",
                "api_key": "test-key",
                "status": "queued",
            },
        )

        def fake_ark_request(path, api_key, method="GET", body=None):
            return {
                "success": True,
                "raw": {
                    "total": 1,
                    "items": [
                        {
                            "id": "cgt-failed-123",
                            "status": "failed",
                            "error": {"message": "bad prompt"},
                        }
                    ],
                },
            }

        original_ark_request = server._ark_request
        server._ark_request = fake_ark_request
        try:
            client = TestClient(server.app)
            response = client.get("/api/result/cgt-failed-123", params={"apiKey": "test-key"})
        finally:
            server._ark_request = original_ark_request

        data = response.json()
        self.assertEqual(data["status"], "completed")
        self.assertEqual(data["result"]["status"], "error")
        self.assertEqual(data["result"]["task_id"], "cgt-failed-123")
        self.assertEqual(data["result"]["action"], "generate_video")
        self.assertEqual(data["result"]["data"], "")
        self.assertEqual(data["result"]["error"], "bad prompt")
        self.assertEqual(data["result"]["client_id"], "seedance_api")
        self.assertEqual(data["completion_response"]["items"][0]["status"], "failed")

    def test_files_endpoint_returns_download_complete_video_url(self):
        server._write_json(
            server._task_file(server.RESULTS_DIR, "cgt-file-123"),
            {
                "status": "success",
                "task_id": "cgt-file-123",
                "action": "generate_video",
                "data": {
                    "id": "cgt-file-123",
                    "status": "succeeded",
                    "content": {"video_url": "https://example.com/file.mp4"},
                },
                "updated_at": 123,
                "completion_response": {"total": 1},
            },
        )

        client = TestClient(server.app)
        response = client.get("/api/files/cgt-file-123")

        data = response.json()
        self.assertEqual(data["status"], "completed")
        self.assertEqual(data["result"]["type"], "download_complete")
        self.assertEqual(data["result"]["task_id"], "cgt-file-123")
        self.assertEqual(data["result"]["cdn_url"], "https://example.com/file.mp4")
        self.assertEqual(data["completion_response"], {"total": 1})


if __name__ == "__main__":
    unittest.main()
