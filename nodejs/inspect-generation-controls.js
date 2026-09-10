import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL || 'http://127.0.0.1:42208' });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1);

await page.bringToFront();
await page.setViewport({ width: 1920, height: 920 });

const before = await page.evaluate(() => Array.from(document.querySelectorAll('button, span, div'))
  .map((item) => ({
    text: (item.innerText || item.textContent || '').trim(),
    className: item.className,
    rect: item.getBoundingClientRect().toJSON(),
  }))
  .filter((item) => item.rect.width > 0 && item.rect.height > 0 && (item.text === '...' || item.text.includes('4s') || item.text.includes('mp4') || item.text === '×'))
  .slice(0, 200));

const moreRect = before
  .filter((item) => item.text === '...')
  .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.rect;

if (moreRect) {
  await page.mouse.click(moreRect.left + moreRect.width / 2, moreRect.top + moreRect.height / 2);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const after = await page.evaluate(() => Array.from(document.querySelectorAll('button, span, div, li, [role="option"], input'))
  .map((item) => ({
    tag: item.tagName,
    text: (item.innerText || item.textContent || item.value || '').trim(),
    value: item.value || '',
    className: item.className,
    role: item.getAttribute('role'),
    rect: item.getBoundingClientRect().toJSON(),
  }))
  .filter((item) => item.rect.width > 0 && item.rect.height > 0 && /4s|5s|10s|mp4|mov|720p|1080p|Seedance|张图|数量|时长|格式|×|图片/.test(item.text || item.value))
  .slice(0, 300));

console.log(JSON.stringify({ before, after }, null, 2));
await browser.disconnect();
