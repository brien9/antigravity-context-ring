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
  } else if (calc.isTruncated) {
    tooltip = `${percentNum}% · ${usedK} / ${limitK} 会话超长已截断`;
  } else if (calc.isUnknownModel) {
    tooltip = `${percentNum}% · ${usedK} / ${limitK} 未知模型限制 默认256K`;
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
  };
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
    const initialLs = await discoverLanguageServer(false);
    if (!initialLs) {
      return formatContextResult({ ready: false });
    }
    const lsRef = { current: initialLs };

    let targetCascadeId = conversationId;

    // 如果前端未提供有效 conversationId，则 fallback 查询最新活跃轨迹
    if (!targetCascadeId) {
      const resp = await rpcCallWithRetry(lsRef, 'GetAllCascadeTrajectories', {
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

    // 分页循环抓取该会话的所有步骤，消除 1000 步截断盲区
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 5; // 单会话 5000 步安全熔断硬顶
    const allSteps = [];
    const seenStepKeys = new Set();
    let startIndex = 0;
    let isTruncated = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const stepsResp = await rpcCallWithRetry(lsRef, 'GetCascadeTrajectorySteps', {
        cascadeId: targetCascadeId,
        startIndex,
        endIndex: startIndex + PAGE_SIZE
      }, 8000);

      const pageSteps = Array.isArray(stepsResp?.steps) ? stepsResp.steps : [];
      if (pageSteps.length === 0) {
        break;
      }
      for (let sIdx = 0; sIdx < pageSteps.length; sIdx++) {
        const s = pageSteps[sIdx];
        const stepKey = (s && (s.stepIndex ?? s.id)) ?? (startIndex + sIdx);
        if (!seenStepKeys.has(stepKey)) {
          seenStepKeys.add(stepKey);
          allSteps.push(s);
        }
      }
      if (pageSteps.length < PAGE_SIZE) {
        break;
      }
      if (page === MAX_PAGES - 1) {
        isTruncated = true;
      }
      startIndex += pageSteps.length;
    }

    const calcOptions = { ...options, isTruncated };
    const calc = processTrajectorySteps(allSteps, calcOptions);
    const result = formatContextResult(calc);
    if (result && result.ready) {
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
