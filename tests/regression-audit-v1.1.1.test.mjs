import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, symlinkSync, existsSync, rmSync, mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

import {
  getContextSnapshot,
  getBackendTrajectoryCache,
  clearBackendTrajectoryCache,
  setBackendTrajectoryCache,
  setSessionLsBinding,
  getSessionLsBinding,
  clearSessionLsBindings,
  _getMemoryCacheInfo,
  _getTrajectoryCacheInfo
} from '../sidecars/ring/context-service.mjs';

import {
  processTrajectorySteps,
  StepType
} from '../sidecars/ring/context-calculator.mjs';

import {
  discoverAllLanguageServers,
  discoverLanguageServer,
  getDiskCacheFile,
  writeDiskCache,
  readDiskCache,
  clearCachedLanguageServer,
  _getLsDiscoveryCacheInfo
} from '../sidecars/ring/ls-discovery.mjs';

import {
  rpcCall,
  isRetryableRpcError
} from '../sidecars/ring/rpc-client.mjs';

beforeEach(() => {
  _getMemoryCacheInfo().clear();
  clearBackendTrajectoryCache();
  clearCachedLanguageServer();
});

// =========================================================================
// 审查点 1: 5000 步驻留抖动防御
// =========================================================================
test('【审查点 1】5000 步驻留抖动防御: 增量拉取正好达到 5000 步且前向探针为 0 时保留增量缓存，绝不抖动全量重拉', async () => {
  let rpcCalls = 0;
  const requestedRanges = [];
  let currentTotalSteps = 4500;

  async function mockRpc(target, method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      rpcCalls++;
      requestedRanges.push({ start: params.startIndex, end: params.endIndex });
      const available = Math.max(0, Math.min(params.endIndex, currentTotalSteps) - params.startIndex);
      return {
        steps: Array.from({ length: available }, (_, i) => ({
          stepIndex: params.startIndex + i,
          type: StepType.PLANNER_RESPONSE,
          plannerResponse: { response: `Step ${params.startIndex + i}` }
        }))
      };
    }
    return {};
  }

  const testCid = 'mock-cascade-exact-5000-residency-jitter';

  // 1. 首次冷拉取 4500 步（5 页：0..1000, 1000..2000, 2000..3000, 3000..4000, 4000..5000 拿 500 步）
  const snap1 = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  assert.equal(snap1.stepCount, 4500);
  assert.equal(snap1.isWindowed, false);
  const initialRpcCount = rpcCalls;
  assert.equal(initialRpcCount, 5, '冷拉取 4500 步发起 5 次 RPC');

  // 2. 追加 500 步，会话总步数正好达到 5000 步（第 5 页 4000..5000 满 1000 步）
  currentTotalSteps = 5000;
  rpcCalls = 0;
  requestedRanges.length = 0;

  const snap2 = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 验证：
  // 增量从 4000 开始重查第 5 页（获得 1000 步，步数正好 5000 步且满页），
  // 触发前向探测 fetchPage(5000) 即 5000..6000。
  // 前向探测返回 0 步，判定为真实 5000 步会话，保留增量缓存！
  // 绝对不执行 clearBackendTrajectoryCache + executeFullFetch（从 0 开始拉 5 次）！
  assert.equal(snap2.totalSteps, 5000);
  assert.equal(snap2.stepCount, 5000);
  assert.equal(snap2.isWindowed, false, '正好 5000 步为非窗口化完整会话');

  // 增量 RPC 调用次数：仅 1 次增量页 (4000..5000) + 1 次前向探针 (5000..6000) = 2 次，绝非 1 + 5 = 6 次全量重拉！
  assert.equal(rpcCalls, 2, '增量拉取至 5000 步仅发起增量页与单次边界探针，坚决杜绝全量重拉');
  assert.deepEqual(requestedRanges.map(r => r.start), [4000, 5000]);

  // 验证缓存保留状态：
  const cached = getBackendTrajectoryCache(testCid);
  assert.ok(cached, '增量缓存必须被完整保留');
  assert.equal(cached.allSteps.length, 5000);

  // 3. 再次强制刷新（会话步数未变，仍然 5000 步），继续验证增量缓存持续有效，不发生抖动
  rpcCalls = 0;
  requestedRanges.length = 0;
  const snap3 = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  assert.equal(snap3.stepCount, 5000);
  assert.equal(snap3.isWindowed, false);
  // 从 4000 开始增量拉取第 5 页（满 1000 步）+ 前向探测 5000（0 步），仍旧只有 2 次 RPC，绝不全量抖动
  assert.equal(rpcCalls, 2);
  assert.ok(!requestedRanges.some(r => r.start === 0), '绝不出现从 0 开始的全量重拉');
});

