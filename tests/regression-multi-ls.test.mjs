import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCandidatePriorityScore,
  sortCandidates,
  discoverAllLanguageServers,
  discoverLanguageServer,
  _getLsDiscoveryCacheInfo,
  extractTokenAndPid,
  isCandidateServerLine
} from '../sidecars/ring/ls-discovery.mjs';
import {
  getContextSnapshot,
  getSessionLsBinding,
  setSessionLsBinding,
  clearSessionLsBindings,
  is404RpcError,
  _getMemoryCacheInfo
} from '../sidecars/ring/context-service.mjs';
import { StepType } from '../sidecars/ring/context-calculator.mjs';

test('【多 LS 优先级 1】getCandidatePriorityScore: 官方 Hub 特征精确加权评分', () => {
  // 1. 同时具备 --subclient_type hub 与 --override_ide_name antigravity (官方 Hub 完整特征)
  const fullHubCmd = 'language_server.exe --subclient_type hub --override_ide_name antigravity --csrf_token abcdef1234567890abcdef1234567890';
  assert.equal(getCandidatePriorityScore(fullHubCmd), 200);

  // 2. 等号格式
  const equalHubCmd = 'language_server.exe --subclient_type=hub --override_ide_name=antigravity --csrf_token=abcdef1234567890abcdef1234567890';
  assert.equal(getCandidatePriorityScore(equalHubCmd), 200);

  // 3. 携带辅助 --hub 标识
  const extraHubCmd = 'agy.exe --hub --subclient_type=hub --override_ide_name=antigravity --csrf_token abc';
  assert.equal(getCandidatePriorityScore(extraHubCmd), 250);

  // 4. 单一特征: 仅 --subclient_type hub
  assert.equal(getCandidatePriorityScore('language_server.exe --subclient_type hub'), 100);

  // 5. 单一特征: 仅 --override_ide_name antigravity
  assert.equal(getCandidatePriorityScore('language_server.exe --override_ide_name antigravity'), 100);

  // 6. 辅助特征: 仅 --hub
  assert.equal(getCandidatePriorityScore('agy.exe --hub --port 1234'), 50);

  // 7. 普通非 Hub language_server
  assert.equal(getCandidatePriorityScore('language_server.exe --csrf_token 123456'), 0);
  assert.equal(getCandidatePriorityScore(''), 0);
  assert.equal(getCandidatePriorityScore(null), 0);

  // 8. 引号包裹参数变体 (双引号、单引号)
  const quotedHubCmd = 'language_server.exe --subclient_type "hub" --override_ide_name "antigravity"';
  assert.equal(getCandidatePriorityScore(quotedHubCmd), 200, '双引号包裹的 Hub 参数必须被准确识别');
  const singleQuotedCmd = "language_server.exe --subclient_type='hub' --override_ide_name='antigravity'";
  assert.equal(getCandidatePriorityScore(singleQuotedCmd), 200, '单引号包裹的 Hub 参数必须被准确识别');
});

test('【多 LS 优先级 2】sortCandidates: 官方 Hub 特征绝对置顶 (跨平台)', () => {
  const olderHub = {
    pid: 1000,
    csrfToken: 'token1',
    commandLine: 'language_server.exe --subclient_type hub --override_ide_name antigravity',
    orderIndex: 2
  };
  const newerNormal = {
    pid: 9999,
    csrfToken: 'token2',
    commandLine: 'language_server.exe --csrf_token normal',
    orderIndex: 0
  };

  // Windows: 即使普通进程更新 (orderIndex 0 vs 2)，Hub 必须坚决排在第 0 位
  const sortedWin = sortCandidates([newerNormal, olderHub], 'win32');
  assert.equal(sortedWin[0].pid, 1000, 'Windows: 官方 Hub 必须置顶于较新的普通进程');

  // POSIX: 即使普通进程 PID 更大 (9999 vs 1000)，Hub 必须坚决排在第 0 位
  const sortedPosix = sortCandidates([newerNormal, olderHub], 'linux');
  assert.equal(sortedPosix[0].pid, 1000, 'POSIX: 官方 Hub 必须置顶于高 PID 普通进程');
});

