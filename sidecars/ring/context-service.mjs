import { discoverLanguageServer, discoverAllLanguageServers } from './ls-discovery.mjs';
import { rpcCall, isRetryableRpcError } from './rpc-client.mjs';
import { processTrajectorySteps } from './context-calculator.mjs';

const memoryCache = new Map();
const MEMORY_CACHE_TTL = 8000; // 8秒内存瞬时命中缓存，杜绝重复RPC冲刷
const MAX_MEMORY_CACHE_SIZE = 50; // 对齐前端一级内存缓存上限（50个会话），防止无限驻留

// 会话级轨迹增量缓存 (Incremental Trajectory Cache)
// 只有可见分屏的活跃会话才会频繁刷新，容量取小值即可；每会话最多驻留 5000 个瘦身后的步骤
const trajectoryCache = new Map();
const MAX_TRAJECTORY_CACHE_SIZE = 50;

// 会话与语言服务器实例绑定映射 (Session-to-LanguageServer Binding)
const sessionLsBindings = new Map();
const MAX_SESSION_BINDINGS = 100;

function normalizeCacheCid(normCid) {
  if (!normCid) return '';
  return typeof normCid === 'string' ? normCid.toLowerCase() : String(normCid).toLowerCase();
}

export function getSessionLsBinding(normCid) {
  const key = normalizeCacheCid(normCid);
  if (!key) return null;
  return sessionLsBindings.get(key) || null;
}

export function setSessionLsBinding(normCid, ls) {
  const key = normalizeCacheCid(normCid);
  if (!key || !ls) return;
  if (sessionLsBindings.has(key)) {
    sessionLsBindings.delete(key);
  } else if (sessionLsBindings.size >= MAX_SESSION_BINDINGS) {
    const oldest = sessionLsBindings.keys().next().value;
    if (oldest !== undefined) sessionLsBindings.delete(oldest);
  }
  sessionLsBindings.set(key, ls);
}

export function clearSessionLsBindings(normCid = null) {
  if (normCid) {
    const key = normalizeCacheCid(normCid);
    if (key) sessionLsBindings.delete(key);
  } else {
    sessionLsBindings.clear();
  }
}

export function is404RpcError(err) {
  if (!err) return false;
  if (err.statusCode === 404 || err.code === 404) return true;
  if (err.code === 'not_found' || err.code === 'NOT_FOUND') return true;
  if (typeof err.message === 'string' && (/404/i.test(err.message) || /not[-_ ]?found/i.test(err.message))) {
    return true;
  }
  return false;
}

export function getBackendTrajectoryCache(normCid) {
  const key = normalizeCacheCid(normCid);
  if (!key) return null;
  return trajectoryCache.get(key) || null;
}

export function clearBackendTrajectoryCache(normCid = null) {
  if (normCid) {
    const key = normalizeCacheCid(normCid);
    if (key) trajectoryCache.delete(key);
  } else {
    trajectoryCache.clear();
  }
}

export function setBackendTrajectoryCache(normCid, entry) {
  const key = normalizeCacheCid(normCid);
  if (!key || !entry) return;
  if (trajectoryCache.has(key)) {
    trajectoryCache.delete(key);
  } else if (trajectoryCache.size >= MAX_TRAJECTORY_CACHE_SIZE) {
    const oldestKey = trajectoryCache.keys().next().value;
    if (oldestKey !== undefined) {
      trajectoryCache.delete(oldestKey);
    }
  }
  trajectoryCache.set(key, entry);
}

export function _getTrajectoryCacheInfo() {
  return {
    size: trajectoryCache.size,
    maxSize: MAX_TRAJECTORY_CACHE_SIZE,
    has: (cid) => cid ? trajectoryCache.has(normalizeCacheCid(cid)) : false,
    clear: () => trajectoryCache.clear()
  };
}

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
 * 提取深层内容签名，用于历史回退/重写比对
 */
