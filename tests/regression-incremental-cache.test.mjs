import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getContextSnapshot,
  getBackendTrajectoryCache,
  clearBackendTrajectoryCache,
  setBackendTrajectoryCache,
  getSessionLsBinding,
  setSessionLsBinding,
  _getMemoryCacheInfo,
  _getTrajectoryCacheInfo
} from '../sidecars/ring/context-service.mjs';
import { StepType } from '../sidecars/ring/context-calculator.mjs';

beforeEach(() => {
  _getMemoryCacheInfo().clear();
  clearBackendTrajectoryCache();
});

test('【增量拉取 1】常规会话增量命中：2500 步增长至 2550 步，单次刷新仅发起 1 次增量 RPC，开销削减 66%', async () => {
  let rpcCalls = 0;
  const requestedRanges = [];
  let currentTotalSteps = 2500;

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

  const testCid = 'mock-cascade-incremental-grow';

  // 1. 首次冷拉取：2500 步应触发 3 次 RPC（0..1000, 1000..2000, 2000..3000 返回 500 步）
  const snap1 = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  assert.equal(rpcCalls, 3, '首次拉取 2500 步需发起 3 次分页 RPC');
  assert.equal(snap1.stepCount, 2500);
  assert.equal(snap1.isWindowed, false);
  assert.equal(snap1.lastStepIndex, 2499);

  // 验证轨迹缓存成功沉淀
  const trajInfo = _getTrajectoryCacheInfo();
  assert.equal(trajInfo.has(testCid), true, '完成拉取后必须沉淀增量轨迹缓存');
  const cached = getBackendTrajectoryCache(testCid);
  assert.equal(cached.allSteps.length, 2500);

  // 2. 会话追加 50 步（增长至 2550 步），触发带 force: true 的增量拉取
  currentTotalSteps = 2550;
  rpcCalls = 0;
  requestedRanges.length = 0;

  const snap2 = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 断言：仅需从 index 2000 发起 1 次 RPC 检查未满页与增量，无需从 0 重拉！
  assert.equal(rpcCalls, 1, '命中增量缓存后，仅需发起 1 次 RPC（从 index 2000 拉取）');
  assert.equal(requestedRanges[0].start, 2000);
  assert.equal(requestedRanges[0].end, 3000);
  assert.equal(snap2.stepCount, 2550, '步数准确收敛至 2550 步');
  assert.equal(snap2.lastStepIndex, 2549);
});

test('【增量拉取 2】跨整页连续拉取：2500 步激增至 3500 步，增量自动滚动拉取 2 次整页完成合并', async () => {
  let rpcCalls = 0;
  const requestedRanges = [];
  let currentTotalSteps = 2500;

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

  const testCid = 'mock-cascade-multipage-grow';

  // 1. 首次冷拉取 2500 步
  await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });
  assert.equal(rpcCalls, 3);

  // 2. 增长至 3500 步（第 2 页填满 1000 步，并新增第 3 页 500 步）
  currentTotalSteps = 3500;
  rpcCalls = 0;
  requestedRanges.length = 0;

  const snap = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  assert.equal(rpcCalls, 2, '增量跨页增长仅需拉取 2 次 RPC（2000..3000 与 3000..4000）');
  assert.equal(requestedRanges[0].start, 2000);
  assert.equal(requestedRanges[1].start, 3000);
  assert.equal(snap.stepCount, 3500);
  assert.equal(snap.lastStepIndex, 3499);
});

test('【失效守卫 1】历史回退（Rewind）：会话从 3500 步回退至 1200 步，安全失效增量缓存并全量回退', async () => {
  let rpcCalls = 0;
  const requestedRanges = [];
  let currentTotalSteps = 3500;

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

  const testCid = 'mock-cascade-rewind-guard';

  // 1. 首次冷拉取 3500 步
  const snap1 = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });
  assert.equal(snap1.stepCount, 3500);

  // 2. 发生历史回退，会话被撤销到 1200 步
  currentTotalSteps = 1200;
  rpcCalls = 0;
  requestedRanges.length = 0;

  const snap2 = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 验证：增量拉取尝试从 index 3000 探针，发现返回 0 条（小于原有预期），
  // 立即触发 Rewind 守卫，失效缓存并平稳回退至全量拉取（0..1000 与 1000..2000）
  assert.equal(requestedRanges[0].start, 3000, '首次尝试从 3000 增量');
  assert.ok(requestedRanges.some(r => r.start === 0), '失效后必须从 index 0 重新全量拉取');
  assert.equal(snap2.stepCount, 1200, '回退后步数必须准确更新为 1200');
  assert.equal(snap2.lastStepIndex, 1199);
});

