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
    let data;
    try { data = await response.json(); } catch { data = await response.text(); }
    return { path, status: response.status, data };
  };

  const base = { TeamId, ProjectId, EpisodeId: episodeId };
  const candidates = [
    ['/proxy/api/v1/shot/create', base],
    ['/proxy/api/v1/shot/create', { ...base, ScriptId }],
    ['/proxy/api/v1/shot/create', { ...base, Meta: { Action: '', Duration: 5 } }],
    ['/proxy/api/v1/shot/create', { ...base, VideoMeta: { Prompt: '', Duration: 5, Ratio: '9:16', Resolution: '720p', OutputFormat: 'mp4' } }],
    ['/proxy/api/v1/shot/add', base],
  ];

  const results = [];
  for (const [path, body] of candidates) {
    const item = await post(path, body);
    results.push({ ...item, body });
    if (item.status === 200 && !item.data?.ResponseMetadata?.Error) break;
  }
  return { ProjectId, ScriptId, TeamId, episodeId, results };
});

console.log(JSON.stringify(result, null, 2));
await browser.disconnect();
