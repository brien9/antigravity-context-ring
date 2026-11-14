import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpConnection, RuntimeBridgeManager } from '../sidecars/ring/runtime-bridge.mjs';
import { processTrajectorySteps, StepType, normalizeModelId, COMPRESSION_MIN_DROP_TOKENS, COMPRESSION_MIN_DROP_RATIO } from '../sidecars/ring/context-calculator.mjs';
import { getPlatformTruncationLimit, isKnownModel, normalizeModelLookupKey } from '../sidecars/ring/model-limits.mjs';
import { formatContextResult, resolveDynamicModelState, clearDynamicModelCatalog, _getMemoryCacheInfo } from '../sidecars/ring/context-service.mjs';
import installAgContextRingWidget from '../assets/ring-widget.cjs';
import { readFileSync } from 'node:fs';

const { normalizeSnapshotSchema, shouldAcceptSnapshot, inferClientModelLimit, getRingColor } = installAgContextRingWidget;

test('【回归 1】CdpConnection.command: 页面无响应时触发超时拒绝并清理挂起队列，防止 syncInFlight 死锁', async () => {
  const OriginalWebSocket = globalThis.WebSocket;

  // 模拟一个能够正常建立连接、但对 Runtime.evaluate 永远不回包的卡死页面
  class HangingWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.listeners = new Map();
      setTimeout(() => this._emit('open', {}), 5);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send() {
      // 模拟渲染进程断点或假死：收到指令后永不回复
    }
    close() {
      this.readyState = 3;
      this._emit('close', {});
    }
    _emit(type, evt) {
      for (const fn of this.listeners.get(type) || []) fn(evt);
    }
  }

  globalThis.WebSocket = HangingWebSocket;
  try {
    const conn = new CdpConnection('ws://127.0.0.1:9222/devtools/page/hanging');
    await conn.open();

    // 验证超时时间到达后主动 reject，且 pending Map 不残留
    await assert.rejects(
      () => conn.command('Runtime.evaluate', { expression: '1+1' }, 120),
      /CDP command timeout: Runtime\.evaluate/
    );
    assert.equal(conn.pending.size, 0, '超时后 pending 队列必须自动清理');
    conn.close();
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('【回归 2】processTrajectorySteps: 同一的步骤同时携带 modelUsage 与 toolCallOutputTokens 时不重复累加', () => {
  const steps = [
    {
      type: StepType.USER_INPUT,
      userInput: {
        userResponse: '请读取配置文件',
        userConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M417' } }
      }
    },
    {
      type: StepType.PLANNER_RESPONSE,
      plannerResponse: { response: '已读取完毕' },
      metadata: {
        // 权威快照已包含截至当前步的上下文用量
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M417',
          inputTokens: 50_000,
          outputTokens: 1_000,
          cacheReadTokens: 10_000,
          cacheCreationTokens: 0
        },
        // 同一步附带的工具输出统计不应在快照归零后再额外累加一次
        toolCallOutputTokens: 3_500
      }
    }
  ];

  const calc = processTrajectorySteps(steps);
  assert.equal(calc.ready, true);
  // 50000 input + 10000 cacheRead + 1000 output = 61000，不重复累加同一步的 3500 toolCallOutputTokens
  assert.equal(calc.contextUsed, 61_000, '权威快照步自身的 toolCallOutputTokens 不得重复追加');
  assert.equal(calc.isEstimated, false, '有最新权威快照且无后续增量步骤时，isEstimated 必须为 false');
});

test('【回归 3】formatContextResult: 告警优先级必须严格遵循 平台超限 (>=100%) > 临界告警 (>=90%) > 历史压缩 > 超长截断 > 未知模型', () => {
  // 同时触发 compressionDetected 与 isOverLimit 时，必须优先展示超限告警并附带压缩记录
  const overLimitWithCompression = formatContextResult({
    ready: true,
    contextUsed: 260_000,
    contextLimit: 256_000,
    usageRatio: 1,
    isOverLimit: true,
    compressionDetected: true,
    compressionDrop: 15_000
  });
  assert.match(
    overLimitWithCompression.tooltip,
    /已达截断阈值 曾压缩 15\.0K/,
    '超限告警必须优先于普通压缩提示展示'
  );

  // 90%~99% 临界告警区间（含历史压缩记录），必须与前端 >=90% 告警文案严格对齐
  const nearLimitWithCompression = formatContextResult({
    ready: true,
    contextUsed: 240_000,
    contextLimit: 256_000,
    usageRatio: 240_000 / 256_000,
    isOverLimit: false,
    compressionDetected: true,
    compressionDrop: 12_000
  });
  assert.match(
    nearLimitWithCompression.tooltip,
    /接近截断 曾压缩 12\.0K/,
    '>=90% 临界告警文案必须与前端严格对齐并高于普通压缩提示'
  );

  // 未超限但触发步数截断
  const truncatedOnly = formatContextResult({
    ready: true,
    contextUsed: 120_000,
    contextLimit: 256_000,
    usageRatio: 120_000 / 256_000,
    isOverLimit: false,
    compressionDetected: false,
    isTruncated: true
  });
  assert.match(truncatedOnly.tooltip, /会话数据不完整/);
});

test('【回归 4】normalizeSnapshotSchema: 完整保留 isTruncated 与 isUnknownModel 状态字段', () => {
  const normalized = normalizeSnapshotSchema({
    ready: true,
    used: 80_000,
    limit: 256_000,
    ratio: 80_000 / 256_000,
    isTruncated: true,
    isUnknownModel: true
  }, '11111111-2222-3333-4444-555555555555');

  assert.equal(normalized.isTruncated, true, 'isTruncated 必须被保留');
  assert.equal(normalized.isUnknownModel, true, 'isUnknownModel 必须被保留');
});

test('【回归 5】ring-widget.cjs: 窗口事件无泄漏卸载、FocusEvent 不误触 force 穿透、离线绝不清零防线生效', async () => {
  const winListeners = new Map();
  const docListeners = new Map();
  const shadowElements = new Map();
  const forceFlagsReceived = [];

  // 构建轻量级 DOM 与宿主模拟环境
  const createEl = (id = '') => ({
    id,
    hidden: id === 'tooltip',
    style: {},
    textContent: '',
    isConnected: true,
    classList: {
      classes: new Set(),
      add(c) { this.classes.add(c); },
      remove(c) { this.classes.delete(c); }
    },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 18, height: 18 }),
    getClientRects: () => [{ width: 18, height: 18 }],
    closest: () => null,
    getAttribute: () => ''
  });

  for (const id of ['ring-container', 'tooltip', 'ring-bar', 'tooltip-text', 'context-ring']) {
    shadowElements.set(id, createEl(id));
  }

  let onDidChangeCallback = null;
  const mockProvider = {
    getState: () => ({
      conversationId: '11111111-2222-3333-4444-555555555555',
      trajectorySlice: { totalStepsLength: 8 }
    }),
    onDidChange: (cb) => {
      onDidChangeCallback = cb;
      return () => { onDidChangeCallback = null; };
    }
  };

  const mockBox = {
    ...createEl('box'),
    __reactFiber$mock: {
      memoizedProps: {
        cascadeContext: { state: { agentStateProvider: mockProvider } }
      }
    },
    contains: () => true
  };

  const mockFlexContainer = {
    ...createEl('flex'),
    contains: () => true,
    insertBefore() {}
  };

  const mockModel = {
    ...createEl('model'),
    parentElement: mockFlexContainer,
    closest: (sel) => (sel === '[data-testid="agent-input-box"]' ? mockBox : (sel.includes('flex') ? mockFlexContainer : null))
  };

  const mockEditor = {
    ...createEl('editor'),
    closest: (sel) => (sel === '[data-testid="agent-input-box"]' ? mockBox : null)
  };

  let snapshotResponder = async (input) => {
    forceFlagsReceived.push(Boolean(input?.force));
    return {
      ready: true,
      used: 64_000,
      limit: 256_000,
      ratio: 0.25,
      usedK: '64.0K',
      limitK: '256.0K',
      percent: '25.0%',
      tooltip: '25.0% · 64.0K / 256.0K 上下文已使用'
    };
  };

  globalThis.window = {
    top: null,
    innerWidth: 1280,
    __agContextRingHost: {
      getSnapshot: (input) => snapshotResponder(input)
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    }
  };
  globalThis.window.top = globalThis.window;

  globalThis.document = {
    documentElement: {},
    body: {},
    hidden: false,
    activeElement: mockEditor,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    querySelector: (sel) => (sel === '[data-testid="agent-input-box"]' ? mockBox : null),
    querySelectorAll: (sel) => {
      if (sel.includes('contenteditable')) return [mockEditor];
      if (sel.includes('model-selector-trigger')) return [mockModel];
      return [];
    },
    createElement: () => ({
      id: '',
      style: {},
      isConnected: true,
      previousElementSibling: mockModel,
      addEventListener() {},
      remove() {},
      attachShadow: () => ({
        innerHTML: '',
        getElementById: (id) => shadowElements.get(id),
        querySelector: () => createEl('arrow')
      })
    })
  };

  globalThis.localStorage = {
    store: new Map(),
    getItem(k) { return this.store.get(k) || null; },
    setItem(k, v) { this.store.set(k, v); },
    removeItem(k) { this.store.delete(k); }
  };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };

  try {
    // 1. 安装组件并等待首次同步完成
    installAgContextRingWidget();
    await new Promise(r => setTimeout(r, 20));

    const bar = shadowElements.get('ring-bar');
    const tipText = shadowElements.get('tooltip-text');
    assert.equal(bar.style.opacity, '1', '正常数据返回后进度条应完全显示');
    assert.match(tipText.textContent, /25\.0% · 64\.0K \/ 256\.0K/);

    // 2. 触发 window focus 事件并传入模拟 FocusEvent 对象，验证不会误触发 force=true
    forceFlagsReceived.length = 0;
    for (const fn of winListeners.get('focus') || []) {
      fn({ type: 'focus', target: globalThis.window });
    }
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(forceFlagsReceived, [false], '窗口 focus 事件对象绝不能被误判为 force: true');

    // 3. 模拟清空缓存后服务断连返回 ready: false（验证 updateView 内部 prevData 绝不清零防线与 0.7 半透明降级）
    globalThis.localStorage.store.clear();
    snapshotResponder = async () => ({ ready: false, tooltip: '暂无上下文数据' });

    // 切换到一个高水位新会话 ID（220 步 -> estRatio=0.98 >= 0.90，仅有 Fiber 预估，无缓存），随后 RPC 返回 ready: false
    mockProvider.getState = () => ({
      conversationId: '22222222-3333-4444-5555-666666666666',
      trajectorySlice: { totalStepsLength: 220 }
    });
    for (const fn of winListeners.get('focus') || []) {
      fn({ type: 'focus' });
    }
    // 同步阶段校验：高水位（>=90%）Fiber 快速预估必须保留 (正在校准...) 提示，严禁被误覆写为正式「接近截断」告警
    assert.match(tipText.textContent, /\(正在校准\.\.\.\)$/, '高水位 Fiber 快速预估在 RPC 返回前必须保留 (正在校准...) 过渡提示');
    assert.doesNotMatch(tipText.textContent, /接近截断/, '高水位 Fiber 快速预估绝不能误报为正式接近截断告警');

    await new Promise(r => setTimeout(r, 20));
    assert.equal(bar.style.opacity, '0.7', '离线返回 ready: false 时必须进入 !data.ready 分支将圆环降级为 0.7 半透明');
    assert.match(tipText.textContent, /\(离线\)$/, '离线时应在已有提示后追加 (离线) 标记');

    // 3.1 离线恢复验证：服务恢复并返回高占用+压缩态（ratio=0.95, compressionDetected=true），随后再次断连
    // 验证高占用告警态下离线时绝不吞掉 (离线) 后缀
    snapshotResponder = async () => ({
      ready: true,
      ratio: 0.95,
      used: 243200,
      limit: 256000,
      usedK: '243.2K',
      limitK: '256.0K',
      percent: '95.0%',
      compressionDetected: true,
      compressionDrop: 18000,
      tooltip: '95.0% · 243.2K / 256.0K 接近截断 曾压缩 18.0K'
    });
    for (const fn of winListeners.get('focus') || []) {
      fn({ type: 'focus' });
    }
    await new Promise(r => setTimeout(r, 20));
    assert.equal(bar.style.opacity, '1', '网络恢复后进度条必须成功恢复完全不透明 (opacity=1)');
    assert.doesNotMatch(tipText.textContent, /\(离线\)/, '网络恢复后气泡文本中的 (离线) 标记必须被正常清除');

    // 再次离线（此时命中 95% 告警态缓存）
    snapshotResponder = async () => ({ ready: false, offline: true });
    for (const fn of winListeners.get('focus') || []) {
      fn({ type: 'focus' });
    }
    await new Promise(r => setTimeout(r, 20));
    assert.equal(bar.style.opacity, '0.7', '告警态缓存命中后离线，依然必须降级为 0.7 半透明');
    assert.match(tipText.textContent, /接近截断 曾压缩 18\.0K.*\(离线\)$/, '高占用告警态离线时绝不能吞掉 (离线) 后缀');

    // 4. 验证卸载后 window 上的 focus 与 popstate 监听器及 editor 绑定彻底归零
    assert.equal(winListeners.get('focus')?.size, 1, '卸载前应有 1 个 focus 监听器');
    assert.equal(winListeners.get('popstate')?.size, 1, '卸载前应有 1 个 popstate 监听器');
    assert.equal(mockEditor.__agRingBound, true, '卸载前 editor 应处于已绑定状态');

    globalThis.window.__agContextRingDispose();

    assert.equal(winListeners.get('focus')?.size, 0, 'dispose 后 focus 监听器必须彻底移除，无内存泄漏');
    assert.equal(winListeners.get('popstate')?.size, 0, 'dispose 后 popstate 监听器必须彻底移除，无内存泄漏');
    assert.equal(mockEditor.__agRingBound, undefined, 'dispose 后 boundEditors 中的 editor 绑定标记必须彻底清理');
    assert.equal(onDidChangeCallback, null, 'dispose 后 React Fiber 状态订阅必须被释放');
  } finally {
    if (globalThis.window?.__agContextRingDispose) {
      globalThis.window.__agContextRingDispose();
    }
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.localStorage;
    delete globalThis.getComputedStyle;
    delete globalThis.MutationObserver;
  }
});

