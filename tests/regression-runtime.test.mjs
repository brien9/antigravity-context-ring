import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { processTrajectorySteps, StepType } from '../sidecars/ring/context-calculator.mjs';
import { formatContextResult, getBackendCachedSnapshot, setBackendCachedSnapshot } from '../sidecars/ring/context-service.mjs';
import { isContextRingProcess } from '../sidecars/ring/main.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const installAgContextRingWidget = require('../assets/ring-widget.cjs');
const { normalizeSnapshotSchema, shouldAcceptSnapshot, inferClientModelLimit } = installAgContextRingWidget;

test('【Argon 修复 1-A】ring-widget: syncPaneState 守卫拦截后绝不将脏数据直接上屏', () => {
  const widgetCode = readFileSync(resolve(__dirname, '../assets/ring-widget.cjs'), 'utf8');
  assert.ok(
    widgetCode.includes('updatePaneView(inst, getCachedSnapshot(cid) || data)'),
    'updatePaneView 必须使用通过校验的快照 (getCachedSnapshot(cid) || data)'
  );
});

test('【Argon 修复 1-B】ring-widget: executeRpc 宿主不可用时入口提前拦截，绝不在 inFlightRequests 残留死锁', () => {
  const widgetCode = readFileSync(resolve(__dirname, '../assets/ring-widget.cjs'), 'utf8');
  const executeRpcSnippet = widgetCode.slice(widgetCode.indexOf('async function executeRpc('), widgetCode.indexOf('// 方案 B：React Fiber'));
  const guardPos = executeRpcSnippet.indexOf('if (!window.__agContextRingHost?.getSnapshot) return null;');
  const promisePos = executeRpcSnippet.indexOf('const reqPromise = (async () =>');
  assert.ok(guardPos !== -1, 'executeRpc 入口必须包含宿主检测拦截');
  assert.ok(guardPos < promisePos, '宿主检测拦截必须在 const reqPromise 异步闭包之前');
});

test('【Argon 修复 2】ls-discovery: 多进程发现不再单次 break，收集所有 candidates 遍历探活', () => {
  const discoveryCode = readFileSync(resolve(__dirname, '../sidecars/ring/ls-discovery.mjs'), 'utf8');
  assert.ok(discoveryCode.includes('const candidates = [];'), '必须使用 candidates 数组收集多个候选进程');
  assert.ok(discoveryCode.includes('for (const cand of candidates)'), '必须遍历 candidates 列表进行逐一端口探活');
  // 确认在提取循环中不再有 early break
  const winQueryBlock = discoveryCode.slice(discoveryCode.indexOf('collectCandidates(lines)'), discoveryCode.indexOf('for (const cand of candidates)'));
  assert.ok(!winQueryBlock.includes('break;'), '候选收集逻辑中严禁 early break');
});

test('【Argon 修复 3】install.ps1: 路径含空格时 Start-Process -ArgumentList 显式双引号转义包裹', () => {
  const installCode = readFileSync(resolve(__dirname, '../install.ps1'), 'utf8');
  assert.ok(
    installCode.includes('@("`"$mainScript`"", "--sidecar=antigravity-context-ring")'),
    'install.ps1 必须使用 `"$mainScript`" 进行双引号转义包裹以支持含空格的用户路径'
  );
});

test('【Argon 修复 4】context-calculator: toolCallOutputTokens 完美兼容 Protobuf 字符串序列化', () => {
  const stepsWithStringToolOut = [
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        modelUsage: {
          model: 'gemini-2.5-pro',
          inputTokens: '10000',
          outputTokens: '1000',
          cacheReadTokens: '0',
          cacheCreationTokens: '0'
        }
      }
    },
    {
      type: StepType.USER_INPUT,
      userInput: {
        userResponse: 'next step'
      }
    },
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        toolCallOutputTokens: '3500' // Protobuf JSON 字符串形态
      }
    }
  ];

  const result = processTrajectorySteps(stepsWithStringToolOut);
  // 10000 + 1000 + 3500 = 14500
  assert.equal(result.contextUsed, 14500, '字符串形态的 toolCallOutputTokens ("3500") 必须被正确转为数值并累加');
});