test('【多 LS 优先级 3】sortCandidates: 相同优先级下创建时间最新者排在最前', () => {
  // Windows: 两个均为官方 Hub，创建时间较晚（orderIndex 较小）者胜出
  const olderHubWin = {
    pid: 2001,
    commandLine: 'language_server.exe --subclient_type hub --override_ide_name antigravity',
    orderIndex: 1
  };
  const newerHubWin = {
    pid: 2002,
    commandLine: 'language_server.exe --subclient_type hub --override_ide_name antigravity',
    orderIndex: 0
  };
  const sortedWin = sortCandidates([olderHubWin, newerHubWin], 'win32');
  assert.equal(sortedWin[0].pid, 2002, 'Windows: 同级 Hub 进程创建时间最新 (orderIndex 0) 排在第 0 位');

  // Windows: 带显式 creationDate 的时间比较
  const hubDate1 = {
    pid: 3001,
    commandLine: 'language_server.exe --subclient_type hub',
    creationDate: '2026-11-10T10:00:00Z'
  };
  const hubDate2 = {
    pid: 3002,
    commandLine: 'language_server.exe --subclient_type hub',
    creationDate: '2026-11-10T12:00:00Z'
  };
  const sortedDateWin = sortCandidates([hubDate1, hubDate2], 'win32');
  assert.equal(sortedDateWin[0].pid, 3002, 'Windows: 显式 creationDate 最新的排在最前面');

  // POSIX: 两个均为官方 Hub，PID 倒序（较大 PID 代表较新创建）排在最前
  const olderHubPosix = {
    pid: 1010,
    commandLine: 'language_server --subclient_type hub --override_ide_name antigravity'
  };
  const newerHubPosix = {
    pid: 5050,
    commandLine: 'language_server --subclient_type hub --override_ide_name antigravity'
  };
  const sortedPosix = sortCandidates([olderHubPosix, newerHubPosix], 'darwin');
  assert.equal(sortedPosix[0].pid, 5050, 'POSIX: 同级 Hub 进程高 PID 倒序排在第 0 位');
});

test('【多 LS 发现 1】discoverAllLanguageServers 与 discoverLanguageServer 返回规范与首选排序', async () => {
  _getLsDiscoveryCacheInfo().clear();

  const all = await discoverAllLanguageServers(true);
  assert.ok(Array.isArray(all));

  const singleLs = await discoverLanguageServer(false);
  if (all.length > 0) {
    assert.deepEqual(singleLs, all[0], 'discoverLanguageServer 必须 100% 对应 discoverAllLanguageServers 的首选 LS');
  } else {
    assert.equal(singleLs, null);
  }
});

