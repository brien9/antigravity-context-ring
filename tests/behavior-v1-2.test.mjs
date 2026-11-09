import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeBridgeManager } from '../sidecars/ring/runtime-bridge.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);
const installAgContextRingWidget = require('../assets/ring-widget.cjs');

const OK_SNAPSHOT = {
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
const FAIL_SNAPSHOT = { ready: false };

// 可控假时钟：接管 setTimeout/clearTimeout，按虚拟时间推进并冲洗微任务，
// 用于对真实 widget 组件验证轮询闹钟的延迟序列（不依赖任何复刻算法）
function installFakeClock() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let seq = 0;
  const tasks = new Map();
  const schedules = [];

  globalThis.setTimeout = (fn, delay = 0, ...args) => {
    const id = ++seq;
    const d = Math.max(0, Number(delay) || 0);
    tasks.set(id, { id, at: now + d, seq: id, fn, args });
    schedules.push({ delay: d, src: typeof fn === 'function' ? String(fn) : String(fn) });
    return id;
  };
  globalThis.clearTimeout = (id) => { tasks.delete(id); };

  const flush = () => new Promise((r) => realSetTimeout(r, 0));

  return {
    pollDelays: () => schedules.filter((s) => s.src.includes('syncPaneState')).map((s) => s.delay),
    pendingPollCount: () => [...tasks.values()].filter((t) => String(t.fn).includes('syncPaneState')).length,
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...tasks.values()]
          .filter((t) => t.at <= now)
          .sort((a, b) => a.at - b.at || a.seq - b.seq);
        if (due.length === 0) break;
        for (const t of due) tasks.delete(t.id);
        for (const t of due) {
          if (typeof t.fn === 'function') t.fn(...t.args);
        }
        await flush();
      }
      await flush();
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      tasks.clear();
    }
  };
}

