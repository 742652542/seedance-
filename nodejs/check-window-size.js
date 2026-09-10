import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL || 'http://127.0.0.1:42208' });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart')) || pages.at(-1);
const session = await page.createCDPSession();
const windowInfo = await session.send('Browser.getWindowForTarget');
const pageSize = await page.evaluate(() => ({
  innerWidth,
  innerHeight,
  outerWidth,
  outerHeight,
  screenWidth: screen.width,
  screenHeight: screen.height,
  devicePixelRatio,
}));

console.log(JSON.stringify({ windowInfo, pageSize }, null, 2));
await browser.disconnect();
