import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL || 'http://127.0.0.1:42208' });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1);

await page.bringToFront();
await page.setViewport({ width: 1920, height: 1080 });

const modules = await page.evaluate(() => Array.from(document.querySelectorAll('.storyboardModule-xRjpng, .aml-draggable-sort-list__list-item, [class*="storyboardModule"]'))
  .map((item, index) => ({
    index,
    className: String(item.className || ''),
    text: (item.innerText || item.textContent || '').trim().slice(0, 1800),
    rect: item.getBoundingClientRect().toJSON(),
    textareas: Array.from(item.querySelectorAll('textarea, [contenteditable="true"]')).map((field) => ({
      tag: field.tagName,
      value: field.value || field.innerText || '',
      rect: field.getBoundingClientRect().toJSON(),
      className: String(field.className || ''),
    })),
    files: item.querySelectorAll('input[type="file"]').length,
  }))
  .filter((item) => item.text.includes('分镜')));

console.log(JSON.stringify(modules, null, 2));
await browser.disconnect();
