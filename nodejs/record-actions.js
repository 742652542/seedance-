import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';
const RECORD_FILE = new URL('./recorded-actions.json', import.meta.url);
const RECORD_SECONDS = Number(process.env.RECORD_SECONDS || 0);

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.at(-1) || (await browser.newPage());
const startedAt = Date.now();
const actions = [];

function pushAction(action) {
  actions.push({ ...action, time: Date.now() - startedAt });
  console.log('记录:', action.type, action.selector || action.url || '');
}

await page.exposeFunction('__recordAction', pushAction);

function recorderSource() {
  if (window.__actionRecorderInstalled) return;
  window.__actionRecorderInstalled = true;

  function cssPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';
    if (element.id) return `#${CSS.escape(element.id)}`;

    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      let part = current.nodeName.toLowerCase();
      if (current.className && typeof current.className === 'string') {
        const className = current.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        if (className) part += `.${className}`;
      }

      const siblings = Array.from(current.parentElement?.children || []).filter(
        (item) => item.nodeName === current.nodeName,
      );
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(' > ');
  }

  function record(type, data) {
    window.__recordAction?.({ type, url: location.href, ...data });
  }

  window.addEventListener('click', (event) => {
    record('click', {
      selector: cssPath(event.target),
      text: event.target?.innerText?.trim()?.slice(0, 80) || '',
      x: event.clientX,
      y: event.clientY,
    });
  }, true);

  window.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || !('value' in target)) return;
    record('change', {
      selector: cssPath(target),
      value: target.type === 'password' ? '__PASSWORD__' : target.value,
    });
  }, true);

  window.addEventListener('input', (event) => {
    const target = event.target;
    if (!target || !('value' in target)) return;
    record('input', {
      selector: cssPath(target),
      value: target.type === 'password' ? '__PASSWORD__' : target.value,
    });
  }, true);

  let scrollTimer;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      record('scroll', { x: window.scrollX, y: window.scrollY });
    }, 300);
  }, true);
}

await page.evaluateOnNewDocument(recorderSource);
await page.evaluate(recorderSource).catch(() => {});

page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) pushAction({ type: 'navigate', url: frame.url() });
});

await page.bringToFront();

const save = async () => {
  await fs.writeFile(RECORD_FILE, JSON.stringify(actions, null, 2));
};
const saveTimer = setInterval(() => save().catch(console.error), 3000);

if (RECORD_SECONDS > 0) {
  console.log(`开始录制 ${RECORD_SECONDS} 秒。请在浏览器里演示创建项目流程。`);
  await new Promise((resolve) => setTimeout(resolve, RECORD_SECONDS * 1000));
} else {
  console.log('开始录制。请在浏览器里操作，完成后回到终端按 Enter 停止。');
  const rl = readline.createInterface({ input, output });
  await rl.question('');
  rl.close();
}

clearInterval(saveTimer);
await save();
console.log(`已保存 ${actions.length} 条操作到 ${RECORD_FILE.pathname}`);
await browser.disconnect();
