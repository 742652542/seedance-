import nodeFs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TEAM_ID = '6a90faa57906980889d712fd';
const DEFAULT_TEMP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp-upload-images');
const IMAGE_MODEL_MAP = {
  'Doubao-Seedream-5.0-Pro': { code: 'ep-20260709194802-qsvc2', name: 'Doubao-Seedream-5.0-Pro' },
  'doubao-seedream-5-0-pro': { code: 'ep-20260709194802-qsvc2', name: 'Doubao-Seedream-5.0-Pro' },
  'ep-20260709194802-qsvc2': { code: 'ep-20260709194802-qsvc2', name: 'Doubao-Seedream-5.0-Pro' },
  'Doubao-Seedream-5.0-lite': { code: 'ep-20260318144532-28ssz', name: 'Doubao-Seedream-5.0-lite' },
  'doubao-seedream-5-0-lite': { code: 'ep-20260318144532-28ssz', name: 'Doubao-Seedream-5.0-lite' },
  'ep-20260318144532-28ssz': { code: 'ep-20260318144532-28ssz', name: 'Doubao-Seedream-5.0-lite' },
  'Doubao-Seedream-4.5': { code: 'ep-20260318141930-4mnvw', name: 'Doubao-Seedream-4.5' },
  'doubao-seedream-4-5': { code: 'ep-20260318141930-4mnvw', name: 'Doubao-Seedream-4.5' },
  'ep-20260318141930-4mnvw': { code: 'ep-20260318141930-4mnvw', name: 'Doubao-Seedream-4.5' },
};

export function resolveImageModel(model) {
  return IMAGE_MODEL_MAP[model] || IMAGE_MODEL_MAP[String(model || '').toLowerCase()] || IMAGE_MODEL_MAP['ep-20260709194802-qsvc2'];
}

