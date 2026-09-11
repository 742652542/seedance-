import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createVideoTempImages, materializeVideoImages } from './video-temp-images.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let activeBrowserURL = process.env.BROWSER_URL || '';
const TEAM_ID = process.env.TEAM_ID || '6a90faa57906980889d712fd';
const PROJECT_DATE = process.env.PROJECT_DATE || new Date().toLocaleDateString('en-CA');
const GENERATION_TIMEOUT_MS = Number(process.env.GENERATION_TIMEOUT_MS || 15 * 60 * 1000);
const SUBMIT_DELAY_MS = Number(process.env.SUBMIT_DELAY_MS || 3 * 1000);
const TEMP_ROOT = path.join(__dirname, 'tmp-upload-images');
const TASK_ID = process.env.SEEDANCE_TASK_ID || `dramart-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${randomUUID().replace(/-/g, '').slice(0, 5)}`;
const TASK_STARTED_AT = new Date().toLocaleString('zh-CN', { hour12: false });

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function loadRequest() {
  const jsonArg = argValue('json');
  const dataArg = argValue('data');
  if (dataArg) return JSON.parse(dataArg);
  if (process.env.SEEDANCE_REQUEST_JSON) return JSON.parse(process.env.SEEDANCE_REQUEST_JSON);
  if (jsonArg) return JSON.parse(await fs.readFile(path.resolve(jsonArg), 'utf8'));
  throw new Error('请通过 --json=请求文件、--data=JSON 或 SEEDANCE_REQUEST_JSON 传入参数');
}

function normalizeRequest(request) {
  const content = Array.isArray(request.content) ? request.content : [];
  const promptFromContent = content.find((item) => item?.type === 'text')?.text;
  const imageItemsFromContent = content.filter((item) => item?.type === 'image_url');
  const rawImages = request.images ?? request.image ?? imageItemsFromContent;
  const images = Array.isArray(rawImages) ? rawImages : rawImages ? [rawImages] : [];
  const imageType = inferImageType(request.image_type, images, imageItemsFromContent);

  return {
    model: request.model || 'Doubao-Seedance-2.0-fast',
    prompt: String(request.prompt ?? promptFromContent ?? '').trim(),
    resolution: request.resolution || '720p',
    ratio: request.ratio || '16:9',
    duration: Number(request.duration || 5),
    output_format: String(request.output_format || 'mp4').toLowerCase(),
    image_type: imageType,
    images,
  };
}

function inferImageType(defaultType, images, contentImages) {
  const roles = [...images, ...contentImages]
    .map((item) => (typeof item === 'object' ? item.type || item.role : null))
    .filter(Boolean);
  if (roles.includes('first_frame') || roles.includes('last_frame')) return 'image_to_video';
  return defaultType || 'reference_image';
}

