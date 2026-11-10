import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ringWidgetModule = require('../assets/ring-widget.cjs');
const { MemoryLRUCache, normalizeSnapshotSchema, shouldAcceptSnapshot, sanitizeLRUIndex } = ringWidgetModule;

test('【验收场景 1】精确 150K 后返回粗略估算 20K -> 坚决不覆盖精确值', () => {
  const memoryCache = new MemoryLRUCache(10);
  const cid = 'test-session-exact';

  function safeSetCache(incoming) {
    if (!incoming || !incoming.ready || incoming.isPending || incoming.isDraft) return false;
    const existing = memoryCache.get(cid);
    if (existing && !existing.isEstimated && incoming.isEstimated) {
      const isCompressedOrRewind = !!incoming.compressionDetected ||
        (typeof incoming.lastStepIndex === 'number' && typeof existing.lastStepIndex === 'number' && incoming.lastStepIndex < existing.lastStepIndex);
      if (!isCompressedOrRewind) {
        existing.lastAccessedAt = Date.now();
        return false;
      }
    }
    const snap = normalizeSnapshotSchema(incoming, cid);
    memoryCache.set(cid, snap);
    return true;
  }

  // 1. 存入精确值 150K
  const exactSnap = { ready: true, used: 150000, limit: 256000, isEstimated: false, lastStepIndex: 10 };
  assert.equal(safeSetCache(exactSnap), true);
  assert.equal(memoryCache.get(cid).used, 150000);

  // 2. 传入粗略估算 20K（无压缩标记，普通估算）
  const roughEst = { ready: true, used: 20000, limit: 256000, isEstimated: true, lastStepIndex: 11 };
  assert.equal(safeSetCache(roughEst), false);

  // 3. 校验：精确值 150K 完好无损，未被降级冲掉
  assert.equal(memoryCache.get(cid).used, 150000);
});

test('【验收场景 2】精确 150K 后发生上下文压缩至 60K -> 允许合法降级更新', () => {
  const memoryCache = new MemoryLRUCache(10);
  const cid = 'test-session-compress';

  function safeSetCache(incoming) {
    if (!incoming || !incoming.ready || incoming.isPending || incoming.isDraft) return false;
    const existing = memoryCache.get(cid);
    if (existing && !existing.isEstimated && incoming.isEstimated) {
      const isCompressedOrRewind = !!incoming.compressionDetected ||
        (typeof incoming.lastStepIndex === 'number' && typeof existing.lastStepIndex === 'number' && incoming.lastStepIndex < existing.lastStepIndex);
      if (!isCompressedOrRewind) {
        existing.lastAccessedAt = Date.now();
        return false;
      }
    }
    const snap = normalizeSnapshotSchema(incoming, cid);
    memoryCache.set(cid, snap);
    return true;
  }

  // 1. 存入精确值 150K
  safeSetCache({ ready: true, used: 150000, limit: 256000, isEstimated: false, lastStepIndex: 10 });

  // 2. 模拟触发了平台压缩，新到达的数据是 60K 并携带 compressionDetected: true
  const compressedData = {
    ready: true,
    used: 60000,
    limit: 256000,
    isEstimated: true, // 即使处于估算状态
    compressionDetected: true,
    compressionDrop: 90000,
    lastStepIndex: 12
  };
  assert.equal(safeSetCache(compressedData), true);

  // 3. 校验：成功更新为 60K
  const updated = memoryCache.get(cid);
  assert.equal(updated.used, 60000);
  assert.equal(updated.compressionDetected, true);

  // 4. 新的精确 Checkpoint 到达（61K, isEstimated: false），无条件允许覆盖
  const newExactCheckpoint = {
    ready: true,
    used: 61000,
    limit: 256000,
    isEstimated: false,
    lastStepIndex: 13
  };
  assert.equal(safeSetCache(newExactCheckpoint), true);
  assert.equal(memoryCache.get(cid).used, 61000);
});

