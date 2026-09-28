import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const browserURL = process.env.BROWSER_URL;
const canvasUrl = process.env.PROBE_CANVAS_URL;
const imageUrl = process.env.PROBE_IMAGE_URL;
if (!browserURL || !canvasUrl || !imageUrl) throw new Error('BROWSER_URL, PROBE_CANVAS_URL, and PROBE_IMAGE_URL are required');

const isAsset = (url) => /\/proxy\/api\/v1\/asset\/ark_asset\/create(?:\?|$)/i.test(url);
const isShotUpdate = (url) => /\/proxy\/api\/v1\/shot\/update(?:\?|$)/i.test(url);
const isGeneration = (url) => /\/proxy\/api\/v1\/tasks\/video_gen\/create(?:\?|$)/i.test(url);
const tempPath = path.join(os.tmpdir(), `seedance-reference-probe-${Date.now()}.jpeg`);

const browser = await puppeteer.connect({ browserURL });
const page = await browser.newPage();
try {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (isGeneration(request.url())) {
      void request.abort('blockedbyclient');
      return;
    }
    void request.continue();
  });
  const downloaded = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
  if (!downloaded.ok) throw new Error(`reference image download failed: HTTP ${downloaded.status}`);
  await fs.writeFile(tempPath, Buffer.from(await downloaded.arrayBuffer()));

  await page.goto(canvasUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.aml-draggable-sort-list__list-item', { timeout: 30000 });
  const [root] = await page.$$('.aml-draggable-sort-list__list-item');
  if (!root) throw new Error('storyboard module not found');
  await root.evaluate((element) => {
    element.scrollIntoView({ block: 'end', inline: 'center' });
    for (const child of element.querySelectorAll('div')) child.scrollTop = child.scrollHeight;
  });
  await new Promise((resolve) => setTimeout(resolve, 800));

  const switched = await root.evaluate(() => {
    const wanted = new Set(['Multimodal reference', '全能参考生视频']);
    const item = Array.from(document.querySelectorAll('button, label, span, div')).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && wanted.has((element.innerText || element.textContent || '').trim());
    });
    if (!item) return false;
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    item.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    item.click();
    return true;
  });
  if (!switched) throw new Error('multimodal reference selector not found');
  await new Promise((resolve) => setTimeout(resolve, 900));

  const assetResponse = page.waitForResponse((response) => response.request().method() === 'POST' && isAsset(response.url()), { timeout: 180000 });
  const updateResponse = page.waitForResponse((response) => response.request().method() === 'POST' && isShotUpdate(response.url()), { timeout: 180000 });
  const freshRoot = (await page.$$('.aml-draggable-sort-list__list-item'))[0];
  const input = await freshRoot.$('input[type="file"]');
  if (!input) throw new Error('reference image file input not found');
  await input.uploadFile(tempPath);
  const [asset, update] = await Promise.all([assetResponse, updateResponse]);
  const assetJson = await asset.json().catch(() => null);
  const updateBody = JSON.parse(update.request().postData() || '{}');
  const meta = updateBody?.Shot?.VideoMeta || {};
  console.log(JSON.stringify({
    assetStatus: asset.status(),
    assetResult: assetJson?.Result || assetJson?.result || assetJson?.ResponseMetadata || null,
    shotUpdateStatus: update.status(),
    refImages: meta.RefImages || [],
    keyFrameImages: meta.KeyFrameImages || {},
    generationBlocked: true,
  }));
} finally {
  await fs.rm(tempPath, { force: true }).catch(() => {});
  await page.close().catch(() => {});
  await browser.disconnect();
}
