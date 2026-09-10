import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';
const PROJECT_NAME = process.env.PROJECT_NAME || new Date().toLocaleDateString('en-CA');

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1);

page.on('response', (response) => {
  const url = response.url();
  if (url.includes('/project') || url.includes('/script')) {
    console.log('响应:', response.status(), url.slice(0, 180));
  }
});

await page.bringToFront();
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});

async function getProjectNameState() {
  return page.evaluate(() => ({
    url: location.href,
    titleArea: document.body.innerText.slice(0, 500),
    inputs: Array.from(document.querySelectorAll('input, textarea')).map((item) => ({
      value: item.value,
      placeholder: item.getAttribute('placeholder'),
      className: item.className,
      rect: item.getBoundingClientRect().toJSON(),
    })),
    buttons: Array.from(document.querySelectorAll('button')).map((item) => ({
      text: item.innerText.trim(),
      className: item.className,
      disabled: item.disabled,
      rect: item.getBoundingClientRect().toJSON(),
    })),
  }));
}

console.log('当前状态:', JSON.stringify(await getProjectNameState(), null, 2));

const editClicked = await page.evaluate(() => {
  const title = Array.from(document.querySelectorAll('span, div')).find((item) => item.innerText?.trim() === 'New Project');
  if (!title) return false;

  const candidates = Array.from(document.querySelectorAll('svg, button, span, div'))
    .filter((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left > title.getBoundingClientRect().right - 5;
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const tr = title.getBoundingClientRect();
      return Math.hypot(ar.left - tr.right, ar.top - tr.top) - Math.hypot(br.left - tr.right, br.top - tr.top);
    });

  const target = candidates[0];
  if (!target) return false;
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  target.click();
  return true;
});

if (!editClicked) throw new Error('没有找到项目名编辑按钮');
console.log('已点击项目名编辑按钮');
await new Promise((resolve) => setTimeout(resolve, 800));

const renamed = await page.evaluate((projectName) => {
  const input = Array.from(document.querySelectorAll('input, textarea')).find((item) => {
    const rect = item.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (!input) return false;

  input.focus();
  input.value = projectName;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, PROJECT_NAME);

if (!renamed) throw new Error('没有找到项目名输入框');
await page.keyboard.press('Enter');
console.log('已修改项目名:', PROJECT_NAME);
await new Promise((resolve) => setTimeout(resolve, 1500));

const confirmInfo = await page.evaluate(() => {
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span')).filter((item) => {
    const text = item.innerText?.trim() || item.textContent?.trim() || '';
    const rect = item.getBoundingClientRect();
    return text.includes('已确认，进入下一步') && rect.width > 0 && rect.height > 0;
  });

  const element = candidates.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return ar.width * ar.height - br.width * br.height;
  })[0];

  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: element.innerText || element.textContent };
});

if (!confirmInfo) throw new Error('没有找到“已确认，进入下一步”按钮');
await page.mouse.move(confirmInfo.x, confirmInfo.y);
await page.mouse.down();
await new Promise((resolve) => setTimeout(resolve, 120));
await page.mouse.up();
console.log('已点击确认按钮:', confirmInfo.text.trim());

await new Promise((resolve) => setTimeout(resolve, 3000));
console.log('完成后状态:', JSON.stringify(await getProjectNameState(), null, 2));

await browser.disconnect();
