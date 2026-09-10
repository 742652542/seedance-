import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL || 'http://127.0.0.1:42208' });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1);

await page.bringToFront();

const result = await page.evaluate(async () => {
  const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
  const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
  const match = location.href.match(/\/dramart\/project\/(project_[^/]+)\/(script_[^/]+)\/([^?/#]+)/);
  const episodeId = new URL(location.href).searchParams.get('episodeId');
  if (!match || !episodeId) throw new Error('缺少项目或 episodeId');
  const [, ProjectId, ScriptId, TeamId] = match;
  const headers = {
    'content-type': 'application/json',
    Authorization: token,
    'X-Vsd-Auth-Token': token,
    'X-Vsd-Refresh-Token': refreshToken || '',
  };
  const post = async (path, body) => {
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await response.json();
    return { status: response.status, data };
  };
  const shotList = await post('/proxy/api/v1/shot/list', {
    TeamId,
    ProjectId,
    Filters: { EpisodeId: episodeId },
    PageSize: 1000,
  });
  const shots = shotList.data.Result?.Items || [];
  const lastShot = shots.sort((a, b) => new Date(a.CreatedAt) - new Date(b.CreatedAt)).at(-1);
  if (!lastShot) throw new Error('当前集没有可作为锚点的分镜');

  const addResult = await post('/proxy/api/v1/shot/add', {
    TeamId,
    ProjectId,
    ShotId: lastShot.ShotId,
  });
  return { ProjectId, ScriptId, TeamId, episodeId, beforeCount: shots.length, lastShotId: lastShot.ShotId, addResult };
});

console.log(JSON.stringify(result, null, 2));
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((resolve) => setTimeout(resolve, 2000));
console.log(await page.evaluate(() => document.body.innerText.slice(0, 1000)));
await browser.disconnect();
