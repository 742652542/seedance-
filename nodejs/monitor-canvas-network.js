import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const OPEN_API = process.env.BROWSER_OPEN_API || 'http://127.0.0.1:27997/api/v2/profile-open';
const PROFILE_ID = Number(process.env.PROFILE_ID || 81372);
const DURATION_MS = Number(process.env.MONITOR_MS || 10 * 60 * 1000);
const LOG_FILE = process.env.CANVAS_MONITOR_LOG || 'nodejs/canvas-monitor.log';

function log(data) {
  const line = `${JSON.stringify(data)}\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf8');
  console.log(line.trim());
}

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

function shouldCapture(url) {
  return url.includes('/proxy/api/v1/') || url.includes('/contents/generations/tasks');
}

function attach(page, label) {
  page.on('request', (request) => {
    const url = request.url();
    if (!shouldCapture(url)) return;
    log({
      type: 'request',
      page: label,
      at: new Date().toISOString(),
      method: request.method(),
      url,
      body: request.postData(),
    });
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (!shouldCapture(url)) return;
    const contentType = response.headers()['content-type'] || '';
    const body = contentType.includes('application/json') || contentType.includes('text/')
      ? await response.text().catch(() => '')
      : '';
    log({
      type: 'response',
      page: label,
      at: new Date().toISOString(),
      status: response.status(),
      url,
      body,
    });
  });
}

fs.writeFileSync(LOG_FILE, '', 'utf8');
const browserURL = await resolveBrowserURL();
const browser = await puppeteer.connect({ browserURL });
const attached = new WeakSet();

async function attachExistingPages() {
  const pages = await browser.pages();
  for (const page of pages) {
    if (attached.has(page)) continue;
    attached.add(page);
    attach(page, page.url() || 'about:blank');
  }
}

await attachExistingPages();
browser.on('targetcreated', async (target) => {
  const page = await target.page().catch(() => null);
  if (!page || attached.has(page)) return;
  attached.add(page);
  attach(page, page.url() || 'new-page');
});

log({ type: 'monitor_started', browserURL, durationMs: DURATION_MS, logFile: LOG_FILE });
await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
log({ type: 'monitor_finished', at: new Date().toISOString() });
await browser.disconnect();