function extensionFromMime(mime) {
  if (mime.includes('jpeg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('bmp')) return '.bmp';
  return '.png';
}

function mimeFromSuffix(suffix) {
  if (suffix === 'jpg' || suffix === 'jpeg') return 'image/jpeg';
  if (suffix === 'webp') return 'image/webp';
  if (suffix === 'gif') return 'image/gif';
  if (suffix === 'bmp') return 'image/bmp';
  return 'image/png';
}

function imageValue(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  if (typeof item.image_url === 'string') return item.image_url;
  return item.image_url?.url || item.url || item.image || '';
}

function imageTitle(item, index) {
  if (!item || typeof item !== 'object') return `image-${index + 1}.png`;
  return item.title || item.name || item.description || `image-${index + 1}.png`;
}

function normalizeRequest(request) {
  const model = resolveImageModel(request.model || 'ep-20260318144532-28ssz');
  return {
    ...request,
    model: model.code,
    modelName: request.model_name || request.modelName || model.name,
    prompt: String(request.prompt || '').trim(),
    ratio: request.ratio || request.aspect_ratio || request.ratios || '9:16',
    resolution: request.resolution || '1k',
    count: Math.max(1, Number(request.count || request.n || 1)),
    styleId: request.style_id || request.styleId || '6a9658a204b6dbdd6d21ce84',
    images: Array.isArray(request.images) ? request.images : request.images ? [request.images] : [],
  };
}

function modelConf(request) {
  return {
    Code: request.model,
    Name: request.modelName,
    Resolution: request.resolution,
    AspectRatio: request.ratio,
  };
}

function outputImages(item) {
  const infos = item?.GeneratedResource?.ImagesInfo || item?.ImagesInfo || [];
  return infos.map((info) => ({
    image_url: info.HighResolutionUrl || info.Url || info.ThumbnailUrl || '',
    image_key: info.HighResolutionKey || info.Key || info.ThumbnailKey || '',
    thumbnail_url: info.ThumbnailUrl || '',
  })).filter((info) => info.image_url || info.image_key);
}

function isConnected(browser) {
  if (!browser) return false;
  return typeof browser.isConnected === 'function' ? browser.isConnected() : browser.connected !== false;
}

function isSessionError(error) {
  return /target closed|session closed|browser.*disconnect|protocol error|execution context was destroyed/i.test(String(error));
}

function isAuthenticationError(error) {
  return /没有 DRAMART_AUTH_TOKEN|\bHTTP (401|403)\b|\b(unauthorized|forbidden)\b/i.test(String(error));
}

function recoveryReason(error) {
  return String(error)
    .replace(/\bbearer\s+\S+/ig, 'Bearer [redacted]')
    .replace(/(authorization|token|credential)(\s*[:=]\s*)\S+/ig, '$1$2[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

async function pagePost(page, requestPath, body, timeoutMs) {
  if (!page || page.isClosed()) throw new Error('Shared image session page is closed');
  return page.evaluate(
    async ({ requestPath, body, timeoutMs }) => {
      const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
      const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
      if (!token) throw new Error('localStorage 中没有 DRAMART_AUTH_TOKEN，请先登录');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(requestPath, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: token,
            'X-Vsd-Auth-Token': token,
            'X-Vsd-Refresh-Token': refreshToken || '',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(`${requestPath} HTTP ${response.status}: ${JSON.stringify(data)}`);
        return data;
      } catch (error) {
        if (controller.signal.aborted) throw new Error(`${requestPath} 请求超时 (${timeoutMs}ms)`);
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { requestPath, body, timeoutMs },
  );
}

export function createImageSession(options = {}) {
  const getBrowser = options.getBrowser;
  if (typeof getBrowser !== 'function') throw new TypeError('getBrowser is required');
  const fetchImpl = options.fetch || globalThis.fetch;
  const fs = options.fs || nodeFs;
  const teamId = options.teamId || DEFAULT_TEAM_ID;
  const tempRoot = options.tempRoot || DEFAULT_TEMP_ROOT;
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const generationTimeoutMs = options.generationTimeoutMs ?? 15 * 60 * 1000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const maxImageBytes = options.maxImageBytes ?? 50 * 1024 * 1024;
  const timers = options.timers || {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const log = options.log || (() => {});
  const onSessionReady = options.onSessionReady;
  let state = null;
  let initializationPromise = null;
  let generation = 0;

  async function notify(callback, value, label) {
    if (typeof callback !== 'function') return;
    try {
      await callback(value);
    } catch (error) {
      log(`[image-session.${label}_error] error=${recoveryReason(error)}`);
    }
  }

  function invalidate(expectedGeneration) {
    if (expectedGeneration !== undefined && state?.generation !== expectedGeneration) return;
    const invalidated = state;
    state = null;
    initializationPromise = null;
    if (invalidated) {
      invalidated.browser.off?.('disconnected', invalidated.onDisconnected);
      invalidated.page.off?.('domcontentloaded', invalidated.onPageReady);
      if (!invalidated.page.isClosed()) invalidated.page.close().catch(() => {});
    }
  }

  async function initialize() {
    const browser = await getBrowser();
    if (!isConnected(browser)) throw new Error('Browser is disconnected');
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1920, height: 920 });
      await page.goto('https://work.xiaomaomi.cn/dramart/projectlist/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
      const createResult = await pagePost(page, '/proxy/api/v1/project/create', {
        TeamId: teamId,
        AspectRatio: '9:16',
        Resolution: '720p',
        Language: 'en',
        VisualPromptId: '6a9658a204b6dbdd6d21ce84',
        CreationMode: 'manual',
      }, requestTimeoutMs);
      const projectId = createResult.Result?.ProjectId;
      const scriptId = createResult.Result?.ScriptId;
      if (!projectId || !scriptId) throw new Error(`创建 image 项目返回缺少 ID: ${JSON.stringify(createResult)}`);
      await pagePost(page, '/proxy/api/v1/project/update', { ProjectName: 'image', ProjectId: projectId, TeamId: teamId }, requestTimeoutMs);
      await pagePost(page, '/proxy/api/v1/project/update', { Status: 'resource_confirmed', ProjectId: projectId, TeamId: teamId }, requestTimeoutMs);
      const url = `https://work.xiaomaomi.cn/dramart/project/${projectId}/${scriptId}/${teamId}/canvas`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
      generation += 1;
      const initialized = { browser, page, projectName: 'image', projectId, scriptId, teamId, url, generation };
      initialized.onDisconnected = () => invalidate(initialized.generation);
      initialized.onPageReady = (frame) => {
        if (state !== initialized) return;
        if (typeof page.mainFrame === 'function' && frame && frame !== page.mainFrame()) return;
        void notify(onSessionReady, page, 'session_ready_callback');
      };
      state = initialized;
      browser.on?.('disconnected', initialized.onDisconnected);
      page.on?.('domcontentloaded', initialized.onPageReady);
      await notify(onSessionReady, initialized.page, 'session_ready_callback');
      if (state !== initialized || !isConnected(browser) || page.isClosed()) {
        throw new Error('Image session was invalidated during initialization');
      }
      return initialized;
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  }

  function ensureReady() {
    if (state && isConnected(state.browser) && !state.page.isClosed()) return Promise.resolve(state);
    if (initializationPromise) return initializationPromise;
    if (state) invalidate(state.generation);
    if (!initializationPromise) {
      let ownedPromise;
      ownedPromise = initialize().then(
        (initialized) => {
          if (initializationPromise === ownedPromise) initializationPromise = null;
          return initialized;
        },
        (error) => {
          if (initializationPromise === ownedPromise) initializationPromise = null;
          throw error;
        },
      );
      initializationPromise = ownedPromise;
    }
    return initializationPromise;
  }

  async function materializeImage(value, index, taskDir) {
    if (!value) return null;
    const trimmed = String(value).trim();
    const suffix = `${index}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (/^https?:\/\//i.test(trimmed)) {
      let response;
      try {
        response = await fetchImpl(trimmed, { signal: AbortSignal.timeout(requestTimeoutMs) });
      } catch (error) {
        throw new Error(`下载图片请求失败或超时 (${requestTimeoutMs}ms): ${trimmed}: ${String(error)}`);
      }
      if (!response.ok) throw new Error(`下载图片失败 HTTP ${response.status}: ${trimmed}`);
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxImageBytes) throw new Error(`下载图片超过大小限制 ${Math.floor(maxImageBytes / 1024 / 1024)}MB: ${trimmed}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxImageBytes) throw new Error(`下载图片超过大小限制 ${Math.floor(maxImageBytes / 1024 / 1024)}MB: ${trimmed}`);
      const filePath = path.join(taskDir, `image-${suffix}${extensionFromMime(response.headers.get('content-type') || 'image/png')}`);
      await fs.writeFile(filePath, buffer);
      return filePath;
    }
    if (trimmed.startsWith('data:')) {
      const match = trimmed.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new Error('不支持的 data URL 图片格式');
      const filePath = path.join(taskDir, `image-${suffix}${extensionFromMime(match[1])}`);
      await fs.writeFile(filePath, Buffer.from(match[2], 'base64'));
      return filePath;
    }
    const candidate = path.resolve(trimmed);
    try {
      await fs.access(candidate);
      const filePath = path.join(taskDir, `image-${suffix}${path.extname(candidate) || '.png'}`);
      await fs.copyFile(candidate, filePath);
      return filePath;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const filePath = path.join(taskDir, `image-${suffix}.png`);
    await fs.writeFile(filePath, Buffer.from(trimmed, 'base64'));
    return filePath;
  }

  async function uploadImage(sessionState, filePath, title) {
    const suffix = path.extname(filePath).replace('.', '').toLowerCase() || 'png';
    const uploadResult = await pagePost(sessionState.page, '/proxy/api/v1/file/upload', {
      Type: 'image', Target: 'temp', Suffix: suffix, ProjectId: sessionState.projectId,
    }, requestTimeoutMs);
    const uploadInfo = uploadResult.Result?.UploadInfos?.[0];
    if (!uploadInfo?.Url || !uploadInfo?.TosKey) throw new Error(`上传凭证返回异常: ${JSON.stringify(uploadResult)}`);
    let putResponse;
    try {
      putResponse = await fetchImpl(uploadInfo.Url, {
        method: 'PUT', headers: { 'content-type': mimeFromSuffix(suffix) }, body: await fs.readFile(filePath), signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      throw new Error(`上传 TOS 请求失败或超时 (${requestTimeoutMs}ms): ${String(error)}`);
    }
    if (!putResponse.ok) throw new Error(`上传 TOS 失败 HTTP ${putResponse.status}: ${await putResponse.text()}`);
    const addResult = await pagePost(sessionState.page, '/proxy/api/v1/image/add', {
      TeamId: sessionState.teamId,
      ProjectId: sessionState.projectId,
      ScriptId: sessionState.scriptId,
      SourceType: 'custom',
      Image: { Name: title },
      File: { TosKey: uploadInfo.TosKey, ImageTitle: title },
    }, requestTimeoutMs);
    if (!addResult.Result?.ImageId) throw new Error(`登记图片返回缺少 ImageId: ${JSON.stringify(addResult)}`);
    return {
      imageId: addResult.Result.ImageId,
      imageKey: uploadInfo.TosKey,
      imageUrl: uploadInfo.DownloadTosUrl || uploadInfo.Url,
      description: title,
    };
  }

  async function runTask(taskId, rawRequest, taskOptions = {}) {
    const request = normalizeRequest(rawRequest);
    const generationDetail = `${request.modelName} · ${request.ratio} · ${request.count} 张`;
    await notify(taskOptions.onProgress, { code: 'preparing_session', stage: '准备生图会话', detail: '' }, 'progress_callback');
    const taskDir = path.join(tempRoot, String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_'));
    await fs.mkdir(taskDir, { recursive: true });
    let sessionState;
    let resourceId = '';
    let submitted = false;
    try {
      sessionState = await ensureReady();
      await taskOptions.onReady?.(sessionState);
      await notify(taskOptions.onProgress, {
        code: 'uploading_references',
        stage: '正在上传参考图',
        detail: `${request.images.length} 张图片`,
      }, 'progress_callback');
      const refs = await Promise.all(request.images.map(async (item, index) => {
        const filePath = await materializeImage(imageValue(item), index, taskDir);
        return filePath ? uploadImage(sessionState, filePath, imageTitle(item, index)) : null;
      }));
      const refImages = refs.filter(Boolean);
      if (!refImages.length) throw new Error('没有可用参考图');
      await notify(taskOptions.onProgress, { code: 'creating_resource', stage: '正在创建生图资源', detail: '' }, 'progress_callback');
      const generated = await pagePost(sessionState.page, '/proxy/api/v1/image/add', {
        TeamId: sessionState.teamId,
        ScriptId: sessionState.scriptId,
        ProjectId: sessionState.projectId,
        SourceType: 'generated',
        Image: { Name: request.title || '图片1' },
      }, requestTimeoutMs);
      resourceId = generated.Result?.ImageId;
      if (!resourceId) throw new Error(`创建生图资源返回缺少 ImageId: ${JSON.stringify(generated)}`);
      await notify(taskOptions.onProgress, { code: 'submitting', stage: '正在提交图片生成', detail: generationDetail }, 'progress_callback');
      await pagePost(sessionState.page, '/proxy/api/v1/tasks/image/generate', {
        Type: 'image',
        TeamId: sessionState.teamId,
        ScriptId: sessionState.scriptId,
        ProjectId: sessionState.projectId,
        CreatedFrom: 'canvas',
        Prompt: request.prompt,
        Count: request.count,
        ResourceId: resourceId,
        ModelConf: modelConf(request),
        GenerationParams: [{
          ScriptUniqId: '',
          RefImages: refImages.map((image) => ({ ImageKey: image.imageKey, ImageUrl: image.imageUrl, Description: image.description })),
        }],
        ParsedPrompt: { StyleId: request.styleId },
      }, requestTimeoutMs);
      submitted = true;
      await notify(taskOptions.onProgress, { code: 'generating', stage: '图片生成中', detail: generationDetail }, 'progress_callback');
      const pollingTarget = {
        teamId: sessionState.teamId,
        projectId: sessionState.projectId,
        scriptId: sessionState.scriptId,
        resourceId,
      };
      log(`[image-session.submit] task_id=${taskId} resource_id=${resourceId} ratio=${request.ratio}`);

      const started = timers.now();
      while (timers.now() - started < generationTimeoutMs) {
        let listResult;
        try {
          listResult = await pagePost(sessionState.page, '/proxy/api/v1/tasks/image/list', {
            TeamId: pollingTarget.teamId,
            ProjectId: pollingTarget.projectId,
            ScriptId: pollingTarget.scriptId,
            PageIndex: 1,
            PageSize: 1,
            Filters: { ResourceType: 'image', ResourceIds: [pollingTarget.resourceId] },
          }, requestTimeoutMs);
        } catch (error) {
          if (!isSessionError(error) && !isAuthenticationError(error) && !sessionState.page.isClosed() && isConnected(sessionState.browser)) throw error;
          const oldProjectId = pollingTarget.projectId;
          await notify(taskOptions.onProgress, { code: 'recovering_session', stage: '正在恢复生图会话', detail: '' }, 'progress_callback');
          invalidate(sessionState.generation);
          let recovered;
          try {
            recovered = await ensureReady();
          } catch (recoveryError) {
            return { status: 'failed', resourceId, failedReason: `图片任务已提交，但会话恢复失败；旧项目 ${oldProjectId} 的资源 ${resourceId} 无法继续查询: ${String(recoveryError)}` };
          }
          log(`[image-session.poll_recover] task_id=${taskId} resource_id=${resourceId} old_project_id=${oldProjectId} mounted_project_id=${recovered.projectId} reason=${recoveryReason(error)}`);
          sessionState = recovered;
          await notify(taskOptions.onProgress, { code: 'generating', stage: '图片生成中', detail: generationDetail }, 'progress_callback');
          continue;
        }
        const item = listResult.Result?.Items?.find((candidate) => candidate?.ResourceId === resourceId);
        if (!item) {
          await timers.sleep(pollIntervalMs);
          continue;
        }
        const status = item?.Status || 'unknown';
        if (status === 'done') return { status: 'succeeded', resourceId, response: item, images: outputImages(item) };
        if (['failed', 'cancelled', 'expired'].includes(status)) {
          return { status: 'failed', resourceId, response: item, failedReason: item?.FailedReason || status };
        }
        await timers.sleep(pollIntervalMs);
      }
      return { status: 'failed', resourceId, failedReason: '图片生成超时' };
    } catch (error) {
      if (sessionState && (sessionState.page.isClosed() || !isConnected(sessionState.browser) || isSessionError(error) || isAuthenticationError(error))) {
        invalidate(sessionState.generation);
      }
      if (submitted) {
        return { status: 'failed', resourceId, failedReason: `图片任务已提交，但旧项目 ${sessionState?.projectId || 'unknown'} 的资源 ${resourceId} 轮询上下文失效，未重复提交: ${String(error)}` };
      }
      throw error;
    } finally {
      await fs.rm(taskDir, { recursive: true, force: true }).catch((error) => log(`[image-session.cleanup_error] task_id=${taskId} error=${String(error)}`));
    }
  }

  return { ensureReady, runTask };
}