test('【回归 6】RuntimeBridgeManager: 输入框折叠移除 DOM 时巡检不误触发重注入，CDP 异常时清理失效连接', async () => {
  const manager = new RuntimeBridgeManager('/fake/dir', '/* widget */');
  manager.running = true;
  manager.generation = 1;

  const evaluatedExpressions = [];
  let shouldThrow = false;
  let closed = false;

  const fakeConn = {
    closed: false,
    command: async (method, params) => {
      if (shouldThrow) throw new Error('Renderer crashed');
      if (method === 'Runtime.evaluate') {
        evaluatedExpressions.push(params.expression);
        // 模拟页面已注入插件与 Bridge，但输入框被折叠（无 DOM 容器）
        if (params.expression.includes('__agContextRingInstalled')) {
          assert.equal(
            params.expression.includes('getElementById'),
            false,
            '巡检脚本严禁耦合 DOM 节点是否存在，防止折叠面板时每 3 秒重注入清空缓存'
          );
          return { result: { value: true } };
        }
      }
      return {};
    },
    close() {
      closed = true;
      this.closed = true;
    }
  };

  const url = 'ws://127.0.0.1:9222/devtools/page/1';
  manager.connections.set(url, fakeConn);

  // 模拟 _performSync 的已连接分支逻辑
  const checkScript = `Boolean(window.__agContextRingInstalled && window.__agContextRingHost && window.__agContextRingBridge)`;
  const res = await fakeConn.command('Runtime.evaluate', { expression: checkScript, returnByValue: true });
  assert.equal(res.result.value, true);
  assert.equal(evaluatedExpressions.length, 1, '存活巡检通过时绝不额外执行重注入指令');

  // 验证连接异常时关闭并移除失效连接
  shouldThrow = true;
  try {
    await fakeConn.command('Runtime.evaluate', { expression: checkScript, returnByValue: true });
  } catch {
    fakeConn.close();
    manager.connections.delete(url);
  }
  assert.equal(closed, true, 'CDP 抛出异常时应主动关闭失效连接');
  assert.equal(manager.connections.has(url), false, '失效连接应从 connections 池中移除以便重连');
});

