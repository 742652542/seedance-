import base64
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field


BASE_DIR = Path(__file__).resolve().parent
ARK_BASE_URL = os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3").rstrip("/")
POLL_TIMEOUT = int(os.getenv("SEEDANCE_POLL_TIMEOUT", "900"))
POLL_INTERVAL = float(os.getenv("SEEDANCE_POLL_INTERVAL", "3"))
UPSTREAM_TIMEOUT = int(os.getenv("SEEDANCE_UPSTREAM_TIMEOUT", "120"))
DEBUG = os.getenv("SEEDANCE_DEBUG", "1") != "0"
TASK_ROOT = BASE_DIR / "seedance_tasks"
RUNNING_DIR = TASK_ROOT / "running"
RESULTS_DIR = TASK_ROOT / "results"

for p in [RUNNING_DIR, RESULTS_DIR]:
    p.mkdir(parents=True, exist_ok=True)

MODELS = {
    "doubao-seedance-2-5-260628",
    "doubao-seedance-2-0-260128",
    "doubao-seedance-2-0-fast-260128",
    "doubao-seedance-2-0-mini-260615",
}
IMAGE_ROLES = {"first_frame", "last_frame", "reference_image"}
TERMINAL_STATUSES = {"succeeded", "failed", "cancelled", "expired"}

app = FastAPI(title="Seedance Python Task Server")


def _debug_log(message: str) -> None:
    if DEBUG:
        print(message, flush=True)


def _task_file(directory: Path, task_id: str) -> Path:
    return directory / f"{task_id}.json"


def _write_json(path: Path, data: Dict[str, Any]) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _read_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


class SeedanceTaskRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="allow")

    model: str = "doubao-seedance-2-0-fast-260128"
    prompt: Optional[str] = None
    resolution: str = "720p"
    ratio: str = "16:9"
    duration: int = 5
    image: Optional[Any] = None
    images: Optional[Any] = None
    content: Optional[List[Dict[str, Any]]] = None
    image_type: str = "reference_image"
    seed: int = -1
    output_format: str = "mp4"
    framespersecond: int = 24
    service_tier: Optional[str] = None
    generate_audio: bool = False
    watermark: bool = False
    camera_fixed: bool = False
    callback_url: Optional[str] = None
    wait_for_completion: bool = False
    api_key: Optional[str] = Field(default=None, alias="apiKey")
    advanced_json: Optional[str] = Field(default=None, alias="advancedJson")


class ResultQuery(BaseModel):
    model: str = "doubao-seedance-2-0-fast-260128"
    api_key: Optional[str] = Field(default=None, alias="apiKey")


def _load_api_key_config() -> Dict[str, str]:
    config_path = BASE_DIR / "api-keys.json"
    if not config_path.exists():
        return {}
    try:
        with config_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _get_api_key(model: str, provided_key: Optional[str]) -> str:
    if provided_key and provided_key.strip():
        return provided_key.strip()

    env_name = f"ARK_API_KEY_{model.upper().replace('-', '_')}"
    if os.getenv(env_name):
        return os.getenv(env_name, "").strip()
    if os.getenv("ARK_API_KEY"):
        return os.getenv("ARK_API_KEY", "").strip()

    return str(_load_api_key_config().get(model) or "").strip()


def _json_response(status: str, message: str, result: Any = None, completion_response: Any = None) -> Dict[str, Any]:
    return {
        "status": status,
        "message": message,
        "result": result,
        "completion_response": completion_response,
    }


def _task_response(
    status: str,
    message: str,
    task_id: str,
    result: Any = None,
    completion_response: Any = None,
) -> Dict[str, Any]:
    response = _json_response(status, message, result, completion_response)
    response["task_id"] = task_id
    return response


def _error_response(message: str, completion_response: Any = None, result: Any = None) -> Dict[str, Any]:
    return _json_response("error", message, result, completion_response)


def _build_completed_response(result_data: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "status": "completed",
        "result": result_data,
        "completion_response": result_data.get("completion_response"),
    }


