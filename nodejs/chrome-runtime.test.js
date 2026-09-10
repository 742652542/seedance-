import assert from 'node:assert/strict';
import test from 'node:test';

import { chromeExecutableCandidates, createChromeRuntime } from './chrome-runtime.js';

test('Chrome discovery prefers an explicit path then checks standard Windows locations', () => {
  assert.deepEqual(chromeExecutableCandidates({
    CHROME_PATH: 'D:\\Portable\\chrome.exe',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  }), [
    'D:\\Portable\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ]);
});

test('runtime launches Chrome with project user data and restarts only after expiry while idle', async () => {
  let now = 0;
  const launched = [];
  const browsers = [];
  const runtime = createChromeRuntime({
    executablePath: 'C:\\Chrome\\chrome.exe',
    userDataDir: 'F:\\project\\.chrome-user-data',
    maxAgeMs: 24 * 60 * 60 * 1000,
    now: () => now,
    launch: async (options) => {
      const id = browsers.length + 1;
      const browser = {
        connected: true,
        wsEndpoint: () => `ws://browser-${id}`,
        closeCalls: 0,
        close: async function close() { this.connected = false; this.closeCalls += 1; },
      };
      launched.push(options);
      browsers.push(browser);
      return browser;
    },
  });

  const firstLease = await runtime.acquire();
  assert.equal(firstLease.browser, browsers[0]);
  assert.deepEqual(launched[0], {
    executablePath: 'C:\\Chrome\\chrome.exe',
    headless: false,
    userDataDir: 'F:\\project\\.chrome-user-data',
    defaultViewport: { width: 1920, height: 920 },
    args: ['--start-maximized', '--disable-extension-welcome-page'],
  });

  now = 24 * 60 * 60 * 1000 + 1;
  const overlappingLease = await runtime.acquire();
  assert.equal(overlappingLease.browser, browsers[0], 'an active task must keep the current browser');
  overlappingLease.release();
  assert.equal(browsers[0].closeCalls, 0);

  firstLease.release();
  await runtime.whenIdle();
  assert.equal(browsers[0].closeCalls, 1);

  const afterRestart = await runtime.acquire();
  assert.equal(afterRestart.browser, browsers[1]);
  assert.equal(afterRestart.browserURL, 'ws://browser-2');
  afterRestart.release();
});

test('runtime automatically restarts an expired Chrome when the expiry timer finds no active task', async () => {
  let now = 0;
  let expiryCallback;
  let launches = 0;
  const closed = [];
  const runtime = createChromeRuntime({
    executablePath: 'C:\\Chrome\\chrome.exe',
    userDataDir: 'F:\\project\\.chrome-user-data',
    maxAgeMs: 100,
    now: () => now,
    setTimeout: (callback) => { expiryCallback = callback; return { unref() {} }; },
    clearTimeout: () => {},
    launch: async () => {
      launches += 1;
      const id = launches;
      return {
        connected: true,
        wsEndpoint: () => `ws://browser-${id}`,
        close: async () => { closed.push(id); },
      };
    },
  });

  await runtime.ensure();
  now = 101;
  await expiryCallback();

  assert.equal(launches, 2);
  assert.deepEqual(closed, [1]);
  assert.equal((await runtime.ensure()).browserURL, 'ws://browser-2');
});
