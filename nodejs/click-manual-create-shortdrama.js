import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project')) || pages.at(-1);

await page.bringToFront();
await page.setViewport({ width: 1920, height: 1080 });
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});

async function clickVisibleText(text) {
  const clicked = await page.evaluate((targetText) => {
    const elements = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
    const element = elements
      .filter((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .find((item) => item.innerText?.trim() === targetText || item.textContent?.trim() === targetText);

    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.click();
    return true;
  }, text);

  if (!clicked) {
    const info = await page.evaluate(() => ({
      url: location.href,
      texts: Array.from(document.querySelectorAll('button, [role="button"], a, div, span'))
        .map((item) => item.innerText?.trim() || item.textContent?.trim())
        .filter(Boolean)
        .slice(0, 160),
    }));
    console.log(JSON.stringify(info, null, 2));
    throw new Error(`没有找到可点击文本: ${text}`);
  }
}

console.log('当前地址:', page.url());
await clickVisibleText('人工模式');
console.log('已点击人工模式');
await new Promise((resolve) => setTimeout(resolve, 1000));

await clickVisibleText('创建短剧项目');
console.log('已点击创建短剧项目');
await new Promise((resolve) => setTimeout(resolve, 1500));
console.log('点击后地址:', page.url());

await browser.disconnect();