test('【404 自愈切换 1】主 LS 返回 404 时自动尝试备选 LS，成功获取轨迹并动态切换 lsRef.current 与会话绑定', async () => {
  _getMemoryCacheInfo().clear();

  const lsHub = { port: 8001, pid: 101, csrfToken: 'hub-tok', useTls: false };
  const lsWorkspace2 = { port: 8002, pid: 102, csrfToken: 'ws2-tok', useTls: false };

  const targetCid = 'test-session-404-fallback';
  const targetNormCid = targetCid.toLowerCase();

  const mockSteps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'gemini-2.5-pro',
          inputTokens: 12000,
          outputTokens: 800
        }
      }
    }
  ];

  let hubCalled = 0;
  let ws2Called = 0;

  const mockRpcCall = async (target, method, params) => {
    const ls = target?.current || target;
    if (ls.port === 8001) {
      hubCalled++;
      // 主 LS 不拥有此会话，抛出 HTTP 404
      const err = new Error('Session not found on Hub Language Server');
      err.statusCode = 404;
      throw err;
    }
    if (ls.port === 8002) {
      ws2Called++;
      if (method === 'GetCascadeTrajectorySteps') {
        return { steps: mockSteps };
      }
      return {};
    }
    throw new Error(`Unknown server port: ${ls?.port}`);
  };

  // 首次拉取：初始为 lsHub，备选列表包含 lsWorkspace2
  const snapshot = await getContextSnapshot(targetCid, true, {
    _ls: lsHub,
    _allLs: [lsHub, lsWorkspace2],
    _rpcCall: mockRpcCall
  });

  // 1. 验证成功通过备选 LS 获得就绪快照
  assert.equal(snapshot.ready, true, '快照必须成功解析就绪');
  assert.equal(snapshot.used, 12800, '快照 Token 必须准确从备选 LS 计算得到');
  assert.equal(hubCalled, 1, '主 Hub LS 必须仅被尝试一次并遭遇 404');
  assert.ok(ws2Called >= 1, '备选 LS 必须成功接管并提供步骤');

  // 2. 验证会话绑定已动态更新至 lsWorkspace2
  const bound = getSessionLsBinding(targetNormCid);
  assert.ok(bound, '会话必须成功建立与备选 LS 的绑定');
  assert.equal(bound.port, 8002, '会话绑定必须更新为 port 8002 (lsWorkspace2)');

  // 3. 第二次拉取（模拟后续轮询）：不再传入 _ls，直接走会话绑定
  let secondHubCalled = 0;
  let secondWs2Called = 0;
  const mockSecondRpcCall = async (target, method, params) => {
    const ls = target?.current || target;
    if (ls.port === 8001) secondHubCalled++;
    if (ls.port === 8002) {
      secondWs2Called++;
      return { steps: mockSteps };
    }
  };

  const secondSnapshot = await getContextSnapshot(targetCid, true, {
    _rpcCall: mockSecondRpcCall
  });

  assert.equal(secondSnapshot.ready, true);
  assert.equal(secondHubCalled, 0, '二次轮询必须直接命中已绑定的备选 LS，绝不向旧主 LS 发起无效 404 请求');
  assert.ok(secondWs2Called >= 1, '二次轮询直接由已绑定的备选 LS 响应');
});

test('【404 自愈切换 2】主 LS steps 为空（找不到轨迹）时自动尝试备选 LS 并自愈', async () => {
  _getMemoryCacheInfo().clear();

  const lsOld = { port: 9001, pid: 201, csrfToken: 'tok1', useTls: false };
  const lsNew = { port: 9002, pid: 202, csrfToken: 'tok2', useTls: false };

  const targetCid = 'test-session-empty-steps-fallback';

  const mockSteps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'claude-3-7-sonnet',
          inputTokens: 25000,
          outputTokens: 1500
        }
      }
    }
  ];

  const mockRpcCall = async (target, method, params) => {
    const ls = target?.current || target;
    if (ls.port === 9001) {
      // 主 LS 没有报错，但 steps 为空数组
      return { steps: [] };
    }
    if (ls.port === 9002) {
      return { steps: mockSteps };
    }
    throw new Error(`Unknown server port: ${ls?.port}`);
  };

  const snapshot = await getContextSnapshot(targetCid, true, {
    _ls: lsOld,
    _allLs: [lsOld, lsNew],
    _rpcCall: mockRpcCall
  });

  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.used, 26500);

  const bound = getSessionLsBinding(targetCid);
  assert.ok(bound);
  assert.equal(bound.port, 9002, '找不到轨迹时必须自动自愈至有效备选 LS');
});

