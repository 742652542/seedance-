import puppeteer from 'puppeteer-core';

const browserURL = process.env.BROWSER_URL;
const canvasUrl = process.env.PROBE_CANVAS_URL;
if (!browserURL || !canvasUrl) throw new Error('BROWSER_URL and PROBE_CANVAS_URL are required');
const isGeneration = (url) => /\/proxy\/api\/v1\/tasks\/video_gen\/create(?:\?|$)/i.test(url);

const browser = await puppeteer.connect({ browserURL });
const page = await browser.newPage();
try {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (isGeneration(request.url())) { void request.abort('blockedbyclient'); return; }
    void request.continue();
  });
  await page.goto(canvasUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.aml-draggable-sort-list__list-item', { timeout: 30000 });
  const [root] = await page.$$('.aml-draggable-sort-list__list-item');
  if (!root) throw new Error('storyboard module not found');
  const promptSet = await root.evaluate((text) => {
    const editor = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).find((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!editor) return false;
    editor.focus();
    if (editor.tagName === 'TEXTAREA') {
      editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return true;
  }, '将视频中的链子进行替换。');
  if (!promptSet) throw new Error('prompt editor not found');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const createRequest = page.waitForRequest((request) => request.method() === 'POST' && isGeneration(request.url()), { timeout: 30000 });
  const clicked = await root.evaluate(() => {
    const options = Array.from(document.querySelectorAll('button')).map((button) => ({
      button, text: (button.innerText || button.textContent || '').trim(), rect: button.getBoundingClientRect(),
    })).filter(({ button, rect, text }) => !button.disabled && rect.width > 0 && rect.height > 0 &&
      (String(button.className).includes('arco-btn-primary') || text.includes('生成') || /^\d+(,\d+)?$/.test(text)))
      .sort((a, b) => b.rect.top - a.rect.top || b.rect.left - a.rect.left);
    const target = options[0]?.button;
    if (!target) return null;
    target.click();
    return (target.innerText || target.textContent || '').trim();
  });
  if (!clicked) throw new Error('generation button not found');
  const request = await createRequest;
  const body = JSON.parse(request.postData() || '{}');
  console.log(JSON.stringify({
    button: clicked,
    requestAborted: true,
    videoMeta: body.VideoMeta || body.Shot?.VideoMeta || null,
  }));
} finally {
  await page.close().catch(() => {});
  await browser.disconnect();
}