// 复用产品同构 DOM/Fiber/宿主桥 mock 骨架，让真实 widget 在 Node 测试进程内完整挂载运行
function buildWidgetDomHarness({ getSnapshot, initialModelText, providerState }) {
  let currentModelText = initialModelText;
  let mutationCb = null;
  const rpcRequests = [];
  const CID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const shadowMap = new Map();
  for (const id of ['ring-bar', 'tooltip-text', 'context-ring', 'ring-container', 'tooltip']) {
    shadowMap.set(id, {
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

  const provider = {
    getState: () => providerState || ({ conversationId: CID, trajectorySlice: { totalStepsLength: 25 } }),
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

  const storageMap = new Map();
  globalThis.location = { pathname: `/c/${CID}` };
  globalThis.window = {
    top: null,
    innerWidth: 1440,
    __agContextRingHost: {
      getSnapshot: async (input) => {
        rpcRequests.push(input);
        return getSnapshot(input, rpcRequests.length);
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
  globalThis.MutationObserver = class {
    constructor(cb) { mutationCb = cb; }
    observe() {}
    disconnect() {}
  };

  return {
    CID,
    rpcRequests,
    setModelText: (t) => { currentModelText = t; },
    getShadowText: (id) => shadowMap.get(id)?.textContent ?? '',
    triggerMutation: () => { if (mutationCb) mutationCb(); },
    cleanup() {
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
  };
}

test('【行为级 1】真实组件轮询时序: 失败 5s -> 连败 10s -> 恢复立即回 5s，且任一时刻仅一个闹钟', async () => {
  const clock = installFakeClock();
  const h = buildWidgetDomHarness({
    initialModelText: 'Gemini 4 Argon',
    getSnapshot: (input, callNo) => (callNo <= 2 ? FAIL_SNAPSHOT : OK_SNAPSHOT)
  });

  try {
    installAgContextRingWidget();
    await clock.advance(0);

    assert.equal(h.rpcRequests.length, 1, '挂载后必须立即发起首轮同步');
    assert.deepEqual(clock.pollDelays(), [5000], '首次失败（计数=1）后下一拍必须 5s');
    assert.equal(clock.pendingPollCount(), 1, '任一时刻只允许存在一个轮询闹钟');

    await clock.advance(5000);
    assert.equal(h.rpcRequests.length, 2, '5s 闹钟到期必须触发第二轮同步');
    assert.deepEqual(clock.pollDelays(), [5000, 10000], '连续第二次失败（计数=2 结算后）必须进入 10s 退避');
    assert.equal(clock.pendingPollCount(), 1);

    await clock.advance(10000);
    assert.equal(h.rpcRequests.length, 3, '10s 闹钟到期必须触发第三轮同步');
    assert.deepEqual(
      clock.pollDelays(),
      [5000, 10000, 5000],
      '恢复成功必须先清零失败计数再定下一拍：立即回到 5s（旧实现调度早于计数结算，此处会误排 10s）'
    );
    assert.equal(clock.pendingPollCount(), 1, '恢复成功后同样只保留一个轮询闹钟，无重复调度');
  } finally {
    h.cleanup();
    clock.restore();
  }
});

test('【行为级 2】真实 _performSync 生命周期: 发现失败保连接、假死巡检剔除、真实空列表清理、恢复重连', async () => {
  const fakeSockets = [];
  const emit = (ws, type, event) => { for (const fn of ws.listeners.get(type) || []) fn(event); };

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.listeners = new Map();
      this.sent = [];
      this.failSend = false;
      fakeSockets.push(this);
      queueMicrotask(() => emit(this, 'open', {}));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send(data) {
      if (this.failSend) throw new Error('fake socket dead');
      const msg = JSON.parse(data);
      this.sent.push(msg);
      if (msg.id !== undefined) {
        queueMicrotask(() => emit(this, 'message', {
          data: JSON.stringify({ id: msg.id, result: { result: { type: 'boolean', value: true } } })
        }));
      }
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      emit(this, 'close', {});
    }
  }

  const hadWebSocket = 'WebSocket' in globalThis;
  const origWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;

  const WIDGET = '/* widget code test v1.2 */';
  let discoverResult = null;
  const manager = new RuntimeBridgeManager('/fake/profile', WIDGET, {
    discoverTargets: async () => discoverResult
  });
  manager.running = true;
  manager.generation = 1;
  const URL_A = 'ws://127.0.0.1:9222/devtools/page/AAA';

  try {
    // 1. 首次发现成功：建立连接并完成完整注入链
    discoverResult = [{ type: 'page', webSocketDebuggerUrl: URL_A, title: 'Antigravity' }];
    await manager._performSync(1);
    assert.equal(manager.connections.size, 1, '发现成功必须建立连接');
    const conn1 = manager.connections.get(URL_A);
    assert.ok(conn1 && !conn1.closed, '新目标连接必须处于健康状态');
    assert.ok(conn1.ws.sent.some((m) => m.method === 'Runtime.enable'), '必须启用 Runtime 域');
    assert.ok(
      conn1.ws.sent.some((m) => m.method === 'Runtime.evaluate' && String(m.params.expression).includes(WIDGET)),
      '必须注入 widget 代码'
    );

    // 2. 目标发现失败（DevToolsActivePort 读取失败/HTTP 超时 → null）：绝不误杀健康连接
    const socketCountAfterFirst = fakeSockets.length;
    discoverResult = null;
    await manager._performSync(1);
    assert.equal(manager.connections.size, 1, '发现失败绝不清理健康连接（高负载瞬时超时场景）');
    assert.strictEqual(manager.connections.get(URL_A), conn1, '发现失败必须保留同一连接实例');
    assert.equal(fakeSockets.length, socketCountAfterFirst, '发现失败期间绝不发起新连接');
    assert.ok(
      conn1.ws.sent.some((m) => m.method === 'Runtime.evaluate' && String(m.params.expression).includes('__agContextRingInstalled')),
      '发现失败期间必须继续巡检存量连接的注入健康度'
    );
    assert.equal(
      conn1.ws.sent.filter((m) => String(m.params?.expression || '').includes(WIDGET)).length,
      1,
      '巡检健康（返回 true）时不得重复注入'
    );

    // 3. 巡检发现假死连接（send 抛异常）：即使发现失败也必须剔除
    conn1.ws.failSend = true;
    await manager._performSync(1);
    assert.equal(manager.connections.size, 0, '假死连接必须被巡检剔除');
    assert.equal(conn1.closed, true, '剔除时必须显式关闭连接');

    // 4. 真实空列表（宿主确认页面全部关闭 → []）：必须清理全部连接
    discoverResult = [{ type: 'page', webSocketDebuggerUrl: URL_A }];
    await manager._performSync(1);
    const conn2 = manager.connections.get(URL_A);
    assert.ok(conn2 && conn2 !== conn1, '目标重现后必须新建连接');
    discoverResult = [];
    await manager._performSync(1);
    assert.equal(manager.connections.size, 0, '真实空列表必须清理全部连接');
    assert.equal(conn2.closed, true, '真实空列表清理时必须关闭连接');

    // 5. 恢复重连：发现成功后重建连接并重新注入
    discoverResult = [{ type: 'page', webSocketDebuggerUrl: URL_A }];
    await manager._performSync(1);
    const conn3 = manager.connections.get(URL_A);
    assert.ok(conn3, '恢复发现后必须重建连接');
    assert.notStrictEqual(conn3.ws, conn2.ws, '恢复重连必须使用全新 WebSocket 实例');
    assert.ok(
      conn3.ws.sent.some((m) => m.method === 'Runtime.evaluate' && String(m.params.expression).includes(WIDGET)),
      '恢复重连后必须重新注入 widget'
    );
  } finally {
    manager.stop();
    if (hadWebSocket) globalThis.WebSocket = origWebSocket;
    else delete globalThis.WebSocket;
  }
});

test('【行为级 3】在途请求追跑最新模型提示: 历史会话切换下拉框不 force，且新提示不被旧请求吞掉', async () => {
  let releaseFirstRpc = null;
  const firstRpcGate = new Promise((r) => { releaseFirstRpc = r; });
  const h = buildWidgetDomHarness({
    initialModelText: 'Model Alpha',
    getSnapshot: (input, callNo) => {
      if (callNo === 1) return firstRpcGate.then(() => OK_SNAPSHOT);
      return OK_SNAPSHOT;
    }
  });

  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(h.rpcRequests.length, 1, '挂载后首轮请求在途');
    assert.equal(h.rpcRequests[0].fallbackModel, 'Model Alpha', '首轮请求携带挂载时的模型提示');
    assert.equal(h.rpcRequests[0].force, undefined, '普通轮询不得携带 force');

    // 在首轮请求仍在途时切换模型，触发 MutationObserver 防抖后的即时同步
    h.setModelText('Model Beta');
    h.triggerMutation();
    await new Promise((r) => setTimeout(r, 160));

    assert.equal(h.rpcRequests.length, 1, '旧请求未完成前不得提前发出第二请求（合并去重）');

    releaseFirstRpc();
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(h.rpcRequests.length, 2, '旧请求完成后必须恰好追跑一次新提示请求');
    assert.equal(h.rpcRequests[1].fallbackModel, 'Model Beta', '追跑请求必须携带切换后的最新模型提示，绝不被旧提示吞掉');
    assert.equal(h.rpcRequests[1].force, undefined, '历史会话纯下拉切换绝不携带 force；force 仅保留给真实 agent 状态变化');
  } finally {
    h.cleanup();
  }
});

test('【行为级 6】isDraftView 三态区分: 识别失败不伪装 0%，确认草稿才显示 0%', async () => {
  // 场景 A：Fiber 已挂载但既非「0 步 0 回合」的确认草稿，也找不到 conversation-view。
  // 旧实现会把这种情况反推为草稿并渲染「新会话 0%」，属于数据可信度缺陷。
  const hA = buildWidgetDomHarness({
    initialModelText: 'GPT-OSS 120B',
    providerState: {},
    getSnapshot: () => OK_SNAPSHOT
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 30));

    const tipA = hA.getShadowText('tooltip-text');
    assert.equal(tipA, '无法识别当前会话，正在等待宿主加载', '识别失败必须渲染明确的未识别状态');
    assert.ok(!tipA.includes('新会话'), '识别失败绝不能伪装成新会话');
    assert.ok(!tipA.includes('0.0%'), '识别失败绝不能显示 0% 占用');
    assert.equal(hA.rpcRequests.length, 0, '识别失败期间不得发起任何会话请求');
  } finally {
    hA.cleanup();
  }

  // 场景 B：Fiber 明确报告 0 步、0 回合且无 CID —— 这是可确认的真草稿，仍应保留 0% 基准。
  const hB = buildWidgetDomHarness({
    initialModelText: 'GPT-OSS 120B',
    providerState: { conversationId: null, trajectorySlice: { totalStepsLength: 0 }, turns: [] },
    getSnapshot: () => OK_SNAPSHOT
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 30));

    const tipB = hB.getShadowText('tooltip-text');
    assert.equal(tipB, '新会话 · 0.0K / 80.0K 上下文未占用', '确认无疑的草稿态必须保留 0% 基准并跟随模型分母');
    assert.equal(hB.rpcRequests.length, 0, '草稿态不得发起任何会话请求');
  } finally {
    hB.cleanup();
  }
});

async function runManagedInstall(caseDir, configContent) {
  const targetDir = join(caseDir, 'plugin');
  const configFile = join(caseDir, 'config.json');
  await mkdir(caseDir, { recursive: true });
  if (configContent !== null) await writeFile(configFile, configContent, 'utf8');
  try {
    const { stdout } = await execFileAsync(process.execPath, [join(ROOT, 'manage.mjs'), 'install'], {
      env: { ...process.env, AGY_TEST_TARGET_DIR: targetDir, AGY_TEST_CONFIG_FILE: configFile }
    });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stderr: String(err.stderr || err.message) };
  }
}

test('【行为级 4】manage.mjs install 配置安全: 空白可初始化、损坏拒绝写入且逐字节保留、其他配置零丢失', async () => {
  const sandboxRoot = join(ROOT, 'dist', 'behavior_v1_2_sandbox');
  await rm(sandboxRoot, { recursive: true, force: true });
  await mkdir(sandboxRoot, { recursive: true });

  // 场景 1：配置不存在 → 初始化并启用
  const c1 = join(sandboxRoot, 'missing');
  let r = await runManagedInstall(c1, null);
  assert.equal(r.ok, true, `缺失配置时安装必须成功: ${r.stderr}`);
  const cfg1 = JSON.parse(await readFile(join(c1, 'config.json'), 'utf8'));
  assert.equal(cfg1.plugins['antigravity-context-ring'].enabled, true, '缺失配置安装后必须初始化并启用插件');

  // 场景 2：空白/纯空白字符配置 → 按初始化处理（不再抛 $null 异常）
  const c2 = join(sandboxRoot, 'blank');
  r = await runManagedInstall(c2, '   \n\t  ');
  assert.equal(r.ok, true, `空白配置必须按初始化处理: ${r.stderr}`);
  const cfg2 = JSON.parse(await readFile(join(c2, 'config.json'), 'utf8'));
  assert.equal(cfg2.plugins['antigravity-context-ring'].enabled, true, '空白配置安装后必须初始化并启用插件');

  // 场景 3：损坏 JSON → 安装明确失败，原文件逐字节保留
  const c3 = join(sandboxRoot, 'corrupt');
  const corruptRaw = '{ "plugins": {, oops broken';
  r = await runManagedInstall(c3, corruptRaw);
  assert.equal(r.ok, false, '损坏 JSON 必须让安装命令明确失败（非零退出）');
  assert.match(r.stderr, /合法 JSON|停止写入/, '失败信息必须指明已停止写入并保留原文件');
  const after3 = await readFile(join(c3, 'config.json'), 'utf8');
  assert.equal(after3, corruptRaw, '损坏配置必须逐字节原样保留，绝不能被静默重建覆盖');

  // 场景 4：既有其他插件与额外字段 → 安装后全部保留，仅翻转本插件 enabled
  const c4 = join(sandboxRoot, 'preserve');
  const existing = {
    coreTools: { telemetry: 'off' },
    plugins: {
      'other-plugin': { enabled: true, port: 8123 },
      'antigravity-context-ring': { enabled: false, note: 'user custom' }
    }
  };
  r = await runManagedInstall(c4, JSON.stringify(existing, null, 2));
  assert.equal(r.ok, true, `合法配置安装必须成功: ${r.stderr}`);
  const cfg4 = JSON.parse(await readFile(join(c4, 'config.json'), 'utf8'));
  assert.equal(cfg4.coreTools.telemetry, 'off', '顶层其他字段必须完整保留');
  assert.equal(cfg4.plugins['other-plugin'].port, 8123, '其他插件配置必须完整保留');
  assert.equal(cfg4.plugins['antigravity-context-ring'].note, 'user custom', '本插件对象内的额外字段必须保留');
  assert.equal(cfg4.plugins['antigravity-context-ring'].enabled, true, '安装后必须启用本插件');
});

test('【行为级 5】install.ps1 配置安全: 空白可初始化、损坏拒绝写入且逐字节保留、其他配置零丢失', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 环境下执行 PowerShell 安装脚本行为级验证');
    return;
  }

  const sandboxRoot = join(ROOT, 'dist', 'behavior_v1_2_ps_sandbox');
  await rm(sandboxRoot, { recursive: true, force: true });
  await mkdir(sandboxRoot, { recursive: true });

  const runPsInstall = async (caseDir, configContent) => {
    const targetDir = join(caseDir, 'plugin');
    const configFile = join(caseDir, 'config.json');
    await mkdir(caseDir, { recursive: true });
    if (configContent !== null) await writeFile(configFile, configContent, 'utf8');
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', join(ROOT, 'install.ps1')
      ], {
        env: { ...process.env, AGY_TEST_TARGET_DIR: targetDir, AGY_TEST_CONFIG_FILE: configFile }
      });
      return { ok: true, stdout };
    } catch (err) {
      return { ok: false, stderr: String(err.stderr || err.message) };
    }
  };

  // 场景 1：配置不存在 → 初始化并启用
  const c1 = join(sandboxRoot, 'missing');
  let r = await runPsInstall(c1, null);
  assert.equal(r.ok, true, `缺失配置时 PowerShell 安装必须成功: ${r.stderr}`);
  assert.match(r.stdout, /\[SUCCESS\]/);
  const cfg1 = JSON.parse(await readFile(join(c1, 'config.json'), 'utf8'));
  assert.equal(cfg1.plugins['antigravity-context-ring'].enabled, true, '缺失配置安装后必须初始化并启用插件');

  // 场景 2：空白配置 → 按初始化处理
  const c2 = join(sandboxRoot, 'blank');
  r = await runPsInstall(c2, '   \r\n  ');
  assert.equal(r.ok, true, `空白配置必须按初始化处理: ${r.stderr}`);
  const cfg2 = JSON.parse(await readFile(join(c2, 'config.json'), 'utf8'));
  assert.equal(cfg2.plugins['antigravity-context-ring'].enabled, true, '空白配置安装后必须初始化并启用插件');

  // 场景 3：损坏 JSON → 脚本抛错非零退出，原文件逐字节保留
  const c3 = join(sandboxRoot, 'corrupt');
  const corruptRaw = '{ "plugins": {, oops broken';
  r = await runPsInstall(c3, corruptRaw);
  assert.equal(r.ok, false, '损坏 JSON 必须让 PowerShell 安装显式失败');
  assert.match(r.stderr, /not valid JSON/, '失败信息必须明确指出 JSON 损坏且未修改原文件');
  const after3 = await readFile(join(c3, 'config.json'), 'utf8');
  assert.equal(after3, corruptRaw, '损坏配置必须逐字节原样保留');

  // 场景 4：既有其他插件与额外字段 → 全部保留，仅翻转本插件 enabled
  const c4 = join(sandboxRoot, 'preserve');
  const existing = {
    coreTools: { telemetry: 'off' },
    plugins: {
      'other-plugin': { enabled: true, port: 8123 },
      'antigravity-context-ring': { enabled: false, note: 'user custom' }
    }
  };
  r = await runPsInstall(c4, JSON.stringify(existing, null, 2));
  assert.equal(r.ok, true, `合法配置 PowerShell 安装必须成功: ${r.stderr}`);
  const cfg4 = JSON.parse(await readFile(join(c4, 'config.json'), 'utf8'));
  assert.equal(cfg4.coreTools.telemetry, 'off', '顶层其他字段必须完整保留');
  assert.equal(cfg4.plugins['other-plugin'].port, 8123, '其他插件配置必须完整保留');
  assert.equal(cfg4.plugins['antigravity-context-ring'].note, 'user custom', '本插件对象内的额外字段必须保留');
  assert.equal(cfg4.plugins['antigravity-context-ring'].enabled, true, '安装后必须启用本插件');
});