test('【Argon 修复 5】main.mjs: startHostWatchdog 具备 watchdogBusy 异步防重入互斥锁', () => {
  const mainCode = readFileSync(resolve(__dirname, '../sidecars/ring/main.mjs'), 'utf8');
  const watchdogSnippet = mainCode.slice(mainCode.indexOf('export function startHostWatchdog('), mainCode.indexOf('async function main('));
  assert.ok(watchdogSnippet.includes('let watchdogBusy = false;'), '必须定义 watchdogBusy 状态变量');
  assert.ok(watchdogSnippet.includes('if (watchdogBusy) return;'), '回调入口必须检测 watchdogBusy 并直接早退');
  assert.ok(watchdogSnippet.includes('watchdogBusy = true;'), '进入巡检前必须锁定 watchdogBusy');
  assert.ok(watchdogSnippet.includes('watchdogBusy = false;'), 'finally 块中必须释放 watchdogBusy');
});

test('【Argon 修复 6】ring-widget: followUpPromise 具备 finally 自清理兜底，彻底免疫交接后宿主断连死锁', () => {
  const widgetCode = readFileSync(resolve(__dirname, '../assets/ring-widget.cjs'), 'utf8');
  const snippet = widgetCode.slice(widgetCode.indexOf('if (!existing.followUpPromise)'), widgetCode.indexOf('async function executeRpc('));
  assert.ok(snippet.includes('finally {'), 'followUpPromise 必须包含 finally 自清理块');
  assert.ok(snippet.includes('inFlightRequests.delete(lowerId)'), 'followUpPromise 在 finally 中必须兜底清理 inFlightRequests');
});

test('【Argon 修复 7】ls-discovery: readDiskCache 与 probePort 具备完整端口越界与异常捕获防御', () => {
  const discoveryCode = readFileSync(resolve(__dirname, '../sidecars/ring/ls-discovery.mjs'), 'utf8');
  assert.ok(discoveryCode.includes('data.port > 0 &&'), 'readDiskCache 必须校验端口下界');
  assert.ok(discoveryCode.includes('data.port <= 65535'), 'readDiskCache 必须校验端口上界');
  assert.ok(discoveryCode.includes('.catch(() => false)'), 'findWorkingPort 必须对 probePort 进行 catch 兜底防挂起');
});

test('【深度审计 Bug 1】formatContextResult 透传 source、normalizeSnapshotSchema 默认 source 区分以及权威快照 + 工具输出增量放行', () => {
  // 1. 未就绪快照返回 source: 'none'
  const unreadyFormatted = formatContextResult({ ready: false });
  assert.equal(unreadyFormatted.source, 'none');

  // 2. 初始纯 Checkpoint 快照 (isEstimated: false, source: 'checkpoint')
  const baseSteps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M418',
          inputTokens: 50_000,
          outputTokens: 2_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0
        }
      }
    }
  ];
  const baseFormatted = formatContextResult(processTrajectorySteps(baseSteps));
  assert.equal(baseFormatted.source, 'checkpoint');
  assert.equal(baseFormatted.isEstimated, false);
  const existingSnap = normalizeSnapshotSchema(baseFormatted, 'cid-tool-delta');

  // 3. 后续步骤产生 toolCallOutputTokens (isEstimated: true, source: 'checkpoint', lastStepIndex 递增)
  const deltaSteps = [
    ...baseSteps,
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        toolCallOutputTokens: 8_000
      }
    }
  ];
  const deltaFormatted = formatContextResult(processTrajectorySteps(deltaSteps));
  assert.equal(deltaFormatted.source, 'checkpoint', 'formatContextResult 必须保留 calc.source ("checkpoint")');
  assert.equal(deltaFormatted.isEstimated, true, '叠加工具输出增量后 isEstimated 为 true');
  assert.equal(deltaFormatted.used, 60_000);

  // shouldAcceptSnapshot 必须识别出这是基于权威快照的工具增量，予以放行而非 rough-estimate-blocked
  const acceptDelta = shouldAcceptSnapshot(existingSnap, deltaFormatted);
  assert.equal(acceptDelta.accept, true, '权威快照基础上的工具输出增量必须被 shouldAcceptSnapshot 放行');

  // 4. 连续第二步产生新的 toolCallOutputTokens (累计增量: 8000 + 4500 = 12500 -> 64500)
  const deltaSteps2 = [
    ...deltaSteps,
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        toolCallOutputTokens: 4_500
      }
    }
  ];
  const cachedDeltaSnap1 = normalizeSnapshotSchema(deltaFormatted, 'cid-tool-delta');
  const deltaFormatted2 = formatContextResult(processTrajectorySteps(deltaSteps2));
  assert.equal(deltaFormatted2.used, 64_500);
  const acceptDelta2 = shouldAcceptSnapshot(cachedDeltaSnap1, deltaFormatted2);
  assert.equal(acceptDelta2.accept, true, '连续多步工具输出增量必须在已有工具增量缓存基础上平滑放行更新');

  // 5. 当 existing.lastStepIndex 为 null 时，权威工具增量快照同样放行
  const legacyExistingWithoutStepIdx = { ...existingSnap, lastStepIndex: null };
  assert.equal(shouldAcceptSnapshot(legacyExistingWithoutStepIdx, deltaFormatted).accept, true, 'existing.lastStepIndex 为 null 时不得误拦截权威工具增量');

  // 6. 将连续工具增量快照写入缓存后，若再来一个纯粗估快照 (source: 'estimated' 或 'fiber-estimate')，依然必须被拦截！
  const cachedDeltaSnap = normalizeSnapshotSchema(deltaFormatted2, 'cid-tool-delta');
  assert.equal(cachedDeltaSnap.source, 'checkpoint');
  const roughIncoming = normalizeSnapshotSchema({
    ready: true,
    used: 15_000,
    limit: 256_000,
    isEstimated: true,
    lastStepIndex: 3
  }, 'cid-tool-delta');
  assert.equal(roughIncoming.source, 'estimated', '未显式指定 source 的估算快照默认应规范化为 estimated 而非 fiber-estimate');
  const blockRough = shouldAcceptSnapshot(cachedDeltaSnap, roughIncoming);
  assert.equal(blockRough.accept, false, '权威工具增量快照绝不能被纯粗估快照覆盖');
  assert.equal(blockRough.reason, 'rough-estimate-blocked');

  const blockFiberRough = shouldAcceptSnapshot(cachedDeltaSnap, {
    ...roughIncoming,
    source: 'fiber-estimate'
  });
  assert.equal(blockFiberRough.accept, false, '权威工具增量快照绝不能被 fiber-estimate 覆盖');
  assert.equal(blockFiberRough.reason, 'rough-estimate-blocked');
});

