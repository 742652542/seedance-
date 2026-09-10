import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';
const BASE_URL = 'https://work.xiaomaomi.cn/dramart';
const today = new Date().toLocaleDateString('en-CA');
const UI_PROJECT_NAME = process.env.UI_PROJECT_NAME || `${today}-capture-ui`;
const API_PROJECT_NAME = process.env.API_PROJECT_NAME || `${today}-api-test`;
const OUTPUT_FILE = new URL('./captured-project-api.json', import.meta.url);

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart')) || pages.at(-1) || (await browser.newPage());

const captures = [];

function tryJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sanitizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) => !['authorization', 'cookie', 'x-vsd-auth-token'].includes(key.toLowerCase()),
    ),
  );
}

page.on('request', (request) => {
  const url = request.url();
  if (!url.includes('/proxy/api/v1/project/')) return;

  captures.push({
    url,
    method: request.method(),
    requestHeaders: sanitizeHeaders(request.headers()),
    requestBody: tryJson(request.postData()),
    responseStatus: null,
    responseBody: null,
  });
});

page.on('response', async (response) => {
  const url = response.url();
  if (!url.includes('/proxy/api/v1/project/')) return;

  const capture = captures.findLast((item) => item.url === url && item.responseStatus === null);
  if (!capture) return;

  capture.responseStatus = response.status();
  capture.responseBody = tryJson(await response.text().catch(() => null));
  console.log('捕获接口:', response.status(), url);
});

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickButtonByText(texts) {
  const targets = Array.isArray(texts) ? texts : [texts];
  await page.waitForFunction(
    (targetTexts) => Array.from(document.querySelectorAll('button')).some((item) => targetTexts.includes(item.innerText?.trim())),
    { timeout: 30000 },
    targets,
  );

  const rect = await page.evaluate((targetTexts) => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => targetTexts.includes(item.innerText?.trim()));
    if (!button) return null;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    return button.getBoundingClientRect().toJSON();
  }, targets);

  if (!rect) throw new Error(`没有找到按钮: ${targets.join(' / ')}`);
  await page.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2);
  await page.mouse.down();
  await wait(120);
  await page.mouse.up();
}

async function clickText(texts) {
  const targets = Array.isArray(texts) ? texts : [texts];
  await page.waitForFunction(
    (targetTexts) => Array.from(document.querySelectorAll('button, span, div')).some((item) => targetTexts.includes(item.innerText?.trim())),
    { timeout: 30000 },
    targets,
  );

  const rect = await page.evaluate((targetTexts) => {
    const element = Array.from(document.querySelectorAll('button, span, div'))
      .filter((item) => {
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      })
      .find((item) => targetTexts.includes(item.innerText?.trim()));
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    return element.getBoundingClientRect().toJSON();
  }, targets);

  if (!rect) throw new Error(`没有找到文本: ${targets.join(' / ')}`);
  await page.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2);
  await page.mouse.down();
  await wait(120);
  await page.mouse.up();
}

async function renameProject(name) {
  await page.waitForFunction(() => document.body.innerText.includes('New Project'), { timeout: 30000 });
  await page.mouse.click(143, 22);
  await page.waitForSelector('input.arco-input', { timeout: 10000 });
  await page.click('input.arco-input', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('input.arco-input', name, { delay: 20 });
  await page.keyboard.press('Enter');
  await wait(2000);
}

async function clickConfirmNext() {
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('button')).some((item) => item.innerText?.includes('已确认，进入下一步') || item.innerText?.includes('Confirmed')),
    { timeout: 30000 },
  );

  const rect = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (item) => item.innerText?.includes('已确认，进入下一步') || item.innerText?.includes('Confirmed'),
    );
    if (!button) return null;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    return button.getBoundingClientRect().toJSON();
  });

  if (!rect) throw new Error('没有找到确认进入下一步按钮');
  await page.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2);
  await page.mouse.down();
  await wait(120);
  await page.mouse.up();
}

function getData(object) {
  return object?.data || object?.result || object;
}

function extractIds(createResponse) {
  const data = getData(createResponse);
  const json = JSON.stringify(data);
  const projectId = data?.project_id || data?.project?.project_id || data?.id || json.match(/project_[a-f0-9]+/)?.[0];
  const scriptId = data?.script_id || data?.script?.script_id || json.match(/script_[a-f0-9]+/)?.[0];
  const accountId = data?.account_id || data?.user_id || json.match(/[a-f0-9]{24}/)?.[0];
  return { projectId, scriptId, accountId };
}

console.log('第一步：页面操作创建临时项目以捕获请求:', UI_PROJECT_NAME);

