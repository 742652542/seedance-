import puppeteer from 'puppeteer-core';

const OPEN_API = process.env.BROWSER_OPEN_API || 'http://127.0.0.1:27997/api/v2/profile-open';
const PROFILE_ID = Number(process.env.PROFILE_ID || 81372);
const TEAM_ID = process.env.TEAM_ID || '6a90faa57906980889d712fd';
const PROJECT_NAME = process.env.PROJECT_NAME || '';
const PROJECTLIST_URL = 'https://work.xiaomaomi.cn/dramart/projectlist/';

function findBrowserURL(data) {
  const port = data?.data?.debugging_port || data?.data?.debug_port || data?.data?.debugPort || data?.data?.port;
  const address = data?.data?.debugging_address;
  if (address) return `http://${address}`;
  if (port) return `http://127.0.0.1:${port}`;
  return '';
}

async function openBrowser() {
  const response = await fetch(OPEN_API, {
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
  const data = await response.json();
  if (!response.ok || data?.error?.code) throw new Error(`打开浏览器失败: ${JSON.stringify(data)}`);
  const browserURL = findBrowserURL(data);
  if (!browserURL) throw new Error(`没有找到浏览器连接地址: ${JSON.stringify(data)}`);
  return browserURL;
}

function attachNetwork(page) {
  page.on('request', (request) => {
    const url = request.url();
    if (!url.includes('/proxy/api/v1/') && !url.includes('/contents/generations/tasks')) return;
    console.log('REQUEST', JSON.stringify({ method: request.method(), url, body: request.postData() }));
  });
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/proxy/api/v1/') && !url.includes('/contents/generations/tasks')) return;
    const contentType = response.headers()['content-type'] || '';
    const body = contentType.includes('application/json') || contentType.includes('text/')
      ? await response.text().catch(() => '')
      : '';
    console.log('RESPONSE', JSON.stringify({ status: response.status(), url, body: body.slice(0, 3000) }));
  });
}

const browserURL = await openBrowser();
console.log('browserURL', browserURL);
const browser = await puppeteer.connect({ browserURL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart')) || pages[0] || await browser.newPage();
attachNetwork(page);
await page.bringToFront();
await page.goto(PROJECTLIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});

const project = await page.evaluate(async ({ teamId, projectName }) => {
  const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
  const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
  if (!token) throw new Error('未登录，localStorage 缺少 DRAMART_AUTH_TOKEN');
  const response = await fetch('/proxy/api/v1/project/list', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: token,
      'X-Vsd-Auth-Token': token,
      'X-Vsd-Refresh-Token': refreshToken || '',
    },
    body: JSON.stringify({ TeamId: teamId, Filters: { CreationMode: 'agent,manual' }, PageIndex: 1, PageSize: 100 }),
  });
  const data = await response.json();
  const items = data.Result?.Items || [];
  const target = (projectName ? items.find((item) => item.ProjectName === projectName) : null) || items[0];
  if (!target) throw new Error('没有找到项目');
  return {
    projectName: target.ProjectName,
    projectId: target.ProjectId,
    scriptId: target.ScriptId,
    teamId: target.TeamId || teamId,
  };
}, { teamId: TEAM_ID, projectName: PROJECT_NAME });

const canvasUrl = `https://work.xiaomaomi.cn/dramart/project/${project.projectId}/${project.scriptId}/${project.teamId}/canvas`;
console.log('canvasUrl', canvasUrl);
await page.goto(canvasUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});

const info = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  bodyText: document.body.innerText.slice(0, 3000),
  buttons: Array.from(document.querySelectorAll('button')).map((button) => ({
    text: (button.innerText || button.textContent || '').trim(),
    className: String(button.className || ''),
    rect: button.getBoundingClientRect().toJSON(),
  })).filter((item) => item.rect.width > 0 && item.rect.height > 0),
  fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map((input) => ({
    accept: input.accept,
    multiple: input.multiple,
    rect: input.getBoundingClientRect().toJSON(),
  })),
  editors: Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).map((editor) => ({
    tagName: editor.tagName,
    placeholder: editor.getAttribute('placeholder'),
    text: (editor.innerText || editor.value || '').slice(0, 300),
    rect: editor.getBoundingClientRect().toJSON(),
  })),
}));
console.log('CANVAS_INFO', JSON.stringify({ project, info }, null, 2));
await browser.disconnect();
