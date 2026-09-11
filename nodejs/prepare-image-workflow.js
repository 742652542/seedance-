import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_OPEN_API = process.env.BROWSER_OPEN_API || 'http://127.0.0.1:27997/api/v2/profile-open';
const PROFILE_ID = Number(process.env.PROFILE_ID || 81372);
const TEAM_ID = process.env.TEAM_ID || '6a90faa57906980889d712fd';
const PROJECT_DATE = process.env.PROJECT_DATE || new Date().toLocaleDateString('en-CA');
const GENERATION_TIMEOUT_MS = Number(process.env.GENERATION_TIMEOUT_MS || 15 * 60 * 1000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const TEMP_DIR = path.join(__dirname, 'tmp-upload-images');
const TASK_ID = process.env.SEEDANCE_TASK_ID || 'manual-image-task';
const TASK_STARTED_AT = new Date().toLocaleString('zh-CN', { hour12: false });
let activeBrowserURL = process.env.BROWSER_URL || '';

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

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
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
  const model = IMAGE_MODEL_MAP[request.model] || IMAGE_MODEL_MAP[String(request.model || '').toLowerCase()] || IMAGE_MODEL_MAP['ep-20260318144532-28ssz'];
  return {
    model: model.code,
    modelName: request.model_name || request.modelName || model.name,
    prompt: String(request.prompt ?? promptFromContent ?? '').trim(),
    ratio: request.ratio || request.aspect_ratio || request.ratios || '9:16',
    resolution: request.resolution || '1k',
    count: Math.max(1, Number(request.count || request.n || 1)),
    styleId: request.style_id || request.styleId || '6a9658a204b6dbdd6d21ce84',
    images,
  };
}

function imageValue(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const imageUrl = item.image_url;
  if (typeof imageUrl === 'string') return imageUrl;
  if (imageUrl && typeof imageUrl === 'object') return imageUrl.url || '';
  return item.url || item.image || '';
}

function imageTitle(item, index) {
  if (!item || typeof item !== 'object') return `image-${index + 1}.png`;
  return item.title || item.name || item.description || `image-${index + 1}.png`;
}

function extensionFromMime(mime) {
  if (mime.includes('jpeg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('bmp')) return '.bmp';
  return '.png';
}

function suffixFromFile(filePath) {
  return path.extname(filePath).replace('.', '').toLowerCase() || 'png';
}

function mimeFromSuffix(suffix) {
  if (suffix === 'jpg' || suffix === 'jpeg') return 'image/jpeg';
  if (suffix === 'webp') return 'image/webp';
  if (suffix === 'gif') return 'image/gif';
  if (suffix === 'bmp') return 'image/bmp';
  return 'image/png';
}

async function materializeImage(value, index) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (/^https?:\/\//i.test(trimmed)) {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const response = await fetch(trimmed);
    if (!response.ok) throw new Error(`下载图片失败 HTTP ${response.status}: ${trimmed}`);
    const mime = response.headers.get('content-type') || 'image/png';
    const buffer = Buffer.from(await response.arrayBuffer());
    const filePath = path.join(TEMP_DIR, `image-${Date.now()}-${index}${extensionFromMime(mime)}`);
    await fs.writeFile(filePath, buffer);
    return filePath;
  }
  if (trimmed.startsWith('data:')) {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const match = trimmed.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('不支持的 data URL 图片格式');
    const filePath = path.join(TEMP_DIR, `image-${Date.now()}-${index}${extensionFromMime(match[1])}`);
    await fs.writeFile(filePath, Buffer.from(match[2], 'base64'));
    return filePath;
  }
  const maybePath = path.resolve(trimmed);
  try {
    await fs.access(maybePath);
    return maybePath;
  } catch {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const filePath = path.join(TEMP_DIR, `image-${Date.now()}-${index}.png`);
    await fs.writeFile(filePath, Buffer.from(trimmed, 'base64'));
    return filePath;
  }
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
      panel.style.cssText = 'position:fixed;right:20px;bottom:70px;z-index:2147483647;width:340px;max-width:calc(100vw - 40px);padding:16px;border:1px solid rgba(255,255,255,.16);border-radius:14px;background:rgba(17,24,39,.94);box-shadow:0 16px 45px rgba(0,0,0,.32);color:#f8fafc;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;backdrop-filter:blur(12px);pointer-events:none';
      document.body.appendChild(panel);
    }
    const color = status === 'success' ? '#34d399' : status === 'error' ? '#fb7185' : '#60a5fa';
    const label = status === 'success' ? '已完成' : status === 'error' ? '执行失败' : '执行中';
    panel.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px"><strong style="font-size:15px">Seedance 生图任务</strong><span style="color:${color};font-weight:700">${label}</span></div><div style="color:#94a3b8;margin-bottom:3px">任务 ID</div><div style="word-break:break-all;margin-bottom:9px">${taskId}</div><div style="color:#94a3b8;margin-bottom:3px">当前步骤</div><div style="color:${color};font-weight:650;margin-bottom:${detailText ? '7px' : '9px'}">${stepText}</div>${detailText ? `<div style="color:#cbd5e1;word-break:break-word;margin-bottom:9px">${detailText}</div>` : ''}<div style="display:flex;justify-content:space-between;color:#64748b;font-size:12px"><span>开始：${startedAt}</span><span>更新：${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</span></div>`;
  }, { taskId: TASK_ID, startedAt: TASK_STARTED_AT, stepText: step, detailText: detail, status: state }).catch(() => {});
}

