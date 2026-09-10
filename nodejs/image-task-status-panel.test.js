import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createImageTaskStatusPanel,
  renderImageTaskStatusPanel,
} from './image-task-status-panel.js';

function createHarness(initialNow = 1000) {
  let currentNow = initialNow;
  let nextTimerId = 1;
  const timers = new Map();
  const cleared = [];
  const panel = createImageTaskStatusPanel({
    now: () => currentNow,
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      timers.delete(id);
    },
  });

  return {
    panel,
    timers,
    cleared,
    setNow(value) { currentNow = value; },
    runTimer(id) {
      const timer = timers.get(id);
      assert.ok(timer, `timer ${id} should exist`);
      timers.delete(id);
      timer.callback();
    },
  };
}

function createFakeDom(nowValue) {
  class FakeStyle {
    constructor() {
      this.value = '';
    }

    set cssText(value) {
      this.value = value;
      for (const declaration of value.split(';')) {
        const separator = declaration.indexOf(':');
        if (separator < 0) continue;
        const name = declaration.slice(0, separator).trim().replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        this[name] = declaration.slice(separator + 1).trim();
      }
    }

    get cssText() { return this.value; }
  }

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.id = '';
      this.style = new FakeStyle();
      this.dataset = {};
      this.children = [];
      this.parentNode = null;
      this._textContent = '';
      this.scrollTop = 0;
      this.clientHeight = 100;
    }

    set textContent(value) {
      this._textContent = String(value);
      this.children = [];
    }

    get textContent() {
      return this._textContent + this.children.map((child) => child.textContent).join('');
    }

    get scrollHeight() { return this.children.length * 100; }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    replaceChildren(...children) {
      this.children.forEach((child) => { child.parentNode = null; });
      this.children = [];
      children.forEach((child) => this.appendChild(child));
    }
  }

  const body = new FakeElement('body');
  const walk = (root) => [root, ...root.children.flatMap(walk)];
  const document = {
    body,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => walk(body).find((element) => element.id === id) || null,
    querySelectorAll: (selector) => selector.includes('[data-started-at]')
      ? walk(body).filter((element) => Object.hasOwn(element.dataset, 'startedAt'))
      : [],
  };
  const intervalCallbacks = [];
  const window = {
    setInterval(callback) {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
  };
  const OriginalDate = Date;
  class FakeDate extends OriginalDate {
    static now() { return nowValue; }
  }

  return { document, window, Date: FakeDate, intervalCallbacks, walk };
}

async function withFakeDom(fakeDom, callback) {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    Date: globalThis.Date,
  };
  globalThis.document = fakeDom.document;
  globalThis.window = fakeDom.window;
  globalThis.Date = fakeDom.Date;
  try {
    await callback();
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.Date = previous.Date;
  }
}

test('tracks independent tasks in insertion order and protects state from snapshot mutation', () => {
  const { panel } = createHarness(1234);

  panel.add('first');
  panel.add('second', 900);
  panel.add('first', 1);
  panel.update('first', '生成中', '正在处理');
  panel.update('missing', '不应出现', '忽略');

  const snapshot = panel.snapshot();
  assert.equal(snapshot.activeCount, 2);
  assert.deepEqual(snapshot.tasks, [
    { id: 'first', startedAt: 1234, stage: '生成中', detail: '正在处理', state: 'running' },
    { id: 'second', startedAt: 900, stage: '等待任务执行', detail: '', state: 'running' },
  ]);

  snapshot.activeCount = 0;
  snapshot.tasks[0].stage = '外部篡改';
  snapshot.tasks.push({ id: 'fake' });
  assert.deepEqual(panel.snapshot(), {
    activeCount: 2,
    tasks: [
      { id: 'first', startedAt: 1234, stage: '生成中', detail: '正在处理', state: 'running' },
      { id: 'second', startedAt: 900, stage: '等待任务执行', detail: '', state: 'running' },
    ],
  });
});

