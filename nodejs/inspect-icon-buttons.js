import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL || 'http://127.0.0.1:42208' });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1);

await page.bringToFront();
await page.setViewport({ width: 1920, height: 920 });

const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button'))
  .map((item) => ({
    text: (item.innerText || item.textContent || '').trim(),
    className: String(item.className || ''),
    disabled: item.disabled,
    rect: item.getBoundingClientRect().toJSON(),
    parentText: (item.parentElement?.innerText || item.parentElement?.textContent || '').trim().slice(0, 200),
    html: item.outerHTML.slice(0, 500),
  }))
  .filter((item) => item.rect.width > 0 && item.rect.height > 0)
  .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left));

console.log(JSON.stringify(buttons, null, 2));
await browser.disconnect();
