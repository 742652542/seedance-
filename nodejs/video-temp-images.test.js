import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createVideoTempImages, cleanupAbandonedVideoTempDirs, materializeVideoImages } from './video-temp-images.js';

async function temporaryRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('two tasks materialize index zero data URLs into distinct task directories with correct content', async () => {
  const root = await temporaryRoot('video-temp-images-');
  const firstId = 'dramart-20260910000000-aaaaa';
  const secondId = 'dramart-20260910000000-bbbbb';
  const first = createVideoTempImages({ taskId: firstId, tempRoot: root });
  const second = createVideoTempImages({ taskId: secondId, tempRoot: root });
  try {
    const firstImage = await first.materialize('data:image/png;base64,Zmlyc3Q=', 0);
    const secondImage = await second.materialize('data:image/png;base64,c2Vjb25k', 0);
    assert.notEqual(firstImage.path, secondImage.path);
    assert.equal(path.dirname(firstImage.path), path.join(root, firstId));
    assert.equal(path.dirname(secondImage.path), path.join(root, secondId));
    assert.match(path.basename(firstImage.path), /^0-[0-9a-f-]+\.png$/);
    assert.equal(await fs.readFile(firstImage.path, 'utf8'), 'first');
    assert.equal(await fs.readFile(secondImage.path, 'utf8'), 'second');
    assert.equal(firstImage.callerOwned, false);
  } finally {
    await Promise.all([first.cleanup(), second.cleanup()]);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('one task can materialize multiple generated images concurrently', async () => {
  const root = await temporaryRoot('video-temp-concurrent-');
  const images = createVideoTempImages({ taskId: 'dramart-20260910000000-sssss', tempRoot: root });
  try {
    const generated = await materializeVideoImages(images, [
      'data:image/png;base64,b25l',
      'data:image/png;base64,dHdv',
    ], (value) => value);
    assert.equal(generated.length, 2);
    assert.deepEqual(await Promise.all(generated.map((file) => fs.readFile(file, 'utf8'))), ['one', 'two']);
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('caller-owned local paths are returned unchanged and survive cleanup', async () => {
  const root = await temporaryRoot('video-temp-local-');
  const localPath = path.join(root, 'caller.png');
  await fs.writeFile(localPath, 'caller');
  const images = createVideoTempImages({ taskId: 'dramart-20260910000000-ccccc', tempRoot: path.join(root, 'temp') });
  const materialized = await images.materialize(localPath, 0);
  assert.deepEqual(materialized, { path: localPath, callerOwned: true });
  await images.cleanup();
  assert.equal(await fs.readFile(localPath, 'utf8'), 'caller');
  await fs.rm(root, { recursive: true, force: true });
});

test('fake HTTP fetch writes response bytes and reports failed downloads', async () => {
  const root = await temporaryRoot('video-temp-http-');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/bad')) return { ok: false, status: 503, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    return new Response(Buffer.from('remote'), { headers: { 'content-type': 'image/webp' } });
  };
  const images = createVideoTempImages({ taskId: 'dramart-20260910000000-ddddd', tempRoot: root, fetchImpl });
  try {
    const image = await images.materialize('https://example.test/good', 1);
    assert.equal(await fs.readFile(image.path, 'utf8'), 'remote');
    assert.match(image.path, /\.webp$/);
    await assert.rejects(images.materialize('https://example.test/bad', 2), /下载图片失败 HTTP 503/);
    assert.deepEqual(calls, ['https://example.test/good', 'https://example.test/bad']);
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('HTTP error cancels its response body and cancellation failure cannot replace status error', async () => {
  const root = await temporaryRoot('video-temp-http-error-body-');
  let cancelCalls = 0;
  const images = createVideoTempImages({
    taskId: 'dramart-20260910000000-uuuuu',
    tempRoot: root,
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      body: { cancel: async () => { cancelCalls += 1; throw new Error('cancel failed'); } },
    }),
  });
  try {
    await assert.rejects(images.materialize('https://example.test/unavailable', 0), /下载图片失败 HTTP 503/);
    assert.equal(cancelCalls, 1);
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function streamingResponse(chunks, headers = {}) {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      controller.close();
    },
    cancel() { cancelled = true; },
  });
  return {
    response: new Response(body, { headers }),
    wasCancelled: () => cancelled,
  };
}

test('HTTP streaming enforces actual bytes without Content-Length and with a falsely small length', async () => {
  const root = await temporaryRoot('video-temp-stream-limit-');
  const responses = [
    streamingResponse(['123', '456']),
    streamingResponse(['123', '456'], { 'content-length': '1' }),
  ];
  const images = createVideoTempImages({
    taskId: 'dramart-20260910000000-nnnnn',
    tempRoot: root,
    maxImageBytes: 5,
    fetchImpl: async () => responses.shift().response,
  });
  try {
    await assert.rejects(images.materialize('https://example.test/no-length', 0), /超过大小限制 5 字节/);
    await assert.rejects(images.materialize('https://example.test/false-length', 1), /超过大小限制 5 字节/);
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('chunked HTTP over-limit download cancels its body', async () => {
  const root = await temporaryRoot('video-temp-chunk-limit-');
  let cancelled = false;
  const chunks = ['12', '34', '56', '78'];
  const streamed = {
    response: new Response(new ReadableStream({
      pull(controller) { controller.enqueue(Buffer.from(chunks.shift())); },
      cancel() { cancelled = true; },
    })),
    wasCancelled: () => cancelled,
  };
  const images = createVideoTempImages({
    taskId: 'dramart-20260910000000-ooooo',
    tempRoot: root,
    maxImageBytes: 5,
    fetchImpl: async () => streamed.response,
  });
  try {
    await assert.rejects(images.materialize('https://example.test/chunked', 0), /超过大小限制 5 字节/);
    assert.equal(streamed.wasCancelled(), true);
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('HTTP timeout aborts fake fetch and reports a clear timeout', async () => {
  const root = await temporaryRoot('video-temp-timeout-');
  let aborted = false;
  const images = createVideoTempImages({
    taskId: 'dramart-20260910000000-ppppp',
    tempRoot: root,
    downloadTimeoutMs: 10,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  try {
    await assert.rejects(images.materialize('https://example.test/slow', 0), /下载图片超时 \(10ms\)/);
    assert.equal(aborted, true);
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('HTTP timeout cancels a response body that stalls after fetch resolves', async () => {
  const root = await temporaryRoot('video-temp-body-timeout-');
  let cancelled = false;
  const body = new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; },
  });
  const images = createVideoTempImages({
    taskId: 'dramart-20260910000000-ttttt',
    tempRoot: root,
    downloadTimeoutMs: 10,
    fetchImpl: async () => new Response(body),
  });
  try {
    await assert.rejects(images.materialize('https://example.test/stalled-body', 0), /下载图片超时 \(10ms\)/);
    assert.equal(cancelled, true);
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('exclusive generated writes preserve collisions and retry with a new name', async () => {
  const root = await temporaryRoot('video-temp-exclusive-');
  const id = 'dramart-20260910000000-qqqqq';
  const taskDir = path.join(root, id);
  await fs.mkdir(taskDir);
  await fs.writeFile(path.join(taskDir, '0-collision.png'), 'original');
  const names = ['collision', 'replacement'];
  const images = createVideoTempImages({ taskId: id, tempRoot: root, randomName: () => names.shift() });
  try {
    const generated = await images.materialize('bmV3', 0);
    assert.equal(path.basename(generated.path), '0-replacement.png');
    assert.equal(await fs.readFile(path.join(taskDir, '0-collision.png'), 'utf8'), 'original');
    assert.equal(await fs.readFile(generated.path, 'utf8'), 'new');
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task directory junction is never followed for writes or recursive cleanup', async (t) => {
  const root = await temporaryRoot('video-temp-link-root-');
  const outside = await temporaryRoot('video-temp-link-outside-');
  const id = 'dramart-20260910000000-rrrrr';
  const link = path.join(root, id);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'outside');
  try {
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    await Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]);
    t.skip(`当前平台无法创建目录链接: ${error.code || error}`);
    return;
  }
  const images = createVideoTempImages({ taskId: id, tempRoot: root });
  await assert.rejects(images.materialize('bmV3', 0), /任务临时目录.*链接|不安全/);
  await images.cleanup();
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside');
  await assert.rejects(fs.lstat(link), { code: 'ENOENT' });
  await Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]);
});

test('materialization waits for a delayed success before rejecting a fast failure so cleanup cannot be undone', async () => {
  const root = await temporaryRoot('video-temp-race-');
  let releaseSlow;
  let slowSettled = false;
  const slowResponse = new Promise((resolve) => { releaseSlow = resolve; });
  const images = createVideoTempImages({
    taskId: 'dramart-20260910000000-mmmmm',
    tempRoot: root,
    fetchImpl: async (url) => {
      if (url.endsWith('/fast-failure')) return { ok: false, status: 500 };
      await slowResponse;
      slowSettled = true;
      return new Response(Buffer.from('slow success'), { headers: { 'content-type': 'image/png' } });
    },
  });
  const pending = materializeVideoImages(images, [
    'https://example.test/fast-failure',
    'https://example.test/slow-success',
  ], (value) => value);
  let rejected = false;
  pending.catch(() => { rejected = true; });
  await new Promise(setImmediate);
  assert.equal(rejected, false);
  releaseSlow();
  await assert.rejects(pending, /下载图片失败 HTTP 500/);
  assert.equal(slowSettled, true);
  await images.cleanup();
  await new Promise(setImmediate);
  await assert.rejects(fs.access(images.taskDir), { code: 'ENOENT' });
  await fs.rm(root, { recursive: true, force: true });
});

test('unsupported data URLs retain their explicit error and invalid task IDs are rejected', async () => {
  const root = await temporaryRoot('video-temp-invalid-');
  assert.throws(() => createVideoTempImages({ taskId: '../escape', tempRoot: root }), /非法任务 ID/);
  const images = createVideoTempImages({ taskId: 'dramart-20260910000000-eeeee', tempRoot: root });
  await assert.rejects(images.materialize('data:image/png,not-base64', 0), /不支持的 data URL 图片格式/);
  await images.cleanup();
  await fs.rm(root, { recursive: true, force: true });
});

test('data URL and raw base64 reject obvious over-limit input before decoding', async () => {
  const root = await temporaryRoot('video-temp-base64-limit-');
  const images = createVideoTempImages({ taskId: 'dramart-20260910000000-xxxxx', tempRoot: root, maxImageBytes: 4 });
  try {
    await assert.rejects(images.materialize('data:image/png;base64,MTIzNDU=', 0), /大小限制 4 字节/);
    await assert.rejects(images.materialize('MTIzNDU=', 1), /大小限制 4 字节/);
    await assert.rejects(fs.access(images.taskDir), { code: 'ENOENT' });
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('data URL and raw base64 accept decoded content at the byte limit', async () => {
  const root = await temporaryRoot('video-temp-base64-boundary-');
  const images = createVideoTempImages({ taskId: 'dramart-20260910000000-yyyyy', tempRoot: root, maxImageBytes: 5 });
  try {
    const [dataUrl, raw] = await Promise.all([
      images.materialize('data:image/png;base64,MTIzNDU=', 0),
      images.materialize('MTIzNDU=', 1),
    ]);
    assert.equal((await fs.readFile(dataUrl.path)).length, 5);
    assert.equal((await fs.readFile(raw.path)).length, 5);
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('data URL and raw base64 reject invalid alphabets, padding, and non-canonical encodings', async () => {
  const root = await temporaryRoot('video-temp-base64-strict-');
  const images = createVideoTempImages({ taskId: 'dramart-20260910000000-ababa', tempRoot: root });
  try {
    for (const value of ['aW1hZ2U$', 'aW=1', 'aW1hZ2U===', 'aW1hZ2U', 'ZE==']) {
      await assert.rejects(images.materialize(value, 0), /base64 图片格式不正确/);
      await assert.rejects(images.materialize(`data:image/png;base64,${value}`, 1), /data URL 图片格式不正确/);
    }
    await assert.rejects(fs.access(images.taskDir), { code: 'ENOENT' });
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('data URL and raw base64 allow ASCII whitespace and valid slash characters', async () => {
  const root = await temporaryRoot('video-temp-base64-whitespace-');
  const images = createVideoTempImages({ taskId: 'dramart-20260910000000-acaca', tempRoot: root });
  try {
    const [raw, dataUrl] = await Promise.all([
      images.materialize(' /w==\r\n', 0),
      images.materialize('data:image/png;base64,/w\n==', 1),
    ]);
    assert.deepEqual(await fs.readFile(raw.path), Buffer.from([255]));
    assert.deepEqual(await fs.readFile(dataUrl.path), Buffer.from([255]));
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('slash-heavy canonical base64 is decoded before considering forward-slash UNC paths', async () => {
  const root = await temporaryRoot('video-temp-base64-slashes-');
  const images = createVideoTempImages({ taskId: 'dramart-20260910000000-afafa', tempRoot: root });
  try {
    const [padded, allSlashes] = await Promise.all([
      images.materialize('//8=', 0),
      images.materialize('////', 1),
    ]);
    assert.deepEqual(await fs.readFile(padded.path), Buffer.from([255, 255]));
    assert.deepEqual(await fs.readFile(allSlashes.path), Buffer.from([255, 255, 255]));
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('raw base64 and data URL payloads reject leading or trailing Unicode whitespace', async () => {
  const root = await temporaryRoot('video-temp-base64-unicode-whitespace-');
  const images = createVideoTempImages({ taskId: 'dramart-20260910000000-agaga', tempRoot: root });
  try {
    for (const whitespace of ['\u00a0', '\ufeff', '\v']) {
      await assert.rejects(images.materialize(`${whitespace}/w==`, 0), /base64 图片格式不正确/);
      await assert.rejects(images.materialize(`/w==${whitespace}`, 1), /base64 图片格式不正确/);
      await assert.rejects(images.materialize(`data:image/png;base64,${whitespace}/w==`, 2), /data URL 图片格式不正确/);
      await assert.rejects(images.materialize(`data:image/png;base64,/w==${whitespace}`, 3), /data URL 图片格式不正确/);
    }
    await assert.rejects(fs.access(images.taskDir), { code: 'ENOENT' });
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('empty image remains optional but non-empty ASCII whitespace is not valid base64', async () => {
  const root = await temporaryRoot('video-temp-base64-empty-');
  const images = createVideoTempImages({ taskId: 'dramart-20260910000000-ahaha', tempRoot: root });
  try {
    assert.equal(await images.materialize('', 0), null);
    await assert.rejects(images.materialize('\t\r\n ', 1), /base64 图片格式不正确/);
    await assert.rejects(images.materialize('data:image/png;base64,\t\r\n ', 2), /data URL 图片格式不正确/);
    await assert.rejects(images.materialize('data:image/png;base64,', 3), /data URL 图片格式不正确/);
    await assert.rejects(fs.access(images.taskDir), { code: 'ENOENT' });
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('missing local image paths report a file error instead of falling back to base64', async () => {
  const root = await temporaryRoot('video-temp-missing-path-');
  const images = createVideoTempImages({ taskId: 'dramart-20260910000000-adada', tempRoot: root });
  try {
    for (const value of ['C:\\missing\\photo.png', 'folder\\missing', '\\\\server\\share\\photo.jpg', '//server/share/folder', './missing.webp', '../missing.gif', 'missing.bmp']) {
      await assert.rejects(images.materialize(value, 0), /图片文件不存在/);
    }
    await assert.rejects(fs.access(images.taskDir), { code: 'ENOENT' });
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('oversized malformed base64 is rejected by estimation before format validation', async () => {
  const root = await temporaryRoot('video-temp-base64-estimate-first-');
  const images = createVideoTempImages({ taskId: 'dramart-20260910000000-aeaea', tempRoot: root, maxImageBytes: 2 });
  try {
    await assert.rejects(images.materialize('!!!!', 0), /大小限制 2 字节/);
    await assert.rejects(images.materialize('data:image/png;base64,!!!!', 1), /大小限制 2 字节/);
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('download timeout settles even when body cancellation never settles', async () => {
  const root = await temporaryRoot('video-temp-stuck-cancel-');
  let cancelCalls = 0;
  const body = {
    cancel: () => { cancelCalls += 1; return new Promise(() => {}); },
    getReader() {
      return {
        read: () => new Promise(() => {}),
        cancel: () => { cancelCalls += 1; return new Promise(() => {}); },
        releaseLock() {},
      };
    },
  };
  const images = createVideoTempImages({
    taskId: 'dramart-20260910000000-zzzzz',
    tempRoot: root,
    downloadTimeoutMs: 10,
    fetchImpl: async () => ({ ok: true, body, headers: { get: () => null } }),
  });
  try {
    await Promise.race([
      assert.rejects(images.materialize('https://example.test/stuck-cancel', 0), /下载图片超时 \(10ms\)/),
      new Promise((_, reject) => setTimeout(() => reject(new Error('stuck cancellation blocked timeout')), 100)),
    ]);
    assert.ok(cancelCalls >= 1);
  } finally {
    await images.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cleanup removes only its own task directory after success or materialization failure', async () => {
  const root = await temporaryRoot('video-temp-cleanup-');
  const sibling = path.join(root, 'keep');
  await fs.mkdir(sibling);
  const success = createVideoTempImages({ taskId: 'dramart-20260910000000-fffff', tempRoot: root });
  await success.materialize('cmF3', 0);
  await success.cleanup();
  await assert.rejects(fs.access(success.taskDir), { code: 'ENOENT' });
  await fs.access(sibling);

  const failure = createVideoTempImages({
    taskId: 'dramart-20260910000000-ggggg',
    tempRoot: root,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(failure.materialize('https://example.test/bad', 0), /下载图片失败/);
  await failure.cleanup();
  await assert.rejects(fs.access(failure.taskDir), { code: 'ENOENT' });
  await fs.access(sibling);
  await fs.rm(root, { recursive: true, force: true });
});

test('abandoned cleanup keeps active and unsafe entries while deleting legal abandoned directories', async () => {
  const root = await temporaryRoot('video-temp-abandoned-');
  const active = 'dramart-20260910000000-hhhhh';
  const abandoned = 'dramart-20260910000000-iiiii';
  const invalid = 'other-directory';
  const legalFile = 'dramart-20260910000000-jjjjj';
  await Promise.all([
    fs.mkdir(path.join(root, active)),
    fs.mkdir(path.join(root, abandoned)),
    fs.mkdir(path.join(root, invalid)),
    fs.writeFile(path.join(root, legalFile), 'file'),
  ]);
  await cleanupAbandonedVideoTempDirs({ tempRoot: root, activeTaskIds: [active] });
  await fs.access(path.join(root, active));
  await fs.access(path.join(root, invalid));
  assert.equal(await fs.readFile(path.join(root, legalFile), 'utf8'), 'file');
  await assert.rejects(fs.access(path.join(root, abandoned)), { code: 'ENOENT' });
  await fs.rm(root, { recursive: true, force: true });
});

test('abandoned cleanup treats a missing root as empty and propagates other readdir errors', async () => {
  const root = path.join(os.tmpdir(), `missing-video-temp-${Date.now()}`);
  await cleanupAbandonedVideoTempDirs({ tempRoot: root, activeTaskIds: [] });
  const denied = Object.create(fs);
  denied.readdir = async () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; };
  await assert.rejects(cleanupAbandonedVideoTempDirs({ tempRoot: root, activeTaskIds: [], fsImpl: denied }), /denied/);
});

test('abandoned cleanup waits for every removal before throwing the first failure in directory order', async () => {
  const root = path.join(os.tmpdir(), 'video-temp-all-settled');
  const first = 'dramart-20260910000000-vvvvv';
  const second = 'dramart-20260910000000-wwwww';
  let releaseSecond;
  let secondCompleted = false;
  const fsImpl = {
    readdir: async () => [first, second].map((name) => ({
      name,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    })),
    rm: async (target) => {
      if (target.endsWith(first)) throw new Error('first removal failed');
      await new Promise((resolve) => { releaseSecond = resolve; });
      secondCompleted = true;
    },
  };
  const pending = cleanupAbandonedVideoTempDirs({ tempRoot: root, activeTaskIds: [], fsImpl });
  let rejected = false;
  pending.catch(() => { rejected = true; });
  await new Promise(setImmediate);
  assert.equal(rejected, false);
  assert.equal(secondCompleted, false);
  releaseSecond();
  await assert.rejects(pending, /first removal failed/);
  assert.equal(secondCompleted, true);
});

test('prepare workflow uses task-scoped helper behind main and has no legacy materializer', async () => {
  const source = await fs.readFile(new URL('./prepare-video-workflow.js', import.meta.url), 'utf8');
  assert.match(source, /from ['"]\.\/video-temp-images\.js['"]/);
  assert.match(source, /async function main\(/);
  assert.match(source, /finally\s*{/);
  assert.doesNotMatch(source, /async function materializeImage\(/);
  assert.match(source, /materializeVideoImages\(tempImages, request\.images, imageValue\)/);
  assert.doesNotMatch(source, /Promise\.all\(request\.images\.map/);
  assert.match(source, /tempImages\.cleanup\(\)/);
  assert.match(source, /createPage:\s*openTaskPage/);
  assert.match(source, /path\.resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/);
});
