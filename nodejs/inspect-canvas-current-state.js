import puppeteer from 'puppeteer-core';

const OPEN_API = process.env.BROWSER_OPEN_API || 'http://127.0.0.1:27997/api/v2/profile-open';
const PROFILE_ID = Number(process.env.PROFILE_ID || 81372);

function browserURLFromOpenResult(data) {
  const address = data?.data?.debugging_address;
  if (address) return `http://${address}`;
  const port = data?.data?.debugging_port || data?.data?.debug_port || data?.data?.port;
  return port ? `http://127.0.0.1:${port}` : '';
}

async function resolveBrowserURL() {
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
  const browserURL = browserURLFromOpenResult(data);
  if (!browserURL) throw new Error(`没有找到浏览器连接地址: ${JSON.stringify(data)}`);
  return browserURL;
}

const browserURL = await resolveBrowserURL();
const browser = await puppeteer.connect({ browserURL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/canvas')) || pages.find((item) => item.url().includes('/dramart')) || pages[0];
if (!page) throw new Error('没有找到可用页面');
await page.bringToFront();

const state = await page.evaluate(async () => {
  const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
  const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
  const match = location.href.match(/\/dramart\/project\/(project_[^/]+)\/(script_[^/]+)\/([^/?#]+)/);
  if (!match) return { url: location.href, error: '当前不是项目页面' };
  const [, ProjectId, ScriptId, TeamId] = match;
  const headers = {
    'content-type': 'application/json',
    Authorization: token,
    'X-Vsd-Auth-Token': token,
    'X-Vsd-Refresh-Token': refreshToken || '',
  };
  const post = async (path, body) => {
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data };
  };
  const canvas = await post('/proxy/api/v1/canvas/get', { TeamId, ProjectId });
  const nodes = (canvas.data?.Result?.Nodes || []).map((node) => {
    let parsed = null;
    try { parsed = JSON.parse(node.Data || '{}'); } catch {}
    return { ...node, ParsedData: parsed, Data: undefined };
  });
  const imageIds = nodes.map((node) => node.ParsedData?.imageResourceId).filter(Boolean);
  const imageList = imageIds.length
    ? await post('/proxy/api/v1/image/list', { TeamId, PageIndex: 1, PageSize: 100, Filters: { ImageIds: imageIds, ProjectId } })
    : null;
  const taskImageList = imageIds.length
    ? await post('/proxy/api/v1/tasks/image/list', { TeamId, ProjectId, ScriptId, Filters: { ResourceType: 'image', ResourceIds: imageIds } })
    : await post('/proxy/api/v1/tasks/image/list', { TeamId, ProjectId, ScriptId, Filters: {} });
  return {
    url: location.href,
    ProjectId,
    ScriptId,
    TeamId,
    bodyText: document.body.innerText.slice(0, 2000),
    nodes,
    edges: canvas.data?.Result?.Edges || [],
    imageIds,
    imageList,
    taskImageList,
  };
});

console.log(JSON.stringify(state, null, 2));
await browser.disconnect();
