import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createImageSession } from './image-session.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  throw new Error(message);
}

function response(result = {}, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => Buffer.from('image'),
    json: async () => result,
    text: async () => JSON.stringify(result),
  };
}

function createHarness(options = {}) {
  const calls = [];
  const pages = [];
  const browserListeners = new Map();
  let projectSequence = 0;
  let resourceSequence = 0;
  const statuses = new Map();

  const handler = options.handler || (async (requestPath, body) => {
    if (requestPath === '/proxy/api/v1/project/create') {
      projectSequence += 1;
      return { Result: { ProjectId: `project-${projectSequence}`, ScriptId: `script-${projectSequence}` } };
    }
    if (requestPath === '/proxy/api/v1/file/upload') {
      return { Result: { UploadInfos: [{ Url: 'https://upload.test/image', TosKey: `key-${calls.length}`, DownloadTosUrl: 'https://cdn.test/ref.png' }] } };
    }
    if (requestPath === '/proxy/api/v1/image/add' && body.SourceType === 'custom') {
      return { Result: { ImageId: `reference-${calls.length}` } };
    }
    if (requestPath === '/proxy/api/v1/image/add' && body.SourceType === 'generated') {
      resourceSequence += 1;
      const resourceId = `resource-${resourceSequence}`;
      statuses.set(resourceId, ['done']);
      return { Result: { ImageId: resourceId } };
    }
    if (requestPath === '/proxy/api/v1/tasks/image/list') {
      const resourceId = body.Filters.ResourceIds[0];
      const sequence = statuses.get(resourceId) || ['done'];
      const status = sequence.shift() || 'done';
      return {
        Result: {
          Items: [{
            ResourceId: resourceId,
            Status: status,
            GeneratedResource: { ImagesInfo: [{ HighResolutionUrl: `https://cdn.test/${resourceId}.png` }] },
          }],
        },
      };
    }
    return { Result: {} };
  });

  function makePage() {
    let closed = false;
    const pageListeners = new Map();
    const mainFrame = {};
    const page = {
      viewports: [],
      url: '',
      isClosed: () => closed,
      close: async () => { closed = true; },
      setViewport: async (viewport) => { page.viewports.push(viewport); },
      waitForNetworkIdle: async () => {},
      goto: async (url) => { page.url = url; },
      mainFrame: () => mainFrame,
      on(event, listener) {
        const listeners = pageListeners.get(event) || new Set();
        listeners.add(listener);
        pageListeners.set(event, listeners);
      },
      off(event, listener) { pageListeners.get(event)?.delete(listener); },
      listenerCount: (event) => pageListeners.get(event)?.size || 0,
      emitForTest(event, value = mainFrame) {
        for (const listener of pageListeners.get(event) || []) listener(value);
      },
      evaluate: async (_fn, args) => {
        if (!args?.requestPath) return { width: 1200, height: 900 };
        calls.push({ path: args.requestPath, body: args.body, timeoutMs: args.timeoutMs, page });
        return handler(args.requestPath, args.body, { calls, page, statuses });
      },
    };
    pages.push(page);
    return page;
  }

  const browser = {
    connected: true,
    isConnected() { return this.connected; },
    newPage: async () => makePage(),
    on(event, listener) {
      const listeners = browserListeners.get(event) || new Set();
      listeners.add(listener);
      browserListeners.set(event, listeners);
    },
    off(event, listener) { browserListeners.get(event)?.delete(listener); },
    listenerCount: (event) => browserListeners.get(event)?.size || 0,
    disconnectForTest() {
      this.connected = false;
      for (const listener of browserListeners.get('disconnected') || []) listener();
    },
  };

  const uploadFetch = async () => response();
  return { browser, calls, pages, statuses, getBrowser: async () => browser, fetch: uploadFetch };
}

function dataImage(value = 'image') {
  return `data:image/png;base64,${Buffer.from(value).toString('base64')}`;
}

function task(overrides = {}) {
  return {
    prompt: 'product photo',
    ratio: '1:1',
    resolution: '1k',
    count: 1,
    model: 'ep-20260318144532-28ssz',
    model_name: 'Doubao-Seedream-5.0-lite',
    images: [{ url: dataImage(), title: 'reference' }],
    ...overrides,
  };
}