test('【失效守卫 2】原位重新编辑（Re-edit）：步骤首步指纹变更，安全识别分叉并回退全量', async () => {
  let rpcCalls = 0;
  const requestedRanges = [];
  let stepModifier = 'original';

  async function mockRpc(target, method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      rpcCalls++;
      requestedRanges.push({ start: params.startIndex, end: params.endIndex });
      const available = Math.max(0, Math.min(params.endIndex, 2500) - params.startIndex);
      return {
        steps: Array.from({ length: available }, (_, i) => ({
          stepIndex: params.startIndex + i,
          type: StepType.PLANNER_RESPONSE,
          plannerResponse: { response: `${stepModifier} Step ${params.startIndex + i}` }
        }))
      };
    }
    return {};
  }

  const testCid = 'mock-cascade-reedit-guard';

  // 1. 首次拉取 2500 步（携带 original 前缀）
  const snap1 = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });
  assert.equal(snap1.stepCount, 2500);

  // 2. 用户在历史位置进行了编辑，第 2000 步的响应文本变为 modified
  stepModifier = 'modified';
  rpcCalls = 0;
  requestedRanges.length = 0;

  const snap2 = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 验证：增量拉取时首步比对发现指纹不一致，立即失效并全量回退
  assert.ok(requestedRanges.some(r => r.start === 0), '检测到首步不匹配后必须全量回退从 0 拉取');
  assert.equal(snap2.stepCount, 2500);
});

test('【失效守卫 3】大幅上下文压缩导致断裂：检测到压缩事件安全失效增量缓存并重锚定', async () => {
  let rpcCalls = 0;
  let hasCompression = false;

  async function mockRpc(target, method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      rpcCalls++;
      const steps = [];
      const len = Math.max(0, Math.min(params.endIndex, 2500) - params.startIndex);
      for (let i = 0; i < len; i++) {
        const idx = params.startIndex + i;
        if (idx === 0) {
          steps.push({
            stepIndex: 0,
            type: StepType.CHECKPOINT,
            metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 100_000, outputTokens: 0 } }
          });
        } else if (idx === 2499 && hasCompression) {
          // 产生大幅压缩：Token 从 100K 暴降至 20K
          steps.push({
            stepIndex: idx,
            type: StepType.CHECKPOINT,
            metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 20_000, outputTokens: 0 } }
          });
        } else {
          steps.push({
            stepIndex: idx,
            type: StepType.PLANNER_RESPONSE,
            plannerResponse: { response: `Step ${idx}` }
          });
        }
      }
      return { steps };
    }
    return {};
  }

  const testCid = 'mock-cascade-compression-guard';

  // 1. 首次拉取无压缩（占用 100K）
  const snap1 = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });
  assert.equal(snap1.used, 100_000);
  assert.equal(snap1.compressionDetected, false);

  // 2. 下一回合触发上下文大幅压缩
  hasCompression = true;
  rpcCalls = 0;

  const snap2 = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 验证：检测到压缩后触发失效守卫并执行全量拉取重锚定
  assert.equal(snap2.compressionDetected, true);
  assert.equal(snap2.used, 20_000);
  assert.ok(snap2.tooltip.includes('上下文已压缩') || snap2.tooltip.includes('曾压缩'));
});