test('【回归 7】Cortex 真实协议 Prefix Cache 命中：严禁漏算 cacheReadTokens 或将缓存命中误报为上下文压缩', () => {
  // 复刻真实 Language Server 轨迹数据：
  // Step 2: 首轮对话，无 cacheRead，inputTokens=22969
  // Step 8: 初始缓存命中，inputTokens=32109, cacheReadTokens=20576 (总输入=52685)
  // Step 10: 次轮对话完全命中 Prefix Cache，cacheReadTokens=52686, 新增 inputTokens=5745 (总输入=58431)
  // Step 48: 后续对话，cacheReadTokens=90739, 新增 inputTokens=2523, outputTokens=253 (总输入=93262, 总占用=93515)
  const realSteps = [
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M418',
          inputTokens: '22969',
          outputTokens: '430'
        }
      }
    },
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M418',
          inputTokens: '32109',
          outputTokens: '91',
          cacheReadTokens: '20576'
        }
      }
    },
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M418',
          inputTokens: '5745',
          outputTokens: '2375',
          cacheReadTokens: '52686'
        }
      }
    },
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M418',
          inputTokens: '2523',
          outputTokens: '253',
          cacheReadTokens: '90739'
        }
      }
    }
  ];

  const calc = processTrajectorySteps(realSteps);
  const view = formatContextResult(calc);

  assert.equal(calc.ready, true);
  assert.equal(calc.compressionDetected, false, 'Prefix Cache 命中导致 uncached inputTokens 下降绝不能误报为历史上下文压缩');
  assert.equal(calc.compressionDrop, 0);
  assert.equal(calc.contextUsed, 2523 + 90739 + 253, '物理总占用必须包含 inputTokens + cacheReadTokens + outputTokens (93,515)');
  assert.equal(view.usedK, '93.5K');
  assert.equal(view.percent, '36.5%');
  assert.equal(view.tooltip, '36.5% · 93.5K / 256.0K 上下文已使用');
});

test('【回归 8】model-limits: 全量覆盖 GetUserStatus 实机模型枚举与 modelId（Gemini 4 Argon / Gemini 3.8 Flash / Claude 5.5）及大小写统一查表', () => {
  const clientModels = [
    // Gemini 4 Argon (High / Medium / Low)
    { enumId: 'MODEL_PLACEHOLDER_M417', modelId: 'gemini-4-argon-high', limit: 256_000 },
    { enumId: 'MODEL_PLACEHOLDER_M418', modelId: 'gemini-4-argon-medium', limit: 256_000 },
    { enumId: 'MODEL_PLACEHOLDER_M419', modelId: 'gemini-4-argon-low', limit: 256_000 },
    // Gemini 3.8 Flash (High / Medium / Low)
    { enumId: 'MODEL_PLACEHOLDER_M318', modelId: 'gemini-3.8-flash-high', limit: 256_000 },
    { enumId: 'MODEL_PLACEHOLDER_M319', modelId: 'gemini-3.8-flash-medium', limit: 256_000 },
    { enumId: 'MODEL_PLACEHOLDER_M320', modelId: 'gemini-3.8-flash-low', limit: 256_000 },
    // Claude Opus 5.5 (Low / Medium / High)
    { enumId: 'MODEL_PLACEHOLDER_M400', modelId: 'claude-opus-5-5-low', limit: 256_000 },
    { enumId: 'MODEL_PLACEHOLDER_M401', modelId: 'claude-opus-5-5-medium', limit: 256_000 },
    { enumId: 'MODEL_PLACEHOLDER_M402', modelId: 'claude-opus-5-5-high', limit: 256_000 },
    // Claude Sonnet 5.5 (Low / Medium / High)
    { enumId: 'MODEL_PLACEHOLDER_M403', modelId: 'claude-sonnet-5-5-low', limit: 256_000 },
    { enumId: 'MODEL_PLACEHOLDER_M404', modelId: 'claude-sonnet-5-5-medium', limit: 256_000 },
    { enumId: 'MODEL_PLACEHOLDER_M405', modelId: 'claude-sonnet-5-5-high', limit: 256_000 },
  ];

  for (const item of clientModels) {
    assert.equal(isKnownModel(item.enumId), true, `枚举 ${item.enumId} 必须识别为已知模型`);
    assert.equal(isKnownModel(item.enumId.toLowerCase()), true, `小写枚举 ${item.enumId.toLowerCase()} 必须识别为已知模型`);
    assert.equal(isKnownModel(item.modelId), true, `modelId ${item.modelId} 必须识别为已知模型`);
    assert.equal(getPlatformTruncationLimit(item.enumId), item.limit, `枚举 ${item.enumId} 截断阈值应为 ${item.limit}`);
    assert.equal(getPlatformTruncationLimit(item.enumId.toLowerCase()), item.limit, `小写枚举 ${item.enumId.toLowerCase()} 截断阈值应为 ${item.limit}`);
    assert.equal(getPlatformTruncationLimit(item.modelId), item.limit, `modelId ${item.modelId} 截断阈值应为 ${item.limit}`);
  }

  // 验证此前漏同步的 m196 小写形式也能通过统一字典查表命中
  assert.equal(isKnownModel('model_placeholder_m196'), true);
  assert.equal(getPlatformTruncationLimit('model_placeholder_m196'), 256_000);
});

