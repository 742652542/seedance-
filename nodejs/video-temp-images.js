import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const TASK_ID_PATTERN = /^dramart-\d{14}-[a-z0-9]{5}$/;

function extensionFromMime(mime) {
  const normalized = String(mime || '').toLowerCase();
  if (normalized.includes('jpeg')) return '.jpg';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('gif')) return '.gif';
  if (normalized.includes('bmp')) return '.bmp';
  return '.png';
}

export function createVideoTempImages({
  taskId,
  tempRoot,
  fsImpl = fs,
  fetchImpl = fetch,
  downloadTimeoutMs = 30_000,
  maxImageBytes = 50 * 1024 * 1024,
  randomName = randomUUID,
}) {
  if (!TASK_ID_PATTERN.test(String(taskId))) throw new Error(`非法任务 ID: ${taskId}`);
  const taskDir = path.join(tempRoot, taskId);

  function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  async function ensureSafeTaskDir() {
    await fsImpl.mkdir(tempRoot, { recursive: true });
    const rootRealPath = await fsImpl.realpath(tempRoot);
    try {
      const existing = await fsImpl.lstat(taskDir);
      if (existing.isSymbolicLink()) throw new Error(`任务临时目录是链接，拒绝使用: ${taskDir}`);
      if (!existing.isDirectory()) throw new Error(`任务临时目录不安全: ${taskDir}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try {
        await fsImpl.mkdir(taskDir);
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
    }
    const taskStat = await fsImpl.lstat(taskDir);
    if (taskStat.isSymbolicLink() || !taskStat.isDirectory()) {
      throw new Error(`任务临时目录不安全，拒绝使用: ${taskDir}`);
    }
    const taskRealPath = await fsImpl.realpath(taskDir);
    if (!isInside(rootRealPath, taskRealPath) || taskRealPath === rootRealPath) {
      throw new Error(`任务临时目录不安全，位于根目录之外: ${taskDir}`);
    }
  }

  async function writeImage(index, extension, contents) {
    await ensureSafeTaskDir();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const filePath = path.join(taskDir, `${index}-${randomName()}${extension}`);
      try {
        await fsImpl.writeFile(filePath, contents, { flag: 'wx' });
        return { path: filePath, callerOwned: false };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    throw new Error(`生成临时图片文件名连续碰撞: ${taskDir}`);
  }

  function cancelBody(body, reader) {
    try {
      let cancellation;
      if (reader?.cancel) cancellation = reader.cancel();
      else if (body?.cancel) cancellation = body.cancel();
      else if (body?.destroy) body.destroy();
      Promise.resolve(cancellation).catch(() => {});
    } catch {}
  }

  function decodeBase64(value, source) {
    const compact = String(value).replace(/[\t\n\f\r ]/g, '');
    const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
    const estimatedBytes = Math.max(0, Math.floor(compact.length * 3 / 4) - padding);
    if (estimatedBytes > maxImageBytes) {
      throw new Error(`${source}超过大小限制 ${maxImageBytes} 字节`);
    }
    if (!compact || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
      throw new Error(`${source}格式不正确`);
    }
    const buffer = Buffer.from(compact, 'base64');
    if (buffer.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
      throw new Error(`${source}格式不正确`);
    }
    if (buffer.length > maxImageBytes) {
      throw new Error(`${source}超过大小限制 ${maxImageBytes} 字节`);
    }
    return buffer;
  }

  function isExplicitLocalImagePath(value) {
    return /^[A-Za-z]:[\\/]/.test(value) ||
      /^\.\.?[\\/]/.test(value) ||
      /^\\(?!\\)/.test(value) ||
      /^\\\\[^\\]+\\[^\\]+(?:\\.*)?$/.test(value) ||
      value.includes('\\') ||
      /\.(?:png|jpe?g|webp|gif|bmp|svg|avif|heic|heif)$/i.test(value);
  }

  function isForwardSlashUncPath(value) {
    return /^\/\/[^/]+\/[^/]+(?:\/.*)?$/.test(value);
  }

  async function readLimitedBody(response, source, signal) {
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxImageBytes) {
      cancelBody(response.body);
      throw new Error(`下载图片超过大小限制 ${maxImageBytes} 字节: ${source}`);
    }
    if (!response.body) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxImageBytes) throw new Error(`下载图片超过大小限制 ${maxImageBytes} 字节: ${source}`);
      return buffer;
    }

    const chunks = [];
    let total = 0;
    const reader = response.body.getReader?.();
    let rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = reject; });
    const onAbort = () => rejectAborted(signal.reason || new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (reader) {
        while (true) {
          const { done, value } = await Promise.race([reader.read(), aborted]);
          if (done) break;
          const chunk = Buffer.from(value);
          total += chunk.length;
          if (total > maxImageBytes) {
            cancelBody(response.body, reader);
            throw new Error(`下载图片超过大小限制 ${maxImageBytes} 字节: ${source}`);
          }
          chunks.push(chunk);
        }
      } else {
        const iterator = response.body[Symbol.asyncIterator]();
        while (true) {
          const { done, value } = await Promise.race([iterator.next(), aborted]);
          if (done) break;
          const chunk = Buffer.from(value);
          total += chunk.length;
          if (total > maxImageBytes) {
            cancelBody(response.body);
            throw new Error(`下载图片超过大小限制 ${maxImageBytes} 字节: ${source}`);
          }
          chunks.push(chunk);
        }
      }
    } catch (error) {
      if (signal.aborted) cancelBody(response.body, reader);
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
      reader?.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
  }

  async function downloadImage(source) {
    const controller = new AbortController();
    let response;
    let timeout;
    let timedOut = false;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(`下载图片超时 (${downloadTimeoutMs}ms): ${source}`));
      }, downloadTimeoutMs);
    });
    try {
      return await Promise.race([
        (async () => {
          response = await fetchImpl(source, { signal: controller.signal });
          if (!response.ok) {
            cancelBody(response.body);
            throw new Error(`下载图片失败 HTTP ${response.status}: ${source}`);
          }
          return {
            buffer: await readLimitedBody(response, source, controller.signal),
            mime: response.headers?.get?.('content-type') || 'image/png',
          };
        })(),
        timeoutPromise,
      ]);
    } catch (error) {
      if (timedOut) {
        cancelBody(response?.body);
        throw new Error(`下载图片超时 (${downloadTimeoutMs}ms): ${source}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function materialize(value, index) {
    if (!value) return null;
    const input = String(value);
    const asciiTrimmed = input.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
    if (/^https?:\/\//i.test(asciiTrimmed)) {
      const { buffer, mime } = await downloadImage(asciiTrimmed);
      return writeImage(index, extensionFromMime(mime), buffer);
    }
    if (asciiTrimmed.startsWith('data:')) {
      const match = asciiTrimmed.match(/^data:([^;]+);base64,([\s\S]*)$/);
      if (!match) throw new Error('不支持的 data URL 图片格式');
      return writeImage(index, extensionFromMime(match[1]), decodeBase64(match[2], 'data URL 图片'));
    }
    if (isExplicitLocalImagePath(asciiTrimmed)) {
      try {
        await fsImpl.access(value);
        return { path: value, callerOwned: true };
      } catch {
        throw new Error(`图片文件不存在: ${asciiTrimmed}`);
      }
    }
    try {
      return writeImage(index, '.png', decodeBase64(input, 'base64 图片'));
    } catch (base64Error) {
      try {
        await fsImpl.access(value);
        return { path: value, callerOwned: true };
      } catch {
        if (isForwardSlashUncPath(asciiTrimmed)) throw new Error(`图片文件不存在: ${asciiTrimmed}`);
        throw base64Error;
      }
    }
  }

  return {
    taskDir,
    materialize,
    cleanup: async () => {
      let stat;
      try {
        stat = await fsImpl.lstat(taskDir);
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        await fsImpl.unlink(taskDir);
        return;
      }
      const rootRealPath = await fsImpl.realpath(tempRoot);
      const taskRealPath = await fsImpl.realpath(taskDir);
      if (!stat.isDirectory() || !isInside(rootRealPath, taskRealPath) || taskRealPath === rootRealPath) {
        throw new Error(`任务临时目录不安全，拒绝清理: ${taskDir}`);
      }
      await fsImpl.rm(taskDir, { recursive: true, force: true });
    },
  };
}

export async function materializeVideoImages(tempImages, images, imageValueFn) {
  const results = await Promise.allSettled(images.map((item, index) => (
    Promise.resolve().then(() => tempImages.materialize(imageValueFn(item), index))
  )));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results
    .map((result) => result.value)
    .filter(Boolean)
    .map((image) => image.path);
}

export async function cleanupAbandonedVideoTempDirs({ tempRoot, activeTaskIds, fsImpl = fs }) {
  let entries;
  try {
    entries = await fsImpl.readdir(tempRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const active = new Set(activeTaskIds || []);
  const removals = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && TASK_ID_PATTERN.test(entry.name) && !active.has(entry.name))
    .map((entry) => fsImpl.rm(path.join(tempRoot, entry.name), { recursive: true, force: true }));
  const results = await Promise.allSettled(removals);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}
