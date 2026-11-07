import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as http from 'node:http';
import * as https from 'node:https';

const execFileAsync = promisify(execFile);

let cachedLsInfo = null;
let lastDiscoveryTime = 0;
let inFlightDiscovery = null;
let inFlightIsForce = false;
const CACHE_TTL_MS = 60_000;
const DISK_CACHE_FILE = join(tmpdir(), 'antigravity-ls-cache.json');

function readDiskCache() {
  try {
    const raw = readFileSync(DISK_CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (
      data &&
      Number.isInteger(data.port) &&
      data.port > 0 &&
      data.port <= 65535 &&
      typeof data.csrfToken === 'string' &&
      data.csrfToken.length > 0 &&
      typeof data.useTls === 'boolean'
    ) {
      return data;
    }
  } catch {}
  return null;
}

function writeDiskCache(info) {
  try {
    writeFileSync(DISK_CACHE_FILE, JSON.stringify(info), 'utf8');
  } catch {}
}

export function extractTokenAndPid(line) {
  if (!line || typeof line !== 'string') return null;
  // 提取 PID：支持 CSV 首列格式（"12345", 或 12345,）或空格格式（ 12345 /path）
  const pidMatch = line.match(/^"?(\d+)"?,/) || line.match(/^\s*(\d+)\b/);
  if (!pidMatch) return null;
  const pid = parseInt(pidMatch[1], 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  // 提取 CSRF Token：吸收 source-monitor 发现机制，支持 --csrf_token, --csrf-token, -csrf_token, -csrf-token, --token 等多种变体
  // 兼容 key=val, key val, key:val 以及单双引号、转义引号包裹
  const tokenMatch = line.match(/(?:--|-)(?:csrf[-_]token|token)(?:=|\s+|:)+[\\"']*([a-zA-Z0-9_-]{24,64})[\\"']*/i);
  if (tokenMatch) {
    return {
      pid,
      csrfToken: tokenMatch[1]
    };
  }
  return null;
}

export function isCandidateServerLine(line) {
  if (!line || typeof line !== 'string') return false;
  const lower = line.toLowerCase();
  return lower.includes('language_server') ||
         lower.includes('agy') ||
         lower.includes('--hub') ||
         lower.includes('csrf');
}

/**
 * 探活指定端口与 TLS 组合
 */
function probePort(port, csrfToken, useTls, timeoutMs = 2000) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || typeof csrfToken !== 'string') {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      const transport = useTls ? https : http;
      const postData = JSON.stringify({
        metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
      });

      const req = transport.request({
        hostname: '127.0.0.1',
        port,
        path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrfToken,
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: timeoutMs,
        rejectUnauthorized: false
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = JSON.parse(data);
              resolve(json !== null && typeof json === 'object');
            } catch {
              resolve(false);
            }
          } else {
            resolve(false);
          }
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.write(postData);
      req.end();
    } catch {
      resolve(false);
    }
  });
}

/**
 * 获取指定 PID 在 Windows netstat 中监听的本地端口列表
 */
async function getWindowsListeningPorts(pid) {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { encoding: 'utf8', timeout: 5000 });
    const ports = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      const match = trimmed.match(/\s(\d+)$/);
      if (match && match[1] === String(pid)) {
        if (trimmed.includes('LISTENING') || trimmed.includes('0.0.0.0:0') || trimmed.includes('[::]:0')) {
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 2) {
            const addr = parts[1];
            const portMatch = addr.match(/:(\d+)$/);
            if (portMatch) {
              const port = parseInt(portMatch[1], 10);
              if (port > 0 && port <= 65535 && !ports.includes(port)) {
                ports.push(port);
              }
            }
          }
        }
      }
    }
    return ports;
  } catch {
    return [];
  }
}

/**
 * 获取指定 PID 在 macOS / Linux 下监听的本地端口列表（lsof 优先，ss -tlnp 兜底）
 */
async function getUnixListeningPorts(pid) {
  const ports = [];
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000
    });
    for (const line of stdout.split('\n')) {
      const match = line.match(/:(\d+)\s+\(LISTEN\)/i);
      if (match) {
        const port = parseInt(match[1], 10);
        if (port > 0 && port <= 65535 && !ports.includes(port)) {
          ports.push(port);
        }
      }
    }
  } catch {}

  if (ports.length === 0 && process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('ss', ['-tlnp'], { encoding: 'utf8', timeout: 5000 });
      const pidTag = `pid=${pid},`;
      for (const line of stdout.split('\n')) {
        if (!line.includes(pidTag) && !line.includes(`pid=${pid})`)) continue;
        const cols = line.trim().split(/\s+/);
        const localAddr = cols[3] || '';
        const portMatch = localAddr.match(/:(\d+)$/);
        if (portMatch) {
          const port = parseInt(portMatch[1], 10);
          if (port > 0 && port <= 65535 && !ports.includes(port)) {
            ports.push(port);
          }
        }
      }
    } catch {}
  }

  return ports;
}

/**
 * 并行探活候选端口列表（首个响应成功的 Connect-RPC 端口立即胜出，消除非 HTTP 端口串行超时等待）
 */
