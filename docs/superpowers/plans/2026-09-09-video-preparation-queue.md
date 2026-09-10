# Video Preparation Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize only video project/episode preparation, recover queued videos after restart, and isolate video upload files without making any real generation submission during automated tests.

**Architecture:** Add a small in-process FIFO scheduler that releases its single preparation slot when the video child reports `TASK_STARTED`. Extract child lifecycle parsing into a testable runner, keep prepared children running concurrently, reconstruct queued work from task records at startup, and use task-scoped temporary image directories.

**Tech Stack:** Node.js 20+, ES modules, Express, Puppeteer Core, `node:test`, filesystem-backed JSON task records.

---

## File Map

- Create `nodejs/video-preparation-scheduler.js`: browser-independent FIFO preparation-slot scheduler.
- Create `nodejs/video-preparation-scheduler.test.js`: deterministic concurrency, ordering, release, and failure tests with deferred promises.
- Create `nodejs/video-child-runner.js`: spawn and observe one video workflow child, parse `TASK_STARTED`, enforce preparation timeout, and collect terminal output.
- Create `nodejs/video-child-runner.test.js`: fake-child tests for preparation signals, malformed output, early exit, and timeout.
- Create `nodejs/video-temp-images.js`: task-scoped image materialization, per-task cleanup, and safe abandoned-directory cleanup.
- Create `nodejs/video-temp-images.test.js`: collision isolation, cleanup, and caller-owned path tests.
- Modify `nodejs/task-server.js`: enqueue video requests, publish dynamic queue positions, recover persisted tasks, delegate child execution, and clean abandoned video temporary directories.
- Modify `nodejs/task-server.test.js`: API-level queue, release, image bypass, and startup recovery tests using fake runners only.
- Modify `nodejs/prepare-video-workflow.js`: consume the temporary-image helper and guarantee cleanup in `finally`.
- Modify `package.json`: include the new isolated unit tests in the default test command.
- Modify `docs/task-api.md`: document real video queue semantics and the preparation-only serialization boundary.

This workspace is not a Git repository, so commit steps are intentionally omitted. Each task ends with a test checkpoint instead.

### Task 1: FIFO Preparation Scheduler

**Files:**
- Create: `nodejs/video-preparation-scheduler.js`
- Create: `nodejs/video-preparation-scheduler.test.js`

- [ ] **Step 1: Write the failing serialization and early-release test**

Create deferred controls and assert that only one preparation starts, while completion after preparation does not hold the slot:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoPreparationScheduler } from './video-preparation-scheduler.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('serializes preparation but releases the next task before completion', async () => {
  const controls = new Map();
  const starts = [];
  let preparing = 0;
  let maxPreparing = 0;
  const scheduler = createVideoPreparationScheduler({
    start: async (item, markPrepared) => {
      const prepared = deferred();
      const completed = deferred();
      controls.set(item.id, { prepared, completed });
      starts.push(item.id);
      preparing += 1;
      maxPreparing = Math.max(maxPreparing, preparing);
      await prepared.promise;
      preparing -= 1;
      await markPrepared();
      return completed.promise;
    },
  });

  const first = scheduler.enqueue({ id: 'first' });
  const second = scheduler.enqueue({ id: 'second' });
  await new Promise(setImmediate);
  assert.deepEqual(starts, ['first']);
  assert.equal(scheduler.queuePosition('first'), 0);
  assert.equal(scheduler.queuePosition('second'), 1);

  controls.get('first').prepared.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(starts, ['first', 'second']);
  assert.equal(maxPreparing, 1);

  controls.get('second').prepared.resolve();
  await new Promise(setImmediate);
  controls.get('first').completed.resolve('first-result');
  controls.get('second').completed.resolve('second-result');
  assert.deepEqual(await Promise.all([first, second]), ['first-result', 'second-result']);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test nodejs/video-preparation-scheduler.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `video-preparation-scheduler.js`.

- [ ] **Step 3: Implement the minimal scheduler**

Implement a closure-based scheduler with an idempotent per-entry release function:

```js
export function createVideoPreparationScheduler({ start }) {
  const waiting = [];
  let active = null;

  function queuePosition(id) {
    if (active?.item.id === id) return 0;
    const index = waiting.findIndex((entry) => entry.item.id === id);
    return index < 0 ? null : index + 1;
  }

  function drain() {
    if (active || waiting.length === 0) return;
    const entry = waiting.shift();
    active = entry;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (active === entry) active = null;
      queueMicrotask(drain);
    };
    Promise.resolve()
      .then(() => start(entry.item, release))
      .then(entry.resolve, entry.reject)
      .finally(release);
  }

  function enqueue(item) {
    const promise = new Promise((resolve, reject) => waiting.push({ item, resolve, reject }));
    drain();
    return promise;
  }

  return { enqueue, queuePosition };
}
```