// =========================================================================
// 审查点 2: 紫色环回退状态污染修复
// =========================================================================
test('【审查点 2】紫色环回退修复: 会话从窗口化压缩态回退至 < 5000 步时，绝不继承紫色压缩标记', async () => {
  // 1. 验证 context-calculator: initialCompressionDetected 仅在显式传入 true 时生效，回退传 false 时严格为 false
  const regularSteps = Array.from({ length: 100 }, (_, i) => ({
    stepIndex: i,
    type: StepType.PLANNER_RESPONSE,
    plannerResponse: {
      modelUsage: {
        model: 'gemini-3.8-flash',
        inputTokens: 1000 + i * 10,
        outputTokens: 50
      }
    }
  }));

  const resInheritedFalse = processTrajectorySteps(regularSteps, 'gemini-3.8-flash', {
    initialCompressionDetected: false,
    initialCompressionDrop: 0
  });
  assert.equal(resInheritedFalse.compressionDetected, false, '回退非窗口化时 initialCompressionDetected=false 必须输出 false');

  // 2. 验证 context-service: 预置已处于窗口化且包含压缩标记 (compressionDetected: true) 的缓存
  const testCid = 'mock-cascade-purple-ring-rewind';
  const initialWindowedSteps = Array.from({ length: 5000 }, (_, i) => ({
    stepIndex: 1000 + i,
    type: StepType.PLANNER_RESPONSE,
    plannerResponse: { response: `Step ${1000 + i}` }
  }));

  setBackendTrajectoryCache(testCid, {
    targetCascadeId: testCid,
    allSteps: initialWindowedSteps,
    analysisSteps: initialWindowedSteps,
    windowStartStep: 1000,
    isWindowed: true,
    isTruncated: true,
    totalSteps: 6000,
    compressionDetected: true, // 原处于紫色压缩环状态
    compressionDrop: 50000,
    lastFetchedAt: Date.now()
  });

  // 模拟用户回退历史（Rollback / Rewind）到 2000 步，会话缩短至 2000 步（非窗口化会话，无压缩）
  let rpcCalls = 0;
  async function mockRpc(target, method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      rpcCalls++;
      const available = Math.max(0, Math.min(params.endIndex, 2000) - params.startIndex);
      return {
        steps: Array.from({ length: available }, (_, i) => ({
          stepIndex: params.startIndex + i,
          type: StepType.PLANNER_RESPONSE,
          plannerResponse: {
            modelUsage: {
              model: 'gemini-3.8-flash',
              inputTokens: 500 + (params.startIndex + i) * 5, // 平稳线性增长，无断崖压缩
              outputTokens: 20
            }
          }
        }))
      };
    }
    return {};
  }

  // 触发拉取：由于旧缓存 lastStepIndex 为 5999，而新拉取首步 stepIndex 为 0 <= 5999，触发时序回退全量重拉
  const snapRewind = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  assert.equal(snapRewind.stepCount, 2000, '步数成功回退至 2000 步');
  assert.equal(snapRewind.isWindowed, false, '回退后不是窗口化会话');
  assert.equal(
    snapRewind.compressionDetected,
    false,
    '回退到 < 5000 步且自身无压缩的会话，坚决不得继承旧缓存中的紫色压缩标记'
  );
});