test('【长会话优化 1】6000 步超长会话冷拉取：彻底消除 tailStart <= 5000 时第 5000 步重复拉取的冗余', async () => {
  const total = 6000;
  let summaryCalls = 0;
  let dataCalls = 0;
  const requestedRanges = [];

  async function mockRpc(target, method, params) {
    if (method === 'GetAllCascadeTrajectories') {
      summaryCalls++;
      return {
        trajectorySummaries: {
          'mock-cascade-6000-clean': { stepCount: total, lastModifiedTime: '2026-11-09T12:00:00Z' }
        }
      };
    }
    dataCalls++;
    requestedRanges.push({ start: params.startIndex, end: params.endIndex });
    const available = Math.max(0, Math.min(params.endIndex, total) - params.startIndex);
    return {
      steps: Array.from({ length: available }, (_, i) => ({
        stepIndex: params.startIndex + i,
        type: StepType.PLANNER_RESPONSE,
        plannerResponse: { response: `Step ${params.startIndex + i}` }
      }))
    };
  }

  const snap = await getContextSnapshot('mock-cascade-6000-clean', true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 断言：严格 6 次数据 RPC（5 次前缀 0..5000 + 1 次边界探针 5000..6000），坚决不发第 7 次重复 5000..6000 补齐
  assert.equal(dataCalls, 6, '5 次前缀 + 1 次边界探针已完整覆盖 6000 步，坚决杜绝第 7 次冗余拉取');
  assert.equal(summaryCalls, 1);
  assert.equal(snap.totalSteps, 6000);
  assert.equal(snap.stepCount, 5000, '保留最新 5000 步尾部窗口');
  assert.equal(snap.isWindowed, true);

  // 验证每次请求区间范围无重复
  const starts = requestedRanges.map(r => r.start);
  assert.deepEqual(starts, [0, 1000, 2000, 3000, 4000, 5000], '拉取区间必须递增且绝无重叠');
});

test('【长会话优化 2】6000 步长会话增量命中：追加至 6010 步时，仅拉取 5000..6000 与 6000..7000，开销大幅削减', async () => {
  let total = 6000;
  let dataCalls = 0;
  const requestedRanges = [];

  async function mockRpc(target, method, params) {
    if (method === 'GetAllCascadeTrajectories') {
      return {
        trajectorySummaries: {
          'mock-cascade-6000-incr': { stepCount: total, lastModifiedTime: '2026-11-09T12:00:00Z' }
        }
      };
    }
    dataCalls++;
    requestedRanges.push({ start: params.startIndex, end: params.endIndex });
    const available = Math.max(0, Math.min(params.endIndex, total) - params.startIndex);
    return {
      steps: Array.from({ length: available }, (_, i) => ({
        stepIndex: params.startIndex + i,
        type: StepType.PLANNER_RESPONSE,
        plannerResponse: { response: `Step ${params.startIndex + i}` }
      }))
    };
  }

  const testCid = 'mock-cascade-6000-incr';

  // 1. 冷拉取 6000 步（6 次 RPC）
  await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });
  assert.equal(dataCalls, 6);

  // 2. 增长至 6010 步，增量拉取
  total = 6010;
  dataCalls = 0;
  requestedRanges.length = 0;

  const snap = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 验证：增量拉取从 index 5000 开始校验，并拉取第 6000 步增量，仅需 2 次 RPC 即可完成！
  assert.equal(dataCalls, 2, '增量拉取长会话仅需 2 次 RPC（5000..6000 与 6000..7000）');
  assert.equal(requestedRanges[0].start, 5000);
  assert.equal(requestedRanges[1].start, 6000);
  assert.equal(snap.totalSteps, 6010);
  assert.equal(snap.stepCount, 5000, '尾部窗口保持 5000 步');
  assert.equal(snap.isWindowed, true);
  assert.equal(snap.lastStepIndex, 6009);
});

