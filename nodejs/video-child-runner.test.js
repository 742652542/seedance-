import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runVideoChild } from './video-child-runner.js';
import { createVideoPreparationScheduler } from './video-preparation-scheduler.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness({ closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.killCalls = 0;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killed = true;
    child.killCalls += 1;
    child.killSignals.push(signal);
    if (closeOnKill) child.emit('close', null);
    return true;
  };

  const spawnCalls = [];
  const spawnImpl = (...args) => {
    spawnCalls.push(args);
    return child;
  };

  return { child, spawnCalls, spawnImpl };
}

function startLine(overrides = {}) {
  return `TASK_STARTED ${JSON.stringify({
    taskEpisode: { EpisodeId: 'episode-1', ShotId: 'shot-1' },
    ...overrides,
  })}\n`;
}

function run(harness, overrides = {}) {
  return runVideoChild({
    spawnImpl: harness.spawnImpl,
    command: 'fake-command',
    args: ['--fake'],
    options: { cwd: 'fake-cwd' },
    preparationTimeoutMs: 1000,
    onPrepared: async () => {},
    ...overrides,
  });
}

async function waitUntil(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  throw new Error(message);
}

function observeSettlement(promise) {
  const state = { settled: false };
  promise.then(
    () => { state.settled = true; },
    () => { state.settled = true; },
  );
  return state;
}

test('reports preparation before final completion and collects all output', async () => {
  const harness = createHarness();
  const prepared = deferred();
  let context;
  const resultPromise = run(harness, {
    onPrepared: async (value) => {
      context = value;
      prepared.resolve();
    },
  });

  assert.deepEqual(harness.spawnCalls, [['fake-command', ['--fake'], { cwd: 'fake-cwd' }]]);
  harness.child.stdout.write('before\nTASK_STA');
  harness.child.stdout.write('RTED {"taskEpisode":{"EpisodeId":"episode-1","ShotId":"shot-1"}}\nafter\n');
  harness.child.stderr.write('first error\n');
  await prepared.promise;
  assert.equal(context.taskEpisode.EpisodeId, 'episode-1');

  let settled = false;
  resultPromise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await Promise.resolve();
  assert.equal(settled, false);

  harness.child.stderr.write('second error');
  harness.child.emit('close', 0);
  assert.deepEqual(await resultPromise, {
    exitCode: 0,
    stdout: 'before\nTASK_STARTED {"taskEpisode":{"EpisodeId":"episode-1","ShotId":"shot-1"}}\nafter\n',
    stderr: 'first error\nsecond error',
  });
});

test('malformed TASK_STARTED JSON kills the child and rejects', async () => {
  const harness = createHarness();
  const result = run(harness);

  harness.child.stdout.write('TASK_STARTED {not-json}\n');

  await assert.rejects(result, /TASK_STARTED.*JSON|JSON.*TASK_STARTED/i);
  assert.equal(harness.child.killCalls, 1);
});

test('malformed TASK_STARTED waits for close before rejecting', async () => {
  const harness = createHarness({ closeOnKill: false });
  const result = run(harness);
  const settlement = observeSettlement(result);

  harness.child.stdout.write('TASK_STARTED {not-json}\n');
  await new Promise(setImmediate);

  assert.equal(harness.child.killCalls, 1);
  assert.equal(settlement.settled, false);
  harness.child.emit('close', null);
  await assert.rejects(result, /TASK_STARTED.*JSON|JSON.*TASK_STARTED/i);
});

test('TASK_STARTED without required IDs kills the child and rejects', async () => {
  const harness = createHarness();
  const result = run(harness);

  harness.child.stdout.write(startLine({ taskEpisode: { EpisodeId: 'episode-1' } }));

  await assert.rejects(result, /EpisodeId.*ShotId|ShotId.*EpisodeId|taskEpisode/i);
  assert.equal(harness.child.killCalls, 1);
});