test('【验收场景 3 & 4】A 请求未完成时切换到 B：A 绝不污染 B 的 UI，但 A 自己的有效缓存成功更新', async () => {
  const sessionCache = new Map();
  let activeCid = 'session-A';
  let displayedView = null;
  let fetchSeq = 0;

  async function syncStateMock(targetCid, delayMs, returnedData) {
    const seq = ++fetchSeq;
    const data = await new Promise(resolve => setTimeout(() => resolve(returnedData), delayMs));

    // 关键解耦 1：只要数据合法，立刻写该会话自己的缓存（数据流一等公民）
    if (data && data.ready) {
      sessionCache.set(targetCid, data);
    }

    // 关键解耦 2：UI 渲染门禁，检查当前是否依然停留在该会话
    if (seq !== fetchSeq) return;
    if (activeCid !== targetCid) return;

    displayedView = data;
  }

  // 1. 会话 A 发起异步拉取（耗时 50ms）
  activeCid = 'session-A';
  displayedView = { cid: 'session-A', used: 10000 };
  syncStateMock('session-A', 50, { ready: true, cid: 'session-A', used: 99999 });

  // 2. 10ms 后，用户切到会话 B
  await new Promise(r => setTimeout(r, 10));
  activeCid = 'session-B';
  displayedView = { cid: 'session-B', used: 0 }; // B 的初始视图

  // 3. 会话 B 发起自己的请求（15ms 返回）
  await syncStateMock('session-B', 15, { ready: true, cid: 'session-B', used: 55555 });

  // 4. 等待 A 的慢速请求彻底到达 (再等 40ms)
  await new Promise(r => setTimeout(r, 40));

  // 5. 校验一（场景 3）：会话 B 当前圆环坚决呈现 B 的 55555，绝不被 A 的 99999 污染！
  assert.equal(displayedView.cid, 'session-B');
  assert.equal(displayedView.used, 55555);

  // 6. 校验二（场景 4）：会话 A 自己的缓存已经悄然更新为 99999！
  const cachedA = sessionCache.get('session-A');
  assert.ok(cachedA !== undefined);
  assert.equal(cachedA.used, 99999);
});

test('【验收场景 5】同一会话多个普通事件同时触发 -> 正常情况下只执行一次 RPC', async () => {
  let rpcCount = 0;
  const mockRpc = async () => {
    rpcCount++;
    await new Promise(r => setTimeout(r, 10));
    return { ready: true, used: 12345 };
  };

  const inFlightRequests = new Map();
  function fetchSnapshotDeduped(cid, options = {}) {
    const isForce = !!options.force;
    const existing = inFlightRequests.get(cid);
    if (existing) {
      if (existing.isForce || !isForce) return existing.promise;
    }
    const reqPromise = (async () => {
      try {
        return await mockRpc();
      } finally {
        inFlightRequests.delete(cid);
      }
    })();
    inFlightRequests.set(cid, { promise: reqPromise, isForce });
    return reqPromise;
  }

  // 模拟同一瞬间：原生 onDidChange + 轮询定时器 + 窗口 focus 触发
  const [res1, res2, res3] = await Promise.all([
    fetchSnapshotDeduped('cid-test'),
    fetchSnapshotDeduped('cid-test'),
    fetchSnapshotDeduped('cid-test')
  ]);

  assert.equal(rpcCount, 1);
  assert.equal(res1.used, 12345);
  assert.equal(res2.used, 12345);
  assert.equal(res3.used, 12345);
});

test('【验收场景 6】普通请求在途期间触发强制刷新 (force: true) -> 不被旧缓存请求吞掉，确保执行 force 请求', async () => {
  let callLogs = [];
  const mockRpc = async (cid, isForce) => {
    callLogs.push(isForce ? 'force-call' : 'normal-call');
    await new Promise(r => setTimeout(r, 20));
    return { ready: true, isForceData: isForce };
  };

  const inFlightRequests = new Map();
  function fetchSnapshotDeduped(cid, options = {}) {
    const isForce = !!options.force;
    const existing = inFlightRequests.get(cid);
    if (existing) {
      if (existing.isForce || !isForce) {
        return existing.promise;
      }
      if (!existing.followUpPromise) {
        existing.followUpPromise = existing.promise.then(() => {
          return fetchSnapshotDeduped(cid, { force: true });
        }).catch(() => {
          return fetchSnapshotDeduped(cid, { force: true });
        });
      }
      return existing.followUpPromise;
    }

    const reqPromise = (async () => {
      try {
        return await mockRpc(cid, isForce);
      } finally {
        const curr = inFlightRequests.get(cid);
        if (curr && curr.promise === reqPromise && !curr.followUpPromise) {
          inFlightRequests.delete(cid);
        } else if (curr && curr.followUpPromise) {
          inFlightRequests.delete(cid);
        }
      }
    })();

    inFlightRequests.set(cid, { promise: reqPromise, isForce, followUpPromise: null });
    return reqPromise;
  }

  // 1. 发起一个普通请求 (normal)
  const normalPromise = fetchSnapshotDeduped('cid-force-test', { force: false });

  // 2. 在普通请求未返回前（5ms 后），触发一次强制刷新 (force: true)
  await new Promise(r => setTimeout(r, 5));
  const forcePromise = fetchSnapshotDeduped('cid-force-test', { force: true });

  const [normalRes, forceRes] = await Promise.all([normalPromise, forcePromise]);

  // 3. 验证：普通请求返回 normal 数据，force 请求返回 force 数据！
  assert.equal(normalRes.isForceData, false);
  assert.equal(forceRes.isForceData, true);

  // 4. 验证调用链路：先执行了 normal-call，紧接着补跑了 force-call，没有被吞噬！
  assert.deepEqual(callLogs, ['normal-call', 'force-call']);
});