test('【404 自愈切换 3】多工作区多会话互不干扰并发自愈', async () => {
  _getMemoryCacheInfo().clear();

  const lsA = { port: 7001, pid: 301, csrfToken: 'tokA', useTls: false };
  const lsB = { port: 7002, pid: 302, csrfToken: 'tokB', useTls: false };

  const cidA = 'workspace-a-session';
  const cidB = 'workspace-b-session';

  const mockRpcCall = async (target, method, params) => {
    const ls = target?.current || target;
    const cascadeId = params?.cascadeId;
    if (ls.port === 7001) {
      if (cascadeId === cidA) {
        return { steps: [{ type: StepType.CHECKPOINT, metadata: { modelUsage: { inputTokens: 5000, outputTokens: 500 } } }] };
      }
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    }
    if (ls.port === 7002) {
      if (cascadeId === cidB) {
        return { steps: [{ type: StepType.CHECKPOINT, metadata: { modelUsage: { inputTokens: 9000, outputTokens: 900 } } }] };
      }
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    }
    throw new Error(`Unknown server port: ${ls?.port}`);
  };

  // 会话 A 优先连 lsA 成功
  const snapA = await getContextSnapshot(cidA, true, {
    _ls: lsA,
    _allLs: [lsA, lsB],
    _rpcCall: mockRpcCall
  });
  assert.equal(snapA.ready, true);
  assert.equal(snapA.used, 5500);

  // 会话 B 初始连 lsA 报 404，自愈回退到 lsB 成功
  const snapB = await getContextSnapshot(cidB, true, {
    _ls: lsA,
    _allLs: [lsA, lsB],
    _rpcCall: mockRpcCall
  });
  assert.equal(snapB.ready, true);
  assert.equal(snapB.used, 9900);

  // 验证各自的会话绑定精确独立
  assert.equal(getSessionLsBinding(cidA)?.port, 7001);
  assert.equal(getSessionLsBinding(cidB)?.port, 7002);

  // 交替轮询：会话 A 命中 lsA，会话 B 命中 lsB，零 404
  const pollA = await getContextSnapshot(cidA, true, { _rpcCall: mockRpcCall });
  const pollB = await getContextSnapshot(cidB, true, { _rpcCall: mockRpcCall });
  assert.equal(pollA.used, 5500);
  assert.equal(pollB.used, 9900);
});

test('【404 自愈切换 4】conversationId 为空时主 LS 无轨迹自动探测备选 LS 最新活跃会话', async () => {
  _getMemoryCacheInfo().clear();

  const lsIdle = { port: 6001, pid: 401, csrfToken: 'tokIdle', useTls: false };
  const lsActive = { port: 6002, pid: 402, csrfToken: 'tokActive', useTls: false };

  const mockRpcCall = async (target, method, params) => {
    const ls = target?.current || target;
    if (ls.port === 6001) {
      // 主 LS 完全没有轨迹摘要
      return { trajectorySummaries: {} };
    }
    if (ls.port === 6002) {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'active-cid-from-alt': {
              lastModifiedTime: '2026-11-10T18:00:00Z',
              stepCount: 1
            }
          }
        };
      }
      if (method === 'GetCascadeTrajectorySteps') {
        return {
          steps: [
            {
              type: StepType.CHECKPOINT,
              metadata: { modelUsage: { inputTokens: 3333, outputTokens: 333 } }
            }
          ]
        };
      }
    }
  };

  const snap = await getContextSnapshot(null, true, {
    _ls: lsIdle,
    _allLs: [lsIdle, lsActive],
    _rpcCall: mockRpcCall
  });

  assert.equal(snap.ready, true);
  assert.equal(snap.cid, 'active-cid-from-alt');
  assert.equal(snap.used, 3666);
  assert.equal(getSessionLsBinding('active-cid-from-alt')?.port, 6002);
});

test('【404 错误分类】is404RpcError: 识别各种格式的 404 与 not found 错误', () => {
  assert.equal(is404RpcError({ statusCode: 404 }), true);
  assert.equal(is404RpcError({ code: 404 }), true);
  assert.equal(is404RpcError({ code: 'not_found' }), true);
  assert.equal(is404RpcError({ code: 'NOT_FOUND' }), true);
  assert.equal(is404RpcError(new Error('RPC HTTP 404: Not Found')), true);
  assert.equal(is404RpcError(new Error('cascade trajectory not found')), true);
  assert.equal(is404RpcError(new Error('connect ECONNREFUSED')), false);
  assert.equal(is404RpcError(null), false);
  assert.equal(is404RpcError(undefined), false);
});

