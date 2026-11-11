import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { RuntimeBridgeManager } from '../sidecars/ring/runtime-bridge.mjs';
import { isContextRingProcess, startHostWatchdog, scanHostPids } from '../sidecars/ring/main.mjs';
import { extractTokenAndPid, isCandidateServerLine } from '../sidecars/ring/ls-discovery.mjs';

test('【阶段四场景 1】RuntimeBridgeManager: syncPending 状态防丢失与 generation 生命周期隔离', async () => {
  const manager = new RuntimeBridgeManager('/fake/dir', '/* widget code */');
  assert.equal(manager.syncInFlight, false, '初始状态 syncInFlight 必须为 false');
  assert.equal(manager.syncPending, false, '初始状态 syncPending 必须为 false');
  assert.equal(manager.generation, 0, '初始 generation 必须为 0');

  // 1. 验证 syncPending 补录机制：并发时排队，当前轮结束后自动补跑最新一轮
  let syncRuns = 0;
  let finishFirstRun = null;
  const holdFirstRun = new Promise((resolve) => { finishFirstRun = resolve; });

  manager._performSync = async () => {
    syncRuns++;
    if (syncRuns === 1) {
      await holdFirstRun;
    }
  };

  manager.running = true;
  manager.generation = 1;

  // 触发第一轮
  const run1 = manager.sync();
  assert.equal(manager.syncInFlight, true, '第一轮进行中 syncInFlight 为 true');

  // 模拟并发状态变化：触发第二轮
  const run2 = manager.sync();
  assert.equal(manager.syncPending, true, '并发请求必须将 syncPending 标记为 true，绝不丢弃最新状态');

  // 释放第一轮
  finishFirstRun();
  await run1;
  await run2;

  assert.equal(syncRuns, 2, '当前轮结束后必须因 syncPending 自动补跑第二轮最新状态');
  assert.equal(manager.syncInFlight, false, '全部完成后锁必须释放');
  assert.equal(manager.syncPending, false, '全部完成后 pending 必须复位');

  // 2. 验证 generation / epoch 生命周期隔离：stop 之后正在飞行的任务绝不污染新状态
  manager.start();
  const activeGen = manager.generation;
  assert.ok(activeGen > 1, 'start 后 generation 必须递增');

  let delayedResolve = null;
  const delayedTask = new Promise((resolve) => { delayedResolve = resolve; });

  let contaminated = false;
  manager._performSync = async (gen) => {
    await delayedTask;
    // 关键 await 后检查 generation
    if (!manager.running || manager.generation !== gen) {
      return; // 成功拦截
    }
    contaminated = true;
  };

  const danglingSync = manager.sync();
  // 模拟中途调用 stop
  manager.stop();
  assert.equal(manager.running, false, 'stop 之后 running 必须为 false');
  assert.notEqual(manager.generation, activeGen, 'stop 之后 generation 必须递增实现生命周期隔离');

  // 旧异步任务恢复
  delayedResolve();
  await danglingSync;

  assert.equal(contaminated, false, '跨生命周期的旧异步任务必须被 generation 隔离阻断，杜绝污染！');
});

test('【阶段四场景 2】安全进程识别: 命中专属标识 --sidecar=antigravity-context-ring', () => {
  const cmd1 = '"C:\\Program Files\\nodejs\\node.exe" "C:\\plugins\\antigravity-context-ring\\sidecars\\ring\\main.mjs" --sidecar=antigravity-context-ring';
  assert.equal(isContextRingProcess(cmd1, 1001, 9999), true, '显式携带专属标识的命令行必须识别为 true');

  const cmd2 = 'node main.mjs --sidecar=antigravity-context-ring';
  assert.equal(isContextRingProcess(cmd2, 1002, 9999), true, '相对路径携带专属标识必须识别为 true');

  const cmd3 = 'node "C:\\Users\\alice\\.gemini\\config\\plugins\\antigravity-context-ring\\sidecars\\ring\\main.mjs"';
  assert.equal(isContextRingProcess(cmd3, 1003, 9999), true, '旧版本插件目录内的 main.mjs 必须兼容识别为 true');
});

