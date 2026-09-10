import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';
const BASE_URL = 'https://work.xiaomaomi.cn/dramart';
const PROJECT_NAME = process.env.PROJECT_NAME || `${new Date().toLocaleDateString('en-CA')}-01`;

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart')) || pages.at(-1) || (await browser.newPage());

page.on('response', (response) => {
  const url = response.url();
  if (url.includes('/proxy/api/v1/project/')) {
    console.log('项目接口:', response.status(), url);
  }
});

await page.bringToFront();
await page.setViewport({ width: 1920, height: 920 });

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickButtonByText(texts) {
  const targets = Array.isArray(texts) ? texts : [texts];
  await page.waitForFunction(
    (targetTexts) => Array.from(document.querySelectorAll('button')).some((item) => targetTexts.includes(item.innerText?.trim())),
    { timeout: 30000 },
    targets,
  );

  const rect = await page.evaluate((targetTexts) => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => targetTexts.includes(item.innerText?.trim()));
    if (!button) return null;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const bounds = button.getBoundingClientRect();
    return bounds.toJSON();
  }, targets);

  if (!rect) throw new Error(`没有找到按钮: ${targets.join(' / ')}`);

  await page.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2);
  await page.mouse.down();
  await wait(120);
  await page.mouse.up();
}

async function clickText(texts) {
  const targets = Array.isArray(texts) ? texts : [texts];
  await page.waitForFunction(
    (targetTexts) => Array.from(document.querySelectorAll('button, span, div')).some((item) => targetTexts.includes(item.innerText?.trim())),
    { timeout: 30000 },
    targets,
  );

  const rect = await page.evaluate((targetTexts) => {
    const element = Array.from(document.querySelectorAll('button, span, div'))
      .filter((item) => {
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      })
      .find((item) => targetTexts.includes(item.innerText?.trim()));
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    return element.getBoundingClientRect().toJSON();
  }, targets);

  if (!rect) throw new Error(`没有找到文本: ${targets.join(' / ')}`);

  await page.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2);
  await page.mouse.down();
  await wait(120);
  await page.mouse.up();
}

async function renameProject(name) {
  await page.waitForFunction(() => document.body.innerText.includes('New Project'), { timeout: 30000 });
  await page.mouse.click(143, 22);
  await page.waitForSelector('input.arco-input', { timeout: 10000 });
  await page.click('input.arco-input', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('input.arco-input', name, { delay: 20 });
  await page.keyboard.press('Enter');
  await wait(2000);
}

async function clickConfirmNext() {
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('button')).some((item) => item.innerText?.includes('已确认，进入下一步')),
    { timeout: 30000 },
  );

  const rect = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.innerText?.includes('已确认，进入下一步'));
    if (!button) return null;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    return button.getBoundingClientRect().toJSON();
  });

  if (!rect) throw new Error('没有找到“已确认，进入下一步”按钮');
  await page.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2);
  await page.mouse.down();
  await wait(120);
  await page.mouse.up();
}

console.log('准备创建项目:', PROJECT_NAME);

await page.goto(`${BASE_URL}/projectlist/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
console.log('已进入项目列表');

await clickButtonByText(['创建项目', 'Create project']);
await page.waitForFunction(() => location.href.includes('/dramart/project'), { timeout: 30000 });
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
console.log('已进入创建页面');

await clickText(['人工模式', 'Manual mode']);
await wait(800);
console.log('已选择人工模式');

await clickButtonByText(['创建短剧项目', 'Create short drama project', 'Create project']);
await page.waitForFunction(() => location.href.includes('/dramart/project/project_'), { timeout: 60000 });
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
console.log('短剧项目创建成功:', page.url());

await renameProject(PROJECT_NAME);
console.log('已修改项目名:', PROJECT_NAME);

await clickConfirmNext();
await page.waitForFunction(() => document.body.innerText.includes('分镜1') || document.body.innerText.includes('Shot'), { timeout: 60000 });
await wait(2000);

const state = await page.evaluate(() => ({
  url: location.href,
  bodyText: document.body.innerText.slice(0, 1000),
}));

console.log('最终状态:', JSON.stringify(state, null, 2));
await browser.disconnect();
