import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.LIVE_TEST_PORT || 9094);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MODEL = process.env.LIVE_TEST_MODEL || 'ep-20260709194802-qsvc2';
const MODEL_NAME = process.env.LIVE_TEST_MODEL_NAME || 'Doubao-Seedream-5.0-Pro';
const STYLE_ID = process.env.LIVE_TEST_STYLE_ID || '6a9658a204b6dbdd6d21ce84';
const POLL_INTERVAL_MS = 3000;
const ROUND_TIMEOUT_MS = 18 * 60 * 1000;
let artifactDir = '';
let serverLogs = '';

const requestedRatio = process.env.LIVE_TEST_RATIO || '5:4';
const rounds = [[{
  label: 'single-ratio',
  prompt: `单任务比例验证，生成一张 ${requestedRatio} 的简洁商品图，保持商品结构`,
  ratio: requestedRatio,
  imageUrl: 'https://cdn.ixspy.cn/aliexpress/aiTool/demo/video/3-1.png',
}]];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function collectSubmitEvidence(logs, tasks) {
  const lines = String(logs).split(/\r?\n/);
  const taskIds = new Set(tasks.map((task) => task.taskId));
  const submits = [];
  const doneTaskIds = new Set();
  let firstDoneIndex = Infinity;
  for (let index = 0; index < lines.length; index += 1) {
    const done = lines[index].match(/\[task\.done\] task_id=([^ ]+)/);
    if (done && taskIds.has(done[1])) {
      doneTaskIds.add(done[1]);
      firstDoneIndex = Math.min(firstDoneIndex, index);
    }
    const submit = lines[index].match(/\[image-session\.submit\] task_id=([^ ]+) resource_id=([^ ]+) ratio=([^ ]+)/);
    if (submit && taskIds.has(submit[1])) {
      submits.push({ index, taskId: submit[1], resourceId: submit[2], ratio: submit[3] });
    }
  }
  const evidence = tasks.map((task) => submits.find((item) => item.taskId === task.taskId));
  if (doneTaskIds.size !== taskIds.size) throw new Error('完成日志证据不足：未捕获该轮全部 task.done');
  if (evidence.some((item) => !item) || evidence.some((item) => item.index >= firstDoneIndex)) {
    throw new Error('提交重叠证据不足：该轮两个 generation submit 必须都早于任一 task.done');
  }
  return evidence.map(({ index: _index, ...item }) => item);
}