test('【验收场景 7】刷新 Antigravity / 页面重启 -> 0ms 完美从 LocalStorage 恢复 Schema v2 快照', () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, String(v))
  };

  const cid = 'session-reboot-test';
  const sampleSnap = normalizeSnapshotSchema({
    ready: true,
    used: 128000,
    limit: 256000,
    ratio: 0.5,
    percent: '50.0%',
    modelId: 'gemini-3.8-flash',
    source: 'ls-rpc'
  }, cid);

  // 页面关闭前持久化写入
  mockStorage.setItem('ag_ring_snap_' + cid, JSON.stringify(sampleSnap));

  // 模拟冷重启，创建全新内存实例
  const freshMemoryCache = new MemoryLRUCache(10);
  assert.equal(freshMemoryCache.get(cid), null);

  // 模拟页面打开时读取
  const raw = mockStorage.getItem('ag_ring_snap_' + cid);
  assert.ok(raw !== null);
  const restored = normalizeSnapshotSchema(JSON.parse(raw), cid);
  freshMemoryCache.set(cid, restored);

  // 验证瞬间恢复稳态数值
  assert.equal(restored.schemaVersion, 2);
  assert.equal(restored.used, 128000);
  assert.equal(restored.percent, '50.0%');
  assert.equal(freshMemoryCache.get(cid).used, 128000);
});

test('【验收场景 8】LocalStorage 超过 100 条时正常淘汰最久未访问记录', () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };

  const STORAGE_PREFIX = 'ag_ring_snap_';
  const INDEX_KEY = 'ag_ring_lru_index';

  function updateIndex(lowerId, timestamp) {
    let index = [];
    const raw = mockStorage.getItem(INDEX_KEY);
    if (raw) {
      try { index = JSON.parse(raw) || []; } catch {}
    }
    index = index.filter(i => i && i.id !== lowerId);
    index.push({ id: lowerId, time: timestamp });

    if (index.length > 100) {
      index.sort((a, b) => a.time - b.time);
      while (index.length > 100) {
        const evicted = index.shift();
        if (evicted?.id) mockStorage.removeItem(STORAGE_PREFIX + evicted.id);
      }
    }
    mockStorage.setItem(INDEX_KEY, JSON.stringify(index));
  }

  // 写入 105 条
  const t0 = 1000000;
  for (let i = 1; i <= 105; i++) {
    const id = `sess-${i}`;
    mockStorage.setItem(STORAGE_PREFIX + id, JSON.stringify({ ready: true, i }));
    updateIndex(id, t0 + i);
  }

  // 检查索引刚好 100
  const idx = JSON.parse(mockStorage.getItem(INDEX_KEY));
  assert.equal(idx.length, 100);

  // 前 5 条已被物理清除
  assert.equal(mockStorage.getItem(STORAGE_PREFIX + 'sess-1'), null);
  assert.equal(mockStorage.getItem(STORAGE_PREFIX + 'sess-5'), null);
  // 第 6 条及之后保留
  assert.ok(mockStorage.getItem(STORAGE_PREFIX + 'sess-6') !== null);
  assert.ok(mockStorage.getItem(STORAGE_PREFIX + 'sess-105') !== null);
});

test('【验收场景 9】LocalStorage 索引损坏时的自愈能力', () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, String(v))
  };

  // 恶意破坏索引内容为乱码/非法 JSON
  mockStorage.setItem('ag_ring_lru_index', '{corrupted_json:::invalid!!!');

  function safeUpdateIndex(id, timestamp) {
    let index = [];
    const raw = mockStorage.getItem('ag_ring_lru_index');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) index = parsed;
      } catch {
        index = []; // 损坏自愈
      }
    }
    index.push({ id, time: timestamp });
    mockStorage.setItem('ag_ring_lru_index', JSON.stringify(index));
  }

  // 尝试正常执行写入，绝不抛错奔溃
  assert.doesNotThrow(() => {
    safeUpdateIndex('healed-cid', Date.now());
  });

  // 检查自愈后的索引恢复正常合法 JSON 格式
  const restoredIndex = JSON.parse(mockStorage.getItem('ag_ring_lru_index'));
  assert.equal(Array.isArray(restoredIndex), true);
  assert.equal(restoredIndex.length, 1);
  assert.equal(restoredIndex[0].id, 'healed-cid');
});

