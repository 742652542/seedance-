# Image Project Concurrency Design

## Goal

Adjust the Dramart image generation workflow so the service creates one project named `image` when it starts, opens that project's Canvas page, and keeps the page mounted for the lifetime of the service. Image requests must no longer select or create projects according to aspect ratio. Every accepted image request starts as soon as the shared image session is ready, with no local concurrency limit or serial queue.

The video generation workflow and the public task API remain unchanged.

## Current Behavior

Each image request starts `prepare-image-workflow.js` in a child process. That process creates a new browser page, searches for or creates a project named from the current date and requested ratio, opens its `/canvas` URL, uploads reference images, submits generation, polls for completion, and closes the page.

Although requests already start in separate child processes, each request pays for project lookup and page navigation. Project selection is coupled to `ratio`, pages are short-lived, and browser resources grow with task concurrency.

## Architecture

`nodejs/task-server.js` will own a long-lived image session in addition to its existing browser connection. The session contains:

- The connected Puppeteer browser.
- A dedicated, long-lived Canvas page.
- The newly created `image` project's `projectId`, `scriptId`, `teamId`, name, and Canvas URL.
- A shared initialization promise used by all image requests.

The service starts image-session initialization during startup. It creates a new Dramart manual project on every service start, sets its name to `image`, confirms the project resources, navigates the dedicated page to the project's `/canvas` URL, and leaves that page open.

The project creation payload uses a fixed project-level aspect ratio of `9:16`. This value exists only because the project API requires a ratio. It does not select the project used by an image request and does not override the request's generation ratio.

Image workflow operations currently implemented in `prepare-image-workflow.js` will move into reusable service-side functions. Image requests will no longer spawn that script. Video requests continue to use `prepare-video-workflow.js` and its existing child-process behavior.

## Initialization And Readiness

All callers share one image-session initialization promise. If an image request arrives before startup initialization has completed, the request remains in the local `processing` state and waits for that promise. Once initialization succeeds, all waiting requests proceed independently and concurrently.

Initialization is not a task queue. It is only a readiness barrier for the shared browser session.

If initialization fails, requests waiting on that attempt fail with the initialization error. The failed promise is cleared so a later image request can start a new initialization attempt. A health response may expose image-session readiness for diagnostics, but no new public endpoint is required.

## Request Data Flow

For each `generate_image` request:

1. Validate and normalize the request using the existing API behavior.
2. Persist the request and running-task record, then return `processing` immediately unless `wait_for_completion` is enabled.
3. Await the shared image-session readiness promise.
4. Materialize each reference image into a task-specific temporary location.
5. Obtain upload credentials, upload each image to TOS, and register each reference image against the shared `image` project.
6. Create a unique generated-image resource and retain its `resourceId`.
7. Immediately submit `/proxy/api/v1/tasks/image/generate`.
8. Poll `/proxy/api/v1/tasks/image/list` using that task's exact `resourceId` until success, failure, cancellation, expiry, or timeout.
9. Persist the normalized result using the existing `/api/result/:task_id` and `/api/files/:task_id` response contract.
10. Remove task-specific temporary files in a `finally` block.

The request's `ratio` is sent in both `GenerationParams[].AspectRatio` and `ParsedPrompt.AspectRatio`. It is never used for project lookup, project creation, or page navigation.

## Concurrency Model

There is no local image-task concurrency limit and no serial execution queue. Each accepted image task runs as its own asynchronous operation in the task-server process.

The tasks share only the initialized project and authenticated page context. Every task has independent:

- Input normalization and temporary files.
- Reference-image uploads and image registrations.
- Generated resource ID.
- Generation submission.
- Polling loop, timeout, result, and error state.

Calls through `page.evaluate` may overlap at the JavaScript promise level and issue independent HTTP requests from the authenticated browser context. A slow generation or polling loop must not block another task from uploading or submitting.

No local backpressure is introduced. The upstream Dramart service and available machine/browser resources determine the practical concurrency ceiling.

## Session Lifecycle And Recovery

The dedicated Canvas page remains open after every task, whether the task succeeds or fails. Individual task cleanup must never close the shared page or disconnect the shared browser.

The session is considered invalid if the browser disconnects, the dedicated page closes, or an operation detects that its authenticated page context can no longer be used. Invalidating the session clears the stored page, project metadata, and initialization promise.

The next recovery attempt creates a new project named `image` and opens a new long-lived Canvas page. Concurrent callers encountering the same invalid session share one recovery promise so they cannot create duplicate recovery projects within that attempt.

Only failures attributable to the shared session trigger invalidation. Prompt rejection, image download failure, upload failure, generation failure, cancellation, expiry, and timeout remain isolated task failures and do not rebuild the session.

Requests already submitted upstream continue polling when possible. If their browser context is lost, they wait for the shared session recovery and resume polling against the same project and `resourceId` only when those identifiers remain valid. If recovery necessarily creates a different project and the old resource cannot be queried from it, the affected task fails explicitly rather than submitting a duplicate generation.

## Temporary Files

Downloaded, decoded, or otherwise materialized reference images are stored under a directory scoped by the local task ID. File names include the image index and a collision-resistant suffix. Each task removes only its own directory after reaching a terminal result.

Cleanup failure is logged but does not replace a successful generation result. Startup may remove abandoned task directories older than the generation timeout, but broad deletion of the shared temporary root is not required for this change.

## Error Handling

Errors retain the existing normalized task-result format. The implementation distinguishes:

- Validation errors before task execution.
- Shared image-session initialization or recovery errors.
- Reference-image materialization and upload errors.
- Generated-resource creation and generation-submission errors.
- Upstream terminal failures, cancellation, and expiry.
- Polling timeout.

A failure in one task changes only that task's persisted result. Other concurrent tasks continue running. Error messages include the failing phase and upstream response where available, without exposing authentication tokens.

## API Compatibility

The following endpoints and their response semantics remain unchanged:

- `POST /api/ask`
- `GET /api/result/:task_id`
- `GET /api/files/:task_id`

`wait_for_completion: false` still returns a local task ID immediately with `status: processing`. `wait_for_completion: true` waits for that specific task. Existing model, prompt, image, count, resolution, style, and ratio fields retain their meanings.

The only externally visible workflow change is that all image tasks use the service's current shared `image` project, while each task still generates with its requested aspect ratio.

## Testing

Automated tests will cover:

- Service startup creates one new project named `image` and opens its `/canvas` URL.
- Two image tasks with different ratios use the same project identifiers and submit their own ratios.
- Multiple requests arriving during initialization wait on one initialization promise and do not create multiple projects.
- A second task reaches generation submission before the first task completes, proving there is no serial queue.
- Concurrent tasks poll only their own `resourceId` and cannot consume each other's results.
- Failure in one task leaves the shared Canvas page open and does not stop another task.
- Browser disconnection or page closure causes one shared recovery attempt.
- Recovery creates a new `image` project rather than reusing an old one.
- Task-specific temporary files do not collide and are cleaned independently.
- Existing task API response normalization remains compatible for image success and failure.
- Existing video workflow behavior remains unchanged.

Tests should mock Puppeteer and upstream browser-context requests. A manual integration check should start the service against the real logged-in profile, verify that the browser defaults to the new `image` Canvas page, submit multiple image requests together, and confirm that all generation calls are issued without waiting for earlier generations to finish.

## Out Of Scope

- Reusing an `image` project from an earlier service run.
- Applying a local concurrency cap, queue, or rate limiter.
- Changing video project selection or video generation behavior.
- Changing the public task API or adding cancellation endpoints.
- Retrying a generation submission when it is ambiguous whether the upstream service accepted it.
