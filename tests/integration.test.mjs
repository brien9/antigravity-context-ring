import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  processTrajectorySteps,
  StepType
} from '../sidecars/ring/context-calculator.mjs';
import { formatContextResult, getContextSnapshot, getStepFingerprint } from '../sidecars/ring/context-service.mjs';
import { CdpConnection } from '../sidecars/ring/runtime-bridge.mjs';
import installAgContextRingWidget from '../assets/ring-widget.cjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('场景 1: 新会话开始，数据从无到有 (中性空心状态过渡到有数据)', () => {
  // 会话尚未产生任何 step
  const unreadyResult = processTrajectorySteps([]);
  const unreadyView = formatContextResult(unreadyResult);
  assert.equal(unreadyView.ready, false);
  assert.equal(unreadyView.ratio, 0);
  assert.equal(unreadyView.usedK, '—');
  assert.equal(unreadyView.tooltip, '暂无上下文数据');

  // 用户刚发出第一条输入
  const initialSteps = [
    {
      type: StepType.USER_INPUT,
      userInput: { userResponse: '请帮我写一个 Python 贪吃蛇' }
    }
  ];
  const initialResult = processTrajectorySteps(initialSteps, { fallbackModel: 'MODEL_PLACEHOLDER_M318' });
  const initialView = formatContextResult(initialResult);
  assert.equal(initialView.ready, true);
  assert.ok(initialView.used > 0);
  assert.ok(initialView.tooltip.includes('上下文已使用'));
});

test('场景 2: 多轮对话 Token 持续增长', () => {
  let steps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: 50_000,
          outputTokens: 2_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    }
  ];
  const round1 = formatContextResult(processTrajectorySteps(steps));

  // 第二轮对话
  steps.push({
    type: StepType.USER_INPUT,
    userInput: { userResponse: '再添加一个分数排行榜功能' }
  });
  steps.push({
    type: StepType.PLANNER_RESPONSE,
    plannerResponse: { response: '好的，这是排行榜代码...', thinking: '正在实现 SQLite 本地存储...' },
    metadata: { toolCallOutputTokens: 1_500 } // 方案 C：结算前仅服务端工具输出增量推动增长
  });
  const round2 = formatContextResult(processTrajectorySteps(steps));

  assert.ok(round2.used > round1.used);
  assert.ok(round2.ratio > round1.ratio);
});

test('场景 3 & 4: 接近阈值并在自动上下文压缩后成功捕获', () => {
  const steps = [
    // 接近 256K 截断线
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: 245_000,
          outputTokens: 3_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    },
    // 平台触发上下文压缩，新 Checkpoint 输入大幅回落
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: 60_000,
          outputTokens: 1_500,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    }
  ];

  const compressed = processTrajectorySteps(steps);
  assert.equal(compressed.compressionDetected, true);
  assert.equal(compressed.compressionDrop, 185_000);
  assert.equal(compressed.contextUsed, 61_500);

  const view = formatContextResult(compressed);
  assert.equal(view.compressionDetected, true);
  assert.equal(view.used, 61_500);
});

test('场景 5: 用户撤销或回退对话步骤，占用量相应减少', () => {
  const stepA = {
    type: StepType.CHECKPOINT,
    metadata: {
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M318',
        inputTokens: 80_000,
        outputTokens: 1_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }
    }
  };
  const stepB = {
    type: StepType.USER_INPUT,
    userInput: { userResponse: '准备撤销的长段落文本输入内容' },
    metadata: { toolCallOutputTokens: 2_000 } // 方案 C：以服务端工具输出增量验证回退
  };

  const beforeRollback = processTrajectorySteps([stepA, stepB]);
  const afterRollback = processTrajectorySteps([stepA]);

  assert.ok(afterRollback.contextUsed < beforeRollback.contextUsed);
});

test('场景 6: 模型切换及平台压缩阈值联动', () => {
  // Gemini 3.8 Flash -> 256K 阈值
  const flashSteps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: 64_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    }
  ];
  const flashView = formatContextResult(processTrajectorySteps(flashSteps));
  assert.equal(flashView.limit, 256_000);
  assert.equal(flashView.percent, '25.0%');

  // 用户在对话中切换为 Gemini 3.1 Pro -> 128K 阈值
  const proSteps = [
    ...flashSteps,
    {
      type: StepType.USER_INPUT,
      userInput: {
        userResponse: '换用 Pro 深度思考',
        userConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M16' } }
      }
    }
  ];
  const proView = formatContextResult(processTrajectorySteps(proSteps));
  assert.equal(proView.limit, 128_000);
  // 64000 左右在 128K 中占比约 50%
  assert.ok(proView.ratio >= 0.5);
});

test('场景 7: 切换会话时，状态完全隔离', () => {
  const session1Steps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: 180_000,
          outputTokens: 2_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    }
  ];
  const session2Steps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: 20_000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    }
  ];

  const view1 = formatContextResult(processTrajectorySteps(session1Steps));
  const view2 = formatContextResult(processTrajectorySteps(session2Steps));

  assert.notEqual(view1.used, view2.used);
  assert.notEqual(view1.percent, view2.percent);
});

test('场景 8: 异常响应或断连时的中性兜底', () => {
  const errView = formatContextResult(null);
  assert.equal(errView.ready, false);
  assert.equal(errView.ratio, 0);
  assert.equal(errView.usedK, '—');
});

test('极限场景 1: 超限与压缩感知的视图层与气泡格式化', () => {
  // 1. 模拟发生压缩的场景
  const compressedCalc = {
    ready: true,
    contextUsed: 62_000,
    contextLimit: 256_000,
    usageRatio: 62_000 / 256_000,
    compressionDetected: true,
    compressionDrop: 180_000,
    isOverLimit: false,
    isEstimated: false,
  };
  const compView = formatContextResult(compressedCalc);
  assert.equal(compView.compressionDetected, true);
  assert.ok(compView.tooltip.includes('上下文已压缩 释放 180.0K'));

  // 2. 模拟超长溢出截断场景
  const overLimitCalc = {
    ready: true,
    contextUsed: 260_000,
    contextLimit: 256_000,
    usageRatio: 1.05,
    compressionDetected: false,
    compressionDrop: 0,
    isOverLimit: true,
    isEstimated: false,
  };
  const overView = formatContextResult(overLimitCalc);
  assert.equal(overView.isOverLimit, true);
  assert.equal(overView.ratio, 1.0); // 截断到 1.0
  assert.ok(overView.tooltip.includes('已达截断阈值'));
});