test('success and failure capture terminal state, finished time, and one three-second timer', () => {
  const harness = createHarness();
  const { panel, timers } = harness;
  panel.add('success');
  panel.add('failure');

  harness.setNow(2000);
  panel.succeed('success', '结果已保存');
  harness.setNow(2500);
  panel.fail('failure', '上游失败');

  assert.equal(panel.snapshot().activeCount, 0);
  assert.deepEqual(panel.snapshot().tasks, [
    { id: 'success', startedAt: 1000, stage: '已完成', detail: '结果已保存', state: 'success', finishedAt: 2000 },
    { id: 'failure', startedAt: 1000, stage: '执行失败', detail: '上游失败', state: 'error', finishedAt: 2500 },
  ]);
  assert.deepEqual([...timers.values()].map(({ delay }) => delay), [3000, 3000]);

  panel.succeed('success', '不应覆盖');
  panel.fail('success', '不应改变终态');
  panel.update('failure', '不应更新', '不应更新');
  panel.fail('missing', '忽略');
  assert.equal(timers.size, 2);
  assert.equal(panel.snapshot().tasks[0].detail, '结果已保存');
  assert.equal(panel.snapshot().tasks[1].stage, '执行失败');
});

test('terminal delay is configurable and out-of-order callbacks remove only their own tasks', () => {
  let now = 10;
  let nextTimerId = 1;
  const timers = new Map();
  const panel = createImageTaskStatusPanel({
    now: () => now,
    terminalDelayMs: 25,
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });

  panel.add('first');
  panel.add('second');
  now = 20;
  panel.succeed('second');
  now = 30;
  panel.fail('first');
  assert.deepEqual([...timers.values()].map(({ delay }) => delay), [25, 25]);

  const [secondTimerId, firstTimerId] = [...timers.keys()];
  const firstTimer = timers.get(firstTimerId);
  timers.delete(firstTimerId);
  firstTimer.callback();
  assert.deepEqual(panel.snapshot().tasks.map(({ id }) => id), ['second']);

  const secondTimer = timers.get(secondTimerId);
  timers.delete(secondTimerId);
  secondTimer.callback();
  assert.deepEqual(panel.snapshot(), { activeCount: 0, tasks: [] });

  panel.add('third', 40);
  assert.deepEqual(panel.snapshot(), {
    activeCount: 1,
    tasks: [{ id: 'third', startedAt: 40, stage: '等待任务执行', detail: '', state: 'running' }],
  });
});

test('attachPage immediately renders an empty persistent panel', async () => {
  const rendered = [];
  const page = { isClosed: () => false };
  const panel = createImageTaskStatusPanel({
    now: () => 1700000000123,
    render: async (target, snapshot) => rendered.push({ target, snapshot }),
  });

  panel.attachPage(page);
  await panel.flush();

  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].target, page);
  assert.deepEqual(rendered[0].snapshot, {
    activeCount: 0,
    tasks: [],
    timestamp: 1700000000123,
  });
});

test('every status change publishes a complete snapshot', async () => {
  const snapshots = [];
  const panel = createImageTaskStatusPanel({
    render: async (_page, snapshot) => snapshots.push(snapshot),
  });
  panel.attachPage({ isClosed: () => false });
  panel.add('first', 1000);
  panel.add('second', 1100);
  panel.update('first', '生成中', '已提交');
  await panel.flush();

  assert.deepEqual(snapshots.map(({ tasks }) => tasks.map(({ id, stage }) => [id, stage])), [
    [],
    [['first', '等待任务执行']],
    [['first', '等待任务执行'], ['second', '等待任务执行']],
    [['first', '生成中'], ['second', '等待任务执行']],
  ]);
});

test('replacing a page restores current tasks and stops publishing to the old page', async () => {
  const calls = [];
  const oldPage = { name: 'old', isClosed: () => false };
  const newPage = { name: 'new', isClosed: () => false };
  const panel = createImageTaskStatusPanel({
    render: async (page, snapshot) => calls.push({ page, snapshot }),
  });

  panel.attachPage(oldPage);
  panel.add('task-12345', 1000);
  await panel.flush();
  const oldCallCount = calls.filter(({ page }) => page === oldPage).length;

  panel.attachPage(newPage);
  await panel.flush();
  assert.deepEqual(calls.at(-1).snapshot.tasks.map(({ id }) => id), ['task-12345']);

  panel.update('task-12345', '下载结果');
  await panel.flush();
  assert.equal(calls.filter(({ page }) => page === oldPage).length, oldCallCount);
  assert.equal(calls.at(-1).page, newPage);
  assert.equal(calls.at(-1).snapshot.tasks[0].stage, '下载结果');
});