- [ ] **Step 4: Add FIFO and failure-release tests**

Add tests which enqueue `a`, `b`, and `c`, assert start order, reject `a` before `markPrepared`, and verify `b` starts. Add a separate case that calls `markPrepared` twice and verifies `c` never starts early. Use deferred promises only; do not spawn processes.

- [ ] **Step 5: Run scheduler tests**

Run: `node --test nodejs/video-preparation-scheduler.test.js`

Expected: PASS, including an explicit `maxPreparing === 1` assertion.

### Task 2: Testable Video Child Runner

**Files:**
- Create: `nodejs/video-child-runner.js`
- Create: `nodejs/video-child-runner.test.js`

- [ ] **Step 1: Write fake-child tests for `TASK_STARTED` and completion**

Use `EventEmitter` and `PassThrough` to build a fake child. Assert `onPrepared` receives parsed context before terminal completion:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runVideoChild } from './video-child-runner.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalled = false;
  child.kill = () => { child.killCalled = true; child.emit('close', 1); };
  return child;
}

test('reports preparation before collecting the final result', async () => {
  const child = fakeChild();
  let preparedContext;
  const running = runVideoChild({
    spawnImpl: () => child,
    command: 'node',
    args: [],
    options: {},
    preparationTimeoutMs: 1000,
    onPrepared: async (context) => { preparedContext = context; },
  });
  child.stdout.write('TASK_STARTED {"taskEpisode":{"EpisodeId":"episode-1","ShotId":"shot-1"}}\n');
  await new Promise(setImmediate);
  assert.equal(preparedContext.taskEpisode.EpisodeId, 'episode-1');
  child.stdout.write('RESULT_JSON {"generationResult":{"status":"succeeded"}}\n');
  child.emit('close', 0);
  const result = await running;
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /RESULT_JSON/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test nodejs/video-child-runner.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement line parsing and timeout control**

Implement `runVideoChild({ spawnImpl, command, args, options, preparationTimeoutMs, onPrepared })`. It must:

```js
const child = spawnImpl(command, args, options);
let stdout = '';
let stderr = '';
let buffer = '';
let prepared = false;
let preparationError = null;
let preparedWrite = Promise.resolve();

const timer = setTimeout(() => {
  if (prepared) return;
  preparationError = new Error(`视频任务准备超时（${preparationTimeoutMs}ms）`);
  child.kill();
}, preparationTimeoutMs);

child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  stdout += text;
  buffer += text;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.startsWith('TASK_STARTED ') || prepared) continue;
    prepared = true;
    clearTimeout(timer);
    try {
      const context = JSON.parse(line.slice('TASK_STARTED '.length));
      if (!context?.taskEpisode?.EpisodeId || !context?.taskEpisode?.ShotId) {
        throw new Error('TASK_STARTED 缺少 EpisodeId 或 ShotId');
      }
      preparedWrite = Promise.resolve(onPrepared(context));
    } catch (error) {
      preparationError = error;
      child.kill();
    }
  }
});
```

If the async `onPrepared` callback rejects, store that error and kill the child immediately so it cannot continue toward submission after prepared-state persistence failed. On `close`, clear the timer, await `preparedWrite`, reject `preparationError`, reject an exit before valid preparation, and otherwise resolve `{ exitCode, stdout, stderr }`. Ensure `close` can settle only once even if a fake `kill()` synchronously emits it.

- [ ] **Step 4: Add malformed signal, early exit, and timeout tests**

Add these isolated cases:

- `TASK_STARTED` with invalid JSON kills and rejects.
- `TASK_STARTED` without `EpisodeId` or `ShotId` kills and rejects.
- Child closes before `TASK_STARTED` and rejects with a preparation error.
- A 10 ms preparation timeout calls `kill`, rejects, and does not invoke `onPrepared`.
- A failure from async `onPrepared` rejects and does not report successful completion.

- [ ] **Step 5: Run child-runner tests**

Run: `node --test nodejs/video-child-runner.test.js`

Expected: PASS with no real process or browser opened.

### Task 3: Integrate the Preparation Queue Into the Task API

**Files:**
- Modify: `nodejs/task-server.js:1-7,462-588,590-710`
- Modify: `nodejs/task-server.test.js`

- [ ] **Step 1: Write an API-level concurrency test with a fake task runner**

Extend the test server helper so `createTaskApp` receives the fake `runTask`. Submit two asynchronous videos. The fake runner must call `context.onPrepared()` only when its deferred preparation control resolves. Assert:

```js
assert.deepEqual(starts, [first.task_id]);
assert.equal(first.queue_position, 0);
assert.equal(second.queue_position, 1);
firstControl.prepared.resolve();
await new Promise(setImmediate);
assert.deepEqual(starts, [first.task_id, second.task_id]);
assert.equal(maxPreparing, 1);
```

Keep the first task's completion unresolved while asserting the second started. The fake runner writes only temporary test result JSON and never imports or executes `prepare-video-workflow.js`.

- [ ] **Step 2: Run the focused API test and verify it fails**

Run: `node --test --test-name-pattern="serializes video preparation" nodejs/task-server.test.js`

Expected: FAIL because both fake video runners start immediately and the second response reports position `0`.

- [ ] **Step 3: Wire the scheduler into `createTaskApp`**

Import `createVideoPreparationScheduler`. Construct one scheduler per app:

```js
const videoScheduler = createVideoPreparationScheduler({
  start: (item, markPrepared) => runTask(
    item.id,
    item.requestPath,
    item.body,
    'generate_video',
    {
      ...item.context,
      onPrepared: async (taskContext) => {
        await item.context.persistPrepared(taskContext);
        markPrepared();
      },
    },
  ),
});
```

Keep image tasks on the existing immediate `runTask` path. Enqueue video descriptors only after request and running records are persisted. Return `videoScheduler.queuePosition(id)` instead of the hard-coded `0`.

Move the existing prepared-state write from an unawaited stdout callback into a `persistPrepared(taskContext)` function supplied by the app. It writes `debug_task_id`, `status: processing`, `updated_at`, `dramart`, and `completion_response` before `markPrepared()` releases the next video.

- [ ] **Step 4: Delegate child lifecycle handling to `runVideoChild`**

In the video branch of `runDramartTask`, replace direct `spawn` listeners with:

```js
let taskContext = null;
const { exitCode, stdout, stderr } = await runVideoChild({
  spawnImpl: spawn,
  command: process.execPath,
  args,
  options: {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      BROWSER_URL: activeBrowserURL,
      SEEDANCE_TASK_ID: id,
      SUBMIT_DELAY_MS: String(process.env.SUBMIT_DELAY_MS || 3000),
    },
    windowsHide: true,
  },
  preparationTimeoutMs: Number(process.env.VIDEO_PREPARATION_TIMEOUT_MS || 5 * 60 * 1000),
  onPrepared: async (context) => {
    taskContext = context;
    await taskOptions.onPrepared(context);
  },
});
```

Retain the existing `RESULT_JSON` parsing and result normalization after this call, including passing `taskContext` to `buildResultData` for stable debug task information. Update `runDramartTask` to accept `taskOptions = {}` as its fifth argument. Remove duplicate stdout buffering and direct child listeners from `task-server.js`.

- [ ] **Step 5: Publish dynamic queue state from result polling**

When `/api/result/:task_id` reads a queued video record, return its existing processing envelope plus:

```js
const queuePosition = running.action === 'generate_video' && running.status === 'queued'
  ? videoScheduler.queuePosition(id)
  : null;
return res.json({
  status: 'processing',
  message: running.status === 'queued' ? '任务排队中' : '任务处理中',
  queue_position: queuePosition,
  completion_response: running.completion_response,
});
```

Do not expose a queue position after `TASK_STARTED`. Keep the top-level status compatible with existing clients.

- [ ] **Step 6: Add image-bypass and failure-release API tests**

Add one test proving an image fake runner starts immediately while a video occupies the preparation slot. Add another where the first video rejects before `onPrepared`; assert the second starts and the first receives an error result. Neither test may invoke a real script.

- [ ] **Step 7: Run focused task-server tests**

Run: `node --test nodejs/task-server.test.js nodejs/video-preparation-scheduler.test.js nodejs/video-child-runner.test.js`

Expected: PASS; test logs contain no browser URL and no upstream request.

### Task 4: Startup Recovery

**Files:**
- Modify: `nodejs/task-server.js:590-733`
- Modify: `nodejs/task-server.test.js`

- [ ] **Step 1: Write recovery tests using temporary task directories**

Prepare records for queued videos `b` and `a`, one processing video, one processing image, and one queued video that already has a result. Use different `created_at` values. Initialize the app with a fake runner and assert:

```js
assert.deepEqual(videoStarts, ['a']);
assert.equal(app.locals.videoScheduler.queuePosition('a'), 0);
assert.equal(app.locals.videoScheduler.queuePosition('b'), 1);
assert.equal(imageStarts.length, 0);
assert.equal(alreadyCompletedStarts.length, 0);
```

Assert the interrupted processing video gets an error result containing `服务重启导致任务中断`, and its running record is removed. Assert the processing image record remains untouched.

- [ ] **Step 2: Run recovery tests and verify they fail**

Run: `node --test --test-name-pattern="recovery" nodejs/task-server.test.js`

Expected: FAIL because the app does not scan running records.

- [ ] **Step 3: Add explicit app initialization**

Add `initializePersistedTasks()` inside `createTaskApp`. It must await directory creation, list `appRunningDir`, safely parse `.json` records, skip records with an existing result file, and split video records by status.

For interrupted processing videos, write:

```js
const resultData = buildResultData(
  'error',
  record.task_id,
  '',
  { interrupted: true },
  '服务重启导致任务中断；为避免重复创建集或重复提交，任务未自动重跑',
  '',
  record.dramart || null,
  'generate_video',
);
```

Remove that running file only after the error result write succeeds. Sort recoverable queued videos by `created_at`, then task ID, and enqueue using their persisted request paths and an empty body.

Initialization must enqueue recovered descriptors without awaiting their completion promises; otherwise one recovered generation would prevent the HTTP server from starting. Attach the normal per-task error persistence handler to each returned promise.

Expose the initialization promise as `app.locals.ready` and await it at the start of all task API routes. Expose `app.locals.videoScheduler` for state inspection in tests.

- [ ] **Step 4: Ensure the production server initializes before listening**

Change `startTaskServer()` to await `app.locals.ready` before `listen`. Preserve the exported function's usable return value by making it async and returning the listening server:

```js
export async function startTaskServer() {
  const app = createTaskApp();
  await app.locals.ready;
  return app.listen(PORT, () => {
    console.log(`Seedance task server listening on http://127.0.0.1:${PORT}`);
  });
}
```

At the module entry point, call `startTaskServer().catch(...)`, set `process.exitCode = 1`, and print the initialization error.

- [ ] **Step 5: Run recovery and import-safety tests**

Run: `node --test nodejs/task-server.test.js`

Expected: PASS, including the existing import-without-server test and all recovery assertions.

### Task 5: Task-Scoped Video Temporary Images

**Files:**
- Create: `nodejs/video-temp-images.js`
- Create: `nodejs/video-temp-images.test.js`
- Modify: `nodejs/prepare-video-workflow.js:1-14,80-119,993-1069`

- [ ] **Step 1: Write isolated materialization and cleanup tests**

Use `fs.mkdtemp()` under `os.tmpdir()` and construct two helpers with task IDs `task-a` and `task-b`. Materialize one data URL at index `0` for each. Assert paths have different parent directories and both contents remain correct. After cleanup, assert both task directories are gone.

Add a caller-owned file case:

```js
const original = path.join(root, 'owned.png');
await fs.writeFile(original, 'owned');
const resolved = await images.materialize(original, 0);
assert.equal(resolved, original);
await images.cleanup();
assert.equal(await fs.readFile(original, 'utf8'), 'owned');
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test nodejs/video-temp-images.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the helper**