async function withSession(harness, callback, options = {}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-session-test-'));
  const session = createImageSession({
    getBrowser: harness.getBrowser,
    getTeamId: async () => 'team-current',
    fetch: harness.fetch,
    fs,
    tempRoot,
    pollIntervalMs: 0,
    generationTimeoutMs: 1000,
    timers: { now: Date.now, sleep: async () => {} },
    ...options,
  });
  try {
    return await callback(session, tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test('concurrent readiness creates one fixed 9:16 image project and keeps its canvas open', async () => {
  const initGate = deferred();
  const harness = createHarness({
    handler: async (requestPath, body) => {
      if (requestPath === '/proxy/api/v1/project/create') {
        await initGate.promise;
        return { Result: { ProjectId: 'project-1', ScriptId: 'script-1' } };
      }
      return { Result: {} };
    },
  });

  await withSession(harness, async (session) => {
    const first = session.ensureReady();
    const second = session.ensureReady();
    await waitUntil(() => harness.calls.some((call) => call.path === '/proxy/api/v1/project/create'), 'initialization did not reach project creation');
    assert.equal(harness.calls.filter((call) => call.path === '/proxy/api/v1/project/create').length, 1);
    initGate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b);
    assert.equal(a.projectName, 'image');
    assert.equal(a.url, 'https://work.xiaomaomi.cn/dramart/project/project-1/script-1/team-current/canvas');
    assert.equal(harness.pages[0].isClosed(), false);
    assert.deepEqual(harness.pages[0].viewports, [{ width: 1920, height: 920 }]);

    const create = harness.calls.find((call) => call.path === '/proxy/api/v1/project/create');
    assert.equal(create.body.AspectRatio, '9:16');
    assert.equal(create.body.VisualPromptId, 'realistic_modern_urban');
    const updates = harness.calls.filter((call) => call.path === '/proxy/api/v1/project/update');
    assert.equal(updates[0].body.ProjectName, 'image');
    assert.equal(updates[1].body.Status, 'resource_confirmed');
  });
});

test('tasks submit concurrently with independent requested ratios', async () => {
  const firstListGate = deferred();
  let firstResource = '';
  const harness = createHarness({
    handler: async (requestPath, body, context) => {
      if (requestPath === '/proxy/api/v1/project/create') return { Result: { ProjectId: 'shared-project', ScriptId: 'shared-script' } };
      if (requestPath === '/proxy/api/v1/file/upload') return { Result: { UploadInfos: [{ Url: 'https://upload.test/image', TosKey: `key-${context.calls.length}` }] } };
      if (requestPath === '/proxy/api/v1/image/add' && body.SourceType === 'custom') return { Result: { ImageId: `ref-${context.calls.length}` } };
      if (requestPath === '/proxy/api/v1/image/add') {
        const id = firstResource ? 'resource-2' : 'resource-1';
        firstResource ||= id;
        return { Result: { ImageId: id } };
      }
      if (requestPath === '/proxy/api/v1/tasks/image/list') {
        if (body.Filters.ResourceIds[0] === firstResource) await firstListGate.promise;
        const resourceId = body.Filters.ResourceIds[0];
        return { Result: { Items: [{ ResourceId: resourceId, Status: 'done', GeneratedResource: { ImagesInfo: [{ HighResolutionUrl: 'https://cdn.test/result.png' }] } }] } };
      }
      return { Result: {} };
    },
  });

  await withSession(harness, async (session) => {
    const first = session.runTask('task-a', task({ ratio: '1:1' }));
    await waitUntil(() => harness.calls.some((call) => call.path.endsWith('/list')), 'first task did not start polling');
    const second = session.runTask('task-b', task({ ratio: '16:9' }));
    await waitUntil(() => harness.calls.filter((call) => call.path.endsWith('/generate')).length >= 2, 'second task did not submit');

    const submissions = harness.calls.filter((call) => call.path.endsWith('/generate'));
    assert.deepEqual(submissions.map((call) => call.body.ModelConf.AspectRatio), ['1:1', '16:9']);
    assert.ok(submissions.every((call) => call.body.ModelConf.Resolution === '1k'));
    assert.ok(submissions.every((call) => call.body.CreatedFrom === 'canvas'));
    assert.ok(submissions.every((call) => !('Resolution' in call.body)));
    assert.ok(submissions.every((call) => !('AspectRatio' in call.body.GenerationParams[0])));
    assert.ok(submissions.every((call) => !('Resolution' in call.body.GenerationParams[0])));
    assert.ok(submissions.every((call) => JSON.stringify(call.body.ParsedPrompt) === JSON.stringify({ StyleId: 'realistic_modern_urban' })));
    assert.ok(submissions.every((call) => call.body.ProjectId === 'shared-project'));
    firstListGate.resolve();
    await Promise.all([first, second]);
  });
});

test('concurrent polling stays isolated by each generated resourceId', async () => {
  const harness = createHarness();
  await withSession(harness, async (session) => {
    const results = await Promise.all([
      session.runTask('task-a', task()),
      session.runTask('task-b', task({ ratio: '4:3' })),
    ]);
    const listIds = harness.calls
      .filter((call) => call.path.endsWith('/list'))
      .map((call) => call.body.Filters.ResourceIds[0]);
    assert.deepEqual(new Set(listIds), new Set(['resource-1', 'resource-2']));
    assert.deepEqual(new Set(results.map((result) => result.resourceId)), new Set(['resource-1', 'resource-2']));
  });
});

test('polling ignores another resource until the requested resource is explicitly returned', async () => {
  let polls = 0;
  const harness = createHarness({
    handler: async (requestPath, body) => {
      if (requestPath === '/proxy/api/v1/project/create') return { Result: { ProjectId: 'project', ScriptId: 'script' } };
      if (requestPath === '/proxy/api/v1/file/upload') return { Result: { UploadInfos: [{ Url: 'https://upload.test/image', TosKey: 'key' }] } };
      if (requestPath === '/proxy/api/v1/image/add' && body.SourceType === 'custom') return { Result: { ImageId: 'reference' } };
      if (requestPath === '/proxy/api/v1/image/add') return { Result: { ImageId: 'resource-current' } };
      if (requestPath.endsWith('/list')) {
        polls += 1;
        const resourceId = polls === 1 ? 'resource-other' : 'resource-current';
        return { Result: { Items: [{ ResourceId: resourceId, Status: 'done', GeneratedResource: { ImagesInfo: [{ HighResolutionUrl: `https://cdn.test/${resourceId}.png` }] } }] } };
      }
      return { Result: {} };
    },
  });

  await withSession(harness, async (session) => {
    const result = await session.runTask('task-current', task());
    assert.equal(polls, 2);
    assert.equal(result.images[0].image_url, 'https://cdn.test/resource-current.png');
  });
});

test('polling ignores ImageId and nested IDs when top-level ResourceId belongs to another resource', async () => {
  let polls = 0;
  const harness = createHarness({
    handler: async (requestPath, body) => {
      if (requestPath === '/proxy/api/v1/project/create') return { Result: { ProjectId: 'project', ScriptId: 'script' } };
      if (requestPath === '/proxy/api/v1/file/upload') return { Result: { UploadInfos: [{ Url: 'https://upload.test/image', TosKey: 'key' }] } };
      if (requestPath === '/proxy/api/v1/image/add' && body.SourceType === 'custom') return { Result: { ImageId: 'reference' } };
      if (requestPath === '/proxy/api/v1/image/add') return { Result: { ImageId: 'resource-current' } };
      if (requestPath.endsWith('/list')) {
        polls += 1;
        if (polls === 1) return { Result: { Items: [{ ResourceId: 'other-resource', ImageId: 'resource-current', GeneratedResource: { ResourceId: 'resource-current', ImagesInfo: [{ HighResolutionUrl: 'https://cdn.test/wrong.png' }] }, Status: 'done' }] } };
        if (polls === 2) return { Result: { Items: [{ ImageId: 'resource-current', GeneratedResource: { ResourceId: 'resource-current', ImagesInfo: [{ HighResolutionUrl: 'https://cdn.test/also-wrong.png' }] }, Status: 'done' }] } };
        return { Result: { Items: [{ ResourceId: 'resource-current', Status: 'done', GeneratedResource: { ImagesInfo: [{ HighResolutionUrl: 'https://cdn.test/right.png' }] } }] } };
      }
      return { Result: {} };
    },
  });
  await withSession(harness, async (session) => {
    const result = await session.runTask('strict-resource', task());
    assert.equal(polls, 3);
    assert.equal(result.images[0].image_url, 'https://cdn.test/right.png');
  });
});

test('external downloads enforce timeout signal and maximum image size', async () => {
  let downloadOptions;
  const harness = createHarness();
  harness.fetch = async (url, options) => {
    if (url === 'https://input.test/large.png') {
      downloadOptions = options;
      return {
        ...response(),
        headers: { get: (name) => name === 'content-length' ? String(51 * 1024 * 1024) : 'image/png' },
      };
    }
    return response();
  };
  await withSession(harness, async (session) => {
    await assert.rejects(session.runTask('large-download', task({ images: [{ url: 'https://input.test/large.png' }] })), /超过.*50.*MB/);
    assert.ok(downloadOptions.signal, 'download fetch must receive an AbortSignal');
  }, { requestTimeoutMs: 1234, maxImageBytes: 50 * 1024 * 1024 });
});

test('TOS upload and pagePost receive configured timeout controls', async () => {
  let putOptions;
  const harness = createHarness();
  harness.fetch = async (url, options) => {
    if (options?.method === 'PUT') putOptions = options;
    return response();
  };
  await withSession(harness, async (session) => {
    await session.runTask('timeouts', task());
    assert.ok(putOptions.signal, 'TOS PUT must receive an AbortSignal');
    assert.ok(harness.calls.every((call) => call.timeoutMs === 4321), 'pagePost must receive configured timeout');
  }, { requestTimeoutMs: 4321 });
});

test('runTask reports the exact session it actually uses through onReady', async () => {
  const harness = createHarness();
  await withSession(harness, async (session) => {
    let readyState;
    await session.runTask('ready-callback', task(), { onReady: async (state) => { readyState = state; } });
    assert.equal(readyState.projectId, 'project-1');
    assert.equal(readyState.page, harness.pages[0]);
  });
});

test('successful task awaits session readiness and reports the complete progress sequence', async () => {
  const harness = createHarness();
  const sessionReadyGate = deferred();
  const readyPages = [];
  const progress = [];
  await withSession(harness, async (session) => {
    const running = session.runTask('progress-success', task({ count: 2 }), {
      onProgress: async (update) => { progress.push(update); },
    });
    await waitUntil(() => readyPages.length === 1, 'session ready callback was not called');
    assert.equal(harness.calls.some((call) => call.path === '/proxy/api/v1/file/upload'), false);
    sessionReadyGate.resolve();
    const result = await running;

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(readyPages, [harness.pages[0]]);
    assert.deepEqual(progress, [
      { code: 'preparing_session', stage: '准备生图会话', detail: '' },
      { code: 'uploading_references', stage: '正在上传参考图', detail: '1 张图片' },
      { code: 'creating_resource', stage: '正在创建生图资源', detail: '' },
      { code: 'submitting', stage: '正在提交图片生成', detail: 'Doubao-Seedream-5.0-lite · 1:1 · 2 张' },
      { code: 'generating', stage: '图片生成中', detail: 'Doubao-Seedream-5.0-lite · 1:1 · 2 张' },
    ]);
  }, {
    onSessionReady: async (page) => {
      readyPages.push(page);
      await sessionReadyGate.promise;
    },
  });
});

test('onSessionReady can reenter ensureReady while the original caller still awaits the hook', async () => {
  const harness = createHarness();
  const hookGate = deferred();
  let sessionRef;
  let reentrantState;
  await withSession(harness, async (session) => {
    sessionRef = session;
    let originalSettled = false;
    const original = session.ensureReady().then((state) => {
      originalSettled = true;
      return state;
    });
    await waitUntil(() => reentrantState, 'reentrant ensureReady did not return initialized state');
    assert.equal(reentrantState.page, harness.pages[0]);
    assert.equal(originalSettled, false);
    hookGate.resolve();
    assert.equal(await original, reentrantState);
  }, {
    onSessionReady: async () => {
      reentrantState = await sessionRef.ensureReady();
      await hookGate.promise;
    },
  });
});

test('main-frame DOM reload notifies readiness again and callback failure remains non-fatal', async () => {
  const harness = createHarness();
  const readyPages = [];
  const logs = [];
  let calls = 0;

  await withSession(harness, async (session) => {
    const state = await session.ensureReady();
    assert.deepEqual(readyPages, [state.page]);
    assert.equal(state.page.listenerCount('domcontentloaded'), 1);

    state.page.emitForTest('domcontentloaded', {});
    await new Promise(setImmediate);
    assert.equal(readyPages.length, 1, 'child-frame navigation must be ignored');

    calls = 1;
    state.page.emitForTest('domcontentloaded');
    await new Promise(setImmediate);
    assert.deepEqual(readyPages, [state.page, state.page]);
    assert.ok(logs.some((line) => line.includes('session_ready_callback_error') && line.includes('reload callback failed')));
    assert.equal(await session.ensureReady(), state);
  }, {
    log: (line) => logs.push(line),
    onSessionReady: async (page) => {
      readyPages.push(page);
      if (calls === 1) throw new Error('reload callback failed');
    },
  });
});

test('page replacement removes the old DOM listener and activates only the new page listener', async () => {
  const harness = createHarness();
  const readyPages = [];

  await withSession(harness, async (session) => {
    const oldState = await session.ensureReady();
    await oldState.page.close();
    const newState = await session.ensureReady();

    assert.equal(oldState.page.listenerCount('domcontentloaded'), 0);
    assert.equal(newState.page.listenerCount('domcontentloaded'), 1);
    oldState.page.emitForTest('domcontentloaded');
    newState.page.emitForTest('domcontentloaded');
    await new Promise(setImmediate);
    assert.deepEqual(readyPages, [oldState.page, newState.page, newState.page]);
  }, {
    onSessionReady: (page) => { readyPages.push(page); },
  });
});

test('invalidated initialization cannot clear or resolve instead of a concurrent retry', async () => {
  const first = createHarness();
  const replacementCreateGate = deferred();
  const firstHookGate = deferred();
  let firstHookEntered = false;
  let replacementCreateCalls = 0;
  const replacement = createHarness({
    handler: async (requestPath) => {
      if (requestPath === '/proxy/api/v1/project/create') {
        replacementCreateCalls += 1;
        await replacementCreateGate.promise;
        return { Result: { ProjectId: 'new-project', ScriptId: 'new-script' } };
      }
      return { Result: {} };
    },
  });
  let currentBrowser = first.browser;

  await withSession(first, async (session) => {
    const stale = session.ensureReady();
    await waitUntil(() => firstHookEntered, 'first session hook was not entered');
    currentBrowser = replacement.browser;
    first.browser.disconnectForTest();

    const retryA = session.ensureReady();
    const retryB = session.ensureReady();
    assert.equal(retryA, retryB);
    await waitUntil(() => replacementCreateCalls === 1, 'replacement initialization did not start');

    firstHookGate.resolve();
    await assert.rejects(stale, /session.*invalidated/i);
    const retryC = session.ensureReady();
    assert.equal(retryC, retryA);
    replacementCreateGate.resolve();

    const [stateA, stateB, stateC] = await Promise.all([retryA, retryB, retryC]);
    assert.equal(stateA, stateB);
    assert.equal(stateB, stateC);
    assert.equal(stateA.projectId, 'new-project');
    assert.equal(stateA.page, replacement.pages[0]);
    assert.equal(replacementCreateCalls, 1);
    assert.equal(first.calls.filter((call) => call.path === '/proxy/api/v1/project/create').length, 1);
  }, {
    getBrowser: async () => currentBrowser,
    onSessionReady: async (page) => {
      if (page === first.pages[0]) {
        firstHookEntered = true;
        await firstHookGate.promise;
      }
    },
  });
});

test('ordinary task failure neither closes the shared page nor blocks another task', async () => {
  const harness = createHarness({
    handler: async (requestPath, body) => {
      if (requestPath === '/proxy/api/v1/project/create') return { Result: { ProjectId: 'project', ScriptId: 'script' } };
      if (requestPath === '/proxy/api/v1/file/upload') return { Result: { UploadInfos: [{ Url: 'https://upload.test/image', TosKey: 'key' }] } };
      if (requestPath === '/proxy/api/v1/image/add' && body.SourceType === 'custom') {
        if (body.File.ImageTitle === 'must-fail') throw new Error('upload registration rejected');
        return { Result: { ImageId: 'ref-ok' } };
      }
      if (requestPath === '/proxy/api/v1/image/add') return { Result: { ImageId: 'resource-ok' } };
      if (requestPath.endsWith('/list')) return { Result: { Items: [{ ResourceId: 'resource-ok', Status: 'done', GeneratedResource: { ImagesInfo: [{ HighResolutionUrl: 'https://cdn.test/ok.png' }] } }] } };
      return { Result: {} };
    },
  });

  await withSession(harness, async (session) => {
    const [failed, succeeded] = await Promise.allSettled([
      session.runTask('task-fail', task({ images: [{ url: dataImage(), title: 'must-fail' }] })),
      session.runTask('task-ok', task()),
    ]);
    assert.equal(failed.status, 'rejected');
    assert.equal(succeeded.status, 'fulfilled');
    assert.equal(harness.pages.length, 1);
    assert.equal(harness.pages[0].isClosed(), false);
  });
});

test('page closure after submission recovers and polls the old target without resubmitting', async () => {
  let currentBrowser;
  let submitCount = 0;
  const logs = [];
  const first = createHarness({
    handler: async (requestPath, body, context) => {
      if (requestPath === '/proxy/api/v1/project/create') return { Result: { ProjectId: 'old-project', ScriptId: 'old-script' } };
      if (requestPath === '/proxy/api/v1/file/upload') return { Result: { UploadInfos: [{ Url: 'https://upload.test/image', TosKey: 'key' }] } };
      if (requestPath === '/proxy/api/v1/image/add' && body.SourceType === 'custom') return { Result: { ImageId: 'reference' } };
      if (requestPath === '/proxy/api/v1/image/add') return { Result: { ImageId: 'old-resource' } };
      if (requestPath.endsWith('/generate')) { submitCount += 1; return { Result: {} }; }
      if (requestPath.endsWith('/list')) {
        await context.page.close();
        currentBrowser = replacement.browser;
        throw new Error('Protocol error: Target closed Authorization: Bearer super-secret');
      }
      return { Result: {} };
    },
  });
  const replacement = createHarness({
    handler: async (requestPath) => {
      if (requestPath === '/proxy/api/v1/project/create') return { Result: { ProjectId: 'new-project', ScriptId: 'new-script' } };
      if (requestPath.endsWith('/list')) return { Result: { Items: [{ ResourceId: 'old-resource', Status: 'done', GeneratedResource: { ImagesInfo: [{ HighResolutionUrl: 'https://cdn.test/recovered.png' }] } }] } };
      return { Result: {} };
    },
  });
  currentBrowser = first.browser;
  const readyPages = [];
  const progress = [];

  await withSession(first, async (session) => {
    const running = session.runTask('task-running', task(), { onProgress: async (update) => { progress.push(update); } });
    await waitUntil(() => first.pages[0]?.isClosed(), 'polling context did not close');
    const result = await running;
    assert.equal(result.status, 'succeeded');
    assert.equal(result.images[0].image_url, 'https://cdn.test/recovered.png');
    assert.equal(submitCount, 1);
    assert.equal(replacement.calls.filter((call) => call.path === '/proxy/api/v1/project/create').length, 1);
    const recoveredPoll = replacement.calls.find((call) => call.path.endsWith('/list'));
    assert.equal(recoveredPoll.body.TeamId, 'team-current');
    assert.equal(recoveredPoll.body.ProjectId, 'old-project');
    assert.equal(recoveredPoll.body.ScriptId, 'old-script');
    assert.deepEqual(recoveredPoll.body.Filters.ResourceIds, ['old-resource']);
    assert.ok(logs.some((line) => line.includes('[image-session.poll_recover]') && line.includes('old_project_id=old-project') && line.includes('mounted_project_id=new-project')));
    assert.ok(logs.every((line) => !line.includes('super-secret')));
    assert.deepEqual(readyPages, [first.pages[0], replacement.pages[0]]);
    assert.deepEqual(progress.map((update) => update.code), [
      'preparing_session',
      'uploading_references',
      'creating_resource',
      'submitting',
      'generating',
      'recovering_session',
      'generating',
    ]);
  }, {
    getBrowser: async () => currentBrowser,
    log: (line) => logs.push(line),
    onSessionReady: async (page) => { readyPages.push(page); },
  });
});

test('sync and async notification failures are logged without failing readiness or tasks', async () => {
  const harness = createHarness();
  const logs = [];
  let readyCalls = 0;
  await withSession(harness, async (session) => {
    const firstState = await session.ensureReady();
    assert.equal(firstState.page, harness.pages[0]);
    await harness.pages[0].close();
    const secondState = await session.ensureReady();
    assert.equal(secondState.page, harness.pages[1]);

    const syncResult = await session.runTask('sync-progress-error', task(), {
      onProgress: () => { throw new Error('sync progress failure Authorization: Bearer progress-secret'); },
    });
    const asyncResult = await session.runTask('async-progress-error', task(), {
      onProgress: async () => { throw new Error('async progress failure credential=async-progress-secret'); },
    });

    assert.equal(syncResult.status, 'succeeded');
    assert.equal(asyncResult.status, 'succeeded');
    assert.equal(readyCalls, 2);
    assert.ok(logs.some((line) => line.startsWith('[image-session.session_ready_callback_error]') && line.includes('sync ready failure') && line.includes('[redacted]')));
    assert.ok(logs.some((line) => line.startsWith('[image-session.session_ready_callback_error]') && line.includes('async ready failure') && line.includes('[redacted]')));
    assert.ok(logs.some((line) => line.startsWith('[image-session.progress_callback_error]') && line.includes('sync progress failure') && line.includes('[redacted]')));
    assert.ok(logs.some((line) => line.startsWith('[image-session.progress_callback_error]') && line.includes('async progress failure') && line.includes('[redacted]')));
    assert.ok(logs.every((line) => !line.includes('ready-secret') && !line.includes('progress-secret')));
  }, {
    log: (line) => logs.push(line),
    onSessionReady: () => {
      readyCalls += 1;
      if (readyCalls === 1) throw new Error('sync ready failure Authorization: Bearer ready-secret');
      return Promise.reject(new Error('async ready failure credential=async-ready-secret'));
    },
  });
});

test('page closure after submission returns an explicit failure when shared recovery fails', async () => {
  let currentBrowser;
  let submitCount = 0;
  const first = createHarness({
    handler: async (requestPath, body, context) => {
      if (requestPath === '/proxy/api/v1/project/create') return { Result: { ProjectId: 'old-project', ScriptId: 'old-script' } };
      if (requestPath === '/proxy/api/v1/file/upload') return { Result: { UploadInfos: [{ Url: 'https://upload.test/image', TosKey: 'key' }] } };
      if (requestPath === '/proxy/api/v1/image/add' && body.SourceType === 'custom') return { Result: { ImageId: 'reference' } };
      if (requestPath === '/proxy/api/v1/image/add') return { Result: { ImageId: 'old-resource' } };
      if (requestPath.endsWith('/generate')) { submitCount += 1; return { Result: {} }; }
      if (requestPath.endsWith('/list')) {
        await context.page.close();
        currentBrowser = replacement.browser;
        throw new Error('Protocol error: Target closed');
      }
      return { Result: {} };
    },
  });
  const replacement = createHarness({
    handler: async (requestPath) => {
      if (requestPath === '/proxy/api/v1/project/create') throw new Error('recovery unavailable');
      return { Result: {} };
    },
  });
  currentBrowser = first.browser;

  await withSession(first, async (session) => {
    const result = await session.runTask('task-recovery-fails', task());
    assert.equal(result.status, 'failed');
    assert.match(result.failedReason, /会话恢复失败.*old-project.*old-resource/i);
    assert.equal(submitCount, 1);
  }, { getBrowser: async () => currentBrowser });
});

test('authentication errors invalidate the session so concurrent next callers share recovery', async () => {
  let currentBrowser;
  const first = createHarness({
    handler: async (requestPath, body) => {
      if (requestPath === '/proxy/api/v1/project/create') return { Result: { ProjectId: 'old-project', ScriptId: 'old-script' } };
      if (requestPath === '/proxy/api/v1/file/upload') throw new Error('/proxy/api/v1/file/upload HTTP 401: unauthorized');
      return { Result: {} };
    },
  });
  const replacement = createHarness({
    handler: async (requestPath) => requestPath === '/proxy/api/v1/project/create'
      ? { Result: { ProjectId: 'new-project', ScriptId: 'new-script' } }
      : { Result: {} },
  });
  currentBrowser = first.browser;

  await withSession(first, async (session) => {
    await assert.rejects(session.runTask('task-auth', task()), /401/);
    assert.equal(first.pages[0].isClosed(), true);
    assert.equal(first.browser.listenerCount('disconnected'), 0);
    currentBrowser = replacement.browser;
    const [a, b] = await Promise.all([session.ensureReady(), session.ensureReady()]);
    assert.equal(a, b);
    assert.equal(a.projectId, 'new-project');
    assert.equal(replacement.calls.filter((call) => call.path === '/proxy/api/v1/project/create').length, 1);
    assert.equal(replacement.browser.listenerCount('disconnected'), 1);
  }, { getBrowser: async () => currentBrowser });
});

test('closed page causes concurrent callers to share exactly one recovery project', async () => {
  const harness = createHarness();
  await withSession(harness, async (session) => {
    const original = await session.ensureReady();
    await harness.pages[0].close();
    const [recoveredA, recoveredB] = await Promise.all([session.ensureReady(), session.ensureReady()]);
    assert.equal(recoveredA, recoveredB);
    assert.notEqual(recoveredA.projectId, original.projectId);
    assert.equal(harness.calls.filter((call) => call.path === '/proxy/api/v1/project/create').length, 2);
    assert.equal(harness.pages.length, 2);
  });
});

test('repeated page recovery keeps one disconnect listener and one live dedicated page', async () => {
  const harness = createHarness();
  await withSession(harness, async (session) => {
    await session.ensureReady();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const previous = harness.pages.at(-1);
      await previous.close();
      await Promise.all([session.ensureReady(), session.ensureReady()]);
      assert.equal(harness.browser.listenerCount('disconnected'), 1);
      assert.equal(harness.pages.filter((page) => !page.isClosed()).length, 1);
    }
  });
});

test('browser disconnection causes concurrent callers to share exactly one recovery project', async () => {
  const harness = createHarness();
  let currentBrowser = harness.browser;
  const replacementHarness = createHarness({
    handler: async (requestPath) => {
      if (requestPath === '/proxy/api/v1/project/create') return { Result: { ProjectId: 'project-2', ScriptId: 'script-2' } };
      return { Result: {} };
    },
  });
  await withSession(harness, async (session) => {
    const original = await session.ensureReady();
    harness.browser.disconnectForTest();
    currentBrowser = replacementHarness.browser;
    harness.getBrowser = async () => currentBrowser;

    const [recoveredA, recoveredB] = await Promise.all([session.ensureReady(), session.ensureReady()]);
    assert.equal(recoveredA, recoveredB);
    assert.notEqual(recoveredA.projectId, original.projectId);
    assert.equal(harness.calls.filter((call) => call.path === '/proxy/api/v1/project/create').length, 1);
    assert.equal(replacementHarness.calls.filter((call) => call.path === '/proxy/api/v1/project/create').length, 1);
  }, { getBrowser: async () => currentBrowser });
});

test('each task uses and finally removes only its own temporary directory', async () => {
  const harness = createHarness();
  await withSession(harness, async (session, tempRoot) => {
    await Promise.all([
      session.runTask('task-a', task({ images: [{ url: dataImage('a') }] })),
      session.runTask('task-b', task({ images: [{ url: dataImage('b') }] })),
    ]);
    assert.deepEqual(await fs.readdir(tempRoot), []);

    await assert.rejects(session.runTask('task-fail', task({ images: [{ url: 'data:not-valid' }] })));
    assert.deepEqual(await fs.readdir(tempRoot), []);
  });
});