async function setViewportToWindow(page) {
  await page.setViewport({ width: 1920, height: 920 });
}

function findDebugPort(data) {
  return (
    data?.data?.debug_port ||
    data?.data?.debugPort ||
    data?.data?.debugging_port ||
    data?.data?.port ||
    data?.data?.debugging_address?.split(':').at(-1) ||
    data?.debug_port ||
    data?.debugPort ||
    data?.debugging_port ||
    data?.port
  );
}

function findBrowserURL(data) {
  const ws = data?.data?.ws || data?.ws;
  if (ws) return String(ws);
  const direct = data?.data?.browser_url || data?.data?.browserURL || data?.data?.debugging_url || data?.browser_url || data?.browserURL || data?.debugging_url;
  if (direct) return String(direct);
  const port = findDebugPort(data);
  return port ? `http://127.0.0.1:${port}` : '';
}

function browserConnectOptions(endpoint) {
  const viewport = { width: 1920, height: 920 };
  return String(endpoint).startsWith('ws:') || String(endpoint).startsWith('wss:')
    ? { browserWSEndpoint: endpoint, defaultViewport: viewport }
    : { browserURL: endpoint, defaultViewport: viewport };
}

function versionURL(endpoint) {
  if (!String(endpoint).startsWith('ws')) return `${endpoint.replace(/\/$/, '')}/json/version`;
  return endpoint.replace(/^ws/, 'http').replace(/\/devtools\/browser\/.+$/, '/json/version');
}

async function resolveBrowserURL() {
  console.log('步骤: 连接浏览器');
  if (activeBrowserURL) {
    try {
      const response = await fetch(versionURL(activeBrowserURL), { signal: AbortSignal.timeout(3000) });
      if (response.ok) return activeBrowserURL;
    } catch {
      activeBrowserURL = '';
    }
  }
  const response = await fetch(BROWSER_OPEN_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profile_id: PROFILE_ID,
      args: ['--disable-extension-welcome-page'],
      load_extensions: false,
      load_default_page: false,
      is_cookies_cache: false,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`打开浏览器失败 HTTP ${response.status}: ${JSON.stringify(result)}`);
  const browserURL = findBrowserURL(result);
  if (!browserURL) throw new Error(`打开浏览器返回中没有连接地址: ${JSON.stringify(result)}`);
  return browserURL;
}

async function pagePost(page, requestPath, body) {
  return page.evaluate(
    async ({ requestPath, body }) => {
      const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
      const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
      if (!token) throw new Error('localStorage 中没有 DRAMART_AUTH_TOKEN，请先登录');
      const response = await fetch(requestPath, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: token,
          'X-Vsd-Auth-Token': token,
          'X-Vsd-Refresh-Token': refreshToken || '',
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`${requestPath} HTTP ${response.status}: ${JSON.stringify(data)}`);
      return data;
    },
    { requestPath, body },
  );
}