Export `createVideoTempImages({ taskId, tempRoot, fsImpl = fs, fetchImpl = fetch })`. Validate `taskId` against `/^[a-zA-Z0-9_-]+$/`, create `path.join(tempRoot, taskId)`, and return:

```js
return {
  async materialize(value, index) {
    // Existing local paths are returned unchanged.
    // HTTP, data URL, and raw base64 inputs are written below taskDir.
    // Use `${index}-${randomUUID()}${extension}` for generated names.
  },
  async cleanup() {
    await fsImpl.rm(taskDir, { recursive: true, force: true });
  },
  taskDir,
};
```

Move MIME extension detection and the existing HTTP/data/base64 decoding behavior from `prepare-video-workflow.js` into this module. Preserve existing error messages for failed downloads and unsupported data URLs.

Also export a narrowly scoped startup cleanup function:

```js
export async function cleanupAbandonedVideoTempDirs({ tempRoot, activeTaskIds, fsImpl = fs }) {
  const active = new Set(activeTaskIds);
  const entries = await fsImpl.readdir(tempRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => /^[a-zA-Z0-9_-]+$/.test(entry.name))
    .filter((entry) => !active.has(entry.name))
    .map((entry) => fsImpl.rm(path.join(tempRoot, entry.name), { recursive: true, force: true })));
}
```

