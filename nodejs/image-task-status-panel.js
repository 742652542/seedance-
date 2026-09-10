export async function renderImageTaskStatusPanel(page, snapshot) {
  if (!page) return;
  try {
    if (typeof page.isClosed === 'function' && page.isClosed()) return;
  } catch {
    return;
  }

  const safeSnapshot = {
    activeCount: Number(snapshot?.activeCount) || 0,
    tasks: Array.isArray(snapshot?.tasks) ? snapshot.tasks.map((task) => {
      const safeTask = {
        id: String(task?.id ?? ''),
        startedAt: Number(task?.startedAt) || 0,
        stage: String(task?.stage ?? ''),
        detail: String(task?.detail ?? ''),
        state: ['running', 'success', 'error'].includes(task?.state) ? task.state : 'running',
      };
      if (Number.isFinite(task?.finishedAt)) safeTask.finishedAt = Number(task.finishedAt);
      return safeTask;
    }) : [],
    timestamp: Number(snapshot?.timestamp) || Date.now(),
  };

  await page.evaluate((currentSnapshot) => {
    const panelId = 'seedance-image-task-status-panel';
    const paginationKey = '__seedanceImageTaskPagination';
    const makeElement = (tag, cssText, text) => {
      const element = document.createElement(tag);
      if (cssText) element.style.cssText = cssText;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const formatElapsed = (elapsedMs) => {
      const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
      const seconds = String(totalSeconds % 60).padStart(2, '0');
      const minutes = String(Math.floor(totalSeconds / 60) % 60).padStart(2, '0');
      if (elapsedMs >= 3600000) {
        const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
      }
      return `${minutes}:${seconds}`;
    };
    const updateElapsed = () => {
      document.querySelectorAll(`#${panelId} [data-started-at]`).forEach((element) => {
        const startedAt = Number(element.dataset.startedAt);
        element.textContent = formatElapsed(Date.now() - startedAt);
      });
    };
    const rotateLongList = () => {
      const list = document.getElementById(`${panelId}-task-list`);
      const pagination = window[paginationKey];
      if (!list || list.scrollHeight <= list.clientHeight) {
        if (list) list.scrollTop = 0;
        return;
      }
      const lastPageTop = list.scrollHeight - list.clientHeight;
      if (pagination?.hasTerminal) {
        const terminalStartTop = Math.min(lastPageTop, pagination.terminalStartTop);
        list.scrollTop = list.scrollTop >= lastPageTop
          ? terminalStartTop
          : Math.min(list.scrollTop + list.clientHeight, lastPageTop);
        pagination.scrollTop = list.scrollTop;
        return;
      }
      list.scrollTop = list.scrollTop >= lastPageTop
        ? 0
        : Math.min(list.scrollTop + list.clientHeight, lastPageTop);
      if (pagination) pagination.scrollTop = list.scrollTop;
    };

    let panel = document.getElementById(panelId);
    if (!panel) {
      panel = document.createElement('section');
      panel.id = panelId;
      panel.style.cssText = [
        'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483647',
        'width:340px', 'max-width:calc(100vw - 40px)', 'padding:16px',
        'max-height:calc(100vh - 40px)', 'display:flex', 'flex-direction:column',
        'border:1px solid rgba(255,255,255,.16)', 'border-radius:14px',
        'background:rgba(17,24,39,.94)', 'box-shadow:0 16px 45px rgba(0,0,0,.32)',
        'color:#f8fafc', 'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'backdrop-filter:blur(12px)', 'pointer-events:none',
      ].join(';');
      document.body.appendChild(panel);
    }

    const header = makeElement('div', 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;flex-shrink:0');
    header.appendChild(makeElement('strong', 'font-size:15px', 'Seedance 生图任务'));
    header.appendChild(makeElement('span', 'color:#60a5fa;font-weight:700', `执行中 ${currentSnapshot.activeCount} 个`));

    const content = makeElement('div', 'display:flex;flex-direction:column;gap:9px;min-height:0;overflow-y:auto');
    content.id = `${panelId}-task-list`;
    const visualTasks = currentSnapshot.tasks
      .map((task, index) => ({ task, index }))
      .sort((left, right) => {
        const leftTerminal = left.task.state === 'running' ? 0 : 1;
        const rightTerminal = right.task.state === 'running' ? 0 : 1;
        return leftTerminal - rightTerminal || left.index - right.index;
      })
      .map(({ task }) => task);
    if (visualTasks.length === 0) {
      content.appendChild(makeElement('div', 'color:#94a3b8;padding:5px 0', '当前无任务'));
    } else {
      visualTasks.forEach((task) => {
        const color = task.state === 'success' ? '#34d399' : task.state === 'error' ? '#fb7185' : '#60a5fa';
        const label = task.state === 'success' ? '已完成' : task.state === 'error' ? '执行失败' : '执行中';
        const id = task.id.length > 14 ? `${task.id.slice(0, 6)}...${task.id.slice(-5)}` : task.id;
        const row = makeElement('div', 'padding:9px 10px;border:1px solid rgba(255,255,255,.10);border-radius:10px;background:rgba(255,255,255,.04)');
        const top = makeElement('div', 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px');
        top.appendChild(makeElement('span', 'color:#94a3b8;font-size:12px;word-break:break-all', id));
        top.appendChild(makeElement('span', `color:${color};font-size:12px;font-weight:700;white-space:nowrap`, label));
        row.appendChild(top);
        row.appendChild(makeElement('div', `color:${color};font-weight:650;word-break:break-word`, task.stage));
        if (task.detail) row.appendChild(makeElement('div', 'color:#cbd5e1;margin-top:3px;word-break:break-word', task.detail));
        const elapsedRow = makeElement('div', 'display:flex;justify-content:flex-end;color:#64748b;font-size:12px;margin-top:5px');
        const elapsed = makeElement('span', '', '00:00');
        elapsed.dataset.startedAt = String(task.startedAt);
        elapsedRow.appendChild(elapsed);
        row.appendChild(elapsedRow);
        content.appendChild(row);
      });
    }

    panel.replaceChildren(header, content);
    const previousPagination = window[paginationKey] || {
      taskIds: [],
      scrollTop: 0,
      ticks: 0,
      hasTerminal: false,
    };
    const taskIds = currentSnapshot.tasks.map((task) => task.id);
    const sameStructure = taskIds.length === previousPagination.taskIds.length
      && taskIds.every((id) => previousPagination.taskIds.includes(id));
    const tasksAdded = taskIds.length > previousPagination.taskIds.length
      && previousPagination.taskIds.every((id) => taskIds.includes(id));
    const terminalCount = visualTasks.filter((task) => task.state !== 'running').length;
    const lastPageTop = Math.max(0, content.scrollHeight - content.clientHeight);
    const runningRatio = visualTasks.length === 0 ? 0 : (visualTasks.length - terminalCount) / visualTasks.length;
    const terminalStartTop = Math.min(lastPageTop, Math.round(content.scrollHeight * runningRatio));
    let nextScrollTop = Math.min(previousPagination.scrollTop, lastPageTop);
    if (terminalCount > 0) {
      nextScrollTop = !previousPagination.hasTerminal || !sameStructure
        ? lastPageTop
        : Math.max(terminalStartTop, nextScrollTop);
    } else if (tasksAdded) {
      nextScrollTop = lastPageTop;
    }
    if (content.scrollHeight <= content.clientHeight) nextScrollTop = 0;
    content.scrollTop = nextScrollTop;
    window[paginationKey] = {
      taskIds,
      scrollTop: nextScrollTop,
      ticks: previousPagination.ticks,
      hasTerminal: terminalCount > 0,
      terminalStartTop,
    };
    updateElapsed();
    if (window.__seedanceImageTaskElapsedTimer == null) {
      window.__seedanceImageTaskElapsedTimer = window.setInterval(() => {
        updateElapsed();
        const pagination = window[paginationKey];
        if (!pagination) return;
        pagination.ticks += 1;
        if (pagination.ticks % 3 === 0) rotateLongList();
      }, 1000);
    }
  }, safeSnapshot);
}

export function createImageTaskStatusPanel(options = {}) {
  const now = options.now || Date.now;
  const terminalDelayMs = options.terminalDelayMs ?? 3000;
  const terminalFallbackMs = options.terminalFallbackMs ?? Math.max(30000, terminalDelayMs * 10);
  const scheduleTimeout = options.setTimeout || globalThis.setTimeout;
  const cancelTimeout = options.clearTimeout || globalThis.clearTimeout;
  const render = options.render || renderImageTaskStatusPanel;
  const log = options.log || console.error;
  const tasks = new Map();
  const removalTimers = new Map();
  const fallbackDeadlines = new Map();
  const visibleGenerations = new Map();
  const pendingTerminalRenders = new Map();
  let nextGenerationId = 1;

  function createGeneration(page) {
    let invalidate;
    return {
      id: nextGenerationId++,
      page,
      chain: Promise.resolve(),
      invalidated: new Promise((resolve) => { invalidate = resolve; }),
      invalidate,
    };
  }

  let currentGeneration = createGeneration(null);

  function isPageClosed(target) {
    if (!target) return true;
    try {
      return target.isClosed();
    } catch {
      return true;
    }
  }

  function logRenderError(error) {
    try {
      log(error);
    } catch {}
  }

  function markTerminalRenderPending(id, generationId) {
    const pending = pendingTerminalRenders.get(id);
    if (pending?.generationId === generationId) {
      pending.count += 1;
    } else {
      pendingTerminalRenders.set(id, { generationId, count: 1 });
    }
  }

  function settleTerminalRender(id, generationId) {
    const pending = pendingTerminalRenders.get(id);
    if (pending?.generationId !== generationId) return;
    if (pending.count > 1) pending.count -= 1;
    else pendingTerminalRenders.delete(id);
  }

  function removeTask(id, timer) {
    if (removalTimers.get(id) !== timer) return;
    cancelTimeout(timer);
    removalTimers.delete(id);
    fallbackDeadlines.delete(id);
    visibleGenerations.delete(id);
    pendingTerminalRenders.delete(id);
    tasks.delete(id);
    publish();
  }

  function scheduleRemoval(id, delay) {
    const previousTimer = removalTimers.get(id);
    if (previousTimer !== undefined) cancelTimeout(previousTimer);
    const timer = scheduleTimeout(() => {
      if (removalTimers.get(id) !== timer) return;
      const pending = pendingTerminalRenders.get(id);
      const deadline = fallbackDeadlines.get(id) ?? 0;
      if (pending?.generationId === currentGeneration.id && now() < deadline) {
        scheduleRemoval(id, Math.min(terminalDelayMs, deadline - now()));
        return;
      }
      removeTask(id, timer);
    }, delay);
    removalTimers.set(id, timer);
  }

  function terminalRendered(id, generation) {
    if (generation !== currentGeneration || !tasks.has(id)) return;
    if (visibleGenerations.get(id) === generation.id) return;
    visibleGenerations.set(id, generation.id);
    pendingTerminalRenders.delete(id);
    scheduleRemoval(id, terminalDelayMs);
  }

  function publish() {
    const generation = currentGeneration;
    const targetPage = generation.page;
    if (isPageClosed(targetPage)) return;

    const current = snapshot();
    const renderSnapshot = JSON.parse(JSON.stringify({
      activeCount: current.activeCount,
      tasks: current.tasks.map((task) => {
        const publishedTask = {
          id: String(task.id ?? ''),
          startedAt: Number(task.startedAt) || 0,
          stage: String(task.stage ?? ''),
          detail: String(task.detail ?? ''),
          state: ['running', 'success', 'error'].includes(task.state) ? task.state : 'running',
        };
        if (Number.isFinite(task.finishedAt)) publishedTask.finishedAt = Number(task.finishedAt);
        return publishedTask;
      }),
      timestamp: Number(now()),
    }));
    const terminalIds = renderSnapshot.tasks
      .filter((task) => task.state !== 'running' && visibleGenerations.get(task.id) !== generation.id)
      .map((task) => task.id);
    terminalIds.forEach((id) => markTerminalRenderPending(id, generation.id));

    generation.chain = generation.chain.then(async () => {
      if (generation !== currentGeneration || isPageClosed(targetPage)) {
        terminalIds.forEach((id) => settleTerminalRender(id, generation.id));
        return;
      }
      try {
        await render(targetPage, renderSnapshot);
        terminalIds.forEach((id) => terminalRendered(id, generation));
      } catch (error) {
        terminalIds.forEach((id) => settleTerminalRender(id, generation.id));
        logRenderError(error);
      }
    });
  }

  function snapshot() {
    const entries = [...tasks.values()].map((task) => ({ ...task }));
    return {
      activeCount: entries.filter((task) => task.state === 'running').length,
      tasks: entries,
    };
  }

  function add(id, startedAt = now()) {
    if (tasks.has(id)) return;
    tasks.set(id, {
      id,
      startedAt,
      stage: '等待任务执行',
      detail: '',
      state: 'running',
    });
    publish();
  }

  function update(id, stage, detail = '') {
    const task = tasks.get(id);
    if (!task || task.state !== 'running') return;
    task.stage = stage;
    task.detail = detail;
    publish();
  }

  function finish(id, state, stage, detail) {
    const task = tasks.get(id);
    if (!task || task.state !== 'running') return;

    task.state = state;
    task.stage = stage;
    task.detail = detail;
    task.finishedAt = now();
    fallbackDeadlines.set(id, task.finishedAt + terminalFallbackMs);
    publish();
    scheduleRemoval(id, terminalDelayMs);
  }

  function succeed(id, detail = '') {
    finish(id, 'success', '已完成', detail);
  }

  function fail(id, detail = '') {
    finish(id, 'error', '执行失败', detail);
  }

  function attachPage(nextPage) {
    currentGeneration.invalidate();
    currentGeneration = createGeneration(nextPage || null);
    publish();
  }

  async function flush() {
    while (true) {
      const generation = currentGeneration;
      const pending = generation.chain;
      await Promise.race([pending, generation.invalidated]);
      if (generation === currentGeneration && pending === generation.chain) return;
    }
  }

  return { snapshot, add, update, succeed, fail, attachPage, flush };
}
