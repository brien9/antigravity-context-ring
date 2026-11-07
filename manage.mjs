import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanOrphanInstances, scanHostPids, isContextRingProcess } from './sidecars/ring/main.mjs';
import { discoverLanguageServer } from './sidecars/ring/ls-discovery.mjs';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const SOURCE = dirname(__filename);

const HOME = process.env.USERPROFILE || process.env.HOME || homedir() || 'C:\\Users\\default';
const PLUGINS_DIR = join(HOME, '.gemini', 'config', 'plugins');
const TARGET_DIR = process.env.AGY_TEST_TARGET_DIR || join(PLUGINS_DIR, 'antigravity-context-ring');
const CONFIG_FILE = process.env.AGY_TEST_CONFIG_FILE || join(HOME, '.gemini', 'config', 'config.json');

async function readJson(file, fallback = {}) {
  try {
    const text = await readFile(file, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function install() {
  console.log('[0/4] 正在安全清理历史残留 Sidecar 孤儿进程...');
  await cleanOrphanInstances().catch(() => {});

  console.log('[1/4] 正在准备插件目标目录...');
  await mkdir(dirname(TARGET_DIR), { recursive: true });
  await mkdir(TARGET_DIR, { recursive: true });

  console.log('[2/4] 正在复制运行时模块...');
  for (const item of ['assets', 'sidecars', 'plugin.json']) {
    const src = join(SOURCE, item);
    const dst = join(TARGET_DIR, item);
    await cp(src, dst, { recursive: true, force: true });
  }

  console.log('[3/4] 正在配置 config.json...');
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  const config = await readJson(CONFIG_FILE, {});
  if (!config.plugins) config.plugins = {};
  config.plugins['antigravity-context-ring'] = { enabled: true };
  await writeJson(CONFIG_FILE, config);

  const hostPids = await scanHostPids().catch(() => new Set());
  if (hostPids.size > 0 && !process.env.AGY_TEST_TARGET_DIR) {
    console.log('[4/4] 检测到 Antigravity 正在运行，正在后台拉起 Sidecar 守护进程...');
    const mainScript = join(TARGET_DIR, 'sidecars', 'ring', 'main.mjs');
    let startedViaWmi = false;
    if (process.platform === 'win32') {
      try {
        const wmiCmdLine = `"${process.execPath}" "${mainScript}" --sidecar=antigravity-context-ring`;
        const psSpawn = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${wmiCmdLine.replace(/'/g, "''")}'; ProcessStartupInformation=$si}; if ($res.ReturnValue -ne 0) { throw 'WMI create failed' }`;
        await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psSpawn]);
        startedViaWmi = true;
      } catch {}
    }
    if (!startedViaWmi) {
      const child = spawn(process.execPath, [mainScript, '--sidecar=antigravity-context-ring'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    }
  }

  console.log(`\n[SUCCESS] 安装成功！插件路径: ${TARGET_DIR}`);
  console.log('若 Antigravity 已在运行，圆环将在数秒内自动挂载；否则重新打开客户端即可生效。');
}

async function uninstall() {
  console.log('[0/2] 正在安全终止运行中的 Sidecar 进程...');
  await cleanOrphanInstances().catch(() => {});

  console.log('[1/2] 正在禁用插件配置...');
  if (existsSync(CONFIG_FILE)) {
    const config = await readJson(CONFIG_FILE, {});
    if (config.plugins && config.plugins['antigravity-context-ring']) {
      config.plugins['antigravity-context-ring'].enabled = false;
      await writeJson(CONFIG_FILE, config);
    }
  }
  await new Promise(r => setTimeout(r, 600));

  console.log('[2/2] 正在清理插件文件...');
  if (existsSync(TARGET_DIR)) {
    for (let i = 0; i < 5; i++) {
      try {
        await rm(TARGET_DIR, { recursive: true, force: true });
        break;
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  console.log('[SUCCESS] 卸载完成！重启 Antigravity 后界面即可恢复默认状态。');
}

async function findRunningSidecarPids() {
  const pids = [];
  const testTargetDir = (process.env.AGY_TEST_TARGET_DIR || '').trim();
  if (process.platform === 'win32') {
    try {
      const targetFilter = testTargetDir
        ? `$normTarget = '${testTargetDir.replace(/\\/g, '/').replace(/'/g, "''").toLowerCase()}'; if ($cmd.Replace('\\', '/').ToLower().IndexOf($normTarget) -lt 0) { return $false }; `
        : `if ($cmd.Replace('\\', '/').ToLower().IndexOf('clean_test_sandbox') -ge 0) { return $false }; `;
      const psCmd = `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { ` +
        `$cmd = $_.CommandLine; ` +
        `if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }; ` +
        targetFilter +
        `$hasFlag = ($cmd -match '(?:^|\\s)--sidecar=antigravity-context-ring(?:\\s|$)'); ` +
        `$hasPath = ($cmd -match 'antigravity-context-ring' -and $cmd -match 'main\\.mjs'); ` +
        `$hasRingMain = ($cmd -match 'sidecars[\\\\/]ring[\\\\/]main\\.mjs' -or $cmd -match 'main\\.mjs'); ` +
        `(($hasFlag -and $hasRingMain) -or $hasPath) -and ($_.ProcessId -ne ${process.pid}) ` +
        `} | Select-Object -ExpandProperty ProcessId`;
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd]);
      for (const line of stdout.split(/\r?\n/)) {
        const pid = parseInt(line.trim(), 10);
        if (Number.isInteger(pid) && pid > 0) pids.push(pid);
      }
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
            pids.push(pid);
          }
        }
      }
    } catch {}
  }
  return pids;
}

