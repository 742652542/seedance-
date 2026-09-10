# Video Preparation Queue Design

## Goal

Prevent concurrent video tasks from racing while they select or create a shared ratio project and append a new episode. Only this preparation phase is serialized. Once a task has its own `EpisodeId` and `ShotId`, its image upload, form filling, generation submission, and result polling may overlap with other prepared video tasks.

Image-generation scheduling is outside this change and retains its existing concurrent shared-session behavior.

## Current Risk

Each accepted video request currently starts a separate `prepare-video-workflow.js` child process immediately. Every child performs these operations independently:

1. List projects and select or create the project named for the current date and ratio.
2. List the project's episodes.
3. Use the latest episode as `PreviousEpisodeId` when creating a new episode.
4. Use the number of episodes read before creation to derive the debug episode index.

Concurrent children can observe the same missing project or the same latest episode. This can create duplicate same-name projects, produce nondeterministic episode ordering, and assign duplicate debug episode indexes.

Video reference images also use a shared temporary directory with names based only on the current millisecond and image index. Separate child processes can theoretically choose the same path, and generated temporary files are not currently removed.

## Chosen Approach

The single `task-server.js` process owns an in-memory FIFO video preparation queue reconstructed from persisted task records after a restart. At most one video child process occupies the preparation slot. The slot covers project selection or creation and creation of the task-specific episode and default shot.

The existing `TASK_STARTED` child output is the preparation-complete signal. It already contains the project, `EpisodeId`, and `ShotId`. When the parent receives and validates this signal, it persists the task context, changes the task status to `processing`, releases the preparation slot, and starts the next queued video task. The prepared child continues independently through image upload, form filling, generation submission, and result polling.

This approach is preferred over a cross-process file lock because the parent can expose real queue state, recover queued work after restart, and handle child failures without stale-lock cleanup. Moving all project and episode APIs into the parent would provide a stronger separation but requires an unnecessary rewrite of the existing workflow.

The design assumes exactly one `task-server.js` service instance. It does not coordinate multiple server instances sharing the same task directories.

## Components

### Video Preparation Scheduler

The task server owns one scheduler with:

- A FIFO collection of queued video task descriptors.
- One optional active preparation descriptor.
- A stable ordering based on persisted `created_at`, with task ID as a deterministic tie-breaker.
- A configurable preparation timeout, defaulting to five minutes.
- A drain operation that starts work only when no preparation task is active.

The scheduler interface separates enqueueing and preparation completion from Express request handling so it can be tested without a browser or real child process.

### Video Child Runner

The child runner starts `prepare-video-workflow.js`, captures its output, and reports two independent promises or events:

- `prepared`: resolves once a valid `TASK_STARTED` payload is received; rejects if the child exits, emits malformed preparation data, or times out before that signal.
- `completed`: resolves or rejects when the entire child workflow finishes and its final output has been normalized and persisted.

Releasing the scheduler slot depends only on `prepared`, not `completed`. A failure before preparation releases the slot and fails that task. A failure after preparation affects only that task because the slot has already moved to the next queued item.

### Task-Scoped Video Images

Materialized video images are stored under a directory scoped by `SEEDANCE_TASK_ID`. Generated file names are unique within that directory. Only files created by the workflow are tracked for cleanup; caller-provided local files are never deleted.

The workflow removes its task directory in a `finally` path after success or failure. Cleanup errors are logged and do not replace the generation result.

Each prepared task continues to upload through its own Puppeteer page and its own shot module associated with its saved `EpisodeId` and `ShotId`. Pages share browser authentication but not DOM state or file inputs.

## Task Lifecycle

### New Asynchronous Request

1. Validate and normalize the video request.
2. Persist the request JSON.
3. Persist a running record with `status: queued`.
4. Add the task to the FIFO scheduler.
5. Return immediately with the local task ID and its current queue position.
6. When the preparation slot is available, start the child process and assign queue position `0`.
7. On `TASK_STARTED`, persist project and episode context, change the record to `processing`, and release the slot.
8. Let the child finish independently and persist its existing normalized result.

