import express from 'express';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createChromeRuntime } from './chrome-runtime.js';
import { createImageSession, resolveImageModel } from './image-session.js';
import { createImageTaskStatusPanel } from './image-task-status-panel.js';
import { runVideoChild } from './video-child-runner.js';
import { createVideoPreparationScheduler } from './video-preparation-scheduler.js';
import { cleanupAbandonedVideoTempDirs, createVideoTempImages } from './video-temp-images.js';
export { resolveImageModel } from './image-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9093);
const HOST = process.env.HOST || '127.0.0.1';
const DEBUG = process.env.SEEDANCE_DEBUG !== '0';
const TASK_ROOT = path.resolve(__dirname, '..', 'seedance_tasks');
const RUNNING_DIR = path.join(TASK_ROOT, 'running');
const RESULTS_DIR = path.join(TASK_ROOT, 'results');
const REQUESTS_DIR = path.join(TASK_ROOT, 'requests');
const VIDEO_TEMP_ROOT = path.join(__dirname, 'tmp-upload-images');
const CHROME_USER_DATA_DIR = path.resolve(__dirname, '..', '.chrome-user-data');
const TEAM_ID = process.env.TEAM_ID || '6a90faa57906980889d712fd';
const PROJECTLIST_URL = 'https://work.xiaomaomi.cn/dramart/projectlist/';
const LOGIN_URL = 'https://work.xiaomaomi.cn/dramart/login';
const LOGIN_POLL_INTERVAL_MS = Number(process.env.LOGIN_POLL_INTERVAL_MS || 2000);
const AUTH_CONFIG_PATH = path.resolve(__dirname, '..', 'dramart-auth.json');
const MODELS = new Set([
  'doubao-seedance-2-5-260628',
  'doubao-seedance-2-0-260128',
  'doubao-seedance-2-0-fast-260128',
  'doubao-seedance-2-0-mini-260615',
]);
const VIDEO_RESOLUTIONS = new Set(['480p', '720p', '1080p', '4k']);
const IMAGE_MODELS = new Set([
  'ep-20260709194802-qsvc2',
  'Doubao-Seedream-5.0-Pro',
  'doubao-seedream-5-0-pro',
  'ep-20260318144532-28ssz',
  'Doubao-Seedream-5.0-lite',
  'doubao-seedream-5-0-lite',
  'ep-20260318141930-4mnvw',
  'Doubao-Seedream-4.5',
  'doubao-seedream-4-5',
]);
const DEFAULT_IMAGE_MODEL = 'ep-20260709194802-qsvc2';
const VIDEO_PREPARATION_TIMEOUT_MS = Number(process.env.VIDEO_PREPARATION_TIMEOUT_MS || 5 * 60 * 1000);
const FIXED_VIEWPORT = { width: 1920, height: 920 };

let browserConnection = null;
let standbyPage = null;
let activeBrowserURL = process.env.BROWSER_URL || '';