Add a test with one active task directory, one abandoned task directory, and one unrelated file. Assert only the abandoned task directory is removed.

- [ ] **Step 4: Wrap the video workflow in `try/finally`**

Create the helper only after loading the request:

```js
const tempImages = createVideoTempImages({
  taskId: process.env.SEEDANCE_TASK_ID || `manual-${process.pid}`,
  tempRoot: path.join(__dirname, 'tmp-upload-images'),
});

try {
  const imageFiles = (await Promise.all(
    request.images.map((item, index) => tempImages.materialize(imageValue(item), index)),
  )).filter(Boolean);
  // Keep the existing browser workflow here.
} finally {
  await tempImages.cleanup().catch((error) => {
    console.error(`清理视频临时图片失败: ${String(error)}`);
  });
}
```

Also close the page and disconnect the Puppeteer connection in the same `finally` path when they were created. This ensures preparation and upload failures clean resources, while never deleting caller-owned local files.

- [ ] **Step 5: Run temporary-image tests**

Run: `node --test nodejs/video-temp-images.test.js`

Expected: PASS without network access; HTTP behavior must use a stubbed `fetchImpl` response.

- [ ] **Step 6: Invoke abandoned-directory cleanup after startup recovery**

In `task-server.js`, after queued records are reconstructed and interrupted processing records are converted to results, pass the IDs of all remaining running records to `cleanupAbandonedVideoTempDirs`. Use `path.join(__dirname, 'tmp-upload-images')` as the root. Catch and log cleanup failure so it cannot prevent the server from starting.

