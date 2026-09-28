import nodeFsSync from 'node:fs';
import nodeFs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_TEMP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp-canvas-video');

const VIDEO_MODEL_MAP = {
  'Doubao-Seedance-2.5': 'ep-20260729173114-qjxc2',
  'ep-20260729173114-qjxc2': 'ep-20260729173114-qjxc2',
  'Doubao-Seedance-2-0': 'ep-20260322113401-vj4bf',
  'ep-20260322113401-vj4bf': 'ep-20260322113401-vj4bf',
  'Doubao-Seedance-2.0-fast': 'ep-20260320142658-hscwv',
  'ep-20260320142658-hscwv': 'ep-20260320142658-hscwv',
  'Doubao-Seedance-2.0-mini': 'doubao-seedance-2-0-mini-260615',
  'doubao-seedance-2-0-mini-260615': 'doubao-seedance-2-0-mini-260615',
};

export const CANVAS_VIDEO_MODELS = new Set(Object.keys(VIDEO_MODEL_MAP));

export function resolveCanvasVideoModel(model) {
  return VIDEO_MODEL_MAP[model] || VIDEO_MODEL_MAP[String(model || '').trim()] || '';
}

function valueFrom(item, kind) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const typed = item[`${kind}_url`];
  if (typeof typed === 'string') return typed;
  return typed?.url || item.url || item[kind] || '';
}

function titleFrom(item, index, kind) {
  if (!item || typeof item !== 'object') return `${kind}-${index + 1}`;
  return item.title || item.name || item.description || `${kind}-${index + 1}`;
}