function imageValue(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const imageUrl = item.image_url;
  if (typeof imageUrl === 'string') return imageUrl;
  if (imageUrl && typeof imageUrl === 'object') return imageUrl.url || '';
  return item.url || item.image || '';
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateTaskStatus(page, step, detail = '', state = 'running') {
  if (!page || page.isClosed()) return;
  await page.evaluate(({ taskId, startedAt, stepText, detailText, status }) => {
    const panelId = 'seedance-task-status-panel';
    let panel = document.getElementById(panelId);
    if (!panel) {
      panel = document.createElement('section');
      panel.id = panelId;
      panel.style.cssText = [
        'position:fixed', 'right:20px', 'bottom:70px', 'z-index:2147483647',
        'width:340px', 'max-width:calc(100vw - 40px)', 'padding:16px',
        'border:1px solid rgba(255,255,255,.16)', 'border-radius:14px',
        'background:rgba(17,24,39,.94)', 'box-shadow:0 16px 45px rgba(0,0,0,.32)',
        'color:#f8fafc', 'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'backdrop-filter:blur(12px)', 'pointer-events:none',
      ].join(';');
      document.body.appendChild(panel);
    }
    const color = status === 'success' ? '#34d399' : status === 'error' ? '#fb7185' : '#60a5fa';
    const label = status === 'success' ? '已完成' : status === 'error' ? '执行失败' : '执行中';
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px">
        <strong style="font-size:15px">Seedance 视频任务</strong>
        <span style="color:${color};font-weight:700">${label}</span>
      </div>
      <div style="color:#94a3b8;margin-bottom:3px">任务 ID</div>
      <div style="word-break:break-all;margin-bottom:9px">${taskId}</div>
      <div style="color:#94a3b8;margin-bottom:3px">当前步骤</div>
      <div style="color:${color};font-weight:650;margin-bottom:${detailText ? '7px' : '9px'}">${stepText}</div>
      ${detailText ? `<div style="color:#cbd5e1;word-break:break-word;margin-bottom:9px">${detailText}</div>` : ''}
      <div style="display:flex;justify-content:space-between;color:#64748b;font-size:12px">
        <span>开始：${startedAt}</span><span>更新：${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</span>
      </div>`;
  }, { taskId: TASK_ID, startedAt: TASK_STARTED_AT, stepText: step, detailText: detail, status: state }).catch(() => {});
}

async function setViewportToWindow(page) {
  await page.setViewport({ width: 1920, height: 920 });
}

function browserConnectOptions(endpoint) {
  return String(endpoint).startsWith('ws:') || String(endpoint).startsWith('wss:')
    ? { browserWSEndpoint: endpoint, defaultViewport: { width: 1920, height: 920 } }
    : { browserURL: endpoint, defaultViewport: { width: 1920, height: 920 } };
}

function versionURL(endpoint) {
  if (!String(endpoint).startsWith('ws')) return `${endpoint.replace(/\/$/, '')}/json/version`;
  return endpoint.replace(/^ws/, 'http').replace(/\/devtools\/browser\/.+$/, '/json/version');
}

async function resolveBrowserURL() {
  if (activeBrowserURL) {
    try {
      const response = await fetch(versionURL(activeBrowserURL), { signal: AbortSignal.timeout(3000) });
      if (response.ok) return activeBrowserURL;
    } catch {
      activeBrowserURL = '';
    }
  }

  throw new Error('父服务提供的 BROWSER_URL 不可用，请重新启动 Seedance 任务服务');
}

export async function ensureProjectForRatioApi({ teamId, projectDate, ratio, pageSize = 100, maxPages = 100, api } = {}) {
      let post = api?.post;
      if (!post) {
      const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
      const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
      if (!token) throw new Error('localStorage 中没有 DRAMART_AUTH_TOKEN，请先登录');
      const headers = {
        'content-type': 'application/json',
        Authorization: token,
        'X-Vsd-Auth-Token': token,
        'X-Vsd-Refresh-Token': refreshToken || '',
      };
      post = async (requestPath, body) => {
        const response = await fetch(requestPath, { method: 'POST', headers, body: JSON.stringify(body) });
        const data = await response.json();
        if (!response.ok) throw new Error(`${requestPath} HTTP ${response.status}: ${JSON.stringify(data)}`);
        return data;
      };
      }

      const projectName = `${projectDate}-${ratio}`;
      const projects = [];
      const seen = new Set();
      let knownTotal = null;
      for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
        const listResult = await post('/proxy/api/v1/project/list', {
          TeamId: teamId,
          Filters: { CreationMode: 'agent,manual' },
          PageIndex: pageIndex,
          PageSize: pageSize,
        });
        const container = listResult?.Result ?? listResult?.result ?? listResult ?? {};
        const items = container.Items ?? container.items ?? [];
        if (!Array.isArray(items)) throw new Error(`项目分页返回的 Items 不是数组: ${JSON.stringify(listResult)}`);

        let added = 0;
        for (const project of items) {
          const projectId = project?.ProjectId ?? project?.projectId;
          const key = projectId ? `id:${projectId}` : `item:${JSON.stringify(project)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          projects.push(project);
          added += 1;
        }

        const rawTotal = container.Total ?? container.TotalCount ?? container.total ?? container.totalCount ??
          container.Pagination?.Total ?? container.Pagination?.TotalCount ??
          container.pagination?.total ?? container.pagination?.totalCount ??
          listResult?.Total ?? listResult?.TotalCount ?? listResult?.total ?? listResult?.totalCount;
        const total = Number(rawTotal);
        if (Number.isFinite(total) && total >= 0) knownTotal = knownTotal === null ? total : Math.max(knownTotal, total);
        if (added === 0 && projects.length > 0) throw new Error(`项目分页第 ${pageIndex} 页没有新增项目，服务可能忽略 PageIndex`);
        if (knownTotal !== null && projects.length >= knownTotal) break;
        if (knownTotal === null && items.length < pageSize) break;
        if (pageIndex === maxPages) throw new Error(`项目分页超过最大页数 ${maxPages}，无法确认列表完整`);
      }

      const itemTime = (item) => Math.max(
        Date.parse(item?.CreatedAt || '') || 0,
        Date.parse(item?.UpdatedAt || '') || 0,
      );
      const existing = projects
        .filter((project) => (project.ProjectName ?? project.projectName) === projectName)
        .sort((a, b) => itemTime(b) - itemTime(a))[0];

      if (existing) {
        const existingProjectId = existing.ProjectId ?? existing.projectId;
        const existingScriptId = existing.ScriptId ?? existing.scriptId;
        const existingTeamId = existing.TeamId ?? existing.teamId ?? teamId;
        return {
          action: 'exists',
          projectName,
          projectId: existingProjectId,
          scriptId: existingScriptId,
          teamId: existingTeamId,
          url: `https://work.xiaomaomi.cn/dramart/project/${existingProjectId}/${existingScriptId}/${existingTeamId}`,
        };
      }

      const createResult = await post('/proxy/api/v1/project/create', {
        TeamId: teamId,
        AspectRatio: ratio,
        Resolution: '720p',
        Language: 'en',
        VisualPromptId: '6a9658a204b6dbdd6d21ce84',
        CreationMode: 'manual',
      });

      const createData = createResult?.Result ?? createResult?.result ?? {};
      const projectId = createData.ProjectId ?? createData.projectId;
      const scriptId = createData.ScriptId ?? createData.scriptId;
      if (!projectId || !scriptId) throw new Error(`创建项目返回缺少 ID: ${JSON.stringify(createResult)}`);

      await post('/proxy/api/v1/project/update', { ProjectName: projectName, ProjectId: projectId, TeamId: teamId });
      const confirmResult = await post('/proxy/api/v1/project/update', {
        Status: 'resource_confirmed',
        ProjectId: projectId,
        TeamId: teamId,
      });

      return {
        action: 'created',
        projectName,
        projectId,
        scriptId,
        teamId,
        status: (confirmResult?.Result ?? confirmResult?.result)?.Status ??
          (confirmResult?.Result ?? confirmResult?.result)?.status,
        url: `https://work.xiaomaomi.cn/dramart/project/${projectId}/${scriptId}/${teamId}`,
      };
}

async function ensureProjectForRatio(page, ratio) {
  await page.goto('https://work.xiaomaomi.cn/dramart/projectlist/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});

  const result = await page.evaluate(ensureProjectForRatioApi, {
    teamId: TEAM_ID,
    projectDate: PROJECT_DATE,
    ratio,
  });

  console.log('比例项目检查结果:', result);
  await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
  return result;
}

export async function createTaskEpisodeApi({ context, pageSize = 1000, maxPages = 100, api } = {}) {
    let post = api?.post;
    const sleep = api?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (!post) {
    const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
    const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
    const headers = {
      'content-type': 'application/json',
      Authorization: token,
      'X-Vsd-Auth-Token': token,
      'X-Vsd-Refresh-Token': refreshToken || '',
    };
    post = async (path, body) => {
      const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${JSON.stringify(data)}`);
      return data;
    };
    }

    let ids = context;
    if (!ids) {
      const match = location.href.match(/\/dramart\/project\/(project_[^/]+)\/(script_[^/]+)\/([^?/#]+)/);
      if (!match) throw new Error('当前页面缺少项目 ID');
      ids = { ProjectId: match[1], ScriptId: match[2], TeamId: match[3] };
    }
    const { ProjectId, ScriptId, TeamId } = ids;

    const episodes = [];
    const seen = new Set();
    let knownTotal = null;
    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
      const episodeList = await post('/proxy/api/v1/episode/list', {
        TeamId,
        ProjectId,
        Filters: { ScriptId },
        PageIndex: pageIndex,
        PageSize: pageSize,
      });
      const container = episodeList?.Result ?? episodeList?.result ?? episodeList ?? {};
      const items = container.Items ?? container.items ?? [];
      if (!Array.isArray(items)) throw new Error(`集分页返回的 Items 不是数组: ${JSON.stringify(episodeList)}`);

      let added = 0;
      for (const item of items) {
        const episodeId = item?.EpisodeId ?? item?.episodeId;
        const key = episodeId ? `id:${episodeId}` : `item:${JSON.stringify(item)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        episodes.push(item);
        added += 1;
      }

      const rawTotal = container.Total ?? container.TotalCount ?? container.total ?? container.totalCount ??
        container.Pagination?.Total ?? container.Pagination?.TotalCount ??
        container.pagination?.total ?? container.pagination?.totalCount ??
        episodeList?.Total ?? episodeList?.TotalCount ?? episodeList?.total ?? episodeList?.totalCount;
      const total = Number(rawTotal);
      if (Number.isFinite(total) && total >= 0) knownTotal = knownTotal === null ? total : Math.max(knownTotal, total);
      if (added === 0 && episodes.length > 0) throw new Error(`集分页第 ${pageIndex} 页没有新增集，服务可能忽略 PageIndex`);
      if (knownTotal !== null && episodes.length >= knownTotal) break;
      if (knownTotal === null && items.length < pageSize) break;
      if (pageIndex === maxPages) throw new Error(`集分页超过最大页数 ${maxPages}，无法确认列表完整`);
    }

    const itemTime = (item) => Date.parse(item?.CreatedAt ?? item?.createdAt ?? item?.UpdatedAt ?? item?.updatedAt ?? '') || 0;
    const previousEpisode = episodes.sort((a, b) => itemTime(b) - itemTime(a))[0];
    if (!previousEpisode) throw new Error('当前项目没有可作为锚点的集');

    const createResult = await post('/proxy/api/v1/episode/create', {
      TeamId,
      ProjectId,
      ScriptId,
      PreviousEpisodeId: previousEpisode.EpisodeId ?? previousEpisode.episodeId,
    });

    const createData = createResult?.Result ?? createResult?.result ?? {};
    const newEpisodeId = createData.EpisodeId ?? createData.episodeId;
    if (!newEpisodeId) throw new Error(`创建集返回缺少 EpisodeId: ${JSON.stringify(createResult)}`);

    let shot = null;
    for (let index = 0; index < 10; index += 1) {
      const shotList = await post('/proxy/api/v1/shot/list', {
        TeamId,
        ProjectId,
        Filters: { EpisodeId: newEpisodeId },
        PageSize: 1000,
      });
      const shotData = shotList?.Result ?? shotList?.result ?? {};
      shot = (shotData.Items ?? shotData.items ?? [])[0] || null;
      if (shot?.ShotId ?? shot?.shotId) break;
      await sleep(500);
    }

    if (!(shot?.ShotId ?? shot?.shotId)) throw new Error(`新建集没有生成默认分镜: ${newEpisodeId}`);

    return {
      ProjectId,
      ScriptId,
      TeamId,
      EpisodeId: newEpisodeId,
      ShotId: shot.ShotId ?? shot.shotId,
      beforeEpisodeCount: episodes.length,
    };
}

async function createTaskEpisode(page) {
  const result = await page.evaluate(createTaskEpisodeApi, {});

  console.log('已通过 API 创建任务专用集:', result);
  await page.goto(
    `https://work.xiaomaomi.cn/dramart/project/${result.ProjectId}/${result.ScriptId}/${result.TeamId}?episodeId=${result.EpisodeId}&step=storyboard`,
    { waitUntil: 'domcontentloaded', timeout: 60000 },
  );
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
  await page.evaluate(() => {
    const scrollers = Array.from(document.querySelectorAll('.flex-1.min-h-0.overflow-auto, .content-GHG0k7, .rightSection-AXlKsd'));
    for (const item of scrollers) item.scrollTop = item.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  });
  await wait(1500);
  return result;
}

async function getTaskShotModule(page) {
  await page.waitForSelector('.aml-draggable-sort-list__list-item', { timeout: 30000 });
  const modules = await page.$$('.aml-draggable-sort-list__list-item');
  const module = modules[0];
  if (!module) throw new Error('没有找到分镜模块');
  await module.evaluate((element) => {
    element.scrollIntoView({ block: 'end', inline: 'center' });
    const nested = Array.from(element.querySelectorAll('div'));
    for (const item of nested) item.scrollTop = item.scrollHeight;
  });
  await wait(800);
  return module;
}

export async function openTaskPage(browser, onCreated, options = {}) {
  const marker = options.marker ?? process.env.SEEDANCE_TASK_PAGE_MARKER ?? '';
  let page;
  if (marker) {
    const pages = await browser.pages();
    for (const candidate of pages) {
      if (candidate.isClosed?.()) continue;
      const name = await candidate.evaluate(() => window.name).catch(() => '');
      if (name === marker) {
        page = candidate;
        break;
      }
    }
    if (!page) throw new Error(`没有找到父进程预创建的任务页面: ${marker}`);
  } else {
    page = await browser.newPage();
  }
  onCreated(page);
  const taskMarker = marker || `seedance-video-${TASK_ID}`;
  await page.evaluate((name) => { window.name = name; }, taskMarker);
  await (options.setViewport || setViewportToWindow)(page);
  await page.goto('https://work.xiaomaomi.cn/dramart/projectlist/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((name) => { window.name = name; }, taskMarker);
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
  return page;
}

async function clickText(page, texts, root = null) {
  const targets = Array.isArray(texts) ? texts : [texts];
  const rect = root
    ? await root.evaluate((container, targetTexts) => {
    const element = Array.from(container.querySelectorAll('button, label, span, div'))
      .filter((item) => {
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      })
      .find((item) => targetTexts.includes((item.innerText || item.textContent || '').trim()));
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    return element.getBoundingClientRect().toJSON();
  }, targets)
    : await page.evaluate((targetTexts) => {
    const element = Array.from(document.querySelectorAll('button, label, span, div'))
      .filter((item) => {
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      })
      .find((item) => targetTexts.includes((item.innerText || item.textContent || '').trim()));
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    return element.getBoundingClientRect().toJSON();
  }, targets);
  if (!rect) throw new Error(`没有找到文本: ${targets.join(' / ')}`);
  await page.mouse.click(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

async function chooseReferenceType(page, imageType, root) {
  if (imageType === 'image_to_video' || imageType === 'first_frame' || imageType === 'last_frame') {
    await clickText(page, ['Image to video', '首尾帧生视频', '图生视频'], root);
    return 'Image to video';
  }

  await clickText(page, ['Multimodal reference', '全能参考生视频'], root);
  return 'Multimodal reference';
}

async function selectDropdownOption(page, currentTexts, optionTexts, root = null) {
  const currentTargets = Array.isArray(currentTexts) ? currentTexts : [currentTexts];
  const optionTargets = Array.isArray(optionTexts) ? optionTexts : [optionTexts];
  const opened = root ? await root.evaluate((container, targets) => {
    const elements = Array.from(container.querySelectorAll('.arco-select, button, [role="combobox"], span, div'));
    const element = elements
      .filter((item) => {
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      })
      .filter((item) => targets.some((target) => (item.innerText || item.textContent || '').trim().includes(target)))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      })[0];
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.click();
    return true;
  }, currentTargets) : await page.evaluate((targets) => {
    const elements = Array.from(document.querySelectorAll('.arco-select, button, [role="combobox"], span, div'));
    const element = elements
      .filter((item) => {
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      })
      .filter((item) => targets.some((target) => (item.innerText || item.textContent || '').trim().includes(target)))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      })[0];
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.click();
    return true;
  }, currentTargets);
  if (!opened) return false;

  await wait(500);
  const selected = await page.evaluate((targets) => {
    const elements = Array.from(document.querySelectorAll('.arco-select-option, [role="option"], li, div, span'));
    const element = elements
      .filter((item) => {
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      })
      .filter((item) => {
        const text = (item.innerText || item.textContent || '').trim();
        return targets.some((target) => text === target || text.includes(target));
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      })[0];
    if (!element) return false;
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.click();
    return true;
  }, optionTargets);
  await wait(500);
  return selected;
}

export async function chooseModel(page, model, root) {
  const select = await root.$('.aml-arco-tag-is-dropdown');
  if (!select) throw new Error('没有找到分镜视频参数旁的模型下拉框');
  await select.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.click();
  });
  await wait(500);

  let targetOption = null;
  for (const option of await page.$$('.arco-dropdown-menu-item')) {
    const state = await option.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        text: (element.innerText || element.textContent || '').trim(),
        visible: bounds.width > 0 && bounds.height > 0,
      };
    });
    if (state.visible && state.text === model) {
      targetOption = option;
      break;
    }
  }
  if (!targetOption) throw new Error(`模型下拉框中没有找到请求模型: ${model}`);

  await targetOption.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.click();
  });
  await wait(500);
  const selectedModel = await root.evaluate((container) => {
    const value = container.querySelector('.aml-arco-tag-is-dropdown .arco-tag-content');
    return (value?.innerText || value?.textContent || '').trim();
  });
  if (selectedModel !== model) {
    throw new Error(`模型未按请求选中，期望 ${model}，实际 ${selectedModel || '未知'}`);
  }
  return selectedModel;
}