test('render rejection is logged without losing state or rejecting mutations and flush', async () => {
  const errors = [];
  const panel = createImageTaskStatusPanel({
    render: async () => { throw new Error('evaluate failed'); },
    log: (error) => errors.push(error),
  });

  assert.doesNotThrow(() => panel.attachPage({ isClosed: () => false }));
  assert.doesNotThrow(() => panel.add('kept', 123));
  assert.doesNotThrow(() => panel.update('kept', '仍然更新', '状态未丢'));
  await assert.doesNotReject(panel.flush());

  assert.equal(errors.length, 3);
  assert.equal(errors[0].message, 'evaluate failed');
  assert.equal(panel.snapshot().tasks[0].detail, '状态未丢');
});

test('closed or empty pages are skipped safely', async () => {
  let renders = 0;
  const panel = createImageTaskStatusPanel({ render: async () => { renders += 1; } });

  panel.attachPage(null);
  panel.add('before-page');
  panel.attachPage({ isClosed: () => true });
  panel.update('before-page', '不会渲染');
  await panel.flush();

  assert.equal(renders, 0);
  assert.equal(panel.snapshot().tasks[0].stage, '不会渲染');
});

test('asynchronous renders stay ordered so an older snapshot cannot overwrite a newer one', async () => {
  let releaseFirst;
  let callCount = 0;
  const applied = [];
  const firstRender = new Promise((resolve) => { releaseFirst = resolve; });
  const panel = createImageTaskStatusPanel({
    render: async (_page, snapshot) => {
      callCount += 1;
      if (callCount === 1) await firstRender;
      applied.push(snapshot.tasks[0]?.stage || 'empty');
    },
  });

  panel.attachPage({ isClosed: () => false });
  panel.add('ordered', 1000);
  panel.update('ordered', '最新状态');
  await Promise.resolve();
  assert.equal(callCount, 1);

  releaseFirst();
  await panel.flush();
  assert.deepEqual(applied, ['empty', '等待任务执行', '最新状态']);
});

test('renderer receives JSON-safe cloned snapshots with millisecond timestamps', async () => {
  let currentNow = 1700000000001;
  const received = [];
  const panel = createImageTaskStatusPanel({
    now: () => currentNow,
    render: async (_page, snapshot) => {
      received.push(snapshot);
      if (snapshot.tasks[0]) snapshot.tasks[0].stage = 'renderer mutation';
    },
  });

  panel.attachPage({ isClosed: () => false });
  await panel.flush();
  currentNow = 1700000000999;
  panel.add('safe', 1700000000123);
  await panel.flush();

  assert.equal(received[1].timestamp, 1700000000999);
  assert.equal(typeof received[1].timestamp, 'number');
  assert.notEqual(received[0], received[1]);
  assert.equal(JSON.stringify(received[1]).includes('undefined'), false);
  assert.equal(panel.snapshot().tasks[0].stage, '等待任务执行');
});

test('default renderer uses safe DOM APIs, one elapsed timer, and a sanitized evaluate payload', async () => {
  let evaluateFunction;
  let evaluateArgument;
  const page = {
    isClosed: () => false,
    async evaluate(fn, argument) {
      evaluateFunction = fn;
      evaluateArgument = argument;
    },
  };

  await renderImageTaskStatusPanel(page, {
    activeCount: 1,
    timestamp: 1700000000123,
    prompt: '<img src=x onerror=alert(1)>',
    images: ['secret-image-data'],
    tasks: [{
      id: '<script>bad-task-12345</script>',
      startedAt: 1700000000000,
      stage: '<b>生成中</b>',
      detail: '<img src=x>',
      state: 'running',
      request: { prompt: 'secret' },
    }],
  });

  assert.deepEqual(Object.keys(evaluateArgument).sort(), ['activeCount', 'tasks', 'timestamp']);
  assert.deepEqual(Object.keys(evaluateArgument.tasks[0]).sort(), [
    'detail', 'id', 'stage', 'startedAt', 'state',
  ]);
  assert.equal(JSON.stringify(evaluateArgument).includes('secret'), false);

  const source = evaluateFunction.toString();
  assert.match(source, /seedance-image-task-status-panel/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /innerHTML/);
  assert.match(source, /__seedanceImageTaskElapsedTimer/);
  assert.match(source, /setInterval/);
  assert.match(source, /querySelectorAll/);
  assert.match(source, /data-started-at|startedAt/);
  assert.match(source, /3600000/);
  assert.match(source, /padStart/);
  assert.match(source, /pointer-events:none/);
  assert.match(source, /执行中/);
  assert.match(source, /当前无任务/);
});

