import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, '..', 'seedance_tasks', 'results');
const RUNNING_DIR = path.resolve(__dirname, '..', 'seedance_tasks', 'running');

function extractVideoUrl(data) {
  if (!data || typeof data !== 'object') return '';
  if (data.video_url) return String(data.video_url);
  if (data.VideoUrl) return String(data.VideoUrl);
  if (Array.isArray(data.videoUrls) && data.videoUrls[0]) return String(data.videoUrls[0]);
  if (Array.isArray(data.GeneratedVideos)) {
    const item = data.GeneratedVideos.find((video) => video?.VideoUrl || video?.VideoPreviewUrl);
    return item?.VideoUrl || item?.VideoPreviewUrl || '';
  }
  if (data.latestVideo) return extractVideoUrl(data.latestVideo);
  if (data.generationResult) return extractVideoUrl(data.generationResult);
  return '';
}

function extractError(video, fallback = '') {
  if (!video || typeof video !== 'object') return fallback;
  return String(
    video.FailedMessage ||
    video.FailedMessageEn ||
    video.FailedReason ||
    video.failedMessage ||
    video.failedReason ||
    video.error ||
    video.message ||
    fallback ||
    '',
  );
}

function findLatestVideo(result) {
  if (result?.data?.ShotId && result?.data?.Status) return result.data;
  if (result?.data?.latestVideo) return result.data.latestVideo;
  if (result?.completion_response?.generationResult?.latestVideo) return result.completion_response.generationResult.latestVideo;
  if (result?.completion_response?.Result?.Videos?.length) {
    return [...result.completion_response.Result.Videos].sort(sortVideos)[0];
  }
  if (result?.data?.response?.Result?.Videos?.length) return [...result.data.response.Result.Videos].sort(sortVideos)[0];
  return null;
}

function findRawCompletionResponse(result) {
  if (result?.data?.response?.ResponseMetadata && result?.data?.response?.Result) return result.data.response;
  if (result?.completion_response?.generationResult?.response) return result.completion_response.generationResult.response;
  if (result?.completion_response?.ResponseMetadata && result?.completion_response?.Result) return result.completion_response;
  if (result?.completion_response?.Result) return result.completion_response;
  return result?.completion_response || null;
}

function findTaskContext(result) {
  if (result?.dramart?.project || result?.dramart?.taskEpisode) return result.dramart;
  if (result?.completion_response?.project || result?.completion_response?.taskEpisode) return result.completion_response;
  if (result?.completion_response?.generationResult && (result.completion_response.project || result.completion_response.taskEpisode)) return result.completion_response;
  for (const text of [result?.stdout, result?.data?.stdout, result?.completion_response?.stdout]) {
    const match = String(text || '').match(/TASK_STARTED (\{.*\})/);
    if (!match) continue;
    try {
      return JSON.parse(match[1]);
    } catch {}
  }
  return null;
}