async function chooseCompactOption(page, value) {
  const text = String(value);
  const ok = await selectDropdownOption(page, [text, '5s', '720p', 'mp4', 'mov'], [text]);
  if (!ok) console.warn(`未能自动选择选项，可能页面当前已经是该值或控件未展开: ${text}`);
}

async function openVideoConfigPanel(page, root) {
  const opened = await root.evaluate((container) => {
    const target = Array.from(container.querySelectorAll('button, span, div'))
      .filter((item) => {
        const text = (item.innerText || item.textContent || '').trim();
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && (text === '...' || /\d+s \| .* \| .*p \| mp4/.test(text));
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const aText = (a.innerText || a.textContent || '').trim();
        const bText = (b.innerText || b.textContent || '').trim();
        const aScore = (aText === '...' ? 0 : 100000) - ar.top;
        const bScore = (bText === '...' ? 0 : 100000) - br.top;
        return aScore - bScore;
      })[0];
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    target.click();
    return true;
  });
  if (!opened) {
    const rect = await root.evaluate((container) => {
      const bounds = container.getBoundingClientRect();
      return {
        x: Math.min(bounds.left + 720, bounds.right - 120),
        y: bounds.bottom - 63,
      };
    });
    await page.mouse.click(rect.x, rect.y);
  }
  await wait(500);
}