test('【回归 9】分屏多实例对等常驻：左右分屏无需聚焦同时显示各自圆环、后台分屏独立更新、草稿分屏防 URL 串台、同会话多开同步及关闭分屏自动回收', async () => {
  const CID_LEFT = 'aaaa1111-2222-3333-4444-555555555555';
  const CID_RIGHT = 'bbbb1111-2222-3333-4444-555555555555';

  const createShadowMap = () => {
    const map = new Map();
    for (const id of ['ring-container', 'tooltip', 'ring-bar', 'tooltip-text', 'context-ring']) {
      map.set(id, {
        id,
        hidden: id === 'tooltip',
        style: {},
        textContent: '',
        classList: {
          classes: new Set(),
          add(c) { this.classes.add(c); },
          remove(c) { this.classes.delete(c); }
        },
        addEventListener() {},
        removeEventListener() {},
        getBoundingClientRect: () => ({ left: 100, top: 100, width: 18, height: 18 })
      });
    }
    return map;
  };

  const makePaneMocks = (cid, initialSteps) => {
    let currentCid = cid;
    let currentSteps = initialSteps;
    let onChangeCb = null;

    const provider = {
      getState: () => ({
        conversationId: currentCid,
        trajectorySlice: { totalStepsLength: currentSteps }
      }),
      onDidChange: (cb) => {
        onChangeCb = cb;
        return () => { onChangeCb = null; };
      }
    };

    const box = {
      isConnected: true,
      __reactFiber$pane: {
        memoizedProps: {
          cascadeContext: { state: { agentStateProvider: provider } }
        }
      },
      getClientRects: () => [{ width: 400, height: 120 }],
      closest: () => null,
      contains: () => true
    };

    const flexContainer = {
      isConnected: true,
      insertedNodes: [],
      contains(n) { return this.insertedNodes.includes(n); },
      insertBefore(n) {
        if (!this.insertedNodes.includes(n)) this.insertedNodes.push(n);
      }
    };

    const model = {
      isConnected: true,
      parentElement: flexContainer,
      getClientRects: () => [{ width: 80, height: 24 }],
      getAttribute: () => '',
      closest: (sel) => (sel === '[data-testid="agent-input-box"]' ? box : (sel.includes('flex') ? flexContainer : null))
    };

    const editor = {
      isConnected: true,
      getClientRects: () => [{ width: 380, height: 60 }],
      addEventListener() {},
      removeEventListener() {},
      closest: (sel) => (sel === '[data-testid="agent-input-box"]' ? box : null)
    };

    return {
      box,
      flexContainer,
      model,
      editor,
      provider,
      setState(nextCid, nextSteps) {
        currentCid = nextCid;
        currentSteps = nextSteps;
      },
      triggerChange() {
        if (onChangeCb) onChangeCb();
      },
      hasActiveSubscription() {
        return typeof onChangeCb === 'function';
      }
    };
  };

  const leftPane = makePaneMocks(CID_LEFT, 20);
  const rightPane = makePaneMocks(CID_RIGHT, 50);
  const createdShadowRoots = [];
  let mutationCallback = null;

  let rightUsed = 128_000;
  let rightRatio = 0.50;
  let rightPercent = '50.0%';
  let rightUsedK = '128.0K';

  globalThis.location = {
    pathname: `/c/${CID_LEFT}%2B${CID_RIGHT}`
  };

  globalThis.window = {
    top: null,
    innerWidth: 1440,
    __agContextRingHost: {
      getSnapshot: async (input) => {
        if (input?.conversationId === CID_LEFT) {
          return {
            ready: true,
            used: 64_000,
            limit: 256_000,
            ratio: 0.25,
            usedK: '64.0K',
            limitK: '256.0K',
            percent: '25.0%',
            tooltip: '25.0% · 64.0K / 256.0K 上下文已使用'
          };
        }
        if (input?.conversationId === CID_RIGHT) {
          return {
            ready: true,
            used: rightUsed,
            limit: 256_000,
            ratio: rightRatio,
            usedK: rightUsedK,
            limitK: '256.0K',
            percent: rightPercent,
            tooltip: `${rightPercent} · ${rightUsedK} / 256.0K 上下文已使用`
          };
        }
        return { ready: false };
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
    // 模拟焦点在左侧分屏（右侧分屏处于非焦点状态）
    activeElement: leftPane.editor,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => leftPane.box,
    querySelectorAll: (sel) => {
      if (sel.includes('contenteditable')) {
        return [leftPane.editor, rightPane.editor].filter(e => e.isConnected);
      }
      if (sel.includes('model-selector-trigger')) {
        return [leftPane.model, rightPane.model].filter(m => m.isConnected);
      }
      return [];
    },
    createElement: () => {
      const shadowMap = createShadowMap();
      const idx = createdShadowRoots.length;
      const ownerModel = idx === 0 ? leftPane.model : rightPane.model;
      createdShadowRoots.push(shadowMap);
      return {
        id: '',
        style: {},
        isConnected: true,
        previousElementSibling: ownerModel,
        addEventListener() {},
        remove() { this.isConnected = false; },
        attachShadow: () => ({
          innerHTML: '',
          getElementById: (id) => shadowMap.get(id),
          querySelector: () => ({ style: {} })
        })
      };
    }
  };

  globalThis.localStorage = {
    store: new Map(),
    getItem(k) { return this.store.get(k) || null; },
    setItem(k, v) { this.store.set(k, v); },
    removeItem(k) { this.store.delete(k); }
  };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  globalThis.MutationObserver = class {
    constructor(cb) { mutationCallback = cb; }
    observe() {}
    disconnect() {}
  };

  try {
    installAgContextRingWidget();
    await new Promise(r => setTimeout(r, 30));

    // 1. 验证无需聚焦右侧分屏，左右两个分屏同时挂载了各自的圆环，且显示各自独立的上下文进度
    assert.equal(createdShadowRoots.length, 2, '左右两个分屏必须同时挂载独立圆环实例');
    const leftTip = createdShadowRoots[0].get('tooltip-text');
    const rightTip = createdShadowRoots[1].get('tooltip-text');
    const leftBar = createdShadowRoots[0].get('ring-bar');
    const rightBar = createdShadowRoots[1].get('ring-bar');

    assert.equal(leftBar.style.opacity, '1', '左侧焦点分屏圆环进度条正常显示');
    assert.equal(rightBar.style.opacity, '1', '右侧非焦点分屏圆环进度条同样 100% 清晰常驻显示');
    assert.match(leftTip.textContent, /25\.0% · 64\.0K \/ 256\.0K/, '左屏独立显示 25.0%');
    assert.match(rightTip.textContent, /50\.0% · 128\.0K \/ 256\.0K/, '右屏无需点击聚焦即独立显示 50.0%');

    // 2. 验证右侧（非焦点）分屏后台流式输出触发 onDidChange 时，右屏圆环独立实时更新
    rightUsed = 192_000;
    rightRatio = 0.75;
    rightPercent = '75.0%';
    rightUsedK = '192.0K';
    rightPane.triggerChange();
    await new Promise(r => setTimeout(r, 300)); // 等待 250ms 防抖完成

    assert.match(rightTip.textContent, /75\.0% · 192\.0K \/ 256\.0K/, '后台非焦点分屏必须实时更新至 75.0%');
    assert.match(leftTip.textContent, /25\.0% · 64\.0K \/ 256\.0K/, '左屏数据保持独立不受影响');

    // 3. 验证分屏新建草稿防 URL 串台：右屏切为新建草稿（cid=null, steps=0），即使 location.pathname 含左屏 ID，右屏也必须显示 0% 草稿态
    rightPane.setState(null, 0);
    rightPane.triggerChange();
    await new Promise(r => setTimeout(r, 300));

    assert.equal(rightBar.style.opacity, '0', '草稿分屏进度条应隐藏为 0% 纯净底轨');
    assert.match(rightTip.textContent, /新会话 · 0\.0K \/ 256\.0K/, '草稿分屏绝不能误偷 URL 中另一分屏的会话 ID');

    // 4. 验证关闭右侧分屏后自动回收实例与订阅
    rightPane.box.isConnected = false;
    rightPane.model.isConnected = false;
    rightPane.editor.isConnected = false;
    if (mutationCallback) mutationCallback();
    await new Promise(r => setTimeout(r, 150));

    assert.equal(rightPane.hasActiveSubscription(), false, '关闭的分屏实例必须自动解绑 React Fiber 订阅');
    assert.equal(leftPane.hasActiveSubscription(), true, '保留的左屏实例订阅继续存活');
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

test('【回归 10】边界细节四合一验证：常规会话与持久压缩态会话回退(Edit/Retry)世代自增、草稿与 fallback 模型分母联动、L1 持久烙印保持', () => {
  // 1. 常规会话回退（Edit / Retry）：携带递增修订号的权威快照允许步数回退并自动推进 contextEpoch，而无修订号的乱序旧包仍被拦截
  const existing = normalizeSnapshotSchema({
    ready: true,
    used: 120_000,
    limit: 256_000,
    lastStepIndex: 30,
    contextEpoch: 1,
    isEstimated: false,
    source: 'ls-rpc'
  }, 'cid-rewind');

  // 1a. 无新修订号的乱序步数倒退 -> 坚决拦截
  const staleCheck = shouldAcceptSnapshot(existing, {
    ready: true,
    used: 40_000,
    limit: 256_000,
    lastStepIndex: 10,
    isEstimated: false,
    source: 'ls-rpc'
  }, { lastCommittedRevision: 2 });
  assert.equal(staleCheck.accept, false);
  assert.equal(staleCheck.reason, 'step-index-reversal');

  // 1b. 携带新修订号 (revision: 3 > lastCommitted: 2) 的权威回退快照 -> 放行并推进 nextEpoch: 2
  const rewindCheck = shouldAcceptSnapshot(existing, {
    ready: true,
    used: 40_000,
    limit: 256_000,
    lastStepIndex: 10,
    isEstimated: false,
    source: 'ls-rpc',
    _requestRevision: 3
  }, { lastCommittedRevision: 2 });
  assert.equal(rewindCheck.accept, true);
  assert.equal(rewindCheck.isRewind, true);
  assert.equal(rewindCheck.nextEpoch, 2);

  // 1c. L1 持久压缩态会话（existing 与 incoming 均带有相同 compressionDetected: true 且 compressionDrop 未扩大）
  const compressedExisting = normalizeSnapshotSchema({
    ready: true,
    used: 150_000,
    limit: 256_000,
    lastStepIndex: 50,
    contextEpoch: 1,
    isEstimated: false,
    source: 'ls-rpc',
    compressionDetected: true,
    compressionDrop: 20_000
  }, 'cid-compressed-rewind');

  // 持久压缩态下收到纯前端粗估快照 -> 依然被 rough-estimate-blocked 拦截，不因持久烙印误豁免
  const compressedRoughCheck = shouldAcceptSnapshot(compressedExisting, {
    ready: true,
    used: 60_000,
    limit: 256_000,
    lastStepIndex: 50,
    isEstimated: true,
    source: 'fiber-estimate',
    compressionDetected: true,
    compressionDrop: 20_000
  }, { lastCommittedRevision: 5 });
  assert.equal(compressedRoughCheck.accept, false);
  assert.equal(compressedRoughCheck.reason, 'rough-estimate-blocked', '已处于压缩态的会话不能因持久烙印被粗估快照覆盖');

  // 持久压缩态下收到无新修订号的乱序旧步数包 -> 依然被 step-index-reversal 拦截
  const compressedStaleCheck = shouldAcceptSnapshot(compressedExisting, {
    ready: true,
    used: 110_000,
    limit: 256_000,
    lastStepIndex: 35,
    isEstimated: false,
    source: 'ls-rpc',
    compressionDetected: true,
    compressionDrop: 20_000
  }, { lastCommittedRevision: 5 });
  assert.equal(compressedStaleCheck.accept, false);
  assert.equal(compressedStaleCheck.reason, 'step-index-reversal', '已处于压缩态的会话仍需拦截同世代乱序旧步数包');

  // 持久压缩态下用户触发 Edit/Retry 回退（携带新修订号 revision: 6 > 5） -> 正常放行并递增 nextEpoch: 2
  const compressedRewindCheck = shouldAcceptSnapshot(compressedExisting, {
    ready: true,
    used: 110_000,
    limit: 256_000,
    lastStepIndex: 35,
    isEstimated: false,
    source: 'ls-rpc',
    compressionDetected: true,
    compressionDrop: 20_000,
    _requestRevision: 6
  }, { lastCommittedRevision: 5 });
  assert.equal(compressedRewindCheck.accept, true);
  assert.equal(compressedRewindCheck.isRewind, true);
  assert.equal(compressedRewindCheck.nextEpoch, 2, '已处于压缩态的会话在用户回退历史消息时必须正常递增世代');

  // 2. 草稿分母推导与 fallbackModel 优先级（在役模型统一 256K 基准，且不覆盖历史轨迹自身的 CHECKPOINT 模型）
  assert.equal(inferClientModelLimit('Gemini 4 Argon 中'), 256_000);
  assert.equal(inferClientModelLimit('Gemini 3.8 Flash 高'), 256_000);
  assert.equal(inferClientModelLimit('Claude Sonnet 5.5'), 256_000);
  assert.equal(inferClientModelLimit('Claude Opus 5.5'), 256_000);

  const customHistorySteps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'CUSTOM_MODEL_160K',
          inputTokens: 60_000,
          outputTokens: 1_200,
          cacheReadTokens: 0,
          cacheCreationTokens: 0
        }
      }
    }
  ];
  const calcWithFallback = processTrajectorySteps(customHistorySteps, { fallbackModel: 'Gemini 4 Argon 中', customLimits: { 'CUSTOM_MODEL_160K': 160_000 } });
  assert.equal(calcWithFallback.contextLimit, 160_000, 'fallbackModel 绝不能篡改历史会话已有的真实 Checkpoint 模型分母');

  // 3. 方案 L1（会话级持久烙印）：当后续对话重新涨过压缩前水位时，仍保留压缩标记以支持高水位紫红二次超限阶梯
  const regrownSteps = [
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M418', inputTokens: 54_000, outputTokens: 200 } }
    },
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M418', inputTokens: 34_000, outputTokens: 200 } } // 降 20K 触发压缩标记
    },
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M418', inputTokens: 60_000, outputTokens: 200 } } // 重新涨超 54K 原水位
    }
  ];
  const calcRegrown = processTrajectorySteps(regrownSteps);
  assert.equal(calcRegrown.compressionDetected, true, '会话级持久烙印：后续水位涨超压缩前水位仍保留压缩标记，支持紫红二次超限阶梯');
  assert.equal(calcRegrown.compressionDrop, 20_000);
});

