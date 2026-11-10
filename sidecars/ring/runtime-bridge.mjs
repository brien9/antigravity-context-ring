import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { getContextSnapshot } from './context-service.mjs';

const logBridge = (msg) => {
  console.log(`[ContextRing] ${msg}`);
};

const BINDING = '__agContextRingCall';

function jsonGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
      // 响应中途断开时 timeout 不再触发，显式结算防止 sync 巡检永久卡死在 syncInFlight
      res.on('error', reject);
      res.on('close', () => {
        if (!res.complete) reject(new Error('Response aborted'));
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Timeout')));
    req.end();
  });
}

export async function discoverTargets(profileDir) {
  let text;
  try {
    text = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8');
  } catch {
    return null;
  }

  const port = Number(text.split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  let list;
  try {
    list = await jsonGet(port, '/json/list');
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;

  // 只有成功拿到 CDP 列表时才返回数组；空数组代表宿主确认当前无页面，而不是发现失败
  return list.filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
}

export class CdpConnection {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
  }

  async open() {
    this.ws = new globalThis.WebSocket(this.url);
    this.ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id) {
          const item = this.pending.get(msg.id);
          if (item) {
            clearTimeout(item.timer);
            this.pending.delete(msg.id);
            if (msg.error) item.reject(new Error(msg.error.message || 'CDP Error'));
            else item.resolve(msg.result || {});
          }
        } else if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === BINDING) {
          this.handleBinding(msg.params);
        }
      } catch {}
    });

    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('Connection closed'));
      }
      this.pending.clear();
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 4000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(err);
      }, { once: true });
    });
  }

  command(method, params = {}, timeoutMs = 3000) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('Not connected'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async handleBinding(params) {
    if (this.closed) return;
    let payload;
    try {
      payload = JSON.parse(params.payload);
    } catch {
      return;
    }

    const { id, type, input } = payload;
    let result = { ready: false };

    if (type === 'snapshot') {
      const reqCid = input?.conversationId || null;
      const force = !!input?.force;
      const calcOptions = {};
      if (typeof input?.selectedModel === 'string' && input.selectedModel) {
        calcOptions.selectedModel = input.selectedModel;
      }
      if (typeof input?.fallbackModel === 'string' && input.fallbackModel) {
        calcOptions.fallbackModel = input.fallbackModel;
      }
      result = await getContextSnapshot(reqCid, force, calcOptions);
      if (this.closed) return;
      if (reqCid) {
        result.cid = reqCid;
        result.conversationId = result.conversationId || reqCid;
      }
      if (result.ready) {
        logBridge(`Snapshot OK: cid=${reqCid} force=${force} used=${result.used} (${result.usedK}) limit=${result.limitK} ratio=${result.percent}`);
        console.log(`[ContextRing] Pushed snapshot: used=${result.used} (${result.usedK}) limit=${result.limitK} ratio=${result.percent}`);
      } else {
        logBridge(`Snapshot NOT ready: cid=${reqCid}`);
      }
    }

    if (this.closed) return;

    const replyScript = `window.__agContextRingBridge?.resolve(${JSON.stringify(id)}, ${JSON.stringify(result)})`;
    try {
      await this.command('Runtime.evaluate', {
        expression: replyScript,
        contextId: params.executionContextId
      });
    } catch {}
  }

  close() {
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Connection closed'));
    }
    this.pending.clear();
    try { this.ws?.close(); } catch {}
  }
}

// 注入到宿主页面的宿主通信 Bridge 代码
function getBridgeScript(bindingName) {
  return `
    (function() {
      if (window !== window.top) return;
      delete window.__agContextRingBridge;
      delete window.__agContextRingHost;

      const bridgeInstId = 'br_' + Math.random().toString(36).slice(2, 10);
      const pending = new Map();
      let seq = 0;

      const call = (type, input) => new Promise((resolve) => {
        const id = bridgeInstId + '_' + (++seq);
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ready: false, offline: true });
        }, 8500);
        pending.set(id, { resolve, timer });
        try {
          window['${bindingName}'](JSON.stringify({ id, type, input }));
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          resolve({ ready: false, offline: true });
        }
      });

      window.__agContextRingBridge = {
        resolve(id, result) {
          const item = pending.get(id);
          if (item) {
            clearTimeout(item.timer);
            pending.delete(id);
            item.resolve(result);
          }
        }
      };

      window.__agContextRingHost = {
        getSnapshot: (input) => call('snapshot', input)
      };
    })();
  `;
}

/**
 * 管理与宿主窗口的 CDP 连接与注入
 */
export class RuntimeBridgeManager {
  constructor(profileDir, widgetCode, options = {}) {
    this.profileDir = profileDir;
    this.widgetCode = widgetCode;
    this.discoverTargets = typeof options.discoverTargets === 'function' ? options.discoverTargets : discoverTargets;
    this.connections = new Map();
    this.running = false;
    this.pollTimer = null;
    this.bootstrapTimer = null;
    // CDP 目标发现与脚本注入巡检的防重入锁与挂起重试机制
    this.syncInFlight = false;
    this.syncPending = false;
    this.generation = 0;
    this.targetInspectionInFlight = false;
  }

