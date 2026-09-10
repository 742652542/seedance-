import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import { openTaskPage } from './prepare-video-workflow.js';
import {
  createAuthenticationGate,
  createImageSessionWithStatusPanel,
  createImageTaskRunner,
  createStandbyBrowserManager,
  createTaskApp,
  cleanupVideoTaskResources,
  listenTaskApp,
  readJson,
  resolveImageModel,
  runDramartTask,
  safePanelCall,
  safePanelError,
  startTaskServer,
  taskExecutionPlan,
  writeJson,
} from './task-server.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function withDeadline(promise, message, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withServer(runTask, callback, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-test-'));
  const resolvedOptions = {
    ...options,
    ...(typeof options.videoTempRoot === 'function' ? { videoTempRoot: options.videoTempRoot(root) } : {}),
  };
  const app = createTaskApp({
    runTask,
    runningDir: path.join(root, 'running'),
    resultsDir: path.join(root, 'results'),
    requestsDir: path.join(root, 'requests'),
    ...resolvedOptions,
  });
  const server = app.listen(0);
  await withDeadline(new Promise((resolve) => server.once('listening', resolve)), 'test server did not listen');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback(baseUrl, root, app);
  } finally {
    await withDeadline(new Promise((resolve) => server.close(resolve)), 'test server did not close');
    await fs.rm(root, { recursive: true, force: true });
  }
}

function imageBody(overrides = {}) {
  return {
    action: 'generate_image',
    prompt: 'product',
    images: [{ url: 'data:image/png;base64,aW1hZ2U=' }],
    ratio: '1:1',
    ...overrides,
  };
}

function videoBody(overrides = {}) {
  return {
    action: 'generate_video',
    model: 'doubao-seedance-2-0-fast-260128',
    prompt: 'video',
    duration: 5,
    resolution: '720p',
    ...overrides,
  };
}

async function waitUntil(predicate, message) {
  await withDeadline((async () => {
    while (!predicate()) await new Promise(setImmediate);
  })(), message);
}

async function postAsk(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
  return response.json();
}

