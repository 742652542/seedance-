import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart')) || pages.at(-1);

await page.bringToFront();

const cookies = await page.cookies();
const info = await page.evaluate(() => {
  const resources = performance
    .getEntriesByType('resource')
    .map((item) => ({ name: item.name, initiatorType: item.initiatorType }))
    .filter((item) => item.name.includes('/proxy/api/') || item.name.includes('/api/'));

  const localStorageItems = Object.fromEntries(
    Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)?.slice(0, 300)]),
  );
  const sessionStorageItems = Object.fromEntries(
    Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)?.slice(0, 300)]),
  );

  return {
    url: location.href,
    resources,
    localStorageItems,
    sessionStorageItems,
  };
});

console.log(JSON.stringify({
  ...info,
  cookies: cookies.map((cookie) => ({
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    valuePreview: cookie.value.slice(0, 80),
  })),
}, null, 2));

await browser.disconnect();
