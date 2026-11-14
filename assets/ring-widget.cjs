// Antigravity 极简上下文圆环插件 - 前端注入组件
// 纯净内嵌于输入框模型选择器旁，Shadow DOM 隔离
// 遵循成熟 Harness (Codex/WorkBuddy/Cursor) 的 SWR 内存缓存与稳态渲染架构

// 使用安全闭包包裹核心数据结构与工具函数，支持热重注时无缝覆盖更新
var __agRingCacheModule = (function() {
  class MemoryLRUCache {
    constructor(maxSize = 50) {
      this.maxSize = maxSize;
      this.map = new Map();
    }
    get(key) {
      if (!this.map.has(key)) return null;
      const val = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, val);
      return val;
    }
    set(key, val, protectedKey = null) {
      const isProtected = (k) => {
        if (!protectedKey) return false;
        if (typeof protectedKey === 'string') return k === protectedKey;
        if (protectedKey instanceof Set) return protectedKey.has(k);
        if (Array.isArray(protectedKey)) return protectedKey.includes(k);
        return false;
      };
      if (this.map.has(key)) {
        this.map.delete(key);
      } else if (this.map.size >= this.maxSize) {
        let evictedKey = null;
        for (const k of this.map.keys()) {
          if (!isProtected(k)) {
            evictedKey = k;
            break;
          }
        }
        if (evictedKey) {
          this.map.delete(evictedKey);
        } else {
          this.map.delete(this.map.keys().next().value);
        }
      }
      this.map.set(key, val);
    }
    has(key) {
      return this.map.has(key);
    }
    delete(key) {
      return this.map.delete(key);
    }
    clear() {
      this.map.clear();
    }
    get size() {
      return this.map.size;
    }
  }

  function normalizeSnapshotSchema(data, cid) {
    if (!data || typeof data !== 'object') return null;
    const now = Date.now();
    const ratio = typeof data.ratio === 'number' ? data.ratio : (data.limit ? (data.used || 0) / data.limit : 0);
    return {
      schemaVersion: 2,
      calcVersion: 2,
      contextEpoch: typeof data.contextEpoch === 'number' ? data.contextEpoch : 1,
      conversationId: (cid || data.conversationId || '').toLowerCase(),
      ready: data.ready !== false,
      used: typeof data.used === 'number' ? data.used : 0,
      limit: typeof data.limit === 'number' ? data.limit : 256000,
      ratio: ratio,
      percent: data.percent || (Math.round(ratio * 1000) / 10 + '%'),
      usedK: data.usedK || (data.used ? (data.used / 1000).toFixed(1) + 'K' : '0.0K'),
      limitK: data.limitK || (data.limit ? (data.limit / 1000).toFixed(1) + 'K' : '256.0K'),
      modelId: data.modelId || null,
      isEstimated: !!data.isEstimated,
      fetchedAt: data.fetchedAt || now,
      lastAccessedAt: data.lastAccessedAt || now,
      lastStepIndex: typeof data.lastStepIndex === 'number' ? data.lastStepIndex : null,
      source: data.source || (data.isEstimated ? 'estimated' : 'ls-rpc'),
      compressionDetected: !!data.compressionDetected,
      compressionDrop: data.compressionDrop || 0,
      isOverLimit: !!data.isOverLimit,
      isTruncated: !!data.isTruncated,
      isWindowed: !!data.isWindowed,
      stepCount: (typeof data.stepCount === 'number') ? data.stepCount : 0,
      totalSteps: (typeof data.totalSteps === 'number') ? data.totalSteps : 0,
      windowStartStep: (typeof data.windowStartStep === 'number') ? data.windowStartStep : 0,
      isUnknownModel: !!data.isUnknownModel,
      tooltip: data.tooltip || ''
    };
  }

  // 独立的时序版本、世代隔离与数据质量写入判定（纯逻辑守卫）
  function shouldAcceptSnapshot(existing, incoming, options = {}) {
    if (!incoming || !incoming.ready || incoming.isPending || incoming.isDraft) {
      return { accept: false, reason: 'not-ready-or-draft' };
    }

    // 1. 会话级请求修订号时序守卫 (Revision Guard - 防新旧请求逆序覆盖)
    const revision = (typeof options.revision === 'number')
      ? options.revision
      : (typeof incoming._requestRevision === 'number' ? incoming._requestRevision : null);
    const lastCommitted = typeof options.lastCommittedRevision === 'number' ? options.lastCommittedRevision : 0;
    if (revision !== null && revision < lastCommitted) {
      return { accept: false, reason: 'revision-outdated' };
    }

    // 2. ContextEpoch 世代隔离守卫 (新世代建立后，旧世代数据严禁回流)
    if (existing && typeof existing.contextEpoch === 'number' && typeof incoming.contextEpoch === 'number') {
      if (incoming.contextEpoch < existing.contextEpoch) {
        return { accept: false, reason: 'epoch-outdated' };
      }
    }

    // 3. 数据质量与上下文重置判定（精确数据保护与新压缩/回退/权威快照工具增量豁免）
    const isNewlyCompressed = !!incoming.compressionDetected && (
      !existing?.compressionDetected ||
      (typeof incoming.compressionDrop === 'number' && incoming.compressionDrop > (existing?.compressionDrop || 0))
    );

    const existingIsAuthoritative = existing && (
      !existing.isEstimated ||
      existing.source === 'checkpoint' ||
      existing.source === 'planner' ||
      existing.source === 'ls-rpc'
    );
    const isAuthoritativeToolDelta =
      (incoming.source === 'checkpoint' || incoming.source === 'planner') &&
      typeof incoming.lastStepIndex === 'number' &&
      (typeof existing?.lastStepIndex !== 'number' || incoming.lastStepIndex >= existing.lastStepIndex);

    if (existingIsAuthoritative && incoming.isEstimated && !isAuthoritativeToolDelta) {
      const isCompressedOrRewind = isNewlyCompressed ||
        (typeof incoming.lastStepIndex === 'number' && typeof existing.lastStepIndex === 'number' && incoming.lastStepIndex < existing.lastStepIndex);
      if (!isCompressedOrRewind) {
        return { accept: false, reason: 'rough-estimate-blocked' };
      }
    }

    // 4. 同世代未发生新压缩时，步数逆序数据拦截（若携带严格递增的新请求修订号且非纯前端粗估，判定为用户回退/编辑历史消息，放行并自增世代）
    if (existing && !isNewlyCompressed && typeof existing.lastStepIndex === 'number' && typeof incoming.lastStepIndex === 'number') {
      const epochExisting = typeof existing.contextEpoch === 'number' ? existing.contextEpoch : 1;
      const epochIncoming = typeof incoming.contextEpoch === 'number' ? incoming.contextEpoch : epochExisting;
      if (epochExisting === epochIncoming && incoming.lastStepIndex < existing.lastStepIndex) {
        const hasNewerRevision = revision !== null && revision > lastCommitted;
        const isAuthoritativeRewind = (hasNewerRevision && incoming.source !== 'fiber-estimate') || !!incoming.isRewind || !!options.allowRewind;
        if (!isAuthoritativeRewind) {
          return { accept: false, reason: 'step-index-reversal' };
        }
        return { accept: true, revision: revision, isRewind: true, nextEpoch: epochExisting + 1 };
      }
    }

    return { accept: true, revision: revision };
  }

  const MODEL_LIMITS_STORAGE_KEY = 'ag_ring_model_limits_v1';
  const MAX_DYNAMIC_MODEL_LIMITS = 100;
  const dynamicModelLimits = new Map();
  let lastModelLimitsStorageRef = null;

  function normalizeClientModelKey(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw
      .replace(/[(（\[]\s*(?:新|new|注意|notice|unavailable|default)\s*[)）\]]/gi, ' ')
      .replace(/(?:\s*[·•|/:-]\s*|\s+)\d+(?:\.\d+)?\s*[km]b?(?=\s|$|[)）\]])/gi, ' ')
      .replace(/(?:^|(?<![a-zA-Z0-9_-]))(?:new|notice|unavailable)(?![a-zA-Z0-9_-])/gi, ' ')
      .replace(/(?:^|(?<=[\s)）\]a-zA-Z0-9低中高])|(?<=\S)(?=(?:新|注意)+$))(?:新|注意)(?=[\s(（\[]|$|(?:新|注意)+$)/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/[()（）[\]_/\s.:·•|]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function syncStorageModelLimits() {
    const storage = typeof localStorage !== 'undefined' ? localStorage : null;
    if (!storage || typeof storage.getItem !== 'function') return;
    if (storage === lastModelLimitsStorageRef) return;
    lastModelLimitsStorageRef = storage;
    try {
      const raw = storage.getItem(MODEL_LIMITS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          const num = Number(v);
          const norm = normalizeClientModelKey(k);
          if (norm && Number.isFinite(num) && num >= 4000 && num <= 10000000) {
            dynamicModelLimits.set(norm, Math.round(num));
          }
        }
      }
    } catch {}
  }

  function updateClientModelLimits(entries, persist = true) {
    if (!entries || typeof entries !== 'object') return false;
    syncStorageModelLimits();
    const pairs = entries instanceof Map
      ? Array.from(entries.entries())
      : (Array.isArray(entries) ? entries : Object.entries(entries));
    let changed = false;
    for (const item of pairs) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const [rawKey, rawVal] = item;
      const keyStr = String(rawKey || '').trim();
      if (!keyStr || /^\d+\s+models?\s+selected$/i.test(keyStr)) continue;
      const num = Number(rawVal);
      if (!Number.isFinite(num) || num < 4000 || num > 10000000) continue;
      const limit = Math.round(num);
      const norm = normalizeClientModelKey(keyStr);
      if (!norm) continue;
      if (dynamicModelLimits.get(norm) !== limit) {
        if (dynamicModelLimits.has(norm)) dynamicModelLimits.delete(norm);
        dynamicModelLimits.set(norm, limit);
        changed = true;
      }
    }
    while (dynamicModelLimits.size > MAX_DYNAMIC_MODEL_LIMITS) {
      const oldest = dynamicModelLimits.keys().next().value;
      if (oldest === undefined) break;
      dynamicModelLimits.delete(oldest);
    }
    if (changed && persist && typeof localStorage !== 'undefined' && typeof localStorage?.setItem === 'function') {
      try {
        const obj = Object.fromEntries(dynamicModelLimits.entries());
        localStorage.setItem(MODEL_LIMITS_STORAGE_KEY, JSON.stringify(obj));
        lastModelLimitsStorageRef = localStorage;
      } catch {}
    }
    return changed;
  }

  function clearClientModelLimits() {
    dynamicModelLimits.clear();
    lastModelLimitsStorageRef = null;
    if (typeof localStorage !== 'undefined' && typeof localStorage?.removeItem === 'function') {
      try { localStorage.removeItem(MODEL_LIMITS_STORAGE_KEY); } catch {}
    }
  }

  function parseContextWindowAttr(raw) {
    if (raw === null || raw === undefined || raw === '') return 0;
    if (typeof raw === 'number') {
      return (Number.isFinite(raw) && raw >= 4000 && raw <= 10000000) ? Math.round(raw) : 0;
    }
    const trimmed = String(raw).trim().toLowerCase();
    if (!trimmed) return 0;
    const unitMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*([km])b?$/);
    if (unitMatch) {
      const val = Math.round(parseFloat(unitMatch[1]) * (unitMatch[2] === 'm' ? 1000000 : 1000));
      return (val >= 4000 && val <= 10000000) ? val : 0;
    }
    const num = Number(trimmed);
    return (Number.isFinite(num) && num >= 4000 && num <= 10000000) ? Math.round(num) : 0;
  }

  // 前端轻量模型截断阈值推导（优先读取 DOM data-context-window 与动态自学习缓存，未命中再回退静态正则与 256K 兜底）
  function inferClientModelLimit(modelHint = '', modelElOrOptions = null) {
    if (modelElOrOptions && typeof modelElOrOptions === 'object') {
      const attrRaw = typeof modelElOrOptions.getAttribute === 'function'
        ? modelElOrOptions.getAttribute('data-context-window')
        : modelElOrOptions.contextWindow;
      const domLimit = parseContextWindowAttr(attrRaw);
      if (domLimit > 0) return domLimit;
    }
    if (modelHint && typeof modelHint === 'object') {
      const attrRaw = typeof modelHint.getAttribute === 'function'
        ? modelHint.getAttribute('data-context-window')
        : modelHint.contextWindow;
      const domLimit = parseContextWindowAttr(attrRaw);
      if (domLimit > 0) return domLimit;
    }

    const lower = String(typeof modelHint === 'string' ? modelHint : '').trim().toLowerCase();
    if (!lower) return 256000;

    // 0. 动态自学习缓存（后端 GetCascadeTrajectoryGeneratorMetadata / GetUserStatus 实测同步 + LocalStorage 持久化）
    syncStorageModelLimits();
    if (dynamicModelLimits.size > 0) {
      const norm = normalizeClientModelKey(lower);
      if (norm && dynamicModelLimits.has(norm)) {
        return dynamicModelLimits.get(norm);
      }
      if (dynamicModelLimits.has(lower)) {
        return dynamicModelLimits.get(lower);
      }
    }

    // 1. Gemini 4 Hydrogen (静态离线为 512K，但线上 AICode Mendel 远端策略统一压在 256K): hydrogen / M525..M528 / canonical M432..M434
    if (lower.includes('hydrogen') || /(?:^|[^a-z0-9])m(?:52[5-8]|43[2-4])(?=$|[^0-9])/.test(lower)) {
      return 256000;
    }

    // 2. GPT-OSS 120B (80K)
    if (/(?:gpt[-_\s]?oss|(?:^|[^a-z0-9])120b(?=$|[^a-z0-9]))/.test(lower)) {
      return 80000;
    }

    // 3. Legacy M26 / M35 / Claude 4 系列 (160K)
    if (
      /(?:^|[^a-z0-9])m(?:26|35)(?=$|[^0-9])/.test(lower) ||
      /(?:^|[^a-z0-9])claude(?:[-_\s]+(?:opus|sonnet|haiku))?[-_\s]+4(?:\.[0-9]+)?(?=$|[^0-9.])/.test(lower)
    ) {
      return 160000;
    }

    // 4. Gemini 2.5 / M50 / M18 / M148 / M198 (128K)
    if (
      /(?:^|[^a-z0-9])gemini[-_\s]?2[-._]5(?=$|[^0-9])/.test(lower) ||
      /(?:^|[^a-z0-9])m(?:50|18|148|198)(?=$|[^0-9])/.test(lower)
    ) {
      return 128000;
    }

    // 5. Gemini 4 Argon / Orchestrator (Argon) / Gemini 4 Carbon / Gemini 3.8 Flash / Claude 5.5 及未收录模型兜底 (256K)
    return 256000;
  }

  // 深度坏损自愈与索引合法性校验
  function sanitizeLRUIndex(raw) {
    if (!raw) return [];
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.time === 'number');
    } catch {
      return [];
    }
  }

  // 依据上下文占用比例与是否经历过历史压缩获取收束汇流色标
  function getRingColor(ratio, isCompressed = false) {
    const r = (typeof ratio === 'number' && Number.isFinite(ratio)) ? ratio : 0;
    if (r < 0.60) {
      return isCompressed ? '#a78bfa' : 'var(--ring-bar)'; // 0% ~ 60%: 压缩态薰衣草亮紫 / 常规态跟随 CSS 变量自适应（安全期）
    } else if (r < 0.80) {
      return '#f59e0b'; // 60% ~ 80%: 琥珀黄（注意期，双轨汇流）
    } else if (r < 0.90) {
      return '#f97316'; // 80% ~ 90%: 暖橙红（警告期，双轨汇流）
    } else {
      return '#ff2626'; // 90% ~ 100%+: 纯正红（极危截断期，双轨汇流）
    }
  }

  return {
    MemoryLRUCache,
    normalizeSnapshotSchema,
    shouldAcceptSnapshot,
    sanitizeLRUIndex,
    inferClientModelLimit,
    updateClientModelLimits,
    clearClientModelLimits,
    normalizeClientModelKey,
    getRingColor
  };
})();

