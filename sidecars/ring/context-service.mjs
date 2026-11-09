import { discoverLanguageServer } from './ls-discovery.mjs';
import { rpcCall } from './rpc-client.mjs';
import { processTrajectorySteps } from './context-calculator.mjs';

const memoryCache = new Map();
const MEMORY_CACHE_TTL = 8000; // 8秒内存瞬时命中缓存，杜绝重复RPC冲刷
const MAX_MEMORY_CACHE_SIZE = 50; // 对齐前端一级内存缓存上限（50个会话），防止无限驻留

function buildModelHintSignature(options = {}) {
  const selected = typeof options?.selectedModel === 'string' ? options.selectedModel.trim().toLowerCase() : '';
  const fallback = typeof options?.fallbackModel === 'string' ? options.fallbackModel.trim().toLowerCase() : '';
  return `${selected}|${fallback}`;
}

export function getBackendCachedSnapshot(normCid, now = Date.now(), options = {}) {
  if (!normCid) return null;
  const cached = memoryCache.get(normCid);
  if (!cached) return null;
  const modelSig = typeof options === 'string' ? options : buildModelHintSignature(options);
  if (now - cached.time < MEMORY_CACHE_TTL && (cached.modelSig ?? '|') === modelSig) {
    // 命中刷新 LRU 顺序
    memoryCache.delete(normCid);
    memoryCache.set(normCid, cached);
    return cached.result;
  }
  memoryCache.delete(normCid);
  return null;
}

export function setBackendCachedSnapshot(normCid, result, now = Date.now(), options = {}) {
  if (!normCid || !result) return;
  const modelSig = typeof options === 'string' ? options : buildModelHintSignature(options);
  if (memoryCache.has(normCid)) {
    memoryCache.delete(normCid);
  } else if (memoryCache.size >= MAX_MEMORY_CACHE_SIZE) {
    // 优先清理已过期的条目
    for (const [k, v] of memoryCache.entries()) {
      if (now - v.time >= MEMORY_CACHE_TTL) {
        memoryCache.delete(k);
      }
    }
    // 若仍达上限，按 LRU 淘汰最久未访问的会话
    if (memoryCache.size >= MAX_MEMORY_CACHE_SIZE) {
      const oldestKey = memoryCache.keys().next().value;
      if (oldestKey !== undefined) {
        memoryCache.delete(oldestKey);
      }
    }
  }
  memoryCache.set(normCid, { result, time: now, modelSig });
}

function formatK(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return '0K';
  const k = tokens / 1000;
  return `${k.toFixed(1)}K`;
}

/**
 * 格式化输出给 UI 的极简上下文数据模型
 */
export function formatContextResult(calc) {
  if (!calc || !calc.ready) {
    return {
      ready: false,
      used: 0,
      limit: 256_000,
      ratio: 0,
      usedK: '—',
      limitK: '—',
      percent: '—',
      tooltip: '暂无上下文数据',
      isEstimated: false,
      source: 'none',
      compressionDetected: false,
      compressionDrop: 0,
      isOverLimit: false,
      selectedModel: '',
      executionModel: '',
      checkpointModel: '',
      stepCount: 0,
      lastStepIndex: -1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      isUnknownModel: false,
      isTruncated: false,
      isWindowed: false,
      totalSteps: 0,
      windowStartStep: 0,
    };
  }

  const ratio = Math.min(Math.max(calc.usageRatio || 0, 0), 1);
  const percentNum = (ratio * 100).toFixed(1);
  const usedK = formatK(calc.contextUsed);
  const limitK = formatK(calc.contextLimit);

  // 严格按危害等级排序：平台截断超限 (>=100%) > 临界告警 (>=90%) > 历史上下文压缩 > 步数超长截断 > 未知模型提示
  let tooltip = `${percentNum}% · ${usedK} / ${limitK} 上下文已使用`;
  if (calc.isOverLimit || ratio >= 1) {
    const compressSuffix = calc.compressionDetected ? ` 曾压缩 ${formatK(calc.compressionDrop || 0)}` : '';
    tooltip = `${percentNum}% · ${usedK} / ${limitK} 已达截断阈值${compressSuffix}`;
  } else if (ratio >= 0.90) {
    const compressSuffix = calc.compressionDetected ? ` 曾压缩 ${formatK(calc.compressionDrop || 0)}` : '';
    tooltip = `${percentNum}% · ${usedK} / ${limitK} 接近截断${compressSuffix}`;
  } else if (calc.compressionDetected) {
    const dropK = formatK(calc.compressionDrop || 0);
    tooltip = `${percentNum}% · ${usedK} / ${limitK} 上下文已压缩 释放 ${dropK}`;
  } else if (calc.isTruncated && !calc.isWindowed) {
    tooltip = `${percentNum}% · ${usedK} / ${limitK} 会话数据不完整`;
  } else if (calc.isUnknownModel) {
    tooltip = `${percentNum}% · ${usedK} / ${limitK} 未知模型限制 默认256K`;
  }
  if (calc.isWindowed) {
    tooltip += ` · 长会话尾部 ${calc.stepCount}/${calc.totalSteps} 步`;
  }

  return {
    ready: true,
    used: calc.contextUsed,
    limit: calc.contextLimit,
    ratio,
    usedK,
    limitK,
    percent: `${percentNum}%`,
    tooltip,
    isEstimated: calc.isEstimated,
    source: calc.source || 'ls-rpc',
    compressionDetected: calc.compressionDetected,
    compressionDrop: calc.compressionDrop,
    isOverLimit: !!calc.isOverLimit,
    selectedModel: calc.selectedModel || calc.model || '',
    executionModel: calc.executionModel || '',
    checkpointModel: calc.checkpointModel || '',
    stepCount: calc.stepCount || 0,
    lastStepIndex: calc.lastStepIndex ?? -1,
    inputTokens: calc.inputTokens || 0,
    outputTokens: calc.outputTokens || 0,
    cacheReadTokens: calc.cacheReadTokens || 0,
    cacheCreationTokens: calc.cacheCreationTokens || 0,
    isUnknownModel: !!calc.isUnknownModel,
    isTruncated: !!calc.isTruncated,
    isWindowed: !!calc.isWindowed,
    totalSteps: calc.totalSteps || calc.stepCount || 0,
    windowStartStep: calc.windowStartStep || 0,
  };
}

