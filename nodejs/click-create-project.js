import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart')) || pages.at(-1);

await page.bringToFront();
await page.setViewport({ width: 1920, height: 920 });

async function clickByText(text) {
  const clicked = await page.evaluate((targetText) => {
    const elements = Array.from(document.querySelectorAll('button, a, div, span'));
    const element = elements.find((item) => item.innerText?.trim() === targetText);
    if (!element) return false;
    element.click();
    return true;
  }, text);

  if (!clicked) throw new Error(`没有找到文本为 ${text} 的元素`);
}

console.log('当前地址:', page.url());

await clickByText('Projects');
console.log('已点击 Projects');
await new Promise((resolve) => setTimeout(resolve, 1000));

const createClicked = await page.evaluate(() => {
  const candidates = Array.from(document.querySelectorAll('button'));
  const element = candidates.find((item) => item.innerText?.trim() === '创建项目');

  if (!element) return false;
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  element.click();
  return true;
});

if (!createClicked) {
  const pageInfo = await page.evaluate(() => ({
    url: location.href,
    texts: Array.from(document.querySelectorAll('button, a, div, span'))
      .map((item) => item.innerText?.trim())
      .filter(Boolean)
      .slice(0, 120),
  }));
  console.log(JSON.stringify(pageInfo, null, 2));
  throw new Error('没有找到创建项目入口');
}

console.log('已点击创建项目');
await new Promise((resolve) => setTimeout(resolve, 1500));
console.log('点击后地址:', page.url());
await browser.disconnect();
