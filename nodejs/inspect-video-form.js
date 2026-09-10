import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL || 'http://127.0.0.1:42208' });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1);

await page.bringToFront();
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});

const info = await page.evaluate(() => {
  const rect = (element) => element.getBoundingClientRect().toJSON();
  return {
    url: location.href,
    radios: Array.from(document.querySelectorAll('input[type="radio"], .arco-radio, .arco-radio-button, label')).map((item) => ({
      tag: item.tagName,
      text: item.innerText?.trim() || item.textContent?.trim() || '',
      checked: item.checked || item.className?.includes?.('checked'),
      className: item.className,
      rect: rect(item),
    })),
    buttons: Array.from(document.querySelectorAll('button')).map((item) => ({
      text: item.innerText.trim(),
      disabled: item.disabled,
      className: item.className,
      rect: rect(item),
    })),
    selects: Array.from(document.querySelectorAll('.arco-select, [role="combobox"]')).map((item) => ({
      text: item.innerText.trim(),
      className: item.className,
      rect: rect(item),
    })),
    textareas: Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).map((item) => ({
      tag: item.tagName,
      value: item.value || item.innerText || '',
      placeholder: item.getAttribute('placeholder'),
      className: item.className,
      rect: rect(item),
    })),
    files: Array.from(document.querySelectorAll('input[type="file"]')).map((item) => ({
      accept: item.accept,
      multiple: item.multiple,
      className: item.className,
      rect: rect(item),
    })),
    bodyText: document.body.innerText.slice(0, 2000),
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.disconnect();