async function configureVideoOptions(page, request, root) {
  let lastResult = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResult = await setVideoOptionsOnce(page, request, root);
    if (videoConfigMatches(lastResult.summary, request)) {
      console.log('视频配置结果:', { attempt, matched: true, ...lastResult });
      await page.keyboard.press('Escape');
      await wait(800);
      return;
    }
    console.warn('视频配置未生效，准备重试:', { attempt, expected: expectedVideoConfig(request), summary: lastResult.summary });
    await page.keyboard.press('Escape').catch(() => {});
    await wait(1000);
  }
  throw new Error(`视频配置未按请求保存，期望 ${JSON.stringify(expectedVideoConfig(request))}，实际 ${JSON.stringify(lastResult?.summary || null)}`);
}

async function setVideoOptionsOnce(page, request, root) {
  let durationRect = null;
  const targetDuration = String(request.duration);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await openVideoConfigPanel(page, root);
    durationRect = await page.evaluate(() => {
    const panel = Array.from(document.querySelectorAll('div'))
      .filter((item) => {
        const text = (item.innerText || item.textContent || '').trim();
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && text.includes('视频时长') && text.includes('视频格式');
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      })[0];
    if (!panel) return null;

    const durationInput = Array.from(panel.querySelectorAll('input')).find((input) => {
      const bounds = input.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    });
    return durationInput?.getBoundingClientRect().toJSON() || null;
    });
    if (durationRect) break;
    await page.keyboard.press('Escape').catch(() => {});
    await wait(700);
  }

  if (!durationRect) throw new Error('没有找到视频时长输入框');
  await page.mouse.click(durationRect.left + durationRect.width / 2, durationRect.top + durationRect.height / 2, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('input:focus', targetDuration, { delay: 20 });
  const durationChanged = await page.evaluate((duration) => {
    const panel = Array.from(document.querySelectorAll('div'))
      .filter((item) => {
        const text = (item.innerText || item.textContent || '').trim();
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && text.includes('视频时长') && text.includes('视频格式');
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      })[0];
    if (!panel) return { panel: false };

    const input = Array.from(panel.querySelectorAll('input')).find((item) => {
      const bounds = item.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    });
    if (!input) return { panel: true, input: false };

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, duration);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: duration }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    return { panel: true, input: true, value: input.value };
  }, targetDuration);
  await wait(1000);

  const resolutionChanged = await clickVideoConfigButton(page, request.resolution);
  await wait(1000);
  const outputFormatChanged = await clickVideoConfigButton(page, request.output_format);
  await wait(1000);
  const summary = await readVideoConfigSummary(page);

  return {
    duration: durationChanged,
    resolution: resolutionChanged,
    outputFormat: outputFormatChanged,
    summary,
  };
}