test('【深度审计 Bug 2】AGY_TEST_TARGET_DIR 双向测试沙箱隔离：严禁跨目录误匹配宿主生产进程或测试沙箱进程', () => {
  const prodCmd = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\alice\\.gemini\\config\\plugins\\antigravity-context-ring\\sidecars\\ring\\main.mjs" --sidecar=antigravity-context-ring';
  const sandboxCmd = '"C:\\Program Files\\nodejs\\node.exe" "E:\\agy_context_ring\\dist\\clean_test_sandbox\\installed_plugin\\sidecars\\ring\\main.mjs" --sidecar=antigravity-context-ring';
  const sandboxDir = 'E:\\agy_context_ring\\dist\\clean_test_sandbox\\installed_plugin';

  // 未设置 testTargetDir（生产模式）时，仅识别生产进程，自动排除 clean_test_sandbox 测试沙箱进程
  assert.equal(isContextRingProcess(prodCmd, 1001, 9999, ''), true, '生产模式下正常识别宿主生产目录的 Sidecar 进程');
  assert.equal(isContextRingProcess(sandboxCmd, 1002, 9999, ''), false, '生产模式下自动排除 clean_test_sandbox 沙箱内的测试进程');

  // 设置了 testTargetDir（测试沙箱模式）时，仅匹配该沙箱目录下的进程，绝不触碰宿主生产进程
  assert.equal(isContextRingProcess(prodCmd, 1001, 9999, sandboxDir), false, '测试沙箱模式下严禁匹配宿主生产目录的 Sidecar 进程');
  assert.equal(isContextRingProcess(sandboxCmd, 1002, 9999, sandboxDir), true, '测试沙箱模式下精准匹配沙箱内的 Sidecar 进程');
});

