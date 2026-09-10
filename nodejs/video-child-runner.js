import { StringDecoder } from 'node:string_decoder';

const TASK_STARTED_PREFIX = 'TASK_STARTED ';

export async function runVideoChild({
  spawnImpl,
  command,
  args,
  options,
  preparationTimeoutMs,
  terminationTimeoutMs = 5000,
  onPrepared,
}) {
  const child = spawnImpl(command, args, options);

  return new Promise((resolve, reject) => {
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let signalSeen = false;
    let prepared = false;
    let closeSeen = false;
    let exitCode;
    let settled = false;
    let terminationError = null;
    let terminationTimer = null;
    let forceTerminationTimer = null;

    const preparationTimer = setTimeout(() => {
      terminate(new Error(`视频子进程准备超时：${preparationTimeoutMs} 毫秒内未收到有效 TASK_STARTED`));
    }, preparationTimeoutMs);

    function clearTimers() {
      clearTimeout(preparationTimer);
      clearTimeout(terminationTimer);
      clearTimeout(forceTerminationTimer);
    }

    function recordError(error) {
      if (!error || typeof error !== 'object') return;
      const recordedError = `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}${String(error.stack || error)}`;
      try {
        error.stderr = recordedError;
      } catch {
        // Preserve the original rejection when an Error object is not extensible.
      }
    }

    function rejectOnce(error) {
      if (settled) return;
      settled = true;
      clearTimers();
      recordError(error);
      reject(error);
    }

    function finishIfReady() {
      if (settled || !prepared || !closeSeen) return;
      settled = true;
      clearTimers();
      resolve({ exitCode, stdout, stderr });
    }

    function terminate(error) {
      if (settled || terminationError) return;
      terminationError = error;
      clearTimeout(preparationTimer);

      try {
        child.kill();
      } catch {
        // Continue waiting for close; escalation below provides a bounded fallback.
      }

      if (closeSeen) {
        rejectOnce(terminationError);
        return;
      }

      terminationTimer = setTimeout(() => {
        if (settled || closeSeen) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // The final timeout reports that process exit could not be confirmed.
        }

        if (settled || closeSeen) return;
        forceTerminationTimer = setTimeout(() => {
          if (settled || closeSeen) return;
          const error = new Error(
            `无法确认子进程退出：TERM 和 SIGKILL 后均未在 ${terminationTimeoutMs} 毫秒内收到 close`,
            { cause: terminationError },
          );
          error.code = 'VIDEO_CHILD_EXIT_UNCONFIRMED';
          error.blocksPreparationQueue = true;
          rejectOnce(error);
        }, terminationTimeoutMs);
      }, terminationTimeoutMs);
    }

    function processLine(line) {
      if (settled || terminationError || signalSeen || !line.startsWith(TASK_STARTED_PREFIX)) return;
      signalSeen = true;

      let context;
      try {
        context = JSON.parse(line.slice(TASK_STARTED_PREFIX.length));
      } catch (error) {
        terminate(new Error(`TASK_STARTED JSON 解析失败：${error.message}`, { cause: error }));
        return;
      }

      const { EpisodeId, ShotId } = context?.taskEpisode || {};
      if (typeof EpisodeId !== 'string' || EpisodeId.trim() === ''
        || typeof ShotId !== 'string' || ShotId.trim() === '') {
        terminate(new Error('TASK_STARTED taskEpisode 必须包含有效的 EpisodeId 和 ShotId'));
        return;
      }

      clearTimeout(preparationTimer);
      Promise.resolve()
        .then(() => onPrepared(context))
        .then(() => {
          if (settled) return;
          prepared = true;
          finishIfReady();
        }, terminate);
    }

    child.stdout.on('data', (chunk) => {
      const text = stdoutDecoder.write(chunk);
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    });

    child.stderr.on('data', (chunk) => {
      stderr += stderrDecoder.write(chunk);
    });

    child.once('error', (error) => {
      terminate(error);
    });

    child.on('close', (code) => {
      if (settled || closeSeen) return;
      closeSeen = true;
      exitCode = code;

      const stdoutTail = stdoutDecoder.end();
      stdout += stdoutTail;
      stdoutBuffer += stdoutTail;
      stderr += stderrDecoder.end();
      if (stdoutBuffer) {
        const finalLine = stdoutBuffer;
        stdoutBuffer = '';
        processLine(finalLine);
      }

      if (settled) return;
      if (terminationError) {
        rejectOnce(terminationError);
        return;
      }
      if (!signalSeen) {
        rejectOnce(new Error(`视频子进程在准备阶段提前退出（exitCode: ${String(code)}）`));
        return;
      }
      finishIfReady();
    });
  });
}
