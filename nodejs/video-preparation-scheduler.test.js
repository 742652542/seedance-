import assert from 'node:assert/strict';
import test from 'node:test';

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

function createHarness() {
  const controls = new Map();
  const starts = [];
  let preparing = 0;
  let maxPreparing = 0;

  const scheduler = createVideoPreparationScheduler({
    start(item, markPrepared) {
      starts.push(item.id);
      preparing += 1;
      maxPreparing = Math.max(maxPreparing, preparing);
      const completion = deferred();
      let preparationCounted = true;
      controls.set(item.id, {
        completion,
        markPrepared() {
          if (preparationCounted) {
            preparationCounted = false;
            preparing -= 1;
          }
          markPrepared();
        },
      });
      return completion.promise;
    },
  });

  return {
    scheduler,
    controls,
    starts,
    get maxPreparing() { return maxPreparing; },
  };
}

test('only one task starts before the first preparation signal', async () => {
  const harness = createHarness();
  const first = harness.scheduler.enqueue({ id: 'first' });
  const second = harness.scheduler.enqueue({ id: 'second' });

  assert.deepEqual(harness.starts, ['first']);
  assert.equal(harness.maxPreparing, 1);

  harness.controls.get('first').markPrepared();
  assert.deepEqual(harness.starts, ['first', 'second']);
  assert.equal(harness.maxPreparing, 1);

  harness.controls.get('second').markPrepared();
  harness.controls.get('first').completion.resolve('first-result');
  harness.controls.get('second').completion.resolve('second-result');
  assert.deepEqual(await Promise.all([first, second]), ['first-result', 'second-result']);
});

test('markPrepared starts the next task before the first task completes', async () => {
  const harness = createHarness();
  const first = harness.scheduler.enqueue({ id: 'first' });
  const second = harness.scheduler.enqueue({ id: 'second' });

  harness.controls.get('first').markPrepared();

  assert.deepEqual(harness.starts, ['first', 'second']);
  let firstSettled = false;
  first.finally(() => { firstSettled = true; });
  await Promise.resolve();
  assert.equal(firstSettled, false);

  harness.controls.get('second').markPrepared();
  harness.controls.get('first').completion.resolve('first-result');
  harness.controls.get('second').completion.resolve('second-result');
  assert.equal(await first, 'first-result');
  assert.equal(await second, 'second-result');
});

test('three tasks start FIFO and report queue positions', async () => {
  const harness = createHarness();
  const first = harness.scheduler.enqueue({ id: 'first' });
  const second = harness.scheduler.enqueue({ id: 'second' });
  const third = harness.scheduler.enqueue({ id: 'third' });

  assert.equal(harness.scheduler.queuePosition('first'), 0);
  assert.equal(harness.scheduler.queuePosition('second'), 1);
  assert.equal(harness.scheduler.queuePosition('third'), 2);
  assert.equal(harness.scheduler.queuePosition('missing'), null);

  harness.controls.get('first').markPrepared();
  assert.deepEqual(harness.starts, ['first', 'second']);
  assert.equal(harness.scheduler.queuePosition('first'), null);
  assert.equal(harness.scheduler.queuePosition('second'), 0);
  assert.equal(harness.scheduler.queuePosition('third'), 1);

  harness.controls.get('second').markPrepared();
  assert.deepEqual(harness.starts, ['first', 'second', 'third']);
  assert.equal(harness.scheduler.queuePosition('second'), null);
  assert.equal(harness.scheduler.queuePosition('third'), 0);

  harness.controls.get('third').markPrepared();
  for (const id of ['first', 'second', 'third']) controlsResolve(harness, id);
  await Promise.all([first, second, third]);
});

test('failure before preparation releases the next task', async () => {
  const harness = createHarness();
  const first = harness.scheduler.enqueue({ id: 'first' });
  const second = harness.scheduler.enqueue({ id: 'second' });
  const failure = new Error('preparation failed');

  harness.controls.get('first').completion.reject(failure);
  await assert.rejects(first, failure);

  assert.deepEqual(harness.starts, ['first', 'second']);
  assert.equal(harness.scheduler.queuePosition('second'), 0);

  harness.controls.get('second').markPrepared();
  controlsResolve(harness, 'second');
  await second;
});

test('synchronous fatal start failure keeps the active slot blocked', async () => {
  const starts = [];
  const fatal = new Error('unconfirmed synchronous exit');
  fatal.code = 'VIDEO_CHILD_EXIT_UNCONFIRMED';
  fatal.blocksPreparationQueue = true;
  const scheduler = createVideoPreparationScheduler({
    start(item) {
      starts.push(item.id);
      throw fatal;
    },
  });

  const first = scheduler.enqueue({ id: 'first' });
  const second = scheduler.enqueue({ id: 'second' });
  void second.catch(() => {});
  await assert.rejects(first, fatal);
  await new Promise(setImmediate);

  assert.deepEqual(starts, ['first']);
  assert.equal(scheduler.queuePosition('first'), 0);
  assert.equal(scheduler.queuePosition('second'), 1);
  assert.equal(scheduler.blockedReason(), fatal);
});