  start() {
    this.running = true;
    this.generation++;
    this.syncPending = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.bootstrapTimer) {
      clearInterval(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }
    this.sync();
    // 冷启动前 15 秒采用 500ms 快频探测，一旦成功注入目标窗口立即自动退订，消除错失首拍干等 3 秒的冷启动延迟
    const bootstrapStart = Date.now();
    this.bootstrapTimer = setInterval(() => {
      if (!this.running || this.connections.size > 0 || (Date.now() - bootstrapStart >= 15000)) {
        if (this.bootstrapTimer) {
          clearInterval(this.bootstrapTimer);
          this.bootstrapTimer = null;
        }
        return;
      }
      this.sync();
    }, 500);
    this.pollTimer = setInterval(() => this.sync(), 3000);
  }

  stop() {
    this.running = false;
    this.generation++;
    this.syncPending = false;
    this.syncInFlight = false;
    this.targetInspectionInFlight = false;
    if (this.bootstrapTimer) {
      clearInterval(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
  }

  async sync() {
    if (!this.running) return;

    if (this.syncInFlight) {
      // 锁占用期间有新同步请求到达，设置 pending 标志，确保当前轮结束后再次执行以同步最新状态
      this.syncPending = true;
      return;
    }

    this.syncInFlight = true;
    this.targetInspectionInFlight = true;
    const currentGen = this.generation;

    try {
      // 循环处理，直到没有 pending 的请求，且当前生命周期仍有效
      do {
        this.syncPending = false;
        await this._performSync(currentGen);
        if (!this.running || this.generation !== currentGen) {
          break;
        }
      } while (this.syncPending && this.running && this.generation === currentGen);
    } finally {
      this.syncInFlight = false;
      this.targetInspectionInFlight = false;
    }
  }

  async _performSync(gen) {
    if (!this.running || this.generation !== gen) return;

    const targets = await this.discoverTargets(this.profileDir);
    if (!this.running || this.generation !== gen) return;

    if (targets !== null) {
      const activeUrls = new Set(targets.map(t => t.webSocketDebuggerUrl));

      // 仅当目标列表发现成功时，才按列表清理已经消失的页面
      for (const [url, conn] of this.connections.entries()) {
        if (!activeUrls.has(url) || conn.closed) {
          conn.close();
          this.connections.delete(url);
        }
      }
    } else {
      // 发现失败不代表页面消失：保留健康连接并继续巡检，仅移除本地已明确关闭的连接
      for (const [url, conn] of this.connections.entries()) {
        if (conn.closed) {
          conn.close();
          this.connections.delete(url);
        }
      }
    }

    if (!this.running || this.generation !== gen) return;

    // 连接新目标或巡检存量目标；发现失败时不引入新目标，但继续巡检所有存量连接
    const targetsToProcess = targets !== null
      ? targets
      : Array.from(this.connections.keys(), url => ({ webSocketDebuggerUrl: url }));

    for (const target of targetsToProcess) {
      if (!this.running || this.generation !== gen) return;

      const url = target.webSocketDebuggerUrl;
      let conn = this.connections.get(url);

      if (!conn) {
        logBridge(`Found new target: ${target.title || target.url || url}`);
        conn = new CdpConnection(url);
        try {
          await conn.open();
          if (!this.running || this.generation !== gen) {
            conn.close();
            return;
          }

          await conn.command('Runtime.enable');
          if (!this.running || this.generation !== gen) {
            conn.close();
            return;
          }

          await conn.command('Runtime.addBinding', { name: BINDING }).catch(() => {});
          if (!this.running || this.generation !== gen) {
            conn.close();
            return;
          }

          await conn.command('Runtime.evaluate', { expression: getBridgeScript(BINDING) });
          if (!this.running || this.generation !== gen) {
            conn.close();
            return;
          }

          const injectCode = `${this.widgetCode}\nif (typeof installAgContextRingWidget === 'function') { installAgContextRingWidget(); }`;
          await conn.command('Runtime.evaluate', { expression: injectCode });
          if (!this.running || this.generation !== gen) {
            conn.close();
            return;
          }

          this.connections.set(url, conn);
          logBridge(`Successfully connected and injected widget to ${url}`);
        } catch (err) {
          conn.close();
          continue;
        }
      } else {
        // 对已连接页面进行定期巡检，若页面发生路由重载或 Bridge 丢失，自动补漏注入
        try {
          const checkScript = `Boolean(window.__agContextRingInstalled && window.__agContextRingHost && window.__agContextRingBridge)`;
          const checkRes = await conn.command('Runtime.evaluate', { expression: checkScript, returnByValue: true });
          if (!this.running || this.generation !== gen) return;

          if (!checkRes?.result?.value) {
            await conn.command('Runtime.addBinding', { name: BINDING }).catch(() => {});
            if (!this.running || this.generation !== gen) return;

            await conn.command('Runtime.evaluate', { expression: getBridgeScript(BINDING) });
            if (!this.running || this.generation !== gen) return;

            const injectCode = `${this.widgetCode}\nif (typeof installAgContextRingWidget === 'function') { installAgContextRingWidget(); }`;
            await conn.command('Runtime.evaluate', { expression: injectCode });
          }
        } catch {
          conn.close();
          this.connections.delete(url);
        }
      }
    }
  }
}