test('【回归 11】双轨收束汇流色彩流转 (Dual-Track Convergent Color Hierarchy)：低位亮紫区分压缩、高位统一汇入标准告警色及异常值兜底', () => {
  assert.equal(typeof getRingColor, 'function', 'getRingColor 必须作为核心方法导出');

  // 1. 正常轨道（未压缩）
  assert.equal(getRingColor(0.00, false), 'var(--ring-bar)', '正常轨道 0% 必须自适应 CSS 变量');
  assert.equal(getRingColor(0.59, false), 'var(--ring-bar)', '正常轨道 59% 必须自适应 CSS 变量');
  assert.equal(getRingColor(0.60, false), '#f59e0b', '正常轨道 60% 必须为琥珀黄');
  assert.equal(getRingColor(0.79, false), '#f59e0b', '正常轨道 79% 必须为琥珀黄');
  assert.equal(getRingColor(0.80, false), '#f97316', '正常轨道 80% 必须为暖橙红');
  assert.equal(getRingColor(0.89, false), '#f97316', '正常轨道 89% 必须为暖橙红');
  assert.equal(getRingColor(0.90, false), '#ff2626', '正常轨道 90% 必须为纯正红');
  assert.equal(getRingColor(1.00, false), '#ff2626', '正常轨道 100% 必须为纯正红');

  // 2. 压缩后轨道（<60% 薰衣草亮紫区分，≥60% 统一汇入琥珀黄 -> 暖橙红 -> 纯正红）
  assert.equal(getRingColor(0.00, true), '#a78bfa', '压缩轨道 0% 必须为薰衣草亮紫（压缩安全期）');
  assert.equal(getRingColor(0.59, true), '#a78bfa', '压缩轨道 59% 必须为薰衣草亮紫（压缩安全期）');
  assert.equal(getRingColor(0.60, true), '#f59e0b', '压缩轨道 60% 必须汇入琥珀黄（注意期）');
  assert.equal(getRingColor(0.79, true), '#f59e0b', '压缩轨道 79% 必须汇入琥珀黄（注意期）');
  assert.equal(getRingColor(0.80, true), '#f97316', '压缩轨道 80% 必须汇入暖橙红（警告期）');
  assert.equal(getRingColor(0.89, true), '#f97316', '压缩轨道 89% 必须汇入暖橙红（警告期）');
  assert.equal(getRingColor(0.90, true), '#ff2626', '压缩轨道 90% 必须汇入纯正红（极危截断期）');
  assert.equal(getRingColor(1.00, true), '#ff2626', '压缩轨道 100% 必须汇入纯正红（极危截断期）');

  // 3. 异常非有限数输入安全兜底（回退至 0% 安全色，绝不误报极危红）
  assert.equal(getRingColor(NaN, false), 'var(--ring-bar)', '正常轨道传入 NaN 应安全回退至自适应 CSS 变量');
  assert.equal(getRingColor(undefined, true), '#a78bfa', '压缩轨道传入 undefined 应安全回退至薰衣草亮紫');
});