def _build_result_data(
    status: str,
    task_id: str,
    data: Any,
    completion_response: Any,
    error: str = "",
    message: str = "",
) -> Dict[str, Any]:
    result = {
        "status": status,
        "task_id": task_id,
        "action": "generate_video",
        "data": data,
        "error": error,
        "message": message,
        "url_id": "",
        "client_id": "seedance_api",
        "updated_at": int(time.time()),
        "completion_response": completion_response,
    }
    video_url = _extract_video_url(data)
    if video_url:
        result["video_url"] = video_url
    return result


def _safe_json_response(resp: httpx.Response) -> Any:
    text = resp.text
    try:
        return resp.json() if text else None
    except Exception:
        return {"raw_text": text}


def _ark_request(path: str, api_key: str, method: str = "GET", body: Optional[Dict[str, Any]] = None) -> Any:
    if body is not None:
        _debug_log(f"[ark.request] method={method} path={path} payload={_payload_summary(body)}")
    else:
        _debug_log(f"[ark.request] method={method} path={path}")

    with httpx.Client(timeout=UPSTREAM_TIMEOUT) as client:
        resp = client.request(
            method,
            f"{ARK_BASE_URL}{path}",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=body if body is not None else None,
        )

    data = _safe_json_response(resp)
    _debug_log(f"[ark.response] method={method} path={path} status_code={resp.status_code} body={_response_summary(data)}")
    if resp.status_code // 100 != 2:
        return {
            "success": False,
            "status_code": resp.status_code,
            "error": _extract_error_message(data, resp.reason_phrase),
            "raw": data,
        }
    return {"success": True, "raw": data}


def _extract_error_message(data: Any, fallback: str = "接口返回异常") -> str:
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error.get("message"))
        if isinstance(error, str) and error:
            return error
        if data.get("message"):
            return str(data.get("message"))
    return fallback or "接口返回异常"


def _extract_video_url(data: Any) -> str:
    if isinstance(data, dict):
        content = data.get("content")
        if isinstance(content, dict) and content.get("video_url"):
            return str(content.get("video_url"))
        if data.get("video_url"):
            return str(data.get("video_url"))
    return ""


def _extract_task_error(task_item: Dict[str, Any], fallback: str) -> str:
    for key in ["error", "message"]:
        value = task_item.get(key)
        if isinstance(value, dict):
            msg = value.get("message") or value.get("error")
            if msg:
                return str(msg)
        if isinstance(value, str) and value:
            return value
    return fallback


def _payload_summary(payload: Dict[str, Any]) -> Dict[str, Any]:
    content = payload.get("content") or []
    image_count = sum(1 for item in content if isinstance(item, dict) and item.get("type") == "image_url")
    text_len = len(_content_prompt(content))
    return {
        "model": payload.get("model"),
        "resolution": payload.get("resolution"),
        "ratio": payload.get("ratio"),
        "duration": payload.get("duration"),
        "seed": payload.get("seed"),
        "output_format": payload.get("output_format"),
        "generate_audio": payload.get("generate_audio"),
        "watermark": payload.get("watermark"),
        "camera_fixed": payload.get("camera_fixed"),
        "text_len": text_len,
        "image_count": image_count,
        "image_roles": [item.get("role") for item in content if isinstance(item, dict) and item.get("type") == "image_url"],
    }


def _response_summary(data: Any) -> Any:
    if not isinstance(data, dict):
        return data
    if data.get("id"):
        return {"id": data.get("id"), "status": data.get("status")}
    if isinstance(data.get("items"), list):
        return {
            "total": data.get("total"),
            "items": [
                {"id": item.get("id"), "status": item.get("status")}
                for item in data.get("items", [])[:3]
                if isinstance(item, dict)
            ],
        }
    if data.get("error") or data.get("message"):
        return {"error": data.get("error"), "message": data.get("message")}
    return data


