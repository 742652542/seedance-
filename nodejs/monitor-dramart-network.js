import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';
const DURATION_MS = Number(process.env.MONITOR_MS || 180000);

function tryJson(text) {
  if (!text) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function shouldCapture(url) {
  return url.includes('/proxy/api/v1/') || url.includes('/contents/generations/tasks');
}

function compactBody(body) {
  if (!body) return null;
  const parsed = tryJson(body);
  if (typeof parsed === 'string') return parsed.slice(0, 4000);
  return parsed;
}

function attach(page, label) {
  page.on('request', (request) => {
    const url = request.url();
    if (!shouldCapture(url)) return;
    console.log(JSON.stringify({
      type: 'request',
      page: label,
      at: new Date().toISOString(),
      method: request.method(),
      url,
      body: compactBody(request.postData()),
    }, null, 2));
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (!shouldCapture(url)) return;
    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    let body = null;
    if (contentType.includes('application/json') || contentType.includes('text/')) {
      body = compactBody(await response.text().catch(() => ''));
    }
    console.log(JSON.stringify({
      type: 'response',
      page: label,
      at: new Date().toISOString(),
      status: response.status(),
      url,
      body,
    }, null, 2));
  });
}

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
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

console.log(JSON.stringify({
  type: 'monitor_started',
  browserURL: BROWSER_URL,
  durationMs: DURATION_MS,
  capture: ['/proxy/api/v1/', '/contents/generations/tasks'],
}, null, 2));

await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
console.log(JSON.stringify({ type: 'monitor_finished', at: new Date().toISOString() }, null, 2));
await browser.disconnect();