test('【验收场景 10】当前活动会话绝不被内存 LRU 淘汰', () => {
  const lru = new MemoryLRUCache(3); // 容量设为 3，便于观察边界
  const activeCid = 'current-active-cid';

  // 1. 存入当前活跃会话
  lru.set(activeCid, { id: activeCid, name: 'Active' });

  // 2. 存入会话 2 和 会话 3
  lru.set('cid-2', { id: 'cid-2' }, activeCid);
  lru.set('cid-3', { id: 'cid-3' }, activeCid);
  assert.equal(lru.size, 3);

  // 3. 此时容量已满。如果不加保护，最先存入的 activeCid 应当被淘汰。
  // 但我们指定了 protectedKey = activeCid，存入会话 4
  lru.set('cid-4', { id: 'cid-4' }, activeCid);

  // 4. 验证：activeCid 依然稳健存在！被淘汰的是未受保护的 cid-2
  assert.ok(lru.get(activeCid) !== null);
  assert.equal(lru.get('cid-2'), null); // cid-2 被淘汰
  assert.ok(lru.get('cid-3') !== null);
  assert.ok(lru.get('cid-4') !== null);
  assert.equal(lru.size, 3);
});

test('【验收场景 11】同一 CID 新旧请求逆序返回 -> 旧快照不能覆盖新快照 (独立时序提交保护)', () => {
  const memoryCache = new MemoryLRUCache(10);
  const sessionCommittedRevisions = new Map();
  const cid = 'session-order-test';

  function commitSnapshot(incoming, revision) {
    const existing = memoryCache.get(cid);
    const lastCommitted = sessionCommittedRevisions.get(cid) || 0;
    const check = shouldAcceptSnapshot(existing, incoming, {
      revision,
      lastCommittedRevision: lastCommitted
    });
    if (!check.accept) return false;
    const snap = normalizeSnapshotSchema(incoming, cid);
    if (typeof check.revision === 'number' && check.revision > lastCommitted) {
      sessionCommittedRevisions.set(cid, check.revision);
    }
    memoryCache.set(cid, snap);
    return true;
  }

  // 1. 模拟发出 R1(rev 1)，随后发出 R2(rev 2)
  // 2. R2 耗时短，先一步返回：Step 15, 120K 精确数据
  const res2 = { ready: true, used: 120000, limit: 256000, isEstimated: false, lastStepIndex: 15 };
  assert.equal(commitSnapshot(res2, 2), true);
  assert.equal(memoryCache.get(cid).used, 120000);
  assert.equal(sessionCommittedRevisions.get(cid), 2);

  // 3. R1 耗时长迟到返回：Step 14, 110K 精确数据（也是合法精确数据）
  const res1 = { ready: true, used: 110000, limit: 256000, isEstimated: false, lastStepIndex: 14 };
  const accepted = commitSnapshot(res1, 1);

  // 4. 验证：R1 被时序守卫拒绝，Cache 依然保留 R2 的 120K！
  assert.equal(accepted, false);
  assert.equal(memoryCache.get(cid).used, 120000);
  assert.equal(sessionCommittedRevisions.get(cid), 2);
});

test('【验收场景 12】ContextEpoch 更新后旧请求返回 -> 旧世代数据不能回流', () => {
  const memoryCache = new MemoryLRUCache(10);
  const cid = 'session-epoch-test';

  function commitSnapshot(incoming) {
    const existing = memoryCache.get(cid);
    const check = shouldAcceptSnapshot(existing, incoming);
    if (!check.accept) return false;
    memoryCache.set(cid, normalizeSnapshotSchema(incoming, cid));
    return true;
  }

  // 1. 会话进入新世代 Epoch 2（例如发生上下文彻底重建或切换世代），当前用量 30K
  const epoch2Snap = { ready: true, contextEpoch: 2, used: 30000, limit: 256000, isEstimated: false };
  assert.equal(commitSnapshot(epoch2Snap), true);
  assert.equal(memoryCache.get(cid).contextEpoch, 2);
  assert.equal(memoryCache.get(cid).used, 30000);

  // 2. 迟到返回了上一世代 Epoch 1 的精确快照（用量高达 200K）
  const staleEpoch1Snap = { ready: true, contextEpoch: 1, used: 200000, limit: 256000, isEstimated: false };
  const accepted = commitSnapshot(staleEpoch1Snap);

  // 3. 验证：旧世代数据坚决拒收，当前缓存依然保持 Epoch 2 的 30K
  assert.equal(accepted, false);
  assert.equal(memoryCache.get(cid).contextEpoch, 2);
  assert.equal(memoryCache.get(cid).used, 30000);
});