test('极限场景 2: 断网/离线下的 SWR 稳态守卫模拟', () => {
  // 模拟 sessionCache
  const mockCache = new Map();
  const testCid = 'c1234567-89ab-cdef-0123-456789abcdef';

  // 1. 初次请求成功，写入稳态缓存
  const initialData = formatContextResult({
    ready: true,
    contextUsed: 83_600,
    contextLimit: 256_000,
    usageRatio: 83_600 / 256_000,
    compressionDetected: false,
    compressionDrop: 0,
    isOverLimit: false,
  });
  mockCache.set(testCid, initialData);

  // 2. 模拟网络突然中断或 CDP 超时返回未就绪
  const networkErrorResponse = { ready: false, offline: true };

  // 核心守卫逻辑判定：若网络未就绪但已有缓存，稳固继承旧快照，绝不抹黑 UI！
  let displayedView = null;
  if (networkErrorResponse && networkErrorResponse.ready) {
    displayedView = networkErrorResponse;
  } else {
    const cached = mockCache.get(testCid);
    if (cached) {
      displayedView = {
        ...cached,
        tooltip: cached.tooltip.includes('(离线)') ? cached.tooltip : `${cached.tooltip} (离线)`
      };
    } else {
      displayedView = { ready: false };
    }
  }

  assert.equal(displayedView.ready, true);
  assert.equal(displayedView.used, 83_600);
  assert.equal(displayedView.limit, 256_000);
  assert.ok(displayedView.tooltip.includes('(离线)'));
  assert.ok(!displayedView.tooltip.includes('暂无上下文数据'));
});