await page.bringToFront();
await page.setViewport({ width: 1920, height: 920 });
await page.goto(`${BASE_URL}/projectlist/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
await clickButtonByText(['创建项目', 'Create project']);
await page.waitForFunction(() => location.href.includes('/dramart/project'), { timeout: 30000 });
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
await clickText(['人工模式', 'Manual mode']);
await wait(800);
await clickButtonByText(['创建短剧项目', 'Create short drama project', 'Create project']);
await page.waitForFunction(() => location.href.includes('/dramart/project/project_'), { timeout: 60000 });
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
await renameProject(UI_PROJECT_NAME);
await clickConfirmNext();
await page.waitForFunction(() => document.body.innerText.includes('分镜1') || document.body.innerText.includes('Shot'), { timeout: 60000 });
await wait(2000);

const createCapture = captures.find((item) => item.url.endsWith('/project/create') && item.responseStatus === 200);
const updateCaptures = captures.filter((item) => item.url.endsWith('/project/update') && item.responseStatus === 200);

if (!createCapture || updateCaptures.length < 2) {
  throw new Error(`捕获不足: create=${Boolean(createCapture)}, updateCount=${updateCaptures.length}`);
}

const renameCapture = updateCaptures[0];
const confirmCapture = updateCaptures[1];
const createIds = extractIds(createCapture.responseBody);
console.log('页面创建结果 ID:', createIds);

console.log('第二步：直接调用 API 创建测试项目:', API_PROJECT_NAME);

const apiResult = await page.evaluate(
  async ({ createBody, renameBody, confirmBody, apiProjectName }) => {
    const authToken = localStorage.getItem('DRAMART_AUTH_TOKEN');
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${authToken}`,
    };

    const post = async (path, body) => {
      const response = await fetch(path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: response.status, data };
    };

    const createResult = await post('/proxy/api/v1/project/create', createBody);
    const createText = JSON.stringify(createResult.data);
    const projectId = createResult.data?.data?.project_id || createResult.data?.data?.project?.project_id || createText.match(/project_[a-f0-9]+/)?.[0];
    const scriptId = createResult.data?.data?.script_id || createResult.data?.data?.script?.script_id || createText.match(/script_[a-f0-9]+/)?.[0];
    const accountId = createResult.data?.data?.account_id || createResult.data?.data?.user_id || createText.match(/[a-f0-9]{24}/)?.[0];

    if (!projectId || !scriptId) {
      return { createResult, error: '创建返回中没有 projectId/scriptId' };
    }

    const replaceIds = (value) => {
      if (Array.isArray(value)) return value.map(replaceIds);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceIds(item)]));
      }
      if (typeof value !== 'string') return value;
      return value
        .replace(/project_[a-f0-9]+/g, projectId)
        .replace(/script_[a-f0-9]+/g, scriptId)
        .replace(/New Project/g, apiProjectName);
    };

    const renamePayload = replaceIds(renameBody);
    const confirmPayload = replaceIds(confirmBody);

    const setName = (value) => {
      if (Array.isArray(value)) return value.map(setName);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, ['name', 'project_name', 'title'].includes(key) ? apiProjectName : setName(item)]),
        );
      }
      return value;
    };

    const renameResult = await post('/proxy/api/v1/project/update', setName(renamePayload));
    const confirmResult = await post('/proxy/api/v1/project/update', confirmPayload);

    return {
      projectId,
      scriptId,
      accountId,
      createResult,
      renameResult,
      confirmResult,
      url: `/dramart/project/${projectId}/${scriptId}/${accountId || ''}`,
    };
  },
  {
    createBody: createCapture.requestBody,
    renameBody: renameCapture.requestBody,
    confirmBody: confirmCapture.requestBody,
    apiProjectName: API_PROJECT_NAME,
  },
);

console.log('API 测试结果:', JSON.stringify(apiResult, null, 2));

if (apiResult.error) {
  throw new Error(apiResult.error);
}

if (apiResult.url) {
  await page.goto(`https://work.xiaomaomi.cn${apiResult.url}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
}

const finalState = await page.evaluate(() => ({
  url: location.href,
  bodyText: document.body.innerText.slice(0, 1000),
}));

const output = {
  uiProjectName: UI_PROJECT_NAME,
  apiProjectName: API_PROJECT_NAME,
  captured: captures.map((item) => ({
    url: item.url,
    method: item.method,
    requestHeaders: item.requestHeaders,
    requestBody: item.requestBody,
    responseStatus: item.responseStatus,
    responseBody: item.responseBody,
  })),
  apiResult,
  finalState,
};

await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2));
console.log(`已保存捕获结果: ${OUTPUT_FILE.pathname}`);
console.log('最终页面:', JSON.stringify(finalState, null, 2));

await browser.disconnect();