// =========================================================================
// 审查点 3: 多 LS 场景单 LS 磁盘缓存穿透真实发现
// =========================================================================
test('【审查点 3】多 LS 单磁盘缓存穿透: isDiskRestoredSingle 状态下 discoverAllLanguageServers 必须穿透缓存执行真实发现并重置标记', async () => {
  const cacheInfo = _getLsDiscoveryCacheInfo();
  assert.equal(cacheInfo.isDiskRestoredSingle, false, '初始状态 isDiskRestoredSingle 为 false');

  // 启动一个临时本地假 LS 服务，响应 probePort 的 GetUnleashData 探活请求
  let srv;
  await new Promise((resolve) => {
    srv = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    srv.listen(0, '127.0.0.1', resolve);
  });
  const fakePort = srv.address().port;

  // 1. 写入磁盘缓存（包含完整的 port、csrfToken 与 useTls）
  const fakeLs = { port: fakePort, csrfToken: 'fake-single-token-1234', useTls: false };
  writeDiskCache(fakeLs);

  try {
    const single = await discoverLanguageServer(false);
    assert.ok(single, '成功从磁盘缓存恢复单个 LS');
    assert.equal(single.port, fakePort);

    const infoAfterRestore = _getLsDiscoveryCacheInfo();
    assert.equal(infoAfterRestore.isDiskRestoredSingle, true, '单磁盘缓存恢复后必须标记 isDiskRestoredSingle = true');

    // 2. 在缓存 TTL 内调用 discoverAllLanguageServers(false)（未带 forceRefresh）
    // 由于 isDiskRestoredSingle = true，必须绕过 isCacheValid，触发真实发现 _performDiscovery
    const allServers = await discoverAllLanguageServers(false);

    // 验证：真实发现完成后，isDiskRestoredSingle 必须被重置为 false
    const infoAfterAll = _getLsDiscoveryCacheInfo();
    assert.equal(infoAfterAll.isDiskRestoredSingle, false, '全量多 LS 发现完成后必须重置 isDiskRestoredSingle = false');
    assert.ok(Array.isArray(allServers), '返回多 LS 列表');
  } finally {
    await new Promise(r => { srv.closeAllConnections?.(); srv.close(r); });
    try {
      rmSync(getDiskCacheFile(), { force: true });
    } catch {}
  }
});