test('【长会话优化 3】7000 步超长会话冷拉取：tailStart=2000 <= 5000 场景严格 7 次 RPC，杜绝重叠冗余', async () => {
  const total = 7000;
  let summaryCalls = 0;
  let dataCalls = 0;
  const requestedRanges = [];

  async function mockRpc(target, method, params) {
    if (method === 'GetAllCascadeTrajectories') {
      summaryCalls++;
      return {
        trajectorySummaries: {
          'mock-cascade-7000': { stepCount: total, lastModifiedTime: '2026-11-09T12:00:00Z' }
        }
      };
    }
    dataCalls++;
    requestedRanges.push({ start: params.startIndex, end: params.endIndex });
    const available = Math.max(0, Math.min(params.endIndex, total) - params.startIndex);
    return {
      steps: Array.from({ length: available }, (_, i) => ({
        stepIndex: params.startIndex + i,
        type: StepType.PLANNER_RESPONSE,
        plannerResponse: { response: `Step ${params.startIndex + i}` }
      }))
    };
  }

  const snap = await getContextSnapshot('mock-cascade-7000', true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 5 次前缀 (0..5000) + 1 次边界探针 (5000..6000) + 1 次尾部拉取 (6000..7000) = 7 次
  assert.equal(dataCalls, 7, '7000 步应为 5 前缀 + 1 边界 + 1 尾部 = 7 次数据 RPC');
  assert.equal(summaryCalls, 1);
  assert.equal(snap.totalSteps, 7000);
  assert.equal(snap.stepCount, 5000);
  assert.equal(snap.isWindowed, true);
  const starts = requestedRanges.map(r => r.start);
  assert.deepEqual(starts, [0, 1000, 2000, 3000, 4000, 5000, 6000]);
});

test('【失效守卫 4】stepIndex 逆序或断裂：单页内步号乱序立即触发守卫回退全量', async () => {
  let isCorrupted = false;
  const requestedRanges = [];

  async function mockRpc(target, method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      requestedRanges.push({ start: params.startIndex, end: params.endIndex });
      if (params.startIndex === 2000 && isCorrupted) {
        // 返回步号倒退的畸形数据
        return {
          steps: [
            { stepIndex: 2000, type: StepType.PLANNER_RESPONSE, plannerResponse: { response: 'A' } },
            { stepIndex: 1990, type: StepType.PLANNER_RESPONSE, plannerResponse: { response: 'B' } }
          ]
        };
      }
      const available = Math.max(0, Math.min(params.endIndex, 2500) - params.startIndex);
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

  const testCid = 'mock-cascade-discontinuity-index';

  // 1. 首次正常拉取 2500 步
  await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 2. 模拟服务端返回步号逆序断裂
  isCorrupted = true;
  requestedRanges.length = 0;

  await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 验证：守卫 4 触发，缓存失效，回退至全量拉取从 index 0 开始
  assert.ok(requestedRanges.some(r => r.start === 0), '发现步号逆序断裂后必须全量回退从 0 开始拉取');
});

test('【失效守卫 5】会话完全重置清空（0 步）：增量探针返回空安全回退全量返回未就绪或空状态', async () => {
  let total = 2500;
  const requestedRanges = [];

  async function mockRpc(target, method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      requestedRanges.push({ start: params.startIndex, end: params.endIndex });
      const available = Math.max(0, Math.min(params.endIndex, total) - params.startIndex);
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

  const testCid = 'mock-cascade-reset-empty';

  // 1. 首次拉取 2500 步
  await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 2. 会话清空重置为 0 步
  total = 0;
  requestedRanges.length = 0;

  const snap = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  assert.ok(requestedRanges.some(r => r.start === 0), '检测到数据清空后必须回退全量从 0 拉取');
  assert.equal(snap.ready, false, '0 步会话返回就绪为 false 的中性状态');
});

test('【轨迹缓存 LRU】超过 50 个会话时按 LRU 顺序淘汰最久未访问条目，杜绝内存泄漏', async () => {
  async function dummyRpc(target, method, params) {
    return {
      steps: [
        { stepIndex: 0, type: StepType.PLANNER_RESPONSE, plannerResponse: { response: 'Step 0' } }
      ]
    };
  }

  // 连续填充 55 个不同会话
  for (let i = 0; i < 55; i++) {
    await getContextSnapshot(`mock-session-lru-${i}`, true, {
      _ls: { port: 9999 },
      _rpcCall: dummyRpc
    });
  }

  const info = _getTrajectoryCacheInfo();
  assert.equal(info.size, 50, '轨迹缓存容量上限严格保持 50');
  assert.equal(info.has('mock-session-lru-0'), false, '最老会话 0 必须被淘汰');
  assert.equal(info.has('mock-session-lru-54'), true, '最新会话 54 必须驻留');
});

test('【失效守卫 3-B】压缩重锚定后会话继续增长：后续增量拉取依然平稳命中，仅发起 1 次 RPC', async () => {
  let rpcCalls = 0;
  let hasCompression = false;
  let currentTotal = 2500;

  async function mockRpc(target, method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      rpcCalls++;
      const steps = [];
      const len = Math.max(0, Math.min(params.endIndex, currentTotal) - params.startIndex);
      for (let i = 0; i < len; i++) {
        const idx = params.startIndex + i;
        if (idx === 0) {
          steps.push({
            stepIndex: 0,
            type: StepType.CHECKPOINT,
            metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 100_000, outputTokens: 0 } }
          });
        } else if (idx === 2490 && hasCompression) {
          steps.push({
            stepIndex: idx,
            type: StepType.CHECKPOINT,
            metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 20_000, outputTokens: 0 } }
          });
        } else {
          steps.push({
            stepIndex: idx,
            type: StepType.PLANNER_RESPONSE,
            plannerResponse: { response: `Step ${idx}` }
          });
        }
      }
      return { steps };
    }
    return {};
  }

  const testCid = 'mock-cascade-compression-followup';

  // 1. 首次冷拉取无压缩
  await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  // 2. 发生压缩：触发守卫失效并全量回退重锚定
  hasCompression = true;
  await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  // 3. 压缩后会话继续追加 20 步（增长至 2520 步）
  currentTotal = 2520;
  rpcCalls = 0;

  const snap3 = await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: mockRpc
  });

  // 核心断言：重锚定后已记录压缩态，后续增量拉取必须正常命中，仅发起 1 次 RPC（2000..3000）！
  assert.equal(rpcCalls, 1, '压缩重锚定后后续拉取应继续享受增量加速，不得反复退化为全量');
  assert.equal(snap3.stepCount, 2520);
  assert.equal(snap3.compressionDetected, true);
  assert.equal(snap3.used, 20_000);
});

