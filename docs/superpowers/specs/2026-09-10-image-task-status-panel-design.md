# Image Task Status Panel Design

## Goal

Add a multi-task status panel to the bottom-right corner of the long-lived image Canvas page. The panel reports whether image generation work is active, the number of active tasks, each task's current stage, and its live elapsed time.

Terminal tasks remain visible for three seconds and then disappear from the list. When no tasks remain, the panel stays visible and displays `当前无任务`.

## Current Architecture

Image generation no longer starts `prepare-image-workflow.js` in a separate page for every request. `task-server.js` now dispatches image requests to the in-process `image-session.js` service. That service creates one image project and keeps one shared Canvas page mounted for the lifetime of the session. All concurrent image tasks upload, submit, and poll through that session.

The single-task `updateTaskStatus()` implementation in `prepare-image-workflow.js` belongs to the obsolete per-task image-window workflow and is not called by the current image execution path. It must not be reused as the state owner for this feature.

Video generation still uses task-specific pages and its existing single-task status panel. Video status behavior is outside this change.

## Chosen Approach

`task-server.js` owns an in-memory image-task status registry. Each accepted image task receives one registry entry. The image runner and `image-session.js` report lifecycle updates to the registry, and the registry renders a complete immutable snapshot into the current long-lived Canvas page after every state change.

The server-side registry is preferred over independent DOM mutation by each image task because concurrent task updates, terminal removal timers, and Canvas page recovery all need one authoritative state. It is preferred over browser polling of a new local endpoint because the server already controls the Puppeteer page and no additional API, cross-origin access, or polling lifecycle is needed.

## Components

### Image Task Status Registry

The task server creates one registry for the service process. Each entry contains:

- Local task ID.
- Start timestamp based on when the service accepts and persists the task.
- Current stage label.
- Optional detail text.
- State: `running`, `success`, or `error`.
- Terminal timestamp when applicable.

The registry provides operations to add a task, update its stage, mark it successful, mark it failed, remove it, and render the current snapshot. Registry operations are synchronous state transitions followed by serialized or coalesced page rendering so that an older asynchronous render cannot overwrite newer state.

The registry counts only `running` entries as active. Success and error entries remain visible during their three-second terminal grace period but do not contribute to the active count.

### Image Session Progress Reporting

`image-session.js` accepts a task progress callback through the existing task options object. It reports only meaningful execution phases:

1. Waiting for or preparing the shared image session.
2. Uploading reference images.
3. Creating the generated-image resource.
4. Submitting image generation.
5. Waiting for generation results.
6. Recovering the shared session when polling context fails.

The image task runner maps completion to `success` and all thrown or normalized failures to `error`. Status-reporting failures are diagnostic only and must not fail or delay image generation.

### Canvas Panel Renderer

The renderer receives a complete JSON-safe snapshot and evaluates one DOM update in the shared Canvas page. It creates or updates a dedicated panel whose ID is distinct from the old single-task panel.

The renderer follows the existing video status card's visual language:

- Fixed to the bottom-right corner.
- Dark translucent background, rounded border, blur, and shadow.
- Blue running state, green success state, and red error state.
- Non-interactive display that does not intercept Canvas pointer input.
- Width constrained for small viewports.

The header reads `Seedance 生图任务` and displays `执行中 N 个`. Each task row shows a shortened but identifiable local task ID, current stage, optional detail, state label, and live `MM:SS` or hour-aware elapsed time.

The browser owns a lightweight one-second display timer that recalculates elapsed labels from the task start timestamps already present in the latest snapshot. It does not poll the server or mutate task state. This avoids a Puppeteer DOM update every second for every active task.

If the snapshot has no entries, the panel remains mounted and shows `当前无任务`.

## Lifecycle And Data Flow

