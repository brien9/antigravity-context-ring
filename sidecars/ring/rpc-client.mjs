import * as http from 'node:http';
import * as https from 'node:https';

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
          safeReject(new Error('RPC response too large'));
        }
      });
      res.on('end', () => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          safeReject(new Error(`RPC HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          safeResolve(JSON.parse(data));
        } catch (e) {
          safeReject(new Error(`Failed to parse RPC response: ${data.substring(0, 100)}`));
        }
      });
    });

    req.on('error', safeReject);
    req.on('timeout', () => {
      req.destroy();
      safeReject(new Error('RPC timeout'));
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