test('【边界跨越】短会话增长突破 5000 步：从 4500 步跨越至 5500 步，自动识别边界并平稳切换为长会话尾部窗口', async () => {
  let total = 4500;
  let summaryCalls = 0;
  let dataCalls = 0;

  async function mockRpc(target, method, params) {
    if (method === 'GetAllCascadeTrajectories') {
      summaryCalls++;
      return {
        trajectorySummaries: {
          'mock-cascade-grow-windowed': { stepCount: total, lastModifiedTime: '2026-11-09T12:00:00Z' }
        }
      };
    }
    dataCalls++;
    const available = Math.max(0, Math.min(params.endIndex, total) - params.startIndex);
    return {
      steps: Array.from({ length: available }, (_, i) => ({
        stepIndex: params.startIndex + i,
        type: StepType.PLANNER_RESPONSE,
        plannerResponse: { response: `Step ${params.startIndex + i}` }
      }))
    };
  }

  const testCid = 'mock-cascade-grow-windowed';

  // 1. 首次拉取 4500 步（未窗口化）
  const snap1 = await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });
  assert.equal(snap1.stepCount, 4500);
  assert.equal(snap1.isWindowed, false);

  // 2. 会话激增至 5500 步
  total = 5500;
  dataCalls = 0;
  summaryCalls = 0;

  const snap2 = await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  // 核心断言：突破 5000 步时安全检测到边界前缀上限，回退全量完成边界探针与权威查询，平稳切换为尾部窗口
  assert.equal(snap2.totalSteps, 5500);
  assert.equal(snap2.stepCount, 5000, '尾部窗口保留 5000 步');
  assert.equal(snap2.isWindowed, true, '成功切换为窗口化模式');
  assert.equal(snap2.lastStepIndex, 5499, '末步保留 5499');
});

test('【长会话回退】超长会话（6000 步）发生历史回退（缩减至 5200 步）：安全失效并全量回退，无缺失窗口重构', async () => {
  let total = 6000;
  const requestedRanges = [];

  async function mockRpc(target, method, params) {
    if (method === 'GetAllCascadeTrajectories') {
      return {
        trajectorySummaries: {
          'mock-cascade-windowed-rewind': { stepCount: total, lastModifiedTime: '2026-11-09T12:00:00Z' }
        }
      };
    }
    requestedRanges.push({ start: params.startIndex, end: params.endIndex });
    const available = Math.max(0, Math.min(params.endIndex, total) - params.startIndex);
    return {
      steps: Array.from({ length: available }, (_, i) => ({
        stepIndex: params.startIndex + i,
        type: StepType.PLANNER_RESPONSE,
        plannerResponse: { response: `Step ${params.startIndex + i}` }
      }))
    };
  }

  const testCid = 'mock-cascade-windowed-rewind';

  // 1. 冷拉取 6000 步
  await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  // 2. 发生历史回退（从 6000 回退至 5200 步）
  total = 5200;
  requestedRanges.length = 0;

  const snap2 = await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  // 核心断言：窗口化状态下步数缩水必须触发守卫 2，全量回退（包含 index 0 开始重新建构 5200 步的最新尾部窗口）
  assert.ok(requestedRanges.some(r => r.start === 0), '窗口化回退必须触发从 0 开始全量回退');
  assert.equal(snap2.totalSteps, 5200);
  assert.equal(snap2.stepCount, 5000);
  assert.equal(snap2.isWindowed, true);

  const cached = getBackendTrajectoryCache(testCid);
  assert.equal(cached.windowStartStep, 200);
  assert.equal(cached.analysisSteps[0].stepIndex, 200, '尾部窗口首步必须与 windowStartStep 严格对齐，绝无空洞');
});

test('【失效守卫 2-B】原位重新编辑（中间/末尾步骤）：修改页内第 2490 步（非首步），安全识别重写并全量回退', async () => {
  let step2490Response = 'Original 2490';
  const requestedRanges = [];

  async function mockRpc(target, method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      requestedRanges.push({ start: params.startIndex, end: params.endIndex });
      const available = Math.max(0, Math.min(params.endIndex, 2500) - params.startIndex);
      return {
        steps: Array.from({ length: available }, (_, i) => {
          const idx = params.startIndex + i;
          const text = idx === 2490 ? step2490Response : `Step ${idx}`;
          return {
            stepIndex: idx,
            type: StepType.PLANNER_RESPONSE,
            plannerResponse: { response: text }
          };
        })
      };
    }
    return {};
  }

  const testCid = 'mock-cascade-reedit-intermediate';

  // 1. 首次拉取 2500 步
  await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  // 2. 修改第 2490 步内容（第 2000 步保持不变）
  step2490Response = 'MODIFIED 2490 RESPONSE';
  requestedRanges.length = 0;

  await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  // 核心断言：全量比对重叠区间所有步骤，即使首步未变，第 2490 步变动也必须触发守卫 3 回退全量！
  assert.equal(requestedRanges[0].start, 2000, '首次尝试从 2000 增量拉取');
  assert.ok(requestedRanges.some(r => r.start === 0), '检测到第 2490 步篡改后必须从 0 全量回退');
});

test('【健壮性】会话 ID 大小写不敏感一致性：get/set/clearBackendTrajectoryCache 无论大小写均统一路由', () => {
  setBackendTrajectoryCache('MyMixedCaseSession-XYZ', {
    allSteps: [{ stepIndex: 0 }],
    analysisSteps: [{ stepIndex: 0 }]
  });

  assert.ok(getBackendTrajectoryCache('MyMixedCaseSession-XYZ'), '大写原样应命中');
  assert.ok(getBackendTrajectoryCache('mymixedcasesession-xyz'), '小写查询必须命中');
  assert.ok(getBackendTrajectoryCache('MYMIXEDCASESESSION-XYZ'), '全大写查询必须命中');

  const info = _getTrajectoryCacheInfo();
  assert.equal(info.has('MyMixedCaseSession-XYZ'), true);
  assert.equal(info.has('mymixedcasesession-xyz'), true);

  clearBackendTrajectoryCache('MyMixedCaseSession-XYZ');
  assert.equal(getBackendTrajectoryCache('mymixedcasesession-xyz'), null);
});

