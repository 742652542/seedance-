import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chooseModel,
  createTaskEpisodeApi,
  ensureProjectForRatioApi,
  isVideoConfigSummaryText,
  openTaskPage,
  prepareVideoTask,
  runVideoWorkflow,
  setVideoOptionsOnce,
  summarizeVideoMetaInput,
  uploadImages,
  videoConfigMatches,
} from './prepare-video-workflow.js';

test('video config opener recognizes a current mov summary before changing it to mp4', () => {
  assert.equal(isVideoConfigSummaryText('5s | 720p | 1个 | mov'), true);
});

test('shot verification reads first-frame prompt and image fields', () => {
  assert.deepEqual(summarizeVideoMetaInput({
    Prompt: '',
    RefImages: [],
    KeyFramePrompt: 'first-frame prompt',
    KeyFrameImages: { HeadImage: { Key: 'head.png' } },
  }), { prompt: 'first-frame prompt', imageCount: 1 });
});

test('chooseModel opens the model select regardless of its current value and verifies the selection', async () => {
  let selected = 'Wan-3.0';
  let triggerSelector = '';
  let optionSelector = '';
  const select = { evaluate: async () => {} };
  const option = {
    evaluate: async () => ({ text: 'Doubao-Seedance-2.0-fast', visible: true }),
  };
  let optionEvaluation = 0;
  option.evaluate = async () => {
    optionEvaluation += 1;
    if (optionEvaluation === 1) return { text: 'Doubao-Seedance-2.0-fast', visible: true };
    selected = 'Doubao-Seedance-2.0-fast';
  };
  const root = {
    $: async (selector) => { triggerSelector = selector; return select; },
    evaluate: async () => selected,
  };
  const page = { $$: async (selector) => { optionSelector = selector; return [option]; } };

  assert.equal(await chooseModel(page, 'Doubao-Seedance-2.0-fast', root), 'Doubao-Seedance-2.0-fast');
  assert.equal(triggerSelector, '.aml-arco-tag-is-dropdown');
  assert.equal(optionSelector, '.arco-dropdown-menu-item');
});

test('chooseModel fails when the selected model does not match the request', async () => {
  const root = {
    $: async () => ({ evaluate: async () => {} }),
    evaluate: async () => 'Wan-3.0',
  };
  let optionEvaluation = 0;
  const page = {
    $$: async () => [{
      evaluate: async () => {
        optionEvaluation += 1;
        return optionEvaluation === 1
          ? { text: 'Doubao-Seedance-2.0-fast', visible: true }
          : undefined;
      },
    }],
  };

  await assert.rejects(
    chooseModel(page, 'Doubao-Seedance-2.0-fast', root),
    /模型未按请求选中.*Wan-3.0/,
  );
});