/**
 * 提取轻量 step 指纹，用于跨页首步比对与重复熔断
 * 优先 s?.metadata?.modelApiContentId，次选 s?.stepIndex / s?.id / 复合字符串
 */
export function getStepFingerprint(s) {
  if (!s || typeof s !== 'object') return String(s);
  const meta = s.metadata;
  if (meta?.modelApiContentId !== undefined && meta?.modelApiContentId !== null && meta.modelApiContentId !== '') {
    return `content:${meta.modelApiContentId}`;
  }
  if (s.stepIndex !== undefined && s.stepIndex !== null && s.stepIndex !== '') {
    return `idx:${s.stepIndex}`;
  }
  if (s.id !== undefined && s.id !== null && s.id !== '') {
    return `id:${s.id}`;
  }
  // 复合字符串提取（涵盖时间戳、步骤类型、用户输入、Planner文本/思考/工具调用、Token指标等）
  const type = s.type || '';
  const created = (meta?.createdAt !== undefined && meta?.createdAt !== null && meta.createdAt !== '') ? meta.createdAt : '';
  const text = s.userInput?.userResponse ||
               s.plannerResponse?.response ||
               s.plannerResponse?.thinking ||
               '';
  let toolPart = '';
  if (Array.isArray(s.plannerResponse?.toolCalls) && s.plannerResponse.toolCalls.length > 0) {
    toolPart = s.plannerResponse.toolCalls
      .map(tc => `${tc?.name || ''}:${(tc?.argumentsJson || '').slice(0, 30)}`)
      .join(';');
  }
  let metaPart = '';
  if (meta?.toolCallOutputTokens != null) {
    metaPart += `:toolOut=${meta.toolCallOutputTokens}`;
  }
  if (meta?.modelUsage) {
    metaPart += `:usage=${meta.modelUsage.inputTokens || 0}+${meta.modelUsage.outputTokens || 0}`;
  }

  if (created || text || toolPart || metaPart) {
    return `comp:${created}|${type}|${text.slice(0, 60)}|${toolPart.slice(0, 60)}${metaPart}`;
  }

  // 针对无特异字段的对象，安全 JSON 序列化（带 WeakSet 防范循环引用）
  try {
    const seen = new WeakSet();
    const jsonStr = JSON.stringify(s, (k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    });
    return `json:${type}_${jsonStr.slice(0, 120)}`;
  } catch {
    const keys = Object.keys(s).sort().join(',');
    return `obj:${type}_${keys}`;
  }
}

/**
 * 带单次重连自愈的 RPC 调用封装（配合 ls-discovery 乐观缓存）
 */
async function rpcCallWithRetry(lsRef, method, params, timeoutMs) {
  try {
    return await rpcCall(lsRef.current, method, params, timeoutMs);
  } catch (err) {
    const refreshedLs = await discoverLanguageServer(true);
    if (!refreshedLs) throw err;
    lsRef.current = refreshedLs;
    return await rpcCall(lsRef.current, method, params, timeoutMs);
  }
}

