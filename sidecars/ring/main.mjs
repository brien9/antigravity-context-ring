import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RuntimeBridgeManager } from './runtime-bridge.mjs';
import { discoverLanguageServer } from './ls-discovery.mjs';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 精准识别是否为本插件的 Sidecar 守护进程
 * 严格白名单三重校验：
 * 1. 必须是 node 可执行程序
 * 2. 专属标识完整匹配（完整参数边界，杜绝子串碰撞），且入口脚本为 main.mjs
 * 3. 或明确属于 antigravity-context-ring 插件目录下的 main.mjs
 * 4. 严格排除自身进程 ID
 */
export function isContextRingProcess(commandLine, processId = null, currentPid = process.pid, testTargetDir = process.env.AGY_TEST_TARGET_DIR) {
  if (!commandLine || typeof commandLine !== 'string') return false;
  if (processId !== null && Number(processId) === Number(currentPid)) return false;

  const cmd = commandLine.trim();
  const isNode = /(?:^|[\s"'\\\/])node(?:\.exe)?(?:["']|\s|$)/i.test(cmd);
  if (!isNode) return false;

  const normalizedCmd = cmd.replace(/\\/g, '/');

  if (testTargetDir && typeof testTargetDir === 'string' && testTargetDir.trim()) {
    const normalizedTarget = testTargetDir.trim().replace(/\\/g, '/').toLowerCase();
    if (!normalizedCmd.toLowerCase().includes(normalizedTarget)) {
      return false;
    }
  } else if (normalizedCmd.toLowerCase().includes('clean_test_sandbox')) {
    return false;
  }

  const hasRingMainScript = normalizedCmd.includes('sidecars/ring/main.mjs');
  const hasPluginDirMain = normalizedCmd.includes('antigravity-context-ring') && normalizedCmd.includes('main.mjs');
  const hasLocalMain = /(?:^|\s)["']?[^"']*\bmain\.mjs["']?(?:\s|$)/.test(normalizedCmd);

  // 1. 严格专属路径：明确属于 antigravity-context-ring 插件目录下的 main.mjs
  if (hasPluginDirMain) {
    return true;
  }

  // 2. 专属 Sidecar 参数完整独立匹配（杜绝子串碰撞如 --sidecar=antigravity-context-ring-fake）
  const hasExactSidecarFlag = /(?:^|\s)--sidecar=antigravity-context-ring(?:\s|$)/.test(cmd);
  if (hasExactSidecarFlag) {
    // 验证入口为 main.mjs 或 sidecars/ring/main.mjs
    if (hasRingMainScript || hasLocalMain) {
      return true;
    }
  }

  return false;
}

export async function cleanOrphanInstances() {
  const testTargetDir = (process.env.AGY_TEST_TARGET_DIR || '').trim();
  if (process.platform === 'win32') {
    try {
      const targetFilter = testTargetDir
        ? `$normTarget = '${testTargetDir.replace(/\\/g, '/').replace(/'/g, "''").toLowerCase()}'; if ($cmd.Replace('\\', '/').ToLower().IndexOf($normTarget) -lt 0) { return $false }; `
        : `if ($cmd.Replace('\\', '/').ToLower().IndexOf('clean_test_sandbox') -ge 0) { return $false }; `;
      // 严格白名单：进程必须是 node.exe；完整匹配 --sidecar=antigravity-context-ring 且为 main.mjs，或专属插件路径下的 main.mjs
      const psCmd = `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { ` +
        `$cmd = $_.CommandLine; ` +
        `if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }; ` +
        targetFilter +
        `$hasFlag = ($cmd -match '(?:^|\\s)--sidecar=antigravity-context-ring(?:\\s|$)'); ` +
        `$hasPath = ($cmd -match 'antigravity-context-ring' -and $cmd -match 'main\\.mjs'); ` +
        `$hasRingMain = ($cmd -match 'sidecars[\\\\/]ring[\\\\/]main\\.mjs' -or $cmd -match 'main\\.mjs'); ` +
        `(($hasFlag -and $hasRingMain) -or $hasPath) -and ($_.ProcessId -ne ${process.pid}) ` +
        `} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd]);
    } catch {}
  } else {
    try {
      const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 5000 });
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (match) {
          const pid = parseInt(match[1], 10);
          const cmd = match[2];
          if (isContextRingProcess(cmd, pid, process.pid, testTargetDir)) {
            try { process.kill(pid, 'SIGTERM'); } catch {}
          }
        }
      }
    } catch {}
  }
}

export async function scanHostPids() {
  if (process.env.AGY_HOST_PID) {
    const pid = parseInt(process.env.AGY_HOST_PID, 10);
    if (Number.isInteger(pid) && pid > 0) return new Set([pid]);
  }
  if (process.platform === 'win32') {
    try {
      const psCmd = `Get-Process antigravity -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`;
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', psCmd]);
      const pids = stdout.trim().split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
      return new Set(pids);
    } catch {}
  } else {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-i', 'antigravity'], { encoding: 'utf8', timeout: 3000 });
      const pids = stdout.trim().split(/\s+/).map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
      return new Set(pids);
    } catch {}
  }
  return new Set();
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function startHostWatchdog(shutdown) {
  let localHostPids = new Set();
  let localDeadChecks = 0;
  let localHostEverDiscovered = false;
  let watchdogBusy = false;
  let timer = null;

  const isTimerStopped = () => !timer || Boolean(timer._destroyed);

  scanHostPids().then(pids => {
    if (isTimerStopped()) return;
    localHostPids = pids;
    if (localHostPids.size > 0) {
      localHostEverDiscovered = true;
      console.log(`[ContextRing] Bound to Antigravity host (PIDs: ${Array.from(localHostPids).join(', ')})`);
    }
  }).catch(() => {});

  timer = setInterval(async () => {
    if (watchdogBusy) return;
    if (isTimerStopped()) return;
    watchdogBusy = true;

    try {
      let alive = false;
      for (const pid of localHostPids) {
        if (isPidAlive(pid)) {
          alive = true;
          break;
        }
      }

      if (!alive) {
        const freshPids = await scanHostPids();
        if (isTimerStopped()) return;
        if (freshPids.size === 0) {
          // 非 Windows 平台或未发现有效宿主时的空 PID 自杀防御：
          // 若从未探测到有效宿主 PID（如未注入 AGY_HOST_PID 且平台无 antigravity 进程），不触发退出
          if (!localHostEverDiscovered) {
            return;
          }
          localDeadChecks++;
          if (localDeadChecks >= 2) {
            console.log('[ContextRing] Antigravity host terminated. Sidecar exiting.');
            clearInterval(timer);
            shutdown();
          }
        } else {
          localHostPids = freshPids;
          localHostEverDiscovered = true;
          localDeadChecks = 0;
        }
      } else {
        localDeadChecks = 0;
      }
    } finally {
      watchdogBusy = false;
    }
  }, 2500);

  return timer;
}

async function main() {
  const rootDir = join(__dirname, '..', '..');
  const widgetFile = join(rootDir, 'assets', 'ring-widget.cjs');

  let rawWidget = await readFile(widgetFile, 'utf8');
  const widgetCode = rawWidget.trim();

  // 冷启动零阻塞：后台异步执行 Language Server 预发现与历史孤儿进程清理，不阻塞首屏 CDP 注入
  const bgBootstrapPromise = discoverLanguageServer(false)
    .catch(() => null)
    .finally(() => cleanOrphanInstances().catch(() => {}));

  // 启动轻量存活服务（响应 Antigravity 宿主平台分配的 Sidecar Web 端口健康检查）
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Antigravity Context Ring Active');
  });

  const sidecarPort = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) || 0;
  let listenRetried = false;
  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE' && !listenRetried) {
      listenRetried = true;
      await cleanOrphanInstances().catch(() => {});
      setTimeout(() => {
        try { server.listen(sidecarPort, '127.0.0.1'); } catch {}
      }, 200);
    }
  });
  server.listen(sidecarPort, '127.0.0.1', () => {
    const bound = server.address()?.port;
    console.log(`[ContextRing] Sidecar heartbeat server listening on 127.0.0.1:${bound}`);
  });

  // 计算 Antigravity profile 目录（测试沙箱模式下严格隔离，避免抢占宿主真实 CDP 连接）
  let profileDir;
  if (process.env.AGY_TEST_TARGET_DIR) {
    profileDir = join(process.env.AGY_TEST_TARGET_DIR, '__isolated_profile__');
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(process.env.USERPROFILE || 'C:\\Users\\default', 'AppData', 'Roaming');
    profileDir = join(appData, 'Antigravity');
  } else if (process.platform === 'darwin') {
    profileDir = join(process.env.HOME || '', 'Library', 'Application Support', 'Antigravity');
  } else {
    profileDir = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || '', '.config'), 'Antigravity');
  }

  const manager = new RuntimeBridgeManager(profileDir, widgetCode);
  manager.start();

  let watchdog = null;
  const shutdown = () => {
    if (watchdog) clearInterval(watchdog);
    manager.stop();
    server.close();
    process.exit(0);
  };

  watchdog = startHostWatchdog(shutdown);
  void bgBootstrapPromise;

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

import { realpathSync } from 'node:fs';

const isDirectRun = Boolean(process.argv[1]) && (() => {
  try {
    const entryPath = realpathSync(process.argv[1]);
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    return entryPath === modulePath;
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error('[ContextRing] Fatal error:', err);
    process.exit(1);
  });
}