def _get_image_mime(image_data: bytes) -> str:
    if image_data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if image_data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if image_data.startswith(b"GIF87a") or image_data.startswith(b"GIF89a"):
        return "image/gif"
    if image_data.startswith(b"RIFF") and image_data[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"


def _normalize_image_url(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None

    value = value.strip()
    if not value:
        return None
    if value.startswith(("http://", "https://", "data:")):
        return value

    try:
        image_data = base64.b64decode(value, validate=True)
    except Exception:
        return value

    return f"data:{_get_image_mime(image_data)};base64,{value}"


def _normalize_image_role(role: Any) -> str:
    role_text = str(role or "reference_image").strip()
    return role_text if role_text in IMAGE_ROLES else "reference_image"


def _iter_image_items(images: Any) -> List[Any]:
    if images is None:
        return []
    if isinstance(images, list):
        return images
    return [images]


def _build_image_content(images: Any, default_role: str) -> List[Dict[str, Any]]:
    content: List[Dict[str, Any]] = []
    for item in _iter_image_items(images):
        role = default_role
        image_value = item

        if isinstance(item, dict):
            role = _normalize_image_role(item.get("type") or item.get("role") or default_role)
            image_value = item.get("url") or item.get("image") or item.get("image_url")
            if isinstance(image_value, dict):
                image_value = image_value.get("url")

        image_url = _normalize_image_url(image_value)
        if image_url:
            content.append({
                "type": "image_url",
                "role": role,
                "image_url": {"url": image_url},
            })
    return content


def _build_content(body: SeedanceTaskRequest) -> List[Dict[str, Any]]:
    if body.content:
        return body.content

    prompt = (body.prompt or "").strip()
    content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
    image_input = body.images if body.images is not None else body.image
    content.extend(_build_image_content(image_input, _normalize_image_role(body.image_type)))
    return content


def _content_prompt(content: List[Dict[str, Any]]) -> str:
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            return str(item.get("text") or "").strip()
    return ""


def _body_to_payload(body: SeedanceTaskRequest) -> Dict[str, Any]:
    if hasattr(body, "model_dump"):
        data = body.model_dump(by_alias=False, exclude_none=True)
    else:
        data = body.dict(by_alias=False, exclude_none=True)
    advanced_json = data.pop("advanced_json", None)
    data.pop("api_key", None)
    data.pop("prompt", None)
    data.pop("image", None)
    data.pop("images", None)
    data.pop("image_type", None)
    data.pop("wait_for_completion", None)
    data.pop("service_tier", None)

    payload: Dict[str, Any] = {
        "model": body.model,
        "content": _build_content(body),
        "resolution": body.resolution,
        "ratio": body.ratio,
        "duration": body.duration,
        "seed": body.seed,
        "output_format": body.output_format,
        "framespersecond": body.framespersecond,
        "generate_audio": body.generate_audio,
        "watermark": body.watermark,
        "camera_fixed": body.camera_fixed,
    }

    if body.service_tier and body.service_tier != "default":
        payload["service_tier"] = body.service_tier

    for key, value in data.items():
        if key not in payload and key != "content":
            payload[key] = value

    if advanced_json and advanced_json.strip():
        payload.update(json.loads(advanced_json))

    return payload


def _extract_task_id(create_response: Any) -> Optional[str]:
    if not isinstance(create_response, dict):
        return None
    if create_response.get("id"):
        return str(create_response.get("id"))
    if isinstance(create_response.get("task"), dict) and create_response["task"].get("id"):
        return str(create_response["task"].get("id"))
    if isinstance(create_response.get("items"), list) and create_response["items"]:
        first = create_response["items"][0]
        if isinstance(first, dict) and first.get("id"):
            return str(first.get("id"))
    return None


def _extract_task_item(completion_response: Any, task_id: str) -> Dict[str, Any]:
    if isinstance(completion_response, dict):
        if isinstance(completion_response.get("items"), list):
            for item in completion_response["items"]:
                if isinstance(item, dict) and str(item.get("id") or "") == task_id:
                    return item
            first = completion_response["items"][0] if completion_response["items"] else {}
            return first if isinstance(first, dict) else {}
        return completion_response
    return {}


def _poll_completion(task_id: str, api_key: str) -> Dict[str, Any]:
    deadline = time.time() + POLL_TIMEOUT
    last_response: Any = None

    while time.time() < deadline:
        upstream = _ark_request(f"/contents/generations/tasks/{task_id}", api_key)
        if not upstream.get("success"):
            return {
                "success": False,
                "message": upstream.get("error") or "查询完成接口失败",
                "completion_response": upstream,
            }

        last_response = upstream.get("raw")
        task_item = _extract_task_item(last_response, task_id)
        status = str(task_item.get("status") or "").lower()
        if status in TERMINAL_STATUSES:
            return {
                "success": status == "succeeded",
                "message": "任务完成" if status == "succeeded" else f"任务状态异常: {status}",
                "result": task_item,
                "completion_response": last_response,
            }

        time.sleep(POLL_INTERVAL)

    return {
        "success": False,
        "message": "等待任务完成超时",
        "completion_response": last_response or {"task_id": task_id, "error": "poll timeout"},
    }


def _validate_payload(payload: Dict[str, Any]) -> Optional[str]:
    model = str(payload.get("model") or "").strip()
    if model not in MODELS:
        return "不支持的模型"
    if not _content_prompt(payload.get("content") or []):
        return "prompt 不能为空"
    duration = payload.get("duration")
    if not isinstance(duration, int) or duration <= 0:
        return "duration 必须是正整数秒"
    if not re.fullmatch(r"\d+p|4k", str(payload.get("resolution") or ""), re.IGNORECASE):
        return "resolution 格式不正确"
    return None


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content=_error_response("请求参数格式错误", {"errors": exc.errors()}))


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=500, content=_error_response("服务器错误", {"exception": str(exc)}))