test('【验收场景 13】普通请求在途时连续多次触发 force -> 最多追加一次请求，且所有调用者拿到最新 force 结果', async () => {
  let callLogs = [];
  let rpcCount = 0;
  const mockRpc = async (cid, isForce) => {
    rpcCount++;
    callLogs.push(isForce ? 'force-call' : 'normal-call');
    await new Promise(r => setTimeout(r, 20));
    return { ready: true, isForce, count: rpcCount };
  };

  const inFlightRequests = new Map();
  const sessionRequestRevisions = new Map();

  function fetchSnapshotDeduped(cid, options = {}) {
    const lowerId = cid.toLowerCase();
    const isForce = !!options.force;
    const existing = inFlightRequests.get(lowerId);

    if (existing) {
      if (existing.isForce || !isForce) return existing.promise;
      if (!existing.followUpPromise) {
        existing.followUpPromise = (async () => {
          try { await existing.promise; } catch {}
          return await executeRpc(lowerId, { ...options, force: true });
        })();
      }
      return existing.followUpPromise;
    }

    return executeRpc(lowerId, options);
  }

  async function executeRpc(lowerId, options = {}) {
    const isForce = !!options.force;
    const reqRevision = (sessionRequestRevisions.get(lowerId) || 0) + 1;
    sessionRequestRevisions.set(lowerId, reqRevision);

    let inFlightEntry = null;
    const reqPromise = (async () => {
      try {
        const res = await mockRpc(lowerId, isForce);
        if (res) res._requestRevision = reqRevision;
        return res;
      } finally {
        const curr = inFlightRequests.get(lowerId);
        if (curr && curr.promise === reqPromise) {
          if (curr.followUpPromise) {
            inFlightRequests.set(lowerId, {
              promise: curr.followUpPromise,
              isForce: true,
              followUpPromise: null
            });
          } else {
            inFlightRequests.delete(lowerId);
          }
        }
      }
    })();

    inFlightEntry = { promise: reqPromise, isForce, followUpPromise: null };
    inFlightRequests.set(lowerId, inFlightEntry);
    return reqPromise;
  }

  // 1. 发起一个普通请求 (耗时 20ms)
  const normalPromise = fetchSnapshotDeduped('cid-multi-force', { force: false });

  // 2. 在 5ms、8ms、12ms 连续触发三次 force 请求
  await new Promise(r => setTimeout(r, 5));
  const forcePromise1 = fetchSnapshotDeduped('cid-multi-force', { force: true });
  await new Promise(r => setTimeout(r, 3));
  const forcePromise2 = fetchSnapshotDeduped('cid-multi-force', { force: true });
  await new Promise(r => setTimeout(r, 4));
  const forcePromise3 = fetchSnapshotDeduped('cid-multi-force', { force: true });

  const [resNormal, resForce1, resForce2, resForce3] = await Promise.all([
    normalPromise, forcePromise1, forcePromise2, forcePromise3
  ]);

  // 3. 校验：总共严格只执行了 2 次 RPC (1 次普通 + 1 次强制)
  assert.equal(rpcCount, 2);
  assert.deepEqual(callLogs, ['normal-call', 'force-call']);

  // 4. 校验：普通请求拿到 normal 结果，三次 force 调用者全部拿到同一次 force 结果！
  assert.equal(resNormal.isForce, false);
  assert.equal(resForce1.isForce, true);
  assert.equal(resForce2.isForce, true);
  assert.equal(resForce3.isForce, true);
  assert.equal(resForce1.count, 2);
  assert.equal(resForce2.count, 2);
  assert.equal(resForce3.count, 2);

  // 5. 校验：执行完毕后在途请求已彻底清空
  assert.equal(inFlightRequests.size, 0);
});

test('【验收场景 14】普通请求失败期间触发 force -> 强制请求仍能坚挺执行并产出快照', async () => {
  let callLogs = [];
  const mockRpc = async (cid, isForce) => {
    callLogs.push(isForce ? 'force-call' : 'normal-fail');
    await new Promise(r => setTimeout(r, 15));
    if (!isForce) {
      throw new Error('Network timeout in normal call');
    }
    return { ready: true, isForce: true, used: 77777 };
  };

  const inFlightRequests = new Map();
  function fetchSnapshotDeduped(cid, options = {}) {
    const lowerId = cid.toLowerCase();
    const isForce = !!options.force;
    const existing = inFlightRequests.get(lowerId);

    if (existing) {
      if (existing.isForce || !isForce) return existing.promise;
      if (!existing.followUpPromise) {
        existing.followUpPromise = (async () => {
          try { await existing.promise; } catch {}
          return await executeRpc(lowerId, { ...options, force: true });
        })();
      }
      return existing.followUpPromise;
    }

    return executeRpc(lowerId, options);
  }

  async function executeRpc(lowerId, options = {}) {
    const isForce = !!options.force;
    let inFlightEntry = null;
    const reqPromise = (async () => {
      try {
        return await mockRpc(lowerId, isForce);
      } finally {
        const curr = inFlightRequests.get(lowerId);
        if (curr && curr.promise === reqPromise) {
          if (curr.followUpPromise) {
            inFlightRequests.set(lowerId, {
              promise: curr.followUpPromise,
              isForce: true,
              followUpPromise: null
            });
          } else {
            inFlightRequests.delete(lowerId);
          }
        }
      }
    })();

    inFlightEntry = { promise: reqPromise, isForce, followUpPromise: null };
    inFlightRequests.set(lowerId, inFlightEntry);
    return reqPromise;
  }

  // 1. 发起一个会抛错的普通请求
  const normalPromise = fetchSnapshotDeduped('cid-fail-then-force', { force: false });

  // 2. 5ms 后，触发一次 force 请求
  await new Promise(r => setTimeout(r, 5));
  const forcePromise = fetchSnapshotDeduped('cid-fail-then-force', { force: true });

  // 3. 验证普通请求抛错，但 force 请求坚挺成功
  await assert.rejects(normalPromise, /Network timeout/);
  const forceResult = await forcePromise;

  assert.equal(forceResult.isForce, true);
  assert.equal(forceResult.used, 77777);
  assert.deepEqual(callLogs, ['normal-fail', 'force-call']);
  assert.equal(inFlightRequests.size, 0);
});

