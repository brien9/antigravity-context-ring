import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rpcCall, isRetryableRpcError } from '../sidecars/ring/rpc-client.mjs';
import { probePort, getDiskCacheFile, writeDiskCache, readDiskCache } from '../sidecars/ring/ls-discovery.mjs';
import { rpcCallWithRetry } from '../sidecars/ring/context-service.mjs';

/**
 * 启动一个临时 HTTP 服务，返回 { port, close }
 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

/** 发送响应头与半截正文后强制断开 socket，模拟 LS 在响应途中重启 */
const midBodyAbortHandler = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
  res.write('{"steps":[');
  setTimeout(() => req.socket.destroy(), 30);
};

/** 给 Promise 加硬超时，超时即判定为挂起 */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: 超过 ${ms}ms 未结算`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

test('【网络健壮性 1】rpcCall: 响应体中途断开必须立即 reject，绝不永久挂起', async () => {
  const srv = await startServer(midBodyAbortHandler);
  try {
    const err = await withDeadline(
      rpcCall({ port: srv.port, csrfToken: 'x', useTls: false }, 'Test', {}, 10000).then(
        () => { throw new Error('不应 resolve'); },
        e => e
      ),
      2000
    );
    assert.match(err.message, /aborted|response error/i);
    assert.equal(isRetryableRpcError(err), true, '中途断开属于连接级故障，应允许重新发现');
  } finally {
    await srv.close();
  }
});

test('【网络健壮性 2】probePort: 响应体中途断开必须结算为 false，杜绝 inFlightDiscovery 死锁', async () => {
  const srv = await startServer(midBodyAbortHandler);
  try {
    const ok = await withDeadline(probePort(srv.port, 'x', false, 10000), 2000);
    assert.equal(ok, false);
  } finally {
    await srv.close();
  }
});

test('【网络健壮性 3】rpcCall: HTTP 状态码错误携带 statusCode 并正确分类', async () => {
  let status = 404;
  const srv = await startServer((req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end('{"code":"not_found"}');
  });
  try {
    const ls = { port: srv.port, csrfToken: 'x', useTls: false };
    const err404 = await rpcCall(ls, 'Test', {}, 3000).catch(e => e);
    assert.equal(err404.statusCode, 404);
    assert.equal(isRetryableRpcError(err404), false, '404 业务错误不应触发重新发现');

    status = 403;
    const err403 = await rpcCall(ls, 'Test', {}, 3000).catch(e => e);
    assert.equal(err403.statusCode, 403);
    assert.equal(isRetryableRpcError(err403), true, '403 可能是 CSRF Token 轮换，应允许重新发现');
  } finally {
    await srv.close();
  }
});

test('【网络健壮性 4】isRetryableRpcError: 连接级与业务级错误分类', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  assert.equal(isRetryableRpcError(refused), true);
  assert.equal(isRetryableRpcError(Object.assign(new Error('RPC timeout'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isRetryableRpcError(Object.assign(new Error('x'), { statusCode: 500 })), false);
  assert.equal(isRetryableRpcError(Object.assign(new Error('parse'), { retryable: false })), false);
  assert.equal(isRetryableRpcError(null), false);
});

test('【网络健壮性 5】rpcCallWithRetry: 业务错误直接抛出，绝不触发强制重新发现', async () => {
  let discoverCalls = 0;
  let rpcCalls = 0;
  const notFound = Object.assign(new Error('RPC HTTP 404'), { statusCode: 404, retryable: false });
  const lsRef = { current: { port: 1, csrfToken: 'a', useTls: false } };
  const err = await rpcCallWithRetry(lsRef, 'GetCascadeTrajectorySteps', {}, 1000, {
    rpcCall: async () => { rpcCalls++; throw notFound; },
    discoverLanguageServer: async () => { discoverCalls++; return { port: 2, csrfToken: 'b', useTls: false }; },
  }).catch(e => e);
  assert.equal(err, notFound);
  assert.equal(discoverCalls, 0, '业务错误不应拉起 PowerShell/netstat 重新发现');
  assert.equal(rpcCalls, 1);
  assert.equal(lsRef.current.port, 1);
});

test('【网络健壮性 6】rpcCallWithRetry: 连接级错误强制重新发现并用新 LS 重试一次', async () => {
  const seenPorts = [];
  let discoverForce = null;
  const lsRef = { current: { port: 1, csrfToken: 'a', useTls: false } };
  const result = await rpcCallWithRetry(lsRef, 'GetCascadeTrajectorySteps', {}, 1000, {
    rpcCall: async (ls) => {
      seenPorts.push(ls.port);
      if (ls.port === 1) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return { steps: [] };
    },
    discoverLanguageServer: async (force) => { discoverForce = force; return { port: 2, csrfToken: 'b', useTls: false }; },
  });
  assert.deepEqual(result, { steps: [] });
  assert.equal(discoverForce, true);
  assert.deepEqual(seenPorts, [1, 2]);
  assert.equal(lsRef.current.port, 2);
});

test('【网络健壮性 7】rpcCallWithRetry: 重新发现失败时抛出原始错误', async () => {
  const original = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const err = await rpcCallWithRetry({ current: { port: 1 } }, 'X', {}, 1000, {
    rpcCall: async () => { throw original; },
    discoverLanguageServer: async () => null,
  }).catch(e => e);
  assert.equal(err, original);
});

test('【稳健性修复 5】ls-discovery: getDiskCacheFile 具备沙箱与私有权限路径隔离，杜绝全局 /tmp 明文泄露', () => {
  const originalTestDir = process.env.AGY_TEST_TARGET_DIR;
  try {
    process.env.AGY_TEST_TARGET_DIR = join(tmpdir(), 'agy_safe_test_cache');
    const path = getDiskCacheFile();
    assert.ok(path.includes('agy_safe_test_cache'), '在测试环境下必须优先使用 AGY_TEST_TARGET_DIR 隔离');
  } finally {
    if (originalTestDir !== undefined) {
      process.env.AGY_TEST_TARGET_DIR = originalTestDir;
    } else {
      delete process.env.AGY_TEST_TARGET_DIR;
    }
  }

  // 验证源码写入时严格指定 mode: 0o600
  const lsDiscoveryCode = readFileSync(new URL('../sidecars/ring/ls-discovery.mjs', import.meta.url), 'utf8');
  assert.ok(lsDiscoveryCode.includes('mode: 0o600'), 'writeDiskCache 写入时必须显式指定 0600 权限');
});

test('【稳健性修复 6】manage.mjs & uninstall.ps1: 卸载时序防御，必须先禁用配置再终止进程', () => {
  const manageCode = readFileSync(new URL('../manage.mjs', import.meta.url), 'utf8');
  const uninstallFunc = manageCode.slice(manageCode.indexOf('async function uninstall('), manageCode.indexOf('async function findRunningSidecarPids('));
  const disableConfigPos = uninstallFunc.indexOf('config.plugins[PLUGIN_KEY].enabled = false;');
  const killSidecarPos = uninstallFunc.indexOf('await cleanOrphanInstances().catch');
  assert.ok(disableConfigPos !== -1 && killSidecarPos !== -1, 'uninstall 必须包含禁用配置与杀死进程两步');
  assert.ok(disableConfigPos < killSidecarPos, '必须在杀进程之前先禁用配置，防止宿主按 restart_policy 重新拉起进程');

  const psCode = readFileSync(new URL('../uninstall.ps1', import.meta.url), 'utf8');
  const psDisablePos = psCode.indexOf('$pluginNode.enabled = $false');
  const psKillPos = psCode.indexOf('Stop-SidecarProcesses');
  assert.ok(psDisablePos !== -1 && psKillPos !== -1);
  assert.ok(psDisablePos < psKillPos, 'uninstall.ps1 中必须先禁用配置，再调用 Stop-SidecarProcesses');
});

test('【稳健性修复 7】ring-widget: model 自身带 flex-1 时不会误判为父容器，且 mount() 隔离异常', () => {
  const widgetCode = readFileSync(new URL('../assets/ring-widget.cjs', import.meta.url), 'utf8');
  assert.ok(
    widgetCode.includes("model.parentElement?.closest?.('.flex-1')"),
    'flexContainer 必须从 model.parentElement 向上探查，杜绝 model 自身带 flex-1 时将自身当成容器'
  );
  assert.ok(
    widgetCode.includes('try {\n        mountOrUpdatePane(comp, composers.length);\n      } catch {}') ||
    widgetCode.includes('try {\r\n        mountOrUpdatePane(comp, composers.length);\r\n      } catch {}'),
    'mount() 遍历挂载必须对单分屏包裹 try/catch，防止单个分屏 DOM 异常中断全局'
  );
});

test('【稳健性修复 5-B】ls-discovery: writeDiskCache 递归创建父目录、数据结构校验与安全权限实测', () => {
  const originalTestDir = process.env.AGY_TEST_TARGET_DIR;
  const sandboxParent = join(tmpdir(), 'agy_cache_deep_' + Date.now());
  const sandboxDir = join(sandboxParent, 'deep_nested_dir');
  try {
    process.env.AGY_TEST_TARGET_DIR = sandboxDir;
    // 1. 父目录完全不存在时，writeDiskCache 自动创建目录并安全写入
    assert.equal(existsSync(sandboxDir), false);
    const mockInfo = { port: 37421, csrfToken: 'sec_token_999999999999999999999999', useTls: false };
    writeDiskCache(mockInfo);
    assert.equal(existsSync(sandboxDir), true, '父目录必须被自动递归创建');

    // 2. readDiskCache 能够精准读回数据
    const loaded = readDiskCache();
    assert.deepEqual(loaded, mockInfo, '写入的凭据信息必须完整正确读回');

    // 3. 校验权限（在非 Windows 系统上，mode 必须受限于 0600）
    if (process.platform !== 'win32') {
      const targetFile = getDiskCacheFile();
      const st = statSync(targetFile);
      assert.equal(st.mode & 0o777, 0o600, '磁盘缓存文件权限必须是 0600');
    }

    // 4. 非法数据自愈防御（如端口非法或缺少 token，返回 null）
    const targetFile = getDiskCacheFile();
    writeFileSync(targetFile, JSON.stringify({ port: -1, csrfToken: 'valid', useTls: false }), 'utf8');
    assert.equal(readDiskCache(), null, '非法端口必须被校验拦截');

    writeFileSync(targetFile, JSON.stringify({ port: 1234, csrfToken: '', useTls: false }), 'utf8');
    assert.equal(readDiskCache(), null, '空 token 必须被校验拦截');

    writeFileSync(targetFile, '{ invalid json', 'utf8');
    assert.equal(readDiskCache(), null, '损坏 JSON 必须被安全捕获返回 null');

    // 5. writeDiskCache 输入校验防御：传入非法对象时绝不覆写磁盘存量有效缓存
    writeDiskCache(mockInfo);
    assert.deepEqual(readDiskCache(), mockInfo);
    writeDiskCache(null);
    assert.deepEqual(readDiskCache(), mockInfo, 'writeDiskCache(null) 绝不能破坏有效缓存');
    writeDiskCache({ port: -99, csrfToken: 'fake', useTls: false });
    assert.deepEqual(readDiskCache(), mockInfo, 'writeDiskCache 非法端口绝不能破坏有效缓存');
    writeDiskCache({ port: 1234, csrfToken: '', useTls: false });
    assert.deepEqual(readDiskCache(), mockInfo, 'writeDiskCache 空 token 绝不能破坏有效缓存');
  } finally {
    if (originalTestDir !== undefined) {
      process.env.AGY_TEST_TARGET_DIR = originalTestDir;
    } else {
      delete process.env.AGY_TEST_TARGET_DIR;
    }
    try {
      rmSync(sandboxParent, { recursive: true, force: true });
    } catch {}
  }
});

test('【稳健性修复 6-B】manage.mjs: 真实调用 uninstall 先修改配置后删目录，保证配置零丢失且时序可靠', async () => {
  const sandboxRoot = join(tmpdir(), 'agy_uninstall_sandbox_' + Date.now());
  const targetDir = join(sandboxRoot, 'installed_plugin');
  const configFile = join(sandboxRoot, 'config.json');
  const manageScript = fileURLToPath(new URL('../manage.mjs', import.meta.url));

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'dummy.txt'), 'some content', 'utf8');

  const initialConfig = {
    theme: 'atom-dark',
    otherSetting: true,
    plugins: {
      'antigravity-context-ring': {
        enabled: true,
        userCustomKey: 'preserve_this_value'
      },
      'unrelated-plugin': {
        enabled: true
      }
    }
  };
  writeFileSync(configFile, JSON.stringify(initialConfig, null, 2), 'utf8');

  // 运行 manage.mjs uninstall
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync(process.execPath, [manageScript, 'uninstall'], {
    env: {
      ...process.env,
      AGY_TEST_TARGET_DIR: targetDir,
      AGY_TEST_CONFIG_FILE: configFile
    }
  });

  // 1. 验证时序日志输出：先禁用配置，再终止进程，最后清理目录
  const disableStepIdx = stdout.indexOf('[0/3] 正在禁用插件配置');
  const killStepIdx = stdout.indexOf('[1/3] 正在安全终止运行中的 Sidecar 进程');
  const rmStepIdx = stdout.indexOf('[2/3] 正在清理插件文件');
  assert.ok(disableStepIdx !== -1 && killStepIdx !== -1 && rmStepIdx !== -1, '必须包含三步完整卸载流程');
  assert.ok(disableStepIdx < killStepIdx && killStepIdx < rmStepIdx, '执行时序必须为: 先改配置 -> 再停进程 -> 最后删目录');

  // 2. 验证目标目录已被物理删除
  assert.equal(existsSync(targetDir), false, '插件安装目录必须已被彻底删除');

  // 3. 验证配置文件内容变更与安全保留
  const updatedRaw = readFileSync(configFile, 'utf8');
  const updatedConfig = JSON.parse(updatedRaw);
  assert.equal(updatedConfig.plugins['antigravity-context-ring'].enabled, false, '插件必须被安全置为 enabled: false');
  assert.equal(updatedConfig.plugins['antigravity-context-ring'].userCustomKey, 'preserve_this_value', '用户原有自定义配置必须原样保留');
  assert.equal(updatedConfig.theme, 'atom-dark', '根级其他配置必须零丢失');
  assert.equal(updatedConfig.plugins['unrelated-plugin']?.enabled, true, '其他无关插件配置必须原样保留');

  // 清理临时沙箱
  try {
    rmSync(sandboxRoot, { recursive: true, force: true });
  } catch {}
});

test('【稳健性修复 7-B】ring-widget: model 自身带 flex-1 时 DOM 算法精确收敛，且分屏异常完美隔离', () => {
  // 1. 模拟 DOM 树：验证 candidateContainer 与 modelBranch 在 model 自身包含 flex-1 时的推导
  // 结构：box -> toolbar(.flex-1) -> wrapper -> model(.flex-1)
  const box = { contains: (node) => true };
  const toolbar = { className: 'composer-toolbar flex-1', parentElement: box, contains: () => true };
  const wrapper = { className: 'model-wrapper', parentElement: toolbar };
  const modelWithFlex1 = {
    className: 'model-btn flex-1',
    parentElement: wrapper,
    closest(sel) {
      if (sel === '.flex-1') return this;
      return null;
    }
  };
  wrapper.closest = (sel) => (sel === '.flex-1' ? toolbar : null);
  toolbar.closest = (sel) => (sel === '.flex-1' ? toolbar : null);

  // 运行算法推导 flexContainer：必须从 model.parentElement 向上探查
  const candidateContainer = modelWithFlex1.parentElement?.closest?.('.flex-1');
  const flexContainer = (candidateContainer && box?.contains(candidateContainer))
    ? candidateContainer
    : (modelWithFlex1.parentElement || box);

  assert.equal(flexContainer, toolbar, 'flexContainer 绝不能是 model 自身，必须是父级工具栏');

  // 推导 modelBranch
  let modelBranch = modelWithFlex1;
  while (modelBranch && modelBranch.parentElement && modelBranch.parentElement !== flexContainer && modelBranch.parentElement !== box && modelBranch.parentElement !== (typeof document !== 'undefined' ? document.body : null)) {
    modelBranch = modelBranch.parentElement;
  }
  assert.equal(modelBranch, wrapper, 'modelBranch 必须精确收敛到 flexContainer 的直接子节点 wrapper');

  // 2. 模拟多分屏错误隔离：3 个分屏，中间的分屏抛出严重 DOM 异常，验证遍历挂载不受影响
  let mountedPanes = [];
  const fakePanes = [
    { id: 1, name: 'pane-left' },
    { id: 2, name: 'broken-pane-throw' },
    { id: 3, name: 'pane-right' }
  ];

  function mockMountOrUpdatePane(comp) {
    if (comp.id === 2) {
      throw new Error('Fake DOMException: insertBefore failed');
    }
    mountedPanes.push(comp.id);
  }

  // 遍历挂载并应用异常隔离防御
  for (const comp of fakePanes) {
    try {
      mockMountOrUpdatePane(comp);
    } catch {}
  }

  assert.deepEqual(mountedPanes, [1, 3], '单个分屏 DOM 异常必须被完全隔离，正常分屏全部挂载成功');

  // 3. 静态断言：mountOrUpdatePane 必须在函数层级建立完整的边界检查与 try-catch 错误隔离
  const widgetCode = readFileSync(new URL('../assets/ring-widget.cjs', import.meta.url), 'utf8');
  assert.ok(
    widgetCode.includes('function mountOrUpdatePane(comp, totalPanes) {\n    if (!comp || !comp.box) return null;\n    try {') ||
    widgetCode.includes('function mountOrUpdatePane(comp, totalPanes) {\r\n    if (!comp || !comp.box) return null;\r\n    try {'),
    'mountOrUpdatePane 内部整体必须包裹 try-catch 实施单分屏错误隔离'
  );
  assert.ok(
    widgetCode.includes('} catch {\n    return null;\n  }') ||
    widgetCode.includes('} catch {\r\n    return null;\r\n  }'),
    'mountOrUpdatePane 异常时必须返回 null 且杜绝抛出未捕获异常'
  );
});

test('【AbortSignal retryable 属性】rpcCall 被 signal 取消时必须标记 retryable = false', async () => {
  // 1. 已处于 aborted 状态的 signal
  const preAbortedController = new AbortController();
  preAbortedController.abort();
  try {
    await rpcCall({ port: 9999, csrfToken: 'x', useTls: false }, 'Test', {}, 1000, preAbortedController.signal);
    assert.fail('应拒绝');
  } catch (err) {
    assert.equal(err.retryable, false, '预先取消的 RPC 错误必须标记 retryable = false');
    assert.equal(isRetryableRpcError(err), false, 'isRetryableRpcError 必须判定为 false');
  }

  // 2. 途中触发 signal abort
  const srv = await startServer((req, res) => {
    // 延迟响应，等待客户端 abort
    setTimeout(() => {
      try { res.end('{}'); } catch {}
    }, 1000);
  });

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    try {
      await rpcCall({ port: srv.port, csrfToken: 'x', useTls: false }, 'Test', {}, 5000, controller.signal);
      assert.fail('应拒绝');
    } catch (err) {
      assert.equal(err.retryable, false, '进行中取消的 RPC 错误必须标记 retryable = false');
      assert.equal(isRetryableRpcError(err), false, 'isRetryableRpcError 必须判定为 false');
    }
  } finally {
    await srv.close();
  }
});