async function ensureProjectForRatio(page, ratio) {
  console.log(`步骤: 打开项目列表，查找比例项目 ${ratio}`);
  await page.goto('https://work.xiaomaomi.cn/dramart/projectlist/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
  const projectName = `${PROJECT_DATE}-${ratio}`;
  const listResult = await pagePost(page, '/proxy/api/v1/project/list', {
    TeamId: TEAM_ID,
    Filters: { CreationMode: 'agent,manual' },
    PageIndex: 1,
    PageSize: 100,
  });
  const existing = (listResult.Result?.Items || [])
    .filter((project) => project.ProjectName === projectName)
    .sort((a, b) => new Date(b.CreatedAt || b.UpdatedAt) - new Date(a.CreatedAt || a.UpdatedAt))[0];
  if (existing) {
    console.log(`步骤: 使用已有项目 ${projectName}`);
    return {
      action: 'exists',
      projectName,
      projectId: existing.ProjectId,
      scriptId: existing.ScriptId,
      teamId: existing.TeamId || TEAM_ID,
      url: `https://work.xiaomaomi.cn/dramart/project/${existing.ProjectId}/${existing.ScriptId}/${existing.TeamId || TEAM_ID}/canvas`,
    };
  }

  console.log(`步骤: 创建比例项目 ${projectName}`);
  const createResult = await pagePost(page, '/proxy/api/v1/project/create', {
    TeamId: TEAM_ID,
    AspectRatio: ratio,
    Resolution: '720p',
    Language: 'en',
    VisualPromptId: '6a9658a204b6dbdd6d21ce84',
    CreationMode: 'manual',
  });
  const projectId = createResult.Result?.ProjectId;
  const scriptId = createResult.Result?.ScriptId;
  if (!projectId || !scriptId) throw new Error(`创建项目返回缺少 ID: ${JSON.stringify(createResult)}`);
  await pagePost(page, '/proxy/api/v1/project/update', { ProjectName: projectName, ProjectId: projectId, TeamId: TEAM_ID });
  await pagePost(page, '/proxy/api/v1/project/update', { Status: 'resource_confirmed', ProjectId: projectId, TeamId: TEAM_ID });
  return {
    action: 'created',
    projectName,
    projectId,
    scriptId,
    teamId: TEAM_ID,
    url: `https://work.xiaomaomi.cn/dramart/project/${projectId}/${scriptId}/${TEAM_ID}/canvas`,
  };
}

async function uploadImage(page, project, filePath, title) {
  console.log(`步骤: 获取图片上传凭证 ${title}`);
  const suffix = suffixFromFile(filePath);
  const uploadResult = await pagePost(page, '/proxy/api/v1/file/upload', {
    Type: 'image',
    Target: 'temp',
    Suffix: suffix,
    ProjectId: project.projectId,
  });
  const uploadInfo = uploadResult.Result?.UploadInfos?.[0];
  if (!uploadInfo?.Url || !uploadInfo?.TosKey) throw new Error(`上传凭证返回异常: ${JSON.stringify(uploadResult)}`);

  const buffer = await fs.readFile(filePath);
  console.log(`步骤: 上传图片到 TOS ${path.basename(filePath)}`);
  const putResponse = await fetch(uploadInfo.Url, { method: 'PUT', headers: { 'content-type': mimeFromSuffix(suffix) }, body: buffer });
  if (!putResponse.ok) throw new Error(`上传 TOS 失败 HTTP ${putResponse.status}: ${await putResponse.text()}`);

  console.log('步骤: 登记参考图片资源');
  const addResult = await pagePost(page, '/proxy/api/v1/image/add', {
    TeamId: project.teamId,
    ProjectId: project.projectId,
    ScriptId: project.scriptId,
    SourceType: 'custom',
    Image: { Name: title },
    File: { TosKey: uploadInfo.TosKey, ImageTitle: title },
  });
  const imageId = addResult.Result?.ImageId;
  if (!imageId) throw new Error(`登记图片返回缺少 ImageId: ${JSON.stringify(addResult)}`);
  console.log(`步骤: 参考图片登记完成 ImageId=${imageId}`);
  return {
    imageId,
    imageKey: uploadInfo.TosKey,
    imageUrl: uploadInfo.DownloadTosUrl || uploadInfo.Url,
    description: title,
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

function modelConf(request) {
  return {
    Code: request.model,
    Name: request.modelName,
    Resolution: request.resolution,
    AspectRatio: request.ratio,
  };
}

async function generateImage(page, project, request, refImages) {
  console.log('步骤: 创建生图结果资源');
  const generatedAddResult = await pagePost(page, '/proxy/api/v1/image/add', {
    TeamId: project.teamId,
    ScriptId: project.scriptId,
    ProjectId: project.projectId,
    SourceType: 'generated',
    Image: { Name: request.title || '图片1' },
  });
  const resourceId = generatedAddResult.Result?.ImageId;
  if (!resourceId) throw new Error(`创建生图资源返回缺少 ImageId: ${JSON.stringify(generatedAddResult)}`);
  console.log(`步骤: 生图结果资源创建完成 ResourceId=${resourceId}`);

  console.log(`步骤: 提交生图任务 model=${request.modelName} code=${request.model} ratio=${request.ratio} count=${request.count}`);
  await pagePost(page, '/proxy/api/v1/tasks/image/generate', {
    Type: 'image',
    TeamId: project.teamId,
    ScriptId: project.scriptId,
    ProjectId: project.projectId,
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
  });

  const start = Date.now();
  while (Date.now() - start < GENERATION_TIMEOUT_MS) {
    const listResult = await pagePost(page, '/proxy/api/v1/tasks/image/list', {
      TeamId: project.teamId,
      ProjectId: project.projectId,
      ScriptId: project.scriptId,
      PageIndex: 1,
      PageSize: 1,
      Filters: { ResourceType: 'image', ResourceIds: [resourceId] },
    });
    const item = listResult.Result?.Items?.[0];
    const status = item?.Status || 'unknown';
    console.log(`图片任务状态: ${status}`);
    if (status === 'done') return { status: 'succeeded', resourceId, response: item, images: outputImages(item) };
    if (['failed', 'cancelled', 'expired'].includes(status)) {
      return { status: 'failed', resourceId, response: item, failedReason: item?.FailedReason || status };
    }
    await wait(POLL_INTERVAL_MS);
  }
  return { status: 'failed', resourceId, failedReason: '图片生成超时' };
}

async function main() {
  const request = normalizeRequest(await loadRequest());
  if (!request.prompt) throw new Error('prompt 不能为空');
  if (!request.images.length) throw new Error('图片生成至少需要 1 张参考图');
  console.log(`步骤: 读取请求 prompt=${request.prompt} model=${request.modelName} ratio=${request.ratio}`);

  const browserURL = await resolveBrowserURL();
  const browser = await puppeteer.connect(browserConnectOptions(browserURL));
  const page = await browser.newPage();
  try {
    await updateTaskStatus(page, '正在初始化任务', `${request.modelName} · ${request.ratio} · ${request.count} 张`);
    await setViewportToWindow(page);
    const project = await ensureProjectForRatio(page, request.ratio);
    console.log(`步骤: 打开画布 ${project.url}`);
    await page.goto(project.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
    await updateTaskStatus(page, '项目准备完成', project.projectName || project.url);
    console.log('TASK_STARTED ' + JSON.stringify({ ...project, type: 'image', prompt: request.prompt }));

    const refImages = [];
    await updateTaskStatus(page, '正在上传参考图', `${request.images.length} 张图片`);
    for (let index = 0; index < request.images.length; index += 1) {
      const source = imageValue(request.images[index]);
      const filePath = await materializeImage(source, index);
      if (!filePath) continue;
      refImages.push(await uploadImage(page, project, filePath, imageTitle(request.images[index], index)));
    }
    if (!refImages.length) throw new Error('没有可用参考图');

    await updateTaskStatus(page, '正在生成图片', `${request.modelName} · ${request.ratio} · ${request.count} 张`);
    const generationResult = await generateImage(page, project, request, refImages);
    await updateTaskStatus(
      page,
      generationResult.status === 'succeeded' ? '图片生成完成' : '图片生成失败',
      generationResult.status === 'succeeded' ? `已生成 ${generationResult.images.length} 张图片` : generationResult.failedReason || '',
      generationResult.status === 'succeeded' ? 'success' : 'error',
    );
    console.log('RESULT_JSON ' + JSON.stringify({ project, request: { ...request, images: undefined }, refImages, generationResult }));
    if (generationResult.status !== 'succeeded') process.exitCode = 1;
  } finally {
    await page.close().catch(() => {});
    await browser.disconnect();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