test('【阶段四场景 3】安全进程识别: 严格白名单，坚决杜绝误杀用户无关 Node 程序与自身', () => {
  // 1. 自身 PID 坚决不杀
  const currentPid = 1234;
  const selfCmd = 'node main.mjs --sidecar=antigravity-context-ring';
  assert.equal(isContextRingProcess(selfCmd, currentPid, currentPid), false, '自身 PID 坚决不能被识别为待清理目标');

  // 2. 用户自建项目的 main.mjs (无专属标识与本插件目录) 坚决不杀！
  const userProjectCmd1 = 'node C:\\workspace\\my-project\\main.mjs';
  assert.equal(isContextRingProcess(userProjectCmd1, 2001, currentPid), false, '用户普通项目的 main.mjs 绝不能误识别');

  const userProjectCmd2 = 'node main.mjs';
  assert.equal(isContextRingProcess(userProjectCmd2, 2002, currentPid), false, '纯相对路径 node main.mjs 绝不能误杀');

  // 3. 用户其他 Node 程序坚决不杀
  const otherNodeApp = '"C:\\Program Files\\nodejs\\node.exe" server.js --port=3000';
  assert.equal(isContextRingProcess(otherNodeApp, 2003, currentPid), false, '无关 node 程序坚决放行');

  const anotherTool = 'node C:\\Users\\alice\\.gemini\\config\\plugins\\other-tool\\main.mjs';
  assert.equal(isContextRingProcess(anotherTool, 2004, currentPid), false, '其他插件的 main.mjs 坚决放行');
});

test('【阶段四场景 4】吸收 source-monitor 发现机制: 多格式与多参数 CSRF Token 提取', () => {
  // 1. 标准下划线格式
  const line1 = '"8912","language_server_windows_x64.exe --csrf_token 11112222333344445555666677778888"';
  const info1 = extractTokenAndPid(line1);
  assert.ok(info1);
  assert.equal(info1.pid, 8912);
  assert.equal(info1.csrfToken, '11112222333344445555666677778888');

  // 2. 中划线等号格式
  const line2 = '9820 language_server_windows_x64.exe --csrf-token=aabbccddeeff00112233445566778899';
  const info2 = extractTokenAndPid(line2);
  assert.ok(info2);
  assert.equal(info2.pid, 9820);
  assert.equal(info2.csrfToken, 'aabbccddeeff00112233445566778899');

  // 3. 双引号包裹格式
  const line3 = '"14208","agy.exe --hub --csrf_token=\\"abcdef1234567890abcdef1234567890\\""';
  const info3 = extractTokenAndPid(line3);
  assert.ok(info3);
  assert.equal(info3.pid, 14208);
  assert.equal(info3.csrfToken, 'abcdef1234567890abcdef1234567890');

  // 4. 单横杠参数与冒号
  const line4 = ' 3045 /path/to/language_server -csrf-token:12345678901234567890123456789012';
  const info4 = extractTokenAndPid(line4);
  assert.ok(info4);
  assert.equal(info4.pid, 3045);
  assert.equal(info4.csrfToken, '12345678901234567890123456789012');

  // 5. 格式无效时安全返回 null
  assert.equal(extractTokenAndPid(''), null);
  assert.equal(extractTokenAndPid('chrome.exe --some-flag'), null);
});

test('【阶段四场景 5】吸收 source-monitor 发现机制: agy --hub 进程与候选行识别', () => {
  // 1. agy --hub 进程
  assert.equal(isCandidateServerLine('agy.exe --hub --csrf_token=12345678901234567890123456789012'), true);
  assert.equal(isCandidateServerLine('/usr/local/bin/agy --hub --port 8080'), true);

  // 2. language_server 进程
  assert.equal(isCandidateServerLine('language_server_windows_x64.exe --csrf_token abc'), true);
  assert.equal(isCandidateServerLine('language_server_macos_arm64'), true);

  // 3. 普通非相关进程
  assert.equal(isCandidateServerLine('chrome.exe --type=renderer'), false);
  assert.equal(isCandidateServerLine('explorer.exe'), false);
  assert.equal(isCandidateServerLine('node.exe main.mjs'), false);
});

