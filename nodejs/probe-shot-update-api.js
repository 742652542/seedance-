import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: process.env.BROWSER_URL || 'http://127.0.0.1:42208' });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1);

const result = await page.evaluate(async () => {
  const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
  const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
  const match = location.href.match(/\/dramart\/project\/(project_[^/]+)\/(script_[^/]+)\/([^?/#]+)/);
  const episodeId = new URL(location.href).searchParams.get('episodeId');
  const [, ProjectId, ScriptId, TeamId] = match;
  const headers = { 'content-type': 'application/json', Authorization: token, 'X-Vsd-Auth-Token': token, 'X-Vsd-Refresh-Token': refreshToken || '' };
  const post = async (path, body) => {
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await response.json();
    return { status: response.status, data };
  };
  const shotList = await post('/proxy/api/v1/shot/list', { TeamId, ProjectId, Filters: { EpisodeId: episodeId }, PageSize: 1000 });
  const shots = (shotList.data.Result?.Items || []).sort((a, b) => new Date(a.CreatedAt) - new Date(b.CreatedAt));
  const shot = shots.at(-1);
  const shotPayload = {
    TeamId,
    ProjectId,
    ShotId: shot.ShotId,
    Meta: {
      ...shot.Meta,
      Duration: 10,
      VideoMeta: {
        ...(shot.Meta?.VideoMeta || {}),
        ModelName: 'ep-20260320142658-hscwv',
        ShotGenType: 'reference_frame',
      },
    },
    VideoMeta: {
      ...(shot.VideoMeta || {}),
      Duration: 10,
      Resolution: '720p',
      OutputFormat: 'mp4',
      ModelName: 'ep-20260320142658-hscwv',
      GenType: 'reference_frame',
    },
  };
  const body = { TeamId, ProjectId, ScriptId, ShotId: shot.ShotId, Shot: shotPayload };
  const update = await post('/proxy/api/v1/shot/update', body);
  return { latestShotId: shot.ShotId, body, update };
});

console.log(JSON.stringify(result, null, 2));
await browser.disconnect();
