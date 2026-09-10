import puppeteer from 'puppeteer-core';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';
const TEAM_ID = process.env.TEAM_ID || '6a90faa57906980889d712fd';
const TODAY = process.env.PROJECT_DATE || new Date().toLocaleDateString('en-CA');
const PROJECT_NAME = process.env.PROJECT_NAME || `${TODAY}-01`;

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart')) || pages.at(-1) || (await browser.newPage());

await page.bringToFront();
await page.goto('https://work.xiaomaomi.cn/dramart/projectlist/', { waitUntil: 'domcontentloaded', timeout: 60000 });

const result = await page.evaluate(
  async ({ teamId, today, projectName }) => {
    const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
    const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
    if (!token) throw new Error('localStorage 中没有 DRAMART_AUTH_TOKEN，请先登录');

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
      const data = await response.json();
      if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${JSON.stringify(data)}`);
      return data;
    };

    const listResult = await post('/proxy/api/v1/project/list', {
      TeamId: teamId,
      Filters: { CreationMode: 'agent,manual' },
      PageIndex: 1,
      PageSize: 50,
    });

    const projects = listResult.Result?.Items || [];
    const todayProjects = projects
      .filter((project) => project.ProjectName === today || project.ProjectName?.startsWith(`${today}-`))
      .sort((a, b) => new Date(b.CreatedAt || b.UpdatedAt) - new Date(a.CreatedAt || a.UpdatedAt));

    const existing = todayProjects[0];
    if (existing) {
      return {
        action: 'exists',
        projectName: existing.ProjectName,
        projectId: existing.ProjectId,
        scriptId: existing.ScriptId,
        teamId: existing.TeamId || teamId,
        status: existing.Status,
        url: `https://work.xiaomaomi.cn/dramart/project/${existing.ProjectId}/${existing.ScriptId}/${existing.TeamId || teamId}`,
      };
    }

    const createResult = await post('/proxy/api/v1/project/create', {
      TeamId: teamId,
      AspectRatio: '9:16',
      Resolution: '720p',
      Language: 'en',
      VisualPromptId: '6a9658a204b6dbdd6d21ce84',
      CreationMode: 'manual',
    });

    const projectId = createResult.Result?.ProjectId;
    const scriptId = createResult.Result?.ScriptId;
    if (!projectId || !scriptId) throw new Error(`创建项目返回缺少 ID: ${JSON.stringify(createResult)}`);

    const renameResult = await post('/proxy/api/v1/project/update', {
      ProjectName: projectName,
      ProjectId: projectId,
      TeamId: teamId,
    });

    const confirmResult = await post('/proxy/api/v1/project/update', {
      Status: 'resource_confirmed',
      ProjectId: projectId,
      TeamId: teamId,
    });

    return {
      action: 'created',
      projectName: renameResult.Result?.ProjectName || projectName,
      projectId,
      scriptId,
      teamId,
      status: confirmResult.Result?.Status,
      url: `https://work.xiaomaomi.cn/dramart/project/${projectId}/${scriptId}/${teamId}`,
    };
  },
  { teamId: TEAM_ID, today: TODAY, projectName: PROJECT_NAME },
);

console.log('今日项目检查结果:', JSON.stringify(result, null, 2));

await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});

const finalState = await page.evaluate(() => ({
  url: location.href,
  bodyText: document.body.innerText.slice(0, 1000),
}));

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getStoryboardState() {
  return page.evaluate(
    async () => {
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
        const data = await response.json();
        if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${JSON.stringify(data)}`);
        return data;
      };

      const episodeResult = await post('/proxy/api/v1/episode/list', {
        TeamId,
        ProjectId,
        Filters: { ScriptId },
        PageSize: 1000,
      });

      const episodes = (episodeResult.Result?.Items || []).sort(
        (a, b) => new Date(a.CreatedAt || a.UpdatedAt) - new Date(b.CreatedAt || b.UpdatedAt),
      );
      return {
        projectId: ProjectId,
        scriptId: ScriptId,
        teamId: TeamId,
        episodeCount: episodes.length,
        episodes: episodes.map((episode) => ({
          episodeId: episode.EpisodeId,
          title: episode.Meta?.Title || '',
        })),
      };
    },
  );
}

const storyboardState = await getStoryboardState();
console.log('分镜页集数状态:', JSON.stringify(storyboardState, null, 2));

const finalStoryboardState = await page.evaluate(() => ({
  url: location.href,
  bodyText: document.body.innerText.slice(0, 1200),
}));

console.log('最终页面:', JSON.stringify({ finalState, storyboardState, finalStoryboardState }, null, 2));
await browser.disconnect();
