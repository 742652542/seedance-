import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const browserURL = process.env.BROWSER_URL;
const logFile = process.env.PROBE_LOG_FILE || 'nodejs/reference-asset-network.ndjson';
const durationMs = Number(process.env.PROBE_DURATION_MS || 8 * 60 * 1000);

if (!browserURL) throw new Error('BROWSER_URL is required');

const interesting = (url) => /\/proxy\/api\/v1\/(?:file\/upload|image\/(?:add|list)|asset\/ark_asset\/create|shot\/update|tasks\/video_gen\/create)(?:\?|$)/i.test(url);

function scrub(value, key = '') {
  if (/authorization|token|cookie|signature|credential|secret/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, name)]));
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      parsed.search = '';
      return parsed.toString();
    } catch {}
  }
  return value;
}

function bodyOf(text) {
  try { return scrub(JSON.parse(text)); } catch { return text.slice(0, 3000); }
}

await fs.writeFile(logFile, '', 'utf8');
const browser = await puppeteer.connect({ browserURL });
const attached = new WeakSet();
async function attach(page) {
  if (!page || attached.has(page)) return;
  attached.add(page);
  page.on('request', (request) => {
    if (!interesting(request.url())) return;
    void fs.appendFile(logFile, `${JSON.stringify(scrub({
      type: 'request', method: request.method(), url: request.url().split('?')[0], body: bodyOf(request.postData() || ''), at: new Date().toISOString(),
    }))}\n`);
  });
  page.on('response', async (response) => {
    if (!interesting(response.url())) return;
    const contentType = response.headers()['content-type'] || '';
    const text = /json|text/i.test(contentType) ? await response.text().catch(() => '') : '';
    await fs.appendFile(logFile, `${JSON.stringify(scrub({
      type: 'response', status: response.status(), url: response.url().split('?')[0], body: bodyOf(text), at: new Date().toISOString(),
    }))}\n`);
  });
}

for (const page of await browser.pages()) await attach(page);
browser.on('targetcreated', async (target) => attach(await target.page().catch(() => null)));
await fs.appendFile(logFile, `${JSON.stringify({ type: 'started', at: new Date().toISOString() })}\n`);
await new Promise((resolve) => setTimeout(resolve, durationMs));
await fs.appendFile(logFile, `${JSON.stringify({ type: 'finished', at: new Date().toISOString() })}\n`);
await browser.disconnect();