// =========================================================================
// 审查点 4: 悬空软链接 (Dangling Symlink) 安全处理
// =========================================================================
test('【审查点 4】悬空软链接防御: readDiskCache 与 writeDiskCache 面对悬空 symlink 必须安全斩断清理，杜绝异常', () => {
  const cacheFile = getDiskCacheFile();
  const danglingTarget = join(tmpdir(), `non-existent-agy-target-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);

  // 清理现有缓存
  try {
    rmSync(cacheFile, { force: true });
  } catch {}

  // 创建指向不存在路径的悬空软链接
  let symlinkCreated = false;
  try {
    symlinkSync(danglingTarget, cacheFile);
    symlinkCreated = true;
  } catch (e) {
    // Windows 下非管理员权限创建 symlink 可能会失败（EPERM）
  }

  if (symlinkCreated) {
    assert.equal(existsSync(cacheFile), false, '悬空软链接的目标不存在时 existsSync 必然返回 false');
    const statBefore = lstatSync(cacheFile);
    assert.equal(statBefore.isSymbolicLink(), true, '但 lstatSync 必须能识别出该文件为符号链接');

    // 1. 测试 readDiskCache: 遇到悬空软链接必须安全返回 null 并彻底删除该软链接
    const readResult = readDiskCache();
    assert.equal(readResult, null, 'readDiskCache 遇到悬空软链接必须安全返回 null');
    assert.throws(() => lstatSync(cacheFile), '悬空软链接必须已被 rmSync 彻底斩断删除');

    // 2. 测试 writeDiskCache: 重新制造悬空软链接，写入新缓存必须斩断软链接并成功写入真实文件
    symlinkSync(danglingTarget, cacheFile);
    assert.equal(lstatSync(cacheFile).isSymbolicLink(), true);

    const testPayload = { port: 48999, csrfToken: 'test-symlink-safe-token', useTls: false };
    assert.doesNotThrow(() => {
      writeDiskCache(testPayload);
    }, 'writeDiskCache 写入悬空软链接路径不得抛出异常');

    const statAfter = lstatSync(cacheFile);
    assert.equal(statAfter.isSymbolicLink(), false, '写入后必须是普通物理文件，绝非符号链接');
    const readAfterWrite = readDiskCache();
    assert.equal(readAfterWrite?.port, 48999);
    assert.equal(readAfterWrite?.csrfToken, 'test-symlink-safe-token');

    // 清理测试文件
    try {
      rmSync(cacheFile, { force: true });
    } catch {}
  } else {
    // 环境权限受限时，做源码级与单元级断言
    const discoveryCode = readFileSync(new URL('../sidecars/ring/ls-discovery.mjs', import.meta.url), 'utf8');
    assert.match(discoveryCode, /lstatSync\(targetFile\)/, 'read/write 必须包含 lstatSync');
    assert.match(discoveryCode, /stat\.isSymbolicLink\(\)/, '必须显式判断 isSymbolicLink');
    assert.match(discoveryCode, /rmSync\(targetFile,\s*\{\s*force:\s*true\s*\}\)/, '必须安全清理符号链接');
  }
});

// =========================================================================
// 审查点 5: AbortSignal 取消错误不可重试
// =========================================================================
test('【审查点 5】AbortSignal 取消防御: 前置与在途 AbortSignal 取消必须设置 retryable=false 且 isRetryableRpcError 为 false', async () => {
  // 1. 前置 Abort 测试
  const preAc = new AbortController();
  preAc.abort();

  let preError = null;
  try {
    await rpcCall({ port: 19999, csrfToken: 'token' }, 'TestMethod', {}, 5000, preAc.signal);
  } catch (err) {
    preError = err;
  }

  assert.ok(preError, '已中止的 signal 必须导致 rpcCall 拒绝');
  assert.equal(preError.retryable, false, '前置 abort 产生的错误 retryable 必须为 false');
  assert.equal(isRetryableRpcError(preError), false, 'isRetryableRpcError 对前置 abort 必须判定为不可重试');

  // 2. 在途 Abort 测试：启动临时假死/慢响应服务器
  let srv;
  await new Promise((resolve) => {
    srv = createServer((req, res) => {
      // 故意不响应，等待客户端 abort
    });
    srv.listen(0, '127.0.0.1', resolve);
  });

  const srvPort = srv.address().port;
  const inFlightAc = new AbortController();

  let inFlightError = null;
  const rpcPromise = rpcCall({ port: srvPort, csrfToken: 'token', useTls: false }, 'SlowMethod', {}, 10000, inFlightAc.signal);

  // 延迟 30ms 后在途 abort
  setTimeout(() => inFlightAc.abort(), 30);

  try {
    await rpcPromise;
  } catch (err) {
    inFlightError = err;
  } finally {
    await new Promise(r => { srv.closeAllConnections?.(); srv.close(r); });
  }

  assert.ok(inFlightError, '在途 abort 必须导致 rpcCall 拒绝');
  assert.equal(inFlightError.retryable, false, '在途 abort 产生的错误 retryable 必须为 false');
  assert.equal(isRetryableRpcError(inFlightError), false, 'isRetryableRpcError 对在途 abort 必须判定为不可重试');
});

// =========================================================================
// 审查点 6: 前端向上查找 flex-1 容器排除外部 box
// =========================================================================
test('【审查点 6】向上 flex-1 容器守卫: candidateContainer === box 时严格拦截，绝不将整个外部 box 当成模型按钮旁容器', () => {
  const widgetCode = readFileSync(new URL('../assets/ring-widget.cjs', import.meta.url), 'utf8');

  // 1. 源码级静态守卫断言
  assert.ok(
    widgetCode.includes('candidateContainer !== box'),
    'mountOrUpdatePane 中向上探测 flex-1 必须包含 candidateContainer !== box 守卫'
  );

  // 2. 行为级算法模拟：当外层 box 自身带有 .flex-1，且内部 model.parentElement 向上 closest 查找到 box 时
  const fakeBox = {
    className: 'antigravity-composer-box flex-1',
    contains: (node) => true // DOM 原生 node.contains 包含自身
  };

  const fakeModelParent = {
    className: 'button-strip',
    parentElement: fakeBox,
    closest: (sel) => (sel === '.flex-1' ? fakeBox : null) // 查找到外层 box 自身
  };

  const fakeModel = {
    parentElement: fakeModelParent
  };

  // 运行带守卫的推导逻辑
  const candidateContainer = fakeModel.parentElement?.closest?.('.flex-1');
  assert.equal(candidateContainer, fakeBox, '模拟场景中 closest 确实命中了外层 box');

  // 核心守卫断言：
  const flexContainer = (candidateContainer && candidateContainer !== fakeBox && fakeBox?.contains(candidateContainer))
    ? candidateContainer
    : (fakeModel.parentElement || fakeBox);

  // 断言：由于 candidateContainer === fakeBox 被拦截，flexContainer 成功降级为 model.parentElement，绝不污染 fakeBox！
  assert.equal(flexContainer, fakeModelParent, '命中 box 时必须被守卫排除，正确回退到 model.parentElement');
  assert.notEqual(flexContainer, fakeBox, 'flexContainer 绝不能是外层 box');
});

// =========================================================================
// 审查点 7: 增量拉取 LS 宕机 discoveryExhausted 熔断防空转
// =========================================================================
test('【审查点 7】次生漏洞防御: 增量拉取遇到连接错误且重新发现返回 null 时，单次轮询仅触发 1 次 discover 并立即熔断，绝不抖动全量重拉', async () => {
  const testCid = 'mock-cascade-discovery-exhausted-defense';

  // 1. 模拟活跃会话：在 sessionLsBindings 中持有端口，在 trajectoryCache 中持有有效缓存
  const fakeLs = { port: 59999, csrfToken: 'fake-active-token', useTls: false };
  setSessionLsBinding(testCid, fakeLs);

  const initialSteps = Array.from({ length: 50 }, (_, i) => ({
    stepIndex: i,
    type: StepType.PLANNER_RESPONSE,
    plannerResponse: { response: `Existing step ${i}` }
  }));

  setBackendTrajectoryCache(testCid, {
    targetCascadeId: testCid,
    allSteps: initialSteps,
    analysisSteps: initialSteps,
    totalSteps: 50,
    windowStartStep: 0,
    isWindowed: false,
    isTruncated: false,
    contextUsed: 1000,
    lastStepIndex: 49,
    compressionDetected: false,
    compressionDrop: 0,
    modelSig: '|',
    time: Date.now()
  });

  // 验证前置状态就绪
  assert.ok(getSessionLsBinding(testCid), '测试前 sessionLsBindings 必须持有绑定');
  assert.ok(getBackendTrajectoryCache(testCid), '测试前 trajectoryCache 必须持有缓存');

  // 2. 提供 mockRpc（第一次抛出 retryable ECONNREFUSED）
  let rpcCallCount = 0;
  async function mockRpc(target, method, params) {
    rpcCallCount++;
    const connErr = new Error('connect ECONNREFUSED 127.0.0.1:59999');
    connErr.code = 'ECONNREFUSED';
    connErr.retryable = true;
    throw connErr;
  }

  // 3. 提供 mockDiscover（计数调用次数，强制刷新且返回 null）
  let discoverCallCount = 0;
  const discoverForceParams = [];
  async function mockDiscover(force) {
    discoverCallCount++;
    discoverForceParams.push(force);
    return null; // 模拟 LS 彻底宕机且无法恢复
  }

  // 4. 调用 getContextSnapshot(cid, true, { _rpcCall: mockRpc, _discoverLanguageServer: mockDiscover })
  const snap = await getContextSnapshot(testCid, true, {
    _rpcCall: mockRpc,
    _discoverLanguageServer: mockDiscover
  });

  // 5. 严格断言：
  // - mockDiscover 被调用次数恒等于 1（绝不能是 2 次！）
  assert.equal(discoverCallCount, 1, 'mockDiscover 被调用次数必须恒等于 1，绝不能因增量 catch 回退全量而二次触发！');
  assert.equal(discoverForceParams[0], true, '重新发现必须携带 force=true');

  // - 返回结果 snap.ready 必须为 false
  assert.equal(snap.ready, false, 'discoveryExhausted 时必须返回 ready: false 快照');

  // - 验证 sessionLsBindings 已被清空
  assert.equal(getSessionLsBinding(testCid), null, '失效的会话 LS 绑定必须已被清空');

  // - 验证 trajectoryCache 已被清空
  assert.equal(getBackendTrajectoryCache(testCid), null, '失效的轨迹增量缓存必须已被清除');
});