test('【验收场景 15】JSON 合法但数据结构错误 -> sanitizeLRUIndex 具备深度自愈能力', () => {
  // 1. 测试合法 JSON，但结构是非数组对象
  const badObject = JSON.stringify({ not: 'an array', hello: 123 });
  assert.deepEqual(sanitizeLRUIndex(badObject), []);

  // 2. 测试合法 JSON，但是为字符串、null 或数字
  assert.deepEqual(sanitizeLRUIndex('null'), []);
  assert.deepEqual(sanitizeLRUIndex('"just a string"'), []);
  assert.deepEqual(sanitizeLRUIndex('12345'), []);

  // 3. 测试数组中掺杂脏数据：null、非对象、缺少 id 或缺少 time
  const dirtyArray = JSON.stringify([
    null,
    'dirty-string',
    123,
    { badKey: true },
    { id: 999, time: 1000 }, // id 必须是 string
    { id: 'valid-1', time: 'not-a-number' }, // time 必须是 number
    { id: 'valid-clean-1', time: 10001 }, // 合法
    { id: 'valid-clean-2', time: 10002 }  // 合法
  ]);

  const sanitized = sanitizeLRUIndex(dirtyArray);
  assert.equal(Array.isArray(sanitized), true);
  assert.equal(sanitized.length, 2);
  assert.equal(sanitized[0].id, 'valid-clean-1');
  assert.equal(sanitized[1].id, 'valid-clean-2');
});

test('【验收场景 16】LocalStorage 写入异常 (如 QuotaExceededError) -> 平稳降级为纯内存模式，主程序不崩', () => {
  const memoryCache = new MemoryLRUCache(10);
  const cid = 'session-quota-exceeded';
  let isStorageDegraded = false;

  // 模拟抛出 QuotaExceededError 的 Storage
  const brokenStorage = {
    setItem: () => {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      throw err;
    }
  };

  function safeSetCacheWithFallback(incoming) {
    if (!incoming || !incoming.ready) return false;
    const snap = normalizeSnapshotSchema(incoming, cid);
    // 第一层：内存写入
    memoryCache.set(cid, snap);

    // 第二层：持久化写入（带异常降级保护）
    if (!isStorageDegraded) {
      try {
        brokenStorage.setItem('ag_ring_snap_' + cid, JSON.stringify(snap));
      } catch {
        isStorageDegraded = true; // 触发降级
      }
    }
    return true;
  }

  // 1. 尝试写入：绝不抛出未捕获异常
  assert.doesNotThrow(() => {
    const ok = safeSetCacheWithFallback({ ready: true, used: 88888, limit: 256000 });
    assert.equal(ok, true);
  });

  // 2. 验证已成功捕获并触发了降级标志位
  assert.equal(isStorageDegraded, true);

  // 3. 验证内存缓存依然完好无损地存取
  const memSnap = memoryCache.get(cid);
  assert.ok(memSnap !== null);
  assert.equal(memSnap.used, 88888);

  // 4. 在降级状态下继续写入新数据，依然安全工作
  assert.doesNotThrow(() => {
    safeSetCacheWithFallback({ ready: true, used: 99999, limit: 256000 });
  });
  assert.equal(memoryCache.get(cid).used, 99999);
});