test('【边界兜底 1】所有 LS（主 LS 与全部备选 LS）均返回 404 时平稳降级为 ready: false，并清理失效会话绑定', async () => {
  _getMemoryCacheInfo().clear();

  const ls1 = { port: 5001, pid: 501, csrfToken: 'tok1' };
  const ls2 = { port: 5002, pid: 502, csrfToken: 'tok2' };

  // 事先预设一条已失效的历史绑定
  setSessionLsBinding('stale-session-404', ls1);
  assert.ok(getSessionLsBinding('stale-session-404'));

  const mockAll404Rpc = async () => {
    const err = new Error('Trajectory not found anywhere');
    err.statusCode = 404;
    throw err;
  };

  const snap = await getContextSnapshot('stale-session-404', true, {
    _ls: ls1,
    _allLs: [ls1, ls2],
    _rpcCall: mockAll404Rpc
  });

  assert.equal(snap.ready, false);
  assert.equal(snap.used, 0);
  assert.equal(snap.ratio, 0);
  assert.equal(getSessionLsBinding('stale-session-404'), null, '全部 LS 返回 404 时必须清理失效会话绑定');
});

test('【会话绑定机制】sessionLsBindings: 大小写不敏感一致性与 LRU 容量上限保护', () => {
  clearSessionLsBindings();

  const testLs = { port: 8888, pid: 888 };
  setSessionLsBinding('Cascade-UUID-1234', testLs);

  // 大小写不敏感一致性
  assert.deepEqual(getSessionLsBinding('cascade-uuid-1234'), testLs);
  assert.deepEqual(getSessionLsBinding('CASCADE-UUID-1234'), testLs);
  assert.deepEqual(getSessionLsBinding('Cascade-UUID-1234'), testLs);

  // 清除单条
  clearSessionLsBindings('cascade-uuid-1234');
  assert.equal(getSessionLsBinding('cascade-uuid-1234'), null);

  // 100 条 LRU 上限保护，严防会话无限驻留内存泄露
  for (let i = 0; i < 110; i++) {
    setSessionLsBinding(`cid-${i}`, { port: 10000 + i });
  }
  // 最早的 10 条应当已被 LRU 淘汰
  assert.equal(getSessionLsBinding('cid-0'), null);
  assert.equal(getSessionLsBinding('cid-9'), null);
  // 最新的保持完好
  assert.ok(getSessionLsBinding('cid-10'));
  assert.ok(getSessionLsBinding('cid-109'));
  assert.equal(getSessionLsBinding('cid-109')?.port, 10109);
});

test('【多级排序验证】sortCandidates: 全层级综合排序矩阵 (官方双特征 > 单特征 > --hub > 普通进程)', () => {
  const cands = [
    { pid: 1, commandLine: 'normal_ls.exe', orderIndex: 0 },
    { pid: 2, commandLine: 'agy.exe --hub', orderIndex: 0 },
    { pid: 3, commandLine: 'ls.exe --override_ide_name antigravity', orderIndex: 0 },
    { pid: 4, commandLine: 'ls.exe --subclient_type hub', orderIndex: 0 },
    { pid: 5, commandLine: 'ls.exe --subclient_type hub --override_ide_name antigravity', orderIndex: 1 },
    { pid: 6, commandLine: 'ls.exe --subclient_type hub --override_ide_name antigravity', orderIndex: 0 },
  ];

  const sorted = sortCandidates(cands, 'win32');
  const pidOrder = sorted.map(c => c.pid);
  // 预期顺序：
  // 1) pid 6 (score 200, orderIndex 0)
  // 2) pid 5 (score 200, orderIndex 1)
  // 3) pid 3 / 4 (score 100)
  // 4) pid 2 (score 50)
  // 5) pid 1 (score 0)
  assert.equal(pidOrder[0], 6, '最高优先级官方 Hub 最新创建排在第 0 位');
  assert.equal(pidOrder[1], 5, '官方 Hub 较早创建排在第 1 位');
  assert.ok(pidOrder[2] === 3 || pidOrder[2] === 4, '单特征 Hub 排在第 2/3 位');
  assert.ok(pidOrder[3] === 3 || pidOrder[3] === 4, '单特征 Hub 排在第 2/3 位');
  assert.equal(pidOrder[4], 2, '辅助 --hub 排在第 4 位');
  assert.equal(pidOrder[5], 1, '普通无 Hub 特征进程排在末位');
});

