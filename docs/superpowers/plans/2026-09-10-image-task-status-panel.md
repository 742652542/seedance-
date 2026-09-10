# Image Task Status Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show all current image-generation tasks, their stages, and live elapsed times in one concurrency-safe status panel on the long-lived image Canvas page.

**Architecture:** Add a focused server-side image-task status registry that owns task state, terminal-removal timers, the attached Canvas page, and ordered full-snapshot rendering. `image-session.js` emits progress and page-ready callbacks without owning UI state; `task-server.js` connects accepted image requests and their terminal outcomes to the registry. Browser-side code only renders snapshots and refreshes elapsed text once per second.

**Tech Stack:** Node.js 20 ESM, Puppeteer Core, Node built-in test runner, fake Puppeteer pages and injected clocks/timers.

---

## File Structure

- Create `nodejs/image-task-status-panel.js`: own the in-memory task registry, three-second terminal lifecycle, Canvas page attachment, stale-render prevention, panel DOM renderer, and browser elapsed timer.
- Create `nodejs/image-task-status-panel.test.js`: unit-test registry concurrency, task isolation, elapsed rendering inputs, terminal removal, empty state, page replacement, stale renders, and render failure isolation.
- Modify `nodejs/image-session.js`: emit page-ready and task-progress callbacks at concrete generation phases.
- Modify `nodejs/image-session.test.js`: verify progress callbacks and recovered-page notification without changing existing concurrency behavior.
- Modify `nodejs/task-server.js`: instantiate the panel registry, register accepted image tasks, pass progress updates into the image session, and report terminal states.
- Modify `nodejs/task-server.test.js`: verify server and runner lifecycle wiring, including authentication waiting and thrown failures.
- Modify `package.json`: include the new focused test file in `npm test`.

### Task 1: Registry State And Terminal Lifecycle

**Files:**
- Create: `nodejs/image-task-status-panel.js`
- Create: `nodejs/image-task-status-panel.test.js`
- Modify: `package.json:9`

- [ ] **Step 1: Write failing registry tests**

Create tests with an injected clock and timer queue. Verify two tasks remain independent, only running tasks count as active, terminal entries remain for exactly three seconds, completion order does not cross-remove rows, and the final snapshot is empty rather than deleting panel state.

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createImageTaskStatusPanel } from './image-task-status-panel.js';

function harness() {
  let now = 10_000;
  const timers = [];
  const renders = [];
  const panel = createImageTaskStatusPanel({
    now: () => now,
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return callback; },
    clearTimeout: () => {},
    render: async (_page, snapshot) => { renders.push(snapshot); },
    log: () => {},
  });
  return { panel, renders, timers, setNow: (value) => { now = value; } };
}

test('tracks concurrent image tasks independently', async () => {
  const { panel } = harness();
  panel.add('task-a', 1_000);
  panel.add('task-b', 2_000);
  panel.update('task-a', '上传参考图', '2 张图片');
  assert.deepEqual(panel.snapshot(), {
    activeCount: 2,
    tasks: [
      { id: 'task-a', startedAt: 1_000, stage: '上传参考图', detail: '2 张图片', state: 'running' },
      { id: 'task-b', startedAt: 2_000, stage: '等待任务执行', detail: '', state: 'running' },
    ],
  });
});