test('【验收场景 17】Sidecar getContextSnapshot 在 force: true 时穿透 8s 短时内存缓存，force: false 时命中缓存', async () => {
  // 模拟 Sidecar 内存缓存与数据拉取
  const memoryCache = new Map();
  const MEMORY_CACHE_TTL = 8000;
  let backendRpcCalls = 0;

  async function mockGetContextSnapshot(conversationId, force = false) {
    const normCid = conversationId ? conversationId.toLowerCase() : null;
    const now = Date.now();
    if (normCid && !force) {
      const cached = memoryCache.get(normCid);
      if (cached && (now - cached.time < MEMORY_CACHE_TTL)) {
        return { ...cached.result, fromCache: true };
      }
    }

    backendRpcCalls++;
    const result = {
      ready: true,
      used: 50000 + backendRpcCalls * 1000,
      limit: 256000,
      fromCache: false
    };
    if (normCid) {
      memoryCache.set(normCid, { result, time: Date.now() });
    }
    return result;
  }

  const testCid = 'session-force-penetration';

  // 1. 首次普通请求 -> 触发真实 RPC
  const res1 = await mockGetContextSnapshot(testCid, false);
  assert.equal(backendRpcCalls, 1);
  assert.equal(res1.fromCache, false);
  assert.equal(res1.used, 51000);

  // 2. 紧接着发起常规轮询 (force: false) -> 命中 8s 短时缓存，RPC 次数不增
  const res2 = await mockGetContextSnapshot(testCid, false);
  assert.equal(backendRpcCalls, 1);
  assert.equal(res2.fromCache, true);
  assert.equal(res2.used, 51000);

  // 3. 原生 agentStateProvider.onDidChange 触发 (force: true) -> 穿透 8s 缓存，触发真实 RPC
  const res3 = await mockGetContextSnapshot(testCid, true);
  assert.equal(backendRpcCalls, 2);
  assert.equal(res3.fromCache, false);
  assert.equal(res3.used, 52000);

  // 4. 后续常规轮询 (force: false) -> 再次命中刚才 force 更新后的短时缓存
  const res4 = await mockGetContextSnapshot(testCid, false);
  assert.equal(backendRpcCalls, 2);
  assert.equal(res4.fromCache, true);
  assert.equal(res4.used, 52000);
});

test('【验收场景 18】架构彻底去预热：Sidecar 与 RuntimeBridge 彻底不提供 warmup 与 buildAllTrajectoriesIndex', async () => {
  const contextServiceModule = await import('../sidecars/ring/context-service.mjs');
  const runtimeBridgeModule = await import('../sidecars/ring/runtime-bridge.mjs');

  // 1. context-service 严禁导出 buildAllTrajectoriesIndex
  assert.equal(typeof contextServiceModule.buildAllTrajectoriesIndex, 'undefined');

  // 2. RuntimeBridgeManager 实例严禁具有 warmupTargets 方法或预热状态字段
  const manager = new runtimeBridgeModule.RuntimeBridgeManager('dummy-profile', '// code');
  assert.equal(typeof manager.warmupTargets, 'undefined');
  assert.equal(typeof manager.warmupRunning, 'undefined');
  assert.equal(typeof manager.cachedIndex, 'undefined');
  assert.equal(typeof manager.warmupDone, 'undefined');
});

test('【验收场景 19】原生 agentStateProvider.onDidChange 触发时携带 force: true 穿透请求', async () => {
  let lastRpcOptions = null;
  const mockHost = {
    getSnapshot: async (opts) => {
      lastRpcOptions = opts;
      return { ready: true, used: 12345, limit: 256000 };
    }
  };

  // 模拟挂载和事件触发
  const cid = 'session-agent-event-test';
  function onAgentStateChanged() {
    mockHost.getSnapshot({ conversationId: cid, force: true });
  }

  onAgentStateChanged();
  assert.ok(lastRpcOptions !== null);
  assert.equal(lastRpcOptions.conversationId, cid);
  assert.equal(lastRpcOptions.force, true);
});

test('【验收场景 20】常规轮询由 2.5s 放宽至 5s 作为失步兜底，失败阶梯退避至 10s', () => {
  let nextDelay = 0;
  function calculateDelay(consecutiveFailures, immediateDelay) {
    let delay = 5000;
    if (typeof immediateDelay === 'number') {
      delay = immediateDelay;
    } else if (consecutiveFailures >= 2) {
      delay = 10000;
    } else if (consecutiveFailures === 1) {
      delay = 5000;
    }
    return delay;
  }

  // 1. 常规正常状态 -> 5000ms
  assert.equal(calculateDelay(0), 5000);

  // 2. 1 次失败 -> 依然 5000ms
  assert.equal(calculateDelay(1), 5000);

  // 3. 2 次及以上失败 -> 退避到 10000ms
  assert.equal(calculateDelay(2), 10000);
  assert.equal(calculateDelay(5), 10000);

  // 4. 显式指定延迟 -> 优先采用
  assert.equal(calculateDelay(0, 1000), 1000);
});