export function getStepContentSignature(s) {
  if (!s || typeof s !== 'object') return String(s);
  const meta = s.metadata;
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
  return `${type}|${created}|${text.slice(0, 80)}|${toolPart}|${metaPart}`;
}

/**
 * 提取唯一 stepKey，优先显式唯一键，次选复合指纹
 */
export function extractStepKey(s, occurrence = 0) {
  if (!s || typeof s !== 'object') return String(s);
  const rawExplicit = s.stepIndex ?? s.id ?? s.metadata?.modelApiContentId;
  if (rawExplicit !== undefined && rawExplicit !== null && rawExplicit !== '') {
    return String(rawExplicit);
  }
  const fp = getStepFingerprint(s);
  return `${fp}#${occurrence}`;
}

/**
 * 步骤稳定身份（仅含生成后不再变化的字段）：用于增量拼接的连续性校验。
 * 刻意排除 response/thinking/modelUsage/toolCallOutputTokens 等流式生成过程中会持续变化的字段，
 * 否则正在生成的尾步每次轮询都会被误判为“历史被改写”，导致增量缓存在活跃回合几乎永远回退全量。
 * 历史回退/重写会产生新的 createdAt，因此仍可被识别。
 */
export function getStableStepIdentity(s) {
  if (!s || typeof s !== 'object') return String(s);
  const meta = s.metadata;
  const explicit = s.stepIndex ?? s.id ?? meta?.modelApiContentId ?? '';
  const created = meta?.createdAt ?? '';
  return `${explicit}|${s.type || ''}|${created}`;
}

const pickDefined = (src, keys) => {
  const out = {};
  let has = false;
  for (const k of keys) {
    if (src[k] !== undefined) {
      out[k] = src[k];
      has = true;
    }
  }
  return has ? out : null;
};

/**
 * 步骤瘦身投影：只保留上下文计算、指纹去重与连续性校验实际读取的字段。
 * 工具结果类步骤可能携带数十 KB 的文件内容/命令输出，增量缓存若原样驻留
 * （最多 N 个会话 × 5000 步）会让 Sidecar 内存膨胀到数百 MB。
 * 对完全不含已知字段的异常对象保持原样，避免指纹退化碰撞。
 */
export function projectStep(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  let known = false;
  for (const k of ['type', 'stepIndex', 'id']) {
    if (s[k] !== undefined) {
      out[k] = s[k];
      known = true;
    }
  }
  const meta = s.metadata;
  if (meta && typeof meta === 'object') {
    const m = pickDefined(meta, ['generatorModel', 'toolCallOutputTokens', 'modelUsage', 'modelApiContentId', 'createdAt']);
    const pm = m || {};
    if (meta.requestedModel && typeof meta.requestedModel === 'object') {
      pm.requestedModel = { model: meta.requestedModel.model };
    }
    if (m || pm.requestedModel) {
      out.metadata = pm;
      known = true;
    }
  }
  const ui = s.userInput;
  if (ui && typeof ui === 'object') {
    const u = {};
    if (ui.userResponse !== undefined) u.userResponse = ui.userResponse;
    const pc = ui.userConfig?.plannerConfig;
    if (pc && typeof pc === 'object') {
      u.userConfig = { plannerConfig: { planModel: pc.planModel, modelName: pc.modelName } };
    }
    out.userInput = u;
    known = true;
  }
  const pr = s.plannerResponse;
  if (pr && typeof pr === 'object') {
    const p = pickDefined(pr, ['response', 'thinking']) || {};
    if (Array.isArray(pr.toolCalls)) {
      p.toolCalls = pr.toolCalls.map(tc => (tc && typeof tc === 'object')
        ? { name: tc.name, argumentsJson: tc.argumentsJson }
        : tc);
    }
    out.plannerResponse = p;
    known = true;
  }
  return known ? out : s;
}

