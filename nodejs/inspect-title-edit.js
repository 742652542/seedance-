import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL || 'http://127.0.0.1:42208' });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1);

await page.bringToFront();
await page.mouse.click(143, 22);
await new Promise((resolve) => setTimeout(resolve, 1000));

const info = await page.evaluate(() => ({
  url: location.href,
  active: {
    tag: document.activeElement?.tagName,
    value: document.activeElement?.value,
    text: document.activeElement?.innerText,
    className: document.activeElement?.className,
    rect: document.activeElement?.getBoundingClientRect().toJSON(),
  },
  inputs: Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]')).map((item) => ({
    tag: item.tagName,
    value: item.value,
    text: item.innerText,
    placeholder: item.getAttribute('placeholder'),
    className: item.className,
    rect: item.getBoundingClientRect().toJSON(),
    visible: item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().height > 0,
  })),
  bodyText: document.body.innerText.slice(0, 800),
}));

console.log(JSON.stringify(info, null, 2));
await browser.disconnect();