function findWorkingPort(ports, csrfToken, timeoutMs = 1500) {
  if (!Array.isArray(ports) || ports.length === 0) return Promise.resolve(null);
  const candidates = [];
  for (const port of ports) {
    candidates.push({ port, useTls: false });
    candidates.push({ port, useTls: true });
  }
  return new Promise((resolve) => {
    let pending = candidates.length;
    let settled = false;
    for (const item of candidates) {
      probePort(item.port, csrfToken, item.useTls, timeoutMs)
        .catch(() => false)
        .then((ok) => {
          if (settled) return;
          if (ok) {
            settled = true;
            resolve(item);
            return;
          }
          pending--;
          if (pending === 0) {
            settled = true;
            resolve(null);
          }
        });
    }
  });
}

/**
 * 发现当前运行中的 Antigravity 语言服务器（含并发请求合并防重入锁）
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<Object|null>}
 */
export async function discoverLanguageServer(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedLsInfo && (now - lastDiscoveryTime < CACHE_TTL_MS)) {
    return cachedLsInfo;
  }

  // 并发合并：若已有发现任务在途且满足刷新级别，直接复用同一 Promise，避免并发拉起多个 PowerShell 进程
  if (inFlightDiscovery && (!forceRefresh || inFlightIsForce)) {
    return inFlightDiscovery;
  }

  const runPromise = _performDiscovery(forceRefresh).finally(() => {
    if (inFlightDiscovery === runPromise) {
      inFlightDiscovery = null;
      inFlightIsForce = false;
    }
  });
  inFlightDiscovery = runPromise;
  inFlightIsForce = Boolean(forceRefresh);
  return runPromise;
}

async function _performDiscovery(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh) {
    if (cachedLsInfo && (now - lastDiscoveryTime < CACHE_TTL_MS)) {
      return cachedLsInfo;
    }

    // 磁盘级跨进程持久化缓存探活
    const diskCache = readDiskCache();
    if (diskCache) {
      const alive = await probePort(diskCache.port, diskCache.csrfToken, diskCache.useTls, 250);
      if (alive) {
        cachedLsInfo = diskCache;
        lastDiscoveryTime = Date.now();
        return cachedLsInfo;
      }
    }
  } else {
    cachedLsInfo = null;
  }

  try {
    if (process.platform === 'win32') {
      const candidates = [];
      const seenPids = new Set();
      const collectCandidates = (lineList) => {
        for (const line of lineList) {
          if (isCandidateServerLine(line)) {
            const info = extractTokenAndPid(line);
            if (info && !seenPids.has(info.pid)) {
              seenPids.add(info.pid);
              candidates.push(info);
            }
          }
        }
      };

      const psScript = 'Get-CimInstance Win32_Process -Filter "Name like \'language_server%\' or Name = \'agy.exe\' or Name = \'agy\'" | Select-Object ProcessId, CommandLine | ConvertTo-Csv -NoTypeInformation';
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NoLogo', '-Command', psScript], {
        encoding: 'utf8',
        timeout: 10000
      });

      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      collectCandidates(lines);

      if (candidates.length === 0) {
        try {
          const fallbackPsScript = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*--hub*" -or $_.CommandLine -like "*--csrf*" } | Select-Object ProcessId, CommandLine | ConvertTo-Csv -NoTypeInformation';
          const { stdout: fallbackStdout } = await execFileAsync('powershell', ['-NoProfile', '-NoLogo', '-Command', fallbackPsScript], {
            encoding: 'utf8',
            timeout: 5000
          });
          const fallbackLines = fallbackStdout.split('\n').map(l => l.trim()).filter(Boolean);
          collectCandidates(fallbackLines);
        } catch {}
      }

      for (const cand of candidates) {
        const ports = await getWindowsListeningPorts(cand.pid);
        const working = await findWorkingPort(ports, cand.csrfToken);
        if (working) {
          cachedLsInfo = { pid: cand.pid, port: working.port, csrfToken: cand.csrfToken, useTls: working.useTls };
          lastDiscoveryTime = Date.now();
          writeDiskCache(cachedLsInfo);
          return cachedLsInfo;
        }
      }
    } else {
      const candidates = [];
      const seenPids = new Set();
      const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 5000 });
      for (const line of stdout.split('\n')) {
        if (isCandidateServerLine(line)) {
          const info = extractTokenAndPid(line);
          if (info && !seenPids.has(info.pid)) {
            seenPids.add(info.pid);
            candidates.push(info);
          }
        }
      }

      for (const cand of candidates) {
        const ports = await getUnixListeningPorts(cand.pid);
        const working = await findWorkingPort(ports, cand.csrfToken);
        if (working) {
          cachedLsInfo = { pid: cand.pid, port: working.port, csrfToken: cand.csrfToken, useTls: working.useTls };
          lastDiscoveryTime = Date.now();
          writeDiskCache(cachedLsInfo);
          return cachedLsInfo;
        }
      }
    }
  } catch (err) {
    // 发现阶段静默容错
  }

  return null;
}
