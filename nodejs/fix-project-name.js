import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';
const PROJECT_NAME = process.env.PROJECT_NAME || new Date().toLocaleDateString('en-CA');

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1);

page.on('response', (response) => {
  const url = response.url();
  if (url.includes('/project/update')) console.log('更新响应:', response.status(), url);
});

await page.bringToFront();

let input = await page.$('input.arco-input');
if (!input) {
  await page.mouse.click(143, 22);
  await page.waitForSelector('input.arco-input', { timeout: 10000 });
  input = await page.$('input.arco-input');
}

await input.click({ clickCount: 3 });
await page.keyboard.press('Backspace');
await page.type('input.arco-input', PROJECT_NAME, { delay: 20 });
await page.keyboard.press('Enter');
await new Promise((resolve) => setTimeout(resolve, 2000));

const state = await page.evaluate(() => ({
  url: location.href,
  bodyText: document.body.innerText.slice(0, 800),
  titleInput: document.querySelector('input.arco-input')?.value || null,
}));

console.log('改名后状态:', JSON.stringify(state, null, 2));
await browser.disconnect();