function installAgContextRingWidget() {
  if (window.__agContextRingDispose) {
    try { window.__agContextRingDispose(); } catch {}
  } else if (window.__agContextRingInstalled) {
    for (const orphan of document.querySelectorAll('#ag-context-ring-container')) {
      orphan.remove();
    }
  }
  if (!document.documentElement || !document.body) {
    document.addEventListener('DOMContentLoaded', installAgContextRingWidget, { once: true });
    return;
  }
  if (!window.__agContextRingHost) return;

  const ID = 'ag-context-ring-container';
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // 1. 双阶前端会话级快照缓存 (In-Memory LRU Map 50 会话 + LocalStorage 持久化 100 会话)
  // 遵循成熟 Harness (Codex/WorkBuddy) 原生架构：缓存优先恢复，后台静默校准
  const {
    MemoryLRUCache,
    normalizeSnapshotSchema,
    shouldAcceptSnapshot,
    sanitizeLRUIndex,
    inferClientModelLimit,
    updateClientModelLimits,
    getRingColor
  } = __agRingCacheModule;
  const memoryCache = new MemoryLRUCache(50);
  const STORAGE_KEY_PREFIX = 'ag_ring_snap_';
  const STORAGE_INDEX_KEY = 'ag_ring_lru_index';
  const MAX_STORAGE_SNAPSHOTS = 100;

  // 会话级请求修订号与提交版本控制（UI 有 fetchSeq，Cache 有独立提交时序保护）
  const sessionRequestRevisions = new Map(); // cid -> number (issued revision)
  const sessionCommittedRevisions = new Map(); // cid -> number (committed revision)
  let isStorageDegraded = false; // 存储异常降级标记（如 LocalStorage 配额满或被禁用时纯内存保活）

  // LocalStorage LRU 索引维护与超限（>100条）淘汰（含深度损坏自愈与存储异常降级）
  function updateStorageLRUIndex(lowerId, timestamp) {
    if (isStorageDegraded) return;
    try {
      const raw = localStorage.getItem(STORAGE_INDEX_KEY);
      let index = sanitizeLRUIndex(raw);
      index = index.filter(item => item && item.id !== lowerId);
      index.push({ id: lowerId, time: timestamp });

      if (index.length > MAX_STORAGE_SNAPSHOTS) {
        index.sort((a, b) => a.time - b.time);
        while (index.length > MAX_STORAGE_SNAPSHOTS) {
          const evicted = index.shift();
          if (evicted?.id) {
            try {
              localStorage.removeItem(STORAGE_KEY_PREFIX + evicted.id);
              localStorage.removeItem('ag_ring_cache_' + evicted.id);
            } catch {}
          }
        }
      }
      localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(index));
    } catch {
      isStorageDegraded = true; // 捕获存储异常（如 QuotaExceededError），平稳降级为内存模式
    }
  }

  const getCachedSnapshot = (cid) => {
    if (!cid) return null;
    const lowerId = cid.toLowerCase();
    
    // 1. 优先查 In-Memory LRU 缓存（命中则刷新 LRU）
    let snap = memoryCache.get(lowerId);
    if (snap) {
      snap.lastAccessedAt = Date.now();
      return snap;
    }

    // 2. 内存未命中，查 LocalStorage 持久化快照
    if (!isStorageDegraded) {
      try {
        let raw = localStorage.getItem(STORAGE_KEY_PREFIX + lowerId);
        if (!raw) {
          raw = localStorage.getItem('ag_ring_cache_' + lowerId);
        }
        if (raw) {
          const parsed = JSON.parse(raw);
          // 校验 calcVersion === 2，自动淘汰旧版未计入 cacheReadTokens 的脏缓存
          if (parsed && parsed.ready && parsed.calcVersion === 2) {
            snap = normalizeSnapshotSchema(parsed, lowerId);
            snap.lastAccessedAt = Date.now();
            memoryCache.set(lowerId, snap, getAllActiveConversationIds());
            updateStorageLRUIndex(lowerId, snap.lastAccessedAt);
            return snap;
          }
        }
      } catch {}
    }

    return null;
  };

  const setCachedSnapshot = (cid, data, options = {}) => {
    if (!cid || !data) return false;
    const lowerId = cid.toLowerCase();
    const dataCid = (data.cid || data.conversationId || '').toLowerCase();
    if (dataCid && dataCid !== lowerId) {
      return false; // 坚决拒写 L1/L2 缓存并丢弃，防止跨会话串台
    }

    const existing = getCachedSnapshot(lowerId);
    const lastCommitted = sessionCommittedRevisions.get(lowerId) || 0;
    const check = shouldAcceptSnapshot(existing, data, {
      ...options,
      revision: options.revision,
      lastCommittedRevision: lastCommitted
    });

    if (!check.accept) {
      if (existing && check.reason === 'rough-estimate-blocked') {
        existing.lastAccessedAt = Date.now();
      }
      return false;
    }

    // 动态模型限额自学习（随快照同步后端动态目录与当前会话权威模型限额）
    if (data.modelLimits && typeof data.modelLimits === 'object') {
      updateClientModelLimits(data.modelLimits, !isStorageDegraded);
    }
    if (!data.isEstimated && !data.isUnknownModel && typeof data.limit === 'number' && data.limit >= 4000) {
      const learned = [];
      for (const candidate of [data.modelId, data.selectedModel, data.model, data.checkpointModel]) {
        if (typeof candidate === 'string' && candidate.trim()) {
          learned.push([candidate.trim(), data.limit]);
        }
      }
      if (learned.length > 0) {
        updateClientModelLimits(learned, !isStorageDegraded);
      }
    }

    const snap = normalizeSnapshotSchema(data, lowerId);
    if (typeof check.nextEpoch === 'number' && check.nextEpoch > snap.contextEpoch) {
      snap.contextEpoch = check.nextEpoch;
    } else if (existing && typeof existing.contextEpoch === 'number' && typeof data.contextEpoch !== 'number') {
      snap.contextEpoch = Math.max(snap.contextEpoch, existing.contextEpoch);
    }
    snap.lastAccessedAt = Date.now();

    // 更新最新提交版本号
    if (typeof check.revision === 'number' && check.revision > lastCommitted) {
      sessionCommittedRevisions.set(lowerId, check.revision);
    }

    // 写入第一层：In-Memory LRU Map（联合保护所有可见分屏的活跃会话不被误删）
    memoryCache.set(lowerId, snap, getAllActiveConversationIds());

    // 写入第二层：LocalStorage 持久化（带存储异常降级保护）
    if (!isStorageDegraded) {
      try {
        localStorage.setItem(STORAGE_KEY_PREFIX + lowerId, JSON.stringify(snap));
        updateStorageLRUIndex(lowerId, snap.lastAccessedAt);
      } catch {
        isStorageDegraded = true;
      }
    }

    // 同会话多开联动：若多个分屏同时打开了同一个会话，一处更新后立即同步刷新所有同会话分屏视图
    notifySameConversationPanes(lowerId, snap);
    return true;
  };

  // 统一会话请求 Promise 合并：普通同提示请求直接复用；force 或模型提示变化时只追跑一次，且始终采用最新 options
  const inFlightRequests = new Map();
  const getRequestModelSignature = (options = {}) => {
    const normalize = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
    return `${normalize(options.selectedModel)}|${normalize(options.fallbackModel)}`;
  };

  function fetchSnapshotDeduped(cid, options = {}) {
    if (!cid) return Promise.resolve(null);
    const lowerId = cid.toLowerCase();
    const isForce = !!options.force;
    const requestModelSig = getRequestModelSignature(options);

    const existing = inFlightRequests.get(lowerId);
    if (existing) {
      // 若已有追跑请求，应与追跑请求而不是原始请求比较，避免模型来回切换时把最新提示吞掉
      const activeOptions = existing.followUpPromise ? existing.followUpOptions : existing.options;
      const activePromise = existing.followUpPromise || existing.promise;
      const activeIsForce = existing.followUpPromise ? !!activeOptions?.force : existing.isForce;
      const sameModelHint = getRequestModelSignature(activeOptions) === requestModelSig;
      if (sameModelHint && (activeIsForce || !isForce)) {
        return activePromise;
      }

      // 同 CID 但 force 等级或模型提示不同：只保留一个追跑 Promise，后续调用持续更新为最新 options
      const followUpForce = activeIsForce || isForce;
      existing.followUpOptions = { ...options };
      if (followUpForce) existing.followUpOptions.force = true;
      else delete existing.followUpOptions.force;
      if (!existing.followUpPromise) {
        const followUp = (async () => {
          try {
            await existing.promise;
          } catch {}
          try {
            return await executeRpc(lowerId, existing.followUpOptions || { ...options, force: isForce });
          } finally {
            const curr = inFlightRequests.get(lowerId);
            if (curr && curr.promise === followUp) {
              inFlightRequests.delete(lowerId);
            }
          }
        })();
        existing.followUpPromise = followUp;
      }
      return existing.followUpPromise;
    }

    return executeRpc(lowerId, options);
  }

  async function executeRpc(lowerId, options = {}) {
    if (!window.__agContextRingHost?.getSnapshot) return null;
    ringMetrics.rpcCalls++;
    const isForce = !!options.force;
    const reqRevision = (sessionRequestRevisions.get(lowerId) || 0) + 1;
    sessionRequestRevisions.set(lowerId, reqRevision);

    let inFlightEntry = null;
    const reqPromise = (async () => {
      try {
        const res = await window.__agContextRingHost.getSnapshot({ conversationId: lowerId, ...options });
        if (res && typeof res === 'object') {
          res._requestRevision = reqRevision;
          const returnedCid = (res.cid || res.conversationId || '').toLowerCase();
          if (returnedCid && returnedCid !== lowerId) {
            return null; // 返回的会话 ID 与发起请求的会话 ID 不符，坚决丢弃，防止串台
          }
        }
        return res;
      } finally {
        const curr = inFlightRequests.get(lowerId);
        if (curr && curr.promise === reqPromise) {
          if (curr.followUpPromise) {
            // 平滑原子交接：有 followUpPromise 时提升为主力，并保留最新模型提示与真实 force 等级
            inFlightRequests.set(lowerId, {
              promise: curr.followUpPromise,
              options: curr.followUpOptions,
              isForce: !!curr.followUpOptions?.force,
              followUpPromise: null
            });
          } else {
            inFlightRequests.delete(lowerId);
          }
        }
      }
    })();

    inFlightEntry = { promise: reqPromise, options: { ...options }, isForce, followUpPromise: null };
    inFlightRequests.set(lowerId, inFlightEntry);
    return reqPromise;
  }

  // 方案 B：React Fiber 状态核心挂钩与分屏多实例托管（Map<box, PaneRingInstance>）
  const paneInstances = new Map();
  const boundEditors = new Set();
  let mountDebounceTimer = null;

  const ringMetrics = {
    agentStateEvents: 0,
    forceRequests: 0,
    rpcCalls: 0
  };
  window.__agContextRingMetrics = ringMetrics;

  // 2. 新建会话草稿静态基准与动态模型分母适配 (方案 B：稳定 0% 干净底轨，不发网络请求)
  const DRAFT_SNAPSHOT = Object.freeze({
    ready: true,
    ratio: 0,
    percent: '0.0%',
    used: 0,
    usedK: '0.0K',
    limit: 256000,
    limitK: '256.0K',
    tooltip: '新会话 · 0.0K / 256.0K 上下文未占用',
    isDraft: true,
  });

  function stripModelHintBadges(text) {
    if (!text) return '';
    return text
      .replace(/[(（\[]\s*(?:新|new|注意|notice|unavailable|default)\s*[)）\]]/gi, ' ')
      .replace(/(?:\s*[·•|/:-]\s*|\s+)\d+(?:\.\d+)?\s*[km]b?(?=\s|$|[)）\]])/gi, ' ')
      .replace(/(?:^|(?<![a-zA-Z0-9_-]))(?:new|notice|unavailable)(?![a-zA-Z0-9_-])/gi, ' ')
      .replace(/(?:^|(?<=[\s)）\]a-zA-Z0-9低中高])|(?<=\S)(?=(?:新|注意)+$))(?:新|注意)(?=[\s(（\[]|$|(?:新|注意)+$)/g, ' ')
      .replace(/^[\s·•|/:-]+|[\s·•|/:-]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function readModelTriggerHint(el) {
    if (!el) return '';
    const rawText = (typeof el.textContent === 'string' ? el.textContent : '').trim();
    const text = stripModelHintBadges(rawText.replace(/^(?:选择模型|select model)\s*[:：-]?\s*/i, '').trim());
    if (text && !/^\d+\s+models?\s+selected$/i.test(text)) return text;
    const aria = (typeof el.getAttribute === 'function' ? (el.getAttribute('aria-label') || '') : '').trim();
    const cleanedAria = aria.replace(/^(?:选择模型|select model)\s*[:：-]?\s*/i, '').trim();
    const normalizedAria = stripModelHintBadges(cleanedAria.replace(/^,\s*current\s*[:：-]?\s*/i, '').trim());
    return /^\d+\s+models?\s+selected$/i.test(normalizedAria) ? '' : normalizedAria;
  }

  function extractPaneModelHint(targetBox, modelEl, allowSideFallback = true) {
    const el = modelEl || targetBox?.querySelector?.('[data-testid="model-selector-trigger"],button[aria-label*="选择模型"],button[aria-label*="Select model"]');
    if (el) {
      const triggerHint = readModelTriggerHint(el);
      if (triggerHint) return triggerHint;
    }

    // 优先从当前窗格 React Fiber cascadeContext.state.selectedModel 直读真实会话模型（覆盖 Subagent / Best-of-N / /btw 等无模型按钮场景）
    if (targetBox) {
      const ctx = getReactCascadeContext(targetBox);
      const fiberModel = ctx?.state?.selectedModel;
      if (fiberModel) {
        const rawFiberHint = typeof fiberModel === 'string'
          ? fiberModel
          : (fiberModel.label || fiberModel.modelId || fiberModel.value || fiberModel.modelOrAlias?.model || '');
        const cleanedFiberHint = stripModelHintBadges(String(rawFiberHint || '').trim());
        if (cleanedFiberHint && !/^\d+\s+models?\s+selected$/i.test(cleanedFiberHint)) {
          return cleanedFiberHint;
        }
      }
    }

    // 无模型选择器按钮（如 /btw 侧边栏、subagentView 侧边栏或 Subagent 全屏视图）时，向主会话活跃窗格的模型按钮借用分母预览
    if (allowSideFallback && targetBox) {
      for (const inst of paneInstances.values()) {
        if (!inst?.box?.isConnected || inst.box === targetBox) continue;
        if (isAuxSubpaneComposer(inst.box)) continue;
        const hint = inst.lastModelHint || extractPaneModelHint(inst.box, inst.model, false);
        if (hint) return hint;
      }
      if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        const triggers = Array.from(document.querySelectorAll('[data-testid="model-selector-trigger"],button[aria-label*="选择模型"],button[aria-label*="Select model"]'));
        for (const btn of triggers) {
          if (!isVisible(btn)) continue;
          const testId = btn.getAttribute?.('data-testid') || '';
          const ariaLabel = btn.getAttribute?.('aria-label') || '';
          if (testId.includes('permission') || ariaLabel.includes('权限')) continue;
          const ownerBox = btn.closest?.('[data-testid="agent-input-box"]') || btn;
          if (ownerBox === targetBox || isAuxSubpaneComposer(ownerBox)) continue;
          const hint = readModelTriggerHint(btn);
          if (hint) return hint;
        }
      }
    }
    return '';
  }

  const formatTokens = (n) => ((Number(n) || 0) / 1000).toFixed(1) + 'K';

  function getSideQuestionInheritPreviewSnapshot(box, model) {
    const sq = getSideQuestionScope(box);
    if (!sq?.isDraft) return null;
    const parentCid = getSideQuestionParentCascadeId(box);
    if (!parentCid) return null;
    const parentSnap = getCachedSnapshot(parentCid);
    if (!parentSnap || !parentSnap.ready || !(parentSnap.used > 0)) return null;

    const modelHint = (box || model) ? extractPaneModelHint(box, model) : '';
    const triggerEl = model || box?.querySelector?.('[data-testid="model-selector-trigger"],button[aria-label*="选择模型"],button[aria-label*="Select model"]') || null;
    const limit = (modelHint || triggerEl) ? inferClientModelLimit(modelHint, triggerEl) : (parentSnap.limit || DRAFT_SNAPSHOT.limit);
    const used = parentSnap.used;
    const ratio = limit > 0 ? used / limit : 0;
    const pct = (ratio * 100).toFixed(1) + '%';
    const usedK = formatTokens(used);
    const limitK = formatTokens(limit);
    const isOverLimit = ratio >= 1.0;
    let statusSuffix = '';
    if (isOverLimit) {
      statusSuffix = ' 已达截断阈值';
    } else if (ratio >= 0.90) {
      statusSuffix = ' 接近截断';
    }

    return {
      ready: true,
      source: 'side-question-inherit-preview',
      ratio,
      percent: pct,
      used,
      usedK,
      limit,
      limitK,
      isOverLimit,
      compressionDetected: !!parentSnap.compressionDetected,
      compressionSaved: parentSnap.compressionSaved || 0,
      tooltip: `将继承主会话 · ${pct} · ${usedK} / ${limitK}${statusSuffix}`,
      isDraft: false
    };
  }

  function getDraftSnapshot(box, model) {
    const inheritPreview = getSideQuestionInheritPreviewSnapshot(box, model);
    if (inheritPreview) {
      return inheritPreview;
    }
    const modelHint = (box || model) ? extractPaneModelHint(box, model) : '';
    const triggerEl = model || box?.querySelector?.('[data-testid="model-selector-trigger"],button[aria-label*="选择模型"],button[aria-label*="Select model"]') || null;
    const limit = (modelHint || triggerEl) ? inferClientModelLimit(modelHint, triggerEl) : DRAFT_SNAPSHOT.limit;
    if (limit === DRAFT_SNAPSHOT.limit) {
      return DRAFT_SNAPSHOT;
    }
    const limitK = (limit / 1000).toFixed(1) + 'K';
    return {
      ready: true,
      ratio: 0,
      percent: '0.0%',
      used: 0,
      usedK: '0.0K',
      limit: limit,
      limitK: limitK,
      tooltip: `新会话 · 0.0K / ${limitK} 上下文未占用`,
      isDraft: true,
    };
  }

  function getUnresolvedSnapshot() {
    return {
      ready: false,
      tooltip: '无法识别当前会话，正在等待宿主加载'
    };
  }

  const isVisible = (el) => {
    return el && el.isConnected && !el.closest('[hidden],[inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  // 检测输入框是否处于侧边 /btw (sideQuestionView) 容器内，优先按 side-question DOM 标记判定草稿与独立子会话 ID（严格排除 subagentView）
  function getSideQuestionScope(targetBox) {
    const box = targetBox || (typeof document !== 'undefined' ? document.querySelector?.('[data-testid="agent-input-box"]') : null);
    if (!box) return null;
    const sideMarker = (typeof box.closest === 'function'
      ? box.closest('[data-testid="side-question-tab-content"], [data-testid="side-question-tab-composer"], [data-side-panel-composer]')
      : null) || (box.hasAttribute?.('data-side-panel-composer') ? box : null);
    if (!sideMarker) return null;

    // 关键守卫：右侧 subagentView（含 Swarm Worker 标签页）同样带有 [data-side-panel-composer]，
    // 但其兄弟节点为 [data-testid="subagent-tab-conversation"]，绝不能误判为 /btw 草稿态！
    const subpaneRoot = box.closest?.('[data-media-drop-scope="subpane"]') || sideMarker.parentElement || null;
    if (subpaneRoot?.querySelector?.('[data-testid="subagent-tab-conversation"]')) {
      return null;
    }

    const isExplicitSideQuestion = Boolean(
      box.closest?.('[data-testid="side-question-tab-content"], [data-testid="side-question-tab-composer"]') ||
      sideMarker.matches?.('[data-testid="side-question-tab-content"], [data-testid="side-question-tab-composer"]')
    );

    const contentRoot =
      box.closest?.('[data-testid="side-question-tab-content"]') ||
      sideMarker.closest?.('[data-testid="side-question-tab-content"]') ||
      (isExplicitSideQuestion && typeof document !== 'undefined' ? document.querySelector?.('[data-testid="side-question-tab-content"]') : null) ||
      subpaneRoot ||
      sideMarker;

    const convEl = contentRoot?.querySelector?.('[data-testid="side-question-tab-conversation"]') || null;
    const emptyEl = contentRoot?.querySelector?.('[data-testid="side-question-tab-empty"]') || null;
    if (!isExplicitSideQuestion && !convEl && !emptyEl) {
      return null;
    }

    const rawId = convEl?.getAttribute?.('data-cascade-id') || '';
    const cascadeId = GUID.test(rawId) ? rawId.toLowerCase() : null;
    const emptyVisible = emptyEl
      ? (typeof emptyEl.getClientRects === 'function'
        ? isVisible(emptyEl)
        : (emptyEl.isConnected !== false && !emptyEl.closest?.('[hidden],[inert]')))
      : false;
    const isDraft = Boolean(emptyVisible || !cascadeId);

    return {
      isSideQuestion: true,
      contentRoot,
      convEl,
      emptyEl,
      cascadeId,
      isDraft,
    };
  }

  // 统一识别右侧辅助子窗格（涵盖 /btw sideQuestionView 与子代理/Worker subagentView）
  function isAuxSubpaneComposer(targetBox) {
    if (!targetBox) return false;
    if (getSideQuestionScope(targetBox)) return true;
    if (typeof targetBox.closest === 'function') {
      if (targetBox.closest('[data-media-drop-scope="subpane"], [data-side-panel-composer], [data-testid="subagent-tab-conversation"]')) {
        return true;
      }
    }
    if (targetBox.hasAttribute?.('data-side-panel-composer')) return true;
    return false;
  }

  // 统计活跃的主聊天窗格数量（排除右侧 /btw 与 subagentView 辅助子窗格，避免开启辅助栏时干扰单主窗格 URL 回退逻辑）
  function getMainConversationPaneCount(fallbackTotal = 1) {
    let hasSideQuestionPane = false;
    let mainCount = 0;
    for (const inst of paneInstances.values()) {
      if (!inst?.box?.isConnected) continue;
      if (isAuxSubpaneComposer(inst.box)) {
        hasSideQuestionPane = true;
      } else {
        mainCount++;
      }
    }
    if (!hasSideQuestionPane && fallbackTotal > mainCount) {
      try {
        const allComposers = findAllComposers();
        if (allComposers.length > 0) {
          let domMainCount = 0;
          let domHasAux = false;
          for (const c of allComposers) {
            if (isAuxSubpaneComposer(c.box)) domHasAux = true;
            else domMainCount++;
          }
          if (domHasAux) {
            return domMainCount > 0 ? domMainCount : 1;
          }
          return Math.max(domMainCount, 1);
        }
      } catch {}
    }
    if (hasSideQuestionPane) {
      return mainCount > 0 ? mainCount : 1;
    }
    return Math.max(mainCount, fallbackTotal || 1);
  }

  function getSideQuestionParentCascadeId(targetBox) {
    const box = targetBox || (typeof document !== 'undefined' ? document.querySelector?.('[data-testid="agent-input-box"]') : null);
    if (!box) return null;

    // 1. 优先从 targetBox 向上遍历 React Fiber，读取 memoizedProps.parentCascadeId 或 memoizedProps.sideQuestionOwnerId
    try {
      const fiberKey = Object.keys(box).find(k => k.startsWith('__reactFiber'));
      if (fiberKey) {
        let curr = box[fiberKey];
        let depth = 0;
        while (curr && depth < 35) {
          depth++;
          const props = curr.memoizedProps;
          const rawOwnerId = props?.parentCascadeId || props?.sideQuestionOwnerId;
          if (typeof rawOwnerId === 'string' && GUID.test(rawOwnerId)) {
            return rawOwnerId.toLowerCase();
          }
          curr = curr.return;
        }
      }
    } catch {}

    // 2. 其次读取 getReactCascadeContext(targetBox)?.state?.agentStateProvider?.getState?.()?.conversationId
    try {
      const ctx = getReactCascadeContext(box);
      const cid = ctx?.state?.agentStateProvider?.getState?.()?.conversationId;
      if (typeof cid === 'string' && GUID.test(cid)) {
        return cid.toLowerCase();
      }
    } catch {}

    // 3. 若 Fiber 尚未就绪且 getMainConversationPaneCount() === 1，回退获取唯一主窗格的 extractRawConversationId
    const totalPanes = paneInstances.size || 1;
    if (getMainConversationPaneCount(totalPanes) === 1) {
      const mainBoxes = [];
      for (const inst of paneInstances.values()) {
        if (inst?.box?.isConnected && !isAuxSubpaneComposer(inst.box)) {
          mainBoxes.push(inst.box);
        }
      }
      if (mainBoxes.length === 0) {
        try {
          for (const c of findAllComposers()) {
            if (c?.box?.isConnected && !isAuxSubpaneComposer(c.box)) {
              mainBoxes.push(c.box);
            }
          }
        } catch {}
      }
      if (mainBoxes.length === 1) {
        return extractRawConversationId(mainBoxes[0], totalPanes);
      }
    }

    return null;
  }

  // 当主会话快照更新缓存后，0ms 同步刷新依赖它的草稿态 /btw 继承预览（0 额外 RPC）
  function refreshSideQuestionDraftPreviews(parentCid) {
    if (!parentCid) return;
    const targetParent = parentCid.toLowerCase();
    for (const inst of paneInstances.values()) {
      if (!inst?.box?.isConnected) continue;
      const sq = getSideQuestionScope(inst.box);
      if (!sq?.isDraft) continue;
      if (getSideQuestionParentCascadeId(inst.box) === targetParent) {
        updatePaneView(inst, getDraftSnapshot(inst.box, inst.model));
      }
    }
  }

  function getReactCascadeContext(targetBox) {
    const box = targetBox || document.querySelector('[data-testid="agent-input-box"]');
    if (!box?.isConnected) return null;
    const fiberKey = Object.keys(box).find(k => k.startsWith('__reactFiber'));
    if (!fiberKey) return null;
    let curr = box[fiberKey];
    let depth = 0;
    while (curr && depth < 35) {
      depth++;
      if (curr.memoizedProps?.cascadeContext) {
        return curr.memoizedProps.cascadeContext;
      }
      curr = curr.return;
    }
    return null;
  }

  function bindPaneAgentStateListener(inst) {
    if (!inst || !inst.box?.isConnected) return;
    const ctx = getReactCascadeContext(inst.box);
    const provider = ctx?.state?.agentStateProvider;
    if (!provider || typeof provider.onDidChange !== 'function') return;
    if (inst.subscribedProvider === provider) return;

    if (inst.disposeAgentState) {
      try { inst.disposeAgentState(); } catch {}
      inst.disposeAgentState = null;
      inst.subscribedProvider = null;
    }

    inst.subscribedProvider = provider;
    provider.__agRingSubscribed = true;
    try {
      const sub = provider.onDidChange(() => {
        ringMetrics.agentStateEvents++;
        if (inst.agentStateDebounceTimer) clearTimeout(inst.agentStateDebounceTimer);
        inst.agentStateDebounceTimer = setTimeout(() => {
          inst.agentStateDebounceTimer = null;
          ringMetrics.forceRequests++;
          handleInstantPaneSync(inst, true); // 携带 force: true 穿透 Sidecar 8s 缓存
        }, 250);
      });
      inst.disposeAgentState = () => {
        try {
          if (typeof sub === 'function') sub();
          else if (sub?.dispose) sub.dispose();
        } catch {}
        delete provider.__agRingSubscribed;
        inst.subscribedProvider = null;
      };
    } catch {
      delete provider.__agRingSubscribed;
      inst.subscribedProvider = null;
    }
  }

  // 纯净直读指定分屏输入框所处的原始会话 ID（优先从该分屏自身 React 状态机与 DOM 树直读，杜绝分屏 URL 串台）
  function extractRawConversationId(targetBox, totalPaneCount = paneInstances.size || 1) {
    const box = targetBox || document.querySelector('[data-testid="agent-input-box"]');
    // 侧边 /btw (`sideQuestionView`) 防串台优先守卫：
    // 草稿态下外层 <X5> Fiber 会注入父会话 conversationId，必须先于 Fiber 按 side-question DOM 标记拦截。
    const sq = getSideQuestionScope(box);
    if (sq) {
      return sq.isDraft ? null : sq.cascadeId;
    }

    const ctx = getReactCascadeContext(box);
    const provider = ctx?.state?.agentStateProvider;
    let hasFiberState = false;
    if (provider && typeof provider.getState === 'function') {
      try {
        const state = provider.getState();
        if (state && typeof state === 'object') {
          hasFiberState = true;
          const cid = state.conversationId;
          if (cid && GUID.test(cid)) {
            return cid.toLowerCase();
          }
        }
      } catch {}
    }

    if (!box?.isConnected) return null;

    const readId = (el) => {
      const id = el.getAttribute?.('data-cascade-id');
      return GUID.test(id || '') ? id.toLowerCase() : null;
    };

    let scope = box;
    let hops = 0;
    while (scope && scope !== document.body && scope !== document.documentElement) {
      if (++hops > 32) break;
      if (scope.matches?.('[data-testid="conversation-view"]')) {
        const id = readId(scope);
        if (id) return id;
      }
      if (scope.hasAttribute?.('data-cascade-id')) {
        const id = readId(scope);
        if (id) return id;
      }
      // 兼容右侧 subagentView：其 [data-testid="subagent-tab-conversation"][data-cascade-id] 为 [data-side-panel-composer] 的同级兄弟节点
      const subagentConv = scope.querySelector?.('[data-testid="subagent-tab-conversation"][data-cascade-id]');
      if (subagentConv) {
        const id = readId(subagentConv);
        if (id) return id;
      }
      scope = scope.parentElement;
    }

    // 分屏防串台铁律：当页面存在多个主分屏、当前输入框为右侧辅助子窗格、URL 含 %2B/+ 多会话拼接、或该分屏 Fiber 已明确返回无 conversationId 时，
    // 绝不回退读取全局 location.pathname，防止新建草稿分屏或子代理侧边栏误偷另一侧主分屏的会话 ID！
    const mainPaneCount = getMainConversationPaneCount(totalPaneCount);
    const pathname = (typeof location !== 'undefined' && location?.pathname) ? location.pathname : '';
    if (mainPaneCount > 1 || isAuxSubpaneComposer(box) || hasFiberState || pathname.includes('%2B') || pathname.includes('%2b') || pathname.includes('+')) {
      return null;
    }

    const urlMatch = pathname.match(/\/c\/([0-9a-f-]{36})/i);
    return urlMatch && GUID.test(urlMatch[1]) ? urlMatch[1].toLowerCase() : null;
  }

  // 严格判断指定分屏输入框所处的会话视图是否是尚未发送任何消息的纯草稿态
  function isDraftView(targetBox, totalPaneCount = paneInstances.size || 1) {
    const box = targetBox || document.querySelector('[data-testid="agent-input-box"]');
    const sq = getSideQuestionScope(box);
    if (sq) {
      return sq.isDraft;
    }
    const rawCid = extractRawConversationId(box, totalPaneCount);
    // 关键守卫：若该分屏会话已识别出有效会话 ID，绝对不是草稿态！
    if (rawCid) {
      return false;
    }

    // 子代理侧边视图（subagentView）承载已创建的子代理/Worker 会话，绝不视为新建草稿态
    const subpaneScope = box?.closest?.('[data-media-drop-scope="subpane"]') || box?.parentElement?.parentElement || null;
    if (subpaneScope?.querySelector?.('[data-testid="subagent-tab-conversation"]')) {
      return false;
    }

    // 方案 B 一等公民：优先直接从该分屏 React Fiber 的 agentStateProvider 获取总步骤或回合数
    const ctx = getReactCascadeContext(box);
    const provider = ctx?.state?.agentStateProvider;
    let hasFiberState = false;
    if (provider && typeof provider.getState === 'function') {
      try {
        const state = provider.getState();
        if (state && typeof state === 'object') {
          hasFiberState = true;
          const stepsLen = state.trajectorySlice?.totalStepsLength;
          if (typeof stepsLen === 'number' && stepsLen > 0) return false;
          if (Array.isArray(state.turns) && state.turns.length > 0) return false;
          const isExplicitEmptyTurns = Array.isArray(state.turns) && state.turns.length === 0;
          if (
            (stepsLen === 0 || (stepsLen === undefined && (state.conversationId === null || state.conversationId === '' || isExplicitEmptyTurns))) &&
            (!state.turns || state.turns.length === 0) &&
            !rawCid
          ) {
            return true;
          }
        }
      } catch {}
    }

    // 降级兜底：基于该分屏自身 DOM 视图的细粒度判定
    if (!box?.isConnected) return false;

    const welcomeTextRe = /今天有什么|我们可以一起完成|what can (we|I) (help|accomplish|do)|what should we build|where should we pick up|what's next|开始新会话|准备好提问/i;
    const welcomeSelector = '[data-testid="home-greeting"],[data-testid*="starter"],[data-testid*="empty"],[data-testid*="welcome"],[data-testid*="suggested"],[data-testid*="greeting"],[data-testid*="hero"],[data-testid*="banner"]';
    const realTurnSelector = '[data-testid="user-input-step"],[data-testid="agent-turn"],[data-testid="turn-card"],[data-testid="step-item"]';

    let view = box.closest?.('[data-testid="conversation-view"]');
    if (!view) {
      let p = box.parentElement;
      while (p && p !== document.body) {
        if (p.matches?.('[data-testid*="conversation"], [data-testid*="chat"], [data-testid*="welcome"], [data-testid*="starter"], [data-testid*="empty"], [data-tiling-pane], .agy-home')) {
          view = p;
          break;
        }
        if (p.querySelector?.(welcomeSelector) || welcomeTextRe.test(p.textContent || '')) {
          view = p;
          break;
        }
        if (p.parentElement === document.body && !hasFiberState) {
          view = p;
          break;
        }
        p = p.parentElement;
      }
    }
    // 找不到会话视图只能证明“识别失败”，不能反推为草稿。
    // 若宿主 DOM 升级或历史视图尚未挂载，伪造成新会话 0% 比暂时不显示更误导。
    if (!view) return false;

    const isWelcomeOrStarter = (el) => {
      if (!el) return false;
      if (el.matches?.(realTurnSelector) || el.querySelector?.(realTurnSelector)) return false;
      if (el.closest?.(welcomeSelector)) return true;
      const text = (el.textContent || '').trim();
      if (text.length <= 160 && welcomeTextRe.test(text)) return true;
      return false;
    };

    const hasAnyRealTurn = (selectors) => {
      const list = view.querySelectorAll(selectors);
      for (let i = 0; i < list.length; i++) {
        const el = list[i];
        if (!isWelcomeOrStarter(el) && isVisible(el)) return true;
      }
      return false;
    };

    if (hasAnyRealTurn('[data-testid="user-input-step"]')) return false;
    if (hasAnyRealTurn('[data-testid="agent-turn"], [data-testid="turn-card"], [data-testid="step-item"]')) return false;

    const turnsContainer = view.querySelector('[data-testid="turn-cards-container"]');
    if (turnsContainer) {
      const children = turnsContainer.children;
      for (let i = 0; i < children.length; i++) {
        const el = children[i];
        if (el.querySelector?.(realTurnSelector)) {
          return false;
        }
        if (!isWelcomeOrStarter(el) && isVisible(el)) {
          if (el.matches?.('[data-testid*="turn"],[data-testid*="step"]') || el.getAttribute?.('role') === 'article') {
            return false;
          }
        }
      }
    }

    const articles = view.querySelectorAll('[role="article"]');
    for (let i = 0; i < articles.length; i++) {
      const el = articles[i];
      if (!box.contains(el) && !isWelcomeOrStarter(el) && isVisible(el)) {
        if (el.querySelector?.('[data-testid="user-input-step"], [data-testid="agent-turn"], [data-testid="turn-card"]') || el.matches?.('[data-testid*="turn"]')) {
          return false;
        }
      }
    }

    return true;
  }

  // 获取指定分屏输入框所处的有效会话 ID（草稿态返回 null，非草稿态返回有效 GUID）
  function getActiveConversationId(targetBox, totalPaneCount = paneInstances.size || 1) {
    if (isDraftView(targetBox, totalPaneCount)) {
      return null;
    }
    return extractRawConversationId(targetBox, totalPaneCount);
  }

  // 获取当前所有可见分屏正在展示的活跃会话 ID 集合，用于联合保护内存 LRU 缓存不被淘汰
  function getAllActiveConversationIds() {
    const set = new Set();
    const total = paneInstances.size || 1;
    for (const inst of paneInstances.values()) {
      if (inst.box?.isConnected) {
        const cid = extractRawConversationId(inst.box, total);
        if (cid) set.add(cid);
      }
    }
    return set;
  }

  // 当某个会话缓存更新时，同步刷新所有正打开该会话的分屏实例
  function notifySameConversationPanes(lowerId, snap) {
    if (!lowerId || !snap) return;
    const total = paneInstances.size || 1;
    for (const inst of paneInstances.values()) {
      if (!inst.box?.isConnected) continue;
      const cid = getActiveConversationId(inst.box, total);
      if (cid === lowerId) {
        updatePaneView(inst, snap);
      }
    }
  }

  // 从指定分屏的 React Fiber 提取实时步骤数进行 0ms 快速估算（用于无缓存冷会话秒开垫底）
  function getFiberQuickEstimate(targetBox, cid, modelEl) {
    if (!cid) return null;
    const ctx = getReactCascadeContext(targetBox);
    const provider = ctx?.state?.agentStateProvider;
    if (provider && typeof provider.getState === 'function') {
      try {
        const state = provider.getState();
        if (state && (state.conversationId?.toLowerCase() === cid.toLowerCase())) {
          const steps = state.trajectorySlice?.totalStepsLength || (Array.isArray(state.turns) ? state.turns.length : 0);
          if (steps > 0) {
            const triggerEl = modelEl || targetBox?.querySelector?.('[data-testid="model-selector-trigger"],button[aria-label*="选择模型"],button[aria-label*="Select model"]') || null;
            const limit = inferClientModelLimit(extractPaneModelHint(targetBox, modelEl), triggerEl);
            const limitK = (limit / 1000).toFixed(1) + 'K';
            const estTokens = Math.min(Math.round(steps * 1200), limit);
            const estRatio = Math.max(0.04, Math.min(estTokens / limit, 0.98));
            return {
              ready: true,
              ratio: estRatio,
              used: estTokens,
              limit: limit,
              usedK: (estTokens / 1000).toFixed(1) + 'K',
              limitK: limitK,
              percent: Math.round(estRatio * 1000) / 10 + '%',
              tooltip: `约 ${(estTokens / 1000).toFixed(1)}K / ${limitK} 上下文 (正在校准...)`,
              isEstimated: true,
              source: 'fiber-estimate',
              conversationId: cid.toLowerCase()
            };
          }
        }
      } catch {}
    }
    return null;
  }

  // 扫描页面上所有可见的分屏输入框与模型选择器组合（按 box 去重，全分屏对等返回；支持无模型选择器的 /btw 等子窗格）
  function findAllComposers() {
    const editors = Array.from(document.querySelectorAll('[role="combobox"][contenteditable="true"],[role="textbox"][contenteditable="true"],[aria-label="Message input"]')).filter(isVisible);
    const models = Array.from(document.querySelectorAll('[data-testid="model-selector-trigger"],button[aria-label*="选择模型"],button[aria-label*="Select model"]')).filter(isVisible);

    const results = [];
    const seenBoxes = new Set();

    for (const model of models) {
      const testId = model.getAttribute('data-testid') || '';
      const ariaLabel = model.getAttribute('aria-label') || '';
      if (testId.includes('permission') || ariaLabel.includes('权限')) continue;

      const box = model.closest('[data-testid="agent-input-box"]');
      if (!box || seenBoxes.has(box)) continue;

      for (const editor of editors) {
        if (box !== editor.closest('[data-testid="agent-input-box"]')) continue;
        seenBoxes.add(box);
        results.push({ box, editor, model });
        break;
      }
    }

    // 兜底扫描：兼容 hideModelSelector=true（无模型选择器按钮，如 /btw 侧边栏或 Subagent）的可见输入框
    for (const editor of editors) {
      const box = editor.closest?.('[data-testid="agent-input-box"]') ||
        editor.closest?.('[data-testid="side-question-tab-composer"], [data-side-panel-composer]');
      if (!box || box.isConnected === false || seenBoxes.has(box)) continue;
      seenBoxes.add(box);
      results.push({ box, editor, model: null });
    }
    return results;
  }

  // 智能差异化渲染指定分屏实例的圆环与气泡数据（带防抖去重与平滑过渡）
  function updatePaneView(inst, data, force = false) {
    if (!inst || !inst.root || !data) return;
    const root = inst.root;
    const currentData = inst.currentData;

    if (!force && currentData &&
        currentData.ready === data.ready &&
        currentData.source === data.source &&
        currentData.ratio === data.ratio &&
        currentData.used === data.used &&
        currentData.limit === data.limit &&
        currentData.isDraft === data.isDraft &&
        currentData.compressionDetected === data.compressionDetected &&
        currentData.isOverLimit === data.isOverLimit &&
        currentData.isTruncated === data.isTruncated &&
        currentData.isWindowed === data.isWindowed &&
        currentData.totalSteps === data.totalSteps &&
        currentData.isUnknownModel === data.isUnknownModel &&
        currentData.tooltip === data.tooltip) {
      return;
    }

    const prevData = currentData;

    const bar = root.getElementById('ring-bar');
    const tooltipText = root.getElementById('tooltip-text');
    const ringEl = root.getElementById('context-ring');
    if (!bar || !tooltipText || !ringEl) return;

    const C = 2 * Math.PI * 7.25; // ~45.553
    bar.style.strokeDasharray = `${C} ${C}`;

    if (data.isPending) {
      inst.currentData = data;
      ringEl.classList.remove('unready');
      const ratio = 0.15;
      const offset = C * (1 - ratio);
      bar.style.strokeDashoffset = `${offset}`;
      bar.style.stroke = '#94a3b8';
      bar.style.opacity = '0.55';
      tooltipText.textContent = data.tooltip || '正在同步上下文进度...';
      return;
    }

    if (!data.ready) {
      if (prevData && prevData.ready && !prevData.isDraft && !prevData.isPending) {
        bar.style.opacity = '0.7';
        const baseTip = prevData.tooltip || '';
        const offlineTip = baseTip.includes('(离线)') ? baseTip : `${baseTip} (离线)`;
        tooltipText.textContent = offlineTip;
        inst.currentData = { ...prevData, tooltip: offlineTip };
        return;
      }
      inst.currentData = data;
      bar.style.strokeDashoffset = `${C}`;
      ringEl.classList.add('unready');
      bar.style.opacity = '0';
      tooltipText.textContent = data.tooltip || '暂无上下文数据';
      return;
    }

    inst.currentData = data;
    ringEl.classList.remove('unready');
    const ratio = Math.min(Math.max(data.ratio || 0, 0), 1);
    const offset = C * (1 - ratio);
    bar.style.strokeDashoffset = `${offset}`;

    if (ratio <= 0.001 || data.isDraft) {
      bar.style.opacity = '0';
    } else {
      bar.style.opacity = '1';
    }

    const isCompressed = !!data.compressionDetected;
    const ringColor = (data.isOverLimit || ratio >= 1)
      ? '#ff2626'
      : getRingColor(ratio, isCompressed);
    bar.style.stroke = ringColor;

    let tip = data.tooltip;
    if (data.isDraft) {
      tip = `新会话 · 0.0K / ${data.limitK || '256.0K'} 上下文未占用`;
    } else if (data.source === 'side-question-inherit-preview') {
      tip = data.tooltip || `将继承主会话 · ${(ratio * 100).toFixed(1)}% · ${data.usedK || '0.0K'} / ${data.limitK || '256.0K'}`;
    } else if (data.source === 'fiber-estimate' || (typeof tip === 'string' && tip.includes('(正在校准...)'))) {
      // 前端 Fiber 快速估算过渡态保持原校准提示，不误报为正式截断告警
      tip = tip || `约 ${data.usedK || '0.0K'} / ${data.limitK || '256.0K'} 上下文 (正在校准...)`;
    } else {
      const pct = data.percent || (Math.round(ratio * 1000) / 10 + '%');
      const usedStr = data.usedK || (data.used ? (data.used / 1000).toFixed(1) + 'K' : '0.0K');
      const limitStr = data.limitK || (data.limit ? (data.limit / 1000).toFixed(1) + 'K' : '256.0K');
      const baseInfo = `${pct} · ${usedStr} / ${limitStr}`;
      const compressNote = data.compressionDetected ? ` 曾压缩 ${data.compressionDrop ? (data.compressionDrop / 1000).toFixed(1) + 'K' : '5.0K+'}` : '';

      if (ratio >= 1.0 || data.isOverLimit) {
        tip = `${baseInfo} 已达截断阈值${compressNote}`;
      } else if (ratio >= 0.90) {
        tip = `${baseInfo} 接近截断${compressNote}`;
      } else if (data.compressionDetected) {
        const dropK = data.compressionDrop ? `${(data.compressionDrop / 1000).toFixed(1)}K` : '5.0K+';
        tip = `${baseInfo} 上下文已压缩 释放 ${dropK}`;
      } else if (data.isTruncated && !data.isWindowed) {
        tip = `${baseInfo} 会话数据不完整`;
      } else if (data.isUnknownModel) {
        const defaultTag = data.limit && data.limit !== 256000 ? `默认${limitStr}` : '默认256K';
        tip = `${baseInfo} 未知模型限制 ${defaultTag}`;
      } else if (!tip) {
        tip = `${baseInfo} 上下文已使用`;
      }
      if (data.isWindowed && typeof tip === 'string' && !tip.includes('长会话尾部')) {
        tip += ` · 长会话尾部 ${data.stepCount || data.totalSteps || 0}/${data.totalSteps || 0} 步`;
      }
    }
    tooltipText.textContent = tip;
    inst.currentData = { ...data, tooltip: tip };
  }

  // 自调度单个分屏实例的下一次轮询（常规 5s 兜底，带失败阶梯退避：5s -> 10s）
  function scheduleNextPaneSync(inst, immediateDelay) {
    if (!inst) return;
    if (inst.pollTimer) clearTimeout(inst.pollTimer);
    if (!inst.box?.isConnected || !paneInstances.has(inst.box)) return;

    let delay = 5000;
    if (typeof immediateDelay === 'number') {
      delay = immediateDelay;
    } else if (inst.consecutiveFailures >= 2) {
      delay = 10000;
    } else if (inst.consecutiveFailures === 1) {
      delay = 5000;
    }
    inst.pollTimer = setTimeout(() => syncPaneState(inst), delay);
  }

  // 核心 SWR 驱动（按分屏实例独立运行）：0 毫秒同步命中缓存渲染 + 后台静默微量校验
  async function syncPaneState(inst, syncOptions = {}) {
    if (!inst || !inst.box?.isConnected) return;
    const totalPanes = paneInstances.size || 1;

    // 每次同步前确保该分屏的 React Fiber 状态监听处于最新绑定状态
    bindPaneAgentStateListener(inst);

    // 优先级 1：草稿态防御（稳定 0% 基准，绝不触碰网络）
    if (isDraftView(inst.box, totalPanes)) {
      inst.lastConversationId = null;
      inst.consecutiveFailures = 0;
      updatePaneView(inst, getDraftSnapshot(inst.box, inst.model));
      scheduleNextPaneSync(inst, 5000);
      return;
    }

    const cid = getActiveConversationId(inst.box, totalPanes);

    // 优先级 2：分屏内会话切换检测与 0 毫秒缓存秒显
    if (cid !== inst.lastConversationId) {
      inst.lastConversationId = cid;
      if (!cid) {
        inst.consecutiveFailures = 0;
        updatePaneView(inst, getUnresolvedSnapshot(), true);
        scheduleNextPaneSync(inst, 5000);
        return;
      }

      const cached = getCachedSnapshot(cid);
      if (cached) {
        updatePaneView(inst, cached);
      } else {
        const fiberEst = getFiberQuickEstimate(inst.box, cid, inst.model);
        if (fiberEst) {
          updatePaneView(inst, fiberEst);
        } else {
          updatePaneView(inst, {
            ready: true,
            isPending: true,
            ratio: 0.15,
            tooltip: '正在同步上下文进度...'
          });
        }
      }
    }

    if (!cid) {
      inst.consecutiveFailures = 0;
      updatePaneView(inst, getUnresolvedSnapshot(), true);
      scheduleNextPaneSync(inst, 5000);
      return;
    }

    // 优先级 3：后台静默校验（SWR + In-Flight 合并请求 + 分屏独立序列号防乱序与离线稳态守卫）
    const seq = ++inst.fetchSeq;
    let data = null;
    try {
      const modelHint = extractPaneModelHint(inst.box, inst.model);
      inst.lastModelHint = modelHint;
      // 历史会话的纯下拉变化只更新 fallback 提示；force 仅由真实 agent 状态变化等调用方显式触发
      const reqOptions = modelHint ? { ...syncOptions, fallbackModel: modelHint } : syncOptions;
      data = await fetchSnapshotDeduped(cid, reqOptions);
    } catch {
      // 网络或桥接异常交由下方离线守卫处理
    }

    try {
      // 架构解耦 1：缓存写入控制（任何分屏拉回的有效数据校验 cid 匹配后立即写入缓存）
      const returnedCid = (data?.cid || data?.conversationId || '').toLowerCase();
      const isCidMismatch = !!(returnedCid && returnedCid !== cid.toLowerCase());

      if (data && data.ready && !isCidMismatch) {
        setCachedSnapshot(cid, data);
        refreshSideQuestionDraftPreviews(cid);
      }

      // 架构解耦 2：分屏独立 UI 更新控制
      if (!inst.box?.isConnected || !paneInstances.has(inst.box)) return;
      if (seq !== inst.fetchSeq) return;
      const currentTotal = paneInstances.size || 1;
      if (getActiveConversationId(inst.box, currentTotal) !== cid) return;
      if (isDraftView(inst.box, currentTotal)) return;

      if (data && data.ready && !isCidMismatch) {
        inst.consecutiveFailures = 0;
        updatePaneView(inst, getCachedSnapshot(cid) || data);
      } else {
        inst.consecutiveFailures++;
        const isCurrentDataValid = inst.currentData &&
          inst.currentData.ready &&
          !inst.currentData.isPending &&
          !inst.currentData.isDraft &&
          (!inst.currentData.conversationId || inst.currentData.conversationId.toLowerCase() === cid.toLowerCase());
        const fallbackSnap = getCachedSnapshot(cid) ||
          (isCurrentDataValid ? inst.currentData : null) ||
          getFiberQuickEstimate(inst.box, cid, inst.model);
        if (fallbackSnap) {
          if (!inst.currentData || !inst.currentData.ready || inst.currentData.isPending || inst.currentData.isDraft) {
            updatePaneView(inst, fallbackSnap);
          }
          updatePaneView(inst, { ready: false, offline: true });
        } else {
          updatePaneView(inst, {
            ready: true,
            isPending: true,
            ratio: 0.15,
            tooltip: '正在等待上下文服务响应 (离线)...'
          });
        }
      }
    } finally {
      // 在最新失败计数结算后调度；所有提前返回也统一经过这里，确保恰好一次且不残留旧闹钟
      scheduleNextPaneSync(inst);
    }
  }

  function positionPaneTooltip(inst) {
    const root = inst?.root;
    const tip = root?.getElementById('tooltip');
    const ring = root?.getElementById('ring-container');
    const arrow = root?.querySelector('.tooltip-arrow');
    if (!tip || !ring || tip.hidden) return;

    const rect = ring.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();

    const rawLeft = rect.left + (rect.width / 2) - (tipRect.width / 2);
    const top = rect.top - tipRect.height - 8;

    const clampedLeft = Math.max(8, Math.min(rawLeft, window.innerWidth - tipRect.width - 8));
    tip.style.left = `${clampedLeft}px`;
    tip.style.top = `${Math.max(8, top)}px`;

    if (arrow && tipRect.width > 0) {
      const ringCenterX = rect.left + (rect.width / 2);
      const arrowRelX = ringCenterX - clampedLeft;
      const safeArrowX = Math.max(12, Math.min(arrowRelX, tipRect.width - 12));
      arrow.style.left = `${safeArrowX}px`;
    }
  }

  function destroyPaneInstance(inst) {
    if (!inst) return;
    if (inst.pollTimer) {
      clearTimeout(inst.pollTimer);
      inst.pollTimer = null;
    }
    if (inst.agentStateDebounceTimer) {
      clearTimeout(inst.agentStateDebounceTimer);
      inst.agentStateDebounceTimer = null;
    }
    if (inst.disposeAgentState) {
      try { inst.disposeAgentState(); } catch {}
      inst.disposeAgentState = null;
    }
    inst.node?.remove();
    inst.node = null;
    inst.root = null;
    if (inst.box) {
      paneInstances.delete(inst.box);
    }
  }

  function mountOrUpdatePane(comp, totalPanes) {
    if (!comp || !comp.box) return null;
    try {
      const { box, editor, model = null } = comp;
      // 容器探测防越界：若 model 自身带 flex-1，closest('.flex-1') 会匹配到自身；必须从 parentElement 开始向上找且限制在 box 内部，杜绝误匹配最外层 box 容器
      const candidateContainer = model ? model.parentElement?.closest?.('.flex-1') : null;
      const flexContainer = model
        ? ((candidateContainer && candidateContainer !== box && box?.contains?.(candidateContainer))
          ? candidateContainer
          : (model.parentElement || box))
        : null;

      let modelBranch = model;
      while (modelBranch && modelBranch.parentElement && modelBranch.parentElement !== flexContainer && modelBranch.parentElement !== box && modelBranch.parentElement !== (typeof document !== 'undefined' ? document.body : null)) {
        modelBranch = modelBranch.parentElement;
      }

      // 当 hideModelSelector=true 无模型按钮时（如 /btw 侧边栏），查找底部工具栏左侧容器或发送按钮作为降级挂载锚点
      const footerLeft = !model
        ? (box.querySelector?.('.agy-composer-footer .flex-1') || box.querySelector?.('.agy-composer-footer') || null)
        : null;
      const sendBtn = !model
        ? (box.querySelector?.('[data-testid="send-button"], [data-testid="send-button-loading"], [data-testid="send-button-pending"]') || null)
        : null;

    let inst = paneInstances.get(box);
    let modelHintChanged = false;
    if (inst) {
      inst.editor = editor;
      inst.model = model;
      const currentModelHint = extractPaneModelHint(box, model);
      modelHintChanged = currentModelHint !== inst.lastModelHint;
      inst.lastModelHint = currentModelHint;
      // 短路守卫：若该分屏圆环节点已挂载在预期锚点，仅确保监听存活，跳过 DOM 重建
      const isAnchored = model
        ? Boolean(
            inst.node &&
            inst.node.isConnected &&
            (flexContainer?.contains(inst.node) || box?.contains(inst.node)) &&
            (inst.node.previousElementSibling === modelBranch || inst.node.previousElementSibling === model)
          )
        : Boolean(
            inst.node &&
            inst.node.isConnected &&
            box?.contains?.(inst.node) &&
            (!footerLeft || typeof footerLeft.contains !== 'function' || footerLeft.contains(inst.node))
          );
      if (isAnchored) {
        bindPaneAgentStateListener(inst);
        if (modelHintChanged) {
          if (isDraftView(box, totalPanes)) {
            inst.lastConversationId = null;
            inst.consecutiveFailures = 0;
            updatePaneView(inst, getDraftSnapshot(box, model));
            scheduleNextPaneSync(inst, 5000);
          } else {
            syncPaneState(inst);
          }
        }
        return inst;
      }
      inst.node?.remove();
    } else {
      inst = {
        box,
        editor,
        model,
        node: null,
        root: null,
        currentData: null,
        lastConversationId: null,
        lastModelHint: extractPaneModelHint(box, model),
        fetchSeq: 0,
        consecutiveFailures: 0,
        pollTimer: null,
        agentStateDebounceTimer: null,
        subscribedProvider: null,
        disposeAgentState: null
      };
      paneInstances.set(box, inst);
    }

    const node = document.createElement('div');
    node.id = ID;
    node.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;height:24px;margin-left:6px;vertical-align:middle;position:relative;z-index:10;flex-shrink:0;';

    const root = node.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host {
          --ring-track: rgba(128, 128, 128, 0.22);
          --ring-bar: #3b82f6;
          --tip-bg: #2b2b2b;
          --tip-fg: #f3f4f6;
          box-sizing: border-box;
          user-select: none;
        }
        @media (prefers-color-scheme: light) {
          :host {
            --ring-track: rgba(0, 0, 0, 0.12);
            --ring-bar: #2563eb;
            --tip-bg: #1f2937;
            --tip-fg: #ffffff;
          }
        }
        .ring-box {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          cursor: default;
          position: relative;
          user-select: none;
          -webkit-user-select: none;
        }
        .context-ring {
          width: 18px;
          height: 18px;
          transform: rotate(-90deg);
          display: block;
          pointer-events: none;
        }
        .ring-svg {
          width: 100%;
          height: 100%;
          pointer-events: none;
        }
        .ring-bg {
          fill: none;
          stroke: var(--ring-track);
          stroke-width: 1.9;
        }
        .ring-bar {
          fill: none;
          stroke: var(--ring-bar);
          stroke-width: 1.9;
          stroke-linecap: round;
          transition: stroke-dashoffset 240ms ease, stroke 300ms ease, opacity 200ms ease;
        }
        .context-ring.unready .ring-bar {
          opacity: 0;
        }
        /* 悬停气泡浮层 - 严格还原截图深灰圆角小胶囊与小三角 */
        .tooltip {
          position: fixed;
          background: var(--tip-bg);
          color: var(--tip-fg);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
          font-size: 12px;
          line-height: 1.4;
          font-weight: 450;
          padding: 4px 10px;
          border-radius: 12px;
          white-space: nowrap;
          pointer-events: none;
          z-index: 2147483647;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.28);
          animation: tip-fade-in 120ms ease-out;
        }
        .tooltip[hidden] {
          display: none;
        }
        .tooltip-arrow {
          position: absolute;
          bottom: -5px;
          left: 50%;
          transform: translateX(-50%);
          width: 0;
          height: 0;
          border-left: 5px solid transparent;
          border-right: 5px solid transparent;
          border-top: 5px solid var(--tip-bg);
          transition: left 120ms ease;
        }
        @keyframes tip-fade-in {
          from { opacity: 0; transform: translateY(3px); }
          to { opacity: 1; transform: translateY(0); }
        }
      </style>
      <div class="ring-box" id="ring-container">
        <div class="context-ring unready" id="context-ring">
          <svg class="ring-svg" viewBox="0 0 18 18">
            <circle class="ring-bg" cx="9" cy="9" r="7.25" />
            <circle class="ring-bar" id="ring-bar" cx="9" cy="9" r="7.25" />
          </svg>
        </div>
        <div class="tooltip" id="tooltip" hidden>
          <span id="tooltip-text">已用上下文</span>
          <div class="tooltip-arrow"></div>
        </div>
      </div>
    `;

    inst.node = node;
    inst.root = root;

    const container = root.getElementById('ring-container');
    const tooltip = root.getElementById('tooltip');

    container.addEventListener('pointerenter', () => {
      tooltip.hidden = false;
      positionPaneTooltip(inst);
    });

    container.addEventListener('pointerleave', () => {
      tooltip.hidden = true;
    });

    const blockInteraction = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    for (const evt of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      node.addEventListener(evt, blockInteraction);
      container.addEventListener(evt, blockInteraction);
    }

    if (editor && !editor.__agRingBound) {
      editor.__agRingBound = true;
      const onFocus = () => {
        const targetInst = paneInstances.get(box);
        if (targetInst) syncPaneState(targetInst);
      };
      editor.__agRingFocusHandler = onFocus;
      editor.addEventListener('focus', onFocus, { passive: true });
      boundEditors.add(editor);
    }

    bindPaneAgentStateListener(inst);

    // 挂载初态同步：在插入 DOM 前完成初态计算与渲染，杜绝任何满环首帧闪烁与回流动画
    if (isDraftView(box, totalPanes)) {
      inst.lastConversationId = null;
      inst.currentData = null;
      updatePaneView(inst, getDraftSnapshot(box, model), true);
    } else {
      const cid = getActiveConversationId(box, totalPanes);
      if (!cid) {
        inst.lastConversationId = null;
        inst.currentData = null;
        updatePaneView(inst, getUnresolvedSnapshot(), true);
      } else {
        inst.lastConversationId = cid;
        const cached = getCachedSnapshot(cid);
        if (cached) {
          updatePaneView(inst, cached, true);
        } else {
          const fiberEst = getFiberQuickEstimate(box, cid, model);
          if (fiberEst) {
            updatePaneView(inst, fiberEst, true);
          } else {
            updatePaneView(inst, {
              ready: true,
              isPending: true,
              ratio: 0.15,
              tooltip: '正在同步上下文进度...'
            }, true);
          }
        }
      }
    }

    try {
      if (model && flexContainer && modelBranch && modelBranch.parentElement === flexContainer) {
        flexContainer.insertBefore(node, modelBranch.nextSibling);
      } else if (model && model.parentElement) {
        model.parentElement.insertBefore(node, model.nextSibling);
      } else if (footerLeft) {
        if (sendBtn && sendBtn.parentElement === footerLeft && typeof footerLeft.insertBefore === 'function') {
          footerLeft.insertBefore(node, sendBtn);
        } else if (typeof footerLeft.appendChild === 'function') {
          footerLeft.appendChild(node);
        }
      } else if (sendBtn && sendBtn.parentElement && box?.contains?.(sendBtn)) {
        sendBtn.parentElement.insertBefore(node, sendBtn);
      } else if (typeof box.appendChild === 'function') {
        box.appendChild(node);
      }
    } catch {}

    // 新挂载或重挂载分屏立即触发一次普通后台校准；历史分母由真实轨迹驱动，草稿直接本地重算
    syncPaneState(inst);
    return inst;
  } catch {
    return null;
  }
}

  function mount() {
    const composers = findAllComposers();
    const activeBoxes = new Set(composers.map(c => c.box));

    // 1. 回收已关闭或隐藏的分屏实例
    for (const [box, inst] of Array.from(paneInstances.entries())) {
      if (!activeBoxes.has(box) || !box.isConnected) {
        destroyPaneInstance(inst);
      }
    }

    // 2. 为所有可见分屏对等挂载或更新圆环实例（带单个分屏挂载异常隔离防御）
    for (const comp of composers) {
      try {
        mountOrUpdatePane(comp, composers.length);
      } catch {}
    }

    // 3. 清理不属于任何活跃分屏实例的残留孤儿节点
    const validNodes = new Set(Array.from(paneInstances.values()).map(i => i.node).filter(Boolean));
    for (const orphan of document.querySelectorAll('#' + ID)) {
      if (!validNodes.has(orphan)) orphan.remove();
    }
  }

  function handleInstantPaneSync(inst, force = false) {
    if (!inst || !inst.box?.isConnected) return;
    inst.consecutiveFailures = 0;
    syncPaneState(inst, force ? { force: true } : {});
  }

  // 全局视口激活感知：遍历同步所有可见分屏实例（相同会话自动通过 fetchSnapshotDeduped 合并请求）
  const handleInstantSync = (force = false) => {
    for (const inst of paneInstances.values()) {
      handleInstantPaneSync(inst, force);
    }
  };
  const handleWindowPassiveSync = () => handleInstantSync(false);
  const handleVisibilityChange = () => {
    if (!document.hidden) handleInstantSync(false);
  };
  const handleGlobalFocusIn = (e) => {
    const target = e.target;
    if (!target) return;
    const targetBox = target.closest?.('[data-testid="agent-input-box"]') ||
      target.closest?.('[data-testid="side-question-tab-composer"], [data-side-panel-composer]');
    if (targetBox) {
      if (!paneInstances.has(targetBox)) {
        mount();
      }
      const inst = paneInstances.get(targetBox);
      if (inst) {
        handleInstantPaneSync(inst, false);
      }
    }
  };

  window.addEventListener('focus', handleWindowPassiveSync);
  window.addEventListener('popstate', handleWindowPassiveSync);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  document.addEventListener('focusin', handleGlobalFocusIn, { passive: true });

  // DOM 观察与自愈巡检（带 120ms 防抖节流，杜绝大模型打字流式输出时的高频 CPU 冲刷）
  const observer = new MutationObserver(() => {
    if (mountDebounceTimer) return;
    mountDebounceTimer = setTimeout(() => {
      mountDebounceTimer = null;
      mount();
    }, 120);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  mount();

  window.__agContextRingInstalled = true;

  window.__agContextRingDispose = () => {
    if (mountDebounceTimer) {
      clearTimeout(mountDebounceTimer);
      mountDebounceTimer = null;
    }
    delete window.__agContextRingMetrics;
    observer.disconnect();
    window.removeEventListener('focus', handleWindowPassiveSync);
    window.removeEventListener('popstate', handleWindowPassiveSync);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    document.removeEventListener('focusin', handleGlobalFocusIn);
    for (const ed of boundEditors) {
      if (ed?.__agRingFocusHandler) {
        ed.removeEventListener('focus', ed.__agRingFocusHandler);
        delete ed.__agRingFocusHandler;
        delete ed.__agRingBound;
      }
    }
    boundEditors.clear();
    for (const inst of Array.from(paneInstances.values())) {
      destroyPaneInstance(inst);
    }
    paneInstances.clear();
    delete window.__agContextRingInstalled;
    delete window.__agContextRingDispose;
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = installAgContextRingWidget;
  module.exports.MemoryLRUCache = __agRingCacheModule.MemoryLRUCache;
  module.exports.normalizeSnapshotSchema = __agRingCacheModule.normalizeSnapshotSchema;
  module.exports.shouldAcceptSnapshot = __agRingCacheModule.shouldAcceptSnapshot;
  module.exports.sanitizeLRUIndex = __agRingCacheModule.sanitizeLRUIndex;
  module.exports.inferClientModelLimit = __agRingCacheModule.inferClientModelLimit;
  module.exports.updateClientModelLimits = __agRingCacheModule.updateClientModelLimits;
  module.exports.clearClientModelLimits = __agRingCacheModule.clearClientModelLimits;
  module.exports.normalizeClientModelKey = __agRingCacheModule.normalizeClientModelKey;
  module.exports.getRingColor = __agRingCacheModule.getRingColor;
}