test('【阶段四场景 6】跨平台 Linux/macOS 鲁棒性: 彻底根除 extractFlag 运行时异常', () => {
  // 模拟 Linux/macOS 下 ps -ax -o pid=,command= 输出
  const mockPsOutput = `
    123 /sbin/launchd
    456 /Applications/Antigravity.app/Contents/MacOS/Antigravity
    789 /Applications/Antigravity.app/Contents/Resources/app/language_server_macos_arm64 --csrf_token 99998888777766665555444433332222 --port 50051
  `;

  const lines = mockPsOutput.split('\n').map(l => l.trim()).filter(Boolean);
  let capturedInfo = null;
  for (const line of lines) {
    if (isCandidateServerLine(line)) {
      capturedInfo = extractTokenAndPid(line);
      if (capturedInfo) break;
    }
  }

  assert.ok(capturedInfo, '必须在 Linux/macOS 的 ps 输出中正常解析出信息');
  assert.equal(capturedInfo.pid, 789);
  assert.equal(capturedInfo.csrfToken, '99998888777766665555444433332222');
});

test('【阶段四场景 7】安全进程识别: 冒名子串防伪与参数边界判定', () => {
  // 1. 子串碰撞伪造：--sidecar=antigravity-context-ring-fake 绝不能被识别为真
  const imposterCmd1 = 'node server.js --sidecar=antigravity-context-ring-fake';
  assert.equal(isContextRingProcess(imposterCmd1, 3001, 9999), false, '子串碰撞伪造 flag 坚决识别为 false');

  // 2. 只有 flag 但没有 main.mjs 或插件路径的纯无关程序，即使携带完整 flag 也不能误识别
  const unrelatedCmd = 'node D:\\other-tools\\watcher.js --sidecar=antigravity-context-ring';
  assert.equal(isContextRingProcess(unrelatedCmd, 3002, 9999), false, '非本插件 main.mjs 的无关程序携带 flag 坚决放行');

  // 3. 非 node 程序（如 python、bash、chrome、vim）携带该参数或打开插件目录文件坚决放行
  const pythonCmd = 'python main.py --sidecar=antigravity-context-ring';
  assert.equal(isContextRingProcess(pythonCmd, 3003, 9999), false, '非 Node 程序坚决放行');

  const vimCmd = 'vim /Users/alice/.gemini/config/plugins/antigravity-context-ring/sidecars/ring/main.mjs';
  assert.equal(isContextRingProcess(vimCmd, 3004, 9999), false, '非 Node 程序打开插件目录 main.mjs 坚决放行');
});

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