test('a permanently pending old page does not block the new page or current-generation flush', async () => {
  let oldRenderStarted;
  const oldStarted = new Promise((resolve) => { oldRenderStarted = resolve; });
  const never = new Promise(() => {});
  const oldPage = { name: 'old', isClosed: () => false };
  const newPage = { name: 'new', isClosed: () => false };
  const calls = [];
  const panel = createImageTaskStatusPanel({
    render: async (page, snapshot) => {
      calls.push({ page, snapshot });
      if (page === oldPage) {
        oldRenderStarted();
        await never;
      }
    },
  });

  panel.attachPage(oldPage);
  await oldStarted;
  panel.add('survives-page-change', 1000);
  panel.attachPage(newPage);

  await Promise.race([
    panel.flush(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('new generation remained blocked')), 50)),
  ]);
  const newCalls = calls.filter(({ page }) => page === newPage);
  assert.equal(newCalls.length, 1);
  assert.deepEqual(newCalls[0].snapshot.tasks.map(({ id }) => id), ['survives-page-change']);
});

test('flush already waiting on an old generation follows invalidation to the new generation', async () => {
  let oldRenderStarted;
  const oldStarted = new Promise((resolve) => { oldRenderStarted = resolve; });
  const never = new Promise(() => {});
  const oldPage = { name: 'old', isClosed: () => false };
  const newPage = { name: 'new', isClosed: () => false };
  const renderedPages = [];
  const panel = createImageTaskStatusPanel({
    render: async (page) => {
      renderedPages.push(page);
      if (page === oldPage) {
        oldRenderStarted();
        await never;
      }
    },
  });

  panel.attachPage(oldPage);
  await oldStarted;
  const flushStartedBeforeReplacement = panel.flush();
  panel.attachPage(newPage);

  await Promise.race([
    flushStartedBeforeReplacement,
    new Promise((_, reject) => setTimeout(() => reject(new Error('existing flush remained blocked')), 50)),
  ]);
  assert.deepEqual(renderedPages, [oldPage, newPage]);
});

test('terminal cleanup starts a full delay after a blocked terminal snapshot renders successfully', async () => {
  let currentNow = 1000;
  let nextTimerId = 1;
  const timers = new Map();
  let releaseTerminal;
  const terminalRender = new Promise((resolve) => { releaseTerminal = resolve; });
  const panel = createImageTaskStatusPanel({
    now: () => currentNow,
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, dueAt: currentNow + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    render: async (_page, snapshot) => {
      if (snapshot.tasks.some(({ state }) => state === 'success')) await terminalRender;
    },
  });
  const runDueTimers = () => {
    const due = [...timers.entries()].filter(([, timer]) => timer.dueAt <= currentNow);
    due.forEach(([id, timer]) => {
      timers.delete(id);
      timer.callback();
    });
  };

  panel.attachPage({ isClosed: () => false });
  panel.add('slow-terminal', 1000);
  await panel.flush();
  panel.succeed('slow-terminal');

  currentNow = 5000;
  runDueTimers();
  assert.equal(panel.snapshot().tasks[0].state, 'success');

  releaseTerminal();
  await panel.flush();
  currentNow = 7999;
  runDueTimers();
  assert.equal(panel.snapshot().tasks.length, 1);

  currentNow = 8000;
  runDueTimers();
  await panel.flush();
  assert.equal(panel.snapshot().tasks.length, 0);
});

