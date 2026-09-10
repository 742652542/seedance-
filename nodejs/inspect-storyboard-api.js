import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart/project/')) || pages.at(-1) || (await browser.newPage());

await page.bringToFront();

const result = await page.evaluate(async () => {
  const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
  const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
  const match = location.pathname.match(/\/dramart\/project\/(project_[^/]+)\/(script_[^/]+)\/([^/]+)/);
  if (!match) throw new Error(`当前地址不是项目分镜页: ${location.href}`);

  const [, ProjectId, ScriptId, TeamId] = match;
  const post = async (path, body) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: token,
        'X-Vsd-Auth-Token': token,
        'X-Vsd-Refresh-Token': refreshToken || '',
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };

  const episodeList = await post('/proxy/api/v1/episode/list', {
    TeamId,
    ProjectId,
    Filters: { ScriptId },
    PageSize: 1000,
  });
  const episodes = episodeList.data?.Result?.Items || [];
  const shotLists = [];
  for (const episode of episodes) {
    shotLists.push({
      EpisodeId: episode.EpisodeId,
      EpisodeName: episode.EpisodeName,
      result: await post('/proxy/api/v1/shot/list', {
        TeamId,
        ProjectId,
        Filters: { EpisodeId: episode.EpisodeId },
        PageSize: 1000,
      }),
    });
  }
  const projectList = await post('/proxy/api/v1/project/list', {
    TeamId,
    Filters: { ProjectIds: [ProjectId] },
  });

  return {
    url: location.href,
    ProjectId,
    ScriptId,
    TeamId,
    episodeList,
    shotLists,
    projectList,
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.disconnect();