test('【失效守卫 4-B】跨页 stepIndex 逆序乱序校验：增量跨页拉取时次页首步小于上一页末步立即全量回退', async () => {
  let isDisordered = false;
  const requestedRanges = [];

  async function mockRpc(target, method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      requestedRanges.push({ start: params.startIndex, end: params.endIndex });
      if (params.startIndex === 3000 && isDisordered) {
        // 次页首步故意倒退为 2500（小于上一页末步 2999）
        return {
          steps: [
            { stepIndex: 2500, type: StepType.PLANNER_RESPONSE, plannerResponse: { response: 'Disordered' } }
          ]
        };
      }
      const available = Math.max(0, Math.min(params.endIndex, 3500) - params.startIndex);
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

  const testCid = 'mock-cascade-disordered-pages';

  // 1. 冷拉取 2500 步
  await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  // 2. 增长至 3500 步，但次页返回跨页倒退步号
  isDisordered = true;
  requestedRanges.length = 0;

  await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  // 验证：守卫 4 跨页递增检查拦截，安全失效并从 0 全量回退
  assert.ok(requestedRanges.some(r => r.start === 0), '检测到跨页步号倒退必须触发全量回退');
});

test('【失效守卫 3-C】模型流式打字生成中（尾部活跃步内容增长）：守卫 3 放行并平滑增量更新，绝不误判回退全量', async () => {
  let step2499Text = 'Hello';
  let step2499Tokens = 10;
  const requestedRanges = [];

  async function mockRpc(target, method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      requestedRanges.push({ start: params.startIndex, end: params.endIndex });
      const available = Math.max(0, Math.min(params.endIndex, 2500) - params.startIndex);
      return {
        steps: Array.from({ length: available }, (_, i) => {
          const idx = params.startIndex + i;
          if (idx === 2499) {
            return {
              stepIndex: 2499,
              type: StepType.PLANNER_RESPONSE,
              metadata: {
                createdAt: '2026-11-11T12:00:00Z',
                modelUsage: { inputTokens: 50, outputTokens: step2499Tokens }
              },
              plannerResponse: { response: step2499Text }
            };
          }
          return {
            stepIndex: idx,
            type: StepType.PLANNER_RESPONSE,
            metadata: { createdAt: '2026-11-11T12:00:00Z' },
            plannerResponse: { response: `Step ${idx}` }
          };
        })
      };
    }
    return {};
  }

  const testCid = 'mock-cascade-streaming-tail-grow';

  // 1. 首次拉取：2500 步（第 2499 步刚刚开始打字 "Hello"，10 tokens）
  const snap1 = await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });
  assert.equal(snap1.stepCount, 2500);

  // 2. 模拟 2.5 秒后轮询：模型继续吐字，第 2499 步内容增长为 "Hello world, Antigravity!"，tokens 增至 80
  step2499Text = 'Hello world, Antigravity!';
  step2499Tokens = 80;
  requestedRanges.length = 0;

  const snap2 = await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  // 核心断言：
  // 1. 守卫 3 识别末步稳定身份（getStableStepIdentity）一致，放行打字内容增长，仅从 2000 发起 1 次增量 RPC！
  // 2. 绝不触发从 0 开始的全量拉取！
  assert.equal(requestedRanges.length, 1, '流式打字中仅发起 1 次增量 RPC');
  assert.equal(requestedRanges[0].start, 2000, '必须从当前页起始（2000）增量拉取');
  assert.ok(!requestedRanges.some(r => r.start === 0), '流式打字绝不可误判篡改而触发从 0 全量回退');

  // 3. 验证增量合并后，缓存内第 2499 步的内容已准确更新为最新文本
  const cached = getBackendTrajectoryCache(testCid);
  const lastStep = cached.allSteps[2499];
  assert.equal(lastStep.plannerResponse.response, 'Hello world, Antigravity!', '缓存中尾步内容必须无缝刷新');
  assert.equal(lastStep.metadata?.modelUsage?.outputTokens, 80, '缓存中尾步 Token 必须同步刷新');
});

