# Seedance Python Server Design

## Goal

Create a Python FastAPI service on port `9093` that accepts Seedance video generation inputs, creates a Volcengine Ark task, polls the task completion endpoint synchronously, and returns a unified response that always includes the completion endpoint output.

## API

`POST /api/ask` accepts JSON with `model`, `prompt`, `resolution`, `ratio`, `duration`, and `images`. Images may be strings or objects. Image object `type` defaults to `reference_image` and supports `first_frame`, `last_frame`, and `reference_image`.

Defaults: `seed=-1`, `output_format=mp4`, `generate_audio=false`, `watermark=false`, `camera_fixed=false`, `framespersecond=24`, `service_tier=default`.

## Data Flow

The service validates the request, resolves the API key from request body, environment variables, or `api-keys.json`, converts images into Ark `content` entries, calls `POST /contents/generations/tasks`, extracts the created task id, then polls `GET /contents/generations/tasks/{id}` until a terminal status or timeout.

## Response Shape

All responses use the reference Python style: `status`, `message`, `result`, and `completion_response`. `completion_response` is present for both success and error cases. For creation failures or exceptions, it stores the upstream response or normalized error object.

## Error Handling

Validation errors, missing API key, upstream create errors, polling errors, task failure, timeout, and unexpected exceptions are normalized into the same response shape. FastAPI exception handlers also return the same structure.

## Scope

This is a focused standalone Python service. It does not replace the existing Node UI server and does not persist local task files.