test('keeps terminal tasks for three seconds then leaves an empty snapshot', async () => {
  const { panel, timers } = harness();
  panel.add('task-a', 1_000);
  panel.succeed('task-a');
  assert.equal(panel.snapshot().activeCount, 0);
  assert.equal(panel.snapshot().tasks[0].state, 'success');
  assert.equal(timers[0].delay, 3_000);
  timers[0].callback();
  assert.deepEqual(panel.snapshot(), { activeCount: 0, tasks: [] });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test nodejs/image-task-status-panel.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` because `image-task-status-panel.js` does not exist.

- [ ] **Step 3: Implement minimal registry transitions**

Implement `createImageTaskStatusPanel(options)` with private `Map` objects for tasks and removal timers. Use insertion order for rows and clone every snapshot so callers cannot mutate registry state.

```js
export function createImageTaskStatusPanel(options = {}) {
  const now = options.now || Date.now;
  const schedule = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  const terminalDelayMs = options.terminalDelayMs ?? 3_000;
  const tasks = new Map();
  const removalTimers = new Map();
  let page = null;

  function snapshot() {
    const rows = [...tasks.values()].map((task) => ({ ...task }));
    return { activeCount: rows.filter((task) => task.state === 'running').length, tasks: rows };
  }

  function add(id, startedAt = now()) {
    if (!tasks.has(id)) tasks.set(id, { id, startedAt, stage: '等待任务执行', detail: '', state: 'running' });
    publish();
  }

  function update(id, stage, detail = '') {
    const task = tasks.get(id);
    if (!task || task.state !== 'running') return;
    Object.assign(task, { stage, detail });
    publish();
  }

  function finish(id, state, detail = '') {
    const task = tasks.get(id);
    if (!task || task.state !== 'running') return;
    Object.assign(task, { state, stage: state === 'success' ? '已完成' : '执行失败', detail, finishedAt: now() });
    publish();
    const timer = schedule(() => {
      if (removalTimers.get(id) !== timer) return;
      removalTimers.delete(id);
      tasks.delete(id);
      publish();
    }, terminalDelayMs);
    removalTimers.set(id, timer);
  }

  function succeed(id, detail = '') { finish(id, 'success', detail); }
  function fail(id, detail = '') { finish(id, 'error', detail); }
```

Complete the module with `snapshot`, `add`, `update`, `succeed`, `fail`, and later rendering methods. Ignore updates for unknown or terminal tasks, and ensure duplicate terminal calls do not schedule another timer.

- [ ] **Step 4: Add completion-order and duplicate-callback tests**

Add tests that finish `task-b` before `task-a`, invoke `fail('task-b')` twice, fire each captured callback, and assert each callback removes only its own row.

- [ ] **Step 5: Run focused tests**

Run: `node --test nodejs/image-task-status-panel.test.js`

Expected: PASS for state, active-count, timer, duplicate-callback, and removal-isolation tests.

- [ ] **Step 6: Add the test to the package script**

Update `package.json` so `npm test` starts with:

```json
"test": "node --test nodejs/image-task-status-panel.test.js nodejs/video-preparation-scheduler.test.js nodejs/video-child-runner.test.js nodejs/video-temp-images.test.js nodejs/prepare-video-workflow.test.js nodejs/image-session.test.js nodejs/live-image-concurrency-test.test.js nodejs/task-server.test.js"
```

- [ ] **Step 7: Commit when Git is available**

Run: `git add nodejs/image-task-status-panel.js nodejs/image-task-status-panel.test.js package.json && git commit -m "feat: add image task status registry"`

Current workspace note: skip this step because `F:\Development\workspace\seedance` is not a Git repository.

### Task 2: Canvas Panel Rendering And Page Recovery

**Files:**
- Modify: `nodejs/image-task-status-panel.js`
- Modify: `nodejs/image-task-status-panel.test.js`

- [ ] **Step 1: Write failing rendering tests**

Use fake pages whose `evaluate` method records its arguments. Verify `attachPage(page)` immediately renders `{ activeCount: 0, tasks: [] }`, subsequent task transitions render complete snapshots, attaching a replacement page renders current tasks, and a rejected evaluation is logged without rejecting `add`, `update`, or terminal methods.

```js
test('attaching a replacement page replays the latest full snapshot', async () => {
  const callsA = [];
  const callsB = [];
  const first = { isClosed: () => false, evaluate: async (_fn, data) => { callsA.push(data); } };
  const second = { isClosed: () => false, evaluate: async (_fn, data) => { callsB.push(data); } };
  const panel = createImageTaskStatusPanel({ log: () => {} });
  panel.attachPage(first);
  panel.add('task-a', 1_000);
  await panel.flush();
  panel.attachPage(second);
  await panel.flush();
  assert.equal(callsB.at(-1).tasks[0].id, 'task-a');
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test nodejs/image-task-status-panel.test.js`

Expected: FAIL because `attachPage()` and `flush()` are not implemented.

- [ ] **Step 3: Implement ordered full-snapshot publication**

Maintain a monotonically increasing revision and one promise chain. Each state mutation captures a fresh snapshot and appends a render operation. Before evaluating, skip work if its revision is older than the latest queued revision or its page is no longer attached. Catch and log evaluation errors.

```js
let revision = 0;
let renderChain = Promise.resolve();

function publish() {
  const targetPage = page;
  const data = snapshot();
  const renderRevision = ++revision;
  renderChain = renderChain.then(async () => {
    if (!targetPage || targetPage !== page || targetPage.isClosed?.() || renderRevision < revision) return;
    await render(targetPage, data);
  }).catch((error) => options.log?.(`[image-task-panel.render_error] error=${String(error)}`));
}

function attachPage(nextPage) {
  page = nextPage;
  publish();
}

function flush() { return renderChain; }
```

Export `attachPage` and `flush` from the returned registry object. Keep all generation-facing methods synchronous and non-throwing.

- [ ] **Step 4: Implement the Canvas DOM renderer**

Add an exported `renderImageTaskStatusPanel(page, snapshot)` default renderer. In one `page.evaluate`, create `#seedance-image-task-status-panel`, apply the same fixed dark-card visual language as the video panel, escape task values by assigning text through DOM properties rather than interpolating untrusted details into HTML, and create one row per task.

The evaluated browser function must:

```js
const PANEL_ID = 'seedance-image-task-status-panel';
const TIMER_KEY = '__seedanceImageTaskElapsedTimer';
const panel = document.getElementById(PANEL_ID) || document.body.appendChild(document.createElement('section'));
panel.id = PANEL_ID;
panel.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;width:340px;max-width:calc(100vw - 40px);padding:16px;border:1px solid rgba(255,255,255,.16);border-radius:14px;background:rgba(17,24,39,.94);box-shadow:0 16px 45px rgba(0,0,0,.32);color:#f8fafc;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;backdrop-filter:blur(12px);pointer-events:none';
```

Render the title `Seedance 生图任务`, header count `执行中 ${snapshot.activeCount} 个`, and `当前无任务` when `snapshot.tasks.length === 0`. Rows include a shortened ID that retains the final five-character suffix, stage, detail when present, state label, and a node with `data-started-at`.

Install exactly one one-second interval on `window[TIMER_KEY]`. Its callback formats `Date.now() - startedAt` as `MM:SS` below one hour and `HH:MM:SS` at or above one hour. The interval reads the current DOM nodes, so snapshots do not need per-second Puppeteer evaluation.

- [ ] **Step 5: Test the browser renderer as a serializable function boundary**

Assert that the fake page receives JSON-safe timestamps in milliseconds, active count, all task rows, and no raw request/image data. Test a closed page and an evaluation rejection both leave registry state intact.

- [ ] **Step 6: Run focused tests**

Run: `node --test nodejs/image-task-status-panel.test.js`

Expected: PASS, including page replacement, empty panel, stale-render, and error-isolation tests.

- [ ] **Step 7: Commit when Git is available**

Run: `git add nodejs/image-task-status-panel.js nodejs/image-task-status-panel.test.js && git commit -m "feat: render image task status panel"`

Current workspace note: skip because the directory is not a Git repository.

### Task 3: Image Session Progress Hooks

**Files:**
- Modify: `nodejs/image-session.js:140-218,294-394`
- Modify: `nodejs/image-session.test.js:39-156,158-537`

- [ ] **Step 1: Write failing progress and page-ready tests**

Add `onSessionReady` to the session harness and pass `onProgress` to `runTask`. Assert initialization reports its final Canvas page once and a normal task emits these stages in order:

```js
[
  ['preparing_session', '准备生图会话'],
  ['uploading_references', '正在上传参考图'],
  ['creating_resource', '正在创建生图资源'],
  ['submitting', '正在提交图片生成'],
  ['generating', '图片生成中'],
]
```

Add a recovery test asserting the recovered page is also passed to `onSessionReady` and `recovering_session` is reported without resubmitting generation.

- [ ] **Step 2: Run session tests and verify failure**

Run: `node --test nodejs/image-session.test.js`

Expected: FAIL because the callbacks are not emitted.

- [ ] **Step 3: Add non-fatal callback helpers**

Capture `options.onSessionReady` in `createImageSession`. Add a callback wrapper that catches synchronous errors and promise rejections and logs them without affecting generation:

```js
async function notify(callback, value, label) {
  try {
    await callback?.(value);
  } catch (error) {
    log(`[image-session.${label}_error] error=${String(error)}`);
  }
}
```

After the Canvas navigation and state assignment in `initialize()`, call `notify(onSessionReady, initialized.page, 'session_ready_callback')` before returning the initialized session.

- [ ] **Step 4: Emit meaningful task phases**

At the start of `runTask`, invoke `onProgress` with `{ code, stage, detail }` objects. Emit:

```js
await notify(taskOptions.onProgress, { code: 'preparing_session', stage: '准备生图会话', detail: '' }, 'progress_callback');
sessionState = await ensureReady();
await taskOptions.onReady?.(sessionState);
await notify(taskOptions.onProgress, { code: 'uploading_references', stage: '正在上传参考图', detail: `${request.images.length} 张图片` }, 'progress_callback');
// materialize and upload
await notify(taskOptions.onProgress, { code: 'creating_resource', stage: '正在创建生图资源', detail: '' }, 'progress_callback');
// create resource
await notify(taskOptions.onProgress, { code: 'submitting', stage: '正在提交图片生成', detail: `${request.modelName} · ${request.ratio} · ${request.count} 张` }, 'progress_callback');
// submit
await notify(taskOptions.onProgress, { code: 'generating', stage: '图片生成中', detail: `${request.modelName} · ${request.ratio} · ${request.count} 张` }, 'progress_callback');
```

Before session recovery in the polling catch path, emit `{ code: 'recovering_session', stage: '正在恢复生图会话', detail: '' }`; after recovery, emit `generating` again.

- [ ] **Step 5: Verify callback failures are isolated**

Add a test with rejecting `onProgress` and `onSessionReady` callbacks. Assert `runTask` still returns `succeeded` and the errors are logged.

- [ ] **Step 6: Run image session tests**

Run: `node --test nodejs/image-session.test.js`

Expected: PASS, including all existing shared-session, concurrency, recovery, size-limit, and cleanup tests.

- [ ] **Step 7: Commit when Git is available**

Run: `git add nodejs/image-session.js nodejs/image-session.test.js && git commit -m "feat: report image task progress"`

Current workspace note: skip because the directory is not a Git repository.

### Task 4: Task Server Lifecycle Integration

**Files:**
- Modify: `nodejs/task-server.js:8-12,384-394,687-724,821-955,1071-1145`
- Modify: `nodejs/task-server.test.js:8-23,1424-1436,1495-1514`

- [ ] **Step 1: Write failing image-runner lifecycle tests**

Import `createImageTaskStatusPanel` only in the implementation module; inject a fake status panel into `createImageTaskRunner` tests. Verify `onProgress` forwards stage/detail, success calls `succeed(id)`, a normalized failed generation calls `fail(id, reason)`, and thrown session failures call `fail` before rethrowing for existing persistence handling.

```js
const events = [];
const statusPanel = {
  update: (id, stage, detail) => events.push(['update', id, stage, detail]),
  succeed: (id) => events.push(['success', id]),
  fail: (id, detail) => events.push(['error', id, detail]),
};
```

- [ ] **Step 2: Run focused server tests and verify failure**

Run: `node --test --test-name-pattern="image task" nodejs/task-server.test.js`

Expected: FAIL because `createImageTaskRunner` does not use the status panel or progress callback.

- [ ] **Step 3: Wire progress and terminal outcomes into the image runner**

Extend `createImageTaskRunner(options)` so `imageSession.runTask` receives:

```js
onProgress: ({ stage, detail }) => options.statusPanel.update(id, stage, detail),
```

After persisting the result and removing the running record, call `statusPanel.succeed(id)` for success or `statusPanel.fail(id, safePanelError(resultData.error))` for failure. Wrap the session call in `try/catch`; on a thrown error call `statusPanel.fail(id, safePanelError(error))` and rethrow. Implement `safePanelError` as a concise string capped at 160 characters, with no request payload included.

- [ ] **Step 4: Write failing request-registration tests**

Inject `imageTaskStatusPanel` into `createTaskApp`. Submit an image request while authentication is blocked and assert `add(id, createdAtMs)` happens before dispatch, with stage `等待任务执行` still present. Submit a video request and assert it never touches the image panel.

- [ ] **Step 5: Register accepted image tasks with millisecond timestamps**

In `createTaskApp`, select `const appImageTaskStatusPanel = options.imageTaskStatusPanel || imageTaskStatusPanel`. Immediately after the image running record is persisted and before authentication begins, call:

```js
if (action === 'generate_image') appImageTaskStatusPanel.add(id, taskRecord.created_at * 1000);
```

Pass the panel through task options to the default image runner. If asynchronous task execution throws before the image runner handles it, mark the image entry failed in `observeTask` using the same safe error text. Duplicate terminal reporting remains harmless by registry contract.

- [ ] **Step 6: Instantiate and attach the global panel**

Import `createImageTaskStatusPanel`, create one process-level `imageTaskStatusPanel` with `log: debugLog`, and pass this callback into `createImageSession`:

```js
onSessionReady: (page) => imageTaskStatusPanel.attachPage(page),
```

Create the global image runner with `{ imageSession, imageTaskStatusPanel, ... }`. This ensures initial session startup and every recovered Canvas page receive the latest complete registry snapshot.

- [ ] **Step 7: Run focused lifecycle tests**

Run: `node --test --test-name-pattern="image task|authentication" nodejs/task-server.test.js`

Expected: PASS. Accepted image tasks appear while authentication waits; progress and terminal events are isolated; video requests do not enter the image registry.

- [ ] **Step 8: Commit when Git is available**

Run: `git add nodejs/task-server.js nodejs/task-server.test.js && git commit -m "feat: connect image tasks to status panel"`

Current workspace note: skip because the directory is not a Git repository.

### Task 5: Full Regression And Safety Verification

**Files:**
- Verify: `nodejs/image-task-status-panel.js`
- Verify: `nodejs/image-session.js`
- Verify: `nodejs/task-server.js`
- Verify: `nodejs/image-task-status-panel.test.js`
- Verify: `nodejs/image-session.test.js`
- Verify: `nodejs/task-server.test.js`
- Verify: `package.json`

- [ ] **Step 1: Run syntax checks**

Run: `node --check nodejs/image-task-status-panel.js`

Run: `node --check nodejs/image-session.js`

Run: `node --check nodejs/task-server.js`

Expected: all commands exit with code 0 and no output.

- [ ] **Step 2: Run the three directly affected test suites**

Run: `node --test nodejs/image-task-status-panel.test.js nodejs/image-session.test.js nodejs/task-server.test.js`

Expected: PASS with zero failed, cancelled, or skipped tests.

- [ ] **Step 3: Run the complete project suite**

Run: `npm test`

Expected: PASS. Do not run `nodejs/live-image-concurrency-test.js` directly; only its parser unit test belongs to the default suite, so verification must not submit real billable image tasks.

- [ ] **Step 4: Inspect feature boundaries**

Confirm with searches that `prepare-video-workflow.js` was not modified, `prepare-image-workflow.js` remains unused and unmodified, panel detail strings contain no prompt or image payload, and no new public API endpoint was added.

Run: `git diff -- nodejs package.json docs/superpowers` only if Git becomes available. Otherwise read the touched files and compare them against this plan.

- [ ] **Step 5: Optional non-billable manual UI check**

Start the local task server only in an already authenticated development environment. Confirm the long-lived image Canvas page displays `当前无任务`, but do not submit a generation unless the user explicitly authorizes a billable live test.

- [ ] **Step 6: Commit when Git is available**

Run: `git add nodejs/image-task-status-panel.js nodejs/image-task-status-panel.test.js nodejs/image-session.js nodejs/image-session.test.js nodejs/task-server.js nodejs/task-server.test.js package.json docs/superpowers/specs/2026-09-10-image-task-status-panel-design.md docs/superpowers/plans/2026-09-10-image-task-status-panel.md && git commit -m "feat: show concurrent image task status"`

Current workspace note: skip because the directory is not a Git repository.