test('【窗口化单次增量追赶上限 1】isWindowed 会话（6000 步）正常追赶：新增 10 步时正常增量合并，不受累计长度限制', async () => {
  const testCid = 'mock-cascade-windowed-normal-catchup';
  let rpcCalls = 0;
  const requestedRanges = [];
  let currentTotalSteps = 6010;

  async function mockRpc(target, method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      rpcCalls++;
      requestedRanges.push({ start: params.startIndex, end: params.endIndex });
      const available = Math.max(0, Math.min(params.endIndex, currentTotalSteps) - params.startIndex);
      return {
        steps: Array.from({ length: available }, (_, i) => ({
          stepIndex: params.startIndex + i,
          type: StepType.PLANNER_RESPONSE,
          metadata: { createdAt: '2026-11-11T12:00:00Z' },
          plannerResponse: { response: `Step ${params.startIndex + i}` }
        }))
      };
    }
    return {};
  }

  // 1. 初始化预置已窗口化的缓存（6000 步，尾部窗口 5000 步：1000..6000）
  const initialSteps = Array.from({ length: 5000 }, (_, i) => ({
    stepIndex: 1000 + i,
    type: StepType.PLANNER_RESPONSE,
    metadata: { createdAt: '2026-11-11T12:00:00Z' },
    plannerResponse: { response: `Step ${1000 + i}` }
  }));
  setBackendTrajectoryCache(testCid, {
    allSteps: initialSteps,
    analysisSteps: initialSteps,
    totalSteps: 6000,
    windowStartStep: 1000,
    isWindowed: true,
    isTruncated: true,
    contextUsed: 100000,
    lastStepIndex: 5999,
    time: Date.now()
  });

  // 2. 触发增量拉取（此时总步数为 6010）
  const snap = await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  assert.equal(snap.totalSteps, 6010, '长会话权威总步数更新至 6010');
  assert.equal(snap.stepCount, 5000, '尾部窗口保持 5000 步');
  assert.equal(snap.isWindowed, true);
  assert.equal(snap.lastStepIndex, 6009);

  // 验证增量请求区间：先拉 5000..6000（覆盖校验重叠并满 1000 步），再拉 6000..7000（拿到 10 步退出）
  assert.equal(rpcCalls, 2, '窗口化模式增量翻页成功完成');
  assert.equal(requestedRanges[0].start, 5000);
  assert.equal(requestedRanges[1].start, 6000);
});

test('【窗口化单次增量追赶上限 2】极端场景服务端死循环熔断：忽略分页且缺失 stepIndex 时有界退出回退全量', async () => {
  const testCid = 'mock-cascade-windowed-infinite-loop-breaker';
  let rpcCalls = 0;
  const requestedRanges = [];

  // 模拟异常服务端：忽略所有 startIndex，恒定返回 1000 条且缺失 stepIndex 的数据
  async function mockMaliciousRpc(target, method, params) {
    if (method === 'GetAllCascadeTrajectories') {
      return {
        trajectorySummaries: {
          [testCid]: { stepCount: 10000 }
        }
      };
    }
    if (method === 'GetCascadeTrajectorySteps') {
      rpcCalls++;
      requestedRanges.push({ start: params.startIndex, end: params.endIndex });
      return {
        steps: Array.from({ length: 1000 }, (_, i) => ({
          // 故意不提供 stepIndex 字段
          type: StepType.PLANNER_RESPONSE,
          metadata: { createdAt: '2026-11-11T12:00:00Z' },
          plannerResponse: { response: `Mock repeat step ${i}` }
        }))
      };
    }
    return {};
  }

  // 1. 初始化预置已窗口化的缓存
  const initialSteps = Array.from({ length: 5000 }, (_, i) => ({
    type: StepType.PLANNER_RESPONSE,
    metadata: { createdAt: '2026-11-11T12:00:00Z' },
    plannerResponse: { response: `Mock repeat step ${i % 1000}` }
  }));
  setBackendTrajectoryCache(testCid, {
    allSteps: initialSteps,
    analysisSteps: initialSteps,
    totalSteps: 6000,
    windowStartStep: 1000,
    isWindowed: true,
    isTruncated: true,
    contextUsed: 100000,
    lastStepIndex: null,
    time: Date.now()
  });

  // 2. 触发增量拉取：必须在有界次数内熔断，严禁无限死循环
  await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockMaliciousRpc });

  // 核心断言：
  // 1. 增量阶段发起了 1 次初始 fetchPage(5000) + 5 次追赶 fetchPage（累计 5000 步）
  // 2. 第 6 次追赶前触发 if (catchupSteps >= MAX_INCREMENTAL_CATCHUP_STEPS) 熔断
  // 3. 熔断后清空缓存并安全转入全量权威探针（GetAllCascadeTrajectories + 全量分页）
  // 4. 总 RPC 调用次数被严格限制在有界常数内，绝不死循环
  assert.ok(rpcCalls <= 15, `总 RPC 调用次数必须严格有界（实测 ${rpcCalls} 次），绝不死循环`);
  assert.ok(requestedRanges.some(r => r.start === 5000), '增量阶段从 5000 开始发起');
  assert.ok(requestedRanges.some(r => r.start === 0), '熔断后必须成功平滑回退至 0 开始的全量探针');
});