async function getJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`, { signal: AbortSignal.timeout(2000) });
  return response.json();
}

async function pollResultUntilCompleted(baseUrl, taskId, message, timeoutMs = 2000) {
  return withDeadline((async () => {
    while (true) {
      const result = await getJson(baseUrl, `/api/result/${taskId}`);
      if (result.status === 'completed') return result;
      await new Promise(setImmediate);
    }
  })(), message, timeoutMs);
}

test('importing task-server exits without listening or starting production services', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', "await import('./nodejs/task-server.js'); console.log('imported')"], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, SEEDANCE_DEBUG: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const exitCode = await withDeadline(new Promise((resolve) => child.once('close', resolve)), 'task-server import did not exit by itself', 3000);
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /^imported\s*$/m);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

async function writeTaskJson(directory, id, data) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify(data), 'utf8');
}

test('atomic JSON writes preserve old data when temp writing fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-atomic-write-'));
  const filePath = path.join(root, 'task.json');
  await fs.writeFile(filePath, JSON.stringify({ status: 'old' }), 'utf8');
  let removedPath = '';
  try {
    await assert.rejects(writeJson(filePath, { status: 'new' }, {
      open: async () => ({ writeFile: async () => { throw new Error('temp write failed'); }, sync: async () => {}, close: async () => {} }),
      rename: fs.rename.bind(fs),
      rm: async (tempPath) => { removedPath = tempPath; },
    }), /temp write failed/);
    assert.deepEqual(await readJson(filePath), { status: 'old' });
    assert.ok(removedPath);
    assert.notEqual(removedPath, filePath);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('atomic JSON writes preserve old data and clean temp files when rename fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-atomic-rename-'));
  const filePath = path.join(root, 'task.json');
  await fs.writeFile(filePath, JSON.stringify({ status: 'old' }), 'utf8');
  try {
    await assert.rejects(writeJson(filePath, { status: 'new' }, {
      open: fs.open.bind(fs),
      rename: async () => { throw new Error('rename failed'); },
      rm: fs.rm.bind(fs),
    }), /rename failed/);
    assert.deepEqual(await readJson(filePath), { status: 'old' });
    assert.deepEqual(await fs.readdir(root), ['task.json']);
    await writeJson(filePath, { status: 'new' });
    assert.deepEqual(await readJson(filePath), { status: 'new' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('atomic JSON writer uses unique same-directory temp files in durable order', async () => {
  const destination = path.join('C:\\tasks', 'task.json');
  const events = [];
  const opened = [];
  const fsImpl = {
    open: async (tempPath, flag) => {
      opened.push(tempPath);
      events.push(['open', tempPath, flag]);
      return {
        writeFile: async (content, encoding) => { events.push(['writeFile', content, encoding]); },
        sync: async () => { events.push(['sync']); },
        close: async () => { events.push(['close']); },
      };
    },
    rename: async (from, to) => { events.push(['rename', from, to]); },
    rm: async (tempPath, options) => { events.push(['rm', tempPath, options]); },
  };

  await writeJson(destination, { value: 1 }, fsImpl);
  await writeJson(destination, { value: 2 }, fsImpl);

  assert.equal(opened.length, 2);
  assert.notEqual(opened[0], opened[1]);
  for (const tempPath of opened) {
    assert.equal(path.dirname(tempPath), path.dirname(destination));
    assert.notEqual(tempPath, destination);
    assert.equal(path.extname(tempPath), '.tmp');
  }
  assert.deepEqual(events.map((event) => event[0]), [
    'open', 'writeFile', 'sync', 'close', 'rename',
    'open', 'writeFile', 'sync', 'close', 'rename',
  ]);
  assert.equal(events[0][2], 'wx');
  assert.equal(events[5][2], 'wx');
  assert.deepEqual(events[4].slice(1), [opened[0], destination]);
  assert.deepEqual(events[9].slice(1), [opened[1], destination]);
});

test('atomic JSON writer best-effort removes its temp file after a recorded failure', async () => {
  const destination = path.join('C:\\tasks', 'task.json');
  const events = [];
  let tempPath;
  await assert.rejects(writeJson(destination, { value: 1 }, {
    open: async (candidate, flag) => {
      tempPath = candidate;
      events.push(['open', candidate, flag]);
      return {
        writeFile: async () => { events.push(['writeFile']); throw new Error('write failed'); },
        sync: async () => { events.push(['sync']); },
        close: async () => { events.push(['close']); },
      };
    },
    rename: async () => { events.push(['rename']); },
    rm: async (candidate, options) => { events.push(['rm', candidate, options]); },
  }), /write failed/);
  assert.deepEqual(events, [
    ['open', tempPath, 'wx'],
    ['writeFile'],
    ['close'],
    ['rm', tempPath, { force: true }],
  ]);
});

test('startup recovery ignores atomic-write temp remnants', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-temp-index-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  await Promise.all([runningDir, resultsDir, requestsDir].map((directory) => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(path.join(runningDir, '.dramart-20260909000000-aaaaa.json.partial.tmp'), '{broken', 'utf8');
  const app = createTaskApp({ runningDir, resultsDir, requestsDir, runTask: async () => {} });
  try {
    await app.locals.ready;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery restores queued videos in persisted order and interrupts only processing videos', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const ids = {
    a: 'dramart-20260909000000-aaaaa',
    b: 'dramart-20260909000000-bbbbb',
    processing: 'dramart-20260909000000-ccccc',
    image: 'dramart-20260909000000-ddddd',
    completed: 'dramart-20260909000000-eeeee',
  };
  const processingContext = { project: { projectName: 'persisted-project' }, taskEpisode: { EpisodeId: 'episode-7', ShotId: 'shot-7' } };
  await Promise.all([
    writeTaskJson(runningDir, ids.b, { task_id: ids.b, action: 'generate_video', status: 'queued', created_at: 20 }),
    writeTaskJson(runningDir, ids.a, { task_id: ids.a, action: 'generate_video', status: 'queued', created_at: 10 }),
    writeTaskJson(runningDir, ids.processing, { task_id: ids.processing, action: 'generate_video', status: 'processing', created_at: 5, dramart: processingContext }),
    writeTaskJson(runningDir, ids.image, { task_id: ids.image, action: 'generate_image', status: 'processing', created_at: 1 }),
    writeTaskJson(runningDir, ids.completed, { task_id: ids.completed, action: 'generate_video', status: 'queued', created_at: 0 }),
    writeTaskJson(requestsDir, ids.a, { prompt: 'a' }),
    writeTaskJson(requestsDir, ids.b, { prompt: 'b' }),
    writeTaskJson(requestsDir, ids.completed, { prompt: 'completed' }),
    writeTaskJson(resultsDir, ids.completed, { task_id: ids.completed, status: 'success' }),
  ]);

  const starts = [];
  const completion = deferred();
  const app = createTaskApp({
    runningDir,
    resultsDir,
    requestsDir,
    runTask: async (id, requestPath, body, action) => {
      starts.push({ id, requestPath, body, action });
      return completion.promise;
    },
  });
  try {
    await withDeadline(app.locals.ready, 'startup recovery waited for task completion');
    assert.deepEqual(starts.map((item) => item.id), [ids.a]);
    assert.equal(starts[0].requestPath, path.join(requestsDir, `${ids.a}.json`));
    assert.equal(starts[0].action, 'generate_video');
    assert.equal(starts[0].body.action, 'generate_video');
    assert.equal(app.locals.videoScheduler.queuePosition(ids.a), 0);
    assert.equal(app.locals.videoScheduler.queuePosition(ids.b), 1);

    const interrupted = JSON.parse(await fs.readFile(path.join(resultsDir, `${ids.processing}.json`), 'utf8'));
    assert.equal(interrupted.status, 'error');
    assert.match(interrupted.error, /服务重启导致任务中断；为避免重复创建集或重复提交，任务未自动重跑/);
    assert.equal(interrupted.completion_response.interrupted, true);
    assert.equal(interrupted.completion_response.project_name, 'persisted-project');
    assert.equal(interrupted.completion_response.taskEpisode.EpisodeId, 'episode-7');
    assert.equal(interrupted.project_name, 'persisted-project');
    assert.deepEqual(interrupted.dramart, processingContext);
    await assert.rejects(fs.access(path.join(runningDir, `${ids.processing}.json`)), { code: 'ENOENT' });
    assert.equal(JSON.parse(await fs.readFile(path.join(runningDir, `${ids.image}.json`), 'utf8')).status, 'processing');
    await assert.rejects(fs.access(path.join(runningDir, `${ids.completed}.json`)), { code: 'ENOENT' });
  } finally {
    completion.resolve();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery reports existing-result running cleanup failure without blocking readiness', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-existing-result-rm-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const id = 'dramart-20260909000000-aaaaa';
  const backgroundErrors = [];
  await Promise.all([
    writeTaskJson(runningDir, id, { task_id: id, action: 'generate_video', status: 'queued' }),
    writeTaskJson(resultsDir, id, { task_id: id, status: 'success' }),
  ]);
  const app = createTaskApp({
    runningDir,
    resultsDir,
    requestsDir,
    runTask: async () => { throw new Error('must not run'); },
    rm: async () => { throw new Error('existing running cleanup failed'); },
    onBackgroundError: (error) => backgroundErrors.push(error),
  });
  try {
    await withDeadline(app.locals.ready, 'cleanup failure blocked startup recovery');
    assert.equal(backgroundErrors.length, 1);
    assert.match(String(backgroundErrors[0]), /existing running cleanup failed/);
    assert.equal((await readJson(path.join(resultsDir, `${id}.json`))).status, 'success');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery cleans abandoned video temp directories and conservatively keeps all running task IDs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-temp-recovery-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const tempRoot = path.join(root, 'video-temp');
  const active = 'dramart-20260910000000-kkkkk';
  const abandoned = 'dramart-20260910000000-lllll';
  await Promise.all([
    writeTaskJson(runningDir, active, { task_id: active, action: 'generate_image', status: 'processing' }),
    fs.mkdir(path.join(tempRoot, active), { recursive: true }),
    fs.mkdir(path.join(tempRoot, abandoned), { recursive: true }),
  ]);
  const app = createTaskApp({ runningDir, resultsDir, requestsDir, videoTempRoot: tempRoot, runTask: async () => { throw new Error('must not run'); } });
  try {
    await app.locals.ready;
    await fs.access(path.join(tempRoot, active));
    await assert.rejects(fs.access(path.join(tempRoot, abandoned)), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup abandoned temp cleanup failure does not block readiness', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-temp-cleanup-failure-'));
  const app = createTaskApp({
    runningDir: path.join(root, 'running'),
    resultsDir: path.join(root, 'results'),
    requestsDir: path.join(root, 'requests'),
    runTask: async () => {},
    cleanupVideoTempDirs: async () => { throw new Error('cleanup unavailable'); },
  });
  try {
    await withDeadline(app.locals.ready, 'cleanup failure blocked startup');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery uses task_id as a stable tie-breaker', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-tie-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const a = 'dramart-20260909000000-aaaaa';
  const b = 'dramart-20260909000000-bbbbb';
  await Promise.all([
    writeTaskJson(runningDir, b, { task_id: b, action: 'generate_video', status: 'queued', created_at: 10 }),
    writeTaskJson(runningDir, a, { task_id: a, action: 'generate_video', status: 'queued', created_at: 10 }),
    writeTaskJson(requestsDir, a, {}),
    writeTaskJson(requestsDir, b, {}),
  ]);
  const completion = deferred();
  const starts = [];
  const app = createTaskApp({ runningDir, resultsDir, requestsDir, runTask: async (id) => { starts.push(id); return completion.promise; } });
  try {
    await app.locals.ready;
    assert.deepEqual(starts, [a]);
    assert.equal(app.locals.videoScheduler.queuePosition(b), 1);
  } finally {
    completion.resolve();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('processing recovery keeps its terminal result when running-file cleanup fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-rm-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const id = 'dramart-20260909000000-aaaaa';
  await writeTaskJson(runningDir, id, { task_id: id, action: 'generate_video', status: 'processing', dramart: { projectName: 'context' } });
  const app = createTaskApp({
    runningDir,
    resultsDir,
    requestsDir,
    runTask: async () => { throw new Error('must not run'); },
    rm: async () => { throw new Error('running cleanup failed'); },
  });
  try {
    await app.locals.ready;
    const result = JSON.parse(await fs.readFile(path.join(resultsDir, `${id}.json`), 'utf8'));
    assert.equal(result.status, 'error');
    assert.match(result.error, /服务重启导致任务中断/);
    await fs.access(path.join(runningDir, `${id}.json`));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery rejects malformed persisted JSON with its file path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-json-'));
  const runningDir = path.join(root, 'running');
  await fs.mkdir(runningDir, { recursive: true });
  const badPath = path.join(runningDir, 'dramart-20260909000000-aaaaa.json');
  await fs.writeFile(badPath, '{broken', 'utf8');
  const app = createTaskApp({
    runningDir,
    resultsDir: path.join(root, 'results'),
    requestsDir: path.join(root, 'requests'),
    runTask: async () => {},
  });
  try {
    await assert.rejects(app.locals.ready, (error) => String(error).includes(badPath) && /JSON|Unexpected/.test(String(error)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery rejects malformed result JSON associated with a running task', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-result-json-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const id = 'dramart-20260909000000-aaaaa';
  await writeTaskJson(runningDir, id, { task_id: id, action: 'generate_video', status: 'queued' });
  await fs.mkdir(resultsDir, { recursive: true });
  const badResultPath = path.join(resultsDir, `${id}.json`);
  await fs.writeFile(badResultPath, '{broken', 'utf8');
  const app = createTaskApp({ runningDir, resultsDir, requestsDir, runTask: async () => {} });
  try {
    await assert.rejects(app.locals.ready, (error) => String(error).includes(badResultPath) && /JSON|Unexpected/.test(String(error)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery rejects malformed request JSON associated with a queued running task', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-request-json-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const id = 'dramart-20260909000000-aaaaa';
  await writeTaskJson(runningDir, id, { task_id: id, action: 'generate_video', status: 'queued' });
  await fs.mkdir(requestsDir, { recursive: true });
  const badRequestPath = path.join(requestsDir, `${id}.json`);
  await fs.writeFile(badRequestPath, '{broken', 'utf8');
  const app = createTaskApp({ runningDir, resultsDir, requestsDir, runTask: async () => {} });
  try {
    await assert.rejects(app.locals.ready, (error) => String(error).includes(badRequestPath) && /JSON|Unexpected/.test(String(error)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery rejects a queued video missing from the request JSON index', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-request-missing-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const id = 'dramart-20260909000000-aaaaa';
  await writeTaskJson(runningDir, id, { task_id: id, action: 'generate_video', status: 'queued' });
  const app = createTaskApp({ runningDir, resultsDir, requestsDir, runTask: async () => {} });
  try {
    await assert.rejects(app.locals.ready, (error) => String(error).includes(`${id}.json`) && /request|请求|缺少/.test(String(error)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery rejects untrusted record task IDs without writing outside task directories', async () => {
  for (const recordId of ['../outside', path.resolve(os.tmpdir(), 'absolute-outside')]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-id-'));
    const runningDir = path.join(root, 'running');
    const resultsDir = path.join(root, 'results');
    const requestsDir = path.join(root, 'requests');
    const stem = 'dramart-20260909000000-aaaaa';
    const outsidePath = path.resolve(resultsDir, `${recordId}.json`);
    await writeTaskJson(runningDir, stem, { task_id: recordId, action: 'generate_video', status: 'processing' });
    const app = createTaskApp({ runningDir, resultsDir, requestsDir, runTask: async () => {} });
    try {
      await assert.rejects(app.locals.ready, /task_id.*文件名|文件名.*task_id/);
      if (!outsidePath.startsWith(`${path.resolve(resultsDir)}${path.sep}`)) {
        await assert.rejects(fs.access(outsidePath), { code: 'ENOENT' });
      }
      assert.deepEqual(await fs.readdir(resultsDir), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('startup recovery rejects a valid-format record ID that differs from the running filename', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-id-mismatch-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const stem = 'dramart-20260909000000-aaaaa';
  const recordId = 'dramart-20260909000000-bbbbb';
  await writeTaskJson(runningDir, stem, { task_id: recordId, action: 'generate_video', status: 'processing' });
  const app = createTaskApp({ runningDir, resultsDir, requestsDir, runTask: async () => {} });
  try {
    await assert.rejects(app.locals.ready, /task_id.*文件名|文件名.*task_id/);
    assert.deepEqual(await fs.readdir(resultsDir), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery rejects an invalid running filename stem', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-stem-'));
  const runningDir = path.join(root, 'running');
  await fs.mkdir(runningDir, { recursive: true });
  await fs.writeFile(path.join(runningDir, 'invalid stem.json'), JSON.stringify({ action: 'generate_video', status: 'processing' }));
  const app = createTaskApp({
    runningDir,
    resultsDir: path.join(root, 'results'),
    requestsDir: path.join(root, 'requests'),
    runTask: async () => {},
  });
  try {
    await assert.rejects(app.locals.ready, /非法.*文件名|文件名.*非法/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery rejects foo.json using the API task ID format', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-foo-'));
  const runningDir = path.join(root, 'running');
  await fs.mkdir(runningDir, { recursive: true });
  await fs.writeFile(path.join(runningDir, 'foo.json'), JSON.stringify({ task_id: 'foo', action: 'generate_video', status: 'processing' }));
  const app = createTaskApp({
    runningDir,
    resultsDir: path.join(root, 'results'),
    requestsDir: path.join(root, 'requests'),
    runTask: async () => {},
  });
  try {
    await assert.rejects(app.locals.ready, /非法.*文件名|文件名.*非法/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery rejects a running record without task_id', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-missing-id-'));
  const runningDir = path.join(root, 'running');
  const id = 'dramart-20260909000000-aaaaa';
  await writeTaskJson(runningDir, id, { action: 'generate_video', status: 'processing' });
  const app = createTaskApp({
    runningDir,
    resultsDir: path.join(root, 'results'),
    requestsDir: path.join(root, 'requests'),
    runTask: async () => {},
  });
  try {
    await assert.rejects(app.locals.ready, /task_id.*缺失|缺失.*task_id/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery validates an existing result before skipping a malformed request', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-result-first-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const id = 'dramart-20260909000000-aaaaa';
  await writeTaskJson(runningDir, id, { task_id: id, action: 'generate_video', status: 'queued' });
  await writeTaskJson(resultsDir, id, { task_id: id, status: 'success' });
  await fs.mkdir(requestsDir, { recursive: true });
  await fs.writeFile(path.join(requestsDir, `${id}.json`), '{broken');
  let starts = 0;
  const app = createTaskApp({ runningDir, resultsDir, requestsDir, runTask: async () => { starts += 1; } });
  try {
    await app.locals.ready;
    assert.equal(starts, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startup recovery interrupts processing video without reading malformed request', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-processing-first-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const id = 'dramart-20260909000000-aaaaa';
  await writeTaskJson(runningDir, id, { task_id: id, action: 'generate_video', status: 'processing' });
  await fs.mkdir(requestsDir, { recursive: true });
  await fs.writeFile(path.join(requestsDir, `${id}.json`), '{broken');
  const app = createTaskApp({ runningDir, resultsDir, requestsDir, runTask: async () => { throw new Error('must not run'); } });
  try {
    await app.locals.ready;
    const result = JSON.parse(await fs.readFile(path.join(resultsDir, `${id}.json`), 'utf8'));
    assert.equal(result.status, 'error');
    assert.match(result.error, /服务重启导致任务中断/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('result route reports malformed JSON as an error rather than a missing task', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-result-json-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const id = 'dramart-20260909000000-aaaaa';
  const app = createTaskApp({ runningDir, resultsDir, requestsDir, runTask: async () => {} });
  await app.locals.ready;
  await fs.writeFile(path.join(resultsDir, `${id}.json`), '{broken', 'utf8');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await getJson(`http://127.0.0.1:${server.address().port}`, `/api/result/${id}`);
    assert.equal(response.status, 'error');
    assert.match(response.message, /JSON|Unexpected/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task API routes wait for startup recovery before reading task state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-ready-route-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const id = 'dramart-20260909000000-aaaaa';
  await writeTaskJson(runningDir, id, { task_id: id, action: 'generate_video', status: 'processing' });
  const writeGate = deferred();
  const app = createTaskApp({
    runningDir,
    resultsDir,
    requestsDir,
    runTask: async () => {},
    writeJson: async (filePath, data) => {
      if (filePath.includes(`${path.sep}results${path.sep}`)) await writeGate.promise;
      await fs.writeFile(filePath, JSON.stringify(data), 'utf8');
    },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const responsePromise = getJson(`http://127.0.0.1:${server.address().port}`, `/api/result/${id}`);
    const settlement = { done: false };
    responsePromise.then(
      () => { settlement.done = true; },
      () => { settlement.done = true; },
    );
    await new Promise(setImmediate);
    assert.equal(settlement.done, false);
    writeGate.resolve();
    const response = await responsePromise;
    assert.equal(response.status, 'completed');
    assert.match(response.result.error, /服务重启导致任务中断/);
  } finally {
    writeGate.resolve();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('startTaskServer awaits app readiness before listening and returns the server', async () => {
  const ready = deferred();
  const fakeServer = { close() {} };
  let listenCalls = 0;
  const taskApp = { locals: { ready: ready.promise } };
  const started = startTaskServer({
    taskApp,
    listen: () => { listenCalls += 1; return fakeServer; },
  });
  await Promise.resolve();
  assert.equal(listenCalls, 0);
  ready.resolve();
  assert.equal(await started, fakeServer);
  assert.equal(listenCalls, 1);
});

test('image request is persisted as processing before its readiness wait settles', async () => {
  const ready = deferred();
  await withServer(async () => ready.promise, async (baseUrl, root) => {
    const accepted = await postAsk(baseUrl, imageBody());
    assert.equal(accepted.status, 'processing');
    assert.equal(accepted.completion_response.status, 'processing');
    const record = JSON.parse(await fs.readFile(path.join(root, 'running', `${accepted.task_id}.json`), 'utf8'));
    assert.equal(record.status, 'processing');
    assert.equal(record.completion_response.status, 'processing');
    const queried = await getJson(baseUrl, `/api/result/${accepted.task_id}`);
    assert.equal(queried.status, 'processing');
    assert.equal(queried.completion_response.status, 'processing');
    const request = JSON.parse(await fs.readFile(path.join(root, 'requests', `${accepted.task_id}.json`), 'utf8'));
    assert.equal(request.model, 'ep-20260709194802-qsvc2');
    assert.equal(request.model_name, 'Doubao-Seedream-5.0-Pro');
    ready.resolve();
  });
});

test('explicit 4.5 image code infers its matching model name in workflow request', async () => {
  const ready = deferred();
  await withServer(async () => ready.promise, async (baseUrl, root) => {
    const accepted = await postAsk(baseUrl, imageBody({ model: 'ep-20260318141930-4mnvw' }));
    const request = JSON.parse(await fs.readFile(path.join(root, 'requests', `${accepted.task_id}.json`), 'utf8'));
    assert.equal(request.model, 'ep-20260318141930-4mnvw');
    assert.equal(request.model_name, 'Doubao-Seedream-4.5');
    ready.resolve();
  });
});

test('wait_for_completion image responses keep each local task_id and result', async () => {
  await withServer(async (id, _requestPath, body, action, context) => {
    const item = {
      ResourceId: `resource-${body.prompt}`,
      GeneratedResource: { ImagesInfo: [{ HighResolutionUrl: `https://cdn.test/${body.prompt}.png` }] },
    };
    await context.writeJson(context.resultPath, context.buildResultData('success', id, item, item, '', '', null, action));
    await fs.rm(context.runningPath, { force: true });
  }, async (baseUrl) => {
    const [first, second] = await Promise.all([
      postAsk(baseUrl, imageBody({ prompt: 'first', wait_for_completion: true })),
      postAsk(baseUrl, imageBody({ prompt: 'second', wait_for_completion: true })),
    ]);
    assert.notEqual(first.result.task_id, second.result.task_id);
    assert.deepEqual(first.result.data, ['https://cdn.test/first.png']);
    assert.deepEqual(second.result.data, ['https://cdn.test/second.png']);
  });
});

test('video API routing retains the child-process video workflow', async () => {
  let routedAction = '';
  await withServer(async (id, _requestPath, _body, action, context) => {
    routedAction = action;
    await context.onPrepared({ taskEpisode: { EpisodeId: 'episode', ShotId: 'shot' } });
    await context.writeJson(context.resultPath, context.buildResultData('error', id, '', {}, 'stopped', '', null, action));
    await fs.rm(context.runningPath, { force: true });
  }, async (baseUrl) => {
    await postAsk(baseUrl, {
      action: 'generate_video',
      model: 'doubao-seedance-2-0-fast-260128',
      prompt: 'video',
      duration: 5,
      resolution: '720p',
      wait_for_completion: true,
    });
    assert.equal(routedAction, 'generate_video');
    assert.deepEqual(taskExecutionPlan('generate_video'), {
      mode: 'child-process',
      script: 'prepare-video-workflow.js',
    });
    assert.deepEqual(taskExecutionPlan('generate_image'), { mode: 'in-process-image-session' });
  });
});

test('video API accepts supported resolutions and rejects malformed or unsupported values without running them', async () => {
  const runCalls = [];
  await withServer(async (id, _requestPath, _body, action, context) => {
    runCalls.push(id);
    await context.onPrepared({ taskEpisode: { EpisodeId: 'episode', ShotId: 'shot' } });
    await context.writeJson(context.resultPath, context.buildResultData('error', id, '', {}, 'stopped', '', null, action));
    await fs.rm(context.runningPath, { force: true });
  }, async (baseUrl) => {
    for (const resolution of ['480p', '720p', '1080p', '4k']) {
      const response = await postAsk(baseUrl, videoBody({ resolution, wait_for_completion: true }));
      assert.equal(response.status, 'completed', resolution);
    }
    assert.equal(runCalls.length, 4);

    for (const resolution of ['720p-invalid', 'invalid-4k', '1440p']) {
      const response = await postAsk(baseUrl, videoBody({ resolution }));
      assert.equal(response.status, 'error', resolution);
      assert.match(response.message, /resolution/);
    }
    assert.equal(runCalls.length, 4);
  });
});

test('video API canonicalizes uppercase resolutions before persistence and workflow dispatch', async () => {
  const observed = [];
  await withServer(async (id, requestPath, _body, action, context) => {
    const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
    const running = JSON.parse(await fs.readFile(context.runningPath, 'utf8'));
    observed.push({ request, running });
    await context.onPrepared({ taskEpisode: { EpisodeId: 'episode', ShotId: 'shot' } });
    await context.writeJson(context.resultPath, context.buildResultData('error', id, '', {}, 'stopped', '', null, action));
    await fs.rm(context.runningPath, { force: true });
  }, async (baseUrl) => {
    for (const [input, canonical] of [['720P', '720p'], ['4K', '4k']]) {
      const response = await postAsk(baseUrl, videoBody({ resolution: input, wait_for_completion: true }));
      assert.equal(response.status, 'completed', input);
      const current = observed.at(-1);
      assert.equal(current.request.resolution, canonical, `${input} request JSON`);
      assert.equal(current.running.payload.resolution, canonical, `${input} running payload`);
    }
  });
  assert.equal(observed.length, 2);
});

test('task API documentation JavaScript example normalizes video and image media URLs', async () => {
  const docs = await fs.readFile(new URL('../docs/task-api.md', import.meta.url), 'utf8');
  assert.match(docs, /response\.result\.video_url \|\| response\.result\.image_url \|\| \(Array\.isArray\(response\.result\.data\) \? response\.result\.data\[0\] : ''\)/);
});

test('image failure is normalized for synchronous responses', async () => {
  await withServer(async (id, _requestPath, _body, action, context) => {
    await context.writeJson(context.resultPath, context.buildResultData('error', id, '', {}, 'prompt rejected', '', null, action));
    await fs.rm(context.runningPath, { force: true });
  }, async (baseUrl) => {
    const result = await postAsk(baseUrl, imageBody({ wait_for_completion: true }));
    assert.equal(result.status, 'completed');
    assert.equal(result.result.status, 'error');
    assert.equal(result.result.action, 'generate_image');
    assert.equal(result.result.data, '');
    assert.equal(result.result.error, 'prompt rejected');
  });
});

test('asynchronous image result and files routes retain compatible fields', async () => {
  await withServer(async (id, _requestPath, _body, action, context) => {
    const item = { ResourceId: 'resource', GeneratedResource: { ImagesInfo: [{ HighResolutionUrl: 'https://cdn.test/image.png' }] } };
    await context.writeJson(context.resultPath, context.buildResultData('success', id, item, item, '', '', null, action));
    await fs.rm(context.runningPath, { force: true });
  }, async (baseUrl) => {
    const accepted = await postAsk(baseUrl, imageBody());
    const result = await pollResultUntilCompleted(baseUrl, accepted.task_id, 'image result was not persisted');
    const files = await getJson(baseUrl, `/api/files/${accepted.task_id}`);
    assert.equal(result.status, 'completed');
    assert.equal(result.result.task_id, accepted.task_id);
    assert.deepEqual(result.result.data, ['https://cdn.test/image.png']);
    assert.equal(files.status, 'completed');
    assert.equal(files.result.task_id, accepted.task_id);
    assert.equal(files.result.cdn_url, 'https://cdn.test/image.png');
  });
});

test('video completion response keeps key compatibility fields', async () => {
  await withServer(async (id, _requestPath, _body, action, context) => {
    await context.onPrepared({ taskEpisode: { EpisodeId: 'episode', ShotId: 'shot' } });
    const item = { status: 'succeeded', VideoUrl: 'https://cdn.test/video.mp4' };
    await context.writeJson(context.resultPath, context.buildResultData('success', id, item, { upstream: true }, '', '', null, action));
    await fs.rm(context.runningPath, { force: true });
  }, async (baseUrl) => {
    const response = await postAsk(baseUrl, { action: 'generate_video', model: 'doubao-seedance-2-0-fast-260128', prompt: 'video', duration: 5, resolution: '720p', wait_for_completion: true });
    assert.equal(response.status, 'completed');
    assert.equal(response.result.action, 'generate_video');
    assert.match(response.result.task_id, /^dramart-/);
    assert.equal(response.result.video_url, 'https://cdn.test/video.mp4');
    assert.equal(response.completion_response.upstream, true);
  });
});

test('video preparation is serialized and GET queue positions update when preparation completes', async () => {
  const starts = [];
  const controls = new Map();
  let preparing = 0;
  let maxPreparing = 0;
  await withServer(async (id, _requestPath, _body, _action, context) => {
    starts.push(id);
    preparing += 1;
    maxPreparing = Math.max(maxPreparing, preparing);
    const completion = deferred();
    controls.set(id, {
      completion,
      async prepare() {
        preparing -= 1;
        await context.onPrepared({
          project: { projectName: `project-${starts.length}` },
          taskEpisode: { EpisodeId: `episode-${starts.length}`, ShotId: `shot-${starts.length}`, beforeEpisodeCount: starts.length - 1 },
        });
      },
    });
    return completion.promise;
  }, async (baseUrl, root) => {
    const first = await postAsk(baseUrl, videoBody({ prompt: 'first' }));
    const second = await postAsk(baseUrl, videoBody({ prompt: 'second' }));
    const third = await postAsk(baseUrl, videoBody({ prompt: 'third' }));

    assert.deepEqual(starts, [first.task_id]);
    assert.equal(first.queue_position, 0);
    assert.equal(second.queue_position, 1);
    assert.equal(third.queue_position, 2);
    assert.equal(maxPreparing, 1);
    assert.equal((await getJson(baseUrl, `/api/result/${second.task_id}`)).queue_position, 1);
    assert.equal((await getJson(baseUrl, `/api/result/${third.task_id}`)).queue_position, 2);

    await controls.get(first.task_id).prepare();
    await waitUntil(() => starts.length === 2, 'second video did not start');
    assert.deepEqual(starts, [first.task_id, second.task_id]);
    assert.equal(maxPreparing, 1);
    const preparedRecord = JSON.parse(await fs.readFile(path.join(root, 'running', `${first.task_id}.json`), 'utf8'));
    assert.equal(preparedRecord.status, 'processing');
    assert.equal(preparedRecord.dramart.taskEpisode.EpisodeId, 'episode-1');
    const secondStatus = await getJson(baseUrl, `/api/result/${second.task_id}`);
    const thirdStatus = await getJson(baseUrl, `/api/result/${third.task_id}`);
    assert.equal(secondStatus.queue_position, 0);
    assert.equal(thirdStatus.queue_position, 1);
    assert.equal(thirdStatus.message, '任务排队中');

    await controls.get(second.task_id).prepare();
    await waitUntil(() => starts.length === 3, 'third video did not start');
    assert.equal((await getJson(baseUrl, `/api/result/${third.task_id}`)).queue_position, 0);
    await controls.get(third.task_id).prepare();
    for (const control of controls.values()) control.completion.resolve();
  });
});

test('video rejection before preparation persists an error and releases the next task', async () => {
  const starts = [];
  const controls = new Map();
  await withServer(async (id, _requestPath, _body, _action, context) => {
    starts.push(id);
    const completion = deferred();
    controls.set(id, { completion, context });
    return completion.promise;
  }, async (baseUrl) => {
    const first = await postAsk(baseUrl, videoBody({ prompt: 'first' }));
    const second = await postAsk(baseUrl, videoBody({ prompt: 'second' }));
    controls.get(first.task_id).completion.reject(new Error('preparation failed'));
    await waitUntil(() => starts.length === 2, 'second video was not released');
    const failed = await pollResultUntilCompleted(baseUrl, first.task_id, 'first video error result was not persisted');
    assert.equal(failed.status, 'completed');
    assert.equal(failed.result.status, 'error');
    assert.match(failed.result.error, /preparation failed/);
    await controls.get(second.task_id).context.onPrepared({ taskEpisode: { EpisodeId: 'episode-2', ShotId: 'shot-2' } });
    controls.get(second.task_id).completion.resolve();
  });
});

test('TASK_STARTED releases the next task only after prepared context persistence succeeds', async () => {
  const starts = [];
  const persistGate = deferred();
  let firstContext;
  let runningWrites = 0;
  await withServer(async (id, _requestPath, _body, _action, context) => {
    starts.push(id);
    if (!firstContext) {
      firstContext = context;
      await context.onPrepared({ taskEpisode: { EpisodeId: 'episode-1', ShotId: 'shot-1' } });
    }
  }, async (baseUrl) => {
    const first = await postAsk(baseUrl, videoBody({ prompt: 'first' }));
    const second = await postAsk(baseUrl, videoBody({ prompt: 'second' }));
    await waitUntil(() => runningWrites === 1, 'prepared persistence did not start');
    assert.deepEqual(starts, [first.task_id]);
    assert.equal(second.queue_position, 1);

    persistGate.resolve();
    await waitUntil(() => starts.length === 2, 'second task did not start after persistence');
    assert.deepEqual(starts, [first.task_id, second.task_id]);
  }, {
    writeJson: async (filePath, data) => {
      if (data?.status === 'processing' && data?.dramart) {
        runningWrites += 1;
        await persistGate.promise;
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(data), 'utf8');
    },
  });
});

test('fatal rejection waits for pending prepared persistence before writing the terminal result', async () => {
  const starts = [];
  const persistGate = deferred();
  const lifecycle = deferred();
  let preparedWrite;
  let preparedWriteStarted = false;
  const fatal = new Error('unconfirmed exit while persistence is pending');
  fatal.code = 'VIDEO_CHILD_EXIT_UNCONFIRMED';
  fatal.blocksPreparationQueue = true;
  await withServer(async (id, _requestPath, _body, _action, context) => {
    starts.push(id);
    if (starts.length === 1) {
      preparedWrite = context.onPrepared({ taskEpisode: { EpisodeId: 'episode-1', ShotId: 'shot-1' } });
      return lifecycle.promise;
    }
    return new Promise(() => {});
  }, async (baseUrl, root, app) => {
    const first = await postAsk(baseUrl, videoBody({ prompt: 'first' }));
    const second = await postAsk(baseUrl, videoBody({ prompt: 'second' }));
    await waitUntil(() => preparedWriteStarted, 'prepared-state write did not start');

    lifecycle.reject(fatal);
    await new Promise(setImmediate);
    assert.equal(await fs.access(path.join(root, 'results', `${first.task_id}.json`)).then(() => true, () => false), false);
    assert.deepEqual(starts, [first.task_id]);

    persistGate.resolve();
    await preparedWrite;
    const failed = await pollResultUntilCompleted(baseUrl, first.task_id, 'fatal task result was not persisted after prepared write settled');

    assert.equal(failed.result.status, 'error');
    assert.match(failed.result.error, /unconfirmed exit/);
    await assert.rejects(fs.access(path.join(root, 'running', `${first.task_id}.json`)), { code: 'ENOENT' });
    assert.equal(app.locals.videoScheduler.isBlocked(), true);
    assert.equal(app.locals.videoScheduler.queuePosition(first.task_id), 0);
    assert.equal(app.locals.videoScheduler.queuePosition(second.task_id), 1);
    assert.deepEqual(starts, [first.task_id]);
  }, {
    cleanupVideoTaskResources: async () => {},
    writeJson: async (filePath, data) => {
      if (data?.status === 'processing' && data?.dramart) {
        preparedWriteStarted = true;
        await persistGate.promise;
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(data), 'utf8');
    },
  });
});

test('parent marker env is used by the child workflow to select the exact created page', async () => {
  const calls = [];
  const page = (initialName, label) => {
    let name = initialName;
    return {
      evaluate: async (_callback, marker) => {
        if (marker === undefined) return name;
        name = marker;
        calls.push(`mark:${label}:${marker}`);
      },
      isClosed: () => false,
      goto: async () => { calls.push(`goto:${label}`); },
      waitForNetworkIdle: async () => {},
      close: async () => { calls.push(`close:${label}`); },
    };
  };
  const original = page('original', 'original');
  const otherTask = page('seedance-video-other', 'other');
  const taskPage = page('', 'task');
  const browser = { newPage: async () => { calls.push('newPage'); return taskPage; }, pages: async () => [original, otherTask, taskPage] };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-marked-page-'));
  const id = 'dramart-20260910000000-abcde';
  try {
    await runDramartTask(id, path.join(root, 'request.json'), {}, 'generate_video', {
      runningPath: path.join(root, 'running.json'),
      resultPath: path.join(root, 'result.json'),
      ensureStandbyBrowser: async () => ({ browser, browserURL: 'http://browser' }),
      runVideoChild: async ({ options }) => {
        const marker = options.env.SEEDANCE_TASK_PAGE_MARKER;
        calls.push(`spawn:${marker}`);
        const selected = await openTaskPage(browser, () => {}, { marker, setViewport: async () => {} });
        assert.equal(selected, taskPage);
        return { exitCode: 0, stdout: 'RESULT_JSON {"status":"failed","error":"stop"}', stderr: '' };
      },
    });
    assert.deepEqual(calls.slice(0, 5), [
      'newPage',
      `mark:task:seedance-video-${id}`,
      `spawn:seedance-video-${id}`,
      `mark:task:seedance-video-${id}`,
      'goto:task',
    ]);
    assert.equal(calls.includes('close:original'), false);
    assert.equal(calls.includes('goto:other'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task page marker failure closes that page and prevents child spawn', async () => {
  const calls = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-marker-failure-'));
  const taskPage = {
    evaluate: async () => { throw new Error('marker failed'); },
    close: async () => { calls.push('close-task'); },
  };
  const browser = { newPage: async () => taskPage };
  try {
    await assert.rejects(runDramartTask('dramart-20260910000000-abcde', 'request.json', {}, 'generate_video', {
      runningPath: path.join(root, 'running.json'),
      resultPath: path.join(root, 'result.json'),
      ensureStandbyBrowser: async () => ({ browser, browserURL: 'http://browser' }),
      runVideoChild: async () => { calls.push('spawn'); },
    }), /marker failed/);
    assert.deepEqual(calls, ['close-task']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('parent fallback removes only failed task temp files and its marked page', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-video-fallback-'));
  const taskId = 'dramart-20260910000000-abcde';
  const taskDir = path.join(root, taskId);
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, 'upload.png'), 'temporary');
  const closed = [];
  const page = (name) => ({
    isClosed: () => false,
    evaluate: async () => name,
    close: async () => { closed.push(name); },
  });
  const browser = { pages: async () => [page(`seedance-video-${taskId}`), page('seedance-video-other'), page('')] };

  await cleanupVideoTaskResources({ taskId, tempRoot: root, browser });

  await assert.rejects(fs.access(taskDir), { code: 'ENOENT' });
  assert.deepEqual(closed, [`seedance-video-${taskId}`]);
  await fs.rm(root, { recursive: true, force: true });
});

test('confirmed video failure finishes parent cleanup before releasing the next preparation', async () => {
  const starts = [];
  const cleanupGate = deferred();
  let firstId;
  await withServer(async (id) => {
    starts.push(id);
    if (!firstId) {
      firstId = id;
      throw new Error('simulated killed child closed');
    }
  }, async (baseUrl) => {
    const first = await postAsk(baseUrl, videoBody({ prompt: 'first' }));
    const second = await postAsk(baseUrl, videoBody({ prompt: 'second' }));
    await new Promise(setImmediate);
    assert.deepEqual(starts, [first.task_id]);
    cleanupGate.resolve();
    await waitUntil(() => starts.length === 2, 'second video was not released after cleanup');
    assert.deepEqual(starts, [first.task_id, second.task_id]);
    await pollResultUntilCompleted(baseUrl, first.task_id, 'first video result was not persisted');
  }, {
    cleanupVideoTaskResources: async ({ taskId }) => {
      assert.equal(taskId, firstId);
      await cleanupGate.promise;
    },
  });
});

test('simulated killed video removes its task temp directory through the app fallback', async () => {
  const kill = deferred();
  await withServer(async (id) => {
    await kill.promise;
    throw new Error(`simulated timeout kill ${id}`);
  }, async (baseUrl, root) => {
    const accepted = await postAsk(baseUrl, videoBody({ prompt: 'killed' }));
    const taskDir = path.join(root, 'video-temp', accepted.task_id);
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(taskDir, 'partial.png'), 'partial');
    kill.resolve();
    await pollResultUntilCompleted(baseUrl, accepted.task_id, 'killed task result was not persisted');
    await assert.rejects(fs.access(taskDir), { code: 'ENOENT' });
  }, { videoTempRoot: (root) => path.join(root, 'video-temp') });
});

test('unconfirmed child exit keeps queue blocked after parent cleanup', async () => {
  const starts = [];
  const cleaned = [];
  await withServer(async (id) => {
    starts.push(id);
    const error = new Error('unconfirmed child exit');
    error.code = 'VIDEO_CHILD_EXIT_UNCONFIRMED';
    error.blocksPreparationQueue = true;
    throw error;
  }, async (baseUrl) => {
    const first = await postAsk(baseUrl, videoBody({ prompt: 'first' }));
    const second = await postAsk(baseUrl, videoBody({ prompt: 'second' }));
    await pollResultUntilCompleted(baseUrl, first.task_id, 'fatal task result was not persisted');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(cleaned, [first.task_id]);
    assert.deepEqual(starts, [first.task_id]);
    assert.equal(second.queue_position, 1);
  }, {
    cleanupVideoTaskResources: async ({ taskId }) => { cleaned.push(taskId); },
  });
});

test('image tasks start immediately while a video occupies the preparation slot', async () => {
  const starts = [];
  const videoCompletion = deferred();
  let videoContext;
  await withServer(async (id, _requestPath, _body, action, context) => {
    starts.push(action);
    if (action === 'generate_video') {
      videoContext = context;
      return videoCompletion.promise;
    }
    await context.writeJson(context.resultPath, context.buildResultData('error', id, '', {}, 'stopped', '', null, action));
    await fs.rm(context.runningPath, { force: true });
  }, async (baseUrl) => {
    await postAsk(baseUrl, videoBody());
    const image = await postAsk(baseUrl, imageBody({ wait_for_completion: true }));
    assert.deepEqual(starts, ['generate_video', 'generate_image']);
    assert.equal(image.status, 'completed');
    await videoContext.onPrepared({ taskEpisode: { EpisodeId: 'episode', ShotId: 'shot' } });
    videoCompletion.resolve();
  });
});

test('result and files routes reject traversal-like task IDs', async () => {
  await withServer(async () => {}, async (baseUrl) => {
    for (const route of ['/api/result/..%5Csecret', '/api/files/%2E%2E%5Csecret']) {
      const response = await getJson(baseUrl, route);
      assert.equal(response.status, 'error');
      assert.match(response.message, /task_id.*格式/);
    }
  });
});

test('background persistence failure is contained and synchronous request returns normalized error', async () => {
  const backgroundErrors = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-failure-test-'));
  const app = createTaskApp({
    runningDir: path.join(root, 'running'), resultsDir: path.join(root, 'results'), requestsDir: path.join(root, 'requests'),
    runTask: async () => { throw new Error('task failed'); },
    writeJson: async (filePath, data) => {
      if (filePath.includes(`${path.sep}results${path.sep}`)) throw new Error('disk failed');
      await fs.writeFile(filePath, JSON.stringify(data));
    },
    onBackgroundError: (error) => backgroundErrors.push(error),
  });
  const server = app.listen(0);
  await withDeadline(new Promise((resolve) => server.once('listening', resolve)), 'failure test server did not listen');
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const sync = await postAsk(baseUrl, imageBody({ wait_for_completion: true }));
    assert.equal(sync.status, 'completed');
    assert.equal(sync.result.status, 'error');
    assert.match(sync.result.error, /task failed/);
    await postAsk(baseUrl, imageBody());
    await withDeadline((async () => { while (!backgroundErrors.length) await new Promise(setImmediate); })(), 'background error was not reported');
    assert.match(String(backgroundErrors[0]), /disk failed/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task failure after terminal result persistence does not overwrite the successful result', async () => {
  await withServer(async (id, _requestPath, _body, action, context) => {
    const item = { GeneratedResource: { ImagesInfo: [{ HighResolutionUrl: 'https://cdn.test/preserved.png' }] } };
    await context.writeJson(context.resultPath, context.buildResultData('success', id, item, item, '', '', null, action));
    throw new Error('running cleanup failed after terminal write');
  }, async (baseUrl, root) => {
    const response = await postAsk(baseUrl, imageBody({ wait_for_completion: true }));
    assert.equal(response.status, 'completed');
    assert.equal(response.result.status, 'success');
    assert.deepEqual(response.result.data, ['https://cdn.test/preserved.png']);

    const persisted = JSON.parse(await fs.readFile(path.join(root, 'results', `${response.result.task_id}.json`), 'utf8'));
    assert.equal(persisted.status, 'success');
    assert.equal(persisted.error, '');
    await assert.rejects(fs.access(path.join(root, 'running', `${response.result.task_id}.json`)), { code: 'ENOENT' });
  });
});

test('malformed existing result is not accepted as a legal terminal result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-malformed-terminal-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const backgroundErrors = [];
  const app = createTaskApp({
    runningDir,
    resultsDir,
    requestsDir,
    runTask: async (id, _requestPath, _body, _action, context) => {
      await fs.writeFile(context.resultPath, '{broken', 'utf8');
      throw new Error(`task failed ${id}`);
    },
    onBackgroundError: (error) => backgroundErrors.push(error),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const accepted = await postAsk(`http://127.0.0.1:${server.address().port}`, imageBody());
    await waitUntil(() => backgroundErrors.length === 1, 'malformed terminal result was not reported');
    assert.match(String(backgroundErrors[0]), /读取持久化任务 JSON失败|JSON|Unexpected/);
    await fs.access(path.join(runningDir, `${accepted.task_id}.json`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('existing terminal result cleanup failure is reported without rejecting the observer', async () => {
  const backgroundErrors = [];
  await withServer(async (id, _requestPath, _body, action, context) => {
    const item = { GeneratedResource: { ImagesInfo: [{ HighResolutionUrl: 'https://cdn.test/preserved.png' }] } };
    await context.writeJson(context.resultPath, context.buildResultData('success', id, item, item, '', '', null, action));
    throw new Error('failure after terminal result');
  }, async (baseUrl, root) => {
    const response = await postAsk(baseUrl, imageBody({ wait_for_completion: true }));
    assert.equal(response.status, 'completed');
    assert.equal(response.result.status, 'success');
    assert.equal(backgroundErrors.length, 1);
    assert.match(String(backgroundErrors[0]), /existing running cleanup failed/);
    await fs.access(path.join(root, 'running', `${response.result.task_id}.json`));
  }, {
    rm: async () => { throw new Error('existing running cleanup failed'); },
    onBackgroundError: (error) => backgroundErrors.push(error),
  });
});

test('null task rejection returns a normalized terminal error without rejecting the observer', async () => {
  await withServer(async () => Promise.reject(null), async (baseUrl) => {
    const response = await postAsk(baseUrl, imageBody({ wait_for_completion: true }));
    assert.equal(response.status, 'completed');
    assert.equal(response.result.status, 'error');
    assert.match(response.result.error, /未知任务错误|Unknown task error/);
  });
});

test('result existence access failure is reported and does not reject the task observer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-access-failure-'));
  const backgroundErrors = [];
  const app = createTaskApp({
    runningDir: path.join(root, 'running'),
    resultsDir: path.join(root, 'results'),
    requestsDir: path.join(root, 'requests'),
    runTask: async () => { throw new Error('task failed'); },
    access: async () => { const error = new Error('access denied'); error.code = 'EACCES'; throw error; },
    onBackgroundError: (error) => backgroundErrors.push(error),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await postAsk(`http://127.0.0.1:${server.address().port}`, imageBody({ wait_for_completion: true }));
    assert.equal(response.status, 'completed');
    assert.equal(response.result.status, 'error');
    assert.match(response.result.error, /task failed/);
    assert.equal(backgroundErrors.length, 1);
    assert.match(String(backgroundErrors[0]), /access denied/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('recovered task error persistence failure is reported without an unhandled rejection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-recovery-error-write-'));
  const runningDir = path.join(root, 'running');
  const resultsDir = path.join(root, 'results');
  const requestsDir = path.join(root, 'requests');
  const id = 'dramart-20260909000000-aaaaa';
  const backgroundErrors = [];
  await writeTaskJson(runningDir, id, { task_id: id, action: 'generate_video', status: 'queued' });
  await writeTaskJson(requestsDir, id, { prompt: 'recover' });
  const app = createTaskApp({
    runningDir,
    resultsDir,
    requestsDir,
    runTask: async () => Promise.reject('recovery failed'),
    writeJson: async (filePath, data) => {
      if (filePath.includes(`${path.sep}results${path.sep}`)) throw new Error('result write failed');
      await fs.writeFile(filePath, JSON.stringify(data), 'utf8');
    },
    onBackgroundError: (error) => backgroundErrors.push(error),
  });
  try {
    await app.locals.ready;
    await waitUntil(() => backgroundErrors.length === 1, 'recovery persistence failure was not reported');
    assert.match(String(backgroundErrors[0]), /result write failed/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('synchronous ask normalizes request persistence failures instead of hanging', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-server-write-failure-'));
  const app = createTaskApp({
    runningDir: path.join(root, 'running'), resultsDir: path.join(root, 'results'), requestsDir: path.join(root, 'requests'),
    runTask: async () => {},
    writeJson: async () => { throw new Error('request disk unavailable'); },
  });
  const server = app.listen(0);
  await withDeadline(new Promise((resolve) => server.once('listening', resolve)), 'write failure server did not listen');
  try {
    const response = await postAsk(`http://127.0.0.1:${server.address().port}`, imageBody({ wait_for_completion: true }));
    assert.equal(response.status, 'error');
    assert.match(response.message, /request disk unavailable/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('image model resolver keeps code and inferred name consistent', () => {
  assert.deepEqual(resolveImageModel(undefined), { code: 'ep-20260709194802-qsvc2', name: 'Doubao-Seedream-5.0-Pro' });
  assert.deepEqual(resolveImageModel('ep-20260709194802-qsvc2'), { code: 'ep-20260709194802-qsvc2', name: 'Doubao-Seedream-5.0-Pro' });
  assert.deepEqual(resolveImageModel('ep-20260318141930-4mnvw'), { code: 'ep-20260318141930-4mnvw', name: 'Doubao-Seedream-4.5' });
});

test('image task context is written from the exact session used by runTask', async () => {
  const writes = [];
  const sessionState = { projectName: 'image', projectId: 'actual-project', scriptId: 'script', teamId: 'team', url: 'canvas' };
  const runner = createImageTaskRunner({
    imageSession: { runTask: async (_id, _request, options) => { await options.onReady(sessionState); return { status: 'failed', failedReason: 'stop' }; } },
    readJson: async (file) => file === 'request' ? { prompt: 'p' } : { status: 'processing' },
    writeJson: async (file, data) => writes.push({ file, data }),
    rm: async () => {},
    log: () => {},
  });
  await runner('task', 'request', {}, 'generate_image', { runningPath: 'running', resultPath: 'result' });
  assert.equal(writes.find((write) => write.file === 'running').data.dramart.project.projectId, 'actual-project');
});

test('image task runner forwards progress and records successful terminal state after persistence cleanup', async () => {
  const calls = [];
  const runner = createImageTaskRunner({
    imageSession: {
      runTask: async (_id, _request, options) => {
        await options.onProgress({ stage: '图片生成中', detail: '1/2' });
        return { status: 'succeeded', response: { images: [{ image_url: 'https://result/image.png' }] } };
      },
    },
    statusPanel: {
      update: (...args) => calls.push(['update', ...args]),
      succeed: (...args) => calls.push(['succeed', ...args]),
      fail: (...args) => calls.push(['fail', ...args]),
    },
    readJson: async () => ({ prompt: 'safe prompt' }),
    writeJson: async () => calls.push(['write']),
    rm: async () => calls.push(['rm']),
    log: () => {},
  });

  await runner('image-task', 'request', {}, 'generate_image', { runningPath: 'running', resultPath: 'result' });

  assert.deepEqual(calls, [
    ['update', 'image-task', '图片生成中', '1/2'],
    ['write'],
    ['rm'],
    ['succeed', 'image-task'],
  ]);
});

test('image task runner records normalized failure after persistence cleanup', async () => {
  const calls = [];
  const runner = createImageTaskRunner({
    imageSession: { runTask: async () => ({ status: 'failed', failedReason: 'generation rejected' }) },
    statusPanel: { fail: (...args) => calls.push(['fail', ...args]) },
    readJson: async () => ({}),
    writeJson: async () => calls.push(['write']),
    rm: async () => calls.push(['rm']),
    log: () => {},
  });

  await runner('image-task', 'request', {}, 'generate_image', { runningPath: 'running', resultPath: 'result' });
  assert.deepEqual(calls, [['write'], ['rm'], ['fail', 'image-task', 'generation rejected']]);
});

test('image task runner marks session exceptions failed before rethrowing', async () => {
  const calls = [];
  const failure = new Error('session unavailable token=secret-value');
  const runner = createImageTaskRunner({
    imageSession: { runTask: async () => { throw failure; } },
    statusPanel: { fail: (...args) => calls.push(args) },
    readJson: async () => ({}),
    writeJson: async () => {},
    rm: async () => {},
    log: () => {},
  });

  await assert.rejects(runner('image-task', 'request', {}, 'generate_image', { runningPath: 'running', resultPath: 'result' }), failure);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'image-task');
  assert.doesNotMatch(calls[0][1], /secret-value/);
});

test('image task safe panel error removes secrets, payloads and line breaks and truncates output', () => {
  const unsafe = new Error(`request failed\nAuthorization: Bearer auth-secret "token":"token-secret" password: pass-secret cookie=session-secret raw=${'B'.repeat(100)} data:image/png;base64,${'A'.repeat(500)} "prompt":"${'private prompt '.repeat(30)}"`);
  const safe = safePanelError(unsafe);
  assert.ok(safe.length <= 160);
  assert.doesNotMatch(safe, /[\r\n]|auth-secret|token-secret|pass-secret|session-secret|AAAA|BBBB|private prompt/);
  assert.equal(safePanelError(null), '未知任务错误');
});

test('image task safe panel error redacts Basic auth and credential field aliases', () => {
  const cases = [
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'api_key=api-secret',
    'api-key: api-secret',
    'apikey=api-secret',
    'access_token=access-secret',
    'access-token: access-secret',
    'refresh_token=refresh-secret',
    'token=token-secret',
    'password=password-secret',
    'passwd=passwd-secret',
    'credential=credential-secret',
    'cookie=cookie-secret',
    'Set-Cookie: session=set-cookie-secret; Path=/',
    'Bearer bearer-secret',
  ];
  for (const credential of cases) {
    const safe = safePanelError(`upload failed while contacting image service; ${credential}; retry is allowed`);
    assert.match(safe, /upload failed while contacting image service/);
    assert.doesNotMatch(safe, /dXNlcjpwYXNzd29yZA|api-secret|access-secret|refresh-secret|token-secret|password-secret|passwd-secret|credential-secret|cookie-secret|set-cookie-secret|bearer-secret/);
    assert.ok(safe.length <= 160);
  }
});

test('image task safe panel error redacts complete cookie header values while preserving context', () => {
  const safe = safePanelError(new Error([
    'upload failed while contacting image service',
    'Cookie: session=cookie-secret; theme=theme-secret; preference=private-value',
    'Set-Cookie: access=set-cookie-secret; Path=/; HttpOnly',
    'retry is allowed',
  ].join('\n')));

  assert.match(safe, /upload failed while contacting image service/);
  assert.match(safe, /retry is allowed/);
  assert.doesNotMatch(safe, /cookie-secret|theme-secret|private-value|set-cookie-secret/);
  assert.doesNotMatch(safe, /[\r\n]/);
  assert.ok(safe.length <= 160);
});

test('image task safe panel calls contain synchronous throws and rejected thenables with safe logs', async () => {
  const logs = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.doesNotThrow(() => safePanelCall(
      { update: () => { throw new Error('sync panel failure api_key=sync-secret'); } },
      'update',
      ['task', 'stage'],
      (message) => logs.push(message),
    ));
    safePanelCall(
      { succeed: () => Promise.reject(new Error('async panel failure Authorization: Basic YXN5bmMtc2VjcmV0')) },
      'succeed',
      ['task'],
      (message) => logs.push(message),
    );
    await new Promise(setImmediate);
    assert.deepEqual(unhandled, []);
    assert.equal(logs.length, 2);
    assert.doesNotMatch(logs.join(' '), /sync-secret|YXN5bmMtc2VjcmV0/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('image task runner panel failures never alter progress, terminal, or session outcomes', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const successful = createImageTaskRunner({
      imageSession: { runTask: async (_id, _request, options) => {
        options.onProgress({ stage: 'working', detail: 'safe' });
        return { status: 'succeeded', response: { images: [{ image_url: 'https://result/image.png' }] } };
      } },
      statusPanel: {
        update: () => { throw new Error('update panel failed'); },
        succeed: () => Promise.reject(new Error('succeed panel failed')),
      },
      readJson: async () => ({}), writeJson: async () => {}, rm: async () => {}, log: () => {},
    });
    await successful('success', 'request', {}, 'generate_image', { runningPath: 'running', resultPath: 'result' });

    const normalizedFailure = createImageTaskRunner({
      imageSession: { runTask: async () => ({ status: 'failed', failedReason: 'generation failed' }) },
      statusPanel: { fail: () => Promise.reject(new Error('terminal fail panel failed')) },
      readJson: async () => ({}), writeJson: async () => {}, rm: async () => {}, log: () => {},
    });
    await normalizedFailure('failed', 'request', {}, 'generate_image', { runningPath: 'running', resultPath: 'result' });

    const sessionError = new Error('original session failure');
    const sessionFailure = createImageTaskRunner({
      imageSession: { runTask: async () => { throw sessionError; } },
      statusPanel: { fail: () => { throw new Error('session fail panel failed'); } },
      readJson: async () => ({}), writeJson: async () => {}, rm: async () => {}, log: () => {},
    });
    await assert.rejects(sessionFailure('session', 'request', {}, 'generate_image', { runningPath: 'running', resultPath: 'result' }), (error) => error === sessionError);
    await new Promise(setImmediate);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('image session readiness ignores synchronous and asynchronous attach panel failures', async () => {
  for (const attachPage of [
    () => { throw new Error('attach failed'); },
    () => Promise.reject(new Error('async attach failed')),
  ]) {
    let sessionOptions;
    createImageSessionWithStatusPanel({ attachPage }, {
      createSession: (options) => { sessionOptions = options; return {}; },
      sessionOptions: { log: () => {} },
    });
    assert.doesNotThrow(() => sessionOptions.onSessionReady('page'));
  }
  await new Promise(setImmediate);
});

test('image task add and observe fail panel exceptions do not interrupt dispatch or error persistence', async () => {
  for (const panelFailure of [
    () => { throw new Error('panel failed'); },
    () => Promise.reject(new Error('async panel failed')),
  ]) {
    let runs = 0;
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await withServer(async () => {
        runs += 1;
        throw new Error('business task failed');
      }, async (baseUrl) => {
        const response = await postAsk(baseUrl, imageBody({ wait_for_completion: true }));
        assert.equal(runs, 1);
        assert.equal(response.result.status, 'error');
      }, { imageTaskStatusPanel: { add: panelFailure, fail: panelFailure } });
      await new Promise(setImmediate);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }
});

test('image task cleanup failure marks the panel failed without overwriting its persisted success', async () => {
  const failures = [];
  const successes = [];
  const panel = {
    add: () => {},
    fail: (...args) => failures.push(args),
    succeed: (...args) => successes.push(args),
  };
  const runner = createImageTaskRunner({
    imageSession: {
      runTask: async () => ({ status: 'succeeded', response: { images: [{ image_url: 'https://result/image.png' }] } }),
    },
    statusPanel: panel,
    readJson,
    writeJson,
    rm: async () => { throw new Error('running cleanup failed'); },
    log: () => {},
  });

  await withServer(runner, async (baseUrl) => {
    const response = await postAsk(baseUrl, imageBody({ wait_for_completion: true }));
    assert.equal(response.result.status, 'success');
    assert.deepEqual(response.result.data, ['https://result/image.png']);
    assert.equal(failures.length, 1);
    assert.deepEqual(successes, []);
  }, { imageTaskStatusPanel: panel });
});

test('image session status panel wiring attaches every ready page', async () => {
  const pages = [];
  let sessionOptions;
  const session = createImageSessionWithStatusPanel({ attachPage: (page) => pages.push(page) }, {
    createSession: (options) => { sessionOptions = options; return { session: true }; },
    sessionOptions: { getBrowser: async () => null, log: () => {} },
  });
  assert.deepEqual(session, { session: true });
  await sessionOptions.onSessionReady('initial-page');
  await sessionOptions.onSessionReady('recovered-page');
  assert.deepEqual(pages, ['initial-page', 'recovered-page']);
});

test('image task status panel is added after persistence while authentication is pending', async () => {
  const authentication = deferred();
  const adds = [];
  const panel = { add: (...args) => adds.push(args) };
  await withServer(async () => {}, async (baseUrl, root, app) => {
    const response = await postAsk(baseUrl, imageBody());
    assert.ok(response.task_id);
    assert.equal(app.locals.imageTaskStatusPanel, panel);
    assert.equal(adds.length, 1);
    const running = JSON.parse(await fs.readFile(path.join(root, 'running', `${response.task_id}.json`), 'utf8'));
    assert.deepEqual(adds[0], [response.task_id, running.created_at * 1000]);
    authentication.resolve();
  }, { authenticate: () => authentication.promise, imageTaskStatusPanel: panel });
});

test('video tasks never touch the image task status panel', async () => {
  const touches = [];
  const panel = new Proxy({}, { get: (_target, method) => (...args) => touches.push([method, ...args]) });
  await withServer(async () => {}, async (baseUrl) => {
    const response = await postAsk(baseUrl, videoBody());
    assert.ok(response.task_id);
    await new Promise(setImmediate);
    assert.deepEqual(touches, []);
  }, { imageTaskStatusPanel: panel });
});

test('image task observe fallback marks custom run and authentication exceptions failed', async () => {
  for (const failurePoint of ['authenticate', 'runTask']) {
    const failures = [];
    await withServer(
      async () => { if (failurePoint === 'runTask') throw new Error('custom image task failed'); },
      async (baseUrl) => {
        const response = await postAsk(baseUrl, imageBody({ wait_for_completion: true }));
        assert.equal(response.status, 'completed');
        assert.equal(response.result.status, 'error');
        assert.equal(failures.length, 1);
        assert.equal(failures[0][0], response.result.task_id);
      },
      {
        authenticate: async () => { if (failurePoint === 'authenticate') throw new Error('authentication failed'); },
        imageTaskStatusPanel: { add: () => {}, fail: (...args) => failures.push(args) },
      },
    );
  }
});

test('custom successful image runTask does not mark status panel successful', async () => {
  const successes = [];
  await withServer(async () => {}, async (baseUrl) => {
    const response = await postAsk(baseUrl, imageBody());
    assert.ok(response.task_id);
    await new Promise(setImmediate);
    assert.deepEqual(successes, []);
  }, { imageTaskStatusPanel: { add: () => {}, succeed: (...args) => successes.push(args) } });
});

test('standby browser initialization is shared and retries after cleaning a partial failure', async () => {
  let connects = 0;
  let disconnects = 0;
  const page = { isClosed: () => false, url: () => '', evaluate: async () => null, goto: async () => {} };
  const manager = createStandbyBrowserManager({
    resolveBrowserURL: async () => 'ws://browser',
    connect: async () => {
      connects += 1;
      if (connects === 1) return { connected: true, pages: async () => { throw new Error('pages failed'); }, disconnect: async () => { disconnects += 1; }, on: () => {} };
      return { connected: true, pages: async () => [page], newPage: async () => page, on: () => {} };
    },
    setViewport: async () => {},
    projectListUrl: 'https://project-list',
    log: () => {},
  });
  const failed = await Promise.allSettled([manager.ensure(), manager.ensure()]);
  assert.ok(failed.every((item) => item.status === 'rejected'));
  assert.equal(connects, 1);
  assert.equal(disconnects, 1);
  const [a, b] = await Promise.all([manager.ensure(), manager.ensure()]);
  assert.equal(a, b);
  assert.equal(connects, 2);
});

test('standby browser reconnects once when a previously ready page closes', async () => {
  let connects = 0;
  let closed = false;
  const manager = createStandbyBrowserManager({
    resolveBrowserURL: async () => 'ws://browser',
    connect: async () => {
      connects += 1;
      const page = { isClosed: () => closed, url: () => '', evaluate: async () => null, goto: async () => {} };
      return { connected: true, pages: async () => [page], newPage: async () => page, on: () => {} };
    },
    setViewport: async () => {}, projectListUrl: 'https://project-list', log: () => {},
  });
  await manager.ensure();
  closed = true;
  await Promise.all([manager.ensure(), manager.ensure()]);
  assert.equal(connects, 2);
});

test('authentication gate shares one login recovery across concurrent callers', async () => {
  let authenticated = false;
  let loginCalls = 0;
  const gate = createAuthenticationGate({
    verify: async () => authenticated,
    login: async () => { loginCalls += 1; authenticated = true; },
    sleep: async () => {},
    pollIntervalMs: 0,
    log: () => {},
  });

  await Promise.all([gate.ensure(), gate.ensure(), gate.ensure()]);
  assert.equal(loginCalls, 1);
});

test('image and video tasks wait for authentication before dispatch', async () => {
  const authentication = deferred();
  const starts = [];
  await withServer(async (id, _requestPath, _body, action) => {
    starts.push({ id, action });
  }, async (baseUrl) => {
    const [image, video] = await Promise.all([
      postAsk(baseUrl, imageBody()),
      postAsk(baseUrl, videoBody()),
    ]);
    await new Promise(setImmediate);
    assert.deepEqual(starts, []);

    authentication.resolve();
    await waitUntil(() => starts.length === 2, 'tasks did not resume after authentication');
    assert.deepEqual(new Set(starts.map((item) => item.action)), new Set(['generate_image', 'generate_video']));
    assert.ok(image.task_id);
    assert.ok(video.task_id);
  }, { authenticate: () => authentication.promise });
});

test('task app listens on loopback by default and accepts explicit host override', async () => {
  const testApp = express().get('/health', (_req, res) => res.json({ ok: true }));
  const server = listenTaskApp(testApp, { port: 0 });
  await withDeadline(new Promise((resolve) => server.once('listening', resolve)), 'loopback server did not listen');
  try {
    assert.equal(server.address().address, '127.0.0.1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const overridden = listenTaskApp(testApp, { port: 0, host: '0.0.0.0' });
  await withDeadline(new Promise((resolve) => overridden.once('listening', resolve)), 'override server did not listen');
  try {
    assert.equal(overridden.address().address, '0.0.0.0');
  } finally {
    await new Promise((resolve) => overridden.close(resolve));
  }
});
