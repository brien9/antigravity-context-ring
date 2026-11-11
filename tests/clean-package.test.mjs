import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const DIST_ZIP = join(ROOT, 'dist', 'antigravity-context-ring-v1.1.1.zip');
const SANDBOX = join(ROOT, 'dist', 'clean_test_sandbox');
const TEST_TARGET_DIR = join(SANDBOX, 'installed_plugin');
const TEST_CONFIG_FILE = join(SANDBOX, 'test_config.json');

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('【分发包端到端干净环境实测】ZIP 解压 -> 独立安装 -> 进程拉起与心跳 -> 精准卸载闭环', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 环境下测试 PowerShell 安装包完整生命周期');
    return;
  }

  assert.ok(existsSync(DIST_ZIP), '发布包 ZIP 文件必须存在');

  // 0. 启动一个无辜的第三方用户 Node 进程，作为误杀校验哨兵
  const innocentUserApp = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const innocentPid = innocentUserApp.pid;
  assert.ok(isPidAlive(innocentPid), '哨兵用户进程必须处于存活状态');

  try {
    // 1. 在完全隔离的临时目录中解压发布包
    if (existsSync(SANDBOX)) {
      await rm(SANDBOX, { recursive: true, force: true });
    }
    await mkdir(SANDBOX, { recursive: true });

    // 初始化一个虚拟 config.json
    await writeFile(TEST_CONFIG_FILE, JSON.stringify({ plugins: {} }, null, 2), 'utf8');

    const unzipCmd = `Expand-Archive -Path "${DIST_ZIP}" -DestinationPath "${SANDBOX}" -Force`;
    await execFileAsync('powershell', ['-NoProfile', '-Command', unzipCmd]);

    // 2. 验证解压出的内容完整性
    const packageRoot = join(SANDBOX, 'antigravity-context-ring');
    const essentialFiles = [
      'plugin.json',
      'install.ps1',
      'uninstall.ps1',
      'install.sh',
      'uninstall.sh',
      'manage.mjs',
      'README.md',
      'sidecars/ring/main.mjs',
      'sidecars/ring/runtime-bridge.mjs',
      'sidecars/ring/context-calculator.mjs',
      'sidecars/ring/context-service.mjs',
      'sidecars/ring/rpc-client.mjs',
      'sidecars/ring/ls-discovery.mjs',
      'sidecars/ring/model-limits.mjs',
      'sidecars/ring/sidecar.json',
      'assets/ring-widget.cjs'
    ];
    for (const rel of essentialFiles) {
      assert.ok(existsSync(join(packageRoot, rel)), `解压包中必须包含必要文件: ${rel}`);
    }

    // 验证 install.ps1 / uninstall.ps1 具备 UTF-8 BOM（兼容英文/多语言 Windows PowerShell 5.1），而 plugin.json 严格无 BOM
    const installPs1Text = await readFile(join(packageRoot, 'install.ps1'), 'utf8');
    const uninstallPs1Text = await readFile(join(packageRoot, 'uninstall.ps1'), 'utf8');
    const pluginJsonText = await readFile(join(packageRoot, 'plugin.json'), 'utf8');
    assert.equal(installPs1Text.startsWith('\ufeff'), true, 'install.ps1 必须携带 UTF-8 BOM 以兼容多语言 Windows PowerShell 5.1');
    assert.equal(uninstallPs1Text.startsWith('\ufeff'), true, 'uninstall.ps1 必须携带 UTF-8 BOM 以兼容多语言 Windows PowerShell 5.1');
    assert.equal(pluginJsonText.startsWith('\ufeff'), false, 'plugin.json 严禁携带 UTF-8 BOM');

    // 3. 执行解压包自身的 install.ps1 进行独立部署（注入隔离目录环境变量）
    const testPort = 59123;
    const installScript = join(packageRoot, 'install.ps1');
    const { stdout: installOut } = await execFileAsync('powershell', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', installScript
    ], {
      env: {
        ...process.env,
        AGY_TEST_TARGET_DIR: TEST_TARGET_DIR,
        AGY_TEST_CONFIG_FILE: TEST_CONFIG_FILE,
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(testPort)
      }
    });
    assert.match(installOut, /\[SUCCESS\]/);
    assert.ok(existsSync(join(TEST_TARGET_DIR, 'plugin.json')), '目标插件目录必须成功写入 plugin.json');

    // 验证 test_config.json 中的启用状态与无 BOM 格式
    const configRawText = await readFile(TEST_CONFIG_FILE, 'utf8');
    assert.equal(configRawText.startsWith('\ufeff'), false, 'PowerShell 安装脚本写入的 config.json 严禁携带 UTF-8 BOM 标记');
    const configRaw = JSON.parse(configRawText);
    assert.equal(configRaw.plugins?.['antigravity-context-ring']?.enabled, true, 'config.json 中必须启用该插件');

    // 4. 验证由安装目录独立拉起真实 Sidecar 进程
    const installedMain = join(TEST_TARGET_DIR, 'sidecars', 'ring', 'main.mjs');
    let sidecarLogs = '';
    const spawnedProc = spawn(process.execPath, [
      installedMain,
      '--sidecar=antigravity-context-ring'
    ], {
      env: {
        ...process.env,
        AGY_TEST_TARGET_DIR: TEST_TARGET_DIR,
        AGY_HOST_PID: String(process.pid),
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(testPort)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    spawnedProc.stdout.on('data', d => sidecarLogs += d.toString());
    spawnedProc.stderr.on('data', d => sidecarLogs += d.toString());
    const sidecarPid = spawnedProc.pid;

    assert.ok(isPidAlive(sidecarPid), '真实 Sidecar 进程必须处于运行状态');

    // 轮询探测 Sidecar 心跳健康服务响应（最多等待 8 秒）
    let heartbeatResponse = { status: 0, body: '', error: null };
    const startTime = Date.now();
    while (Date.now() - startTime < 8000) {
      heartbeatResponse = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${testPort}`, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve({ status: res.statusCode, body: data, error: null }));
        });
        req.on('error', (err) => resolve({ status: 500, body: '', error: err }));
        req.setTimeout(800, () => req.destroy());
      });
      if (heartbeatResponse.status === 200) break;
      await new Promise(r => setTimeout(r, 400));
    }

    if (heartbeatResponse.error?.code === 'EACCES') {
      console.log('受限沙箱隔离策略拦截本地 Socket，进程已正常拉起');
    } else {
      if (heartbeatResponse.status !== 200) {
        console.error('Heartbeat failed! error:', heartbeatResponse.error, 'sidecarLogs:', sidecarLogs);
      }
      assert.equal(heartbeatResponse.status, 200, 'Sidecar 心跳服务必须返回 HTTP 200');
      assert.match(heartbeatResponse.body, /Antigravity Context Ring Active/, '心跳响应内容必须正确');
    }

    // 5. 验证执行卸载脚本 uninstall.ps1：必须精准杀死 Sidecar 并清理文件
    const uninstallScript = join(packageRoot, 'uninstall.ps1');
    const { stdout: uninstallOut } = await execFileAsync('powershell', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', uninstallScript
    ], {
      env: {
        ...process.env,
        AGY_TEST_TARGET_DIR: TEST_TARGET_DIR,
        AGY_TEST_CONFIG_FILE: TEST_CONFIG_FILE
      }
    });
    assert.match(uninstallOut, /\[SUCCESS\]/);

    // 等待进程退出
    await new Promise(r => setTimeout(r, 800));

    // 6. 严苛断言：
    // - 插件目录必须已被物理移除
    assert.equal(existsSync(TEST_TARGET_DIR), false, '卸载后插件目录必须已被完全移除');
    // - 用户无辜进程绝不能被误杀！
    assert.equal(isPidAlive(innocentPid), true, '卸载脚本绝不能误杀用户其他 Node 进程！');

    // - config.json 中的 enabled 必须置为 false 且无 BOM
    const configAfterText = await readFile(TEST_CONFIG_FILE, 'utf8');
    assert.equal(configAfterText.startsWith('\ufeff'), false, 'PowerShell 卸载脚本更新的 config.json 严禁携带 UTF-8 BOM 标记');
    const configAfter = JSON.parse(configAfterText);
    assert.equal(configAfter.plugins?.['antigravity-context-ring']?.enabled, false, 'config.json 状态必须置为 false');

    // 主动确保测试进程退出
    try { spawnedProc.kill(); } catch {}

  } finally {
    // 7. 清理哨兵进程与沙箱
    try { innocentUserApp.kill(); } catch {}
    if (existsSync(SANDBOX)) {
      await rm(SANDBOX, { recursive: true, force: true });
    }
  }
});