function taskDate(taskId) {
  const match = String(taskId || '').match(/dramart-(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function inferProjectName(result) {
  const ratio = result?.data?.VideoMeta?.Ratio || result?.data?.latestVideo?.VideoMeta?.Ratio || result?.payload?.ratio;
  const date = taskDate(result?.task_id);
  return date && ratio ? `${date}-${ratio}` : '';
}

function buildDebugTaskInfo(result, inferredEpisodeIndex = null) {
  const taskContext = findTaskContext(result);
  const projectName = result.project_name || taskContext?.project?.projectName || taskContext?.projectName || inferProjectName(result);
  const explicitEpisodeIndex = Number(result.episode_index);
  const beforeEpisodeCount = Number(taskContext?.taskEpisode?.beforeEpisodeCount);
  const episodeIndex = Number.isFinite(explicitEpisodeIndex) && explicitEpisodeIndex > 0
    ? explicitEpisodeIndex
    : Number.isFinite(beforeEpisodeCount)
      ? beforeEpisodeCount + 1
      : inferredEpisodeIndex
        ? inferredEpisodeIndex
      : null;
  const debugTaskId = projectName && episodeIndex ? `${projectName}-${episodeIndex}` : result.debug_task_id || result.task_id;
  return {
    debug_task_id: debugTaskId,
    project_name: projectName,
    episode_index: episodeIndex,
  };
}

function buildClientData(data, debugInfo) {
  if (!data || typeof data !== 'object') return data;
  const videoUrl = extractVideoUrl(data);
  const {
    VideoMeta,
    FailedReason,
    GeneratedVideos,
    ClearSubtitleCode,
    ClearSubtitleEnable,
    EnhanceEnable,
    EnhanceCode,
    ...rest
  } = data;
  return {
    ...rest,
    debug_task_id: debugInfo.debug_task_id,
    content: { ...(data.content || {}), video_url: videoUrl },
  };
}

function applyDebugInfo(result, inferredEpisodeIndex = null) {
  const debugInfo = buildDebugTaskInfo(result, inferredEpisodeIndex);
  const videoUrl = extractVideoUrl(result.data) || result.video_url || '';
  const next = { ...result, ...debugInfo };
  if (videoUrl) next.video_url = videoUrl;
  if (next.data && typeof next.data === 'object') {
    next.data = buildClientData(next.data, debugInfo);
  }
  if (next.completion_response && typeof next.completion_response === 'object') {
    next.completion_response = { ...next.completion_response, ...debugInfo };
  }
  return next;
}

function sortVideos(a, b) {
  const aTime = Date.parse(a.CreatedAt || a.UpdatedAt || '') || 0;
  const bTime = Date.parse(b.CreatedAt || b.UpdatedAt || '') || 0;
  if (bTime !== aTime) return bTime - aTime;
  return String(b.Version || '').localeCompare(String(a.Version || ''));
}

function needsMigration(result) {
  return Boolean(
    result?.task_id?.startsWith('dramart-') &&
    result?.data &&
    !result.data.ShotId &&
    (result.data.latestVideo || result.data.response || result.completion_response?.generationResult),
  );
}

function migrateResult(result, inferredEpisodeIndex = null) {
  const latestVideo = findLatestVideo(result);
  if (!latestVideo) return null;

  const rawCompletionResponse = findRawCompletionResponse(result);
  const rawStatus = String(latestVideo.Status || '').toLowerCase();
  const success = ['done', 'completed', 'succeeded', 'success'].includes(rawStatus) || Boolean(extractVideoUrl(latestVideo));
  const error = success ? '' : extractError(latestVideo, result.error || '任务失败');
  const debugInfo = buildDebugTaskInfo(result, inferredEpisodeIndex);
  const videoUrl = extractVideoUrl(latestVideo);
  const resultData = buildClientData(latestVideo, debugInfo);
  const migrated = {
    status: success ? 'success' : 'error',
    task_id: result.task_id,
    ...debugInfo,
    action: result.action || 'generate_video',
    data: resultData,
    error,
    message: result.message || '',
    url_id: result.url_id || '',
    client_id: result.client_id || 'seedance_api',
    updated_at: result.updated_at || Math.floor(Date.now() / 1000),
    completion_response: rawCompletionResponse && typeof rawCompletionResponse === 'object'
      ? { ...rawCompletionResponse, ...debugInfo }
      : rawCompletionResponse,
  };

  if (videoUrl) migrated.video_url = videoUrl;
  return migrated;
}

const summary = [];

async function processFile(dir, name) {
  const filePath = path.join(dir, name);
  const result = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (needsMigration(result)) {
    const migrated = migrateResult(result, episodeIndexByTaskId.get(result.task_id));
    if (!migrated) {
      summary.push({ file: name, action: 'failed', reason: 'missing latest video' });
      return;
    }

    await fs.writeFile(filePath, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8');
    summary.push({
      file: name,
      action: 'migrated',
      status: migrated.status,
      debug_task_id: migrated.debug_task_id,
      dataShape: migrated.data?.ShotId ? 'dramart_video' : typeof migrated.data,
      hasRawCompletionResponse: Boolean(migrated.completion_response?.ResponseMetadata),
      hasVideoUrl: Boolean(migrated.video_url),
    });
    return;
  }

  const withDebugInfo = applyDebugInfo(result, episodeIndexByTaskId.get(result.task_id));
  if (JSON.stringify(withDebugInfo) !== JSON.stringify(result)) {
    await fs.writeFile(filePath, `${JSON.stringify(withDebugInfo, null, 2)}\n`, 'utf8');
    summary.push({ file: name, action: 'debug-info-added', debug_task_id: withDebugInfo.debug_task_id });
    return;
  }

  summary.push({ file: name, action: 'skipped', debug_task_id: result.debug_task_id });
}

const allRecords = [];
for (const dir of [RESULTS_DIR, RUNNING_DIR]) {
  const files = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json'));
  for (const name of files) {
    const filePath = path.join(dir, name);
    try {
      const result = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const projectName = result.project_name || findTaskContext(result)?.project?.projectName || inferProjectName(result);
      if (projectName && result.task_id?.startsWith('dramart-')) allRecords.push({ taskId: result.task_id, projectName });
    } catch {}
  }
}

const episodeIndexByTaskId = new Map();
for (const projectName of new Set(allRecords.map((item) => item.projectName))) {
  allRecords
    .filter((item) => item.projectName === projectName)
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
    .forEach((item, index) => episodeIndexByTaskId.set(item.taskId, index + 1));
}

for (const dir of [RESULTS_DIR, RUNNING_DIR]) {
  const files = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json'));
  for (const name of files) await processFile(dir, name);
}

console.log(JSON.stringify(summary, null, 2));
