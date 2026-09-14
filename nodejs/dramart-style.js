export const DEFAULT_VISUAL_PROMPT_ID = 'realistic_modern_urban';
export const CUSTOM_VISUAL_STYLE_LIST_PATH = '/proxy/api/v1/custom_visual_style/list';

function trimmed(value) {
  return String(value ?? '').trim();
}

function responseError(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return '响应不是对象';
  const code = response.Code ?? response.code ?? response.StatusCode ?? response.statusCode;
  if (code !== undefined && code !== null && String(code) !== '' && Number(code) !== 0 && Number(code) !== 200) {
    return `业务状态码 ${code}`;
  }
  const metadataError = response.ResponseMetadata?.Error ?? response.responseMetadata?.error;
  if (metadataError && (metadataError.Code ?? metadataError.code ?? 0) !== 0) {
    return `业务错误 ${metadataError.Code ?? metadataError.code}: ${metadataError.Message ?? metadataError.message ?? ''}`;
  }
  return '';
}

function resultContainer(response) {
  const result = response?.Result ?? response?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('自定义风格列表返回缺少 Result 对象');
  }
  return result;
}

function styleFields(item) {
  return {
    id: trimmed(item?.StyleId ?? item?.styleId),
    name: trimmed(item?.StyleName ?? item?.styleName ?? item?.Name ?? item?.name ?? item?.Title ?? item?.title) || '未命名风格',
    category: trimmed(item?.Category ?? item?.category).toLowerCase(),
    display: item?.Display ?? item?.display ?? item?.IsDisplay ?? item?.isDisplay,
  };
}

function totalFrom(container, response) {
  const raw = container.Total ?? container.TotalCount ?? container.total ?? container.totalCount ??
    container.Pagination?.Total ?? container.Pagination?.TotalCount ??
    container.pagination?.total ?? container.pagination?.totalCount ??
    response.Total ?? response.TotalCount ?? response.total ?? response.totalCount;
  const total = Number(raw);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/**
 * Resolve the visual style for a Dramart team without making a write request.
 * `post` must throw on HTTP/transport failures and return decoded JSON.
 */
export async function resolveDramartVisualPromptId({
  teamId,
  post,
  configuredVisualPromptId = process.env.DRAMART_VISUAL_PROMPT_ID,
  pageSize = 100,
  maxPages = 100,
  log = () => {},
} = {}) {
  const override = trimmed(configuredVisualPromptId);
  if (override) return { styleId: override, source: 'configured' };
  if (!trimmed(teamId)) throw new Error('读取自定义风格需要 TeamId');
  if (typeof post !== 'function') throw new TypeError('读取自定义风格需要 post 函数');
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('自定义风格分页 PageSize 必须是正整数');
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError('自定义风格分页 maxPages 必须是正整数');

  const styles = new Map();
  let knownTotal = null;
  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
    const response = await post(CUSTOM_VISUAL_STYLE_LIST_PATH, {
      TeamId: teamId,
      Filters: { Display: true, Category: 'custom' },
      PageIndex: pageIndex,
      PageSize: pageSize,
    });
    const error = responseError(response);
    if (error) throw new Error(`读取自定义风格失败: ${error}`);
    const container = resultContainer(response);
    const items = container.Items ?? container.items;
    if (!Array.isArray(items)) throw new Error('自定义风格列表返回的 Items 不是数组');

    const before = styles.size;
    for (const item of items) {
      const style = styleFields(item);
      if (style.display !== true || style.category !== 'custom' || !style.id) continue;
      if (!styles.has(style.id)) styles.set(style.id, style);
    }
    const total = totalFrom(container, response);
    if (total !== null) knownTotal = knownTotal === null ? total : Math.max(knownTotal, total);
    if (knownTotal !== null && pageIndex * pageSize >= knownTotal) break;
    if (knownTotal === null && items.length < pageSize) break;
    if (pageIndex === maxPages) throw new Error(`自定义风格分页超过最大页数 ${maxPages}，无法确认列表完整`);
    if (items.length > 0 && styles.size === before && pageIndex > 1) {
      // Continue when the page only contains hidden/duplicate entries; page metadata still defines completeness.
    }
  }

  const candidates = [...styles.values()];
  if (candidates.length === 0) {
    log(`[dramart-style.fallback] team_id=${teamId} style_id=${DEFAULT_VISUAL_PROMPT_ID} reason=no_visible_custom_style`);
    return { styleId: DEFAULT_VISUAL_PROMPT_ID, source: 'fallback' };
  }
  if (candidates.length === 1) return { styleId: candidates[0].id, source: 'auto', candidate: candidates[0] };

  const choices = candidates.map((style) => `${style.name} (${style.id})`).join('；');
  throw new Error(`当前团队有多个可见自定义风格，无法自动选择：${choices}。请设置 DRAMART_VISUAL_PROMPT_ID 为其中一个风格 ID。`);
}

export function projectNameForStyle(baseName, styleId) {
  if (styleId === DEFAULT_VISUAL_PROMPT_ID) return baseName;
  let hash = 2166136261;
  for (const character of String(styleId)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const safe = Array.from(String(styleId), (character) => (
    /^[a-zA-Z0-9._-]$/.test(character) ? character : `_${character.codePointAt(0).toString(16)}_`
  )).join('').slice(0, 56);
  return `${baseName}-style-${safe || 'custom'}-${(hash >>> 0).toString(36)}`;
}
