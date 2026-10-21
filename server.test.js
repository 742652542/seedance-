import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, writeFile, symlink, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { app } from './server.js';

test('server blocks unsafe paths and preserves existing task flows', async t => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => JSON.stringify({ id: 'task-123', status: 'queued' }) };
  };
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
  });
  const send = (path, method = 'GET', payload) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path, method,
      headers: payload ? { 'Content-Type': 'application/json' } : {} }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(payload ? JSON.stringify(payload) : undefined);
  });

  await t.test('raw traversal, encodings and device names never reach upstream', async () => {
    for (const path of [
      '/api/files/..%5C..%5Cconfig', '/api/result/..%5C..%5Cconfig',
      '/api/files/..%5C..%5Ccon', '/api/files/..%5C..%5Cnul',
      '/../api-keys.json', '/%2e%2e/api-keys.json', '/%252e%252e%255cconfig',
      '/api/tasks/..', '/api/tasks/%2e%2e', '/api/tasks/a%2fb',
      '/api/tasks/CON', '/api/tasks/nul.json', '/api/tasks/COM1.mp4',
      '/api/tasks/name%3Astream', '/api/tasks/name%00', '/api/tasks/%ZZ'
    ]) assert.equal((await send(path)).status, 400, path);
    assert.equal(calls.length, 0);
  });

  await t.test('only the homepage and project routes are exposed', async () => {
    for (const path of ['/openapi.json', '/docs', '/redoc', '/api/files/config',
      '/api-keys.json', '/server.js', '/package.json', '/.git/config']) {
      assert.equal((await send(path)).status, 404, path);
    }
    for (const path of ['/', '/index.html']) assert.equal((await send(path)).status, 200);
  });

  await t.test('static links cannot expose files outside public', async sub => {
    const outside = await mkdtemp(join(tmpdir(), 'seedance-static-'));
    const link = fileURLToPath(new URL(`./public/security-test-${process.pid}`, import.meta.url));
    try {
      await writeFile(join(outside, 'index.html'), 'private sentinel');
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      await rm(outside, { recursive: true, force: true });
      if (error.code === 'EPERM' || error.code === 'EACCES') return sub.skip('Symlinks unavailable');
      throw error;
    }
    try {
      for (const suffix of ['', '/', '/index.html']) {
        const result = await send(`/security-test-${process.pid}${suffix}`);
        assert.equal(result.status, 403);
        assert.ok(!result.body.includes('private sentinel'));
      }
    } finally {
      await unlink(link);
      await rm(outside, { recursive: true, force: true });
    }
  });

  await t.test('create, poll, list, advanced fields and prompt text remain intact', async () => {
    const model = 'doubao-seedance-2-0-260128';
    const content = [{ type: 'text', text: 'camera .. move & 中文 % details' }];
    assert.equal((await send('/api/tasks', 'POST', {
      model, apiKey: 'test-key', content, advancedJson: '{"duration":8}'
    })).status, 200);
    assert.deepEqual(JSON.parse(calls[0].options.body), { model, content, duration: 8 });
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
    assert.equal((await send(`/api/tasks/task-123?model=${model}&apiKey=test-key`)).status, 200);
    assert.ok(calls[1].url.endsWith('/contents/generations/tasks/task-123'));
    assert.equal((await send(`/api/tasks?model=${model}&apiKey=test-key&page_num=2&filter.status=running`)).status, 200);
    assert.ok(calls[2].url.endsWith('?page_num=2&filter.status=running'));
    assert.equal(calls.length, 3);
  });
});
