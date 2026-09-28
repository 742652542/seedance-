import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCanvasVideoSession,
  normalizeCanvasVideoRequest,
  resolveCanvasVideoModel,
} from './canvas-video-session.js';

const sessionState = {
  browser: { connected: true },
  page: { isClosed: () => false },
  teamId: 'team',
  projectId: 'project',
  scriptId: 'script',
  projectName: 'shared',
  visualPromptId: 'style-default',
  url: 'https://work.test/canvas',
};

function createHarness(overrides = {}) {
  const calls = [];
  const post = async (_session, requestPath, body) => {
    calls.push({ path: requestPath, body });
    if (overrides.post) return overrides.post(requestPath, body, calls);
    if (requestPath === '/proxy/api/v1/media/add') return { Result: { MediaId: 'media-output' } };
    if (requestPath.endsWith('/create')) return { Result: { TaskIds: ['task-1'] } };
    if (requestPath.endsWith('/list')) {
      return { Result: { Videos: [{ ResourceId: 'media-output', Status: 'done', GeneratedVideos: [{ VideoUrl: 'https://cdn.test/out.mp4', VideoKey: 'out.mp4', Selected: true }] }] } };
    }
    return { Result: {} };
  };
  const videoSession = createCanvasVideoSession({
    getSession: async () => sessionState,
    post,
    pollIntervalMs: 0,
    timers: { now: () => 0, sleep: async () => {} },
    ...overrides.options,
  });
  return { calls, videoSession };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('live Seedance display names resolve to the model codes used by the canvas', () => {
  assert.equal(resolveCanvasVideoModel('Doubao-Seedance-2.5'), 'ep-20260729173114-qjxc2');
  assert.equal(resolveCanvasVideoModel('Doubao-Seedance-2-0'), 'ep-20260322113401-vj4bf');
  assert.equal(resolveCanvasVideoModel('Doubao-Seedance-2.0-fast'), 'ep-20260320142658-hscwv');
  assert.equal(resolveCanvasVideoModel('Doubao-Seedance-2.0-mini'), 'doubao-seedance-2-0-mini-260615');
  assert.equal(resolveCanvasVideoModel('Wan-3.0'), '');
});

test('reference-frame text-only request follows the current canvas payload and task-id polling shape', async () => {
  const { calls, videoSession } = createHarness();
  const result = await videoSession.runTask('task-text', {
    prompt: '云层穿过山谷',
    model: 'Doubao-Seedance-2.0-mini',
    gen_type: 'reference_frame',
    ratio: '9:16',
    duration: 4,
    resolution: '480p',
    count: 1,
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.videos[0].video_url, 'https://cdn.test/out.mp4');
  const resource = calls.find((call) => call.path === '/proxy/api/v1/media/add');
  assert.deepEqual(resource.body, {
    TeamId: 'team', ProjectId: 'project', ScriptId: 'script',
    MediaType: 'video', Source: 'canvas', SourceType: 'custom', Media: { Name: '视频生成' },
  });
  const create = calls.find((call) => call.path.endsWith('/create'));
  assert.deepEqual(create.body.VideoMeta, {
    GenType: 'reference_frame', Prompt: '云层穿过山谷',
    ModelName: 'doubao-seedance-2-0-mini-260615', Ratio: '9:16', Duration: 4,
    Resolution: '480p', Count: 1, OutputFormat: 'mp4', VisualPromptId: 'style-default',
  });
  const list = calls.find((call) => call.path.endsWith('/list'));
  assert.deepEqual(list.body.Filters, { TaskIds: ['task-1'], TaskType: ['gen_video'] });
});

test('reference-frame supports mixed pre-uploaded image and video references', async () => {
  const { calls, videoSession } = createHarness();
  await videoSession.runTask('task-mixed', {
    prompt: '跟随参考素材运动',
    model: 'Doubao-Seedance-2.5',
    images: [{ Key: 'image.png', Url: 'https://cdn.test/image.png', ArkAssetId: 'asset-image' }],
    videos: [{ Key: 'video.mp4', Url: 'https://cdn.test/video.mp4', ResourceId: 'media-ref', Duration: 4.096 }],
  });
  const meta = calls.find((call) => call.path.endsWith('/create')).body.VideoMeta;
  assert.deepEqual(meta.RefImages, [{ Key: 'image.png', Url: 'https://cdn.test/image.png', ArkAssetId: 'asset-image' }]);
  assert.deepEqual(meta.RefVideos, [{ Key: 'video.mp4', Url: 'https://cdn.test/video.mp4', ResourceId: 'media-ref', Duration: 4.096 }]);
});

test('uploaded reference image creates a team Ark asset and sends its API ID in RefImages', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-video-ark-asset-test-'));
  const { calls, videoSession } = createHarness({
    options: {
      tempRoot,
      fetch: async () => new Response('', { status: 200 }),
    },
    post: async (requestPath, body) => {
      if (requestPath === '/proxy/api/v1/file/upload') {
        return { Result: { UploadInfos: [{
          Url: 'https://upload.test/reference.jpg',
          DownloadTosUrl: 'https://cdn.test/reference.jpg',
          TosKey: 'reference-key',
        }] } };
      }
      if (requestPath === '/proxy/api/v1/accessa/DescribeUser') return { Result: { ArkAssetGroupID: 'group-current-account' } };
      if (requestPath === '/proxy/api/v1/asset/ark_asset/create') return { Result: { ArkAssetID: 'asset-created-by-api' } };
      if (requestPath === '/proxy/api/v1/image/add') return { Result: { ImageId: 'image-reference' } };
      if (requestPath === '/proxy/api/v1/image/list') return { Result: { Items: [{ ImageId: 'image-reference', ImageInfo: {} }] } };
      if (requestPath === '/proxy/api/v1/media/add') return { Result: { MediaId: 'media-output' } };
      if (requestPath.endsWith('/create')) return { Result: { TaskIds: ['task-1'] } };
      if (requestPath.endsWith('/list')) return { Result: { Videos: [{ ResourceId: 'media-output', Status: 'done', GeneratedVideos: [] }] } };
      return { Result: {} };
    },
  });
  try {
    await videoSession.runTask('task-uploaded-image', {
      prompt: '替换链子', model: 'Doubao-Seedance-2.0-mini',
      images: [{ image_url: 'data:image/jpeg;base64,aW1hZ2U=', title: '参考图' }],
    });
    const asset = calls.find((call) => call.path === '/proxy/api/v1/asset/ark_asset/create');
    assert.deepEqual(asset.body, {
      ArkAssetGroupID: 'group-current-account',
      Owner: { Id: 'team', Type: 'team' },
      Url: 'https://cdn.test/reference.jpg',
    });
    const meta = calls.find((call) => call.path === '/proxy/api/v1/tasks/video_gen/create').body.VideoMeta;
    assert.deepEqual(meta.RefImages, [{
      Key: 'reference-key', Url: 'https://cdn.test/reference.jpg', ArkAssetId: 'asset-created-by-api', Description: '参考图',
    }]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('multiple canvas video tasks submit concurrently and poll by independent task IDs', async () => {
  const pollGate = deferred();
  let resourceSequence = 0;
  const createdTaskIds = [];
  const harness = createHarness({
    post: async (requestPath, body) => {
      if (requestPath === '/proxy/api/v1/media/add') {
        resourceSequence += 1;
        return { Result: { MediaId: `media-${resourceSequence}` } };
      }
      if (requestPath.endsWith('/create')) {
        const taskId = `upstream-${body.ResourceId}`;
        createdTaskIds.push(taskId);
        return { Result: { TaskIds: [taskId] } };
      }
      if (requestPath.endsWith('/list')) {
        await pollGate.promise;
        const taskId = body.Filters.TaskIds[0];
        const resourceId = taskId.replace('upstream-', '');
        return { Result: { Videos: [{ ResourceId: resourceId, Status: 'done', GeneratedVideos: [{ VideoUrl: `https://cdn.test/${resourceId}.mp4` }] }] } };
      }
      return { Result: {} };
    },
  });

  const first = harness.videoSession.runTask('local-1', { prompt: 'first', model: 'Doubao-Seedance-2-0' });
  const second = harness.videoSession.runTask('local-2', { prompt: 'second', model: 'Doubao-Seedance-2-0' });
  while (createdTaskIds.length < 2) await new Promise(setImmediate);
  assert.deepEqual(new Set(createdTaskIds), new Set(['upstream-media-1', 'upstream-media-2']));
  pollGate.resolve();

  const results = await Promise.all([first, second]);
  assert.deepEqual(new Set(results.map((result) => result.resourceId)), new Set(['media-1', 'media-2']));
  const filters = harness.calls.filter((call) => call.path.endsWith('/list')).map((call) => call.body.Filters.TaskIds[0]);
  assert.deepEqual(new Set(filters), new Set(['upstream-media-1', 'upstream-media-2']));
});

test('head-tail mode sends only key and optional ArkAssetId and rejects video references before writes', async () => {
  const { calls, videoSession } = createHarness();
  await videoSession.runTask('task-head-tail', {
    prompt: '从白天过渡到夜晚',
    model: 'Doubao-Seedance-2-0',
    gen_type: 'head_tail_frame',
    images: [
      { Key: 'head.png', Url: 'https://cdn.test/head.png', ArkAssetId: 'asset-head' },
      { Key: 'tail.png', Url: 'https://cdn.test/tail.png' },
    ],
  });
  const meta = calls.find((call) => call.path.endsWith('/create')).body.VideoMeta;
  assert.equal(meta.Prompt, undefined);
  assert.equal(meta.KeyFramePrompt, '从白天过渡到夜晚');
  assert.deepEqual(meta.KeyFrameImages, {
    HeadImage: { Key: 'head.png', ArkAssetId: 'asset-head' },
    TailImage: { Key: 'tail.png' },
  });
  assert.equal(meta.RefVideos, undefined);

  const rejected = createHarness();
  await assert.rejects(rejected.videoSession.runTask('task-invalid', {
    prompt: 'invalid', model: 'Doubao-Seedance-2-0', gen_type: 'head_tail_frame',
    images: [{ Key: 'head.png', Url: 'https://cdn.test/head.png' }],
    videos: [{ Key: 'video.mp4', Url: 'https://cdn.test/video.mp4', ResourceId: 'media-ref' }],
  }), /首尾帧模式不支持参考视频/);
  assert.equal(rejected.calls.length, 0);
});

test('local video upload is registered with the exact canvas media shape', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-video-test-'));
  const calls = [];
  let uploadRequest;
  const post = async (_session, requestPath, body) => {
    calls.push({ path: requestPath, body });
    if (requestPath === '/proxy/api/v1/file/upload') return { Result: { UploadInfos: [{ Url: 'https://upload.test/video', TosKey: 'uploaded.mp4', DownloadTosUrl: 'https://cdn.test/uploaded.mp4' }] } };
    if (requestPath === '/proxy/api/v1/media/add' && body.VideoFile) return { Result: { MediaId: 'media-ref' } };
    if (requestPath === '/proxy/api/v1/media/add') return { Result: { MediaId: 'media-output' } };
    if (requestPath.endsWith('/create')) return { Result: { TaskIds: ['task-1'] } };
    if (requestPath.endsWith('/list')) return { Result: { Videos: [{ ResourceId: 'media-output', Status: 'done', GeneratedVideos: [] }] } };
    return { Result: {} };
  };
  const videoSession = createCanvasVideoSession({
    getSession: async () => sessionState,
    post,
    tempRoot,
    fetch: async (_url, request) => {
      uploadRequest = request;
      const chunks = [];
      for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
      assert.equal(Buffer.concat(chunks).toString(), 'video');
      return new Response('', { status: 200 });
    },
    pollIntervalMs: 0,
    timers: { now: () => 0, sleep: async () => {} },
  });
  try {
    await videoSession.runTask('task-upload', {
      prompt: 'video ref', model: 'Doubao-Seedance-2.0-fast',
      videos: [{ video_url: 'data:video/mp4;base64,dmlkZW8=', title: '参考视频', duration: 1 }],
    });
    const add = calls.find((call) => call.path === '/proxy/api/v1/media/add' && call.body.VideoFile);
    assert.deepEqual(add.body, {
      TeamId: 'team', ProjectId: 'project', ScriptId: 'script', Source: 'canvas',
      SourceType: 'custom', MediaType: 'video', Media: { Name: '参考视频' },
      VideoFile: { VideoKey: 'uploaded.mp4', VideoTitle: '参考视频' }, Category: 'video',
    });
    assert.equal(uploadRequest.duplex, 'half');
    assert.equal(uploadRequest.headers['content-length'], '5');
    assert.equal(Buffer.isBuffer(uploadRequest.body), false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('remote video download streams to disk and stops as soon as the byte limit is exceeded', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-video-stream-limit-test-'));
  let uploadRequested = false;
  const videoSession = createCanvasVideoSession({
    getSession: async () => sessionState,
    tempRoot,
    maxVideoBytes: 5,
    fetch: async (_url, request = {}) => {
      if (request.method === 'PUT') {
        uploadRequested = true;
        return new Response('', { status: 200 });
      }
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('1234'));
          controller.enqueue(Buffer.from('5678'));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'video/mp4' } });
    },
    post: async () => { throw new Error('download failure must happen before upload APIs'); },
  });
  try {
    await assert.rejects(videoSession.runTask('task-stream-limit', {
      prompt: 'video ref', model: 'Doubao-Seedance-2.0-fast',
      videos: ['https://cdn.test/oversized.mp4'],
    }), /下载文件超过大小限制/);
    assert.equal(uploadRequested, false);
    assert.deepEqual(await fs.readdir(tempRoot), []);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('media transfer concurrency limits simultaneous streaming uploads across one session', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-video-stream-concurrency-test-'));
  let activeUploads = 0;
  let maximumUploads = 0;
  let uploadSequence = 0;
  let referenceSequence = 0;
  const post = async (_session, requestPath, body) => {
    if (requestPath === '/proxy/api/v1/file/upload') {
      uploadSequence += 1;
      return { Result: { UploadInfos: [{
        Url: `https://upload.test/video-${uploadSequence}`,
        TosKey: `uploaded-${uploadSequence}.mp4`,
        DownloadTosUrl: `https://cdn.test/uploaded-${uploadSequence}.mp4`,
      }] } };
    }
    if (requestPath === '/proxy/api/v1/media/add' && body.VideoFile) {
      referenceSequence += 1;
      return { Result: { MediaId: `media-ref-${referenceSequence}` } };
    }
    if (requestPath === '/proxy/api/v1/media/add') return { Result: { MediaId: 'media-output' } };
    if (requestPath.endsWith('/create')) return { Result: { TaskIds: ['task-1'] } };
    if (requestPath.endsWith('/list')) {
      return { Result: { Videos: [{ ResourceId: 'media-output', Status: 'done', GeneratedVideos: [] }] } };
    }
    return { Result: {} };
  };
  const videoSession = createCanvasVideoSession({
    getSession: async () => sessionState,
    post,
    tempRoot,
    mediaTransferConcurrency: 2,
    fetch: async (_url, request) => {
      activeUploads += 1;
      maximumUploads = Math.max(maximumUploads, activeUploads);
      for await (const _chunk of request.body) { /* consume the file stream */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeUploads -= 1;
      return new Response('', { status: 200 });
    },
    pollIntervalMs: 0,
    timers: { now: () => 0, sleep: async () => {} },
  });
  try {
    await videoSession.runTask('task-stream-concurrency', {
      prompt: 'video refs', model: 'Doubao-Seedance-2.0-fast',
      videos: Array.from({ length: 5 }, (_, index) => ({
        video_url: `data:video/mp4;base64,${Buffer.from(`video-${index}`).toString('base64')}`,
      })),
    });
    assert.equal(maximumUploads, 2);
    assert.equal(activeUploads, 0);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('normalization keeps only supported canvas modes and defaults to the live default Seedance model', () => {
  const normalized = normalizeCanvasVideoRequest({ prompt: 'x' });
  assert.equal(normalized.model, 'ep-20260322113401-vj4bf');
  assert.equal(normalized.genType, 'reference_frame');
});