Extend the recovery test with active and abandoned temporary directories. Assert the active directory remains and the abandoned directory is removed, without importing or running the video workflow.

### Task 6: Documentation and Complete Simulated Verification

**Files:**
- Modify: `package.json:6-10`
- Modify: `docs/task-api.md:60-73,260-285,320-350`

- [ ] **Step 1: Add all isolated tests to the default command**

Set the test script to:

```json
"test": "node --test nodejs/video-preparation-scheduler.test.js nodejs/video-child-runner.test.js nodejs/video-temp-images.test.js nodejs/image-session.test.js nodejs/live-image-concurrency-test.test.js nodejs/task-server.test.js"
```

`live-image-concurrency-test.test.js` only validates helper behavior and does not execute `live-image-concurrency-test.js`. Confirm this remains true before running the default command.

- [ ] **Step 2: Update API documentation**

Document these exact behaviors:

- Video tasks use a FIFO preparation queue.
- Only project confirmation and task-specific episode/shot creation are serialized.
- `TASK_STARTED` releases the next task, so upload and generation may overlap on separate pages.
- `queue_position: 0` means actively preparing; positive values mean waiting.
- Queued videos recover after restart; interrupted processing videos fail without replay.
- Video temporary uploads are isolated per local task ID.
- Image-generation scheduling remains unchanged.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`

Expected: PASS. No test may print `browser.open`, a real Dramart project URL created during the run, `正在提交视频生成`, or an upstream generation task ID.

- [ ] **Step 4: Run syntax checks without executing workflows**

Run: `node --check nodejs/task-server.js`

Expected: exit code `0`.

Run: `node --check nodejs/prepare-video-workflow.js`

Expected: exit code `0`; `--check` parses but does not execute the top-level workflow.

Run: `node --check nodejs/video-preparation-scheduler.js`

Expected: exit code `0`.

Run: `node --check nodejs/video-child-runner.js`

Expected: exit code `0`.

Run: `node --check nodejs/video-temp-images.js`

Expected: exit code `0`.

- [ ] **Step 5: Inspect the final changes for forbidden live execution**

Review test imports and assertions. Confirm no test imports `prepare-video-workflow.js`, invokes `startTaskServer()` with the production runner, calls `BROWSER_OPEN_API`, or sends `/proxy/api/v1/tasks/video/generate`. Confirm all task-server tests pass `runTask` fakes and temporary directories.

- [ ] **Step 6: Record verification outcome**

Report the exact commands, pass counts, and any skipped live verification. State explicitly that no real video generation was submitted.