1. `POST /api/ask` validates an image request and persists its request and running record.
2. The server adds a `running` registry entry using the persisted task's `created_at` time before asynchronous execution begins.
3. Authentication waiting and shared-session readiness are represented as the initial stage so accepted tasks are immediately visible.
4. `image-session.js` reports stage changes while preparing uploads, creating the resource, submitting, polling, and recovering.
5. The registry publishes a complete snapshot to the currently mounted Canvas page after every transition.
6. A successful task is marked `success`; a failed task is marked `error` with a safe, concise detail.
7. The terminal entry remains in the snapshot for three seconds.
8. A per-task server timer removes the terminal entry and publishes the next snapshot.
9. When the last entry is removed, the renderer keeps the panel mounted and renders `当前无任务`.

Tasks may finish in any order. Removing one entry must not alter another task's state or timer.

## Session Recovery

The image session may invalidate and create a new Canvas page after browser disconnection, page closure, authentication failure, or another shared-session error. After every successful session initialization or recovery, the session passes the new page to the status registry, which immediately renders its latest snapshot.

The registry survives Canvas page replacement because it belongs to `task-server.js`, not the page. A stale or closed page is detached from rendering. Page rendering errors are logged and ignored by image task execution.

The panel reflects tasks accepted during the current service process. This change does not resume image generation tasks after a full task-server restart. Persisted stale image running records and broader image-task restart recovery remain outside scope.

## Terminal Removal

Both success and failure entries use the same three-second grace period. Repeated terminal updates for the same task do not create multiple removal timers. Removing an already removed task is a no-op.

The implementation should allow timer injection in unit tests so the three-second behavior can be verified without real waits. Service shutdown cleanup may clear outstanding display-removal timers, but these timers do not affect persisted generation results.

## Error Handling

- A panel render failure is logged and never changes a generation result.
- A page replacement causes the latest full snapshot to be rendered into the replacement page.
- A progress update for an unknown or already removed task is ignored.
- Task failure details shown in the panel are concise and must not include authentication tokens, full request payloads, or image data.
- Terminal removal failure or a duplicate callback cannot remove another task.
- One image task's failure cannot clear or overwrite other task rows.

## Testing

Automated tests use fake pages, clocks, and timers. They must not open a browser, upload images, call Dramart, or submit billable work.

Required coverage:

1. Adding two image tasks produces one panel snapshot with active count two and two independent rows.
2. Updating one task changes only that task's stage and detail.
3. Elapsed labels derive from each task's own accepted timestamp and continue updating in browser-side rendering.
4. A successful task remains visible with success state for three seconds, does not count as active, and is then removed.
5. A failed task follows the same three-second lifecycle with error state.
6. Tasks completing in different orders retain and remove the correct rows.
7. Removing the last terminal task leaves the panel visible with `当前无任务`.
8. Replacing the Canvas page renders the latest registry snapshot into the new page.
9. A stale asynchronous page render cannot overwrite a newer registry snapshot.
10. Page evaluation failures do not reject or change an image task result.
11. Image-session progress callbacks cover upload, submission, polling, and recovery phases.
12. Existing image concurrency and result-isolation tests continue to pass.
13. Existing video task panel behavior remains unchanged.

## Out Of Scope

- Modifying the video task status panel.
- Reusing the obsolete `prepare-image-workflow.js` status implementation.
- Adding cancellation, retry, sorting, filtering, collapse controls, or task links.
- Persisting panel-only status across a full service restart.
- Changing image generation concurrency, shared project behavior, task API responses, or result persistence.

## Success Criteria

- The long-lived image Canvas page always shows one multi-task status panel.
- A newly accepted image task appears promptly, including while waiting for authentication or session readiness.
- The header accurately reports the current number of running image tasks.
- Every visible task has an independent current stage and live elapsed time.
- Concurrent updates and out-of-order completions cannot overwrite another task.
- Success and failure rows remain for three seconds and then disappear automatically.
- An empty registry leaves a visible `当前无任务` panel.
- Panel failures do not affect image generation, video generation, or persisted task results.