function expectedVideoConfig(request) {
  return {
    duration: `${Number(request.duration)}s`,
    resolution: String(request.resolution),
    outputFormat: String(request.output_format).toLowerCase(),
  };
}

function videoConfigMatches(summary, request) {
  const compact = String(summary?.compact || '');
  const expected = expectedVideoConfig(request);
  const duration = summary?.duration ? `${Number(summary.duration)}s` : '';
  const resolution = String(summary?.resolution || '');
  const outputFormat = String(summary?.outputFormat || '').toLowerCase();
  return (duration === expected.duration || compact.includes(expected.duration)) &&
    (resolution === expected.resolution || compact.includes(expected.resolution)) &&
    (outputFormat === expected.outputFormat || compact.toLowerCase().includes(expected.outputFormat));
}

async function clickVideoConfigButton(page, text) {
  return page.evaluate((targetText) => {
    const panel = Array.from(document.querySelectorAll('div'))
      .filter((item) => {
        const text = (item.innerText || item.textContent || '').trim();
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && text.includes('视频时长') && text.includes('视频格式');
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      })[0];
    if (!panel) return { panel: false };

    const buttons = Array.from(panel.querySelectorAll('button')).filter((item) => {
      const itemText = (item.innerText || item.textContent || '').trim();
      const bounds = item.getBoundingClientRect();
      return itemText === targetText && bounds.width > 0 && bounds.height > 0;
    });
    const button = buttons.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.left - br.left;
    })[0];
    if (!button) return { panel: true, clicked: false, targetText };
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    button.click();
    return { panel: true, clicked: true, targetText };
  }, text);
}