test('late markPrepared cannot release an entry blocked by an earlier fatal rejection', async () => {
  const starts = [];
  const writeGate = deferred();
  const lifecycle = deferred();
  let preparedWrite;
  const fatal = new Error('unconfirmed exit during prepared-state write');
  fatal.code = 'VIDEO_CHILD_EXIT_UNCONFIRMED';
  fatal.blocksPreparationQueue = true;
  const scheduler = createVideoPreparationScheduler({
    start(item, markPrepared) {
      starts.push(item.id);
      if (item.id === 'first') {
        preparedWrite = writeGate.promise.then(markPrepared);
        return lifecycle.promise;
      }
      return new Promise(() => {});
    },
  });

  const first = scheduler.enqueue({ id: 'first' });
  const second = scheduler.enqueue({ id: 'second' });
  void second.catch(() => {});
  lifecycle.reject(fatal);
  await assert.rejects(first, fatal);
  assert.equal(scheduler.isBlocked(), true);
  assert.deepEqual(starts, ['first']);

  writeGate.resolve();
  await preparedWrite;
  await new Promise(setImmediate);
  await new Promise(setImmediate);

  assert.equal(scheduler.isBlocked(), true);
  assert.equal(scheduler.blockedReason(), fatal);
  assert.equal(scheduler.queuePosition('first'), 0);
  assert.equal(scheduler.queuePosition('second'), 1);
  assert.deepEqual(starts, ['first']);
});

test('repeated markPrepared does not release another active task', async () => {
  const harness = createHarness();
  const first = harness.scheduler.enqueue({ id: 'first' });
  const second = harness.scheduler.enqueue({ id: 'second' });
  const third = harness.scheduler.enqueue({ id: 'third' });

  harness.controls.get('first').markPrepared();
  harness.controls.get('first').markPrepared();

  assert.deepEqual(harness.starts, ['first', 'second']);
  assert.equal(harness.scheduler.queuePosition('second'), 0);
  assert.equal(harness.scheduler.queuePosition('third'), 1);

  harness.controls.get('second').markPrepared();
  harness.controls.get('third').markPrepared();
  for (const id of ['first', 'second', 'third']) controlsResolve(harness, id);
  await Promise.all([first, second, third]);
});

test('failure after preparation does not disturb the current preparation slot', async () => {
  const harness = createHarness();
  const first = harness.scheduler.enqueue({ id: 'first' });
  const second = harness.scheduler.enqueue({ id: 'second' });
  const third = harness.scheduler.enqueue({ id: 'third' });

  harness.controls.get('first').markPrepared();
  harness.controls.get('first').completion.reject(new Error('completion failed'));
  await assert.rejects(first, /completion failed/);

  assert.deepEqual(harness.starts, ['first', 'second']);
  assert.equal(harness.scheduler.queuePosition('second'), 0);
  assert.equal(harness.scheduler.queuePosition('third'), 1);

  harness.controls.get('second').markPrepared();
  harness.controls.get('third').markPrepared();
  controlsResolve(harness, 'second');
  controlsResolve(harness, 'third');
  await Promise.all([second, third]);
});

test('fatal lifecycle rejection after markPrepared fails only that completed preparation', async () => {
  const harness = createHarness();
  const first = harness.scheduler.enqueue({ id: 'first' });
  const second = harness.scheduler.enqueue({ id: 'second' });
  const third = harness.scheduler.enqueue({ id: 'third' });
  const fatal = new Error('late unconfirmed exit');
  fatal.code = 'VIDEO_CHILD_EXIT_UNCONFIRMED';
  fatal.blocksPreparationQueue = true;

  harness.controls.get('first').markPrepared();
  assert.deepEqual(harness.starts, ['first', 'second']);
  harness.controls.get('first').completion.reject(fatal);
  await assert.rejects(first, fatal);

  assert.equal(harness.scheduler.isBlocked(), false);
  assert.equal(harness.scheduler.queuePosition('second'), 0);
  assert.equal(harness.scheduler.queuePosition('third'), 1);
  harness.controls.get('second').markPrepared();
  assert.deepEqual(harness.starts, ['first', 'second', 'third']);

  harness.controls.get('third').markPrepared();
  controlsResolve(harness, 'second');
  controlsResolve(harness, 'third');
  await Promise.all([second, third]);
});

function controlsResolve(harness, id) {
  harness.controls.get(id).completion.resolve(`${id}-result`);
}