function directReference(item, kind) {
  if (!item || typeof item !== 'object') return null;
  const key = item.Key || item.key || item.image_key || item.video_key;
  const url = item.Url || item.url || item.image_url?.url || item.video_url?.url ||
    item.image_url || item.video_url;
  if (!key || !url) return null;
  if (kind === 'image') {
    return compact({
      Key: key,
      Url: url,
      ArkAssetId: item.ArkAssetId || item.ark_asset_id || item.arkAssetId,
      Description: item.Description || item.description || item.title || item.name,
    });
  }
  return compact({
    Key: key,
    Url: url,
    ResourceId: item.ResourceId || item.resource_id || item.resourceId || item.MediaId || item.media_id,
    ArkAssetId: item.ArkAssetId || item.ark_asset_id || item.arkAssetId,
    Description: item.Description || item.description || item.title || item.name,
    Duration: finiteNumber(item.Duration ?? item.duration),
  });
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function createConcurrencyLimiter(concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('mediaTransferConcurrency must be a positive integer');
  }
  let active = 0;
  const waiting = [];

  async function acquire() {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiting.push(resolve));
    active += 1;
  }

  function release() {
    active -= 1;
    waiting.shift()?.();
  }

  return async (operation) => {
    await acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

function extensionFromContentType(contentType, kind) {
  const type = String(contentType || '').toLowerCase();
  if (kind === 'video') {
    if (type.includes('quicktime')) return '.mov';
    if (type.includes('webm')) return '.webm';
    return '.mp4';
  }
  if (type.includes('jpeg')) return '.jpg';
  if (type.includes('webp')) return '.webp';
  if (type.includes('gif')) return '.gif';
  return '.png';
}

function contentTypeFromSuffix(suffix, kind) {
  const normalized = suffix.toLowerCase();
  if (kind === 'video') {
    if (normalized === 'mov') return 'video/quicktime';
    if (normalized === 'webm') return 'video/webm';
    return 'video/mp4';
  }
  if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg';
  if (normalized === 'webp') return 'image/webp';
  if (normalized === 'gif') return 'image/gif';
  return 'image/png';
}

function isConnected(browser) {
  if (!browser) return false;
  if (typeof browser.isConnected === 'function') return browser.isConnected();
  return browser.connected !== false;
}

function isSessionError(error) {
  return /target closed|session closed|browser.*disconnect|protocol error|execution context was destroyed|\bHTTP (401|403)\b|unauthorized|forbidden/i.test(String(error));
}

async function pagePost(page, requestPath, body, timeoutMs) {
  if (!page || page.isClosed()) throw new Error('Shared canvas session page is closed');
  try {
    return await page.evaluate(async ({ requestPath, body, timeoutMs }) => {
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
    }, { requestPath, body, timeoutMs });
  } catch (error) {
    if (String(error).includes(requestPath)) throw error;
    throw new Error(`${requestPath} 页面调用失败: ${String(error)}`, { cause: error });
  }
}

export function normalizeCanvasVideoRequest(rawRequest, defaultStyleId = '') {
  const model = resolveCanvasVideoModel(rawRequest.model || 'Doubao-Seedance-2-0');
  return {
    ...rawRequest,
    model,
    prompt: String(rawRequest.prompt || '').trim(),
    ratio: rawRequest.ratio || rawRequest.aspect_ratio || rawRequest.ratios || '16:9',
    duration: Number(rawRequest.duration || 5),
    resolution: String(rawRequest.resolution || '720p').toLowerCase(),
    count: Math.max(1, Number(rawRequest.count || rawRequest.n || 1)),
    outputFormat: rawRequest.output_format || rawRequest.outputFormat || 'mp4',
    styleId: String(rawRequest.style_id || rawRequest.styleId || defaultStyleId || '').trim(),
    genType: rawRequest.gen_type || rawRequest.genType || 'reference_frame',
    images: Array.isArray(rawRequest.images) ? rawRequest.images : rawRequest.images ? [rawRequest.images] : [],
    videos: Array.isArray(rawRequest.videos) ? rawRequest.videos : rawRequest.videos ? [rawRequest.videos] : [],
  };
}

function outputVideos(item) {
  return (item?.GeneratedVideos || []).map((video) => ({
    video_url: video.VideoUrl || video.VideoPreviewUrl || '',
    video_key: video.VideoKey || '',
    thumbnail_url: video.VideoThumbnailUrl || '',
    selected: Boolean(video.Selected),
  })).filter((video) => video.video_url || video.video_key);
}

export function createCanvasVideoSession(options = {}) {
  const getSession = options.getSession;
  if (typeof getSession !== 'function') throw new TypeError('getSession is required');
  const fetchImpl = options.fetch || globalThis.fetch;
  const fs = options.fs || nodeFs;
  const tempRoot = options.tempRoot || DEFAULT_TEMP_ROOT;
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const generationTimeoutMs = options.generationTimeoutMs ?? 30 * 60 * 1000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const transferTimeoutMs = options.transferTimeoutMs ?? 15 * 60 * 1000;
  const maxImageBytes = options.maxImageBytes ?? 50 * 1024 * 1024;
  const maxVideoBytes = options.maxVideoBytes ?? 500 * 1024 * 1024;
  const mediaTransferConcurrency = Number(options.mediaTransferConcurrency ?? 2);
  const limitMediaTransfer = createConcurrencyLimiter(mediaTransferConcurrency);
  const createReadStream = options.createReadStream || nodeFsSync.createReadStream;
  const createWriteStream = options.createWriteStream || nodeFsSync.createWriteStream;
  const timers = options.timers || { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
  const log = options.log || (() => {});
  const post = options.post || ((session, requestPath, body) => pagePost(session.page, requestPath, body, requestTimeoutMs));

  async function notify(callback, value) {
    if (typeof callback !== 'function') return;
    try { await callback(value); } catch (error) { log(`[canvas-video.progress_error] error=${String(error)}`); }
  }

  async function materialize(value, index, kind, taskDir) {
    if (!value) return null;
    const trimmed = String(value).trim();
    const suffix = `${kind}-${index}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const maxBytes = kind === 'video' ? maxVideoBytes : maxImageBytes;
    if (/^https?:\/\//i.test(trimmed)) {
      const signal = AbortSignal.timeout(transferTimeoutMs);
      let response;
      let filePath = '';
      try {
        response = await fetchImpl(trimmed, { signal });
        if (!response.ok) throw new Error(`下载${kind === 'video' ? '视频' : '图片'}失败 HTTP ${response.status}: ${trimmed}`);
        const contentLengthHeader = response.headers.get('content-length');
        const contentLength = contentLengthHeader == null ? NaN : Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          Promise.resolve(response.body?.cancel?.()).catch(() => {});
          throw new Error(`下载文件超过大小限制: ${trimmed}`);
        }
        if (!response.body) throw new Error(`下载响应缺少内容: ${trimmed}`);
        filePath = path.join(taskDir, `${suffix}${extensionFromContentType(response.headers.get('content-type'), kind)}`);
        let received = 0;
        const limiter = new Transform({
          transform(chunk, _encoding, callback) {
            received += chunk.length;
            if (received > maxBytes) {
              callback(new Error(`下载文件超过大小限制: ${trimmed}`));
              return;
            }
            callback(null, chunk);
          },
        });
        const source = typeof response.body.getReader === 'function'
          ? Readable.fromWeb(response.body)
          : response.body;
        await pipeline(source, limiter, createWriteStream(filePath, { flags: 'wx' }), { signal });
        return filePath;
      } catch (error) {
        if (filePath) await fs.rm(filePath, { force: true }).catch(() => {});
        if (signal.aborted) throw new Error(`下载${kind === 'video' ? '视频' : '图片'}超时 (${transferTimeoutMs}ms): ${trimmed}`, { cause: error });
        throw error;
      }
    }
    if (trimmed.startsWith('data:')) {
      const match = trimmed.match(/^data:([^;]+);base64,(.+)$/s);
      if (!match) throw new Error('不支持的 data URL 格式');
      const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
      if (buffer.length > maxBytes) throw new Error('Data URL 文件超过大小限制');
      const filePath = path.join(taskDir, `${suffix}${extensionFromContentType(match[1], kind)}`);
      await fs.writeFile(filePath, buffer);
      return filePath;
    }
    const candidate = path.resolve(trimmed);
    try {
      const stat = await fs.stat(candidate);
      if (stat.size > maxBytes) throw new Error(`本地文件超过大小限制: ${candidate}`);
      const filePath = path.join(taskDir, `${suffix}${path.extname(candidate) || extensionFromContentType('', kind)}`);
      await fs.copyFile(candidate, filePath);
      return filePath;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const buffer = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64');
    if (!buffer.length) throw new Error(`找不到本地文件且内容不是有效 Base64: ${trimmed.slice(0, 80)}`);
    const filePath = path.join(taskDir, `${suffix}${extensionFromContentType('', kind)}`);
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  async function uploadFile(session, filePath, kind) {
    const suffix = path.extname(filePath).slice(1).toLowerCase() || (kind === 'video' ? 'mp4' : 'png');
    const uploadResult = await post(session, '/proxy/api/v1/file/upload', {
      Type: kind,
      Target: 'temp',
      Suffix: suffix,
      ProjectId: session.projectId,
    });
    const uploadInfo = uploadResult.Result?.UploadInfos?.[0];
    if (!uploadInfo?.Url || !uploadInfo?.TosKey) throw new Error(`上传凭证返回异常: ${JSON.stringify(uploadResult)}`);
    const stat = await fs.stat(filePath);
    const body = createReadStream(filePath);
    let response;
    try {
      response = await fetchImpl(uploadInfo.Url, {
        method: 'PUT',
        headers: {
          'content-type': contentTypeFromSuffix(suffix, kind),
          'content-length': String(stat.size),
        },
        body,
        duplex: 'half',
        signal: AbortSignal.timeout(transferTimeoutMs),
      });
    } finally {
      body.destroy?.();
    }
    if (!response.ok) throw new Error(`上传 TOS 失败 HTTP ${response.status}: ${await response.text()}`);
    return uploadInfo;
  }

  async function createImageArkAsset(session, uploadInfo) {
    const account = await post(session, '/proxy/api/v1/accessa/DescribeUser', {});
    const arkAssetGroupId = account.Result?.ArkAssetGroupID || account.Result?.ArkAssetGroupId;
    if (!arkAssetGroupId) throw new Error('当前账号未返回 ArkAssetGroupID，无法创建参考图资产');
    const assetUrl = uploadInfo.DownloadTosUrl || uploadInfo.Url;
    if (!assetUrl) throw new Error('上传图片返回缺少可访问 URL，无法创建参考图资产');
    const created = await post(session, '/proxy/api/v1/asset/ark_asset/create', {
      ArkAssetGroupID: arkAssetGroupId,
      Owner: { Id: session.teamId, Type: 'team' },
      Url: assetUrl,
    });
    const arkAssetId = created.Result?.ArkAssetID || created.Result?.ArkAssetId || created.Result?.arkAssetId;
    if (!arkAssetId) throw new Error(`创建参考图资产返回缺少 ArkAssetID: ${JSON.stringify(created)}`);
    return arkAssetId;
  }

  async function uploadImage(session, item, index, taskDir) {
    const direct = directReference(item, 'image');
    if (direct) return direct;
    const title = titleFrom(item, index, 'image');
    const filePath = await materialize(valueFrom(item, 'image'), index, 'image', taskDir);
    if (!filePath) return null;
    const uploadInfo = await uploadFile(session, filePath, 'image');
    const arkAssetId = await createImageArkAsset(session, uploadInfo);
    const added = await post(session, '/proxy/api/v1/image/add', {
      TeamId: session.teamId,
      ProjectId: session.projectId,
      ScriptId: session.scriptId,
      SourceType: 'custom',
      Image: { Name: title },
      File: { TosKey: uploadInfo.TosKey, ImageTitle: title },
    });
    const imageId = added.Result?.ImageId;
    if (!imageId) throw new Error(`登记图片返回缺少 ImageId: ${JSON.stringify(added)}`);
    let listed;
    try {
      listed = await post(session, '/proxy/api/v1/image/list', {
        TeamId: session.teamId,
        PageIndex: 1,
        PageSize: 1,
        Filters: { ImageIds: [imageId], ProjectId: session.projectId },
      });
    } catch (error) {
      log(`[canvas-video.image_metadata_error] image_id=${imageId} error=${String(error)}`);
    }
    const metadata = listed?.Result?.Items?.find((entry) => entry.ImageId === imageId);
    const info = metadata?.ImageInfo || metadata?.ImagesInfo?.[0] || {};
    return compact({
      Key: info.HighResolutionKey || info.Key || uploadInfo.TosKey,
      Url: info.HighResolutionUrl || info.Url || uploadInfo.DownloadTosUrl || uploadInfo.Url,
      ArkAssetId: arkAssetId || metadata?.ArkAssetId || added.Result?.ArkAssetId,
      Description: title,
    });
  }

  async function uploadVideo(session, item, index, taskDir) {
    const direct = directReference(item, 'video');
    if (direct) return direct;
    const title = titleFrom(item, index, 'video');
    const filePath = await materialize(valueFrom(item, 'video'), index, 'video', taskDir);
    if (!filePath) return null;
    const uploadInfo = await uploadFile(session, filePath, 'video');
    const added = await post(session, '/proxy/api/v1/media/add', {
      TeamId: session.teamId,
      ProjectId: session.projectId,
      ScriptId: session.scriptId,
      Source: 'canvas',
      SourceType: 'custom',
      MediaType: 'video',
      Media: { Name: title },
      VideoFile: { VideoKey: uploadInfo.TosKey, VideoTitle: title },
      Category: 'video',
    });
    const result = added.Result || {};
    const resourceId = result.MediaId || result.ResourceId;
    if (!resourceId) throw new Error(`登记视频返回缺少 MediaId/ResourceId: ${JSON.stringify(added)}`);
    const info = result.MediaInfo || result.VideoInfo || {};
    return compact({
      Key: info.VideoKey || info.Key || uploadInfo.TosKey,
      Url: info.VideoUrl || info.Url || uploadInfo.DownloadTosUrl || uploadInfo.Url,
      ResourceId: resourceId,
      ArkAssetId: result.ArkAssetId,
      Description: title,
      Duration: finiteNumber(item?.duration ?? item?.Duration ?? info.Duration),
    });
  }

  async function createOutputResource(session, request) {
    const added = await post(session, '/proxy/api/v1/media/add', {
      TeamId: session.teamId,
      ProjectId: session.projectId,
      ScriptId: session.scriptId,
      MediaType: 'video',
      Source: 'canvas',
      SourceType: 'custom',
      Media: { Name: request.title || '视频生成' },
    });
    const resourceId = added.Result?.MediaId || added.Result?.ResourceId;
    if (!resourceId) throw new Error(`创建视频资源返回缺少 MediaId/ResourceId: ${JSON.stringify(added)}`);
    return resourceId;
  }

  async function runTask(taskId, rawRequest, taskOptions = {}) {
    const taskDir = path.join(tempRoot, String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_'));
    await fs.mkdir(taskDir, { recursive: true });
    let session = await getSession();
    let resourceId = '';
    let submitted = false;
    try {
      const request = normalizeCanvasVideoRequest(rawRequest, session.visualPromptId);
      if (!request.model) throw new Error(`不支持的视频模型: ${rawRequest.model || ''}`);
      if (!['reference_frame', 'head_tail_frame'].includes(request.genType)) throw new Error(`不支持的视频生成模式: ${request.genType}`);
      const requestedHeadTail = request.genType === 'head_tail_frame';
      if (requestedHeadTail && request.videos.length) throw new Error('首尾帧模式不支持参考视频，请使用全能参考模式');
      if (requestedHeadTail && !request.images.length) throw new Error('首尾帧模式至少需要 1 张图片');
      if (requestedHeadTail && request.images.length > 2) throw new Error('首尾帧模式最多支持 2 张图片');
      await taskOptions.onReady?.(session);
      await notify(taskOptions.onProgress, { code: 'preparing_references', stage: '正在准备视频参考素材', detail: `${request.images.length} 张图片 · ${request.videos.length} 个视频` });
      const [imageResults, videoResults] = await Promise.all([
        Promise.allSettled(request.images.map((item, index) => (
          limitMediaTransfer(() => uploadImage(session, item, index, taskDir))
        ))),
        Promise.allSettled(request.videos.map((item, index) => (
          limitMediaTransfer(() => uploadVideo(session, item, index, taskDir))
        ))),
      ]);
      const failedTransfer = [...imageResults, ...videoResults].find((result) => result.status === 'rejected');
      if (failedTransfer) throw failedTransfer.reason;
      const images = imageResults.map((result) => result.value);
      const videos = videoResults.map((result) => result.value);
      const refImages = images.filter(Boolean);
      const refVideos = videos.filter(Boolean);
      await notify(taskOptions.onProgress, { code: 'creating_resource', stage: '正在创建视频资源', detail: '' });
      resourceId = await createOutputResource(session, request);
      const headTail = requestedHeadTail;
      if (headTail && !refImages.length) throw new Error('首尾帧模式至少需要 1 张图片');
      if (headTail && refImages.length > 2) throw new Error('首尾帧模式最多支持 2 张图片');
      if (headTail && refVideos.length) throw new Error('首尾帧模式不支持参考视频，请使用全能参考模式');
      const videoMeta = compact({
        GenType: request.genType,
        Prompt: headTail ? undefined : request.prompt,
        KeyFramePrompt: headTail ? request.prompt : undefined,
        ModelName: request.model,
        Ratio: request.ratio,
        Duration: request.duration,
        Resolution: request.resolution,
        Count: request.count,
        OutputFormat: request.outputFormat,
        VisualPromptId: request.styleId,
        RefImages: !headTail && refImages.length ? refImages : undefined,
        RefVideos: !headTail && refVideos.length ? refVideos : undefined,
        KeyFrameImages: headTail ? compact({
          HeadImage: refImages[0] ? compact({ Key: refImages[0].Key, ArkAssetId: refImages[0].ArkAssetId }) : undefined,
          TailImage: refImages[1] ? compact({ Key: refImages[1].Key, ArkAssetId: refImages[1].ArkAssetId }) : undefined,
        }) : undefined,
      });
      await notify(taskOptions.onProgress, { code: 'submitting', stage: '正在提交视频生成', detail: `${request.model} · ${request.duration}s · ${request.resolution}` });
      const created = await post(session, '/proxy/api/v1/tasks/video_gen/create', {
        TeamId: session.teamId,
        ProjectId: session.projectId,
        ScriptId: session.scriptId,
        ResourceId: resourceId,
        CreatedFrom: 'canvas',
        TaskType: 'gen_video',
        VideoMeta: videoMeta,
      });
      submitted = true;
      const taskIds = (created.Result?.TaskIds || []).filter(Boolean);
      if (!taskIds.length) throw new Error(`创建视频任务返回缺少 TaskIds: ${JSON.stringify(created)}`);
      log(`[canvas-video.submit] task_id=${taskId} resource_id=${resourceId} images=${refImages.length} videos=${refVideos.length}`);
      await notify(taskOptions.onProgress, { code: 'generating', stage: '视频生成中', detail: `ResourceId: ${resourceId}` });
      const pollingTarget = {
        teamId: session.teamId,
        projectId: session.projectId,
        scriptId: session.scriptId,
        resourceId,
      };
      const started = timers.now();
      while (timers.now() - started < generationTimeoutMs) {
        let response;
        try {
          response = await post(session, '/proxy/api/v1/tasks/video_gen/list', {
            TeamId: pollingTarget.teamId,
            ProjectId: pollingTarget.projectId,
            ScriptId: pollingTarget.scriptId,
            Filters: { TaskIds: taskIds, TaskType: ['gen_video'] },
          });
        } catch (error) {
          if (!isSessionError(error) && !session.page?.isClosed?.() && isConnected(session.browser)) throw error;
          session = await getSession();
          continue;
        }
        const items = (response.Result?.Videos || []).filter((entry) => entry.ResourceId === resourceId);
        if (!items.length) {
          await timers.sleep(pollIntervalMs);
          continue;
        }
        const terminal = (item) => ['done', 'failed', 'cancelled', 'canceled', 'expired'].includes(String(item.Status || '').toLowerCase()) || item.FailedReason;
        if (items.every(terminal)) {
          const generated = items.flatMap(outputVideos);
          const responseItem = { ...items[0], GeneratedVideos: items.flatMap((item) => item.GeneratedVideos || []), Tasks: items };
          if (generated.length) return { status: 'succeeded', resourceId, response: responseItem, videos: generated };
          const failed = items.find((item) => item.FailedMessage || item.FailedReason) || items[0];
          return { status: 'failed', resourceId, response: responseItem, failedReason: failed.FailedMessage || failed.FailedReason || failed.Status || '视频生成失败' };
        }
        await timers.sleep(pollIntervalMs);
      }
      return { status: 'failed', resourceId, failedReason: '视频生成超时' };
    } catch (error) {
      if (submitted) return { status: 'failed', resourceId, failedReason: `视频任务已提交但结果轮询失败，未重复提交: ${String(error)}` };
      throw error;
    } finally {
      await fs.rm(taskDir, { recursive: true, force: true }).catch((error) => log(`[canvas-video.cleanup_error] task_id=${taskId} error=${String(error)}`));
    }
  }

  return { runTask };
}