test('【深度审计 Bug 3 & Bug 4 & Bug 5】setCachedSnapshot 回退读取 L2 LocalStorage、历史模型切换不强制穿透与在役主力模型分母推导', async () => {
  // Bug 5：在役主力模型 MODEL_PLACEHOLDER_M402 (Claude Opus 5.5) / M405 (Claude Sonnet 5.5) 推导为 256000
  assert.equal(inferClientModelLimit('MODEL_PLACEHOLDER_M402'), 256_000, 'MODEL_PLACEHOLDER_M402 (Claude Opus 5.5) 必须推导为 256K');
  assert.equal(inferClientModelLimit('MODEL_PLACEHOLDER_M405'), 256_000, 'MODEL_PLACEHOLDER_M405 (Claude Sonnet 5.5) 必须推导为 256K');

  // Bug 4 后端部分：8s 内存缓存包含模型提示签名，切换模型立即穿透旧分母缓存
  const cidBackend = 'cid-model-switch-backend';
  const tNow = Date.now();
  setBackendCachedSnapshot(cidBackend, { ready: true, used: 40_000, limit: 256_000 }, tNow, { fallbackModel: 'Gemini 4 Argon' });
  assert.ok(getBackendCachedSnapshot(cidBackend, tNow + 100, { fallbackModel: 'Gemini 4 Argon' }), '同模型提示在 8s 内命中缓存');
  assert.equal(
    getBackendCachedSnapshot(cidBackend, tNow + 100, { fallbackModel: 'Claude Sonnet 4.6' }),
    null,
    '切换模型提示后必须错过旧签名缓存，拒绝直接复用旧提示对应的缓存条目'
  );

  // Bug 3 & Bug 4 前端部分：
  // 1) L1 为空但 L2 LocalStorage 存有高世代精确快照 (contextEpoch: 3, used: 100K) 时，setCachedSnapshot 必须从 L2 恢复 existing 并拦截粗估覆盖 & 保留世代号
  // 2) 在已挂载历史分屏上切换模型选择器文本时，短路守卫必须立即同步最新 fallback 提示，但不得强制穿透
  const CID_L2 = '11111111-2222-3333-4444-555555555555';
  const createShadowMap = () => {
    const map = new Map();
    for (const id of ['ring-bar', 'tooltip-text', 'context-ring', 'ring-container', 'tooltip']) {
      map.set(id, {
        id,
        style: {},
        textContent: '',
        hidden: true,
        classList: { add() {}, remove() {} },
        addEventListener() {},
        removeEventListener() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 19, height: 19 })
      });
    }
    return map;
  };

  let currentModelText = 'Gemini 4 Argon';
  let mutationCb = null;
  const rpcRequests = [];

  const provider = {
    getState: () => ({
      conversationId: CID_L2,
      trajectorySlice: { totalStepsLength: 25 }
    }),
    onDidChange: () => () => {}
  };
  const box = {
    isConnected: true,
    __reactFiber$test: {
      memoizedProps: { cascadeContext: { state: { agentStateProvider: provider } } }
    },
    getClientRects: () => [{ width: 400, height: 100 }],
    closest: () => null,
    contains: () => true
  };
  const flexContainer = {
    isConnected: true,
    insertedNodes: [],
    contains(n) { return this.insertedNodes.includes(n); },
    insertBefore(n) { if (!this.insertedNodes.includes(n)) this.insertedNodes.push(n); }
  };
  const modelEl = {
    isConnected: true,
    parentElement: flexContainer,
    get textContent() { return currentModelText; },
    getClientRects: () => [{ width: 80, height: 24 }],
    getAttribute: () => '',
    closest: (sel) => (sel === '[data-testid="agent-input-box"]' ? box : (sel.includes('flex') ? flexContainer : null))
  };
  const editorEl = {
    isConnected: true,
    getClientRects: () => [{ width: 380, height: 60 }],
    addEventListener() {},
    removeEventListener() {},
    closest: (sel) => (sel === '[data-testid="agent-input-box"]' ? box : null)
  };

  const shadowMap = createShadowMap();
  const storageMap = new Map();
  // 在页面启动前预先在 L2 LocalStorage 写入 contextEpoch: 3、lastStepIndex: 20 的精确快照
  storageMap.set('ag_ring_snap_' + CID_L2, JSON.stringify({
    schemaVersion: 2,
    calcVersion: 2,
    contextEpoch: 3,
    conversationId: CID_L2,
    ready: true,
    used: 80_000,
    limit: 256_000,
    ratio: 0.3125,
    percent: '31.3%',
    usedK: '80.0K',
    limitK: '256.0K',
    isEstimated: false,
    lastStepIndex: 20,
    source: 'checkpoint'
  }));

  let nextRpcResponse = {
    ready: true,
    used: 15_000,
    limit: 256_000,
    ratio: 0.058,
    usedK: '15.0K',
    limitK: '256.0K',
    percent: '5.8%',
    isEstimated: true,
    source: 'estimated',
    lastStepIndex: 21
  };

  globalThis.location = { pathname: `/c/${CID_L2}` };
  globalThis.window = {
    top: null,
    innerWidth: 1440,
    __agContextRingHost: {
      getSnapshot: async (input) => {
        rpcRequests.push(input);
        return nextRpcResponse;
      }
    },
    addEventListener() {},
    removeEventListener() {}
  };
  globalThis.window.top = globalThis.window;
  globalThis.document = {
    documentElement: {},
    body: {},
    hidden: false,
    activeElement: editorEl,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => box,
    querySelectorAll: (sel) => {
      if (sel.includes('contenteditable')) return [editorEl];
      if (sel.includes('model-selector-trigger')) return [modelEl];
      return [];
    },
    createElement: () => ({
      id: '',
      style: {},
      isConnected: true,
      previousElementSibling: modelEl,
      addEventListener() {},
      remove() { this.isConnected = false; },
      attachShadow: () => ({
        innerHTML: '',
        getElementById: (id) => shadowMap.get(id),
        querySelector: () => ({ style: {} })
      })
    })
  };
  globalThis.localStorage = {
    getItem(k) { return storageMap.get(k) || null; },
    setItem(k, v) { storageMap.set(k, v); },
    removeItem(k) { storageMap.delete(k); }
  };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  let observedOptions = null;
  globalThis.MutationObserver = class {
    constructor(cb) { mutationCb = cb; }
    observe(_target, opts) { observedOptions = opts; }
    disconnect() {}
  };

  try {
    installAgContextRingWidget();
    await new Promise(r => setTimeout(r, 30));

    assert.equal(observedOptions?.characterData, true, 'MutationObserver 必须启用 characterData: true 以捕获纯文本节点模型名变更');

    // 验证 Bug 3：首次 RPC 返回粗估 15K，但由于 L2 LocalStorage 存在 80K 精确快照，被拒绝覆盖，且 L2 中的 contextEpoch: 3 完好保留
    const persistedAfterRough = JSON.parse(storageMap.get('ag_ring_snap_' + CID_L2));
    assert.equal(persistedAfterRough.used, 80_000, 'L2 精确快照绝不能被首次返回的粗估快照覆盖');
    assert.equal(persistedAfterRough.contextEpoch, 3, 'L2 持久化的 contextEpoch 必须完好保留');

    // 验证当新的权威快照（未携带显式 contextEpoch）写入时，自动继承 L2 的 contextEpoch: 3
    nextRpcResponse = {
      ready: true,
      used: 80_000,
      limit: 256_000,
      ratio: 0.3125,
      usedK: '80.0K',
      limitK: '256.0K',
      percent: '31.3%',
      isEstimated: false,
      source: 'checkpoint',
      lastStepIndex: 25
    };

    // 验证 Bug 4 (A - 短路分支)：模拟用户在 UI 切换模型为 Claude Sonnet 4.6 并触发 DOM MutationObserver
    const countBeforeSwitch = rpcRequests.length;
    currentModelText = 'Claude Sonnet 4.6';
    if (mutationCb) mutationCb();
    await new Promise(r => setTimeout(r, 160)); // 等待 120ms MutationObserver 防抖 + 异步 RPC

    assert.ok(rpcRequests.length > countBeforeSwitch, '模型选择器变更后短路守卫必须立即触发新的快照拉取');
    const latestReq = rpcRequests[rpcRequests.length - 1];
    assert.equal(latestReq.force, undefined, '历史会话纯下拉变化不得携带 force；force 仅保留给真实 agent 状态变化');
    assert.equal(latestReq.fallbackModel, 'Claude Sonnet 4.6', '必须传递最新切换的模型提示');

    const persistedAfterSwitch = JSON.parse(storageMap.get('ag_ring_snap_' + CID_L2));
    assert.equal(persistedAfterSwitch.limit, 256_000, '历史会话分母必须继续由真实轨迹快照驱动，不能被前端下拉提示篡改');
    assert.equal(persistedAfterSwitch.contextEpoch, 3, '更新快照后依然继承 L2 的 contextEpoch: 3');

    // 验证 Bug 4 (B - 非短路 DOM 重建分支)：模型切换伴随宿主容器重建时，重挂载仍只传递最新提示且不强制穿透
    const countBeforeRemountSwitch = rpcRequests.length;
    currentModelText = 'Gemini 3.1 Pro';
    flexContainer.insertedNodes = []; // 模拟父容器重建导致不再包含旧 node，走非短路重挂载分支
    if (mutationCb) mutationCb();
    await new Promise(r => setTimeout(r, 160));

    assert.ok(rpcRequests.length > countBeforeRemountSwitch, '非短路重挂载下模型切换必须触发新的快照拉取');
    const remountReq = rpcRequests[rpcRequests.length - 1];
    assert.equal(remountReq.force, undefined, '非短路重挂载伴随纯模型切换时同样不得携带 force');
    assert.equal(remountReq.fallbackModel, 'Gemini 3.1 Pro', '必须传递重挂载后的最新模型提示');
  } finally {
    if (globalThis.window?.__agContextRingDispose) {
      globalThis.window.__agContextRingDispose();
    }
    delete globalThis.location;
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.localStorage;
    delete globalThis.getComputedStyle;
    delete globalThis.MutationObserver;
  }
});