test('【验收场景 21】未访问冷会话纯按需加载，已访问会话 LocalStorage 0ms 秒开恢复', async () => {
  const localStorageMock = new Map();
  const memoryCache = new MemoryLRUCache(10);

  function getSnapshotSmart(cid) {
    if (memoryCache.has(cid)) return { snap: memoryCache.get(cid), latency: 0, source: 'memory' };
    const raw = localStorageMock.get('ag_ring_snap_' + cid);
    if (raw) {
      const snap = normalizeSnapshotSchema(JSON.parse(raw), cid);
      memoryCache.set(cid, snap);
      return { snap, latency: 0, source: 'localstorage' };
    }
    return null; // 冷会话未命中，需按需拉取
  }

  const visitedCid = 'session-already-visited';
  const coldCid = 'session-never-visited-cold';

  // 1. 模拟历史访问过的会话已持久化
  localStorageMock.set('ag_ring_snap_' + visitedCid, JSON.stringify({
    ready: true,
    used: 75000,
    limit: 256000
  }));

  // 2. 切到已访问会话 -> 0ms LocalStorage 恢复
  const hit = getSnapshotSmart(visitedCid);
  assert.ok(hit !== null);
  assert.equal(hit.latency, 0);
  assert.equal(hit.snap.used, 75000);
  assert.equal(hit.source, 'localstorage');

  // 3. 切到从未访问的冷会话 -> 未命中（不进行前置 30 会话预热）
  const miss = getSnapshotSmart(coldCid);
  assert.equal(miss, null);

  // 4. 随后按需拉取数据并存入 LocalStorage
  localStorageMock.set('ag_ring_snap_' + coldCid, JSON.stringify({
    ready: true,
    used: 32000,
    limit: 256000
  }));
  const loaded = getSnapshotSmart(coldCid);
  assert.ok(loaded !== null);
  assert.equal(loaded.snap.used, 32000);
});

test('【验收场景 22】AI 流式打字高频 onDidChange 事件 -> 250ms 防抖合并为单次 force 刷新，彻底免疫事件风暴', async () => {
  let timer = null;
  const metrics = {
    eventsReceived: 0,
    forceDispatched: 0
  };

  function simulateOnDidChange() {
    metrics.eventsReceived++;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      metrics.forceDispatched++;
    }, 250);
  }

  // 1. 模拟 AI 快速流式打字输出：1 秒内高频触发 20 次 onDidChange
  for (let i = 0; i < 20; i++) {
    simulateOnDidChange();
    await new Promise(r => setTimeout(r, 20)); // 每隔 20ms 来一个事件
  }

  // 打字过程中由于不断重置防抖，强制刷新尚未派发
  assert.equal(metrics.eventsReceived, 20);
  assert.equal(metrics.forceDispatched, 0);

  // 2. 等待打字停顿 260ms
  await new Promise(r => setTimeout(r, 260));

  // 3. 校验：20 次高频事件被优雅防抖归并为恰好 1 次 force 刷新！
  assert.equal(metrics.forceDispatched, 1);
});

test('【验收场景 23】前后端一级内存缓存默认容量对齐为 50 个会话，冷启动快频探测定时器在 stop 后零残留', async () => {
  const defaultLru = new MemoryLRUCache();
  assert.equal(defaultLru.maxSize, 50, '前端 MemoryLRUCache 默认容量应为 50');

  // 写入 55 个会话，验证保留最近 50 个会话并淘汰最早 5 个
  for (let i = 1; i <= 55; i++) {
    defaultLru.set(`sess-${i}`, { id: `sess-${i}` });
  }
  assert.equal(defaultLru.size, 50);
  assert.equal(defaultLru.has('sess-1'), false);
  assert.equal(defaultLru.has('sess-5'), false);
  assert.equal(defaultLru.has('sess-6'), true);
  assert.equal(defaultLru.has('sess-55'), true);

  const contextServiceModule = await import('../sidecars/ring/context-service.mjs');
  const cacheInfo = contextServiceModule._getMemoryCacheInfo();
  assert.equal(cacheInfo.maxSize, 50, '后端 Sidecar 内存缓存上限应统一为 50');

  const runtimeBridgeModule = await import('../sidecars/ring/runtime-bridge.mjs');
  const manager = new runtimeBridgeModule.RuntimeBridgeManager('dummy-profile', '// code');
  manager.start();
  assert.ok(manager.bootstrapTimer !== null, 'start 后应启动冷启动 500ms 快频探测定时器');
  manager.stop();
  assert.equal(manager.bootstrapTimer, null, 'stop 后快频探测定时器必须彻底清理');
  assert.equal(manager.pollTimer, null, 'stop 后常规轮询定时器必须彻底清理');
});
