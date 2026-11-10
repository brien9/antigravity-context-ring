import * as http from 'node:http';
import * as https from 'node:https';

/**
 * 构造带分类标记的 RPC 错误
 * @param {string} message
 * @param {{ statusCode?: number, code?: string, retryable?: boolean }} [extra]
 */
function createRpcError(message, extra = {}) {
  const err = new Error(message);
  if (typeof extra.statusCode === 'number') err.statusCode = extra.statusCode;
  if (extra.code) err.code = extra.code;
  if (typeof extra.retryable === 'boolean') err.retryable = extra.retryable;
  return err;
}

/**
 * 判断 RPC 错误是否值得触发 Language Server 重新发现：
 * 仅连接级故障（拒连、重置、超时、中途断开）或 CSRF 鉴权失败才可能是 LS 迁移/重启，
 * 业务级 HTTP 错误（如 404 会话不存在）、响应解析失败、超大响应重新发现也无济于事。
 */
export function isRetryableRpcError(err) {
  if (!err || typeof err !== 'object') return false;
  if (typeof err.retryable === 'boolean') return err.retryable;
  if (typeof err.statusCode === 'number') return err.statusCode === 401 || err.statusCode === 403;
  return true; // 未分类的底层 socket 错误（ECONNREFUSED/EPIPE 等）视为连接级
}

/**
 * Connect-RPC 通信客户端
 * @param {Object} ls - 语言服务器连接信息 { port, csrfToken, useTls }
 * @param {string} endpoint - 调用的 RPC 服务端点
 * @param {Object} body - 请求载荷
 * @param {number} [timeoutMs=10000] - 超时毫秒数
 * @param {AbortSignal} [signal] - 取消信号
 * @returns {Promise<Object>}
 */
export function rpcCall(ls, endpoint, body = {}, timeoutMs = 10000, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('RPC aborted'));
      return;
    }

    let settled = false;
    const safeResolve = (val) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(val);
    };
    const safeReject = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    let onAbort;
    const cleanup = () => {
      if (onAbort && signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const postData = JSON.stringify(body);
    const transport = ls.useTls ? https : http;

    const req = transport.request({
      hostname: '127.0.0.1',
      port: ls.port,
      path: `/exa.language_server_pb.LanguageServerService/${endpoint}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': ls.csrfToken,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: timeoutMs,
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > 50 * 1024 * 1024) { // 50MB 保护
          req.destroy();
          safeReject(createRpcError('RPC response too large', { retryable: false }));
        }
      });
      res.on('end', () => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          safeReject(createRpcError(`RPC HTTP ${res.statusCode}: ${data.substring(0, 200)}`, {
            statusCode: res.statusCode,
            // 401/403 多为 LS 重启后 CSRF Token 轮换，允许重新发现；其余 HTTP 状态属业务错误
            retryable: res.statusCode === 401 || res.statusCode === 403,
          }));
          return;
        }
        try {
          safeResolve(JSON.parse(data));
        } catch (e) {
          safeReject(createRpcError(`Failed to parse RPC response: ${data.substring(0, 100)}`, { retryable: false }));
        }
      });
      // 响应体传输中途断开时 socket 已销毁、timeout 不会再触发，必须显式结算，否则 Promise 永久挂起
      res.on('error', (err) => safeReject(createRpcError(`RPC response error: ${err?.message || err}`, { code: err?.code || 'ECONNRESET' })));
      res.on('close', () => {
        if (!res.complete) {
          safeReject(createRpcError('RPC response aborted', { code: 'ECONNRESET' }));
        }
      });
    });

    req.on('error', safeReject);
    req.on('timeout', () => {
      req.destroy();
      safeReject(createRpcError('RPC timeout', { code: 'ETIMEDOUT' }));
    });

    if (signal) {
      onAbort = () => {
        req.destroy();
        safeReject(new Error('RPC aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.write(postData);
    req.end();
  });
}
