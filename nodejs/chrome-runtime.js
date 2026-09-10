import fs from 'node:fs/promises';
import path from 'node:path';

const FIXED_VIEWPORT = { width: 1920, height: 920 };

export function chromeExecutableCandidates(env = process.env) {
  return [
    env.CHROME_PATH,
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
}

export async function findChromeExecutable(options = {}) {
  const access = options.access || fs.access;
  const candidates = chromeExecutableCandidates(options.env);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the standard installation locations.
    }
  }
  throw new Error(`未找到 Chrome，请安装 Google Chrome 或设置 CHROME_PATH。已检查: ${candidates.join(', ')}`);
}

export function createChromeRuntime(options) {
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const now = options.now || Date.now;
  const log = options.log || (() => {});
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  let browser = null;
  let browserURL = '';
  let launchedAt = 0;
  let activeTasks = 0;
  let operation = Promise.resolve();
  let expiryTimer = null;

  function serialized(callback) {
    const next = operation.then(callback, callback);
    operation = next.catch(() => {});
    return next;
  }

  function expired() {
    return browser && now() - launchedAt >= maxAgeMs;
  }

  function scheduleExpiry() {
    clearTimer(expiryTimer);
    expiryTimer = setTimer(
      () => serialized(restartIfIdle).catch((error) => log(`[chrome.restart_error] error=${String(error)}`)),
      maxAgeMs,
    );
    expiryTimer.unref?.();
  }

  async function closeBrowser() {
    if (!browser) return;
    const closing = browser;
    browser = null;
    browserURL = '';
    clearTimer(expiryTimer);
    await closing.close().catch((error) => log(`[chrome.close_error] error=${String(error)}`));
  }

  async function restartIfIdle() {
    if (!expired() || activeTasks > 0) return false;
    log(`[chrome.restart] reason=24h_idle age_ms=${now() - launchedAt}`);
    await closeBrowser();
    await launchBrowser();
    return true;
  }

  async function launchBrowser() {
    const executablePath = options.executablePath || await (options.findExecutable || findChromeExecutable)();
    browser = await options.launch({
      executablePath,
      headless: false,
      userDataDir: options.userDataDir,
      defaultViewport: FIXED_VIEWPORT,
      args: ['--start-maximized', '--disable-extension-welcome-page'],
    });
    browserURL = browser.wsEndpoint();
    launchedAt = now();
    scheduleExpiry();
    log(`[chrome.open] executable=${executablePath} user_data_dir=${options.userDataDir}`);
    return { browser, browserURL };
  }

  async function ensureBrowser() {
    if (await restartIfIdle()) return { browser, browserURL };
    if (browser && browser.connected !== false) return { browser, browserURL };
    return launchBrowser();
  }

  return {
    acquire() {
      return serialized(async () => {
        const ready = await ensureBrowser();
        activeTasks += 1;
        let released = false;
        return {
          ...ready,
          release() {
            if (released) return;
            released = true;
            activeTasks -= 1;
            serialized(restartIfIdle).catch((error) => log(`[chrome.restart_error] error=${String(error)}`));
          },
        };
      });
    },

    ensure() {
      return serialized(ensureBrowser);
    },

    whenIdle() {
      return serialized(restartIfIdle);
    },
  };
}
