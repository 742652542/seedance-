# Seedance Python Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python FastAPI service on port `9093` that creates Seedance video tasks and synchronously returns the completion endpoint response.

**Architecture:** Add one focused server file, `seedance_task_server.py`, following the reference Python response style. The service validates inputs, builds Ark payloads, calls create, polls completion, and normalizes every success/error response with `completion_response`.

**Tech Stack:** Python 3, FastAPI, Pydantic, httpx, uvicorn.

---

### Task 1: Add Standalone Server

**Files:**
- Create: `seedance_task_server.py`

- [ ] **Step 1: Define request models and constants**

Create Pydantic models for image input and task request. Define model allowlist, defaults, Ark base URL, polling timeout, and retry interval.

- [ ] **Step 2: Implement API key resolution**

Resolve API key from request `apiKey`, per-model environment variable, generic `ARK_API_KEY`, then `api-keys.json`.

- [ ] **Step 3: Implement payload conversion**

Convert prompt and images into Ark `content` entries. Support raw URL, data URL, base64 string, or object with `url`/`image` and `type`.

- [ ] **Step 4: Implement upstream calls**

Use `httpx.Client` to call task creation and completion endpoints. Parse JSON safely and preserve raw text for non-JSON responses.

- [ ] **Step 5: Implement synchronous polling**

Poll until `succeeded`, `failed`, `cancelled`, or timeout. Return terminal response as `completion_response`.

- [ ] **Step 6: Implement unified errors**

Return `{status, message, result, completion_response}` for validation, upstream, timeout, and unexpected errors.

- [ ] **Step 7: Add health endpoint and main runner**

Add `GET /health` and `uvicorn.run(... port=9093)`.

### Task 2: Verify Syntax

**Files:**
- Verify: `seedance_task_server.py`

- [ ] **Step 1: Compile Python file**

Run: `python -m py_compile seedance_task_server.py`

Expected: command exits successfully without output.

- [ ] **Step 2: Inspect dependency note**

If imports are unavailable in the current environment, report the required install command: `pip install fastapi uvicorn httpx`.

## Self-Review

The plan covers the requested Python service, port `9093`, request fields, image role defaults, synchronous completion output, and unified response handling. No placeholders or contradictory field names remain.