test('【5000步抖动消除】增量阶段恰好到达 5000 步且满页，前向探针返回空时保留增量缓存不回退全量', async () => {
  const testCid = 'mock-cascade-5000-residency';
  let totalSteps = 4500;
  let requestedRanges = [];

  async function mockRpc(target, method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      const { startIndex, endIndex } = params;
      requestedRanges.push({ startIndex, endIndex });
      const steps = [];
      for (let i = startIndex; i < Math.min(endIndex, totalSteps); i++) {
        steps.push({
          stepIndex: i,
          type: StepType.PLANNER_RESPONSE,
          metadata: { createdAt: '2026-11-11T12:00:00Z' },
          plannerResponse: { response: `Step ${i}` }
        });
      }
      return { steps };
    }
    return {};
  }

  // 1. 冷启动建立 4500 步缓存
  await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  // 2. 增长至 5000 步（刚好满 5 页，最后一页刚好满 1000 步）
  totalSteps = 5000;
  requestedRanges = [];

  const snap = await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  // 断言：
  // 增量阶段拉取 4000..5000，随后发起前向探针 fetchPage(5000..6000)
  // 探针返回空（0 步），保留增量缓存，绝不触发全量回退（不从 0 重新拉取！）
  assert.equal(snap.totalSteps, 5000);
  assert.ok(requestedRanges.some(r => r.startIndex === 4000), '拉取 4000..5000 增量');
  assert.ok(requestedRanges.some(r => r.startIndex === 5000), '前向探针发起 5000 探测');
  assert.ok(!requestedRanges.some(r => r.startIndex === 0), '探针返回 0 步，必须保留增量缓存，严禁从 0 全量重拉');

  const cached = getBackendTrajectoryCache(testCid);
  assert.ok(cached, '增量缓存依然健康驻留');
  assert.equal(cached.allSteps.length, 5000);
});

test('【Trap 1 紫环倒带修复】窗口化会话全量与增量拉取继承 initialCompressionDetected 状态', async () => {
  const testCid = 'mock-cascade-purple-ring-rewind';

  // 预置带有压缩记录的缓存
  setBackendTrajectoryCache(testCid, {
    allSteps: Array.from({ length: 5000 }, (_, i) => ({
      stepIndex: 1000 + i,
      type: StepType.PLANNER_RESPONSE,
      metadata: { createdAt: '2026-11-11T12:00:00Z' },
      plannerResponse: { response: `Step ${1000 + i}` }
    })),
    analysisSteps: [],
    totalSteps: 6000,
    windowStartStep: 1000,
    isWindowed: true,
    isTruncated: true,
    contextUsed: 80000,
    compressionDetected: true,
    compressionDrop: 30000,
    time: Date.now()
  });

  async function mockRpc(target, method, params) {
    if (method === 'GetCascadeTrajectorySteps') {
      const { startIndex, endIndex } = params;
      const steps = [];
      for (let i = startIndex; i < Math.min(endIndex, 6010); i++) {
        steps.push({
          stepIndex: i,
          type: StepType.PLANNER_RESPONSE,
          metadata: { createdAt: '2026-11-11T12:00:00Z' },
          plannerResponse: { response: `Step ${i}` }
        });
      }
      return { steps };
    }
    return {};
  }

  const snap = await getContextSnapshot(testCid, true, { _ls: { port: 9999 }, _rpcCall: mockRpc });

  assert.equal(snap.compressionDetected, true, '窗口化增量拉取必须继承压缩状态');
  assert.equal(snap.compressionDrop, 30000, '窗口化增量拉取必须继承压缩降幅');
});

test('【宿主退出防重复扫描】RPC 抛出致命异常或 initialLs 探测失败时清除 sessionLsBinding', async () => {
  const testCid = 'mock-cascade-host-exit-cleanup';
  setSessionLsBinding(testCid, { port: 9999, csrfToken: 'fake' });
  assert.ok(getSessionLsBinding(testCid), '绑定存在');

  async function failingRpc() {
    throw new Error('Fatal socket connection refused');
  }

  // RPC 失败应触发 catch 块并清理绑定
  await getContextSnapshot(testCid, true, {
    _ls: { port: 9999 },
    _rpcCall: failingRpc
  });

  assert.equal(getSessionLsBinding(testCid), null, 'RPC 失败后 sessionLsBinding 必须被清空');

  // initialLs 失败场景
  setSessionLsBinding(testCid, { port: 9999, csrfToken: 'fake' });
  await getContextSnapshot(testCid, true, {
    _ls: null,
    _discoverAllLanguageServers: async () => []
  });
  assert.equal(getSessionLsBinding(testCid), null, 'initialLs 失败后 sessionLsBinding 必须被清空');
});