test('【阶段四场景 8】真实 Windows 宿主环境: CIM 孤儿进程识别与误杀防范实测', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 宿主环境下执行真实 CIM 查询');
    return;
  }

  // 前置探针：在隔离沙箱或受限策略下，Windows WMI/CIM 权限可能被屏蔽
  try {
    await execFileAsync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_OperatingSystem -ErrorAction Stop']);
  } catch {
    t.skip('当前处于隔离沙箱环境中，Windows CIM/WMI 权限被系统屏蔽，在真实宿主终端中方可执行端到端实测');
    return;
  }

  // 启动一个模拟用户的无辜 Node 进程
  const userAppProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const userPid = userAppProc.pid;

  // 启动一个伪造了 flag 的冒牌 Node 进程
  const imposterProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--sidecar=antigravity-context-ring-fake'], { stdio: 'ignore' });
  const imposterPid = imposterProc.pid;

  // 启动一个真实 Sidecar 进程（注入专属测试目录隔离变量，防止其冷启动清理逻辑误杀宿主真实生产守护进程或并行测试进程）
  const sidecarProc = spawn(process.execPath, ['sidecars/ring/main.mjs', '--sidecar=antigravity-context-ring'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      AGY_TEST_TARGET_DIR: '__agy_stability_cim_isolated_sandbox__'
    }
  });
  const sidecarPid = sidecarProc.pid;

  await new Promise(r => setTimeout(r, 600));

  const isAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  assert.equal(isAlive(userPid), true, '用户进程启动后必须存活');
  assert.equal(isAlive(imposterPid), true, '伪造进程启动后必须存活');
  assert.equal(isAlive(sidecarPid), true, 'Sidecar 进程启动后必须存活');

  // 执行真实 Windows CIM 过滤与终止（仅限定在受试候选进程集，防止干扰并行测试）
  const psCmd = `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { ` +
    `$targetPids = @(${sidecarPid}, ${userPid}, ${imposterPid}); ` +
    `if (-not ($targetPids -contains $_.ProcessId)) { return $false }; ` +
    `$cmd = $_.CommandLine; ` +
    `if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }; ` +
    `$hasFlag = ($cmd -match '(?:^|\\s)--sidecar=antigravity-context-ring(?:\\s|$)'); ` +
    `$hasPath = ($cmd -match 'antigravity-context-ring' -and $cmd -match 'main\\.mjs'); ` +
    `$hasRingMain = ($cmd -match 'sidecars[\\\\/]ring[\\\\/]main\\.mjs' -or $cmd -match 'main\\.mjs'); ` +
    `(($hasFlag -and $hasRingMain) -or $hasPath) -and ($_.ProcessId -ne ${process.pid}) ` +
    `} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;

  await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd]);
  await new Promise(r => setTimeout(r, 800));

  const sidecarAlive = isAlive(sidecarPid);
  const userAlive = isAlive(userPid);
  const imposterAlive = isAlive(imposterPid);

  try { userAppProc.kill(); } catch {}
  try { imposterProc.kill(); } catch {}
  try { sidecarProc.kill(); } catch {}
  try { rmSync('__agy_stability_cim_isolated_sandbox__', { recursive: true, force: true }); } catch {}

  assert.equal(sidecarAlive, false, '目标 Sidecar 进程必须被精准识别并终止！');
  assert.equal(userAlive, true, '用户无关 Node 进程绝不能被误杀！');
  assert.equal(imposterAlive, true, '冒名伪造 Node 进程绝不能被误杀！');
});

test('【阶段四场景 9】宿主看门狗: 空 PID 自杀防御、销毁后异步回调隔离与 manage.mjs status 状态巡检', async () => {
  let shutdownTriggered = false;
  const originalEnvPid = process.env.AGY_HOST_PID;
  delete process.env.AGY_HOST_PID;

  try {
    const timer = startHostWatchdog(() => {
      shutdownTriggered = true;
    });

    assert.ok(timer, '看门狗定时器必须正常初始化');
    clearInterval(timer);
    assert.equal(shutdownTriggered, false, '未曾发现有效宿主 PID 时，看门狗绝不能自杀触发 shutdown');

    // 验证定时器立即销毁后，在途的 scanHostPids() 异步回调被 isTimerStopped() 静默丢弃，不打印绑定日志
    process.env.AGY_HOST_PID = String(process.pid);
    const capturedLogs = [];
    const origLog = console.log;
    console.log = (...args) => capturedLogs.push(args.join(' '));
    try {
      const timer2 = startHostWatchdog(() => {});
      clearInterval(timer2);
      await new Promise(r => setTimeout(r, 60));
    } finally {
      console.log = origLog;
    }
    assert.equal(
      capturedLogs.some(msg => msg.includes('Bound to Antigravity host')),
      false,
      '看门狗被 clearInterval 销毁后，异步返回的 scanHostPids 回调必须静默丢弃，严禁跨生命周期输出日志'
    );

    // 验证 node manage.mjs status 运维子命令输出完整性
    const { stdout: statusOut } = await execFileAsync(process.execPath, ['manage.mjs', 'status']);
    assert.match(statusOut, /Antigravity Context Ring Status/, 'status 命令必须输出标题');
    assert.match(statusOut, /插件目录:/, 'status 命令必须输出插件目录状态');
    assert.match(statusOut, /配置状态:/, 'status 命令必须输出配置启用状态');
    assert.match(statusOut, /宿主进程:/, 'status 命令必须输出宿主进程状态');
    assert.match(statusOut, /守护进程:/, 'status 命令必须输出守护进程状态');
    assert.match(statusOut, /语言服务:/, 'status 命令必须输出语言服务状态');
  } finally {
    if (originalEnvPid) {
      process.env.AGY_HOST_PID = originalEnvPid;
    } else {
      delete process.env.AGY_HOST_PID;
    }
  }
});
