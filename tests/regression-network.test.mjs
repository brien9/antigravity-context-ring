import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rpcCall, isRetryableRpcError } from '../sidecars/ring/rpc-client.mjs';
import { probePort } from '../sidecars/ring/ls-discovery.mjs';
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