async function readVideoConfigSummary(page) {
  return page.evaluate(() => {
    const panel = Array.from(document.querySelectorAll('div'))
      .filter((item) => {
        const text = (item.innerText || item.textContent || '').trim();
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && text.includes('视频时长') && text.includes('视频格式');
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      })[0];
    const compact = Array.from(document.querySelectorAll('button, span, div'))
      .map((item) => (item.innerText || item.textContent || '').trim())
      .find((text) => /\d+s \| \d+个 \| \d+p \| mp4/.test(text));
    const durationInput = panel?.querySelector('input[aria-label="视频时长"]') ||
      Array.from(panel?.querySelectorAll('input') || []).find((input) => input.type !== 'range');
    const selectedButton = (values) => Array.from(panel?.querySelectorAll('button') || [])
      .filter((button) => values.includes((button.innerText || button.textContent || '').trim()))
      .find((button) => {
        const style = getComputedStyle(button);
        return Number.parseInt(style.fontWeight, 10) >= 600;
      });
    return {
      panel: Boolean(panel),
      compact: compact || '',
      duration: durationInput?.value || '',
      resolution: (selectedButton(['480p', '720p', '1080p', '4k'])?.innerText || '').trim(),
      outputFormat: (selectedButton(['mp4', 'mov'])?.innerText || '').trim().toLowerCase(),
      panelText: panel ? (panel.innerText || panel.textContent || '').trim() : '',
    };
  });
}

async function uploadImages(page, files, root) {
  if (!files.length) return;
  const input = await root.$('input[type="file"]');
  if (!input) throw new Error('没有找到图片上传 input[type=file]');
  await input.uploadFile(...files);
  await wait(3000);
}

async function clearExistingImages(page, root) {
  for (let index = 0; index < 10; index += 1) {
    const rect = await root.evaluate((container) => {
      const buttons = Array.from(container.querySelectorAll('button, span, div'))
        .filter((item) => {
          const text = (item.innerText || item.textContent || '').trim();
          const bounds = item.getBoundingClientRect();
          return text === '×' && bounds.width > 0 && bounds.height > 0;
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.top - br.top || ar.left - br.left;
        });
      const target = buttons[0];
      if (!target) return null;
      return target.getBoundingClientRect().toJSON();
    });

    if (!rect) return;
    await page.mouse.click(rect.left + rect.width / 2, rect.top + rect.height / 2);
    await wait(500);
  }
}

async function pastePrompt(page, prompt, root) {
  if (!prompt) throw new Error('prompt 不能为空');
  const ok = await root.evaluate((container, text) => {
    const editors = Array.from(container.querySelectorAll('[contenteditable="true"], textarea'))
      .filter((item) => {
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      })
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    const editor = editors[0];
    if (!editor) return false;
    editor.scrollIntoView({ block: 'center', inline: 'center' });
    editor.focus();
    if (editor.tagName === 'TEXTAREA') {
      editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return true;
  }, prompt);
  if (!ok) throw new Error('没有找到提示词输入框');
  await wait(800);
}

async function submitGeneration(page, root) {
  const clicked = await root.evaluate((container) => {
    const buttons = Array.from(container.querySelectorAll('button'))
      .map((button) => ({
        button,
        text: (button.innerText || button.textContent || '').trim(),
        rect: button.getBoundingClientRect(),
      }))
      .filter(({ button, rect }) => !button.disabled && rect.width > 0 && rect.height > 0)
      .filter(({ button, text }) =>
        button.className.includes('arco-btn-primary') ||
        text.includes('生成') ||
        /^\d+(,\d+)?$/.test(text),
      )
      .sort((a, b) => b.rect.top - a.rect.top || b.rect.left - a.rect.left);

    const target = buttons[0]?.button;
    if (!target) return null;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    target.click();
    return {
      text: (target.innerText || target.textContent || '').trim(),
      className: String(target.className || ''),
    };
  });

  if (!clicked) throw new Error('没有找到分镜生成提交按钮');
  console.log('已点击生成按钮:', clicked);
  await wait(1500);
}

async function waitForGenerationResult(page, taskEpisode) {
  const startedAt = Date.now();
  let lastState = null;

  while (Date.now() - startedAt < GENERATION_TIMEOUT_MS) {
    lastState = await page.evaluate(async ({ teamId, projectId, shotId }) => {
      const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
      const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
      const response = await fetch('/proxy/api/v1/tasks/video/list', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: token,
          'X-Vsd-Auth-Token': token,
          'X-Vsd-Refresh-Token': refreshToken || '',
        },
        body: JSON.stringify({ TeamId: teamId, ProjectId: projectId, Filters: { ShotIds: [shotId] } }),
      });
      const data = await response.json();
      const videos = (data.Result?.Videos || []).filter((item) => item.ShotId === shotId);
      const video = videos
        .sort((a, b) => {
          const aTime = Date.parse(a.CreatedAt || a.UpdatedAt || '') || 0;
          const bTime = Date.parse(b.CreatedAt || b.UpdatedAt || '') || 0;
          if (bTime !== aTime) return bTime - aTime;
          return String(b.Version || '').localeCompare(String(a.Version || ''));
        })[0] || null;
      const generated = video?.GeneratedVideos || [];
      const videoUrls = generated.map((item) => item.VideoUrl || item.VideoPreviewUrl).filter(Boolean);
      const arkTaskIds = generated.map((item) => item.ArkTaskId).filter(Boolean);
      const rawStatus = String(video?.Status || '').toLowerCase();
      let status = 'processing';
      if (['done', 'completed', 'succeeded', 'success'].includes(rawStatus) || videoUrls.length > 0) status = 'succeeded';
      if (['failed', 'error', 'cancelled', 'canceled'].includes(rawStatus) || video?.FailedReason || video?.FailedCode) status = 'failed';

      return {
        status,
        rawStatus,
        shotId,
        version: video?.Version || '',
        createdAt: video?.CreatedAt || '',
        updatedAt: video?.UpdatedAt || '',
        videoUrls,
        arkTaskIds,
        failedCode: video?.FailedCode || '',
        failedType: video?.FailedType || '',
        failedMessage: video?.FailedMessage || video?.FailedMessageEn || '',
        failedReason: video?.FailedReason || '',
        latestVideo: video,
        response: data,
      };
    }, {
      teamId: taskEpisode.TeamId,
      projectId: taskEpisode.ProjectId,
      shotId: taskEpisode.ShotId,
    });

    if (lastState.status !== 'processing') return lastState;
    await wait(3000);
  }

  return {
    status: 'timeout',
    timeoutMs: GENERATION_TIMEOUT_MS,
    lastState,
  };
}