export async function stopChild(child, options = {}) {
  if (child.exitCode !== null) return;
  child.kill();
  const timeoutMs = options.timeoutMs ?? 5000;
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function waitForSubmitEvidence(logStart, tasks) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return collectSubmitEvidence(serverLogs.slice(logStart), tasks);
    } catch (error) {
      if (!/完成日志证据不足/.test(String(error))) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return collectSubmitEvidence(serverLogs.slice(logStart), tasks);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function waitForServer(child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`任务服务提前退出，exitCode=${child.exitCode}`);
    try {
      const health = await requestJson(`${BASE_URL}/health`);
      if (health.success) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('等待任务服务启动超时');
}

async function submit(spec) {
  const submitted = await requestJson(`${BASE_URL}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'generate_image',
      model: MODEL,
      model_name: MODEL_NAME,
      prompt: spec.prompt,
      images: [{ url: spec.imageUrl, title: spec.label }],
      ratio: spec.ratio,
      resolution: '1k',
      count: 1,
      style_id: STYLE_ID,
      wait_for_completion: false,
    }),
  });
  assert(submitted.status === 'processing', `${spec.label} 提交状态不是 processing`);
  assert(submitted.task_id, `${spec.label} 未返回 task_id`);
  return { ...spec, taskId: submitted.task_id };
}

async function waitForProject(task) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const current = await requestJson(`${BASE_URL}/api/result/${task.taskId}`);
    const project = current.completion_response?.project;
    if (project?.projectId) return project;
    if (current.status === 'completed') throw new Error(`${task.label} 在记录项目上下文前已结束: ${JSON.stringify(current)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${task.label} 等待项目上下文超时`);
}

async function waitForResult(task) {
  const deadline = Date.now() + ROUND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await requestJson(`${BASE_URL}/api/result/${task.taskId}`);
    if (current.status === 'completed') {
      assert(current.result?.task_id === task.taskId, `${task.label} 响应 task_id 串任务`);
      assert(current.result?.status === 'success', `${task.label} 生图失败: ${current.result?.error || JSON.stringify(current)}`);
      assert(Array.isArray(current.result.data) && current.result.data.length > 0, `${task.label} 没有图片 URL`);
      return { ...task, urls: current.result.data };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`${task.label} 等待结果超时`);
}

async function loadPersistedResult(task) {
  const filePath = path.join(ROOT, 'seedance_tasks', 'results', `${task.taskId}.json`);
  const result = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert(result.task_id === task.taskId, `${task.label} 落盘 task_id 串任务`);
  const resourceId = result.data?.ResourceId || result.completion_response?.ResourceId || result.data?.GeneratedResource?.ResourceId;
  const generatedAspectRatio = result.data?.GenImageMeta?.AspectRatio || result.completion_response?.GenImageMeta?.AspectRatio || '';
  return { ...task, resourceId: resourceId || '', generatedAspectRatio, persistedImageUrl: result.image_url || '' };
}

async function downloadArtifacts(task) {
  const files = [];
  for (let index = 0; index < task.urls.length; index += 1) {
    const response = await fetch(task.urls[index]);
    assert(response.ok, `${task.label} 下载结果失败 HTTP ${response.status}`);
    const filePath = path.join(artifactDir, `${task.label}-${index + 1}.png`);
    await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
    files.push(filePath);
  }
  return { ...task, files };
}

async function runRound(index, specs) {
  console.log(`[live-test] 第 ${index} 轮提交 ${specs.length} 个任务`);
  const logStart = serverLogs.length;
  const submitted = await Promise.all(specs.map(submit));
  assert(new Set(submitted.map((task) => task.taskId)).size === submitted.length, `第 ${index} 轮 task_id 重复`);

  const projects = await Promise.all(submitted.map(waitForProject));
  assert(projects.every((project) => project.projectId === projects[0].projectId), `第 ${index} 轮没有共用 image 项目`);
  assert(projects.every((project) => project.projectName === 'image'), `第 ${index} 轮项目名称不是 image`);

  const completed = await Promise.all(submitted.map(waitForResult));
  const submitEvidence = await waitForSubmitEvidence(logStart, submitted);
  const persisted = await Promise.all(completed.map(loadPersistedResult));
  const allUrls = persisted.flatMap((task) => task.urls);
  assert(new Set(allUrls).size === allUrls.length, `第 ${index} 轮返回图片 URL 发生交叉或重复`);
  const resourceIds = persisted.map((task) => task.resourceId).filter(Boolean);
  assert(new Set(resourceIds).size === resourceIds.length, `第 ${index} 轮 ResourceId 发生交叉`);

  const downloaded = await Promise.all(persisted.map(downloadArtifacts));
  console.log(`[live-test] 第 ${index} 轮通过 ${JSON.stringify(downloaded.map((task) => ({
    label: task.label,
    taskId: task.taskId,
    ratio: task.ratio,
    generatedAspectRatio: task.generatedAspectRatio,
    projectId: projects[0].projectId,
    resourceId: task.resourceId,
    urls: task.urls,
    files: task.files,
  })))}`);
  return { model: MODEL, modelName: MODEL_NAME, styleId: STYLE_ID, projectId: projects[0].projectId, submitEvidence, tasks: downloaded };
}

async function main() {
artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seedance-live-image-test-'));
const child = spawn(process.execPath, ['nodejs/task-server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => {
  serverLogs += chunk.toString();
  process.stdout.write(`[server] ${chunk}`);
});
child.stderr.on('data', (chunk) => {
  serverLogs += chunk.toString();
  process.stderr.write(`[server:error] ${chunk}`);
});

try {
  await waitForServer(child);
  const results = [];
  for (let index = 0; index < rounds.length; index += 1) {
    results.push(await runRound(index + 1, rounds[index]));
  }
  const summaryPath = path.join(artifactDir, 'summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`[live-test] 真实生图验证通过，证据目录: ${artifactDir}`);
} finally {
  await stopChild(child);
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
