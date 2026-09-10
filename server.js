import express from 'express';
import open from 'open';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const MODELS = new Set([
  'doubao-seedance-2-5-260628',
  'doubao-seedance-2-0-260128',
  'doubao-seedance-2-0-fast-260128',
  'doubao-seedance-2-0-mini-260615'
]);

let apiKeyConfig = null;

async function loadApiKeyConfig() {
  if (apiKeyConfig) return apiKeyConfig;

  const configPath = join(__dirname, 'api-keys.json');
  if (!existsSync(configPath)) {
    apiKeyConfig = {};
    return apiKeyConfig;
  }

  const raw = await readFile(configPath, 'utf8');
  apiKeyConfig = JSON.parse(raw);
  return apiKeyConfig;
}

async function getApiKey(model, providedKey) {
  if (providedKey && providedKey.trim()) return providedKey.trim();

  const envName = `ARK_API_KEY_${model.toUpperCase().replaceAll('-', '_')}`;
  if (process.env[envName]) return process.env[envName];
  if (process.env.ARK_API_KEY) return process.env.ARK_API_KEY;

  const keys = await loadApiKeyConfig();
  return keys[model] || '';
}

async function arkFetch(path, { method = 'GET', apiKey, body } = {}) {
  const response = await fetch(`${ARK_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message = typeof data === 'object' && data?.error?.message ? data.error.message : response.statusText;
    const error = new Error(message);
    error.statusCode = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function validateModel(model) {
  if (!MODELS.has(model)) {
    throw Object.assign(new Error('不支持的模型'), { statusCode: 400 });
  }
}

async function handleCreate(req, res) {
  const body = req.body || {};
  const { apiKey: providedKey, advancedJson, ...task } = body;
  validateModel(task.model);

  const apiKey = await getApiKey(task.model, providedKey);
  if (!apiKey) {
    return res.status(400).json({ error: '缺少该模型的 API Key，请在页面填写或创建 api-keys.json' });
  }

  let payload = task;
  if (advancedJson && advancedJson.trim()) {
    payload = { ...payload, ...JSON.parse(advancedJson) };
    validateModel(payload.model);
  }

  const result = await arkFetch('/contents/generations/tasks', {
    method: 'POST',
    apiKey,
    body: payload
  });

  res.json(result);
}

async function handleGetTask(req, res) {
  const id = req.params.id?.trim();
  const model = req.query.model || '';
  const providedKey = req.query.apiKey || '';
  if (!id) return res.status(400).json({ error: '缺少任务 ID' });
  validateModel(model);

  const apiKey = await getApiKey(model, providedKey);
  if (!apiKey) return res.status(400).json({ error: '缺少该模型的 API Key' });

  const result = await arkFetch(`/contents/generations/tasks/${encodeURIComponent(id)}`, { apiKey });
  res.json(result);
}

async function handleListTasks(req, res) {
  const model = req.query.model || '';
  const providedKey = req.query.apiKey || '';
  validateModel(model);

  const apiKey = await getApiKey(model, providedKey);
  if (!apiKey) return res.status(400).json({ error: '缺少该模型的 API Key' });

  const params = new URLSearchParams();
  for (const key of ['page_num', 'page_size', 'filter.status', 'filter.model', 'filter.service_tier']) {
    const value = req.query[key];
    if (value) params.set(key, value);
  }

  const path = `/contents/generations/tasks${params.size ? `?${params}` : ''}`;
  const result = await arkFetch(path, { apiKey });
  res.json(result);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

const app = express();

app.use(express.json({ limit: '200mb' }));
app.use(express.static(join(__dirname, 'public')));

app.post('/api/tasks', asyncRoute(handleCreate));
app.get('/api/tasks/:id', asyncRoute(handleGetTask));
app.get('/api/tasks', asyncRoute(handleListTasks));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: '上传内容太大，请减少图片数量或降低图片尺寸后重试' });
  }

  res.status(error.statusCode || 500).json({
    error: error.message || '服务器错误',
    detail: error.data
  });
});

app.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Seedance video task UI: ${url}`);

  if (process.env.NO_OPEN !== '1') {
    await open(url);
  }
});