`wait_for_completion: true` follows the same queue but keeps that request open until the specific task reaches a terminal result.

### Queue Position

The active preparation task has queue position `0`. Waiting tasks have positions `1`, `2`, and so on. Once a task reaches `processing`, it has no queue position because it no longer occupies the preparation queue.

The public top-level asynchronous response remains `status: processing` for compatibility. `completion_response.status` reports the actual internal `queued` or `processing` state. Result polling for a queued task includes its current dynamic `queue_position`; the existing constant placeholder is removed.

### Startup Recovery

Before accepting work, the server scans persisted running records:

- Video records in `queued` state with no completed result are sorted and re-enqueued.
- Video records in `processing` state are not rerun. They are converted to terminal error results explaining that service restart interrupted the task. This avoids duplicate episode creation, generation submission, and billing.
- Records that already have result files are not scheduled.
- Image records are not changed or added to the video scheduler.

Abandoned task-scoped video image directories with no active or recoverable task may be removed during startup. Cleanup must be scoped to known video task directories and must not broadly delete unrelated files.

## Failure Handling

- Project or episode preparation failure writes an error result and releases the slot.
- Child exit before `TASK_STARTED` writes an error result and releases the slot.
- Malformed `TASK_STARTED` output writes an error result and releases the slot.
- Preparation timeout terminates that child, writes an error result, and releases the slot.
- Errors after `TASK_STARTED`, including image upload, parameter verification, submission, generation failure, cancellation, expiry, and polling timeout, affect only that task.
- Only an unconfirmed child exit before a valid `TASK_STARTED` context is persisted blocks the preparation queue. After persistence, the task has left the shared preparation section, so even an unconfirmed later exit does not retroactively block the next preparation.
- A failure while writing task state is logged and handled without leaving the scheduler slot permanently occupied.
- Queue draining continues after every terminal preparation outcome.

## Non-Goals

- Serializing the complete video generation lifecycle.
- Limiting the number of already prepared videos generating upstream.
- Changing image-generation concurrency or its shared image project.
- Coordinating multiple task-server instances.
- Resuming an interrupted `processing` video task after server restart.
- Re-submitting a task whose upstream submission state is uncertain.

## Testing

All tests for this change are isolated simulations. They must not open a real browser, create a real project or episode, upload an image, call the upstream generation API, or submit a billable video task.

The scheduler tests use a controllable fake child runner. Tests manually resolve preparation and completion signals and record preparation concurrency.

Required coverage:

1. Two queued videos do not prepare concurrently; the measured maximum active preparation count is exactly one.
2. The second video begins preparation immediately after the first reports `TASK_STARTED`, even while the first completion remains unresolved.
3. Three tasks start preparation in persisted FIFO order and expose correct dynamic queue positions.
4. Preparation failure releases the slot and starts the next task.
5. Child exit before preparation releases the slot and starts the next task.
6. Preparation timeout releases the slot and starts the next task.
7. A failure after preparation does not affect the queue or another task.
8. Startup recovery re-enqueues only queued video tasks in stable order.
9. Startup recovery converts interrupted processing video tasks to explicit error results without running them.
10. Image requests bypass the video scheduler and retain their current behavior.
11. Task-scoped temporary image paths cannot collide between video tasks.
12. Generated temporary files are removed on both success and failure, while caller-owned local paths are preserved.
13. Existing video routing, response normalization, result polling, and synchronous waiting behavior remain compatible.

The repository's live image concurrency script remains outside the default unit test path for this work and will not be executed as verification.

## Success Criteria

- No more than one video task can select or create a project and append an episode at a time.
- Each prepared task has a distinct persisted `EpisodeId` and `ShotId` before the next task starts preparing.
- Prepared video tasks can upload and generate concurrently on separate pages.
- Video temporary images are isolated by local task ID and cleaned up safely.
- Queued video tasks survive a service restart without replaying uncertain processing tasks.
- Automated verification controls and observes concurrency without any real upstream submission.
