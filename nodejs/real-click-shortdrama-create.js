import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project')) || pages.at(-1);

page.on('console', (message) => console.log('页面日志:', message.type(), message.text()));
page.on('response', async (response) => {
  const url = response.url();
  if (url.includes('/dramart') || url.includes('/api')) {
    console.log('响应:', response.status(), url.slice(0, 180));
  }
});

await page.bringToFront();
await page.waitForSelector('button.arco-btn-primary', { timeout: 15000 });

const buttonInfo = await page.evaluate(() => {
  const button = Array.from(document.querySelectorAll('button')).find(
    (item) => item.innerText?.trim() === '创建短剧项目',
  );
  if (!button) return null;

  const rect = button.getBoundingClientRect();
  return {
    disabled: button.disabled,
    className: button.className,
    text: button.innerText.trim(),
    rect: rect.toJSON(),
  };
});

if (!buttonInfo) throw new Error('没有找到创建短剧项目按钮');
console.log('按钮信息:', buttonInfo);

const x = buttonInfo.rect.left + buttonInfo.rect.width / 2;
const y = buttonInfo.rect.top + buttonInfo.rect.height / 2;
await page.mouse.move(x, y);
await page.mouse.down();
await new Promise((resolve) => setTimeout(resolve, 120));
await page.mouse.up();

await new Promise((resolve) => setTimeout(resolve, 3000));

const after = await page.evaluate(() => ({
  url: location.href,
  bodyText: document.body.innerText.slice(0, 1500),
  dialogs: Array.from(document.querySelectorAll('.arco-message, .arco-notification, .arco-modal, [role="dialog"]')).map(
    (item) => item.innerText.trim(),
  ),
}));

console.log('点击后状态:', JSON.stringify(after, null, 2));
await browser.disconnect();
