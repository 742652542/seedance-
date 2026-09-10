import assert from 'node:assert/strict';
import test from 'node:test';

import { collectSubmitEvidence, stopChild } from './live-image-concurrency-test.js';

const tasks = [
  { taskId: 'task-a', ratio: '1:1' },
  { taskId: 'task-b', ratio: '16:9' },
];

test('collects both submit records when they precede every task completion', () => {
  const logs = [
    '[image-session.submit] task_id=task-a resource_id=resource-a ratio=1:1',
    '[image-session.submit] task_id=task-b resource_id=resource-b ratio=16:9',
    '[task.done] task_id=task-a status=success',
    '[task.done] task_id=task-b status=success',
  ].join('\n');
  assert.deepEqual(collectSubmitEvidence(logs, tasks), [
    { taskId: 'task-a', resourceId: 'resource-a', ratio: '1:1' },
    { taskId: 'task-b', resourceId: 'resource-b', ratio: '16:9' },
  ]);
});

test('rejects a round when any completion appears before both submissions', () => {
  const logs = [
    '[image-session.submit] task_id=task-a resource_id=resource-a ratio=1:1',
    '[task.done] task_id=task-a status=success',
    '[image-session.submit] task_id=task-b resource_id=resource-b ratio=16:9',
    '[task.done] task_id=task-b status=success',
  ].join('\n');
  assert.throws(() => collectSubmitEvidence(logs, tasks), /提交重叠证据不足/);
});

test('rejects evidence that has submissions but no captured completion logs', () => {
  const logs = [
    '[image-session.submit] task_id=task-a resource_id=resource-a ratio=1:1',
    '[image-session.submit] task_id=task-b resource_id=resource-b ratio=16:9',
  ].join('\n');
  assert.throws(() => collectSubmitEvidence(logs, tasks), /完成日志证据不足/);
});

test('stopChild returns immediately for exited children and bounds close waiting after kill', async () => {
  let onceCalls = 0;
  await stopChild({ exitCode: 0, once: () => { onceCalls += 1; } }, { timeoutMs: 10 });
  assert.equal(onceCalls, 0);

  let killed = false;
  const started = Date.now();
  await stopChild({ exitCode: null, kill: () => { killed = true; }, once: () => {} }, { timeoutMs: 20 });
  assert.equal(killed, true);
  assert.ok(Date.now() - started < 200);
});
