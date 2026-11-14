import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isInjectablePageTarget, CdpConnection, RuntimeBridgeManager } from '../sidecars/ring/runtime-bridge.mjs';
import { parseEnvLanguageServer, probeEnvLanguageServer } from '../sidecars/ring/ls-discovery.mjs';
import { isAntigravityHostCommandLine } from '../sidecars/ring/main.mjs';
import { writeJson, isPluginEnabledInConfig } from '../manage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

describe('v1.1.2 守护进程韧性、热更新兼容与自适应架构回归套件 (R1~R6)', () => {
  test('R1: isInjectablePageTarget 精准过滤 data:text/html 启动 Splash 页与内部页面，放行真实工作台窗口', () => {
    // 真实采样的 Antigravity v2.32.1 冷启动过渡页 1：暗色背景占位页
    const darkSplashTarget = {
      id: 'splash-1',
      type: 'page',
      title: 'data:text/html;charset=utf-8,%3C!DOCTYPE%20html%3E...',
      url: 'data:text/html;charset=utf-8,%3C!DOCTYPE%20html%3E%3Chtml%3E%3Cbody%20style%3D%22background%3A%23131010%22%3E%3C%2Fbody%3E%3C%2Fhtml%3E',
      webSocketDebuggerUrl: 'ws://127.0.0.1:8925/devtools/page/splash-1'
    };

    // 真实采样的 Antigravity v2.32.1 冷启动过渡页 2：脉冲 Logo 加载页
    const logoSplashTarget = {
      id: 'splash-2',
      type: 'page',
      title: 'Antigravity Loading',
      url: 'data:text/html;charset=utf-8,%3C!DOCTYPE%20html%3E%3Cstyle%3E%40keyframes%20pulse%7B%7D%3C%2Fstyle%3E',
      webSocketDebuggerUrl: 'ws://127.0.0.1:8925/devtools/page/splash-2'
    };

    // 其他非工作台内部 Target
    const blankTarget = { type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:8925/devtools/page/blank' };
    const devtoolsTarget = { type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://127.0.0.1:8925/devtools/page/dt' };
    const extTarget = { type: 'page', url: 'chrome-extension://abcdef/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:8925/devtools/page/ext' };
    const pluginTarget = { type: 'page', url: 'plugin://ui-panel/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:8925/devtools/page/plg' };
    const workerTarget = { type: 'service_worker', url: 'https://127.0.0.1:8927/sw.js', webSocketDebuggerUrl: 'ws://127.0.0.1:8925/devtools/page/sw' };

    assert.equal(isInjectablePageTarget(darkSplashTarget), false, '应过滤暗色背景 data: 占位页');
    assert.equal(isInjectablePageTarget(logoSplashTarget), false, '应过滤脉冲 Logo data: 过渡页');
    assert.equal(isInjectablePageTarget(blankTarget), false, '应过滤 about:blank');
    assert.equal(isInjectablePageTarget(devtoolsTarget), false, '应过滤 devtools://');
    assert.equal(isInjectablePageTarget(extTarget), false, '应过滤 chrome-extension://');
    assert.equal(isInjectablePageTarget(pluginTarget), false, '应过滤 plugin://');
    assert.equal(isInjectablePageTarget(workerTarget), false, '应过滤非 page 类型 Target');

    // 真实工作台主窗口与 Swarm 独立窗口
    const mainWorkbenchTarget = {
      id: 'main-1',
      type: 'page',
      title: 'Antigravity - agy_context_ring',
      url: 'https://127.0.0.1:8927/?project=e%3A%5Cagy_context_ring',
      webSocketDebuggerUrl: 'ws://127.0.0.1:8925/devtools/page/main-1'
    };
    const mockLegacyTargetWithoutUrl = {
      type: 'page',
      webSocketDebuggerUrl: 'ws://127.0.0.1:8925/devtools/page/mock-1'
    };

    assert.equal(isInjectablePageTarget(mainWorkbenchTarget), true, '应放行真实 https://127.0.0.1 工作台主窗口');
    assert.equal(isInjectablePageTarget(mockLegacyTargetWithoutUrl), true, '应兼容未携带 url 字段的测试 Mock Target');
  });

  test('R1 & R2: RuntimeBridgeManager 忽略 data: 占位页保持 500ms 快频冷启动，并在收到 Runtime.executionContextCreated 时立即重注入', async () => {
    const origWebSocket = globalThis.WebSocket;
    const socketsByUrl = new Map();
    let evaluateWidgetCount = 0;
    let ringInstalledInPage = false;

    class MockWebSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.listeners = { open: [], message: [], close: [], error: [] };
        socketsByUrl.set(url, this);
        setTimeout(() => {
          this.readyState = 1;
          for (const fn of this.listeners.open) fn({});
        }, 5);
      }
      addEventListener(type, fn) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(fn);
      }
      send(raw) {
        const msg = JSON.parse(raw);
        setTimeout(() => {
          if (this.readyState !== 1) return;
          if (msg.method === 'Runtime.evaluate') {
            const expr = String(msg.params?.expression || '');
            if (expr.includes('window.__agContextRingInstalled && window.__agContextRingHost')) {
              this._emitMessage({ id: msg.id, result: { result: { value: ringInstalledInPage } } });
              return;
            }
            if (expr.includes('installAgContextRingWidget')) {
              evaluateWidgetCount++;
              ringInstalledInPage = true;
            }
          }
          this._emitMessage({ id: msg.id, result: {} });
        }, 2);
      }
      _emitMessage(payload) {
        const data = JSON.stringify(payload);
        for (const fn of this.listeners.message) fn({ data });
      }
      close() {
        this.readyState = 3;
        for (const fn of this.listeners.close) fn({});
      }
    }

    globalThis.WebSocket = MockWebSocket;
    let discoveryCallCount = 0;
    let mainTargetReady = false;

    const manager = new RuntimeBridgeManager('/mock-profile', 'function installAgContextRingWidget(){}', {
      discoverTargets: async () => {
        discoveryCallCount++;
        const list = [
          {
            type: 'page',
            url: 'data:text/html;charset=utf-8,splash',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/page/splash'
          }
        ];
        if (mainTargetReady) {
          list.push({
            type: 'page',
            url: 'https://127.0.0.1:8927/?project=test',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/page/main'
          });
        }
        return list;
      }
    });

    try {
      manager.start();
      await new Promise(r => setTimeout(r, 40));

      // 首拍仅有 data: Splash 页，不应建立任何连接，且 bootstrapTimer 必须保持存活
      assert.equal(manager.connections.size, 0, '仅存在 data: 过渡页时不应建立连接');
      assert.notEqual(manager.bootstrapTimer, null, '真实窗口未就绪前 500ms bootstrapTimer 必须持续存活');

      // 模拟第 150ms 时真实主窗口就绪，验证 500ms bootstrapTimer 能自动捕获并注入（无需等待 3000ms）
      mainTargetReady = true;
      await new Promise(r => setTimeout(r, 550));

      assert.equal(manager.connections.has('ws://127.0.0.1:9999/devtools/page/main'), true, '500ms 快频探测器应迅速捕获并连接真实主窗口');
      assert.equal(evaluateWidgetCount, 1, '真实主窗口应完成首次 Widget 注入');

      // R2: 模拟宿主窗口重载，页面上下文被清空并由 CDP 推送 Runtime.executionContextCreated
      ringInstalledInPage = false;
      const ws = socketsByUrl.get('ws://127.0.0.1:9999/devtools/page/main');
      assert.ok(ws, '主窗口 WebSocket 实例应存在');

      ws._emitMessage({
        method: 'Runtime.executionContextCreated',
        params: {
          context: {
            id: 2,
            auxData: { isDefault: true }
          }
        }
      });

      await new Promise(r => setTimeout(r, 60));
      assert.equal(evaluateWidgetCount, 2, '收到 Runtime.executionContextCreated 事件后应在数十毫秒内立即完成重注入，无需干等 3000ms');
      assert.equal(ringInstalledInPage, true);
    } finally {
      manager.stop();
      globalThis.WebSocket = origWebSocket;
    }
  });

  test('R3: parseEnvLanguageServer 与 probeEnvLanguageServer 支持环境变量毫秒级直连探活', async () => {
    // 1. 解析器单测
    assert.equal(parseEnvLanguageServer({}), null);
    assert.equal(parseEnvLanguageServer({ ANTIGRAVITY_LS_ADDRESS: 'localhost:8928' }), null, '缺少 token 应返回 null');

    const parsed1 = parseEnvLanguageServer({
      ANTIGRAVITY_LS_ADDRESS: 'localhost:8928',
      ANTIGRAVITY_CSRF_TOKEN: 'test-csrf-token-1234567890',
      ANTIGRAVITY_LS_PID: '43210'
    });
    assert.deepEqual(parsed1, {
      pid: 43210,
      port: 8928,
      csrfToken: 'test-csrf-token-1234567890'
    });

    const parsed2 = parseEnvLanguageServer({
      ANTIGRAVITY_LS_ADDRESS: 'http://127.0.0.1:18928/',
      ANTIGRAVITY_CSRF_TOKEN: 'token-abc'
    });
    assert.equal(parsed2?.port, 18928);
    assert.equal(parsed2?.csrfToken, 'token-abc');

    // 2. 真实本地 HTTP Connect-RPC 探活验证
    const expectedToken = 'env-fastpath-csrf-token-999';
    const mockLsServer = createServer((req, res) => {
      if (
        req.method === 'POST' &&
        req.url === '/exa.language_server_pb.LanguageServerService/GetUnleashData' &&
        req.headers['x-codeium-csrf-token'] === expectedToken
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(403);
        res.end();
      }
    });

    await new Promise(resolve => mockLsServer.listen(0, '127.0.0.1', resolve));
    const port = mockLsServer.address().port;

    try {
      const okResult = await probeEnvLanguageServer({
        ANTIGRAVITY_LS_ADDRESS: `localhost:${port}`,
        ANTIGRAVITY_CSRF_TOKEN: expectedToken,
        ANTIGRAVITY_LS_PID: '54321'
      }, 500);

      assert.deepEqual(okResult, {
        pid: 54321,
        port,
        csrfToken: expectedToken,
        useTls: false
      });

      const badTokenResult = await probeEnvLanguageServer({
        ANTIGRAVITY_LS_ADDRESS: `localhost:${port}`,
        ANTIGRAVITY_CSRF_TOKEN: 'wrong-token'
      }, 300);
      assert.equal(badTokenResult, null, 'Token 不匹配时应安全返回 null');
    } finally {
      await new Promise(resolve => mockLsServer.close(resolve));
    }
  });

  test('R5: isAntigravityHostCommandLine 与 scanHostPids 免疫 swarm_board 等无界面 Sidecar 孤儿进程', () => {
    const swarmSidecarCmd = `"C:\\Users\\knori\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --import=file:///C:/Users/knori/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js "C:\\Users\\knori\\.gemini\\antigravity\\builtin\\plugins\\swarm_board\\sidecars\\board\\main.mjs"`;
    const ringSidecarCmd = `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\knori\\.gemini\\config\\plugins\\antigravity-context-ring\\sidecars\\ring\\main.mjs" --sidecar=antigravity-context-ring`;
    const realGuiHostCmd = `"C:\\Users\\knori\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --enable-features=Vulkan`;

    assert.equal(isAntigravityHostCommandLine(swarmSidecarCmd, 1001, 9999), false, '应排除 swarm_board sidecar 进程');
    assert.equal(isAntigravityHostCommandLine(ringSidecarCmd, 1002, 9999), false, '应排除 context-ring sidecar 进程');
    assert.equal(isAntigravityHostCommandLine(realGuiHostCmd, 1003, 9999), true, '应保留真实 Antigravity GUI 宿主进程');
    assert.equal(isAntigravityHostCommandLine(realGuiHostCmd, 9999, 9999), false, '应排除当前进程自身 PID');

    const mainSource = readFileSync(join(ROOT, 'sidecars', 'ring', 'main.mjs'), 'utf8');
    assert.ok(
      mainSource.includes('MainWindowHandle -ne 0'),
      'Windows Get-Process 降级分支必须校验 MainWindowHandle -ne 0 以过滤无界面 Sidecar 孤儿'
    );
  });

  test('R6: plugin.json 双字段兼容 (displayName + display_name) 且 manage.mjs 支持原子写入与 opt-out 默认启用判定', async () => {
    const pluginRaw = readFileSync(join(ROOT, 'plugin.json'), 'utf8');
    assert.equal(pluginRaw.startsWith('\uFEFF'), false, 'plugin.json 严禁包含 UTF-8 BOM');
    const pluginManifest = JSON.parse(pluginRaw);
    assert.equal(pluginManifest.name, 'antigravity-context-ring');
    assert.equal(pluginManifest.displayName, 'Antigravity 上下文监控圆环');
    assert.equal(pluginManifest.display_name, 'Antigravity 上下文监控圆环');

    // 验证 isPluginEnabledInConfig 的显式与默认启用（opt-out）语义
    assert.equal(isPluginEnabledInConfig({ plugins: { 'antigravity-context-ring': { enabled: true } } }, false), true);
    assert.equal(isPluginEnabledInConfig({ plugins: { 'antigravity-context-ring': { enabled: false } } }, true), false);
    assert.equal(isPluginEnabledInConfig({ plugins: {} }, true), true, '文件完整部署且未显式禁用时应遵循 opt-out 默认启用');
    assert.equal(isPluginEnabledInConfig({ plugins: {} }, false), false, '文件未部署且未显式配置时应判定为未启用');

    // 验证 writeJson 原子写入且不遗留 .tmp 临时文件
    const tmpDir = await mkdtemp(join(tmpdir(), 'agy-ring-atomic-'));
    try {
      const targetConfig = join(tmpDir, 'config.json');
      const payload = {
        plugins: { 'antigravity-context-ring': { enabled: true } },
        sidecars: { 'antigravity-context-ring': { restart_policy: 'always' } },
        userSettings: { theme: 'dark' }
      };
      await writeJson(targetConfig, payload);

      const writtenRaw = await readFile(targetConfig, 'utf8');
      assert.equal(writtenRaw.startsWith('\uFEFF'), false, 'writeJson 写入的配置文件不应包含 BOM');
      assert.deepEqual(JSON.parse(writtenRaw), payload);

      const filesInDir = await readdir(tmpDir);
      assert.deepEqual(filesInDir, ['config.json'], '原子写入完成后目录下不应残留任何 .tmp 临时文件');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
