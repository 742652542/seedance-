import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1) || (await browser.newPage());

await page.bringToFront();

const before = await page.evaluate(() => ({
  url: location.href,
  text: document.body.innerText.slice(0, 500),
}));
console.log('创建前:', JSON.stringify(before, null, 2));

const plusRect = await page.evaluate(() => {
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
    .filter((item) => {
      const text = item.innerText?.trim() || item.textContent?.trim() || '';
      const rect = item.getBoundingClientRect();
      return text === '+' && rect.width > 0 && rect.height > 0 && rect.left < 80;
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.top - br.top;
    });

  const target = candidates[0];
  if (!target) return null;
  target.scrollIntoView({ block: 'center', inline: 'center' });
  return target.getBoundingClientRect().toJSON();
});

if (!plusRect) throw new Error('没有找到左侧新增集数 + 按钮');

await page.mouse.move(plusRect.left + plusRect.width / 2, plusRect.top + plusRect.height / 2);
await page.mouse.down();
await new Promise((resolve) => setTimeout(resolve, 120));
await page.mouse.up();
await new Promise((resolve) => setTimeout(resolve, 3000));

const after = await page.evaluate(() => ({
  url: location.href,
  text: document.body.innerText.slice(0, 800),
}));
console.log('创建后:', JSON.stringify(after, null, 2));

await browser.disconnect();