async function verifyCurrentTaskShot(page, taskEpisode, request) {
  const shotState = await page.evaluate(async ({ teamId, projectId, episodeId, shotId }) => {
    const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
    const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
    const response = await fetch('/proxy/api/v1/shot/list', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: token,
        'X-Vsd-Auth-Token': token,
        'X-Vsd-Refresh-Token': refreshToken || '',
      },
      body: JSON.stringify({ TeamId: teamId, ProjectId: projectId, Filters: { EpisodeId: episodeId }, PageSize: 1000 }),
    });
    const data = await response.json();
    const shots = data.Result?.Items || [];
    return {
      total: shots.length,
      shot: shots.find((item) => item.ShotId === shotId) || null,
      response: data,
    };
  }, {
    teamId: taskEpisode.TeamId,
    projectId: taskEpisode.ProjectId,
    episodeId: taskEpisode.EpisodeId,
    shotId: taskEpisode.ShotId,
  });

  const prompt = shotState.shot?.VideoMeta?.Prompt || shotState.shot?.Meta?.Action || '';
  const imageCount = shotState.shot?.VideoMeta?.RefImages?.length || 0;
  if (shotState.total !== 1) throw new Error(`任务集不是唯一分镜，当前 ${shotState.total} 个分镜`);
  if (!prompt.includes(request.prompt.slice(0, Math.min(30, request.prompt.length)))) {
    throw new Error(`本次任务分镜未写入目标提示词，ShotId=${taskEpisode.ShotId}`);
  }
  if (request.images.length && imageCount < request.images.length) {
    throw new Error(`本次任务分镜图片未写入完整，期望 ${request.images.length}，实际 ${imageCount}`);
  }
  return {
    shotId: taskEpisode.ShotId,
    shotCount: shotState.total,
    imageCount,
    duration: shotState.shot?.VideoMeta?.Duration,
    resolution: shotState.shot?.VideoMeta?.Resolution,
    outputFormat: shotState.shot?.VideoMeta?.OutputFormat,
    videoMeta: shotState.shot?.VideoMeta,
  };
}

function captureGenerationNetwork(page) {
  const captures = [];
  const interesting = (url) => /\/proxy\/api\/v1\/(video|generation|shot|task)|\/contents\/generations\/tasks/i.test(url);

  page.on('request', (request) => {
    const url = request.url();
    if (!interesting(url)) return;
    captures.push({
      type: 'request',
      url,
      method: request.method(),
      body: request.postData(),
      at: new Date().toISOString(),
    });
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (!interesting(url)) return;
    const contentType = response.headers()['content-type'] || '';
    let body = '';
    if (contentType.includes('application/json') || contentType.includes('text/')) {
      body = await response.text().catch(() => '');
    }
    captures.push({
      type: 'response',
      url,
      status: response.status(),
      body,
      at: new Date().toISOString(),
    });
  });

  return captures;
}

export async function runVideoWorkflow({ tempImages, materialize, connect, createPage, prepare, execute, logError = console.error }) {
  let browser;
  let page;
  const safeLog = (message) => {
    try {
      Promise.resolve(logError(message)).catch(() => {});
    } catch {}
  };
  try {
    browser = await connect();
    page = await createPage(browser, (createdPage) => { page = createdPage; });
    const prepared = await prepare({ browser, page });
    const imageFiles = prepared?.imageFiles ?? await materialize();
    return await execute({ imageFiles, browser, page, prepared });
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (error) {
        safeLog(`[video.cleanup_page_error] error=${String(error)}`);
      }
    }
    if (browser) {
      try {
        await browser.disconnect();
      } catch (error) {
        safeLog(`[video.cleanup_browser_error] error=${String(error)}`);
      }
    }
    try {
      await tempImages.cleanup();
    } catch (error) {
      safeLog(`[video.cleanup_temp_error] error=${String(error)}`);
    }
  }
}

