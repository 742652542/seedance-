import puppeteer from 'puppeteer-core';

const PROFILE_ID = 81372;
const OPEN_API = 'http://127.0.0.1:27997/api/v2/profile-open';
const TARGET_URL = 'https://work.xiaomaomi.cn/dramart/login';
const USERNAME = process.env.DRAMART_USERNAME || '';
const PASSWORD = process.env.DRAMART_PASSWORD || '';

function findDebugPort(data) {
  return (
    data?.data?.debug_port ||
    data?.data?.debugPort ||
    data?.data?.debugging_port ||
    data?.data?.port ||
    data?.data?.debugging_address?.split(':').at(-1) ||
    data?.debug_port ||
    data?.debugPort ||
    data?.debugging_port ||
    data?.port
  );
}

async function openChrome() {
  const response = await fetch(OPEN_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profile_id: PROFILE_ID,
      args: ['--disable-extension-welcome-page', '--start-maximized'],
      load_extensions: false,
      load_default_page: false,
      is_cookies_cache: false,
    }),
    signal: AbortSignal.timeout(20000),
  });

  const result = await response.json();
  console.log('启动结果:', result);

  if (!response.ok) {
    throw new Error(`启动浏览器失败: HTTP ${response.status}`);
  }

  const debugPort = findDebugPort(result);
  if (!debugPort) {
    throw new Error('启动结果中没有找到调试端口 debug_port/debugPort/port');
  }

  const browserURL = `http://127.0.0.1:${debugPort}`;
  console.log('开始连接:', browserURL);

  const browser = await puppeteer.connect({ browserURL, defaultViewport: { width: 1920, height: 920 } });
  console.log('已经连接');

  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  await page.setViewport({ width: 1920, height: 920 });
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('已打开地址:', TARGET_URL);

  if (!USERNAME || !PASSWORD) {
    console.log('未设置 DRAMART_USERNAME / DRAMART_PASSWORD，已打开登录页但未执行输入登录。');
    return browser;
  }

  await login(page);

  return browser;
}

async function login(page) {
  const usernameSelectors = [
    '#AccountInfo_input',
    'input[name="username"]',
    'input[name="account"]',
    'input[name="phone"]',
    'input[type="text"]',
  ];
  const passwordSelectors = ['#Password_input', 'input[name="password"]', 'input[type="password"]'];
  const submitSelectors = [
    'button[type="submit"]',
    '.submitButton-BYq5M6',
    '.ant-btn-primary',
    'button',
  ];

  const usernameSelector = await firstExistingSelector(page, usernameSelectors, 30000);
  const passwordSelector = await firstExistingSelector(page, passwordSelectors, 30000);

  if (!usernameSelector || !passwordSelector) {
    throw new Error('没有找到登录账号或密码输入框');
  }

  await page.click(usernameSelector, { clickCount: 3 });
  await page.type(usernameSelector, USERNAME, { delay: 30 });
  await page.click(passwordSelector, { clickCount: 3 });
  await page.type(passwordSelector, PASSWORD, { delay: 30 });

  const submitSelector = await firstExistingSelector(page, submitSelectors, 30000);
  if (!submitSelector) {
    throw new Error('没有找到登录按钮');
  }

  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.click(submitSelector),
  ]);

  console.log('已执行登录，当前地址:', page.url());
}

async function firstExistingSelector(page, selectors, timeout = 0) {
  const deadline = Date.now() + timeout;

  for (const selector of selectors) {
    if (await page.$(selector)) return selector;
  }

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      if (await page.$(selector)) return selector;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return null;
}

openChrome()
  .then(() => {
    console.log('浏览器保持连接中，按 Ctrl+C 结束脚本。');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