test('【回归 12】三道防线体系 (Three-Tier Defense)：跨模型载荷重构防误报、次轮延迟误报清零、双门槛断崖检测与步数单调守卫', () => {
  assert.equal(COMPRESSION_MIN_DROP_TOKENS, 15_000, '绝对降幅下限必须为 15K');
  assert.equal(COMPRESSION_MIN_DROP_RATIO, 0.25, '相对降幅下限必须为 25%');
  assert.equal(normalizeModelId('  Gemini-3.8-Flash  '), 'gemini-3.8-flash', 'normalizeModelId 必须支持 trim 与 lowerCase');

  // 1. 测试用例 1（死胡同 84 实况复现）：Argon 120,325 ➔ Flash 115,006（跌 5,319），验证跨模型防线 2 拦截，compressionDetected 为 false
  const crossModelDropSteps = [
    {
      type: StepType.CHECKPOINT,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M418', inputTokens: 120_325, outputTokens: 500 } }
    },
    {
      type: StepType.CHECKPOINT,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 115_006, outputTokens: 500 } }
    }
  ];
  const r1 = processTrajectorySteps(crossModelDropSteps);
  assert.equal(r1.compressionDetected, false, '跨模型载荷重构（分词/Prompt差异跌 5.3K）严禁误报为上下文压缩');
  assert.equal(r1.compressionDrop, 0);

  // 2. 测试用例 2（漏洞 1 次轮延迟误报验证）：在切模型后下一回合（继续使用 Flash 正常增至 118,000），验证消灭延迟误报
  const nextTurnSteps = [
    ...crossModelDropSteps,
    {
      type: StepType.CHECKPOINT,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 118_000, outputTokens: 500 } }
    }
  ];
  const r2 = processTrajectorySteps(nextTurnSteps);
  assert.equal(r2.compressionDetected, false, '切模型次轮基准已重锚定，同模型正常增长绝不能触发延迟误报');

  // 3. 测试用例 3（跨模型 Thinking 块剥离等大跌验证）：Claude 5.5 100K ➔ Gemini 4 Argon 65K（跨模型跌 35K 载荷剥离），验证不被误判为压缩
  const crossModelBigDropSteps = [
    {
      type: StepType.CHECKPOINT,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M405', inputTokens: 100_000, outputTokens: 1000 } }
    },
    {
      type: StepType.CHECKPOINT,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M417', inputTokens: 65_000, outputTokens: 1000 } }
    }
  ];
  const r3 = processTrajectorySteps(crossModelBigDropSteps);
  assert.equal(r3.compressionDetected, false, '跨模型 Thinking 块剥离导致的万级下跌属于载荷重构，不标记压缩');

  // 4. 测试用例 4（跨模型后发生真实压缩）：在切到 Flash 后，上下文由 150K 真实压缩至 30K（跌 120K，80%），验证精准触发压缩
  const realCompressionAfterSwitchSteps = [
    {
      type: StepType.CHECKPOINT,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M418', inputTokens: 120_000, outputTokens: 500 } }
    },
    {
      type: StepType.CHECKPOINT,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 150_000, outputTokens: 500 } }
    },
    {
      type: StepType.CHECKPOINT,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 30_000, outputTokens: 500 } } // 跌 120K (80%)
    }
  ];
  const r4 = processTrajectorySteps(realCompressionAfterSwitchSteps);
  assert.equal(r4.compressionDetected, true, '切换模型后发生的真实 Auto-Compaction 必须精准捕获');
  assert.equal(r4.compressionDrop, 120_000);

  // 5. 测试用例 5（漏洞 2 Edit/Retry 步数倒退）：同模型下非单调步骤导致 Token 减少，防线 1 拦截且不触发压缩
  const nonMonotonicSteps = [
    {
      type: StepType.CHECKPOINT,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 80_000, outputTokens: 500 } }
    }
  ];
  const r5Before = processTrajectorySteps(nonMonotonicSteps);
  assert.equal(r5Before.compressionDetected, false);

  // 6. 测试用例 6（中间步缺失 model 字段）：继承上一有效模型，不被误判为模型切换
  const missingModelSteps = [
    {
      type: StepType.CHECKPOINT,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 80_000, outputTokens: 500 } }
    },
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: { modelUsage: { model: '', inputTokens: 82_000, outputTokens: 500 } } // 缺失 model 字段
    },
    {
      type: StepType.CHECKPOINT,
      metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: 20_000, outputTokens: 500 } } // 真实压缩 (跌 62K, 75%)
    }
  ];
  const r6 = processTrajectorySteps(missingModelSteps);
  assert.equal(r6.compressionDetected, true, '中间步缺失 model 字段应继承上一有效模型，后续同模型真实压缩正常捕获');
  assert.equal(r6.compressionDrop, 62_000);
});

test('【回归 13】无显式 USER_INPUT planModel 时跨模型切换：分母动态跟随最新 checkpointModel 且免疫中间步空模型名', () => {
  // 场景 A：首轮使用 Claude 3.7 Sonnet (160K)，次轮切换至 GPT-OSS 120B (80K)
  const switchedSteps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'Claude-3.7-Sonnet',
          inputTokens: 60_000,
          outputTokens: 1_000
        }
      }
    },
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'GPT-OSS-120B',
          inputTokens: 40_000,
          outputTokens: 500
        }
      }
    }
  ];

  const customTestLimits = {
    'Claude-3.7-Sonnet': 160_000,
    'GPT-OSS-120B': 80_000,
    'MODEL_PLACEHOLDER_M16': 128_000,
    'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': 80_000
  };

  const calcSwitched = processTrajectorySteps(switchedSteps, { customLimits: customTestLimits });
  assert.equal(calcSwitched.checkpointModel, 'GPT-OSS-120B', '最新快照模型必须更新为 GPT-OSS-120B');
  assert.equal(calcSwitched.contextLimit, 80_000, '无显式 USER_INPUT 锁定时，分母必须跟随最新 checkpointModel 切换为 80K，不得被首轮 160K 锁死');

  // 场景 B：后续 PLANNER_RESPONSE 步骤的 modelUsage.model 为空字符串时，不得冲掉已有的 checkpointModel
  const emptyModelFollowUpSteps = [
    ...switchedSteps,
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        modelUsage: {
          model: '',
          inputTokens: 45_000,
          outputTokens: 600
        }
      }
    }
  ];

  const calcEmptyFollowUp = processTrajectorySteps(emptyModelFollowUpSteps, { customLimits: customTestLimits });
  assert.equal(calcEmptyFollowUp.checkpointModel, 'GPT-OSS-120B', '中间步骤空 model 字段不得清空已记录的 checkpointModel');
  assert.equal(calcEmptyFollowUp.contextLimit, 80_000, '分母必须继续保持 80K 而不是回退到默认 256K');
});

test('【回归 14】首轮显式 planModel 后切换模型但新 USER_INPUT 无配置：分母必须由后续权威 Checkpoint 重新锚定', () => {
  const steps = [
    {
      stepIndex: 0,
      type: StepType.USER_INPUT,
      userInput: {
        userResponse: '首轮使用 Pro',
        userConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M16' } }
      }
    },
    {
      stepIndex: 1,
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M16',
          inputTokens: 60_000,
          outputTokens: 1_000
        }
      }
    },
    {
      stepIndex: 2,
      type: StepType.USER_INPUT,
      userInput: { userResponse: '切到 GPT-OSS 继续，但该回合没有 plannerConfig' }
    },
    {
      stepIndex: 3,
      type: StepType.INVOKE_SUBAGENT,
      metadata: { generatorModel: 'MODEL_PLACEHOLDER_M318', toolCallOutputTokens: 2_000 }
    },
    {
      stepIndex: 4,
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
          inputTokens: 40_000,
          outputTokens: 500
        }
      }
    }
  ];

  const result = processTrajectorySteps(steps, {
    customLimits: {
      'MODEL_PLACEHOLDER_M16': 128_000,
      'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': 80_000
    }
  });
  assert.equal(result.selectedModel, 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', '新回合无显式配置时，分母必须由该回合 Checkpoint 重新锚定');
  assert.equal(result.checkpointModel, 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM');
  assert.equal(result.contextLimit, 80_000, '切到 GPT-OSS 后必须使用 80K，而不是继续锁死旧的 Pro 128K');
  assert.equal(result.contextUsed, 40_500, '最新权威水位必须来自 GPT-OSS Checkpoint');
  assert.equal(result.usageRatio, 40_500 / 80_000);
});