function harness(overrides = {}) {
  const calls = [];
  const page = { close: async () => { calls.push('close'); } };
  const browser = { disconnect: async () => { calls.push('disconnect'); } };
  return {
    calls,
    page,
    browser,
    options: {
      tempImages: { cleanup: async () => { calls.push('cleanup'); } },
      materialize: async () => { calls.push('materialize'); return ['image']; },
      connect: async () => { calls.push('connect'); return browser; },
      createPage: async (_browser, onCreated) => { calls.push('createPage'); onCreated(page); return page; },
      prepare: async () => { calls.push('prepare'); return { prepared: true }; },
      execute: async () => { calls.push('execute'); return 'result'; },
      logError: () => {},
      ...overrides,
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('uploadImages waits for the shot update containing every uploaded reference', async () => {
  const responseGate = deferred();
  let responsePredicate;
  let waitOptions;
  const uploadCalls = [];
  const page = {
    waitForResponse: (predicate, options) => {
      responsePredicate = predicate;
      waitOptions = options;
      return responseGate.promise;
    },
  };
  const root = {
    $: async () => ({ uploadFile: async (...files) => { uploadCalls.push(files); } }),
  };

  const pending = uploadImages(page, ['one.png', 'two.png'], root, { timeoutMs: 1234 });
  let settled = false;
  pending.finally(() => { settled = true; }).catch(() => {});
  await new Promise(setImmediate);

  assert.deepEqual(uploadCalls, [['one.png', 'two.png']]);
  assert.equal(waitOptions.timeout, 1234);
  assert.equal(settled, false);
  const matchingResponse = {
    url: () => 'https://work.xiaomaomi.cn/proxy/api/v1/shot/update',
    request: () => ({
      method: () => 'POST',
      postData: () => JSON.stringify({ Shot: { VideoMeta: { RefImages: [{ Key: 'one' }, { Key: 'two' }] } } }),
    }),
    ok: () => true,
  };
  assert.equal(await responsePredicate(matchingResponse), true);
  responseGate.resolve(matchingResponse);
  await pending;
});

test('uploadImages ignores shot updates that do not contain all references', async () => {
  let responsePredicate;
  const responseGate = deferred();
  const page = {
    waitForResponse: (predicate) => {
      responsePredicate = predicate;
      return responseGate.promise;
    },
  };
  const root = { $: async () => ({ uploadFile: async () => {} }) };
  const pending = uploadImages(page, ['one.png', 'two.png'], root, { timeoutMs: 10 });
  const rejection = assert.rejects(pending, /等待参考图写入分镜超时 \(10ms\)/);
  await new Promise(setImmediate);

  const partialResponse = {
    url: () => 'https://work.xiaomaomi.cn/proxy/api/v1/shot/update',
    request: () => ({
      method: () => 'POST',
      postData: () => JSON.stringify({ Shot: { VideoMeta: { RefImages: [{ Key: 'one' }] } } }),
    }),
  };
  assert.equal(await responsePredicate(partialResponse), false);
  responseGate.reject(new Error('timeout'));
  await rejection;
});

test('uploadImages recognizes first-frame persistence in KeyFrameImages', async () => {
  const responseGate = deferred();
  let responsePredicate;
  const page = {
    waitForResponse: (predicate) => {
      responsePredicate = predicate;
      return responseGate.promise;
    },
  };
  const root = { $: async () => ({ uploadFile: async () => {} }) };
  const pending = uploadImages(page, ['first-frame.png'], root);
  await new Promise(setImmediate);
  const response = {
    url: () => 'https://work.xiaomaomi.cn/proxy/api/v1/shot/update',
    request: () => ({
      method: () => 'POST',
      postData: () => JSON.stringify({
        Shot: { VideoMeta: { RefImages: [], KeyFrameImages: { HeadImage: { Key: 'head.png' } } } },
      }),
    }),
    ok: () => true,
  };

  assert.equal(await responsePredicate(response), true);
  responseGate.resolve(response);
  await pending;
});

test('uploadImages immediately returns ark asset validation errors wrapped in HTTP 200', async () => {
  const responseGate = deferred();
  let responsePredicate;
  const page = {
    waitForResponse: (predicate) => {
      responsePredicate = predicate;
      return responseGate.promise;
    },
  };
  const root = { $: async () => ({ uploadFile: async () => {} }) };
  const pending = uploadImages(page, ['short.png'], root, { timeoutMs: 120000 });
  const rejection = assert.rejects(
    pending,
    /参考图素材创建失败 InvalidParameter\.HeightTooSmall: Height must be between 300px and 6000px\./,
  );
  await new Promise(setImmediate);

  const errorResponse = {
    url: () => 'https://work.xiaomaomi.cn/proxy/api/v1/asset/ark_asset/create',
    request: () => ({ method: () => 'POST' }),
    status: () => 200,
    ok: () => true,
    json: async () => ({
      ResponseMetadata: {
        Error: {
          Code: 'InvalidParameter.HeightTooSmall',
          Message: 'Height must be between 300px and 6000px.',
        },
      },
    }),
  };
  assert.equal(await responsePredicate(errorResponse), true);
  responseGate.resolve(errorResponse);
  await rejection;
});

test('video options use a duration button when image-to-video mode has no duration input', async () => {
  const evaluatedTargets = [];
  const page = {
    evaluate: async (_callback, target) => {
      if (target === undefined) return null;
      evaluatedTargets.push(target);
      if (target === '10s' || target === '720p' || target === 'mp4') {
        return { panel: true, clicked: true, targetText: target };
      }
      return null;
    },
    keyboard: { press: async () => {} },
  };
  const root = { evaluate: async () => true };

  const result = await setVideoOptionsOnce(page, {
    duration: 10,
    resolution: '720p',
    output_format: 'mp4',
  }, root);

  assert.deepEqual(evaluatedTargets, ['10s', '720p', 'mp4']);
  assert.equal(result.duration.clicked, true);
});

test('image-to-video accepts a hidden default mp4 control but reference mode remains strict', () => {
  const summary = { panel: true, duration: '10', resolution: '720p', outputFormat: '' };
  const request = { duration: 10, resolution: '720p', output_format: 'mp4', image_type: 'image_to_video' };

  assert.equal(videoConfigMatches(summary, request), true);
  assert.equal(videoConfigMatches(summary, { ...request, image_type: 'reference_image' }), false);
  assert.equal(videoConfigMatches(summary, { ...request, output_format: 'mov' }), false);
});

test('image-to-video accepts hidden default resolution and format controls', () => {
  const summary = { panel: true, duration: '10', resolution: '', outputFormat: '' };
  const request = { duration: 10, resolution: '720p', output_format: 'mp4', image_type: 'image_to_video' };

  assert.equal(videoConfigMatches(summary, request), true);
  assert.equal(videoConfigMatches(summary, { ...request, image_type: 'reference_image' }), false);
});

function project(overrides = {}) {
  return {
    ProjectId: 'project-default',
    ScriptId: 'script-default',
    TeamId: 'team-1',
    ProjectName: 'other',
    CreatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function episode(EpisodeId, CreatedAt) {
  return { EpisodeId, CreatedAt };
}

function fakeEpisodeApi(listPages) {
  const calls = [];
  return {
    calls,
    api: {
      sleep: async () => {},
      post: async (requestPath, body) => {
        calls.push({ requestPath, body });
        if (requestPath.endsWith('/episode/list')) return listPages[body.PageIndex - 1] ?? { Result: { Items: [] } };
        if (requestPath.endsWith('/episode/create')) return { Result: { EpisodeId: 'episode-new' } };
        if (requestPath.endsWith('/shot/list')) return { Result: { Items: [{ ShotId: 'shot-new' }] } };
        throw new Error(`unexpected API call: ${requestPath}`);
      },
    },
  };
}

test('project on the second page is reused without calling create', async () => {
  const calls = [];
  const projectName = '2026-09-10-16:9';
  const result = await ensureProjectForRatioApi({
    teamId: 'team-1',
    projectDate: '2026-09-10',
    ratio: '16:9',
    pageSize: 2,
    api: {
      post: async (requestPath, body) => {
        calls.push({ requestPath, body });
        assert.equal(requestPath, '/proxy/api/v1/project/list');
        if (body.PageIndex === 1) return { Result: { Items: [project(), project({ ProjectId: 'project-2' })], Total: 3 } };
        return { Result: { Items: [project({ ProjectId: 'project-target', ScriptId: 'script-target', ProjectName: projectName })], Total: 3 } };
      },
    },
  });

  assert.equal(result.action, 'exists');
  assert.equal(result.projectId, 'project-target');
  assert.deepEqual(calls.map((call) => call.body.PageIndex), [1, 2]);
});

test('project pagination follows a known total even when each page is shorter than requested', async () => {
  const calls = [];
  const projectName = '2026-09-10-4:3';
  const result = await ensureProjectForRatioApi({
    teamId: 'team-1',
    projectDate: '2026-09-10',
    ratio: '4:3',
    pageSize: 5,
    api: {
      post: async (requestPath, body) => {
        calls.push({ requestPath, body });
        assert.equal(requestPath, '/proxy/api/v1/project/list');
        if (body.PageIndex === 1) return { Result: { Items: [project()], TotalCount: 2 } };
        return { Result: { Items: [project({ ProjectId: 'project-target', ProjectName: projectName })], TotalCount: 2 } };
      },
    },
  });

  assert.equal(result.projectId, 'project-target');
  assert.deepEqual(calls.map((call) => call.body.PageIndex), [1, 2]);
});

test('project pagination keeps the largest known total when a later page reports a smaller total', async () => {
  const calls = [];
  const projectName = '2026-09-10-3:2';
  const pages = [
    { Result: { Items: [project({ ProjectId: 'project-1' })], Total: 3 } },
    { Result: { Items: [project({ ProjectId: 'project-2' })], Total: 2 } },
    { Result: { Items: [project({ ProjectId: 'project-target', ProjectName: projectName })], Total: 2 } },
  ];
  const result = await ensureProjectForRatioApi({
    teamId: 'team-1',
    projectDate: '2026-09-10',
    ratio: '3:2',
    pageSize: 5,
    api: {
      post: async (requestPath, body) => {
        calls.push({ requestPath, body });
        assert.equal(requestPath, '/proxy/api/v1/project/list');
        return pages[body.PageIndex - 1];
      },
    },
  });

  assert.equal(result.action, 'exists');
  assert.equal(result.projectId, 'project-target');
  assert.deepEqual(calls.map((call) => call.body.PageIndex), [1, 2, 3]);
});

test('project pagination extends the completeness boundary when a later total grows', async () => {
  const calls = [];
  const projectName = '2026-09-10-2:1';
  const pages = [
    { Result: { Items: [project({ ProjectId: 'project-1' })], Total: 2 } },
    { Result: { Items: [project({ ProjectId: 'project-2' })], Total: 3 } },
    { Result: { Items: [project({ ProjectId: 'project-target', ProjectName: projectName })], Total: 3 } },
  ];
  const result = await ensureProjectForRatioApi({
    teamId: 'team-1',
    projectDate: '2026-09-10',
    ratio: '2:1',
    pageSize: 5,
    api: {
      post: async (requestPath, body) => {
        calls.push({ requestPath, body });
        assert.equal(requestPath, '/proxy/api/v1/project/list');
        return pages[body.PageIndex - 1];
      },
    },
  });

  assert.equal(result.projectId, 'project-target');
  assert.deepEqual(calls.map((call) => call.body.PageIndex), [1, 2, 3]);
});

test('project pagination rejects two full pages with the same ID before known total two is reached', async () => {
  let listCalls = 0;
  const repeated = { Result: { Items: [project()], Total: 2 } };
  await assert.rejects(ensureProjectForRatioApi({
    teamId: 'team-1',
    projectDate: '2026-09-10',
    ratio: '1:1',
    pageSize: 1,
    api: {
      post: async (requestPath) => {
        assert.equal(requestPath, '/proxy/api/v1/project/list');
        listCalls += 1;
        return repeated;
      },
    },
  }), /项目分页.*没有新增/);
  assert.equal(listCalls, 2);
});

test('project pagination continues after a partially duplicate page until unique IDs reach total', async () => {
  const projectName = '2026-09-10-1:1';
  const pages = [
    { Result: { Items: [project({ ProjectId: 'project-1' }), project({ ProjectId: 'project-2' })], Total: 4 } },
    { Result: { Items: [project({ ProjectId: 'project-2' }), project({ ProjectId: 'project-3' })], Total: 4 } },
    { Result: { Items: [project({ ProjectId: 'project-target', ProjectName: projectName })], Total: 4 } },
  ];
  const calls = [];
  const result = await ensureProjectForRatioApi({
    teamId: 'team-1',
    projectDate: '2026-09-10',
    ratio: '1:1',
    pageSize: 2,
    api: {
      post: async (requestPath, body) => {
        calls.push({ requestPath, body });
        assert.equal(requestPath, '/proxy/api/v1/project/list');
        return pages[body.PageIndex - 1];
      },
    },
  });

  assert.equal(result.projectId, 'project-target');
  assert.deepEqual(calls.map((call) => call.body.PageIndex), [1, 2, 3]);
});

test('duplicate project names across pages select the newest timestamp', async () => {
  const projectName = '2026-09-10-9:16';
  const pages = [
    { Result: { Items: [
      project({ ProjectId: 'older', ProjectName: projectName, CreatedAt: '2026-09-01T00:00:00Z' }),
      project({ ProjectId: 'other' }),
    ] } },
    { Result: { Items: [
      project({ ProjectId: 'newer', ProjectName: projectName, CreatedAt: '2026-08-01T00:00:00Z', UpdatedAt: '2026-09-09T00:00:00Z' }),
    ] } },
  ];
  const result = await ensureProjectForRatioApi({
    teamId: 'team-1',
    projectDate: '2026-09-10',
    ratio: '9:16',
    pageSize: 2,
    api: {
      post: async (requestPath, body) => {
        assert.equal(requestPath, '/proxy/api/v1/project/list');
        return pages[body.PageIndex - 1];
      },
    },
  });

  assert.equal(result.projectId, 'newer');
});

test('episode pagination uses the newest episode from the second page and the complete count', async () => {
  const fake = fakeEpisodeApi([
    { Result: { Items: [episode('episode-1', '2026-09-01T00:00:00Z'), episode('episode-2', '2026-09-02T00:00:00Z')], TotalCount: 3 } },
    { Result: { Items: [episode('episode-latest', '2026-09-10T00:00:00Z')], TotalCount: 3 } },
  ]);
  const result = await createTaskEpisodeApi({
    context: { ProjectId: 'project-1', ScriptId: 'script-1', TeamId: 'team-1' },
    pageSize: 2,
    api: fake.api,
  });

  const createCall = fake.calls.find((call) => call.requestPath.endsWith('/episode/create'));
  assert.equal(createCall.body.PreviousEpisodeId, 'episode-latest');
  assert.equal(result.beforeEpisodeCount, 3);
});

test('episode pagination follows a known total through a short first page', async () => {
  const fake = fakeEpisodeApi([
    { Result: { Items: [episode('episode-1', '2026-09-01T00:00:00Z')], Total: 2 } },
    { Result: { Items: [episode('episode-2', '2026-09-02T00:00:00Z')], Total: 2 } },
  ]);
  const result = await createTaskEpisodeApi({
    context: { ProjectId: 'project-1', ScriptId: 'script-1', TeamId: 'team-1' },
    pageSize: 5,
    api: fake.api,
  });

  assert.equal(result.beforeEpisodeCount, 2);
  assert.deepEqual(
    fake.calls.filter((call) => call.requestPath.endsWith('/episode/list')).map((call) => call.body.PageIndex),
    [1, 2],
  );
});

test('episode pagination keeps the largest known total when a later page reports a smaller total', async () => {
  const fake = fakeEpisodeApi([
    { Result: { Items: [episode('episode-1', '2026-09-01T00:00:00Z')], Total: 3 } },
    { Result: { Items: [episode('episode-2', '2026-09-02T00:00:00Z')], Total: 2 } },
    { Result: { Items: [episode('episode-latest', '2026-09-10T00:00:00Z')], Total: 2 } },
  ]);
  const result = await createTaskEpisodeApi({
    context: { ProjectId: 'project-1', ScriptId: 'script-1', TeamId: 'team-1' },
    pageSize: 5,
    api: fake.api,
  });

  assert.equal(result.beforeEpisodeCount, 3);
  assert.equal(fake.calls.find((call) => call.requestPath.endsWith('/episode/create')).body.PreviousEpisodeId, 'episode-latest');
  assert.deepEqual(
    fake.calls.filter((call) => call.requestPath.endsWith('/episode/list')).map((call) => call.body.PageIndex),
    [1, 2, 3],
  );
});

test('episode pagination extends the completeness boundary when a later total grows', async () => {
  const fake = fakeEpisodeApi([
    { Result: { Items: [episode('episode-1', '2026-09-01T00:00:00Z')], Total: 2 } },
    { Result: { Items: [episode('episode-2', '2026-09-02T00:00:00Z')], Total: 3 } },
    { Result: { Items: [episode('episode-latest', '2026-09-10T00:00:00Z')], Total: 3 } },
  ]);
  const result = await createTaskEpisodeApi({
    context: { ProjectId: 'project-1', ScriptId: 'script-1', TeamId: 'team-1' },
    pageSize: 5,
    api: fake.api,
  });

  assert.equal(result.beforeEpisodeCount, 3);
  assert.equal(fake.calls.find((call) => call.requestPath.endsWith('/episode/create')).body.PreviousEpisodeId, 'episode-latest');
  assert.deepEqual(
    fake.calls.filter((call) => call.requestPath.endsWith('/episode/list')).map((call) => call.body.PageIndex),
    [1, 2, 3],
  );
});

test('episode pagination rejects two full pages with the same ID before known total two is reached', async () => {
  let listCalls = 0;
  const repeated = { Result: { Items: [episode('episode-1', '2026-09-01T00:00:00Z')], TotalCount: 2 } };
  await assert.rejects(createTaskEpisodeApi({
    context: { ProjectId: 'project-1', ScriptId: 'script-1', TeamId: 'team-1' },
    pageSize: 1,
    api: {
      post: async (requestPath) => {
        assert.equal(requestPath, '/proxy/api/v1/episode/list');
        listCalls += 1;
        return repeated;
      },
    },
  }), /集分页.*没有新增/);
  assert.equal(listCalls, 2);
});

test('episode pagination continues after a partially duplicate page until unique IDs reach total', async () => {
  const fake = fakeEpisodeApi([
    { Result: { Items: [episode('episode-1', '2026-09-01T00:00:00Z'), episode('episode-2', '2026-09-02T00:00:00Z')], Total: 4 } },
    { Result: { Items: [episode('episode-2', '2026-09-02T00:00:00Z'), episode('episode-3', '2026-09-03T00:00:00Z')], Total: 4 } },
    { Result: { Items: [episode('episode-4', '2026-09-04T00:00:00Z')], Total: 4 } },
  ]);
  const result = await createTaskEpisodeApi({
    context: { ProjectId: 'project-1', ScriptId: 'script-1', TeamId: 'team-1' },
    pageSize: 2,
    api: fake.api,
  });

  assert.equal(result.beforeEpisodeCount, 4);
  assert.equal(fake.calls.find((call) => call.requestPath.endsWith('/episode/create')).body.PreviousEpisodeId, 'episode-4');
  assert.deepEqual(
    fake.calls.filter((call) => call.requestPath.endsWith('/episode/list')).map((call) => call.body.PageIndex),
    [1, 2, 3],
  );
});

test('episode pagination deduplicates IDs repeated across changing pages', async () => {
  const fake = fakeEpisodeApi([
    { Result: { Items: [episode('episode-1', '2026-09-01T00:00:00Z'), episode('episode-2', '2026-09-02T00:00:00Z')] } },
    { Result: { Items: [episode('episode-2', '2026-09-02T00:00:00Z'), episode('episode-3', '2026-09-03T00:00:00Z')] } },
    { Result: { Items: [episode('episode-4', '2026-09-04T00:00:00Z')] } },
  ]);
  const result = await createTaskEpisodeApi({
    context: { ProjectId: 'project-1', ScriptId: 'script-1', TeamId: 'team-1' },
    pageSize: 2,
    api: fake.api,
  });

  assert.equal(result.beforeEpisodeCount, 4);
  assert.equal(fake.calls.find((call) => call.requestPath.endsWith('/episode/create')).body.PreviousEpisodeId, 'episode-4');
});

test('known total does not treat raw duplicate records as complete', async () => {
  const fake = fakeEpisodeApi([
    { Result: { Items: [episode('episode-1', '2026-09-01T00:00:00Z'), episode('episode-2', '2026-09-02T00:00:00Z')], Total: 3 } },
    { Result: { Items: [episode('episode-2', '2026-09-02T00:00:00Z')], Total: 3 } },
  ]);
  await assert.rejects(createTaskEpisodeApi({
    context: { ProjectId: 'project-1', ScriptId: 'script-1', TeamId: 'team-1' },
    pageSize: 2,
    api: fake.api,
  }), /集分页.*没有新增/);
  assert.equal(fake.calls.filter((call) => call.requestPath.endsWith('/episode/list')).length, 2);
});

test('episode anchor uses CreatedAt before a later UpdatedAt', async () => {
  const older = { ...episode('episode-old', '2026-09-01T00:00:00Z'), UpdatedAt: '2026-09-20T00:00:00Z' };
  const newer = { ...episode('episode-newer', '2026-09-10T00:00:00Z'), UpdatedAt: '2026-09-10T00:00:00Z' };
  const fake = fakeEpisodeApi([{ Result: { Items: [older, newer] } }]);
  await createTaskEpisodeApi({
    context: { ProjectId: 'project-1', ScriptId: 'script-1', TeamId: 'team-1' },
    pageSize: 5,
    api: fake.api,
  });

  assert.equal(fake.calls.find((call) => call.requestPath.endsWith('/episode/create')).body.PreviousEpisodeId, 'episode-newer');
});

test('project creation accepts lowercase result and ID fields', async () => {
  const calls = [];
  const result = await ensureProjectForRatioApi({
    teamId: 'team-1',
    projectDate: '2026-09-10',
    ratio: '3:2',
    api: {
      post: async (requestPath, body) => {
        calls.push({ requestPath, body });
        if (requestPath.endsWith('/project/list')) return { result: { items: [] } };
        if (requestPath.endsWith('/project/create')) return { result: { projectId: 'project-lower', scriptId: 'script-lower' } };
        if (body.ProjectName) return { result: {} };
        return { result: { status: 'resource_confirmed' } };
      },
    },
  });

  assert.equal(result.projectId, 'project-lower');
  assert.equal(result.scriptId, 'script-lower');
  assert.equal(result.status, 'resource_confirmed');
  assert.equal(calls.find((call) => call.requestPath.endsWith('/project/create')).body.VisualPromptId, 'realistic_modern_urban');
  assert.equal(calls.filter((call) => call.requestPath.endsWith('/project/update')).length, 2);
});

test('episode creation and shot lookup accept lowercase response and ID fields', async () => {
  const calls = [];
  const result = await createTaskEpisodeApi({
    context: { ProjectId: 'project-1', ScriptId: 'script-1', TeamId: 'team-1' },
    api: {
      sleep: async () => {},
      post: async (requestPath, body) => {
        calls.push({ requestPath, body });
        if (requestPath.endsWith('/episode/list')) {
          return { result: { items: [{ episodeId: 'episode-anchor', createdAt: '2026-09-10T00:00:00Z' }] } };
        }
        if (requestPath.endsWith('/episode/create')) return { result: { episodeId: 'episode-created' } };
        return { result: { items: [{ shotId: 'shot-created' }] } };
      },
    },
  });

  assert.equal(calls.find((call) => call.requestPath.endsWith('/episode/create')).body.PreviousEpisodeId, 'episode-anchor');
  assert.equal(result.EpisodeId, 'episode-created');
  assert.equal(result.ShotId, 'shot-created');
  assert.equal(result.beforeEpisodeCount, 1);
});

test('a server repeating the same full page fails clearly instead of looping forever', async () => {
  let listCalls = 0;
  const repeated = { Result: { Items: [episode('episode-1', '2026-09-01T00:00:00Z'), episode('episode-2', '2026-09-02T00:00:00Z')] } };
  await assert.rejects(createTaskEpisodeApi({
    context: { ProjectId: 'project-1', ScriptId: 'script-1', TeamId: 'team-1' },
    pageSize: 2,
    maxPages: 10,
    api: {
      post: async (requestPath) => {
        assert.equal(requestPath, '/proxy/api/v1/episode/list');
        listCalls += 1;
        return repeated;
      },
    },
  }), /分页.*重复|没有新增/);
  assert.equal(listCalls, 2);
});

test('pagination propagates an upstream API error', async () => {
  await assert.rejects(ensureProjectForRatioApi({
    teamId: 'team-1',
    projectDate: '2026-09-10',
    ratio: '16:9',
    pageSize: 2,
    api: {
      post: async (_requestPath, body) => {
        if (body.PageIndex === 1) return { Result: { Items: [project(), project({ ProjectId: 'project-2' })] } };
        throw new Error('upstream page 2 failed');
      },
    },
  }), /upstream page 2 failed/);
});

test('empty episode list preserves the existing anchor error', async () => {
  const fake = fakeEpisodeApi([{ Result: { Items: [] } }]);
  await assert.rejects(createTaskEpisodeApi({
    context: { ProjectId: 'project-1', ScriptId: 'script-1', TeamId: 'team-1' },
    pageSize: 2,
    api: fake.api,
  }), /当前项目没有可作为锚点的集/);
});

test('real preparation chain signals exact task IDs before deferred materialization settles', async () => {
  const events = [];
  const materializeGate = deferred();
  const project = { projectName: 'project', projectId: 'project-1' };
  const taskEpisode = { EpisodeId: 'episode-1', ShotId: 'shot-1', ProjectId: 'project-1' };
  let signalPayload;
  const pending = prepareVideoTask({
    page: {},
    request: { ratio: '16:9', images: ['image'] },
    ensureProject: async () => { events.push('project'); return project; },
    updateStatus: async () => {},
    createEpisode: async () => { events.push('episode'); return taskEpisode; },
    emitTaskStarted: (payload) => { events.push('signal'); signalPayload = payload; },
    materialize: async () => { events.push('materialize'); return materializeGate.promise; },
  });
  let settled = false;
  pending.finally(() => { settled = true; }).catch(() => {});
  await new Promise(setImmediate);

  assert.deepEqual(events, ['project', 'episode', 'signal', 'materialize']);
  assert.equal(settled, false);
  assert.equal(signalPayload.taskEpisode.EpisodeId, 'episode-1');
  assert.equal(signalPayload.taskEpisode.ShotId, 'shot-1');

  materializeGate.resolve(['image.png']);
  assert.deepEqual(await pending, { project, taskEpisode, imageFiles: ['image.png'] });
});

for (const failingStep of ['project', 'episode']) {
  test(`${failingStep} failure emits no preparation signal and does not materialize`, async () => {
    const events = [];
    await assert.rejects(prepareVideoTask({
      page: {},
      request: { ratio: '16:9', images: ['image'] },
      ensureProject: async () => {
        events.push('project');
        if (failingStep === 'project') throw new Error('project failed');
        return { projectName: 'project' };
      },
      updateStatus: async () => {},
      createEpisode: async () => {
        events.push('episode');
        throw new Error('episode failed');
      },
      emitTaskStarted: () => events.push('signal'),
      materialize: async () => { events.push('materialize'); return []; },
    }), new RegExp(`${failingStep} failed`));
    assert.deepEqual(events, failingStep === 'project' ? ['project'] : ['project', 'episode']);
  });
}

test('workflow lifecycle cleans temp resources after materialization failure', async () => {
  const h = harness({ materialize: async () => { h.calls.push('materialize'); throw new Error('materialize failed'); } });
  await assert.rejects(runVideoWorkflow(h.options), /materialize failed/);
  assert.deepEqual(h.calls, ['connect', 'createPage', 'prepare', 'materialize', 'close', 'disconnect', 'cleanup']);
});

test('workflow lifecycle disconnects after failure following connection', async () => {
  const h = harness({ createPage: async () => { h.calls.push('createPage'); throw new Error('page failed'); } });
  await assert.rejects(runVideoWorkflow(h.options), /page failed/);
  assert.deepEqual(h.calls, ['connect', 'createPage', 'disconnect', 'cleanup']);
});

test('workflow lifecycle closes a created page and disconnects after business failure', async () => {
  const h = harness({ execute: async () => { h.calls.push('execute'); throw new Error('business failed'); } });
  await assert.rejects(runVideoWorkflow(h.options), /business failed/);
  assert.deepEqual(h.calls, ['connect', 'createPage', 'prepare', 'materialize', 'execute', 'close', 'disconnect', 'cleanup']);
});

test('workflow lifecycle returns success and releases every owned resource', async () => {
  const h = harness();
  assert.equal(await runVideoWorkflow(h.options), 'result');
  assert.deepEqual(h.calls, ['connect', 'createPage', 'prepare', 'materialize', 'execute', 'close', 'disconnect', 'cleanup']);
});

test('preparation signal happens before materialization and lets another preparation start', async () => {
  const materializeGate = (() => {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
  })();
  const events = [];
  const first = harness({
    prepare: async () => { events.push('first-prepared'); },
    materialize: async () => { events.push('first-materialize'); return materializeGate.promise; },
  });
  const firstRun = runVideoWorkflow(first.options);
  while (!events.includes('first-materialize')) await new Promise(setImmediate);

  const second = harness({ prepare: async () => { events.push('second-prepared'); } });
  const secondRun = runVideoWorkflow(second.options);
  while (!events.includes('second-prepared')) await new Promise(setImmediate);
  assert.deepEqual(events, ['first-prepared', 'first-materialize', 'second-prepared']);

  materializeGate.resolve(['image']);
  await Promise.all([firstRun, secondRun]);
});

test('cleanup failures are logged without replacing the original business error', async () => {
  const logged = [];
  const h = harness({
    execute: async () => { throw new Error('original business error'); },
    createPage: async (_browser, onCreated) => {
      const page = { close: async () => { throw new Error('close failed'); } };
      onCreated(page);
      return page;
    },
    connect: async () => ({ disconnect: async () => { throw new Error('disconnect failed'); } }),
    tempImages: { cleanup: async () => { throw new Error('cleanup failed'); } },
    logError: (message) => logged.push(message),
  });
  await assert.rejects(runVideoWorkflow(h.options), /original business error/);
  assert.equal(logged.length, 3);
  assert.match(logged.join('\n'), /close failed/);
  assert.match(logged.join('\n'), /disconnect failed/);
  assert.match(logged.join('\n'), /cleanup failed/);
});

test('throwing cleanup logger neither replaces the business error nor stops later cleanup', async () => {
  const calls = [];
  await assert.rejects(runVideoWorkflow({
    materialize: async () => [],
    prepare: async () => {},
    connect: async () => ({ disconnect: async () => { calls.push('disconnect'); throw new Error('disconnect failed'); } }),
    createPage: async (_browser, onCreated) => {
      const page = { close: async () => { calls.push('close'); throw new Error('close failed'); } };
      onCreated(page);
      return page;
    },
    execute: async () => { throw new Error('original business error'); },
    tempImages: { cleanup: async () => { calls.push('cleanup'); throw new Error('cleanup failed'); } },
    logError: () => { calls.push('log'); throw new Error('logger failed'); },
  }), /original business error/);
  assert.deepEqual(calls, ['close', 'log', 'disconnect', 'log', 'cleanup', 'log']);
});

test('child workflow reuses only the page with its exact parent marker', async () => {
  const calls = [];
  const page = (name) => ({
    evaluate: async (callback, value) => value === undefined ? name : calls.push(`remark:${value}`),
    isClosed: () => false,
    goto: async () => { calls.push(`goto:${name}`); },
    waitForNetworkIdle: async () => {},
  });
  const original = page('');
  const otherTask = page('seedance-video-other');
  const ownTask = page('seedance-video-own');
  const browser = {
    pages: async () => [original, otherTask, ownTask],
    newPage: async () => { throw new Error('must not create another page'); },
  };

  const selected = await openTaskPage(browser, () => {}, { marker: 'seedance-video-own', setViewport: async () => {} });

  assert.equal(selected, ownTask);
  assert.deepEqual(calls, ['remark:seedance-video-own', 'goto:seedance-video-own', 'remark:seedance-video-own']);
});

test('child workflow fails clearly instead of borrowing another page when marker is missing', async () => {
  const browser = {
    pages: async () => [{ evaluate: async () => '' }, { evaluate: async () => 'seedance-video-other' }],
    newPage: async () => { throw new Error('must not create another page'); },
  };
  await assert.rejects(openTaskPage(browser, () => {}, { marker: 'seedance-video-missing', setViewport: async () => {} }), /没有找到父进程预创建的任务页面.*seedance-video-missing/);
});

test('manual workflow without a parent marker creates its own page', async () => {
  const calls = [];
  const page = {
    evaluate: async (_callback, marker) => { calls.push(`mark:${marker}`); },
    goto: async () => { calls.push('goto'); },
    waitForNetworkIdle: async () => {},
  };
  const browser = {
    pages: async () => { throw new Error('manual mode must not scan pages'); },
    newPage: async () => { calls.push('newPage'); return page; },
  };
  const selected = await openTaskPage(browser, () => {}, { marker: '', setViewport: async () => {} });
  assert.equal(selected, page);
  assert.equal(calls[0], 'newPage');
  assert.equal(calls.filter((call) => call.startsWith('mark:')).length, 2);
});

test('task pages always use a fixed 1920x920 viewport', async () => {
  const viewports = [];
  const page = {
    evaluate: async (_callback, marker) => marker === undefined ? { width: 800, height: 600 } : undefined,
    goto: async () => {},
    setViewport: async (viewport) => { viewports.push(viewport); },
    waitForNetworkIdle: async () => {},
  };
  const browser = {
    pages: async () => { throw new Error('manual mode must not scan pages'); },
    newPage: async () => page,
  };

  await openTaskPage(browser, () => {}, { marker: '' });

  assert.deepEqual(viewports, [{ width: 1920, height: 920 }]);
});
