import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:42208' });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/login')) || pages[0];

await page.bringToFront();
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 30000 }).catch(() => {});

const frames = page.frames();
for (const frame of frames) {
  const fields = await frame.evaluate(() => ({
    url: location.href,
    title: document.title,
    inputs: Array.from(document.querySelectorAll('input, textarea')).map((input) => ({
      tag: input.tagName.toLowerCase(),
      type: input.getAttribute('type'),
      name: input.getAttribute('name'),
      id: input.id,
      className: input.className,
      placeholder: input.getAttribute('placeholder'),
      autocomplete: input.getAttribute('autocomplete'),
    })),
    buttons: Array.from(document.querySelectorAll('button')).map((button) => ({
      type: button.getAttribute('type'),
      className: button.className,
      text: button.innerText.trim(),
    })),
    text: document.body?.innerText?.slice(0, 1000),
  }));

  console.log(JSON.stringify(fields, null, 2));
}

await browser.disconnect();