/**
 * 带单次重连自愈的 RPC 调用封装（配合 ls-discovery 乐观缓存）
 * 仅连接级故障或 CSRF 鉴权失败才强制重新发现，业务错误（如 404 会话不存在）直接抛出，
 * 避免每次轮询都拉起 PowerShell/netstat 全量扫描却依然失败的空转。
 * @param {Object} [deps] - 可注入依赖（仅供测试）：{ rpcCall, discoverLanguageServer }
 */
export async function rpcCallWithRetry(lsRef, method, params, timeoutMs, deps = {}) {
  const call = deps.rpcCall || rpcCall;
  const discover = deps.discoverLanguageServer || discoverLanguageServer;
  try {
    return await call(lsRef.current, method, params, timeoutMs);
  } catch (err) {
    if (!isRetryableRpcError(err)) throw err;
    const refreshedLs = await discover(true);
    if (!refreshedLs) {
      err.discoveryExhausted = true;
      lsRef.current = null;
      throw err;
    }
    lsRef.current = refreshedLs;
    return await call(lsRef.current, method, params, timeoutMs);
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
  let resolvedNormCid = conversationId ? conversationId.toLowerCase() : null;
  const normCid = resolvedNormCid;
  const modelSig = buildModelHintSignature(options);
  const now = Date.now();
  if (normCid && !force) {
    const hit = getBackendCachedSnapshot(normCid, now, modelSig);
    if (hit) return hit;
  }

  try {
    const boundLs = normCid ? getSessionLsBinding(normCid) : null;
    const initialLs = options._ls || boundLs || (await discoverLanguageServer(false));
    if (!initialLs) {
      if (resolvedNormCid) clearSessionLsBindings(resolvedNormCid);
      return formatContextResult({ ready: false });
    }
    const lsRef = { current: initialLs };
    const rpcCaller = (target, method, params, timeout) => {
      if (options._discoverLanguageServer) {
        return rpcCallWithRetry(target, method, params, timeout, {
          rpcCall: options._rpcCall,
          discoverLanguageServer: options._discoverLanguageServer
        });
      }
      if (options._rpcCall) {
        return options._rpcCall(target, method, params, timeout);
      }
      return rpcCallWithRetry(target, method, params, timeout);
    };

    const getAlternativeServers = async (currentLs) => {
      let all = options._allLs;
      if (!all) {
        const discoverAll = options._discoverAllLanguageServers || discoverAllLanguageServers;
        // 只读 60s 发现缓存，绝不强制刷新：单 LS 环境下若此处 force，查不到的会话每次轮询都会
        // 拉起 PowerShell + netstat 全量扫描（等同于问题 2 的空转风暴）。新 LS 由缓存过期自然纳入。
        all = await discoverAll(false);
      }
      if (!Array.isArray(all)) return [];
      const seenPorts = new Set();
      if (currentLs?.port) seenPorts.add(currentLs.port);
      const uniqueAlts = [];
      for (const s of all) {
        if (!s || !s.port) continue;
        if (!seenPorts.has(s.port)) {
          seenPorts.add(s.port);
          uniqueAlts.push(s);
        }
      }
      return uniqueAlts;
    };

    let targetCascadeId = conversationId;

    // 如果前端未提供有效 conversationId，则 fallback 查询最新活跃轨迹
    if (!targetCascadeId) {
      let resp = null;
      try {
        resp = await rpcCaller(lsRef, 'GetAllCascadeTrajectories', {
          metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
        }, 4000);
      } catch (err) {
        if (!is404RpcError(err) && !isRetryableRpcError(err)) {
          // 静默容错，后续尝试备选 LS
        }
      }
      let summaries = resp?.trajectorySummaries || {};
      let entries = Object.entries(summaries);

      // 如果当前 LS 没有轨迹，自动尝试备选存活 LS
      if (entries.length === 0) {
        const altServers = await getAlternativeServers(lsRef.current);
        for (const altLs of altServers) {
          try {
            const altRef = { current: altLs };
            const altResp = await rpcCaller(altRef, 'GetAllCascadeTrajectories', {
              metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
            }, 4000);
            const altSummaries = altResp?.trajectorySummaries || {};
            const altEntries = Object.entries(altSummaries);
            if (altEntries.length > 0) {
              lsRef.current = altLs;
              entries = altEntries;
              break;
            }
          } catch {}
        }
      }

      if (entries.length > 0) {
        entries.sort((a, b) => {
          const tA = a[1]?.lastModifiedTime || '';
          const tB = b[1]?.lastModifiedTime || '';
          return tB.localeCompare(tA);
        });
        targetCascadeId = entries[0][0];
        resolvedNormCid = targetCascadeId.toLowerCase();
        setSessionLsBinding(resolvedNormCid, lsRef.current);
      }
    }

    if (!targetCascadeId) {
      return formatContextResult({ ready: false });
    }

    // Fallback 解析出 targetCascadeId 后，二次检查内存缓存避免重复全量拉取
    resolvedNormCid = targetCascadeId.toLowerCase();
    if (!normCid && !force) {
      const hit = getBackendCachedSnapshot(resolvedNormCid, Date.now(), modelSig);
      if (hit) return hit;
    }

    const cachedTraj = getBackendTrajectoryCache(resolvedNormCid);

    // 固定 1000 步等长分页。常规会话完整读取；超长会话仅读取最新尾部窗口，
    // 避免“只分析最早 5000 步、最新 Checkpoint 永远看不到”的失真。
    const PAGE_SIZE = 1000;
    const MAX_PREFIX_PAGES = 5;
    const MAX_PREFIX_STEPS = PAGE_SIZE * MAX_PREFIX_PAGES;
    const TAIL_WINDOW_STEPS = 5000;

    const fetchPage = async (pageStart) => {
      const stepsResp = await rpcCaller(lsRef, 'GetCascadeTrajectorySteps', {
        cascadeId: targetCascadeId,
        startIndex: pageStart,
        endIndex: pageStart + PAGE_SIZE
      }, 8000);
      return Array.isArray(stepsResp?.steps) ? stepsResp.steps : [];
    };

    // 全量拉取执行器（冷启动或增量守卫失效回退时调用）
    const executeFullFetch = async () => {
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

      for (let page = 0; page < MAX_PREFIX_PAGES; page++) {
        let pageSteps = [];
        if (page === 0) {
          let needsFallback = false;
          try {
            pageSteps = await fetchPage(startIndex);
            if (!pageSteps || pageSteps.length === 0) {
              needsFallback = true;
            }
          } catch (fetchErr) {
            if (is404RpcError(fetchErr) || isRetryableRpcError(fetchErr)) {
              needsFallback = true;
            } else {
              throw fetchErr;
            }
          }

          if (needsFallback) {
            const altServers = await getAlternativeServers(lsRef.current);
            for (const altLs of altServers) {
              try {
                const altRef = { current: altLs };
                const altResp = await rpcCaller(altRef, 'GetCascadeTrajectorySteps', {
                  cascadeId: targetCascadeId,
                  startIndex: 0,
                  endIndex: PAGE_SIZE
                }, 8000);
                const altSteps = Array.isArray(altResp?.steps) ? altResp.steps : [];
                if (altSteps.length > 0) {
                  lsRef.current = altLs;
                  setSessionLsBinding(resolvedNormCid, altLs);
                  pageSteps = altSteps;
                  needsFallback = false;
                  break;
                } else {
                  try {
                    const sumResp = await rpcCaller(altRef, 'GetAllCascadeTrajectories', {
                      metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
                    }, 4000);
                    const altSums = sumResp?.trajectorySummaries || {};
                    if (altSums[targetCascadeId] || Object.keys(altSums).some(k => k.toLowerCase() === resolvedNormCid)) {
                      lsRef.current = altLs;
                      setSessionLsBinding(resolvedNormCid, altLs);
                      pageSteps = altSteps;
                      needsFallback = false;
                      break;
                    }
                  } catch {}
                }
              } catch {}
            }
            if (needsFallback) {
              clearSessionLsBindings(resolvedNormCid);
            }
          }
        } else {
          pageSteps = await fetchPage(startIndex);
        }

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
      let allSteps = [...prefixSteps];

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

            // 修复 tailStart <= 5000 时的重叠分页拉取逻辑：
            // boundaryProbe 已经拉取了 MAX_PREFIX_STEPS 到 MAX_PREFIX_STEPS + boundaryProbe.length，
            // 故尾部拉取游标必须从已拉取步数与 tailStart 的较大值开始，杜绝第 5000 步附近重复拉取！
            let tailCursor = Math.max(MAX_PREFIX_STEPS + boundaryProbe.length, tailStart);
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
            allSteps = analysisSteps;
          } else {
            // 无法取得权威总步数时，明确标记为客户端窗口，不伪装成完整轨迹。
            totalSteps = Math.max(MAX_PREFIX_STEPS + boundaryProbe.length, MAX_PREFIX_STEPS);
            if (boundaryProbe.length > 0) {
              analysisSteps = prefixSteps.concat(boundaryProbe);
              allSteps = analysisSteps;
            }
            windowStartStep = 0;
            isWindowed = true;
            isTruncated = true;
          }
        }
      }

      // 去重完成后统一瘦身，缓存与计算只持有必要字段（计算结果与原始对象完全一致）。
      // 全量路径下 allSteps 与 analysisSteps 内容恒等，共享同一份投影数组避免双份驻留。
      analysisSteps = analysisSteps.map(projectStep);
      allSteps = analysisSteps;

      const calcOptions = {
        ...options,
        isTruncated,
        isWindowed,
        totalSteps,
        windowStartStep,
        initialCompressionDetected: isWindowed ? (cachedTraj?.compressionDetected || false) : false,
        initialCompressionDrop: isWindowed ? (cachedTraj?.compressionDrop || 0) : 0,
      };
      const calc = processTrajectorySteps(analysisSteps, calcOptions);
      const result = formatContextResult(calc);
      if (result && result.ready) {
        result.cid = targetCascadeId;
        result.conversationId = targetCascadeId;
        setBackendCachedSnapshot(resolvedNormCid, result, Date.now(), modelSig);
        setBackendTrajectoryCache(resolvedNormCid, {
          allSteps,
          analysisSteps,
          totalSteps,
          windowStartStep,
          isWindowed,
          isTruncated,
          contextUsed: result.used,
          lastStepIndex: result.lastStepIndex,
          compressionDetected: calc.compressionDetected || false,
          compressionDrop: calc.compressionDrop || 0,
          modelSig,
          time: Date.now()
        });
        setSessionLsBinding(resolvedNormCid, lsRef.current);
      }
      return result;
    };

    // 检查是否存在当前会话的增量轨迹缓存
    if (!cachedTraj || !Array.isArray(cachedTraj.allSteps) || cachedTraj.allSteps.length === 0) {
      return await executeFullFetch();
    }

    // 执行会话级轨迹增量缓存拉取
    try {
      const cachedSteps = cachedTraj.allSteps;
      const cachedCount = cachedSteps.length;
      const isWindowed = !!cachedTraj.isWindowed;
      const windowStartStep = cachedTraj.windowStartStep || 0;
      const previousTotal = isWindowed ? (cachedTraj.totalSteps || cachedCount) : cachedCount;

      // 计算起始页下标：对齐 1000 步整页边界，确保覆盖未满整页，并利用重叠步校验连续性
      let incrementalStart;
      if (!isWindowed) {
        incrementalStart = Math.floor(Math.max(0, cachedCount - 1) / PAGE_SIZE) * PAGE_SIZE;
      } else {
        incrementalStart = Math.floor(Math.max(0, previousTotal - 1) / PAGE_SIZE) * PAGE_SIZE;
        // 防线：如果窗口化缓存的起始偏移越界（无重叠或负偏移），说明窗口已脱节，必须回退全量
        if (incrementalStart < windowStartStep || incrementalStart > windowStartStep + cachedCount) {
          clearBackendTrajectoryCache(resolvedNormCid);
          return await executeFullFetch();
        }
      }

      const pageSteps = (await fetchPage(incrementalStart)).map(projectStep);

      // --- 守卫 1: 空数据检测（若原本应有步骤的页返回空，说明被删除或重置）---
      if (pageSteps.length === 0) {
        clearBackendTrajectoryCache(resolvedNormCid);
        return await executeFullFetch();
      }

      // --- 守卫 2: 步骤数量缩水检测（历史回退/rewind，全量覆盖非窗口与窗口化）---
      let currentEnd = incrementalStart + pageSteps.length;
      if (currentEnd < previousTotal) {
        clearBackendTrajectoryCache(resolvedNormCid);
        return await executeFullFetch();
      }

      // --- 守卫 3: 重叠步骤一致性比对（步号/唯一键/指纹/文本内容签名），识别历史回退后的原位重写与分叉 ---
      let overlapStartInCache = 0;
      let overlapCount = 0;
      if (!isWindowed) {
        overlapStartInCache = incrementalStart;
        overlapCount = Math.min(pageSteps.length, Math.max(0, cachedCount - incrementalStart));
      } else {
        const offsetInWindow = incrementalStart - windowStartStep;
        if (offsetInWindow < 0 || offsetInWindow > cachedCount) {
          clearBackendTrajectoryCache(resolvedNormCid);
          return await executeFullFetch();
        }
        overlapStartInCache = offsetInWindow;
        overlapCount = Math.min(pageSteps.length, Math.max(0, cachedCount - offsetInWindow));
      }

      for (let i = 0; i < overlapCount; i++) {
        const expectedStep = cachedSteps[overlapStartInCache + i];
        const actualStep = pageSteps[i];
        if (!expectedStep || !actualStep) continue;

        const isLatestCachedStep = (overlapStartInCache + i === cachedSteps.length - 1);
        if (isLatestCachedStep) {
          // 活跃尾步：模型流式生成或工具执行中，文本内容与 Token 会持续增长。
          // 解耦 extractStepKey，仅校验 getStableStepIdentity 连续性，允许流式文本与 Token 增长；
          // 若身份变更（如发生回退或编辑）则立即判定失效回退全量。
          if (getStableStepIdentity(expectedStep) !== getStableStepIdentity(actualStep)) {
            clearBackendTrajectoryCache(resolvedNormCid);
            return await executeFullFetch();
          }
        } else {
          // 历史已完成步骤：执行全量深度三重校验（键名、内容签名、指纹），严防中间篡改
          if (
            extractStepKey(expectedStep, i) !== extractStepKey(actualStep, i) ||
            getStepContentSignature(expectedStep) !== getStepContentSignature(actualStep) ||
            getStepFingerprint(expectedStep) !== getStepFingerprint(actualStep)
          ) {
            clearBackendTrajectoryCache(resolvedNormCid);
            return await executeFullFetch();
          }
        }
      }

      // --- 守卫 4: stepIndex 单调递增与连续性校验 ---
      const validatePageOrder = (steps) => {
        for (let i = 1; i < steps.length; i++) {
          const prev = steps[i - 1];
          const curr = steps[i];
          if (prev?.stepIndex != null && curr?.stepIndex != null) {
            if (curr.stepIndex <= prev.stepIndex) {
              return false;
            }
          }
        }
        return true;
      };

      if (!validatePageOrder(pageSteps)) {
        clearBackendTrajectoryCache(resolvedNormCid);
        return await executeFullFetch();
      }

      // 连续性校验通过：合并新步骤
      let updatedAllSteps;
      let newTotalSteps;
      let newWindowStartStep = 0;
      let newIsWindowed = false;
      let newIsTruncated = false;
      let analysisSteps;

      if (!isWindowed) {
        updatedAllSteps = cachedSteps.slice(0, incrementalStart).concat(pageSteps);
        currentEnd = incrementalStart + pageSteps.length;
        let lastPage = pageSteps;

        // 若当前页刚好满 1000 步，继续拉取后续新增页（直到不足整页或到达前缀上限）
        while (lastPage.length === PAGE_SIZE && currentEnd < MAX_PREFIX_STEPS) {
          const nextPage = (await fetchPage(currentEnd)).map(projectStep);
          if (nextPage.length === 0) break;
          if (!validatePageOrder(nextPage)) {
            clearBackendTrajectoryCache(resolvedNormCid);
            return await executeFullFetch();
          }
          const lastInPrev = updatedAllSteps[updatedAllSteps.length - 1];
          if (lastInPrev?.stepIndex != null && nextPage[0]?.stepIndex != null) {
            if (nextPage[0].stepIndex <= lastInPrev.stepIndex) {
              clearBackendTrajectoryCache(resolvedNormCid);
              return await executeFullFetch();
            }
          }
          for (const s of nextPage) updatedAllSteps.push(s);
          currentEnd += nextPage.length;
          lastPage = nextPage;
          if (nextPage.length < PAGE_SIZE) break;
        }

        newTotalSteps = updatedAllSteps.length;

        // 若步数达到或超过 MAX_PREFIX_STEPS (5000) 且最后一页满整页，
        // 进行前向探测 fetchPage(MAX_PREFIX_STEPS)，仅当探测返回 > 0 步时（确为超长会话）才清缓存并执行全量拉取；
        // 否则（恰好 5000 步）保留增量缓存，消除每回合强制全量拉取的抖动。
        if (newTotalSteps >= MAX_PREFIX_STEPS && lastPage.length === PAGE_SIZE) {
          const probeSteps = await fetchPage(MAX_PREFIX_STEPS);
          if (probeSteps.length > 0) {
            clearBackendTrajectoryCache(resolvedNormCid);
            return await executeFullFetch();
          } else {
            analysisSteps = updatedAllSteps;
            newWindowStartStep = 0;
            newIsWindowed = false;
            newIsTruncated = false;
          }
        } else {
          analysisSteps = updatedAllSteps;
          newWindowStartStep = 0;
          newIsWindowed = false;
          newIsTruncated = false;
        }
      } else {
        // 长会话已窗口化状态下的增量拼接
        const offsetInWindow = incrementalStart - windowStartStep;
        if (offsetInWindow < 0 || offsetInWindow > cachedSteps.length) {
          clearBackendTrajectoryCache(resolvedNormCid);
          return await executeFullFetch();
        }

        let merged = cachedSteps.slice(0, offsetInWindow).concat(pageSteps);
        currentEnd = incrementalStart + pageSteps.length;
        let lastPage = pageSteps;
        let catchupSteps = 0;
        const MAX_INCREMENTAL_CATCHUP_STEPS = MAX_PREFIX_STEPS;

        while (lastPage.length === PAGE_SIZE) {
          // 防御性熔断守卫：如果单次增量追赶已满上限且仍有满页，说明单次增量过大或服务端分页死循环异常
          // 主动清理缓存回退 executeFullFetch 走权威全量探针流程，绝不陷入理论无限循环
          if (catchupSteps >= MAX_INCREMENTAL_CATCHUP_STEPS) {
            clearBackendTrajectoryCache(resolvedNormCid);
            return await executeFullFetch();
          }

          const nextPage = (await fetchPage(currentEnd)).map(projectStep);
          if (nextPage.length === 0) break;
          if (!validatePageOrder(nextPage)) {
            clearBackendTrajectoryCache(resolvedNormCid);
            return await executeFullFetch();
          }
          const lastInPrev = merged[merged.length - 1];
          if (lastInPrev?.stepIndex != null && nextPage[0]?.stepIndex != null) {
            if (nextPage[0].stepIndex <= lastInPrev.stepIndex) {
              clearBackendTrajectoryCache(resolvedNormCid);
              return await executeFullFetch();
            }
          }
          for (const s of nextPage) merged.push(s);
          catchupSteps += nextPage.length;
          currentEnd += nextPage.length;
          lastPage = nextPage;
          if (nextPage.length < PAGE_SIZE) break;
        }

        if (currentEnd < previousTotal) {
          clearBackendTrajectoryCache(resolvedNormCid);
          return await executeFullFetch();
        }

        newTotalSteps = currentEnd;
        if (newTotalSteps < merged.length) newTotalSteps = merged.length;
        const tailStart = Math.max(0, newTotalSteps - TAIL_WINDOW_STEPS);
        if (merged.length > TAIL_WINDOW_STEPS) {
          analysisSteps = merged.slice(merged.length - TAIL_WINDOW_STEPS);
        } else {
          analysisSteps = merged;
        }
        updatedAllSteps = analysisSteps;
        newWindowStartStep = tailStart;
        newIsWindowed = true;
        newIsTruncated = true;
      }

      const calcOptions = {
        ...options,
        isTruncated: newIsTruncated,
        isWindowed: newIsWindowed,
        totalSteps: newTotalSteps,
        windowStartStep: newWindowStartStep,
        initialCompressionDetected: newIsWindowed ? (cachedTraj?.compressionDetected || false) : false,
        initialCompressionDrop: newIsWindowed ? (cachedTraj?.compressionDrop || 0) : 0,
      };
      const calc = processTrajectorySteps(analysisSteps, calcOptions);

      // --- 守卫 5: 大幅压缩/断裂检测 ---
      // 仅在首次检测到压缩或发生更深层大幅压缩（额外降幅 >= 15K）时才失效回退重锚定，
      // 避免会话曾发生压缩后永久退化为全量拉取的致命缺陷
      const isNewCompression = calc.compressionDetected && (
        !cachedTraj.compressionDetected ||
        (calc.compressionDrop || 0) > (cachedTraj.compressionDrop || 0) + 15000
      );
      if (isNewCompression) {
        clearBackendTrajectoryCache(resolvedNormCid);
        return await executeFullFetch();
      }

      const result = formatContextResult(calc);
      if (result && result.ready) {
        result.cid = targetCascadeId;
        result.conversationId = targetCascadeId;
        setBackendCachedSnapshot(resolvedNormCid, result, Date.now(), modelSig);
        setBackendTrajectoryCache(resolvedNormCid, {
          allSteps: updatedAllSteps,
          analysisSteps,
          totalSteps: newTotalSteps,
          windowStartStep: newWindowStartStep,
          isWindowed: newIsWindowed,
          isTruncated: newIsTruncated,
          contextUsed: result.used,
          lastStepIndex: result.lastStepIndex,
          compressionDetected: calc.compressionDetected || false,
          compressionDrop: calc.compressionDrop || 0,
          modelSig,
          time: Date.now()
        });
        setSessionLsBinding(resolvedNormCid, lsRef.current);
      }
      return result;
    } catch (incErr) {
      clearBackendTrajectoryCache(resolvedNormCid);
      if (incErr?.discoveryExhausted) {
        clearSessionLsBindings(resolvedNormCid);
        return formatContextResult({ ready: false });
      }
      return await executeFullFetch();
    }
  } catch (error) {
    if (resolvedNormCid) clearSessionLsBindings(resolvedNormCid);
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
    clear: () => {
      memoryCache.clear();
      trajectoryCache.clear();
      sessionLsBindings.clear();
    }
  };
}