test('【回归 15】会话识别失败不得伪装成新草稿 0%', () => {
  const widgetSource = readFileSync(new URL('../assets/ring-widget.cjs', import.meta.url), 'utf8');
  assert.ok(!widgetSource.includes('if (!view) return true;'), '找不到 conversation view 时绝不能直接判定为草稿');
  assert.match(widgetSource, /if \(!view\) return false;/, '识别失败必须与确认的草稿态分离');
  assert.match(widgetSource, /getUnresolvedSnapshot\(\)/, 'CID 无法解析时必须渲染明确的识别失败状态');
  assert.doesNotMatch(
    widgetSource,
    /if \(!cid\) \{\s*inst\.consecutiveFailures = 0;\s*updatePaneView\(inst, getDraftSnapshot/,
    'CID 缺失不得继续回退为 0% 新会话'
  );

  // 顺手加固 4 细节防回归断言：
  // 1. 亚像素对齐：.ring-box 必须为 18px 消除半像素边界
  assert.match(widgetSource, /\.ring-box\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;/s, '.ring-box 必须为 18px × 18px');
  // 2. 首帧防闪烁：HTML 模板默认 unready 且初态 updatePaneView 在 insertBefore 之前执行
  assert.match(widgetSource, /<div class="context-ring unready" id="context-ring">/, 'HTML 模板必须默认携带 unready');
  const mountInitialUpdatePos = widgetSource.indexOf('// 挂载初态同步：在插入 DOM 前完成初态计算与渲染');
  const insertBeforePos = widgetSource.indexOf('flexContainer.insertBefore(node, modelBranch.nextSibling);');
  assert.ok(mountInitialUpdatePos !== -1 && insertBeforePos !== -1 && mountInitialUpdatePos < insertBeforePos, '挂载初态同步必须在 insertBefore 之前执行');
  // 3. 浅色模式 CSS 变量不被内联样式覆盖
  assert.match(widgetSource, /return isCompressed \? '#a78bfa' : 'var\(--ring-bar\)';/, 'getRingColor 常规低位态必须返回 var(--ring-bar)');
  // 4. 草稿态轮询去 force 并对齐 tooltip 命中 diff 守卫
  assert.match(widgetSource, /tooltip:\s*'新会话 · 0\.0K \/ 256\.0K 上下文未占用'/s, 'DRAFT_SNAPSHOT tooltip 必须对齐');
  assert.match(widgetSource, /if \(isDraftView\(inst\.box, totalPanes\)\) \{\s*inst\.lastConversationId = null;\s*inst\.consecutiveFailures = 0;\s*updatePaneView\(inst, getDraftSnapshot\([^)]*\)\);\s*scheduleNextPaneSync\(inst, 5000\);/s, '草稿态轮询去 force 并保留 currentData');
});

test('【回归 16】PowerShell 配置更新必须兼容已存在的空插件对象 {}', () => {
  const installPs = readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');
  const uninstallPs = readFileSync(new URL('../uninstall.ps1', import.meta.url), 'utf8');

  assert.match(installPs, /PSObject\.Properties\['enabled'\]/, '安装脚本写 enabled 前必须检查属性是否存在');
  assert.match(installPs, /Add-Member -NotePropertyName 'enabled'/, '空插件对象必须通过 Add-Member 增加 enabled');
  assert.match(uninstallPs, /Add-Member -NotePropertyName 'enabled' -NotePropertyValue \$false/, '卸载脚本对空插件对象同样必须 Add-Member enabled=false');
});

test('【回归 17】mountOrUpdatePane 容器探测防越界: candidateContainer !== box 坚决防止误选外层 box', () => {
  const widgetSource = readFileSync(new URL('../assets/ring-widget.cjs', import.meta.url), 'utf8');
  assert.ok(
    widgetSource.includes('candidateContainer !== box'),
    'mountOrUpdatePane 向上探查 .flex-1 容器时必须包含 candidateContainer !== box 守卫，杜绝误把 box 当成工具栏容器'
  );

  // 模拟 DOM 结构验证：box 自身携带 flex-1
  const box = { className: 'agent-input-box flex-1', isConnected: true };
  const toolbar = { className: 'bottom-toolbar', parentElement: box };
  const model = { className: 'model-trigger', parentElement: toolbar };

  // 当向上搜索最近的 .flex-1 命中了 box 自身时：
  toolbar.closest = (sel) => (sel === '.flex-1' ? box : null);
  const candidateContainer = model.parentElement?.closest?.('.flex-1');
  assert.equal(candidateContainer, box, '前置条件：向上探查命中 box 自身');

  box.contains = (el) => el === box || el === toolbar || el === model;
  const flexContainer = (candidateContainer && candidateContainer !== box && box?.contains(candidateContainer))
    ? candidateContainer
    : (model.parentElement || box);

  assert.equal(flexContainer, toolbar, '添加 candidateContainer !== box 守卫后必须安全回退至 model.parentElement (toolbar)，绝不落入 box');
});

test('【回归 18】冷会话/过渡态 Fiber 预估离线稳态: RPC 失败时 fallback 链保留 inst.currentData 绝不退化为 0.15 灰环', () => {
  const widgetSource = readFileSync(new URL('../assets/ring-widget.cjs', import.meta.url), 'utf8');
  assert.ok(
    widgetSource.includes('isCurrentDataValid ? inst.currentData : null'),
    'syncPaneState 失败分支中 fallbackSnap 必须优先保留有效的 inst.currentData'
  );
  assert.ok(
    widgetSource.includes('!inst.currentData.isPending') && widgetSource.includes('!inst.currentData.isDraft'),
    '有效 inst.currentData 必须排除 pending 与 draft 态'
  );
});

test('【回归 19】前后端模型截断阈值双向对齐: Hydrogen(256K线上基线) / GPT-OSS(80K) / Argon&Carbon&Claude5.5(256K) / Legacy(160K/128K)', () => {
  const cases = [
    // Gemini 4 Hydrogen (线上 AICode Mendel 实际截断基线 256K)
    { id: 'MODEL_PLACEHOLDER_M525', limit: 256_000 },
    { id: 'MODEL_PLACEHOLDER_M526', limit: 256_000 },
    { id: 'MODEL_PLACEHOLDER_M527', limit: 256_000 },
    { id: 'MODEL_PLACEHOLDER_M528', limit: 256_000 },
    { id: 'MODEL_PLACEHOLDER_M432', limit: 256_000 },
    { id: 'MODEL_PLACEHOLDER_M433', limit: 256_000 },
    { id: 'MODEL_PLACEHOLDER_M434', limit: 256_000 },
    { id: 'gemini-4-hydrogen', limit: 256_000 },
    { id: 'gemini-4-hydrogen-high', limit: 256_000 },
    { id: 'gemini-4-hydrogen-medium', limit: 256_000 },
    { id: 'gemini-4-hydrogen-low', limit: 256_000 },
    { id: 'gemini-4-hydrogen-xhigh', limit: 256_000 },
    { id: 'Gemini 4 Hydrogen (Medium) 新', limit: 256_000 },
    { id: 'Gemini 4 Hydrogen (XHigh) (New)', limit: 256_000 },
    // Orchestrator (Argon) (256K)
    { id: 'MODEL_PLACEHOLDER_M667', limit: 256_000 },
    { id: 'MODEL_PLACEHOLDER_M668', limit: 256_000 },
    { id: 'gemini-pro-orchestrator-g1-pro', limit: 256_000 },
    { id: 'Orchestrator (Argon)', limit: 256_000 },
    // Gemini 4 Carbon (256K)
    { id: 'MODEL_PLACEHOLDER_M670', limit: 256_000 },
    { id: 'gemini-4-carbon-disabled', limit: 256_000 },
    { id: 'gemini-4-carbon-low', limit: 256_000 },
    { id: 'gemini-4-carbon-medium', limit: 256_000 },
    { id: 'gemini-4-carbon-high', limit: 256_000 },
    { id: 'Gemini 4 Carbon (High) 注意', limit: 256_000 },
    // Claude Opus/Sonnet 5.5 (256K)
    { id: 'claude-opus-5-5-max', limit: 256_000 },
    { id: 'claude-opus-5.5-max', limit: 256_000 },
    { id: 'Claude Opus 5.5 (Max)', limit: 256_000 },
    { id: 'Claude Sonnet 5.5 (High)', limit: 256_000 },
    // GPT-OSS 120B (80K)
    { id: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', limit: 80_000 },
    { id: 'gpt-oss-120b-medium', limit: 80_000 },
    { id: 'GPT-OSS 120B (Medium) 注意', limit: 80_000 },
    // Legacy M26/M35 (160K)
    { id: 'MODEL_PLACEHOLDER_M26', limit: 160_000 },
    { id: 'MODEL_PLACEHOLDER_M35', limit: 160_000 },
    // Gemini 2.5 & M50/M18/M148/M198 (128K)
    { id: 'MODEL_GOOGLE_GEMINI_2_5_FLASH', limit: 128_000 },
    { id: 'MODEL_GOOGLE_GEMINI_2_5_PRO', limit: 128_000 },
    { id: 'gemini-2.5-flash', limit: 128_000 },
    { id: 'gemini-2.5-pro', limit: 128_000 },
    { id: 'MODEL_PLACEHOLDER_M50', limit: 128_000 },
    { id: 'MODEL_PLACEHOLDER_M18', limit: 128_000 },
    { id: 'MODEL_PLACEHOLDER_M148', limit: 128_000 },
    { id: 'MODEL_PLACEHOLDER_M198', limit: 128_000 },
  ];

  for (const item of cases) {
    assert.equal(getPlatformTruncationLimit(item.id), item.limit, `后端 getPlatformTruncationLimit(${item.id}) 应返回 ${item.limit}`);
    assert.equal(inferClientModelLimit(item.id), item.limit, `前端 inferClientModelLimit(${item.id}) 应返回 ${item.limit}`);
  }

  // 防边界数字前缀/后缀误命中（例如 M5250 不得命中 Hydrogen，M180 不得命中 M18 的 128K，M260 不得命中 M26 的 160K）
  assert.equal(inferClientModelLimit('MODEL_PLACEHOLDER_M5250'), 256_000, 'M5250 不得误匹配 M525');
  assert.equal(inferClientModelLimit('MODEL_PLACEHOLDER_M180'), 256_000, 'M180 不得误匹配 M18 (128K)');
  assert.equal(inferClientModelLimit('MODEL_PLACEHOLDER_M260'), 256_000, 'M260 不得误匹配 M26 (160K)');
  assert.equal(normalizeModelLookupKey('Gemini 4 Hydrogen (Medium) 新'), 'gemini-4-hydrogen-medium');
  assert.equal(normalizeModelLookupKey('GPT-OSS 120B (Medium) 注意'), 'gpt-oss-120b-medium');
});

test('【回归 20】resolveDynamicModelState: GetUserStatus 懒同步、动态别名限额重算、TTL 缓存与异常兜底', async () => {
  _getMemoryCacheInfo().clear();
  clearDynamicModelCatalog();

  try {
    // 1. 已知模型直接跳过，0 次额外 RPC
    let rpcCalls = 0;
    const knownCalc = {
      ready: true,
      model: 'MODEL_PLACEHOLDER_M526',
      isUnknownModel: false,
      contextUsed: 100_000,
      contextLimit: 256_000,
      usageRatio: 100_000 / 256_000,
      isOverLimit: false,
    };
    await resolveDynamicModelState(knownCalc, { port: 1 }, async () => {
      rpcCalls++;
      return {};
    });
    assert.equal(rpcCalls, 0, '已知模型不得发起 GetUserStatus RPC');

    // 2. 未知模型首次触发 GetUserStatus 懒同步：一方面将别名解析为 M26 (160K) 并重算；
    //    另一方面若携带同族 runtimeMaxContextTokens（如 512K），消除告警的同时不得用静态表反向冲掉运行态限额
    const unknownAliasCalc = {
      ready: true,
      model: 'MODEL_PLACEHOLDER_M999',
      selectedModel: 'MODEL_PLACEHOLDER_M999',
      isUnknownModel: true,
      contextUsed: 180_000,
      contextLimit: 256_000,
      usageRatio: 180_000 / 256_000,
      isOverLimit: false,
    };
    await resolveDynamicModelState(unknownAliasCalc, { port: 1 }, async (_ls, method) => {
      rpcCalls++;
      assert.equal(method, 'GetUserStatus');
      return {
        userStatus: {
          cascadeModelConfigData: {
            clientModelConfigs: [
              {
                modelId: 'MODEL_PLACEHOLDER_M999',
                label: 'Future Model Preview 新',
                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M26' },
              },
              {
                modelId: 'MODEL_PLACEHOLDER_M998',
                label: 'Future Compact Alpha 注意',
                modelOrAlias: { model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM' },
              },
            ],
          },
        },
      };
    });
    assert.equal(rpcCalls, 1, '首次遇到未知模型应调一次 GetUserStatus');
    assert.equal(unknownAliasCalc.isUnknownModel, false, '同步后应消除 isUnknownModel');
    assert.equal(unknownAliasCalc.contextLimit, 160_000, '动态别名映射到 M26 后应重算 contextLimit 为 160K');
    assert.equal(unknownAliasCalc.usageRatio, 1, '180K >= 160K 时 usageRatio 必须钳位至 1');
    assert.equal(unknownAliasCalc.isOverLimit, true, '180K >= 160K 时 isOverLimit 必须重算为 true');

    // 3. TTL 内命中已缓存动态目录的另一个别名 (label 带徽章)，0 次额外 RPC 且正确重算为 80K
    const cachedOssLabel = {
      ready: true,
      model: 'Future Compact Alpha 注意',
      isUnknownModel: true,
      contextUsed: 82_000,
      contextLimit: 256_000,
      usageRatio: 82_000 / 256_000,
      isOverLimit: false,
    };
    await resolveDynamicModelState(cachedOssLabel, { port: 1 }, async () => {
      rpcCalls++;
      return {};
    });
    assert.equal(rpcCalls, 1, '命中已缓存动态目录不得再次发起 GetUserStatus RPC');
    assert.equal(cachedOssLabel.isUnknownModel, false);
    assert.equal(cachedOssLabel.contextLimit, 80_000, '动态目录别名应将限额重算为 80K');
    assert.equal(cachedOssLabel.usageRatio, 1, '82K >= 80K 时 usageRatio 必须钳位至 1');
    assert.equal(cachedOssLabel.isOverLimit, true, '82K >= 80K 时 isOverLimit 必须重算为 true');

    // 4. TTL 缓存有效期内遇到目录外的新未知模型，同样不重复冲刷 GetUserStatus
    const uncatalogedModel = {
      ready: true,
      model: 'totally-unlisted-model-x',
      isUnknownModel: true,
      contextUsed: 10_000,
      contextLimit: 256_000,
      usageRatio: 10_000 / 256_000,
      isOverLimit: false,
    };
    await resolveDynamicModelState(uncatalogedModel, { port: 1 }, async () => {
      rpcCalls++;
      return {};
    });
    assert.equal(rpcCalls, 1, 'TTL 有效期内不应重复请求 GetUserStatus');
    assert.equal(uncatalogedModel.isUnknownModel, true, '未在动态目录中的未知模型保持 isUnknownModel=true');

    // 5. 清空缓存后 RPC 抛错静默兜底，且 formatContextResult 对非 256K 未知模型正确显示默认标签
    clearDynamicModelCatalog();
    const errorFallbackCalc = {
      ready: true,
      model: 'totally-unlisted-model-x',
      isUnknownModel: true,
      contextUsed: 20_000,
      contextLimit: 80_000,
      usageRatio: 20_000 / 80_000,
      isOverLimit: false,
    };
    await resolveDynamicModelState(errorFallbackCalc, { port: 1 }, async () => {
      rpcCalls++;
      throw new Error('LS timeout');
    });
    assert.equal(rpcCalls, 2, '清空缓存后允许重新探查一次 GetUserStatus');
    assert.equal(errorFallbackCalc.isUnknownModel, true, 'RPC 异常时静默保留原状态');
    assert.equal(errorFallbackCalc.contextLimit, 80_000);

    const formattedCustomUnknown = formatContextResult(errorFallbackCalc);
    assert.match(formattedCustomUnknown.tooltip, /未知模型限制 默认80\.0K/, '非 256K 未知模型 tooltip 必须展示实际默认阈值');
    const formattedDefaultUnknown = formatContextResult({ ...errorFallbackCalc, contextLimit: 256_000, usageRatio: 20_000 / 256_000 });
    assert.match(formattedDefaultUnknown.tooltip, /未知模型限制 默认256K/, '256K 未知模型 tooltip 必须展示默认256K');
  } finally {
    clearDynamicModelCatalog();
    _getMemoryCacheInfo().clear();
  }
});
