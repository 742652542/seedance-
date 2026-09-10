import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.at(-1) || (await browser.newPage());
const session = await page.createCDPSession();
const { windowId } = await session.send('Browser.getWindowForTarget');

await session.send('Browser.setWindowBounds', {
  windowId,
  bounds: { windowState: 'maximized' },
});

await page.setViewport({ width: 1920, height: 1080 });
await page.bringToFront();
await browser.disconnect();

console.log('浏览器窗口已最大化');