function debugLog(message) {
  if (DEBUG) console.log(message);
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function taskFile(dir, taskId) {
  return path.join(dir, `${taskId}.json`);
}

export async function writeJson(filePath, data, fsImpl = fs) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fsImpl.open(tempPath, 'wx');
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.rename(tempPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsImpl.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function taskId() {
  return `dramart-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`;
}

function taskAction(body, payload) {
  const explicit = String(body?.action || body?.task_type || body?.type || '').toLowerCase();
  const model = String(payload?.model || body?.model || '');
  if (explicit.includes('image') || IMAGE_MODELS.has(model) || /seedream|ep-20260318144532-28ssz/i.test(model)) return 'generate_image';
  return 'generate_video';
}

function buildDebugTaskInfo(id, taskContext) {
  const projectName = taskContext?.project?.projectName || taskContext?.projectName || '';
  const beforeEpisodeCount = Number(taskContext?.taskEpisode?.beforeEpisodeCount);
  const episodeIndex = Number.isFinite(beforeEpisodeCount) ? beforeEpisodeCount + 1 : null;
  const debugTaskId = projectName && episodeIndex ? `${projectName}-${episodeIndex}` : id;
  return {
    debug_task_id: debugTaskId,
    project_name: projectName,
    episode_index: episodeIndex,
  };
}

function buildClientData(data, debugInfo) {
  if (!data || typeof data !== 'object') return data;
  const videoUrl = extractVideoUrl(data);
  const imageUrl = extractImageUrl(data);
  const {
    VideoMeta,
    FailedReason,
    GeneratedVideos,
    ClearSubtitleCode,
    ClearSubtitleEnable,
    EnhanceEnable,
    EnhanceCode,
    ...rest
  } = data;
  const content = { ...(data.content || {}) };
  if (videoUrl) content.video_url = videoUrl;
  if (imageUrl) content.image_url = imageUrl;
  return {
    ...rest,
    debug_task_id: debugInfo.debug_task_id,
    content,
  };
}

function jsonResponse(status, message, result = null, completionResponse = null) {
  return { status, message, result, completion_response: completionResponse };
}

function errorResponse(message, completionResponse = null, result = null) {
  return jsonResponse('error', message, result, completionResponse);
}

function buildResultData(status, id, data, completionResponse, error = '', message = '', taskContext = null, action = 'generate_video') {
  const debugInfo = buildDebugTaskInfo(id, taskContext);
  const videoUrl = extractVideoUrl(data);
  const imageUrl = extractImageUrl(data);
  const resultData = buildClientData(data, debugInfo);
  const result = {
    status,
    task_id: id,
    ...debugInfo,
    action,
    data: resultData,
    error,
    message,
    url_id: '',
    client_id: 'seedance_api',
    updated_at: now(),
    completion_response: completionResponse && typeof completionResponse === 'object' ? { ...completionResponse, ...debugInfo } : completionResponse,
  };
  if (videoUrl) result.video_url = videoUrl;
  if (imageUrl) result.image_url = imageUrl;
  return result;
}

export function createStandbyBrowserManager(options) {
  let browser = null;
  let page = null;
  let readinessPromise = null;

  async function initialize() {
    const browserURL = await options.resolveBrowserURL();
    const connectedBrowser = await options.connect(browserURL);
    try {
      const pages = await connectedBrowser.pages();
      const standby = pages.find((candidate) => candidate.url().startsWith(options.projectListUrl)) || await connectedBrowser.newPage();
      await options.setViewport(standby);
      await standby.goto(options.projectListUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      browser = connectedBrowser;
      page = standby;
      connectedBrowser.on('disconnected', () => {
        if (browser === connectedBrowser) {
          browser = null;
          page = null;
          readinessPromise = null;
        }
      });
      options.log(`[browser.ready] browser_url=${browserURL} standby_url=${options.projectListUrl}`);
      return { browser, page, browserURL };
    } catch (error) {
      await connectedBrowser.disconnect?.();
      throw error;
    }
  }

  function ensure() {
    if (browser?.connected && page && !page.isClosed()) return Promise.resolve({ browser, page });
    if (browser || page) {
      browser = null;
      page = null;
      readinessPromise = null;
    }
    if (!readinessPromise) readinessPromise = initialize().catch((error) => {
      readinessPromise = null;
      browser = null;
      page = null;
      throw error;
    });
    return readinessPromise;
  }

  return { ensure };
}

export function createAuthenticationGate(options) {
  let waiting = null;

  async function waitForAuthentication() {
    while (true) {
      try {
        if (await options.verify()) return;
      } catch (error) {
        options.log?.(`[auth.check_failed] error=${String(error)}`);
      }

      try {
        await options.login();
      } catch (error) {
        options.log?.(`[auth.login_failed] error=${String(error)}`);
      }

      options.log?.('[auth.waiting] tasks are paused until login succeeds');
      await options.sleep(options.pollIntervalMs);
    }
  }

  return {
    ensure() {
      if (!waiting) {
        waiting = waitForAuthentication().finally(() => {
          waiting = null;
        });
      }
      return waiting;
    },
  };
}

const chromeRuntime = createChromeRuntime({
  userDataDir: CHROME_USER_DATA_DIR,
  maxAgeMs: 24 * 60 * 60 * 1000,
  launch: (options) => puppeteer.launch(options),
  log: debugLog,
});

const standbyBrowserManager = createStandbyBrowserManager({
  resolveBrowserURL,
  connect: async (browserURL) => {
    activeBrowserURL = browserURL;
    return puppeteer.connect(browserConnectOptions(browserURL));
  },
  setViewport: setViewportToWindow,
  projectListUrl: PROJECTLIST_URL,
  log: debugLog,
});

async function ensureStandbyBrowser() {
  const ready = await standbyBrowserManager.ensure();
  browserConnection = ready.browser;
  standbyPage = ready.page;
  return ready;
}

async function authenticationState(page) {
  await page.goto(PROJECTLIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});
  return page.evaluate(async ({ teamId }) => {
    const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
    const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
    if (!token || location.pathname.includes('/login')) return false;
    try {
      const response = await fetch('/proxy/api/v1/project/list', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: token,
          'X-Vsd-Auth-Token': token,
          'X-Vsd-Refresh-Token': refreshToken || '',
        },
        body: JSON.stringify({
          TeamId: teamId,
          Filters: { CreationMode: 'agent,manual' },
          PageIndex: 1,
          PageSize: 1,
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }, { teamId: TEAM_ID });
}

async function firstExistingSelector(page, selectors, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      if (await page.$(selector)) return selector;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return '';
}

async function loginStandbyBrowser() {
  const { page } = await ensureStandbyBrowser();
  let localCredentials = {};
  try {
    localCredentials = JSON.parse(await fs.readFile(AUTH_CONFIG_PATH, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`读取登录配置失败: ${String(error)}`);
  }
  const username = process.env.DRAMART_USERNAME || localCredentials.username || '';
  const password = process.env.DRAMART_PASSWORD || localCredentials.password || '';
  if (!username || !password) {
    debugLog('[auth.manual_required] DRAMART_USERNAME or DRAMART_PASSWORD is not configured');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return;
  }

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => document.body?.innerText?.includes('主账号登录'),
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    const mainAccount = Array.from(document.querySelectorAll('label, span, div'))
      .find((element) => element.textContent?.trim() === '主账号登录' && element.getBoundingClientRect().width > 0);
    mainAccount?.click();
  });
  const usernameSelector = await firstExistingSelector(page, [
    '#AccountInfo_input',
    'input[placeholder="企业ID/企业名称"]',
    'input[name="username"]',
    'input[name="account"]',
    'input[name="phone"]',
    'input[type="text"]',
  ]);
  const passwordSelector = await firstExistingSelector(page, [
    '#Password_input',
    'input[name="password"]',
    'input[type="password"]',
  ]);
  if (!usernameSelector || !passwordSelector) throw new Error('没有找到登录账号或密码输入框');

  await page.click(usernameSelector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(usernameSelector, username, { delay: 30 });
  await page.click(passwordSelector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(passwordSelector, password, { delay: 30 });
  const submitSelector = await firstExistingSelector(page, [
    'button[type="submit"]',
    '.submitButton-BYq5M6',
    '.ant-btn-primary',
  ]);
  if (!submitSelector) throw new Error('没有找到登录按钮');
  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.click(submitSelector),
  ]);
}

const authenticationGate = createAuthenticationGate({
  verify: async () => authenticationState((await ensureStandbyBrowser()).page),
  login: loginStandbyBrowser,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs: LOGIN_POLL_INTERVAL_MS,
  log: debugLog,
});

export async function ensureAuthenticated() {
  await authenticationGate.ensure();
  debugLog('[auth.ready] task dispatch resumed');
}

const imageTaskStatusPanel = createImageTaskStatusPanel({
  log: debugLog,
  setTimeout: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    return timer;
  },
});

export function createImageSessionWithStatusPanel(statusPanel, options = {}) {
  const createSession = options.createSession || createImageSession;
  return createSession({
    ...(options.sessionOptions || {}),
    onSessionReady: (page) => safePanelCall(
      statusPanel,
      'attachPage',
      [page],
      options.sessionOptions?.log || debugLog,
    ),
  });
}

const imageSession = createImageSessionWithStatusPanel(imageTaskStatusPanel, { sessionOptions: {
  getBrowser: async () => {
    await ensureAuthenticated();
    return browserConnection;
  },
  fetch,
  fs,
  generationTimeoutMs: Number(process.env.GENERATION_TIMEOUT_MS || 15 * 60 * 1000),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 3000),
  log: debugLog,
} });

async function setViewportToWindow(page) {
  await page.setViewport(FIXED_VIEWPORT);
}

function browserConnectOptions(endpoint) {
  return String(endpoint).startsWith('ws:') || String(endpoint).startsWith('wss:')
    ? { browserWSEndpoint: endpoint, defaultViewport: FIXED_VIEWPORT }
    : { browserURL: endpoint, defaultViewport: FIXED_VIEWPORT };
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

  const ready = await chromeRuntime.ensure();
  activeBrowserURL = ready.browserURL;
  return activeBrowserURL;
}

function buildCompletedResponse(resultData) {
  const normalizedResult = normalizeCompletedResult(resultData);
  if (resultData?.action === 'generate_image') {
    return {
      status: 'completed',
      result: normalizedResult,
    };
  }
  return {
    status: 'completed',
    result: normalizedResult,
    completion_response: normalizedResult.completion_response,
  };
}

function normalizeCompletedResult(resultData) {
  if (resultData?.action !== 'generate_image') return resultData;

  const imageUrls = extractImageUrls(resultData.data);
  if (!imageUrls.length) imageUrls.push(...extractImageUrls(resultData.completion_response));
  if (!imageUrls.length && resultData.image_url) imageUrls.push(String(resultData.image_url));
  const success = resultData.status === 'success' && imageUrls.length > 0;

  return {
    status: success ? 'success' : 'error',
    task_id: resultData.task_id,
    action: 'generate_image',
    data: success ? [...new Set(imageUrls)] : '',
    error: success ? '' : resultData.error || '图片生成失败或未返回图片地址',
    url_id: resultData.url_id || '',
    client_id: resultData.client_id || 'seedance_api',
  };
}

function extractVideoUrl(data) {
  if (!data || typeof data !== 'object') return '';
  if (data.video_url) return String(data.video_url);
  if (data.VideoUrl) return String(data.VideoUrl);
  if (Array.isArray(data.videoUrls) && data.videoUrls[0]) return String(data.videoUrls[0]);
  if (Array.isArray(data.GeneratedVideos)) {
    const video = data.GeneratedVideos.find((item) => item?.VideoUrl || item?.VideoPreviewUrl);
    return video?.VideoUrl || video?.VideoPreviewUrl || '';
  }
  if (data.latestVideo) return extractVideoUrl(data.latestVideo);
  if (data.generationResult) return extractVideoUrl(data.generationResult);
  return '';
}

function extractImageUrl(data) {
  if (!data || typeof data !== 'object') return '';
  if (data.image_url) return String(data.image_url);
  if (data.ImageUrl) return String(data.ImageUrl);
  if (Array.isArray(data.images) && data.images[0]) return extractImageUrl(data.images[0]) || String(data.images[0]);
  if (Array.isArray(data.Images) && data.Images[0]) return extractImageUrl(data.Images[0]) || String(data.Images[0]);
  const generatedInfo = data.GeneratedResource?.ImagesInfo?.[0] || data.ImagesInfo?.[0];
  if (generatedInfo) return generatedInfo.HighResolutionUrl || generatedInfo.Url || generatedInfo.ThumbnailUrl || '';
  if (data.generationResult) return extractImageUrl(data.generationResult);
  if (data.response) return extractImageUrl(data.response);
  return '';
}

function extractImageUrls(data) {
  if (!data) return [];
  if (typeof data === 'string') return data ? [data] : [];
  if (Array.isArray(data)) return data.flatMap(extractImageUrls);
  if (typeof data !== 'object') return [];

  const infos = data.GeneratedResource?.ImagesInfo || data.ImagesInfo;
  if (Array.isArray(infos)) {
    return infos
      .map((info) => info?.HighResolutionUrl || info?.Url || info?.ThumbnailUrl || '')
      .filter(Boolean)
      .map(String);
  }
  if (Array.isArray(data.images)) return data.images.flatMap(extractImageUrls);
  if (data.image_url) return [String(data.image_url)];
  if (data.ImageUrl) return [String(data.ImageUrl)];
  if (data.generationResult) return extractImageUrls(data.generationResult);
  if (data.response) return extractImageUrls(data.response);
  return [];
}

function extractError(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;
  return data.failedMessage || data.failedReason || data.FailedMessage || data.FailedReason || data.error || data.message || fallback;
}

export function safePanelError(reason) {
  const message = reason instanceof Error ? reason.message : reason == null ? '未知任务错误' : String(reason);
  return message
    .replace(/https?:\/\/[^\s<>"']+/ig, (value) => {
      const trailing = value.match(/[),.;!?]+$/)?.[0] || '';
      const candidate = trailing ? value.slice(0, -trailing.length) : value;
      try {
        const url = new URL(candidate);
        return `${url.origin}${url.pathname}${trailing}`;
      } catch {
        return `[url redacted]${trailing}`;
      }
    })
    .replace(/\b(authorization\s*[:=]\s*)?(?:basic|bearer)\s+[^\s,;]+/ig, '$1[redacted]')
    .replace(/(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]*/ig, '$1[redacted]')
    .replace(/data:image\/[^;,\s]+;base64,[a-z0-9+/=]+/ig, '[image redacted]')
    .replace(/\b[a-z0-9+/]{80,}={0,2}\b/ig, '[base64 redacted]')
    .replace(/(["']?\b(?:cookie|set-cookie)["']?)(\s*=\s*)[^\r\n]*/ig, '$1$2[redacted]')
    .replace(/(["']?\b(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|credentials?|cookie|set-cookie)["']?)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&}]+)/ig, '$1$2[redacted]')
    .replace(/(["']?\b(?:prompt|payload|image[-_]?data|base64)["']?)(\s*[:=]\s*)[\s\S]*/i, '$1$2[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function safeLog(log, message) {
  try {
    const result = log?.(message);
    if (result != null && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
  } catch {}
}

export function safePanelCall(panel, method, args = [], log = debugLog) {
  const report = (error) => safeLog(log, `[image-task-status-panel.${method}_error] error=${safePanelError(error)}`);
  try {
    const result = panel?.[method]?.(...args);
    if (result != null && typeof result.then === 'function') {
      Promise.resolve(result).catch(report);
    }
  } catch (error) {
    report(error);
  }
}

function contentPrompt(content) {
  if (!Array.isArray(content)) return '';
  return String(content.find((item) => item?.type === 'text')?.text || '').trim();
}

function payloadSummary(payload) {
  const content = payload.content || [];
  const images = Array.isArray(content) ? content.filter((item) => item?.type === 'image_url') : [];
  return {
    model: payload.model,
    resolution: payload.resolution,
    ratio: payload.ratio,
    duration: payload.duration,
    seed: payload.seed,
    output_format: payload.output_format,
    generate_audio: payload.generate_audio,
    watermark: payload.watermark,
    camera_fixed: payload.camera_fixed,
    text_len: contentPrompt(content).length,
    image_count: images.length,
    image_roles: images.map((item) => item.role),
  };
}

function imagePayloadSummary(payload) {
  return {
    action: payload.action,
    model: payload.model,
    ratio: payload.ratio,
    count: payload.count || payload.n,
    text_len: contentPrompt(payload.content).length,
    image_count: Array.isArray(payload.content) ? payload.content.filter((item) => item?.type === 'image_url').length : 0,
  };
}

function responseSummary(data) {
  if (!data || typeof data !== 'object') return data;
  const generation = data.generationResult || data;
  return {
    status: generation.status,
    rawStatus: generation.rawStatus,
    shotId: generation.shotId || data.taskEpisode?.ShotId,
    arkTaskIds: generation.arkTaskIds,
    videoUrlCount: Array.isArray(generation.videoUrls) ? generation.videoUrls.length : 0,
    failedCode: generation.failedCode,
    failedType: generation.failedType,
    failedMessage: generation.failedMessage,
    failedReason: generation.failedReason ? String(generation.failedReason).slice(0, 300) : '',
  };
}

function buildContent(body) {
  if (Array.isArray(body.content) && body.content.length) return body.content;
  const content = [];
  const prompt = String(body.prompt || '').trim();
  if (prompt) content.push({ type: 'text', text: prompt });
  const rawImages = body.images ?? body.image;
  const images = Array.isArray(rawImages) ? rawImages : rawImages ? [rawImages] : [];
  for (const item of images) {
    const url = typeof item === 'string' ? item : item?.url || item?.image || item?.image_url?.url || item?.image_url;
    if (!url) continue;
    content.push({
      type: 'image_url',
      role: typeof item === 'object' ? item.type || item.role || body.image_type || 'reference_image' : body.image_type || 'reference_image',
      image_url: { url },
    });
  }
  return content;
}

function bodyToPayload(body) {
  let payload = {
    model: body.model || 'doubao-seedance-2-0-fast-260128',
    content: buildContent(body),
    resolution: body.resolution || '720p',
    ratio: body.ratio || body.aspect_ratio || body.ratios || '16:9',
    duration: Number(body.duration || 5),
    seed: body.seed ?? -1,
    output_format: body.output_format || 'mp4',
    framespersecond: body.framespersecond || 24,
    generate_audio: Boolean(body.generate_audio),
    watermark: Boolean(body.watermark),
    camera_fixed: Boolean(body.camera_fixed),
  };

  for (const [key, value] of Object.entries(body)) {
    if (!(key in payload) && !['prompt', 'image', 'images', 'image_type', 'wait_for_completion', 'apiKey', 'api_key', 'advancedJson', 'advanced_json'].includes(key)) {
      payload[key] = value;
    }
  }

  const advancedJson = body.advancedJson || body.advanced_json;
  if (advancedJson && String(advancedJson).trim()) payload = { ...payload, ...JSON.parse(advancedJson) };
  return payload;
}

function validatePayload(payload, action = 'generate_video') {
  if (action === 'generate_image') {
    if (!contentPrompt(payload.content)) return 'prompt 不能为空';
    if (!payload.content?.some((item) => item?.type === 'image_url')) return '图片生成至少需要 1 张参考图';
    return '';
  }
  if (!MODELS.has(String(payload.model || ''))) return '不支持的模型';
  if (!contentPrompt(payload.content)) return 'prompt 不能为空';
  if (!Number.isInteger(payload.duration) || payload.duration <= 0) return 'duration 必须是正整数秒';
  if (!VIDEO_RESOLUTIONS.has(String(payload.resolution || '').toLowerCase())) {
    return 'resolution 不支持，可选值为 480p、720p、1080p、4k';
  }
  return '';
}

function requestForWorkflow(payload) {
  const images = (payload.content || [])
    .filter((item) => item?.type === 'image_url')
    .map((item) => ({
      type: item.role || 'reference_image',
      url: typeof item.image_url === 'string' ? item.image_url : item.image_url?.url,
    }))
    .filter((item) => item.url);

  return {
    ...payload,
    prompt: contentPrompt(payload.content),
    images,
    image_type: images[0]?.type || 'reference_image',
  };
}

function requestForImageWorkflow(payload, body) {
  const request = requestForWorkflow(payload);
  const model = resolveImageModel(body?.model || DEFAULT_IMAGE_MODEL);
  request.model = model.code;
  request.model_name = body?.model_name || body?.modelName || model.name;
  return request;
}

export function createImageTaskRunner(options) {
  const statusPanel = options.statusPanel || {};
  const panelLog = options.log || debugLog;
  return async function runImageTask(id, requestPath, _body, action, context) {
    const taskStatusPanel = context.statusPanel || statusPanel;
    const request = await options.readJson(requestPath);
    let taskContext = null;
    let generationResult;
    try {
      generationResult = await options.imageSession.runTask(id, request, {
        onReady: async (sessionState) => {
          const project = {
            projectName: sessionState.projectName,
            projectId: sessionState.projectId,
            scriptId: sessionState.scriptId,
            teamId: sessionState.teamId,
            url: sessionState.url,
          };
          taskContext = { type: 'image', project, projectName: sessionState.projectName, prompt: request.prompt };
          const debugInfo = buildDebugTaskInfo(id, taskContext);
          await options.writeJson(context.runningPath, {
            ...await options.readJson(context.runningPath),
            ...debugInfo,
            status: 'processing',
            updated_at: now(),
            dramart: taskContext,
            completion_response: { ...taskContext, ...debugInfo, status: 'processing' },
          });
          options.log(`[task.started] task_id=${id} context=${JSON.stringify(taskContext)}`);
        },
        onProgress: ({ stage, detail }) => safePanelCall(taskStatusPanel, 'update', [id, stage, detail], panelLog),
      });
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(reason == null ? '未知任务错误' : String(reason));
      safePanelCall(taskStatusPanel, 'fail', [id, safePanelError(error)], panelLog);
      if (context.taskLifecycle) context.taskLifecycle.panelFailureReported = true;
      throw error;
    }
    const ok = generationResult.status === 'succeeded';
    const resultItem = generationResult.response || generationResult;
    const resultData = buildResultData(ok ? 'success' : 'error', id, resultItem, resultItem, ok ? '' : extractError(generationResult, '图片生成失败'), '', taskContext, action);
    await options.writeJson(context.resultPath, resultData);
    if (ok) safePanelCall(taskStatusPanel, 'succeed', [id], panelLog);
    else safePanelCall(taskStatusPanel, 'fail', [id, safePanelError(resultData.error)], panelLog);
    await options.rm(context.runningPath, { force: true });
    options.log(`[task.done] task_id=${id} status=${resultData.status} media_url=${resultData.image_url || ''} error=${resultData.error || ''}`);
  };
}

const runImageTask = createImageTaskRunner({ imageSession, statusPanel: imageTaskStatusPanel, readJson, writeJson, rm: fs.rm.bind(fs), log: debugLog });

export async function cleanupVideoTaskResources({ taskId: id, tempRoot, browser, fsImpl = fs }) {
  const cleanup = createVideoTempImages({ taskId: id, tempRoot, fsImpl }).cleanup();
  const closePage = (async () => {
    if (!browser) return;
    const pages = await browser.pages();
    const marker = `seedance-video-${id}`;
    const matches = await Promise.all(pages.map(async (page) => {
      if (page.isClosed?.()) return null;
      const name = await page.evaluate(() => window.name).catch(() => '');
      return name === marker ? page : null;
    }));
    await Promise.all(matches.filter(Boolean).map((page) => page.close()));
  })();
  const results = await Promise.allSettled([cleanup, closePage]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

export async function createMarkedTaskPage(browser, marker) {
  const page = await browser.newPage();
  try {
    await page.evaluate((name) => { window.name = name; }, marker);
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

export async function runDramartTask(id, requestPath, body, action = 'generate_video', taskOptions = {}) {
  const runningPath = taskOptions.runningPath || taskFile(RUNNING_DIR, id);
  const resultPath = taskOptions.resultPath || taskFile(RESULTS_DIR, id);
  if (action === 'generate_image') {
    const imageTaskRunner = taskOptions.imageTaskRunner || runImageTask;
    return imageTaskRunner(id, requestPath, body, action, { runningPath, resultPath, ...taskOptions });
  }

  const plan = taskExecutionPlan(action);
  const args = [path.join(__dirname, plan.script), `--json=${requestPath}`, '--submit'];
  const ready = await (taskOptions.ensureStandbyBrowser || ensureStandbyBrowser)();
  const pageMarker = `seedance-video-${id}`;
  await (taskOptions.createMarkedTaskPage || createMarkedTaskPage)(ready.browser, pageMarker);
  debugLog(`[task.start] task_id=${id} request=${requestPath}`);
  let taskContext = null;
  const { exitCode, stdout, stderr } = await (taskOptions.runVideoChild || runVideoChild)({
    spawnImpl: spawn,
    command: process.execPath,
    args,
    options: {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        BROWSER_URL: ready.browserURL || activeBrowserURL,
        SEEDANCE_TASK_ID: id,
        SEEDANCE_TASK_PAGE_MARKER: pageMarker,
        SUBMIT_DELAY_MS: String(process.env.SUBMIT_DELAY_MS || 3000),
      },
      windowsHide: true,
    },
    preparationTimeoutMs: VIDEO_PREPARATION_TIMEOUT_MS,
    onPrepared: async (context) => {
      taskContext = context;
      await taskOptions.onPrepared?.(context);
    },
  });
  debugLog(`[task.child_exit] task_id=${id} exit_code=${exitCode} stdout_len=${stdout.length} stderr_len=${stderr.length}`);
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith('RESULT_JSON '));
  const completionResponse = resultLine ? JSON.parse(resultLine.slice('RESULT_JSON '.length)) : { stdout, stderr };
  const generationResult = completionResponse.generationResult || completionResponse;
  const ok = generationResult.status === 'succeeded';
  const rawCompletionResponse = generationResult.response || completionResponse;
  const resultItem = generationResult.latestVideo || generationResult.response || generationResult;
  debugLog(`[task.response] task_id=${id} summary=${JSON.stringify(responseSummary(completionResponse))}`);
  const resultData = buildResultData(
    ok ? 'success' : 'error',
    id,
    resultItem,
    rawCompletionResponse,
    ok ? '' : extractError(resultItem, extractError(generationResult, stderr || '任务失败')),
    '',
    taskContext,
    action,
  );
  await (taskOptions.writeJson || writeJson)(resultPath, resultData);
  await (taskOptions.rm || fs.rm.bind(fs))(runningPath, { force: true }).catch((error) => debugLog(`[task.cleanup_error] task_id=${id} error=${String(error)}`));
  debugLog(`[task.done] task_id=${id} status=${resultData.status} media_url=${resultData.video_url || resultData.image_url || ''} error=${resultData.error || ''}`);
}

export function videoWorkflowScript() {
  return path.join(__dirname, 'prepare-video-workflow.js');
}

export function taskExecutionPlan(action) {
  return action === 'generate_image'
    ? { mode: 'in-process-image-session' }
    : { mode: 'child-process', script: 'prepare-video-workflow.js' };
}

export function createTaskApp(options = {}) {
const app = express();
const runTask = options.runTask || runDramartTask;
const authenticate = options.authenticate || (options.runTask ? async () => {} : ensureAuthenticated);
const appWriteJson = options.writeJson || writeJson;
const appReadJson = options.readJson || readJson;
const appRm = options.rm || fs.rm.bind(fs);
const appAccess = options.access || fs.access.bind(fs);
const onBackgroundError = options.onBackgroundError || ((error) => debugLog(`[task.background_error] error=${String(error)}`));
const appRunningDir = options.runningDir || RUNNING_DIR;
const appResultsDir = options.resultsDir || RESULTS_DIR;
const appRequestsDir = options.requestsDir || REQUESTS_DIR;
const appVideoTempRoot = options.videoTempRoot || VIDEO_TEMP_ROOT;
const appImageTaskStatusPanel = options.imageTaskStatusPanel || imageTaskStatusPanel;
const appImageSession = options.imageSession || (options.imageSessionOptions
  ? createImageSessionWithStatusPanel(appImageTaskStatusPanel, options.imageSessionOptions)
  : null);
const appImageTaskRunner = options.imageTaskRunner || (appImageSession
  ? createImageTaskRunner({
    imageSession: appImageSession,
    statusPanel: appImageTaskStatusPanel,
    readJson: appReadJson,
    writeJson: appWriteJson,
    rm: appRm,
    log: options.log || debugLog,
  })
  : undefined);
const acquireBrowserLease = options.acquireBrowserLease || (async () => ({ release() {} }));
const cleanupVideoTempDirs = options.cleanupVideoTempDirs || cleanupAbandonedVideoTempDirs;
const cleanupVideoTask = options.cleanupVideoTaskResources || cleanupVideoTaskResources;
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const isMissing = (error) => error?.code === 'ENOENT';
const videoScheduler = createVideoPreparationScheduler({
  start: async (item, markPrepared) => {
    const browserLease = await acquireBrowserLease();
    try {
      await authenticate();
      return await runTask(item.id, item.requestPath, item.body, item.action, {
    runningPath: item.runningPath,
    resultPath: item.resultPath,
    readJson: appReadJson,
    writeJson: appWriteJson,
    buildResultData,
    onPrepared: (taskContext) => {
      const persistence = (async () => {
      const debugInfo = buildDebugTaskInfo(item.id, taskContext);
      await appWriteJson(item.runningPath, {
        ...await appReadJson(item.runningPath),
        ...debugInfo,
        status: 'processing',
        updated_at: now(),
        dramart: taskContext,
        completion_response: { ...taskContext, ...debugInfo, status: 'processing' },
      });
      debugLog(`[task.started] task_id=${item.id} context=${JSON.stringify(taskContext)}`);
      markPrepared();
      })();
      item.preparedPersistence = persistence;
      persistence.catch(() => {});
      return persistence;
    },
      });
    } catch (error) {
      try {
        await cleanupVideoTask({ taskId: item.id, tempRoot: appVideoTempRoot, browser: options.videoCleanupBrowser || browserConnection });
      } catch (cleanupError) {
        reportBackgroundError(cleanupError);
      }
      throw error;
    } finally {
      await releaseBrowserLeaseSafely(browserLease);
    }
  },
});
app.locals.videoScheduler = videoScheduler;
app.locals.imageTaskStatusPanel = appImageTaskStatusPanel;

function normalizeTaskError(reason) {
  if (reason instanceof Error) return reason;
  if (reason == null) return new Error('未知任务错误');
  return new Error(String(reason));
}

function reportBackgroundError(error) {
  try {
    Promise.resolve(onBackgroundError(error)).catch((reportError) => {
      debugLog(`[task.background_error_handler_failed] error=${String(reportError)}`);
    });
  } catch (reportError) {
    debugLog(`[task.background_error_handler_failed] error=${String(reportError)}`);
  }
}

async function releaseBrowserLeaseSafely(browserLease) {
  try {
    await browserLease?.release?.();
  } catch (error) {
    reportBackgroundError(error);
  }
}

async function cleanupRunningTask(item) {
  try {
    await appRm(item.runningPath, { force: true });
  } catch (cleanupError) {
    reportBackgroundError(cleanupError);
  }
}

async function persistTaskError(item, reason) {
  let error = normalizeTaskError(reason);
  try {
    await item.preparedPersistence;
  } catch (persistenceError) {
    const preparedError = normalizeTaskError(persistenceError);
    if (preparedError !== error) {
      error = new Error(`${error.message}; prepared persistence failed: ${preparedError.message}`, { cause: error });
    }
  }
  debugLog(`[task.error] task_id=${item.id} error=${String(error)} stack=${error.stack || ''}`);
  const resultData = buildResultData(
    'error',
    item.id,
    '',
    { exception: String(error), stack: error.stack },
    String(error),
    '',
    null,
    item.action,
  );

  try {
    if (await resultExists(item.resultPath)) {
      debugLog(`[task.cleanup_error] task_id=${item.id} terminal_result_preserved error=${String(error)}`);
      await cleanupRunningTask(item);
      return null;
    }
  } catch (accessError) {
    reportBackgroundError(accessError);
    return resultData;
  }

  try {
    await appWriteJson(item.resultPath, resultData);
  } catch (persistenceError) {
    reportBackgroundError(persistenceError);
    return resultData;
  }
  await cleanupRunningTask(item);
  return resultData;
}

function observeTask(item, promise) {
  return Promise.resolve(promise)
    .then(() => null, async (reason) => {
      const error = normalizeTaskError(reason);
      const resultData = await persistTaskError(item, error);
      if (item.action === 'generate_image' && resultData && !item.panelFailureReported) {
        safePanelCall(appImageTaskStatusPanel, 'fail', [item.id, safePanelError(error)], debugLog);
      }
      return resultData;
    })
    .catch((error) => {
      reportBackgroundError(error);
      return buildResultData('error', item.id, '', { exception: String(error) }, String(error), '', null, item.action);
    });
}

async function resultExists(resultPath) {
  try {
    await appAccess(resultPath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw new Error(`检查任务结果失败 ${resultPath}: ${String(error)}`, { cause: error });
  }
  await readPersistedJson(resultPath);
  return true;
}

async function readPersistedJson(filePath) {
  try {
    return await appReadJson(filePath);
  } catch (error) {
    throw new Error(`读取持久化任务 JSON 失败 ${filePath}: ${String(error)}`, { cause: error });
  }
}

async function initializePersistedTasks() {
  await Promise.all([appRunningDir, appResultsDir, appRequestsDir].map((dir) => fs.mkdir(dir, { recursive: true })));
  const [runningEntries, resultEntries, requestEntries] = await Promise.all([
    fs.readdir(appRunningDir, { withFileTypes: true }),
    fs.readdir(appResultsDir, { withFileTypes: true }),
    fs.readdir(appRequestsDir, { withFileTypes: true }),
  ]);
  const jsonFileNames = (entries) => new Set(entries
    .filter((entry) => entry.isFile() && path.extname(entry.name) === '.json')
    .map((entry) => entry.name));
  const resultFiles = jsonFileNames(resultEntries);
  const requestFiles = jsonFileNames(requestEntries);
  const queued = [];

  for (const entry of runningEntries) {
    if (!entry.isFile() || path.extname(entry.name) !== '.json') continue;
    const id = path.basename(entry.name, '.json');
    if (!validTaskId(id)) {
      throw new Error(`恢复任务失败：非法 running 文件名 ${entry.name}`);
    }
    const runningPath = path.join(appRunningDir, entry.name);
    const record = await readPersistedJson(runningPath);
    if (!Object.hasOwn(record || {}, 'task_id')) {
      throw new Error(`恢复任务失败：running 记录缺失 task_id ${entry.name}`);
    }
    if (record.task_id !== id) {
      throw new Error(`恢复任务失败：record.task_id 与文件名不一致 ${entry.name}`);
    }
    if (record?.action !== 'generate_video') continue;

    const fileName = entry.name;
    const resultPath = path.join(appResultsDir, fileName);
    const requestPath = path.join(appRequestsDir, fileName);
    if (resultFiles.has(fileName)) {
      await readPersistedJson(resultPath);
      await cleanupRunningTask({ id, runningPath });
      continue;
    }

    if (record.status === 'processing') {
      const resultData = buildResultData(
        'error',
        id,
        '',
        { interrupted: true, ...(record.dramart || {}) },
        '服务重启导致任务中断；为避免重复创建集或重复提交，任务未自动重跑',
        '',
        record.dramart || null,
        'generate_video',
      );
      resultData.dramart = record.dramart;
      await appWriteJson(resultPath, resultData);
      await appRm(runningPath, { force: true }).catch((error) => {
        reportBackgroundError(error);
      });
      continue;
    }

    if (record.status === 'queued') {
      if (!requestFiles.has(fileName)) {
        throw new Error(`恢复 queued 视频任务失败：请求文件索引中缺少 ${fileName}`);
      }
      const request = await readPersistedJson(requestPath);
      queued.push({
        id,
        requestPath,
        body: { ...request, action: 'generate_video' },
        action: 'generate_video',
        runningPath,
        resultPath,
        createdAt: Number(record.created_at) || 0,
      });
    }
  }

  queued.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  for (const item of queued) observeTask(item, videoScheduler.enqueue(item));

  try {
    const retainedEntries = await fs.readdir(appRunningDir, { withFileTypes: true });
    const activeTaskIds = retainedEntries
      .filter((entry) => entry.isFile() && path.extname(entry.name) === '.json')
      .map((entry) => path.basename(entry.name, '.json'))
      .filter(validTaskId);
    await cleanupVideoTempDirs({ tempRoot: appVideoTempRoot, activeTaskIds });
  } catch (error) {
    debugLog(`[video_temp.cleanup_abandoned_error] error=${String(error)}`);
  }
}

app.locals.ready = initializePersistedTasks();
app.use(express.json({ limit: '200mb' }));
app.use(['/api/ask', '/api/result/:task_id', '/api/files/:task_id'], asyncRoute(async (_req, _res, next) => {
  await app.locals.ready;
  next();
}));

app.post('/api/ask', asyncRoute(async (req, res) => {
  let payload;
  try {
    payload = bodyToPayload(req.body || {});
  } catch (error) {
    return res.json(errorResponse('advancedJson 不是合法 JSON', { exception: String(error) }));
  }

  const action = taskAction(req.body || {}, payload);
  if (action === 'generate_video') payload.resolution = String(payload.resolution).toLowerCase();
  const validationError = validatePayload(payload, action);
  if (validationError) return res.json(errorResponse(validationError, { payload }));

  debugLog(`[/api/ask] received payload=${JSON.stringify(action === 'generate_image' ? imagePayloadSummary(payload) : payloadSummary(payload))} wait_for_completion=${Boolean(req.body?.wait_for_completion)}`);

  const id = taskId();
  const workflowRequest = action === 'generate_image' ? requestForImageWorkflow(payload, req.body || {}) : requestForWorkflow(payload);
  const requestPath = taskFile(appRequestsDir, id);
  await appWriteJson(requestPath, workflowRequest);

  const taskRecord = {
    action,
    status: action === 'generate_image' ? 'processing' : 'queued',
    task_id: id,
    debug_task_id: id,
    model: payload.model,
    payload,
    created_at: now(),
    updated_at: now(),
    completion_response: { task_id: id, debug_task_id: id, status: action === 'generate_image' ? 'processing' : 'queued' },
  };
  await appWriteJson(taskFile(appRunningDir, id), taskRecord);
  if (action === 'generate_image') {
    safePanelCall(appImageTaskStatusPanel, 'add', [id, taskRecord.created_at * 1000], debugLog);
  }
  debugLog(`[/api/ask] queued task_id=${id} request=${requestPath}`);

  const runItem = {
    id,
    requestPath,
    body: req.body || {},
    action,
    runningPath: taskFile(appRunningDir, id),
    resultPath: taskFile(appResultsDir, id),
  };
  const runPromise = observeTask(runItem, action === 'generate_video'
    ? videoScheduler.enqueue(runItem)
    : Promise.resolve().then(async () => {
      const browserLease = await acquireBrowserLease();
      try {
        await authenticate();
        return await runTask(id, requestPath, req.body || {}, action, {
          runningPath: runItem.runningPath,
          resultPath: runItem.resultPath,
          readJson: appReadJson,
          writeJson: appWriteJson,
          buildResultData,
          statusPanel: appImageTaskStatusPanel,
          imageTaskRunner: appImageTaskRunner,
          taskLifecycle: runItem,
        });
      } finally {
        await releaseBrowserLeaseSafely(browserLease);
      }
    }));

  if (!req.body?.wait_for_completion) {
    debugLog(`[/api/ask] return_immediately status=processing task_id=${id}`);
    return res.json({
      status: 'processing',
      message: '任务已发送给客户端',
      task_id: id,
      debug_task_id: id,
      queue_position: action === 'generate_video' ? videoScheduler.queuePosition(id) : 0,
      completion_response: taskRecord.completion_response,
    });
  }

  const fallbackResult = await runPromise;
  debugLog(`[/api/ask] completed_sync task_id=${id}`);
  if (fallbackResult) return res.json(buildCompletedResponse(fallbackResult));
  try {
    return res.json(buildCompletedResponse(await appReadJson(taskFile(appResultsDir, id))));
  } catch (error) {
    return res.json(buildCompletedResponse(buildResultData('error', id, '', { exception: String(error) }, String(error), '', null, action)));
  }
}));

function validTaskId(id) {
  return /^dramart-\d{14}-[a-z0-9]{5}$/.test(String(id));
}

app.use(['/api/result/:task_id', '/api/files/:task_id'], (req, res, next) => {
  if (!validTaskId(req.params.task_id)) return res.json(errorResponse('task_id 格式不正确'));
  next();
});

app.get('/api/result/:task_id', asyncRoute(async (req, res) => {
  const id = req.params.task_id;
  debugLog(`[/api/result] task_id=${id}`);
  const resultPath = taskFile(appResultsDir, id);
  const runningPath = taskFile(appRunningDir, id);

  let resultData;
  try {
    resultData = await appReadJson(resultPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (resultData) {
    debugLog(`[/api/result] cached_completed task_id=${id} status=${resultData.status}`);
    return res.json(buildCompletedResponse(resultData));
  }

  try {
    const running = await appReadJson(runningPath);
    debugLog(`[/api/result] processing task_id=${id} status=${running.status}`);
    if (running.status === 'queued') {
      return res.json({
        status: 'processing',
        message: '任务排队中',
        queue_position: videoScheduler.queuePosition(id),
        completion_response: running.completion_response,
      });
    }
    return res.json({ status: 'processing', message: '任务处理中', completion_response: running.completion_response });
  } catch (error) {
    if (!isMissing(error)) throw error;
    debugLog(`[/api/result] missing task_id=${id}`);
    return res.json({ status: 'processing', message: '任务处理中或不存在', completion_response: null });
  }
}));

app.get('/api/files/:task_id', asyncRoute(async (req, res) => {
  debugLog(`[/api/files] task_id=${req.params.task_id}`);
  const resultPath = taskFile(appResultsDir, req.params.task_id);
  try {
    const resultData = await appReadJson(resultPath);
    const mediaUrl = extractVideoUrl(resultData.data) || resultData.video_url || extractImageUrl(resultData.data) || resultData.image_url || '';
    if (resultData.status === 'success' && mediaUrl) {
      debugLog(`[/api/files] completed task_id=${req.params.task_id} cdn_url=${mediaUrl}`);
      return res.json({
        status: 'completed',
        result: {
          type: 'download_complete',
          task_id: req.params.task_id,
          cdn_url: mediaUrl,
          file_type: 'cdn_url',
          updated_at: resultData.updated_at,
        },
        completion_response: resultData.completion_response,
      });
    }
    debugLog(`[/api/files] failed task_id=${req.params.task_id} status=${resultData.status} error=${resultData.error || ''}`);
    return res.json({ status: 'failed', result: resultData, completion_response: resultData.completion_response });
  } catch (error) {
    if (!isMissing(error)) throw error;
    debugLog(`[/api/files] processing_or_missing task_id=${req.params.task_id}`);
    return res.json({ status: 'processing', message: '文件生成中或不存在', completion_response: null });
  }
}));

app.get('/health', (req, res) => {
  res.json({ success: true, service: 'seedance-python-task-server', port: PORT, ark_base_url: 'dramart' });
});

app.use((error, _req, res, _next) => {
  debugLog(`[request.error] error=${String(error)} stack=${error.stack || ''}`);
  res.json(errorResponse(String(error)));
});

return app;
}

export function listenTaskApp(taskApp, options = {}) {
  return taskApp.listen(options.port ?? PORT, options.host || HOST, options.onListening);
}

export async function startTaskServer(options = {}) {
const taskApp = options.taskApp || createTaskApp({ acquireBrowserLease: () => chromeRuntime.acquire() });
await taskApp.locals.ready;
const listen = options.listen || listenTaskApp;
return listen(taskApp, { port: PORT, host: HOST, onListening: () => {
  console.log(`Seedance Node task server: http://${HOST}:${PORT}`);
  debugLog(`[server] debug=${DEBUG} task_root=${TASK_ROOT}`);
  imageSession.ensureReady().catch((error) => {
    debugLog(`[image-session.ready_error] error=${String(error)}`);
  });
} });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startTaskServer().catch((error) => {
    console.error(`Seedance task server startup failed: ${String(error)}`);
    process.exitCode = 1;
  });
}