/**
 * 获取指定会话的上下文监控快照
 * @param {string|null} conversationId - 当前活跃输入框所处的会话 ID
 * @param {boolean} [force=false] - 是否强制穿透 8s 内存短时缓存，获取最新轨迹
 * @param {Object} [options={}] - 可选配置（如 selectedModel、fallbackModel 等）
 * @returns {Promise<Object>}
 */
export async function getContextSnapshot(conversationId = null, force = false, options = {}) {
  const normCid = conversationId ? conversationId.toLowerCase() : null;
  const modelSig = buildModelHintSignature(options);
  const now = Date.now();
  if (normCid && !force) {
    const hit = getBackendCachedSnapshot(normCid, now, modelSig);
    if (hit) return hit;
  }

  try {
    const initialLs = options._ls || (await discoverLanguageServer(false));
    if (!initialLs) {
      return formatContextResult({ ready: false });
    }
    const lsRef = { current: initialLs };
    const rpcCaller = options._rpcCall || ((target, method, params, timeout) => rpcCallWithRetry(target, method, params, timeout));

    let targetCascadeId = conversationId;

    // 如果前端未提供有效 conversationId，则 fallback 查询最新活跃轨迹
    if (!targetCascadeId) {
      const resp = await rpcCaller(lsRef, 'GetAllCascadeTrajectories', {
        metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
      }, 4000);
      const summaries = resp?.trajectorySummaries || {};
      const entries = Object.entries(summaries);
      if (entries.length > 0) {
        entries.sort((a, b) => {
          const tA = a[1]?.lastModifiedTime || '';
          const tB = b[1]?.lastModifiedTime || '';
          return tB.localeCompare(tA);
        });
        targetCascadeId = entries[0][0];
      }
    }

    if (!targetCascadeId) {
      return formatContextResult({ ready: false });
    }

    // Fallback 解析出 targetCascadeId 后，二次检查内存缓存避免重复全量拉取
    const resolvedNormCid = targetCascadeId.toLowerCase();
    if (!normCid && !force) {
      const hit = getBackendCachedSnapshot(resolvedNormCid, Date.now(), modelSig);
      if (hit) return hit;
    }

    // 固定 1000 步等长分页。常规会话完整读取；超长会话仅读取最新尾部窗口，
    // 避免“只分析最早 5000 步、最新 Checkpoint 永远看不到”的失真。
    const PAGE_SIZE = 1000;
    const MAX_PREFIX_PAGES = 5;
    const MAX_PREFIX_STEPS = PAGE_SIZE * MAX_PREFIX_PAGES;
    const TAIL_WINDOW_STEPS = 5000;
    const seenStepKeys = new Set();
    const prefixSteps = [];
    let startIndex = 0;
    let prefixPageFullAtCap = false;

    const appendPageSteps = (pageSteps, pageStartIndex, target = prefixSteps) => {
      let addedInPage = 0;
      const pageFingerprintCounts = new Map();
      for (let sIdx = 0; sIdx < pageSteps.length; sIdx++) {
        const s = pageSteps[sIdx];
        // 第三道防线（严防跨页首步碰撞与重复熔断）：
        // 优先显式唯一键；若无显式 ID，采用复合指纹 + 页内频次计数（occurrence）。
        let stepKey;
        const rawExplicit = s ? (s.stepIndex ?? s.id ?? s.metadata?.modelApiContentId) : null;
        const explicitKey = (rawExplicit !== undefined && rawExplicit !== null && rawExplicit !== '') ? rawExplicit : null;
        if (explicitKey != null) {
          stepKey = String(explicitKey);
        } else {
          const fp = getStepFingerprint(s);
          const count = pageFingerprintCounts.get(fp) || 0;
          pageFingerprintCounts.set(fp, count + 1);
          stepKey = `${fp}#${count}`;
        }

        if (!seenStepKeys.has(stepKey)) {
          seenStepKeys.add(stepKey);
          target.push(s);
          addedInPage++;
        }
      }
      return addedInPage;
    };

    const fetchPage = async (pageStart) => {
      const stepsResp = await rpcCaller(lsRef, 'GetCascadeTrajectorySteps', {
        cascadeId: targetCascadeId,
        startIndex: pageStart,
        endIndex: pageStart + PAGE_SIZE
      }, 8000);
      return Array.isArray(stepsResp?.steps) ? stepsResp.steps : [];
    };

    for (let page = 0; page < MAX_PREFIX_PAGES; page++) {
      const pageSteps = await fetchPage(startIndex);
      if (pageSteps.length === 0) break;

      const addedInPage = appendPageSteps(pageSteps, startIndex);
      if (addedInPage === 0) break;
      if (page === 0 && pageSteps.length > PAGE_SIZE) break;
      if (pageSteps.length < PAGE_SIZE) break;

      if (page === MAX_PREFIX_PAGES - 1) {
        prefixPageFullAtCap = true;
        break;
      }
      startIndex += pageSteps.length;
    }

    let analysisSteps = prefixSteps;
    let isTruncated = false;
    let isWindowed = false;
    let totalSteps = prefixSteps.length;
    let windowStartStep = 0;

    if (prefixSteps.length === MAX_PREFIX_STEPS && prefixPageFullAtCap) {
      // 单步前瞻只用于区分“恰好 5000 步”与“超过 5000 步”，不把 5001 当作粗略截断证据。
      const boundaryProbe = await fetchPage(MAX_PREFIX_STEPS);
      if (boundaryProbe.length === 0) {
        totalSteps = MAX_PREFIX_STEPS;
      } else {
        let authoritativeTotal = null;
        try {
          const summariesResp = await rpcCaller(lsRef, 'GetAllCascadeTrajectories', {
            metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
          }, 4000);
          const summaries = summariesResp?.trajectorySummaries || {};
          const summary = summaries[targetCascadeId] ||
            Object.entries(summaries).find(([cid]) => cid.toLowerCase() === targetCascadeId.toLowerCase())?.[1];
          const rawTotal = summary?.stepCount;
          const parsedTotal = (typeof rawTotal === 'number' || typeof rawTotal === 'string') ? Number(rawTotal) : NaN;
          if (Number.isSafeInteger(parsedTotal) && parsedTotal > MAX_PREFIX_STEPS) {
            authoritativeTotal = parsedTotal;
          }
        } catch {}

        if (authoritativeTotal !== null) {
          totalSteps = authoritativeTotal;
          const tailStart = Math.max(0, totalSteps - TAIL_WINDOW_STEPS);

          // 离尾部不足 5000 步时，前缀与尾部会重叠：按真实步号合并去重，避免重复计算。
          const indexed = new Map();
          const putIndexed = (step, fallbackIndex) => {
            const actual = (Number.isSafeInteger(step?.stepIndex) && step.stepIndex >= 0)
              ? step.stepIndex
              : fallbackIndex;
            if (actual >= tailStart && actual < totalSteps && !indexed.has(actual)) {
              indexed.set(actual, step);
            }
          };
          prefixSteps.forEach((step, i) => putIndexed(step, i));
          boundaryProbe.forEach((step, i) => putIndexed(step, MAX_PREFIX_STEPS + i));

          let tailCursor = Math.max(MAX_PREFIX_STEPS, tailStart);
          while (tailCursor < totalSteps) {
            const pageSteps = await fetchPage(tailCursor);
            if (pageSteps.length === 0) break;
            pageSteps.forEach((step, i) => putIndexed(step, tailCursor + i));
            tailCursor += pageSteps.length;
            if (pageSteps.length < PAGE_SIZE) break;
          }

          analysisSteps = Array.from(indexed.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, step]) => step);
          windowStartStep = tailStart;
          isWindowed = analysisSteps.length < totalSteps;
          isTruncated = isWindowed;
        } else {
          // 无法取得权威总步数时，明确标记为客户端窗口，不伪装成完整轨迹。
          totalSteps = Math.max(MAX_PREFIX_STEPS + boundaryProbe.length, MAX_PREFIX_STEPS);
          windowStartStep = 0;
          isWindowed = true;
          isTruncated = true;
        }
      }
    }

    const calcOptions = {
      ...options,
      isTruncated,
      isWindowed,
      totalSteps,
      windowStartStep,
    };
    const calc = processTrajectorySteps(analysisSteps, calcOptions);
    const result = formatContextResult(calc);
    if (result && result.ready) {
      result.cid = targetCascadeId;
      result.conversationId = targetCascadeId;
      setBackendCachedSnapshot(resolvedNormCid, result, Date.now(), modelSig);
    }
    return result;
  } catch (error) {
    return formatContextResult({ ready: false });
  }
}

/**
 * 导出内存短时缓存诊断辅助（仅供测试或调试）
 */
export function _getMemoryCacheInfo() {
  return {
    size: memoryCache.size,
    maxSize: MAX_MEMORY_CACHE_SIZE,
    has: (cid) => cid ? memoryCache.has(cid.toLowerCase()) : false,
    clear: () => memoryCache.clear()
  };
}