@app.post("/api/ask")
async def create_and_wait(body: SeedanceTaskRequest) -> Dict[str, Any]:
    try:
        payload = _body_to_payload(body)
    except json.JSONDecodeError as exc:
        return _error_response("advancedJson 不是合法 JSON", {"exception": str(exc)})

    validation_error = _validate_payload(payload)
    if validation_error:
        _debug_log(f"[/api/ask] validation_error={validation_error} payload={_payload_summary(payload)}")
        return _error_response(validation_error, {"payload": payload})

    api_key = _get_api_key(payload["model"], body.api_key)
    _debug_log(
        f"[/api/ask] received payload={_payload_summary(payload)} "
        f"wait_for_completion={body.wait_for_completion} api_key_present={bool(api_key)}"
    )
    if not api_key:
        return _error_response("缺少该模型的 API Key，请传入 apiKey、设置环境变量或创建 api-keys.json", {"model": payload["model"]})

    create_result = _ark_request("/contents/generations/tasks", api_key, method="POST", body=payload)
    if not create_result.get("success"):
        return _error_response(create_result.get("error") or "创建任务失败", create_result)

    create_response = create_result.get("raw")
    upstream_task_id = _extract_task_id(create_response)
    _debug_log(f"[/api/ask] task_id={upstream_task_id} create_response={_response_summary(create_response)}")
    if not upstream_task_id:
        return _error_response("创建任务成功但未返回任务 ID", create_response, create_response)

    task_record = {
        "action": "generate_video",
        "status": "queued",
        "task_id": upstream_task_id,
        "model": payload["model"],
        "api_key": body.api_key,
        "payload": payload,
        "created_at": int(time.time()),
        "updated_at": int(time.time()),
        "completion_response": create_response,
    }
    _write_json(_task_file(RUNNING_DIR, upstream_task_id), task_record)

    if not body.wait_for_completion:
        _debug_log(f"[/api/ask] return_immediately status=processing task_id={upstream_task_id}")
        return {
            "status": "processing",
            "message": "任务已发送给客户端",
            "task_id": upstream_task_id,
            "queue_position": 0,
            "completion_response": create_response,
        }

    completion = _poll_completion(upstream_task_id, api_key)
    if completion.get("success"):
        final_data = {
            **_build_result_data("success", upstream_task_id, completion.get("result"), completion.get("completion_response"))
        }
        _write_json(_task_file(RESULTS_DIR, upstream_task_id), final_data)
        _task_file(RUNNING_DIR, upstream_task_id).unlink(missing_ok=True)
        _debug_log(f"[/api/ask] completed task_id={upstream_task_id} result={_response_summary(completion.get('completion_response'))}")
        return _build_completed_response(final_data)

    final_data = _build_result_data(
        "error",
        upstream_task_id,
        "",
        completion.get("completion_response"),
        completion.get("message") or "任务失败",
    )
    _write_json(_task_file(RESULTS_DIR, upstream_task_id), final_data)
    _task_file(RUNNING_DIR, upstream_task_id).unlink(missing_ok=True)
    _debug_log(f"[/api/ask] failed task_id={upstream_task_id} message={completion.get('message')}")
    return _build_completed_response(final_data)