export async function prepareVideoTask({
  page,
  request,
  ensureProject = ensureProjectForRatio,
  updateStatus = updateTaskStatus,
  createEpisode = createTaskEpisode,
  emitTaskStarted = (payload) => console.log('TASK_STARTED', JSON.stringify(payload)),
  materialize,
}) {
  const project = await ensureProject(page, request.ratio);
  await updateStatus(page, '项目准备完成', project.projectName || project.url);
  const taskEpisode = await createEpisode(page);
  await updateStatus(page, '已创建任务分镜', `ShotId: ${taskEpisode.ShotId}`);
  await emitTaskStarted({ project, taskEpisode });
  const imageFiles = await materialize();
  return { project, taskEpisode, imageFiles };
}

async function main() {
  const request = normalizeRequest(await loadRequest());
  const shouldSubmit = hasFlag('submit');
  const tempImages = createVideoTempImages({ taskId: TASK_ID, tempRoot: TEMP_ROOT });
  return runVideoWorkflow({
    tempImages,
    materialize: () => materializeVideoImages(tempImages, request.images, imageValue),
    connect: async () => {
      activeBrowserURL = await resolveBrowserURL();
      return puppeteer.connect(browserConnectOptions(activeBrowserURL));
    },
    createPage: openTaskPage,
    prepare: async ({ page }) => {
      const networkCaptures = captureGenerationNetwork(page);
      await updateTaskStatus(page, '正在初始化任务', `${request.model} · ${request.ratio} · ${request.duration}s`);
      await setViewportToWindow(page);
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
      return {
        ...await prepareVideoTask({
          page,
          request,
          materialize: () => materializeVideoImages(tempImages, request.images, imageValue),
        }),
        networkCaptures,
      };
    },
    execute: async ({ imageFiles, page, prepared }) => {
      const { project, taskEpisode, networkCaptures } = prepared;
      const shotModule = await getTaskShotModule(page);

    console.log('准备填写视频工作流参数:', {
      ...request,
      images: `${imageFiles.length} file(s)`,
    });

    const referenceLabel = await chooseReferenceType(page, request.image_type, shotModule);
    await updateTaskStatus(page, '正在填写视频参数', `${request.model} · ${request.duration}s · ${request.resolution} · ${request.output_format}`);
    await chooseModel(page, request.model, shotModule);
    await wait(2000);
    await configureVideoOptions(page, request, shotModule);
    await clearExistingImages(page, shotModule);
    await uploadImages(page, imageFiles, shotModule);
    await updateTaskStatus(page, '参考图上传完成', `${imageFiles.length} 张图片`);
    await pastePrompt(page, request.prompt, shotModule);
    await wait(2000);
    const verifiedShot = await verifyCurrentTaskShot(page, taskEpisode, request);
    if (Number(verifiedShot.duration) !== Number(request.duration)) {
      throw new Error(`视频时长未按请求保存，期望 ${request.duration}s，实际 ${verifiedShot.duration}s`);
    }
    if (String(verifiedShot.resolution || '').toLowerCase() !== String(request.resolution || '').toLowerCase()) {
      throw new Error(`视频清晰度未按请求保存，期望 ${request.resolution}，实际 ${verifiedShot.resolution}`);
    }
    if (String(verifiedShot.outputFormat || '').toLowerCase() !== String(request.output_format || '').toLowerCase()) {
      throw new Error(`视频格式未按请求保存，期望 ${request.output_format}，实际 ${verifiedShot.outputFormat}`);
    }

    const generationResult = shouldSubmit
      ? await (async () => {
        await updateTaskStatus(page, '正在提交视频生成', `ShotId: ${taskEpisode.ShotId}`);
        console.log(`页面停留 ${SUBMIT_DELAY_MS / 1000}s 后点击生成...`);
        await wait(SUBMIT_DELAY_MS);
        await submitGeneration(page, shotModule);
        await updateTaskStatus(page, '视频生成中', `ShotId: ${taskEpisode.ShotId}`);
        const result = await waitForGenerationResult(page, taskEpisode);
        await updateTaskStatus(
          page,
          result.status === 'succeeded' ? '视频生成完成' : '视频生成失败',
          result.status === 'succeeded' ? `已生成 ${result.videoUrls.length} 个视频` : result.failedMessage || result.failedReason || result.status,
          result.status === 'succeeded' ? 'success' : 'error',
        );
        return result;
      })()
      : (await updateTaskStatus(page, '参数填写完成，未提交生成', '', 'success'), null);

    const state = await page.evaluate(() => ({
      url: location.href,
      bodyText: document.body.innerText.slice(0, 1500),
    }));
    const resultPayload = { project, taskEpisode, referenceLabel, verifiedShot, generationResult, networkCaptures, state };
    console.log(
      shouldSubmit ? '已点击生成并等待结果:' : '已完成填写，未提交生成任务:',
      JSON.stringify(resultPayload, null, 2),
    );
    console.log('RESULT_JSON ' + JSON.stringify(resultPayload));
    return resultPayload;
    },
    logError: (message) => console.error(`${message} task_id=${TASK_ID}`),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