test('close before valid TASK_STARTED rejects as an early preparation exit', async () => {
  const harness = createHarness();
  const result = run(harness);

  harness.child.stdout.write('ordinary output\n');
  harness.child.emit('close', 2);

  await assert.rejects(result, /准备阶段.*提前退出/);
});

test('preparation timeout kills and rejects without calling onPrepared', async () => {
  const harness = createHarness();
  let preparedCalls = 0;
  const result = run(harness, {
    preparationTimeoutMs: 10,
    onPrepared: async () => { preparedCalls += 1; },
  });

  await assert.rejects(result, /准备超时.*10.*毫秒/);
  assert.equal(harness.child.killCalls, 1);
  assert.equal(preparedCalls, 0);
});

test('preparation timeout waits for close before rejecting', async () => {
  const harness = createHarness({ closeOnKill: false });
  const result = run(harness, { preparationTimeoutMs: 10 });
  const settlement = observeSettlement(result);

  await waitUntil(() => harness.child.killCalls === 1, 'timeout did not kill child');
  assert.equal(settlement.settled, false);

  harness.child.emit('close', null);
  await assert.rejects(result, /准备超时.*10.*毫秒/);
});

test('escalates to SIGKILL then rejects clearly if close is never observed', async () => {
  const harness = createHarness({ closeOnKill: false });
  const result = run(harness, { terminationTimeoutMs: 10 });

  harness.child.stdout.write('TASK_STARTED invalid\n');

  const error = await result.catch((reason) => reason);
  assert.match(error.message, /无法确认子进程退出/);
  assert.equal(error.code, 'VIDEO_CHILD_EXIT_UNCONFIRMED');
  assert.equal(error.blocksPreparationQueue, true);
  assert.deepEqual(harness.child.killSignals, [undefined, 'SIGKILL']);
});

