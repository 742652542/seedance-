import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL || 'http://127.0.0.1:42208' });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1);

await page.bringToFront();

const opened = await page.evaluate(() => {
  const select = Array.from(document.querySelectorAll('.arco-select, [role="combobox"], div, span')).find((item) =>
    (item.innerText || item.textContent || '').includes('Doubao-Seedance'),
  );
  if (!select) return false;
  select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  select.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  select.click();
  return true;
});

await new Promise((resolve) => setTimeout(resolve, 1000));

const options = await page.evaluate(() => Array.from(document.querySelectorAll('.arco-select-option, [role="option"], li, div, span'))
  .map((item) => ({
    text: (item.innerText || item.textContent || '').trim(),
    className: item.className,
    rect: item.getBoundingClientRect().toJSON(),
  }))
  .filter((item) => item.text.includes('Seedance') || item.text.includes('Doubao')));

console.log(JSON.stringify({ opened, options }, null, 2));
await browser.disconnect();