async function status() {
  console.log('==========================================');
  console.log('   Antigravity Context Ring Status        ');
  console.log('==========================================');

  const dirExists = existsSync(TARGET_DIR);
  const pluginJsonExists = existsSync(join(TARGET_DIR, 'plugin.json'));
  const mainExists = existsSync(join(TARGET_DIR, 'sidecars', 'ring', 'main.mjs'));
  const widgetExists = existsSync(join(TARGET_DIR, 'assets', 'ring-widget.cjs'));
  const filesHealthy = dirExists && pluginJsonExists && mainExists && widgetExists;

  const config = existsSync(CONFIG_FILE) ? await readJson(CONFIG_FILE, {}) : {};
  const enabled = Boolean(config?.plugins?.['antigravity-context-ring']?.enabled);

  const hostPids = await scanHostPids().catch(() => new Set());
  const sidecarPids = await findRunningSidecarPids();
  const lsInfo = await discoverLanguageServer(false).catch(() => null);

  console.log(`插件目录: ${TARGET_DIR} (${filesHealthy ? '已部署且完整' : '未部署或缺失文件'})`);
  console.log(`配置状态: ${enabled ? '已启用 (enabled: true)' : '未启用'} (${CONFIG_FILE})`);
  console.log(`宿主进程: ${hostPids.size > 0 ? `运行中 (PIDs: ${Array.from(hostPids).join(', ')})` : '未检测到运行中的 Antigravity'}`);
  console.log(`守护进程: ${sidecarPids.length > 0 ? `运行中 (PIDs: ${sidecarPids.join(', ')})` : '未运行'}`);
  console.log(`语言服务: ${lsInfo ? `已连接 (127.0.0.1:${lsInfo.port}, PID: ${lsInfo.pid}, TLS: ${lsInfo.useTls})` : '未发现活跃 Language Server'}`);
  console.log('------------------------------------------');
}

async function ensurePs1Utf8Bom(filePath) {
  if (!existsSync(filePath)) return;
  const raw = await readFile(filePath, 'utf8');
  if (!raw.startsWith('\uFEFF')) {
    await writeFile(filePath, '\uFEFF' + raw, 'utf8');
  }
}

async function packageZip() {
  const distDir = join(SOURCE, 'dist');
  await mkdir(distDir, { recursive: true });
  const pluginInfo = await readJson(join(SOURCE, 'plugin.json'), { version: '1.1.0' });
  const zipPath = join(distDir, `antigravity-context-ring-v${pluginInfo.version}.zip`);

  if (existsSync(zipPath)) {
    await rm(zipPath, { force: true });
  }

  // 确保源码中的 PowerShell 脚本携带 UTF-8 BOM（兼容 Windows PowerShell 5.1）
  await ensurePs1Utf8Bom(join(SOURCE, 'install.ps1'));
  await ensurePs1Utf8Bom(join(SOURCE, 'uninstall.ps1'));

  // 临时准备打包目录结构
  const stageRoot = join(distDir, 'stage');
  const stageDir = join(stageRoot, 'antigravity-context-ring');
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  for (const item of ['assets', 'sidecars', 'plugin.json', 'install.ps1', 'uninstall.ps1', 'install.sh', 'uninstall.sh', 'manage.mjs', 'README.md']) {
    const p = join(SOURCE, item);
    if (existsSync(p)) {
      await cp(p, join(stageDir, item), { recursive: true });
    }
  }

  await ensurePs1Utf8Bom(join(stageDir, 'install.ps1'));
  await ensurePs1Utf8Bom(join(stageDir, 'uninstall.ps1'));

  console.log('正在生成独立安装包...');
  if (process.platform === 'win32') {
    const psCmd = `Compress-Archive -Path "${stageDir}" -DestinationPath "${zipPath}" -Force`;
    await execFileAsync('powershell', ['-NoProfile', '-Command', psCmd]);
  } else {
    await execFileAsync('zip', ['-r', '-q', zipPath, 'antigravity-context-ring'], { cwd: stageRoot });
  }
  await rm(stageRoot, { recursive: true, force: true });

  console.log(`打包成功！压缩包已生成至:\n${zipPath}`);
}

const action = process.argv[2];
if (action === 'install') {
  install();
} else if (action === 'uninstall') {
  uninstall();
} else if (action === 'status') {
  status();
} else if (action === 'package') {
  packageZip();
} else {
  console.log('用法: node manage.mjs [install | uninstall | status | package]');
}
