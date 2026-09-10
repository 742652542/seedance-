import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1) || (await browser.newPage());

const captures = [];

page.on('request', (request) => {
  const url = request.url();
  if (!url.includes('/proxy/api/v1/episode/') && !url.includes('/proxy/api/v1/shot/')) return;
  captures.push({ url, method: request.method(), body: request.postData() });
});

await page.bringToFront();
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForNetworkIdle({ idleTime: 1500, timeout: 20000 }).catch(() => {});

console.log(JSON.stringify(captures.map((item) => ({
  ...item,
  body: item.body ? JSON.parse(item.body) : null,
})), null, 2));

await browser.disconnect();