test('real scheduler remains blocked when the fake child exit cannot be confirmed', async () => {
  const starts = [];
  const children = [];
  const scheduler = createVideoPreparationScheduler({
    start(item, onPrepared) {
      starts.push(item.id);
      const harness = createHarness({ closeOnKill: false });
      children.push(harness.child);
      return run(harness, { onPrepared, terminationTimeoutMs: 10 });
    },
  });

  const first = scheduler.enqueue({ id: 'first' });
  const second = scheduler.enqueue({ id: 'second' });
  children[0].stdout.write('TASK_STARTED invalid\n');
  await assert.rejects(first, { code: 'VIDEO_CHILD_EXIT_UNCONFIRMED' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(starts, ['first']);
  assert.equal(scheduler.queuePosition('first'), 0);
  assert.equal(scheduler.queuePosition('second'), 1);
  assert.equal(scheduler.isBlocked(), true);
  assert.equal(scheduler.blockedReason().code, 'VIDEO_CHILD_EXIT_UNCONFIRMED');
  void second.catch(() => {});
});

test('async onPrepared rejection records the error, kills, and rejects', async () => {
  const harness = createHarness({ closeOnKill: false });
  const callbackGate = deferred();
  const failure = new Error('scheduler callback failed');
  const result = run(harness, {
    onPrepared: async () => callbackGate.promise,
  });
  const settlement = observeSettlement(result);

  harness.child.stderr.write('existing stderr\n');
  harness.child.stdout.write(startLine());
  callbackGate.reject(failure);
  await waitUntil(() => harness.child.killCalls === 1, 'onPrepared rejection did not kill child');
  assert.equal(settlement.settled, false);
  harness.child.emit('close', null);

  const rejected = await result.catch((error) => error);
  assert.equal(rejected, failure);
  assert.match(rejected.stderr, /existing stderr/);
  assert.match(rejected.stderr, /scheduler callback failed/);
  assert.equal(harness.child.killCalls, 1);
});

test('close waits for an in-flight onPrepared rejection', async () => {
  const harness = createHarness();
  const callbackGate = deferred();
  const result = run(harness, {
    onPrepared: async () => callbackGate.promise,
  });

  harness.child.stdout.write(startLine());
  harness.child.emit('close', 0);
  let settled = false;
  result.finally(() => { settled = true; }).catch(() => {});
  await Promise.resolve();
  assert.equal(settled, false);

  callbackGate.reject(new Error('late callback failure'));
  await assert.rejects(result, /late callback failure/);
  assert.equal(harness.child.killCalls, 1);
});

test('repeated TASK_STARTED lines call onPrepared only once', async () => {
  const harness = createHarness();
  let preparedCalls = 0;
  const result = run(harness, {
    onPrepared: async () => { preparedCalls += 1; },
  });

  harness.child.stdout.write(startLine());
  harness.child.stdout.write(startLine({ taskEpisode: { EpisodeId: 'episode-2', ShotId: 'shot-2' } }));
  await new Promise(setImmediate);
  harness.child.emit('close', 0);

  await result;
  assert.equal(preparedCalls, 1);
});

test('non-zero exit after valid preparation still resolves', async () => {
  const harness = createHarness();
  const result = run(harness);

  harness.child.stdout.write(startLine());
  await new Promise(setImmediate);
  harness.child.emit('close', 7);

  assert.equal((await result).exitCode, 7);
});

test('synchronous and duplicate close during kill settle only once', async () => {
  const harness = createHarness();
  const result = run(harness);

  harness.child.stdout.write('TASK_STARTED invalid\n');
  harness.child.emit('close', null);

  await assert.rejects(result, /TASK_STARTED.*JSON|JSON.*TASK_STARTED/i);
  assert.equal(harness.child.killCalls, 1);
});

test('scheduler does not start the next child until killed child closes', async () => {
  const children = [];
  const starts = [];
  const scheduler = createVideoPreparationScheduler({
    start(item, onPrepared) {
      starts.push(item.id);
      const harness = createHarness({ closeOnKill: false });
      children.push(harness.child);
      return run(harness, { onPrepared });
    },
  });

  const first = scheduler.enqueue({ id: 'first' });
  const firstRejection = assert.rejects(first, /TASK_STARTED.*JSON|JSON.*TASK_STARTED/i);
  const second = scheduler.enqueue({ id: 'second' });
  children[0].stdout.write('TASK_STARTED invalid\n');
  await new Promise(setImmediate);

  assert.deepEqual(starts, ['first']);
  assert.equal(children[0].killCalls, 1);

  children[0].emit('close', null);
  await firstRejection;
  await waitUntil(() => starts.length === 2, 'second child did not start after close');
  assert.deepEqual(starts, ['first', 'second']);

  children[1].stdout.write(startLine());
  await new Promise(setImmediate);
  children[1].emit('close', 0);
  await second;
});

test('real runner fatal rejection after TASK_STARTED does not retroactively block the next preparation', async () => {
  const children = [];
  const starts = [];
  const scheduler = createVideoPreparationScheduler({
    start(item, onPrepared) {
      starts.push(item.id);
      const harness = createHarness({ closeOnKill: false });
      children.push(harness.child);
      return run(harness, { onPrepared, terminationTimeoutMs: 10 });
    },
  });

  const first = scheduler.enqueue({ id: 'first' });
  const second = scheduler.enqueue({ id: 'second' });
  children[0].stdout.write(startLine());
  await waitUntil(() => starts.length === 2, 'second child did not start after TASK_STARTED');
  children[0].emit('error', new Error('late child failure'));
  await assert.rejects(first, { code: 'VIDEO_CHILD_EXIT_UNCONFIRMED' });

  assert.equal(scheduler.isBlocked(), false);
  assert.equal(scheduler.queuePosition('second'), 0);
  children[1].stdout.write(startLine());
  await new Promise(setImmediate);
  children[1].emit('close', 0);
  await second;
});
