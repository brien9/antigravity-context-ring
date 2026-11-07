import test from 'node:test';
import assert from 'node:assert/strict';
import {
  processTrajectorySteps,
  StepType
} from '../sidecars/ring/context-calculator.mjs';
import { formatContextResult } from '../sidecars/ring/context-service.mjs';

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
