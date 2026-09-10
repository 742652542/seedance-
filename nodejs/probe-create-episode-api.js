import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1) || (await browser.newPage());
const captures = [];

page.on('request', (request) => {
  const url = request.url();
  if (!url.includes('/proxy/api/v1/episode/')) return;
  captures.push({ url, method: request.method(), body: request.postData() });
});

await page.bringToFront();

const before = await page.evaluate(() => document.body.innerText.slice(0, 500));
const rect = await page.evaluate(() => {
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
    .filter((item) => {
      const text = item.innerText?.trim() || item.textContent?.trim() || '';
      const bounds = item.getBoundingClientRect();
      return text === '+' && bounds.width > 0 && bounds.height > 0 && bounds.left < 90;
    })
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const target = candidates[0];
  if (!target) return null;
  target.scrollIntoView({ block: 'center', inline: 'center' });
  return target.getBoundingClientRect().toJSON();
});

if (!rect) throw new Error('没有找到左侧新增集数 + 按钮');
await page.mouse.click(rect.left + rect.width / 2, rect.top + rect.height / 2);
await new Promise((resolve) => setTimeout(resolve, 3500));

console.log(JSON.stringify({ before, captures: captures.map((item) => ({
  ...item,
  body: item.body ? JSON.parse(item.body) : null,
})) }, null, 2));

await browser.disconnect();