test('terminal tasks without a usable page or with failed rendering are removed by fallback', async () => {
  function createFallbackPanel(render) {
    let currentNow = 1000;
    const timers = new Map();
    let nextTimerId = 1;
    const panel = createImageTaskStatusPanel({
      now: () => currentNow,
      render,
      log: () => {},
      setTimeout(callback, delay) {
        const id = nextTimerId++;
        timers.set(id, { callback, dueAt: currentNow + delay });
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
    });
    return {
      panel,
      expire() {
        currentNow += 3000;
        [...timers.entries()].filter(([, timer]) => timer.dueAt <= currentNow).forEach(([id, timer]) => {
          timers.delete(id);
          timer.callback();
        });
      },
    };
  }

  const detached = createFallbackPanel(async () => {});
  detached.panel.add('detached');
  detached.panel.fail('detached');
  detached.expire();
  assert.equal(detached.panel.snapshot().tasks.length, 0);

  const failed = createFallbackPanel(async () => { throw new Error('render unavailable'); });
  failed.panel.attachPage({ isClosed: () => false });
  failed.panel.add('failed-render');
  await failed.panel.flush();
  failed.panel.fail('failed-render');
  await failed.panel.flush();
  failed.expire();
  await failed.panel.flush();
  assert.equal(failed.panel.snapshot().tasks.length, 0);
});

test('default renderer constrains long lists while keeping the panel non-interactive', async () => {
  let source;
  const page = {
    isClosed: () => false,
    async evaluate(fn) { source = fn.toString(); },
  };

  await renderImageTaskStatusPanel(page, { activeCount: 0, tasks: [], timestamp: Date.now() });

  assert.match(source, /max-height:calc\(100vh - 40px\)/);
  assert.match(source, /display:flex/);
  assert.match(source, /flex-direction:column/);
  assert.match(source, /overflow-y:auto/);
  assert.doesNotMatch(source, /pointer-events:auto/);
  assert.match(source, /pointer-events:none/);
});

test('default renderer executes safely in a minimal DOM and preserves its behavioral boundaries', async () => {
  const nowValue = 1700003600000;
  const fakeDom = createFakeDom(nowValue);
  const page = {
    isClosed: () => false,
    async evaluate(fn, argument) { return fn(argument); },
  };

  await withFakeDom(fakeDom, async () => {
    await renderImageTaskStatusPanel(page, {
      activeCount: 2,
      timestamp: nowValue,
      tasks: [
        {
          id: 'malicious-task-12345',
          startedAt: nowValue - 3599000,
          stage: '<img src=x onerror=alert(1)>',
          detail: '<script>bad()</script>',
          state: 'running',
        },
        {
          id: 'hour-task-67890',
          startedAt: nowValue - 3600000,
          stage: '生成中',
          detail: '',
          state: 'running',
        },
      ],
    });

    const panel = fakeDom.document.getElementById('seedance-image-task-status-panel');
    const list = panel.children[1];
    const elements = fakeDom.walk(panel);
    const elapsed = elements.filter((element) => Object.hasOwn(element.dataset, 'startedAt'));
    assert.equal(fakeDom.intervalCallbacks.length, 1);
    assert.deepEqual(elapsed.map((element) => element.textContent), ['59:59', '01:00:00']);
    assert.ok(elements.some((element) => element.textContent === '<img src=x onerror=alert(1)>'));
    assert.ok(elements.some((element) => element.textContent === '<script>bad()</script>'));
    assert.equal(elements.some((element) => ['IMG', 'SCRIPT'].includes(element.tagName)), false);
    assert.equal(panel.style.pointerEvents, 'none');
    assert.equal(elements.some((element) => element.style.pointerEvents === 'auto'), false);
    assert.equal(panel.style.maxHeight, 'calc(100vh - 40px)');
    assert.equal(list.style.overflowY, 'auto');
    assert.equal(list.scrollTop, list.scrollHeight - list.clientHeight);

    await renderImageTaskStatusPanel(page, { activeCount: 0, tasks: [], timestamp: nowValue });
    const emptyList = panel.children[1];
    assert.equal(fakeDom.intervalCallbacks.length, 1);
    assert.equal(emptyList.textContent, '当前无任务');
    assert.equal(panel.textContent.includes('<script>bad()</script>'), false);
  });
});

test('the single elapsed interval cycles long task lists without affecting short lists', async () => {
  const nowValue = 1700003600000;
  const fakeDom = createFakeDom(nowValue);
  const page = {
    isClosed: () => false,
    async evaluate(fn, argument) { return fn(argument); },
  };
  const task = (id) => ({
    id,
    startedAt: nowValue,
    stage: '等待',
    detail: '',
    state: 'running',
  });

  await withFakeDom(fakeDom, async () => {
    await renderImageTaskStatusPanel(page, {
      activeCount: 4,
      tasks: [task('first'), task('second'), task('third'), task('fourth')],
      timestamp: nowValue,
    });
    const panel = fakeDom.document.getElementById('seedance-image-task-status-panel');
    const longList = panel.children[1];
    const tick = fakeDom.intervalCallbacks[0];
    assert.equal(fakeDom.intervalCallbacks.length, 1);
    assert.equal(longList.scrollHeight, 400);
    assert.equal(longList.clientHeight, 100);
    assert.equal(longList.scrollTop, 300);

    tick(); tick(); tick();
    assert.equal(longList.scrollTop, 0);
    tick(); tick(); tick();
    assert.equal(longList.scrollTop, 100);
    tick(); tick(); tick();
    assert.equal(longList.scrollTop, 200);
    tick(); tick(); tick();
    assert.equal(longList.scrollTop, 300);
    tick(); tick(); tick();
    assert.equal(longList.scrollTop, 0);

    await renderImageTaskStatusPanel(page, {
      activeCount: 1,
      tasks: [task('only')],
      timestamp: nowValue,
    });
    const shortList = panel.children[1];
    assert.equal(fakeDom.intervalCallbacks.length, 1);
    assert.equal(shortList.scrollHeight, shortList.clientHeight);
    assert.equal(shortList.scrollTop, 0);
    tick(); tick(); tick();
    assert.equal(shortList.scrollTop, 0);
  });
});

test('a terminal task from the middle is rendered last, immediately visible, and kept for three seconds', async () => {
  let currentNow = 1000;
  let nextTimerId = 1;
  const timers = new Map();
  const fakeDom = createFakeDom(currentNow);
  const page = {
    isClosed: () => false,
    async evaluate(fn, argument) { return fn(argument); },
  };
  const panel = createImageTaskStatusPanel({
    now: () => currentNow,
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, dueAt: currentNow + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  const runDueTimers = () => {
    [...timers.entries()].filter(([, timer]) => timer.dueAt <= currentNow).forEach(([id, timer]) => {
      timers.delete(id);
      timer.callback();
    });
  };

  await withFakeDom(fakeDom, async () => {
    panel.attachPage(page);
    ['first', 'middle', 'third', 'fourth', 'fifth', 'sixth'].forEach((id) => panel.add(id, 1000));
    await panel.flush();
    currentNow = 2000;
    panel.succeed('middle', '完成结果');
    await panel.flush();

    assert.deepEqual(panel.snapshot().tasks.map(({ id }) => id), [
      'first', 'middle', 'third', 'fourth', 'fifth', 'sixth',
    ]);
    const list = fakeDom.document.getElementById('seedance-image-task-status-panel').children[1];
    assert.deepEqual(list.children.map((row) => row.textContent.includes('middle')), [
      false, false, false, false, false, true,
    ]);
    assert.equal(list.scrollTop, list.scrollHeight - list.clientHeight);

    currentNow = 4999;
    runDueTimers();
    assert.equal(panel.snapshot().tasks.some(({ id }) => id === 'middle'), true);
    currentNow = 5000;
    runDueTimers();
    await panel.flush();
    assert.equal(panel.snapshot().tasks.some(({ id }) => id === 'middle'), false);
  });
});

test('ordinary updates preserve pagination position and rotation progress across full rerenders', async () => {
  const nowValue = 1700003600000;
  const fakeDom = createFakeDom(nowValue);
  const page = {
    isClosed: () => false,
    async evaluate(fn, argument) { return fn(argument); },
  };
  const tasks = ['first', 'second', 'third', 'fourth'].map((id) => ({
    id,
    startedAt: nowValue,
    stage: '等待',
    detail: '',
    state: 'running',
  }));

  await withFakeDom(fakeDom, async () => {
    await renderImageTaskStatusPanel(page, { activeCount: 4, tasks, timestamp: nowValue });
    const panel = fakeDom.document.getElementById('seedance-image-task-status-panel');
    const tick = fakeDom.intervalCallbacks[0];
    tick(); tick(); tick();
    tick(); tick(); tick();
    assert.equal(panel.children[1].scrollTop, 100);

    await renderImageTaskStatusPanel(page, {
      activeCount: 4,
      tasks: tasks.map((task, index) => ({
        ...task,
        stage: index === 1 ? '阶段已更新' : task.stage,
        detail: index === 1 ? '详情已更新' : task.detail,
      })),
      timestamp: nowValue,
    });
    assert.equal(panel.children[1].scrollTop, 100);

    tick(); tick(); tick();
    assert.equal(panel.children[1].scrollTop, 200);
  });
});
