import puppeteer from 'puppeteer-core';
import { resolveDramartTeamId } from './dramart-team.js';

const BROWSER_URL = process.env.BROWSER_URL || 'http://127.0.0.1:42208';
const CONFIGURED_TEAM_ID = process.env.TEAM_ID || '';
const PROJECT_NAME = process.env.PROJECT_NAME || `${new Date().toLocaleDateString('en-CA')}-api-only`;

const browser = await puppeteer.connect({ browserURL: BROWSER_URL });
const pages = await browser.pages();
const page = pages.find((item) => item.url().includes('/dramart')) || pages.at(-1) || (await browser.newPage());

await page.bringToFront();
await page.goto('https://work.xiaomaomi.cn/dramart/projectlist/', { waitUntil: 'domcontentloaded', timeout: 60000 });
const teamId = await resolveDramartTeamId(page, CONFIGURED_TEAM_ID);

const result = await page.evaluate(
  async ({ teamId, projectName }) => {
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

    const createResult = await post('/proxy/api/v1/project/create', {
      TeamId: teamId,
      AspectRatio: '9:16',
      Resolution: '720p',
      Language: 'en',
      VisualPromptId: 'realistic_modern_urban',
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
      projectName,
      projectId,
      scriptId,
      teamId,
      url: `https://work.xiaomaomi.cn/dramart/project/${projectId}/${scriptId}/${teamId}`,
      createStatus: createResult.ResponseMetadata?.RequestId ? 'ok' : createResult,
      renameProjectName: renameResult.Result?.ProjectName,
      confirmStatus: confirmResult.Result?.Status,
    };
  },
  { teamId, projectName: PROJECT_NAME },
);

console.log('API 创建结果:', JSON.stringify(result, null, 2));

await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});

const finalState = await page.evaluate(() => ({
  url: location.href,
  bodyText: document.body.innerText.slice(0, 1000),
}));

console.log('最终页面:', JSON.stringify(finalState, null, 2));
await browser.disconnect();
