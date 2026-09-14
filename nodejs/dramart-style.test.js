import assert from 'node:assert/strict';
import test from 'node:test';

import { CUSTOM_VISUAL_STYLE_LIST_PATH, DEFAULT_VISUAL_PROMPT_ID, resolveDramartVisualPromptId } from './dramart-style.js';

function customStyle(StyleId, StyleName = StyleId) {
  return { StyleId, StyleName, Category: 'custom', Display: true };
}

test('configured visual style wins without reading the custom-style API', async () => {
  const result = await resolveDramartVisualPromptId({
    teamId: 'team-1', configuredVisualPromptId: 'configured-style',
    post: async () => { throw new Error('must not call'); },
  });
  assert.deepEqual(result, { styleId: 'configured-style', source: 'configured' });
});

test('no visible custom style falls back to the legacy style and logs the reason', async () => {
  const calls = [];
  const logs = [];
  const result = await resolveDramartVisualPromptId({
    teamId: 'team-1', log: (line) => logs.push(line),
    post: async (path, body) => {
      calls.push({ path, body });
      return { Result: { Items: [{ StyleId: '', Category: 'custom', Display: true }, { ...customStyle('hidden'), Display: false }] } };
    },
  });
  assert.equal(result.styleId, DEFAULT_VISUAL_PROMPT_ID);
  assert.equal(result.source, 'fallback');
  assert.deepEqual(calls, [{ path: CUSTOM_VISUAL_STYLE_LIST_PATH, body: {
    TeamId: 'team-1', Filters: { Display: true, Category: 'custom' }, PageIndex: 1, PageSize: 100,
  } }]);
  assert.match(logs[0], /no_visible_custom_style/);
});

test('one visible custom style is auto-selected after all pages are read', async () => {
  const calls = [];
  const pageOne = Array.from({ length: 100 }, (_, index) => ({ StyleId: `hidden-${index}`, Category: 'preset', Display: true }));
  const result = await resolveDramartVisualPromptId({
    teamId: 'team-1',
    post: async (_path, body) => {
      calls.push(body);
      return body.PageIndex === 1
        ? { Result: { Items: pageOne } }
        : { Result: { Items: [customStyle('auto-style', '我的风格')] } };
    },
  });
  assert.equal(result.styleId, 'auto-style');
  assert.equal(result.source, 'auto');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((body) => body.PageIndex), [1, 2]);
});

test('multiple custom styles fail with candidates and configuration guidance', async () => {
  await assert.rejects(
    resolveDramartVisualPromptId({
      teamId: 'team-1',
      post: async () => ({ Result: { Items: [customStyle('style-a', '写实'), customStyle('style-b', '漫画'), customStyle('style-a', '重复')] } }),
    }),
    /写实 \(style-a\).*漫画 \(style-b\).*DRAMART_VISUAL_PROMPT_ID/s,
  );
});

test('custom-style API business and structure errors fail safely', async () => {
  await assert.rejects(
    resolveDramartVisualPromptId({ teamId: 'team-1', post: async () => ({ Code: 500, Result: { Items: [] } }) }),
    /业务状态码 500/,
  );
  await assert.rejects(
    resolveDramartVisualPromptId({ teamId: 'team-1', post: async () => ({ Result: {} }) }),
    /Items 不是数组/,
  );
});