test('极限场景 3: 历史会话按需加载与已访问会话 LocalStorage 0ms 秒显 (告别全量预热反模式)', async () => {
  const sessionCache = new Map();
  const localStorageMock = new Map();
  const setCachedSnapshot = (cid, data) => {
    sessionCache.set(cid.toLowerCase(), data);
    localStorageMock.set(`ag_ring_snap_${cid.toLowerCase()}`, JSON.stringify(data));
  };
  const getCachedSnapshot = (cid) => {
    const lower = cid.toLowerCase();
    if (sessionCache.has(lower)) return sessionCache.get(lower);
    const raw = localStorageMock.get(`ag_ring_snap_${lower}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      sessionCache.set(lower, parsed);
      return parsed;
    }
    return null;
  };

  const oldVisitedCid = '11111111-2222-3333-4444-555555555555';
  const neverVisitedColdCid = '66666666-7777-8888-9999-000000000000';

  // 1. 已访问过的会话（存在于 LocalStorage） -> 0ms 瞬间秒出
  setCachedSnapshot(oldVisitedCid, formatContextResult({
    ready: true,
    contextUsed: 50_000,
    contextLimit: 256_000,
    usageRatio: 50000 / 256000
  }));
  sessionCache.clear(); // 模拟页面刷新或跨会话内存淘汰，仅保留 LocalStorage

  const instantSnapshot = getCachedSnapshot(oldVisitedCid);
  assert.ok(instantSnapshot);
  assert.equal(instantSnapshot.ready, true);
  assert.equal(instantSnapshot.used, 50_000);

  // 2. 从未访问过的冷会话（无预热注入、无缓存） -> 初始未命中，走按需拉取后存入缓存
  assert.equal(getCachedSnapshot(neverVisitedColdCid), null);

  // 模拟按需 RPC 请求到达并回填
  const onDemandData = formatContextResult({
    ready: true,
    contextUsed: 120_000,
    contextLimit: 128_000,
    usageRatio: 120000 / 128000
  });
  setCachedSnapshot(neverVisitedColdCid, onDemandData);

  const afterFetched = getCachedSnapshot(neverVisitedColdCid);
  assert.ok(afterFetched);
  assert.equal(afterFetched.ready, true);
  assert.equal(afterFetched.limit, 128_000);
});

test('极限场景 4: 原生 React agentStateProvider 状态机草稿与会话隔离验证', () => {
  // 模拟 React agentStateProvider 的状态推导
  const mockProviderState1 = {
    conversationId: 'aaaa1111-bbbb-2222-cccc-333344445555',
    trajectorySlice: { totalStepsLength: 0 },
    turns: []
  };

  const isDraftFromState = (state) => {
    const stepsLen = state?.trajectorySlice?.totalStepsLength;
    if (typeof stepsLen === 'number') return stepsLen === 0;
    if (Array.isArray(state?.turns)) return state.turns.length === 0;
    return false;
  };

  // 草稿态校验：0 步数 100% 确认草稿
  assert.equal(isDraftFromState(mockProviderState1), true);

  // 会话产生了步骤
  const mockProviderState2 = {
    conversationId: 'aaaa1111-bbbb-2222-cccc-333344445555',
    trajectorySlice: { totalStepsLength: 15 },
    turns: [{ startStepIndex: 0 }]
  };
  assert.equal(isDraftFromState(mockProviderState2), false);
});

test('极限场景 5: 冷会话未命中缓存时绝不抹成空白圆环，优雅呈现快速估算或微光过渡', () => {
  const sessionCache = new Map();
  const getCachedSnapshot = (cid) => sessionCache.get(cid);

  const getFiberQuickEstimate = (cid, state) => {
    if (!cid || state?.conversationId !== cid) return null;
    const steps = state?.trajectorySlice?.totalStepsLength || 0;
    if (steps > 0) {
      const estTokens = Math.min(Math.round(steps * 1200), 256000);
      const estRatio = Math.max(0.04, Math.min(estTokens / 256000, 0.98));
      return {
        ready: true,
        ratio: estRatio,
        used: estTokens,
        limit: 256000,
        usedK: (estTokens / 1000).toFixed(1) + 'K',
        limitK: '256.0K',
        percent: Math.round(estRatio * 1000) / 10 + '%',
        tooltip: `约 ${(estTokens / 1000).toFixed(1)}K / 256.0K 上下文 (正在校准...)`,
        isEstimated: true
      };
    }
    return null;
  };

  const coldCid = '77777777-8888-9999-aaaa-bbbbccccdddd';

  // 1. 无缓存、但 React 已持有 20 步的冷会话
  const stateWithSteps = {
    conversationId: coldCid,
    trajectorySlice: { totalStepsLength: 20 },
    turns: [{}, {}]
  };
  const fastEst = getFiberQuickEstimate(coldCid, stateWithSteps);
  assert.ok(fastEst);
  assert.equal(fastEst.ready, true);
  assert.equal(fastEst.used, 24000);
  assert.ok(fastEst.ratio > 0.05);

  // 2. 无缓存且 React 数据尚在 pending 的极限情况
  const pendingState = {
    conversationId: coldCid,
    trajectorySlice: null,
    turns: null
  };
  let coldView = null;
  const cached = getCachedSnapshot(coldCid);
  if (cached) {
    coldView = cached;
  } else {
    const est = getFiberQuickEstimate(coldCid, pendingState);
    if (est) {
      coldView = est;
    } else {
      coldView = {
        ready: true,
        isPending: true,
        ratio: 0.15,
        tooltip: '正在同步上下文进度...'
      };
    }
  }

  // 验证：绝不是 ready: false 的白环！而是微光过渡态
  assert.equal(coldView.ready, true);
  assert.equal(coldView.isPending, true);
  assert.equal(coldView.ratio, 0.15);
  assert.equal(coldView.tooltip, '正在同步上下文进度...');
});

test('极限场景 6: 离线或错误时绝不将已有红色/警告进度清零抹黑', () => {
  // 模拟一个已有高用量红色状态的当前视图数据
  let currentView = {
    ready: true,
    ratio: 0.95,
    percent: '95.0%',
    used: 243200,
    usedK: '243.2K',
    limit: 256000,
    limitK: '256.0K',
    tooltip: '95.0% · 243.2K / 256.0K 已达截断阈值'
  };

  // 模拟收到 { ready: false } 故障响应（例如断网或超时）
  function updateViewMock(current, incoming) {
    if (!incoming.ready) {
      if (current && current.ready && !current.isDraft) {
        return {
          ...current,
          tooltip: current.tooltip.includes('(离线)') ? current.tooltip : `${current.tooltip} (离线)`
        };
      }
      return { ready: false, ratio: 0, opacity: 0 };
    }
    return incoming;
  }

  const result = updateViewMock(currentView, { ready: false });

  // 验证：即使收到 ready: false，高危进度坚决不能归零，保留 95% 与原数值！
  assert.equal(result.ready, true);
  assert.equal(result.ratio, 0.95);
  assert.equal(result.used, 243200);
  assert.ok(result.tooltip.includes('(离线)'));
});

test('【阶段三集成测试 1】长会话分页拉取：超过 1000 步时分批循环抓取并无损合并', async () => {
  // 模拟 RPC 分页响应器
  const PAGE_SIZE = 1000;
  const mockPages = {
    0: Array.from({ length: 1000 }, (_, i) => ({
      type: StepType.PLANNER_RESPONSE,
      plannerResponse: { response: `Step ${i}` }
    })),
    1000: [
      ...Array.from({ length: 449 }, (_, i) => ({
        type: StepType.PLANNER_RESPONSE,
        plannerResponse: { response: `Step ${1000 + i}` }
      })),
      // 第 1450 步：超长对话末尾生成的精确 Checkpoint
      {
        type: StepType.CHECKPOINT,
        metadata: {
          modelUsage: {
            model: 'MODEL_PLACEHOLDER_M318',
            inputTokens: 180_000,
            outputTokens: 2_000,
            cacheReadTokens: 15_000,
            cacheCreationTokens: 500,
          }
        }
      }
    ]
  };

  let rpcCallCount = 0;
  async function mockRpcCall(method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      rpcCallCount++;
      const start = params.startIndex;
      return { steps: mockPages[start] || [] };
    }
    return {};
  }

  // 模拟 context-service 内部的分页拉取算法
  const MAX_PAGES = 5;
  const allSteps = [];
  let startIndex = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const stepsResp = await mockRpcCall('GetCascadeTrajectorySteps', {
      cascadeId: 'mock-long-cascade',
      startIndex,
      endIndex: startIndex + PAGE_SIZE
    });
    const pageSteps = Array.isArray(stepsResp?.steps) ? stepsResp.steps : [];
    if (pageSteps.length === 0) break;
    allSteps.push(...pageSteps);
    if (pageSteps.length < PAGE_SIZE) break;
    startIndex += pageSteps.length;
  }

  assert.equal(rpcCallCount, 2); // 精确发起了 2 次分页请求
  assert.equal(allSteps.length, 1450); // 完整拿到了 1450 步

  const calc = processTrajectorySteps(allSteps);
  const view = formatContextResult(calc);

  // 验证：超长会话末尾的 Checkpoint 被完整捕获，没有因为截断在 1000 步而丢失！
  assert.equal(view.ready, true);
  assert.equal(view.stepCount, 1450);
  assert.equal(view.lastStepIndex, 1449);
  // 权威物理占用量: 180000 input + 15000 cacheRead + 500 cacheCreation + 2000 output = 197500
  assert.equal(view.used, 197_500);
  assert.equal(view.isEstimated, false);
  assert.equal(view.inputTokens, 180_000);
  assert.equal(view.cacheReadTokens, 15_000);
});

test('【阶段三集成测试 2】长会话熔断安全网：极端长对话在 5000 步时硬顶跳出，杜绝死循环', async () => {
  const PAGE_SIZE = 1000;
  let callCount = 0;
  async function endlessRpcCall() {
    callCount++;
    // 永远返回满额 1000 步
    return { steps: Array.from({ length: PAGE_SIZE }, () => ({ type: StepType.PLANNER_RESPONSE })) };
  }

  const MAX_PAGES = 5;
  const allSteps = [];
  let startIndex = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await endlessRpcCall();
    const pageSteps = resp.steps || [];
    if (pageSteps.length === 0) break;
    allSteps.push(...pageSteps);
    if (pageSteps.length < PAGE_SIZE) break;
    startIndex += pageSteps.length;
  }

  // 严格在第 5 页熔断停止
  assert.equal(callCount, 5);
  assert.equal(allSteps.length, 5000);
});

test('【阶段三集成测试 3】全链路三层模型解耦与视图呈现：主模型与子 Agent 隔离', () => {
  const steps = [
    {
      type: StepType.USER_INPUT,
      userInput: {
        userResponse: '写一个微服务架构方案',
        userConfig: {
          plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M16' } // Pro 128K
        }
      }
    },
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M16',
          inputTokens: 90_000,
          outputTokens: 2_000,
          cacheReadTokens: 10_000,
          cacheCreationTokens: 0,
        }
      }
    },
    // 中途派生多个子 Agent 运行轻量模型 (Flash 256K)
    {
      type: StepType.INVOKE_SUBAGENT,
      metadata: {
        generatorModel: 'MODEL_PLACEHOLDER_M318',
        toolCallOutputTokens: 500
      }
    }
  ];

  const calc = processTrajectorySteps(steps);
  const view = formatContextResult(calc);

  assert.equal(view.ready, true);
  assert.equal(view.selectedModel, 'MODEL_PLACEHOLDER_M16');
  assert.equal(view.executionModel, 'MODEL_PLACEHOLDER_M318');
  assert.equal(view.limit, 128_000);
  assert.equal(view.limitK, '128.0K');
  // 权威物理总用量: 90000 input + 10000 cacheRead + 2000 output + 500 tool = 102500
  assert.equal(view.used, 102_500);
  assert.equal(view.usedK, '102.5K');
  // 占比: 102500 / 128000 ≈ 80.1%
  assert.equal(view.percent, '80.1%');
  assert.ok(view.tooltip.includes('80.1% · 102.5K / 128.0K 上下文已使用'));
});

test('【阶段三集成测试 4】恰好 5000 步：单步前瞻确认为自然结束，不得误报截断；999 步不截断', async () => {
  const PAGE_SIZE = 1000;
  let rpcCalls = 0;
  const requestedRanges = [];

  async function mockRpc(target, method, params) {
    rpcCalls++;
    requestedRanges.push({ start: params.startIndex, end: params.endIndex });
    if (params.startIndex >= 5000) return { steps: [] };
    // 每页均返回满整页 1000 条具有唯一 ID 的 step
    return {
      steps: Array.from({ length: PAGE_SIZE }, (_, i) => ({
        stepIndex: params.startIndex + i,
        type: StepType.PLANNER_RESPONSE,
        plannerResponse: { response: `Step ${params.startIndex + i}` }
      }))
    };
  }

  // 1. 真实调用 context-service.getContextSnapshot
  const view = await getContextSnapshot('mock-cascade-exact-5000', true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 5 页数据 + 1 次单步边界探针
  assert.equal(rpcCalls, 6);
  assert.equal(view.stepCount, 5000);
  assert.equal(view.isTruncated, false, '恰好 5000 步且边界探针为空时必须视为完整轨迹');
  assert.equal(view.isWindowed, false);

  // 验证每次请求均严格等长对称（无 PAGE_SIZE + 1 缝合窗口）
  for (const r of requestedRanges) {
    assert.equal(r.end - r.start, 1000, '每次 RPC 请求区间跨度必须严格固定为 1000');
  }

  assert.ok(!view.tooltip.includes('不完整') && !view.tooltip.includes('长会话'), `完整 5000 步不得误报数据缺失: ${view.tooltip}`);

  // 边界验证：若第 5 页仅返回 999 条（总共 4999 条），绝不能误判为截断
  let boundaryCalls = 0;
  async function mockBoundaryRpc(target, method, params) {
    boundaryCalls++;
    const len = params.startIndex === 4000 ? 999 : PAGE_SIZE;
    return {
      steps: Array.from({ length: len }, (_, i) => ({
        stepIndex: params.startIndex + i,
        type: StepType.PLANNER_RESPONSE,
        plannerResponse: { response: `Step ${params.startIndex + i}` }
      }))
    };
  }

  const boundaryView = await getContextSnapshot('mock-cascade-boundary-999', true, {
    _ls: { port: 9999 },
    _rpcCall: mockBoundaryRpc
  });

  assert.equal(boundaryCalls, 5, '第 5 页无论 999 还是 1000 均需完整发起');
  assert.equal(boundaryView.stepCount, 4999);
  assert.equal(boundaryView.isTruncated, false, '第 5 页返回 999 条（小于 1000）代表自然结束，绝不能标记截断');
  assert.ok(!boundaryView.tooltip.includes('截断'), '未截断会话 tooltip 不得含截断字样');
});

test('【阶段三集成测试 4-B】6000 步超长会话：读取最新尾部窗口，末步 Checkpoint 不得被前 5000 步遮蔽', async () => {
  const total = 6000;
  const steps = Array.from({ length: total }, (_, i) => ({
    stepIndex: i,
    type: StepType.PLANNER_RESPONSE,
    plannerResponse: { response: `Step ${i}` }
  }));
  steps[0] = {
    stepIndex: 0,
    type: StepType.CHECKPOINT,
    metadata: {
      modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 10_000, outputTokens: 0 }
    }
  };
  steps[total - 1] = {
    stepIndex: total - 1,
    type: StepType.CHECKPOINT,
    metadata: {
      modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 200_000, outputTokens: 0 }
    }
  };

  let summaryCalls = 0;
  let dataCalls = 0;
  async function mockRpc(target, method, params) {
    if (method === 'GetAllCascadeTrajectories') {
      summaryCalls++;
      return {
        trajectorySummaries: {
          'mock-cascade-6000': { stepCount: total, lastModifiedTime: '2026-11-09T12:00:00Z' }
        }
      };
    }
    dataCalls++;
    return { steps: steps.slice(params.startIndex, params.endIndex) };
  }

  const view = await getContextSnapshot('mock-cascade-6000', true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  assert.equal(summaryCalls, 1, '仅在确认超过 5000 步后才查询一次权威总步数');
  assert.equal(dataCalls, 7, '5 页前缀 + 1 次边界探针 + 1 页尾部补齐');
  assert.equal(view.stepCount, 5000, '只保留并分析最新 5000 步窗口');
  assert.equal(view.totalSteps, 6000);
  assert.equal(view.isWindowed, true);
  assert.equal(view.isTruncated, true, '窗口化属于不完整分析，必须显式标记而非伪装完整');
  assert.equal(view.used, 200_000, '必须采用第 5999 步的最新 Checkpoint，而不是停留在旧水位');
  assert.equal(view.lastStepIndex, 5999, '必须保留服务端真实步号');
  assert.match(view.tooltip, /长会话尾部 5000\/6000 步/);
});

test('【阶段三集成测试 4-C】恰好 5000 步：边界探针为空即结束，不得误报窗口化或截断', async () => {
  const total = 5000;
  const steps = Array.from({ length: total }, (_, i) => ({
    stepIndex: i,
    type: StepType.PLANNER_RESPONSE,
    plannerResponse: { response: `Step ${i}` }
  }));
  steps[total - 1] = {
    stepIndex: total - 1,
    type: StepType.CHECKPOINT,
    metadata: {
      modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 200_000, outputTokens: 0 }
    }
  };

  let summaryCalls = 0;
  let dataCalls = 0;
  async function mockRpc(target, method, params) {
    if (method === 'GetAllCascadeTrajectories') {
      summaryCalls++;
      return { trajectorySummaries: {} };
    }
    dataCalls++;
    return { steps: steps.slice(params.startIndex, params.endIndex) };
  }

  const view = await getContextSnapshot('mock-cascade-5000', true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  assert.equal(summaryCalls, 0, '恰好 5000 步时边界探针已足以判定结束，不得再查权威总步数');
  assert.equal(dataCalls, 6, '应为 5 页前缀 + 1 次边界探针，且不发起尾部补页');
  assert.equal(view.stepCount, 5000);
  assert.equal(view.totalSteps, 5000);
  assert.equal(view.isWindowed, false, '完整 5000 步不得被标记为尾部窗口');
  assert.equal(view.isTruncated, false, '完整 5000 步不得误报截断');
  assert.equal(view.used, 200_000, '末步 Checkpoint 必须被采纳');
  assert.equal(view.lastStepIndex, 4999);
  assert.ok(!view.tooltip.includes('长会话尾部'), '完整会话不得显示尾部窗口提示');
  assert.ok(!view.tooltip.includes('不完整'), '完整会话不得显示数据不完整');
});

test('【阶段三集成测试 5】标准等长分页提前退出：单页小于 1000 步正常结束且 isTruncated = false', async () => {
  let rpcCalls = 0;

  async function mockRpc(target, method, params) {
    rpcCalls++;
    if (params.startIndex === 0) {
      return {
        steps: Array.from({ length: 1000 }, (_, i) => ({
          stepIndex: i,
          type: StepType.PLANNER_RESPONSE
        }))
      };
    }
    if (params.startIndex === 1000) {
      // 第 2 页只有 350 条（小于 1000），标志着会话结束
      return {
        steps: Array.from({ length: 350 }, (_, i) => ({
          stepIndex: 1000 + i,
          type: StepType.PLANNER_RESPONSE
        }))
      };
    }
    return { steps: [] };
  }

  // 真实调用 context-service.getContextSnapshot
  const view = await getContextSnapshot('mock-cascade-normal', true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  assert.equal(rpcCalls, 2, '第 2 页小于 1000 时应立即退出，不应发起第 3 页');
  assert.equal(view.stepCount, 1350);
  assert.equal(view.isTruncated, false, '正常提前退出的会话绝不能标记截断');
  assert.ok(!view.tooltip.includes('截断'));
});

test('【阶段三集成测试 6】服务端忽略分页返回重复步骤：seenStepKeys 保证短路熔断防死循环', async () => {
  let rpcCalls = 0;

  // 模拟服务端 Bug：无论 startIndex 是多少，始终返回第一页的相同步骤
  async function buggyRpc(target, method, params) {
    rpcCalls++;
    return {
      steps: Array.from({ length: 1000 }, (_, i) => ({
        stepIndex: i, // 固定的 stepIndex
        type: StepType.PLANNER_RESPONSE
      }))
    };
  }

  // 真实调用 context-service.getContextSnapshot
  const view = await getContextSnapshot('mock-cascade-buggy', true, {
    _ls: { port: 9999 },
    _rpcCall: buggyRpc
  });

  assert.equal(rpcCalls, 2, '第 2 页步骤全部重复时，addedInPage === 0 必须立即短路熔断');
  assert.equal(view.stepCount, 1000, '只收纳第 1 页的有效 1000 步');
  assert.equal(view.isTruncated, false);
});

test('【阶段三集成测试 7】无 stepIndex/id/contentId 时服务端重复吐出全量数据：第二道防线轻量首步指纹跨页比对短路熔断', async () => {
  let rpcCalls = 0;

  // 模拟服务端 Bug：步骤对象没有任何 stepIndex、id 或 modelApiContentId，且每次请求均返回相同的全量列表
  async function buggyRpcWithoutIds(target, method, params) {
    rpcCalls++;
    return {
      steps: Array.from({ length: 1000 }, (_, i) => ({
        type: StepType.PLANNER_RESPONSE,
        plannerResponse: { response: `Planner response step without id ${i}` }
      }))
    };
  }

  const view = await getContextSnapshot('mock-cascade-buggy-no-id', true, {
    _ls: { port: 9999 },
    _rpcCall: buggyRpcWithoutIds
  });

  // 验证：尽管 steps 没有任何显式 ID，第二道首步指纹比对必须在第 2 页立即识别出重复并熔断短路
  assert.equal(rpcCalls, 2, '第 2 页首步指纹与第 1 页相同时，必须立即短路熔断，不应持续请求到第 5 页');
  assert.equal(view.stepCount, 1000, '只收纳第 1 页的有效 1000 步');
  assert.equal(view.isTruncated, false);
});

test('【阶段三集成测试 8】超长单次直退（第一道防线）：单次返回大于 PAGE_SIZE 判定服务端一次性全量吐出，收集后直接退出', async () => {
  let rpcCalls = 0;
  async function singleFullRpc(target, method, params) {
    rpcCalls++;
    return {
      steps: Array.from({ length: 1500 }, (_, i) => ({
        stepIndex: i,
        type: StepType.PLANNER_RESPONSE,
        plannerResponse: { response: `Step ${i}` }
      }))
    };
  }

  const view = await getContextSnapshot('mock-cascade-oversize-single', true, {
    _ls: { port: 9999 },
    _rpcCall: singleFullRpc
  });

  assert.equal(rpcCalls, 1, '第一道防线生效，一次性全量吐出时收集后直接 break，不发起第 2 页请求');
  assert.equal(view.stepCount, 1500);
  assert.equal(view.isTruncated, false);
});

test('【阶段三集成测试 9】并行工具调用具有相同 createdAt：防碰撞 stepKey 拼接页内下标，正常保留无误删', async () => {
  const sharedTimestamp = '2026-11-09T10:00:00.123456789Z';
  const parallelToolSteps = [
    {
      type: StepType.USER_INPUT,
      userInput: { userResponse: '请帮我搜索并下载这三个文件' }
    },
    // 3 个并行发起的工具调用步骤，没有 stepIndex/id，时间戳完全相同
    {
      type: StepType.TOOL_CALL,
      metadata: { createdAt: sharedTimestamp, toolCallOutputTokens: 200 }
    },
    {
      type: StepType.TOOL_CALL,
      metadata: { createdAt: sharedTimestamp, toolCallOutputTokens: 300 }
    },
    {
      type: StepType.TOOL_CALL,
      metadata: { createdAt: sharedTimestamp, toolCallOutputTokens: 400 }
    }
  ];

  async function mockRpc(target, method, params) {
    return { steps: parallelToolSteps };
  }

  const view = await getContextSnapshot('mock-cascade-parallel-tools', true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 4 个步骤必须全部被保留，绝不能因为相同 createdAt 碰撞导致误杀
  assert.equal(view.stepCount, 4, '4 个步骤（含 3 个相同 createdAt 的并行工具调用）必须全部保留');
  assert.equal(view.ready, true);
});

test('【阶段三集成测试 10】跨页首步为同类型无文本步骤（如 Checkpoint 或仅含 ToolCall）且无显式 ID 时，第二道防线绝不误判碰撞，正常翻页', async () => {
  let rpcCalls = 0;
  // 第 0 页首步为 Checkpoint（100 inputTokens），共 1000 步
  const page0Steps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 }
      }
    },
    ...Array.from({ length: 999 }, (_, i) => ({
      type: StepType.PLANNER_RESPONSE,
      plannerResponse: { response: `P0 Step ${i + 1}` }
    }))
  ];

  // 第 1 页首步亦为 Checkpoint（5000 inputTokens），共 200 步
  const page1Steps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 5000, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 }
      }
    },
    ...Array.from({ length: 199 }, (_, i) => ({
      type: StepType.PLANNER_RESPONSE,
      plannerResponse: { response: `P1 Step ${i + 1}` }
    }))
  ];

  async function mockRpc(target, method, params) {
    rpcCalls++;
    if (params.startIndex === 0) return { steps: page0Steps };
    if (params.startIndex === 1000) return { steps: page1Steps };
    return { steps: [] };
  }

  const view = await getContextSnapshot('mock-cascade-checkpoints-across-pages', true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  assert.equal(rpcCalls, 2, '两页均需正常拉取，第 2 页绝不能因为同为 CHECKPOINT 发生指纹误撞被阻断');
  assert.equal(view.stepCount, 1200, '总步数应完整收纳两页合计 1200 步');
  assert.equal(view.used, 5050, '以第 2 页末尾最新 Checkpoint 5000+50 为权威基准');
});

test('【阶段三集成测试 11】Protobuf 默认空字符串 id/modelApiContentId 时防碰撞 stepKey 正常回退，绝不发生误杀或仅剩 1 步', async () => {
  const stepsWithEmptyId = Array.from({ length: 10 }, (_, i) => ({
    id: '', // Protobuf 默认序列化空串
    metadata: { modelApiContentId: '' },
    type: StepType.PLANNER_RESPONSE,
    plannerResponse: { response: `Empty ID Step ${i}` }
  }));

  async function mockRpc(target, method, params) {
    return { steps: stepsWithEmptyId };
  }

  const view = await getContextSnapshot('mock-cascade-empty-id', true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  assert.equal(view.stepCount, 10, '所有 10 个步骤必须全部保留，绝不能因为 id: "" 误判全碰撞导致只剩 1 步');
});

test('【阶段三集成测试 12】极端循环引用与畸形步骤对象：getStepFingerprint 安全提取且不同对象互不碰撞', () => {
  const c1 = { type: StepType.USER_INPUT, userInput: { userResponse: '问答 1' } };
  c1.self = c1;
  const c2 = { type: StepType.USER_INPUT, userInput: { userResponse: '问答 2' } };
  c2.self = c2;

  const fp1 = getStepFingerprint(c1);
  const fp2 = getStepFingerprint(c2);

  assert.ok(fp1 && typeof fp1 === 'string');
  assert.ok(fp2 && typeof fp2 === 'string');
  assert.notEqual(fp1, fp2, '不同内容的循环引用对象指纹必须区分');

  // 无文本且含循环引用的深层畸形对象
  const c3 = { type: 'CUSTOM_TYPE', val: 123 };
  c3.ref = c3;
  const c4 = { type: 'CUSTOM_TYPE', val: 456 };
  c4.ref = c4;

  const fp3 = getStepFingerprint(c3);
  const fp4 = getStepFingerprint(c4);
  assert.ok(fp3 && typeof fp3 === 'string');
  assert.ok(fp4 && typeof fp4 === 'string');
  assert.notEqual(fp3, fp4, '不同属性值的无文本循环引用对象指纹不得碰撞为相同常数');
});

test('【静态架构审计】等长分页 + 权威总步数尾部窗口，禁止 PAGE_SIZE+1 与无限扫描', () => {
  const code = readFileSync(resolve(__dirname, '../sidecars/ring/context-service.mjs'), 'utf8');

  // 1. 禁止不可移植的 PAGE_SIZE+1 前瞻缝合
  assert.ok(!code.includes('PAGE_SIZE + 1'), '严禁存在 PAGE_SIZE + 1 前瞻探针');
  assert.ok(!code.includes('requestSize'), '严禁存在 requestSize 前瞻尺寸计算');
  assert.ok(!code.includes('isWindowBoundary'), '严禁存在 isWindowBoundary 临界判定');

  // 2. 禁止无上限扫描或旧式头尾缝合常量
  assert.ok(!code.includes('MAX_SCAN_PAGES'), '严禁存在无上限 / 15 页扫描');
  assert.ok(!code.includes('MAX_RETAINED_STEPS'), '严禁存在无约束保留量');
  assert.ok(!code.includes('headConfigIdx'), '严禁存在 headConfigIdx 头尾缝合代码');

  // 3. 确立对称等长分页、权威 stepCount 与尾部窗口
  assert.ok(code.includes('const PAGE_SIZE = 1000;'), '必须固定 PAGE_SIZE = 1000');
  assert.ok(code.includes('const MAX_PREFIX_PAGES = 5;'), '前缀扫描必须固定为 5 页');
  assert.ok(code.includes('const TAIL_WINDOW_STEPS = 5000;'), '必须固定最新尾部窗口大小');
  assert.ok(code.includes('endIndex: pageStart + PAGE_SIZE'), 'RPC 请求参数必须严格等长');
  assert.ok(code.includes("stepCount"), '必须读取权威轨迹总步数');
  assert.ok(code.includes('seenStepKeys'), '必须维护 seenStepKeys 集合');
});

test('【阶段三集成测试 13】真实调用 getContextSnapshot 的 1001 步跨页同时间戳测试：弱指纹移除后完整保留 1001 步且未截断', async () => {
  let rpcCalls = 0;
  const sameTimestamp = '2026-03-30T10:00:00.000Z';

  // 1. 验证带 stepIndex 时的 1001 步跨页同时间戳场景
  async function mockRpc(target, method, params) {
    rpcCalls++;
    if (params.startIndex === 0) {
      // 第 0 页：1000 步，首步时间戳为 sameTimestamp
      return {
        steps: Array.from({ length: 1000 }, (_, i) => ({
          stepIndex: i,
          type: StepType.PLANNER_RESPONSE,
          metadata: { createdAt: i === 0 ? sameTimestamp : `2026-03-30T10:00:${String(i % 60).padStart(2, '0')}.000Z` },
          plannerResponse: { response: `Step ${i}` }
        }))
      };
    }
    if (params.startIndex === 1000) {
      // 第 1 页：1 步（第 1001 步），其首步与第 0 页首步时间戳完全相同！
      return {
        steps: [
          {
            stepIndex: 1000,
            type: StepType.PLANNER_RESPONSE,
            metadata: { createdAt: sameTimestamp },
            plannerResponse: { response: 'Step 1000' }
          }
        ]
      };
    }
    return { steps: [] };
  }

  const view = await getContextSnapshot('mock-cascade-1001-steps', true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  assert.equal(rpcCalls, 2, '必须正常发起第 2 页拉取');
  assert.equal(view.stepCount, 1001, '1001 步必须被 100% 完整保留，绝不因弱指纹比对误判丢弃第 1 页');
  assert.equal(view.lastStepIndex, 1000, '最后一步的 stepIndex 必须为 1000');
  assert.equal(view.isTruncated, false, '单页返回 1 步小于 1000 属于正常结束，绝不能标记截断');
  assert.ok(!view.tooltip.includes('截断'), 'tooltip 中不得含截断字样');

  // 2. 深度断言：无 stepIndex/id 裸步骤时，首步同时间戳场景亦必须完整保留 1001 步，绝不因页内下标 _sIdx 碰撞丢弃第 1 页
  let rpcCallsNoId = 0;
  async function mockRpcNoId(target, method, params) {
    rpcCallsNoId++;
    if (params.startIndex === 0) {
      return {
        steps: Array.from({ length: 1000 }, (_, i) => ({
          type: StepType.PLANNER_RESPONSE,
          metadata: { createdAt: i === 0 ? sameTimestamp : `2026-03-30T10:00:${String(i % 60).padStart(2, '0')}.000Z` },
          plannerResponse: { response: `Raw Step ${i}` }
        }))
      };
    }
    if (params.startIndex === 1000) {
      return {
        steps: [
          {
            type: StepType.PLANNER_RESPONSE,
            metadata: { createdAt: sameTimestamp },
            plannerResponse: { response: 'Raw Step 1000' }
          }
        ]
      };
    }
    return { steps: [] };
  }

  const viewNoId = await getContextSnapshot('mock-cascade-1001-steps-no-id', true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpcNoId
  });

  assert.equal(rpcCallsNoId, 2, '无 ID 步骤必须正常拉取第 2 页');
  assert.equal(viewNoId.stepCount, 1001, '无 ID 步骤在首步时间戳相同时亦必须完整保留 1001 步');
  assert.equal(viewNoId.isTruncated, false, '无 ID 步骤未被截断');
});

test('【阶段三集成测试 14】Bridge 请求归属与重注防碰撞、回传 cid 校验与拒写串台测试', async () => {
  // 1. 验证 Bridge 脚本包含唯一的 bridgeInstId 且超时放宽至 8500ms
  const bridgeCode = readFileSync(resolve(__dirname, '../sidecars/ring/runtime-bridge.mjs'), 'utf8');
  assert.ok(bridgeCode.includes('bridgeInstId'), 'Bridge 脚本必须生成 bridgeInstId 实例唯一标识');
  assert.ok(bridgeCode.includes('8500'), 'Bridge 请求超时预算必须放宽至 8500ms');

  // 2. 验证 Node 端 handleBinding 回传带有 cid 并安全包裹 id 字符串
  const cdp = new CdpConnection('ws://127.0.0.1:9999');
  let evaluatedExpression = null;
  cdp.command = async (method, params) => {
    if (method === 'Runtime.evaluate') {
      evaluatedExpression = params.expression;
      return { result: {} };
    }
    return {};
  };

  await cdp.handleBinding({
    executionContextId: 1,
    payload: JSON.stringify({
      id: 'br_test_1',
      type: 'snapshot',
      input: {
        conversationId: 'cid-alpha-999',
        force: true
      }
    })
  });

  assert.ok(evaluatedExpression, 'handleBinding 必须调用 Runtime.evaluate 回传结果');
  assert.ok(evaluatedExpression.includes('window.__agContextRingBridge?.resolve("br_test_1"'), '回传 script 必须安全序列化字符串类型的 id');
  assert.ok(evaluatedExpression.includes('"cid":"cid-alpha-999"') || evaluatedExpression.includes('"conversationId":"cid-alpha-999"'), '回传结果中必须包含入参的 conversationId / cid');

  // 3. 验证 ring-widget.cjs 源码守卫防线
  const widgetSource = readFileSync(resolve(__dirname, '../assets/ring-widget.cjs'), 'utf8');
  assert.ok(widgetSource.includes('dataCid && dataCid !== lowerId'), 'setCachedSnapshot 必须检查 data 中的 cid 匹配');
  assert.ok(widgetSource.includes('isCidMismatch'), 'syncPaneState 必须守卫 isCidMismatch');
});

test('【阶段三集成测试 15】DOM body 未就绪防半死状态机：守候 DOMContentLoaded 且成功后才标记 installed', () => {
  const origWindow = globalThis.window;
  const origDoc = globalThis.document;

  const eventListeners = new Map();
  const mockDoc = {
    documentElement: {},
    body: null, // 关键：模拟 DOM body 尚未就绪！
    addEventListener: (evt, cb) => {
      eventListeners.set(evt, cb);
    },
    removeEventListener: (evt) => {
      eventListeners.delete(evt);
    },
    querySelectorAll: () => []
  };

  const mockWin = {
    __agContextRingHost: { getSnapshot: async () => ({}) },
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  globalThis.document = mockDoc;
  globalThis.window = mockWin;

  try {
    // 首次调用：body 为 null
    installAgContextRingWidget();

    // 验证：由于 body 未就绪，绝不能提前将 installed 设为 true，否则 CDP 巡检会误判已就绪！
    assert.equal(mockWin.__agContextRingInstalled, undefined, 'DOM body 未就绪时绝不能提前设置 __agContextRingInstalled = true');
    assert.ok(eventListeners.has('DOMContentLoaded'), '必须将初始化逻辑挂载至 DOMContentLoaded 事件守候');

    // 模拟 DOMContentLoaded 触发，DOM body 已就绪
    const mockBody = {
      querySelectorAll: () => [],
      isConnected: true
    };
    mockDoc.body = mockBody;
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    };

    const domLoadedCb = eventListeners.get('DOMContentLoaded');
    domLoadedCb();

    // 此时 DOM body 就绪，mount 执行完毕，正式标记 installed = true
    assert.equal(mockWin.__agContextRingInstalled, true, 'DOMContentLoaded 触发且 mount 成功后必须标记 __agContextRingInstalled = true');
  } finally {
    globalThis.window = origWindow;
    globalThis.document = origDoc;
    delete globalThis.MutationObserver;
  }
});

test('【阶段三集成测试 16】连续回退时服务端未返回 contextEpoch：正常自增世代且防步数逆序拦截失效', () => {
  const { shouldAcceptSnapshot } = installAgContextRingWidget;

  // 初始快照：第 1 世代，步数 10
  const existingEpoch1 = {
    ready: true,
    contextEpoch: 1,
    lastStepIndex: 10,
    used: 100_000
  };

  // 第 1 次回退：用户回退到第 5 步，服务端返回的数据不携带 contextEpoch
  const rewind1 = {
    ready: true,
    lastStepIndex: 5,
    used: 50_000,
    _requestRevision: 1
  };
  const check1 = shouldAcceptSnapshot(existingEpoch1, rewind1, {
    revision: 1,
    lastCommittedRevision: 0
  });

  assert.equal(check1.accept, true, '第一次回退必须放行');
  assert.equal(check1.isRewind, true, '必须识别为合法回退');
  assert.equal(check1.nextEpoch, 2, '世代必须递增为 2');

  // 模拟缓存保存了更新后的快照（世代变为 2，步数为 5）
  const existingEpoch2 = {
    ready: true,
    contextEpoch: 2,
    lastStepIndex: 5,
    used: 50_000
  };

  // 第 2 次回退：用户再次回退到第 3 步，服务端返回的数据仍然不携带 contextEpoch
  const rewind2 = {
    ready: true,
    lastStepIndex: 3,
    used: 30_000,
    _requestRevision: 2
  };
  const check2 = shouldAcceptSnapshot(existingEpoch2, rewind2, {
    revision: 2,
    lastCommittedRevision: 1
  });

  assert.equal(check2.accept, true, '第二次连续回退必须放行，绝不能因 incoming 未携带 contextEpoch 跳过分支');
  assert.equal(check2.isRewind, true, '第二次连续回退必须同样识别为回退');
  assert.equal(check2.nextEpoch, 3, '世代必须继续递增为 3');

  // 对比测试：如果不是合法回退（例如没有递增的 revision，而是网络乱序到达的旧步数数据）
  const outdatedStepData = {
    ready: true,
    lastStepIndex: 2,
    used: 20_000
  };
  const checkReversal = shouldAcceptSnapshot(existingEpoch2, outdatedStepData, {
    revision: 1,
    lastCommittedRevision: 2
  });

  assert.equal(checkReversal.accept, false, '非回退的旧逆序数据必须坚决拦截');
});

test('【阶段三集成测试 17】卸载脚本 manage.mjs 与 uninstall.ps1 具备目录残留二次检查与非 0 退出防假成功', async () => {
  const manageCode = readFileSync(resolve(__dirname, '../manage.mjs'), 'utf8');
  assert.ok(manageCode.includes('existsSync(TARGET_DIR)'), 'manage.mjs 必须包含 existsSync(TARGET_DIR) 残留检查');
  assert.ok(manageCode.includes('process.exit(1)'), 'manage.mjs 残留时必须执行 process.exit(1)');

  const psCode = readFileSync(resolve(__dirname, '../uninstall.ps1'), 'utf8');
  assert.ok(psCode.includes('Test-Path $targetDir'), 'uninstall.ps1 必须包含 Test-Path $targetDir 残留检查');
  assert.ok(psCode.includes('exit 1'), 'uninstall.ps1 残留时必须执行 exit 1');

  // 实机动态运行断言：当目录被占用无法删除时，manage.mjs 必须真实以非 0 状态码退出，绝不输出 [SUCCESS]
  const execFileAsync = promisify(execFile);
  const testLockedDir = resolve(__dirname, '../dist/test_integration_residue_dir');
  const testDummyConfigFile = resolve(__dirname, '../dist/test_dummy_config.json');
  await mkdir(testLockedDir, { recursive: true });
  await writeFile(testDummyConfigFile, JSON.stringify({ plugins: { 'antigravity-context-ring': { enabled: true } } }), 'utf8');

  // 模拟被宿主占用的目录（锁定 cwd）
  const locker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: testLockedDir });
  try {
    let processExitedWithError = false;
    let stdout = '';
    let stderr = '';
    try {
      const res = await execFileAsync(process.execPath, [resolve(__dirname, '../manage.mjs'), 'uninstall'], {
        env: {
          ...process.env,
          AGY_TEST_TARGET_DIR: testLockedDir,
          AGY_TEST_CONFIG_FILE: testDummyConfigFile
        }
      });
      stdout = res.stdout;
    } catch (err) {
      processExitedWithError = true;
      stderr = err.stderr || '';
    }
    assert.equal(processExitedWithError, true, '目录残留时 manage.mjs 必须以非 0 状态码退出');
    assert.ok(stderr.includes('仍有残留文件') || stderr.includes('ERROR'), 'stderr 必须输出残留文件错误信息');
    assert.ok(!stdout.includes('[SUCCESS]'), '目录残留时绝不能误报 [SUCCESS]');
  } finally {
    locker.kill();
    await new Promise(r => setTimeout(r, 400));
    await rm(testLockedDir, { recursive: true, force: true }).catch(() => {});
    await rm(testDummyConfigFile, { force: true }).catch(() => {});
  }
});
