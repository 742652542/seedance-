import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';
const PASSWORD = process.env.DRAMART_PASSWORD || '';
const RECORD_FILE = new URL('./recorded-actions.json', import.meta.url);

const actions = JSON.parse(await fs.readFile(RECORD_FILE, 'utf8'));
const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.at(-1) || (await browser.newPage());

let previousTime = 0;
for (const action of actions) {
  const delay = Math.max(0, Math.min(action.time - previousTime, 5000));
  previousTime = action.time;
  await new Promise((resolve) => setTimeout(resolve, delay));

  try {
    if (action.type === 'navigate' && action.url && page.url() !== action.url) {
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('回放跳转:', action.url);
      continue;
    }

    if (action.type === 'click' && action.selector) {
      await page.waitForSelector(action.selector, { timeout: 10000 });
      await page.click(action.selector);
      console.log('回放点击:', action.selector);
      continue;
    }

    if ((action.type === 'input' || action.type === 'change') && action.selector) {
      const value = action.value === '__PASSWORD__' ? PASSWORD : action.value || '';
      await page.waitForSelector(action.selector, { timeout: 10000 });
      await page.click(action.selector, { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type(action.selector, value, { delay: 20 });
      console.log('回放输入:', action.selector);
      continue;
    }

    if (action.type === 'scroll') {
      await page.evaluate(({ x, y }) => window.scrollTo(x, y), action);
      console.log('回放滚动:', action.x, action.y);
    }
  } catch (error) {
    console.warn('跳过失败操作:', action.type, action.selector || action.url, error.message);
  }
}

console.log('回放完成，当前地址:', page.url());
await browser.disconnect();
