import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart')) || pages.at(-1);

await page.bringToFront();
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }).catch(() => {});

const info = await page.evaluate(() => {
  function path(element) {
    if (element.id) return `#${element.id}`;
    const attrs = [element.tagName.toLowerCase()];
    if (element.className && typeof element.className === 'string') {
      attrs.push(`.${element.className.trim().split(/\s+/).slice(0, 4).join('.')}`);
    }
    return attrs.join('');
  }

  return {
    url: location.href,
    title: document.title,
    buttons: Array.from(document.querySelectorAll('button')).map((item) => ({
      selector: path(item),
      text: item.innerText.trim(),
      aria: item.getAttribute('aria-label'),
      title: item.getAttribute('title'),
      rect: item.getBoundingClientRect().toJSON(),
    })),
    clickable: Array.from(document.querySelectorAll('a, [role="button"], .arco-card, .arco-btn, div, span'))
      .map((item) => ({
        selector: path(item),
        text: item.innerText?.trim()?.slice(0, 120) || '',
        role: item.getAttribute('role'),
        aria: item.getAttribute('aria-label'),
        title: item.getAttribute('title'),
        cursor: getComputedStyle(item).cursor,
        rect: item.getBoundingClientRect().toJSON(),
      }))
      .filter((item) => item.text || item.role || item.aria || item.title || item.cursor === 'pointer')
      .slice(0, 200),
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.disconnect();
