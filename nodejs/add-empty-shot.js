import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL || 'http://127.0.0.1:42208' });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1);

await page.bringToFront();
await page.setViewport({ width: 1920, height: 1080 });

const rect = await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('button, div, span'))
    .filter((item) => {
      const text = (item.innerText || item.textContent || '').trim();
      const bounds = item.getBoundingClientRect();
      return text === '+' && bounds.width > 0 && bounds.height > 0 && bounds.left > 500 && bounds.top > 250;
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.width * ar.height - br.width * br.height;
    });
  const target = buttons[0];
  if (!target) return null;
  target.scrollIntoView({ block: 'center', inline: 'center' });
  return target.getBoundingClientRect().toJSON();
});

if (!rect) throw new Error('没有找到新增分镜 + 按钮');
await page.mouse.click(rect.left + rect.width / 2, rect.top + rect.height / 2);
await new Promise((resolve) => setTimeout(resolve, 2000));

console.log(await page.evaluate(() => document.body.innerText.slice(0, 800)));
await browser.disconnect();