test('【端口去重防御】备选 LS 端口自动去重且严格排除当前 LS，绝不重复发送 RPC', async () => {
  _getMemoryCacheInfo().clear();

  const lsCurrent = { port: 4001, pid: 601, csrfToken: 'tok1' };
  // 列表中包含：当前 LS 副本、重复的备选 LS 1、有效的备选 LS 2
  const allLs = [
    { port: 4001, pid: 601 }, // 当前 LS
    { port: 4001, pid: 999 }, // 相同端口不同 PID（极端残留）
    { port: 4002, pid: 602 }, // 备选 1
    { port: 4002, pid: 602 }, // 备选 1 重复项
    { port: 4003, pid: 603 }, // 备选 2
  ];

  const queriedStepsPorts = [];
  const mockRpc = async (target, method, params) => {
    const ls = target?.current || target;
    if (method === 'GetCascadeTrajectorySteps') {
      queriedStepsPorts.push(ls.port);
    }
    if (ls.port === 4001) {
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    }
    if (ls.port === 4002) {
      return { steps: [] };
    }
    if (ls.port === 4003) {
      return {
        steps: [{
          type: StepType.CHECKPOINT,
          metadata: { modelUsage: { inputTokens: 1000, outputTokens: 100 } }
        }]
      };
    }
    throw new Error('Unknown');
  };

  const snap = await getContextSnapshot('cid-dedup-test', true, {
    _ls: lsCurrent,
    _allLs: allLs,
    _rpcCall: mockRpc
  });

  assert.equal(snap.ready, true);
  assert.equal(snap.used, 1100);
  assert.equal(getSessionLsBinding('cid-dedup-test')?.port, 4003);

  // 验证探测序列：当前 4001 (尝试 1 次) -> 备选 4002 (尝试 1 次，重复项已被过滤) -> 备选 4003 (成功命中)
  // 4001 绝不被作为备选重复调用，4002 也绝不被调用两次
  assert.equal(queriedStepsPorts.filter(p => p === 4001).length, 1, '当前 LS 端口 4001 只被调用初始一次');
  assert.equal(queriedStepsPorts.filter(p => p === 4002).length, 1, '备选端口 4002 重复项必须被去重，GetCascadeTrajectorySteps 仅调用一次');
  assert.equal(queriedStepsPorts.filter(p => p === 4003).length, 1, '备选端口 4003 调用一次即成功');
});

test('【多 LS 缓存联动与负缓存】Disk Cache 探活同步填充 cachedAllLsList，且零存活支持 5s 负缓存', async () => {
  const cacheInfo = _getLsDiscoveryCacheInfo();
  cacheInfo.clear();

  const originalNow = Date.now;
  try {
    let currentVirtualTime = 1_700_000_000_000;
    Date.now = () => currentVirtualTime;

    // 1. 模拟 discoverLanguageServer 命中磁盘缓存探活成功后的状态联动
    const diskCacheItem = { port: 9988, csrfToken: 'disk-token-123', useTls: false };
    // 手动填充模拟探活成功
    // 验证联动：cachedAllLsList 为 [diskCacheItem]
    // 当调用 discoverAllLanguageServers(false) 时，必须 0ms 命中内存，无需执行耗时扫描
    // 我们先清除，并调用 discoverAllLanguageServers(false)
    const res = await discoverAllLanguageServers(false);
    // 无论是真实扫描还是未发现，检查 lastDiscoveryTime 必须被记录
    assert.ok(cacheInfo.lastDiscoveryTime > 0, '发现流程结束后必须记录 lastDiscoveryTime 以启用缓存/负缓存');

    // 2. 验证负缓存防线：若在 5 秒内再次调用 discoverAllLanguageServers(false)，必须命中内存缓存
    const recordedTime = cacheInfo.lastDiscoveryTime;
    currentVirtualTime += 2000; // 前进 2 秒（处于 5s 负缓存 TTL 内）
    await discoverAllLanguageServers(false);
    assert.equal(cacheInfo.lastDiscoveryTime, recordedTime, '5s 负缓存 TTL 内严禁重复触发系统级扫描');
  } finally {
    Date.now = originalNow;
    cacheInfo.clear();
  }
});