@app.get("/api/result/{task_id}")
async def get_task_result(task_id: str, model: str = "doubao-seedance-2-0-fast-260128", apiKey: Optional[str] = None) -> Dict[str, Any]:
    _debug_log(f"[/api/result] task_id={task_id} model={model} api_key_present={bool(apiKey)}")
    result_path = _task_file(RESULTS_DIR, task_id)
    if result_path.exists():
        result_data = _read_json(result_path)
        response = _build_completed_response(result_data)
        _debug_log(f"[/api/result] cached_completed task_id={task_id} response={_response_summary(response.get('completion_response'))}")
        return response

    running_path = _task_file(RUNNING_DIR, task_id)
    if not running_path.exists():
        return {
            "status": "processing",
            "message": "任务处理中或不存在",
            "completion_response": None,
        }

    task_record = _read_json(running_path)
    upstream_task_id = task_id
    model = str(task_record.get("model") or model)
    if model not in MODELS:
        return _error_response("不支持的模型", {"model": model})

    api_key = _get_api_key(model, apiKey or task_record.get("api_key"))
    if not api_key:
        return _error_response("缺少该模型的 API Key，请传入 apiKey、设置环境变量或创建 api-keys.json", {"model": model})

    upstream = _ark_request(f"/contents/generations/tasks/{upstream_task_id}", api_key)
    if not upstream.get("success"):
        return _error_response(upstream.get("error") or "查询完成接口失败", upstream)

    completion_response = upstream.get("raw")
    task_item = _extract_task_item(completion_response, upstream_task_id)
    status = str(task_item.get("status") or "").lower()
    if status == "succeeded":
        result_data = _build_result_data("success", task_id, task_item, completion_response)
        _write_json(result_path, result_data)
        running_path.unlink(missing_ok=True)
        _debug_log(f"[/api/result] completed task_id={task_id} status={status}")
        return _build_completed_response(result_data)
    if status in TERMINAL_STATUSES:
        result_data = _build_result_data(
            "error",
            task_id,
            "",
            completion_response,
            _extract_task_error(task_item, f"任务状态异常: {status}"),
        )
        _write_json(result_path, result_data)
        running_path.unlink(missing_ok=True)
        _debug_log(f"[/api/result] terminal_error task_id={task_id} status={status}")
        return _build_completed_response(result_data)
    _debug_log(f"[/api/result] processing task_id={task_id} status={status or 'unknown'}")
    task_record["status"] = "processing"
    task_record["updated_at"] = int(time.time())
    task_record["completion_response"] = completion_response
    _write_json(running_path, task_record)
    return {"status": "processing", "message": "任务处理中", "completion_response": completion_response}


@app.get("/api/files/{task_id}")
async def get_task_files(task_id: str) -> Dict[str, Any]:
    result_path = _task_file(RESULTS_DIR, task_id)
    if not result_path.exists():
        return {"status": "processing", "message": "文件生成中或不存在", "completion_response": None}

    result_data = _read_json(result_path)
    video_url = _extract_video_url(result_data.get("data")) or result_data.get("video_url") or ""
    if result_data.get("status") == "success" and video_url:
        return {
            "status": "completed",
            "result": {
                "type": "download_complete",
                "task_id": task_id,
                "cdn_url": video_url,
                "file_type": "cdn_url",
                "updated_at": result_data.get("updated_at"),
            },
            "completion_response": result_data.get("completion_response"),
        }

    return {
        "status": "failed",
        "result": result_data,
        "completion_response": result_data.get("completion_response"),
    }


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "success": True,
        "service": "seedance-python-task-server",
        "port": int(os.getenv("PORT", "9091")),
        "ark_base_url": ARK_BASE_URL,
    }


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "9091"))
    uvicorn.run(app, host=host, port=port)
