import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, statSync, lstatSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import * as http from 'node:http';
import * as https from 'node:https';

const execFileAsync = promisify(execFile);

let cachedLsInfo = null;
let cachedAllLsList = null;
let lastDiscoveryTime = 0;
let inFlightDiscovery = null;
let inFlightIsForce = false;
let isDiskRestoredSingle = false;
const CACHE_TTL_MS = 60_000;
const NEGATIVE_CACHE_TTL_MS = 5_000;

function isCacheValid(now) {
  if (!cachedAllLsList) return false;
  const ttl = cachedAllLsList.length > 0 ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
  return (now - lastDiscoveryTime < ttl);
}

/**
 * 获取跨进程持久化缓存文件路径
 * 优先级：测试隔离沙箱 > Windows 用户 AppData > POSIX XDG_RUNTIME_DIR (0700私有目录) > ~/.gemini 目录 > 带 UID 隔离的 Temp 目录
 */
export function getDiskCacheFile() {
  if (process.env.AGY_TEST_TARGET_DIR) {
    return join(process.env.AGY_TEST_TARGET_DIR, 'antigravity-ls-cache.json');
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || tmpdir();
    return join(base, 'antigravity-ls-cache.json');
  }
  if (process.env.XDG_RUNTIME_DIR) {
    return join(process.env.XDG_RUNTIME_DIR, 'antigravity-ls-cache.json');
  }
  const home = homedir();
  if (home) {
    return join(home, '.gemini', 'antigravity-ls-cache.json');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'default';
  return join(tmpdir(), `antigravity-user-${uid}`, 'antigravity-ls-cache.json');
}

export const DISK_CACHE_FILE = getDiskCacheFile();

export function readDiskCache() {
  try {
    const targetFile = getDiskCacheFile();
    try {
      const stat = lstatSync(targetFile);
      if (stat.isSymbolicLink()) {
        rmSync(targetFile, { force: true });
        return null;
      }
    } catch {
      return null;
    }
    const raw = readFileSync(targetFile, 'utf8');
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

export function writeDiskCache(info) {
  if (
    !info ||
    !Number.isInteger(info.port) ||
    info.port <= 0 ||
    info.port > 65535 ||
    typeof info.csrfToken !== 'string' ||
    !info.csrfToken ||
    typeof info.useTls !== 'boolean'
  ) {
    return;
  }
  try {
    const targetFile = getDiskCacheFile();
    const targetDir = dirname(targetFile);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    } else {
      if (typeof process.getuid === 'function') {
        try {
          const dirStat = statSync(targetDir);
          if (dirStat.uid !== process.getuid()) {
            return;
          }
        } catch {}
      }
      try {
        chmodSync(targetDir, 0o700);
      } catch {}
    }
    try {
      const stat = lstatSync(targetFile);
      if (stat.isSymbolicLink()) {
        rmSync(targetFile, { force: true });
      }
    } catch {}
    // 权限显式设为 0600 (仅当前所有者可读写)，杜绝多用户主机或共享环境下的 CSRF Token 越权读取
    writeFileSync(targetFile, JSON.stringify(info), { mode: 0o600, encoding: 'utf8' });
    try {
      chmodSync(targetFile, 0o600);
    } catch {}
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
      csrfToken: tokenMatch[1],
      commandLine: line
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
         lower.includes('csrf') ||
         lower.includes('subclient_type') ||
         lower.includes('override_ide_name');
}

/**
 * 计算语言服务器候选进程的优先级评分
 * 官方 Hub 特征置顶：--subclient_type hub / --override_ide_name antigravity
 */
export function getCandidatePriorityScore(lineOrCand) {
  const line = typeof lineOrCand === 'string' ? lineOrCand : (lineOrCand?.commandLine || lineOrCand?.cmd || '');
  if (!line) return 0;
  let score = 0;
  // 官方 Hub 特征 1: --subclient_type hub (兼容等号、空格以及单双引号、转义引号包裹)
  if (/(?:^|\s|--|-)(?:subclient_type)(?:=|\s+|:)+[\\"']*hub[\\"']*(?:\s|$|[\\"'])/i.test(line) ||
      line.toLowerCase().includes('subclient_type=hub') || line.toLowerCase().includes('subclient_type hub')) {
    score += 100;
  }
  // 官方 Hub 特征 2: --override_ide_name antigravity (兼容等号、空格以及单双引号、转义引号包裹)
  if (/(?:^|\s|--|-)(?:override_ide_name)(?:=|\s+|:)+[\\"']*antigravity[\\"']*(?:\s|$|[\\"'])/i.test(line) ||
      line.toLowerCase().includes('override_ide_name=antigravity') || line.toLowerCase().includes('override_ide_name antigravity')) {
    score += 100;
  }
  // 辅助 Hub 标识: --hub
  if (/(?:^|\s)(?:--|-)hub(?:\s|=|$)/i.test(line)) {
    score += 50;
  }
  return score;
}

/**
 * 候选进程加权排序：官方 Hub 特征置顶，进程创建时间（Windows CreationDate 最新，POSIX PID 倒序）排在最前
 */
export function sortCandidates(candidates, platform = process.platform) {
  if (!Array.isArray(candidates)) return [];
  const valid = candidates.filter(c => c && typeof c === 'object');
  return valid.sort((a, b) => {
    const scoreA = getCandidatePriorityScore(a);
    const scoreB = getCandidatePriorityScore(b);
    if (scoreA !== scoreB) {
      return scoreB - scoreA; // 优先级加权高者置顶
    }
    if (a?.creationDate || b?.creationDate) {
      const timeA = a?.creationDate ? new Date(a.creationDate).getTime() : NaN;
      const timeB = b?.creationDate ? new Date(b.creationDate).getTime() : NaN;
      if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) {
        return timeB - timeA;
      }
      if (!isNaN(timeA) && isNaN(timeB)) return -1;
      if (isNaN(timeA) && !isNaN(timeB)) return 1;
    }
    if (platform === 'win32') {
      if (a?.orderIndex !== undefined && b?.orderIndex !== undefined && a.orderIndex !== b.orderIndex) {
        return a.orderIndex - b.orderIndex; // PowerShell Sort-Object CreationDate -Descending，序号小者代表最新
      }
      return (b?.pid || 0) - (a?.pid || 0);
    } else {
      return (b?.pid || 0) - (a?.pid || 0);
    }
  });
}

/**
 * 探活指定端口与 TLS 组合
 */
export function probePort(port, csrfToken, useTls, timeoutMs = 2000) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || typeof csrfToken !== 'string') {
    return Promise.resolve(false);
  }
  return new Promise((rawResolve) => {
    // 单次结算守卫：响应中途断开时 socket 已销毁、timeout 不再触发，必须由 close 兜底结算，
    // 否则 inFlightDiscovery 永久挂起，后续所有发现请求都会复用这个死 Promise
    let settled = false;
    const resolve = (val) => {
      if (settled) return;
      settled = true;
      rawResolve(val);
    };
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
        res.on('error', () => resolve(false));
        res.on('close', () => {
          if (!res.complete) resolve(false);
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
 * 解析 Antigravity 官方 Sidecar 运行时注入的环境变量直连参数
 * (ANTIGRAVITY_LS_ADDRESS + ANTIGRAVITY_CSRF_TOKEN)
 */
export function parseEnvLanguageServer(env = process.env) {
  if (!env || typeof env !== 'object') return null;
  const rawAddr = typeof env.ANTIGRAVITY_LS_ADDRESS === 'string' ? env.ANTIGRAVITY_LS_ADDRESS.trim() : '';
  const rawToken = typeof env.ANTIGRAVITY_CSRF_TOKEN === 'string' ? env.ANTIGRAVITY_CSRF_TOKEN.trim() : '';
  if (!rawAddr || !rawToken) return null;

  const portMatch = rawAddr.match(/:(\d+)(?:\/.*)?$/);
  if (!portMatch) return null;
  const port = parseInt(portMatch[1], 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  const explicitPid = parseInt(String(env.ANTIGRAVITY_LS_PID || ''), 10);
  const pid = (Number.isInteger(explicitPid) && explicitPid > 0) ? explicitPid : (Number(process.ppid) || 0);

  return {
    pid,
    port,
    csrfToken: rawToken
  };
}

/**
 * 探活环境变量注入的 Language Server 地址（零子进程开销，<3ms 极速直连）
 */
export async function probeEnvLanguageServer(env = process.env, timeoutMs = 400) {
  const parsed = parseEnvLanguageServer(env);
  if (!parsed) return null;
  const working = await findWorkingPort([parsed.port], parsed.csrfToken, timeoutMs);
  if (!working) return null;
  return {
    pid: parsed.pid,
    port: working.port,
    csrfToken: parsed.csrfToken,
    useTls: working.useTls
  };
}

/**
 * 发现当前运行中的所有存活且响应正常的 Antigravity 语言服务器（按优先级排序，首选排在第 0 位）
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<Array<Object>>}
 */
export async function discoverAllLanguageServers(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && !isDiskRestoredSingle && isCacheValid(now)) {
    return cachedAllLsList;
  }

  // 并发合并：若已有发现任务在途且满足刷新级别，直接复用同一 Promise
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

/**
 * 发现当前运行中的首选 Antigravity 语言服务器（含并发请求合并防重入锁，保持调用方 100% 兼容）
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<Object|null>}
 */
export async function discoverLanguageServer(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedLsInfo && (now - lastDiscoveryTime < CACHE_TTL_MS)) {
    return cachedLsInfo;
  }
  if (!forceRefresh && cachedAllLsList && cachedAllLsList.length === 0 && (now - lastDiscoveryTime < NEGATIVE_CACHE_TTL_MS)) {
    return null;
  }

  // 磁盘级跨进程持久化缓存探活（仅在非强制刷新且无内存首选时作为秒开捷径）
  if (!forceRefresh) {
    const diskCache = readDiskCache();
    if (diskCache) {
      const alive = await probePort(diskCache.port, diskCache.csrfToken, diskCache.useTls, 250);
      if (alive) {
        cachedLsInfo = diskCache;
        cachedAllLsList = [diskCache];
        lastDiscoveryTime = Date.now();
        isDiskRestoredSingle = true;
        return cachedLsInfo;
      }
    }

    // 环境变量极速直连通道（当无可用磁盘缓存或宿主重启后旧端口已死时，优先探活官方注入的 ANTIGRAVITY_LS_ADDRESS）
    if (!process.env.AGY_TEST_TARGET_DIR) {
      const envLs = await probeEnvLanguageServer(process.env, 350);
      if (envLs) {
        cachedLsInfo = envLs;
        cachedAllLsList = [envLs];
        lastDiscoveryTime = Date.now();
        isDiskRestoredSingle = true;
        writeDiskCache(envLs);
        return cachedLsInfo;
      }
    }
  }

  const all = await discoverAllLanguageServers(forceRefresh);
  return (Array.isArray(all) && all.length > 0) ? all[0] : null;
}

async function _performDiscovery(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && !isDiskRestoredSingle && isCacheValid(now)) {
    return cachedAllLsList;
  }

  if (forceRefresh) {
    cachedLsInfo = null;
    cachedAllLsList = null;
    isDiskRestoredSingle = false;
  }

  try {
    const workingServers = [];
    if (process.platform === 'win32') {
      const candidates = [];
      const seenPids = new Set();
      const collectCandidates = (lineList) => {
        for (let idx = 0; idx < lineList.length; idx++) {
          const line = lineList[idx];
          if (isCandidateServerLine(line)) {
            const info = extractTokenAndPid(line);
            if (info && !seenPids.has(info.pid)) {
              seenPids.add(info.pid);
              candidates.push({
                ...info,
                orderIndex: idx
              });
            }
          }
        }
      };

      const psScript = 'Get-CimInstance Win32_Process -Filter "Name like \'language_server%\' or Name = \'agy.exe\' or Name = \'agy\'" | Sort-Object CreationDate -Descending | Select-Object ProcessId, CommandLine | ConvertTo-Csv -NoTypeInformation';
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NoLogo', '-Command', psScript], {
        encoding: 'utf8',
        timeout: 10000
      });

      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      collectCandidates(lines);

      if (candidates.length === 0) {
        try {
          const fallbackPsScript = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*--hub*" -or $_.CommandLine -like "*--csrf*" -or $_.CommandLine -like "*--subclient_type*" -or $_.CommandLine -like "*--override_ide_name*" } | Sort-Object CreationDate -Descending | Select-Object ProcessId, CommandLine | ConvertTo-Csv -NoTypeInformation';
          const { stdout: fallbackStdout } = await execFileAsync('powershell', ['-NoProfile', '-NoLogo', '-Command', fallbackPsScript], {
            encoding: 'utf8',
            timeout: 5000
          });
          const fallbackLines = fallbackStdout.split('\n').map(l => l.trim()).filter(Boolean);
          collectCandidates(fallbackLines);
        } catch {}
      }

      const sorted = sortCandidates(candidates, 'win32');
      candidates.splice(0, candidates.length, ...sorted);

      for (const cand of candidates) {
        const ports = await getWindowsListeningPorts(cand.pid);
        const working = await findWorkingPort(ports, cand.csrfToken);
        if (working) {
          workingServers.push({
            pid: cand.pid,
            port: working.port,
            csrfToken: cand.csrfToken,
            useTls: working.useTls
          });
        }
      }
    } else {
      const candidates = [];
      const seenPids = new Set();
      const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 5000 });
      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        if (isCandidateServerLine(line)) {
          const info = extractTokenAndPid(line);
          if (info && !seenPids.has(info.pid)) {
            seenPids.add(info.pid);
            candidates.push({
              ...info,
              orderIndex: idx
            });
          }
        }
      }

      const sorted = sortCandidates(candidates, process.platform);
      candidates.splice(0, candidates.length, ...sorted);

      for (const cand of candidates) {
        const ports = await getUnixListeningPorts(cand.pid);
        const working = await findWorkingPort(ports, cand.csrfToken);
        if (working) {
          workingServers.push({
            pid: cand.pid,
            port: working.port,
            csrfToken: cand.csrfToken,
            useTls: working.useTls
          });
        }
      }
    }

    if (!process.env.AGY_TEST_TARGET_DIR) {
      const envParsed = parseEnvLanguageServer(process.env);
      if (envParsed && !workingServers.some(s => s.port === envParsed.port)) {
        const envWorking = await probeEnvLanguageServer(process.env, 400);
        if (envWorking) {
          workingServers.unshift(envWorking);
        }
      }
    }

    if (workingServers.length > 0) {
      cachedAllLsList = workingServers;
      cachedLsInfo = workingServers[0];
      lastDiscoveryTime = Date.now();
      isDiskRestoredSingle = false;
      writeDiskCache(cachedLsInfo);
      return workingServers;
    }
  } catch (err) {
    // 发现阶段静默容错
  }

  cachedAllLsList = [];
  cachedLsInfo = null;
  lastDiscoveryTime = Date.now();
  isDiskRestoredSingle = false;
  return [];
}

export function clearCachedLanguageServer() {
  cachedLsInfo = null;
  cachedAllLsList = null;
  lastDiscoveryTime = 0;
  isDiskRestoredSingle = false;
}

/**
 * 诊断辅助接口（供测试状态验证与重置）
 */
export function _getLsDiscoveryCacheInfo() {
  return {
    cachedLsInfo,
    cachedAllLsList: cachedAllLsList ? [...cachedAllLsList] : null,
    lastDiscoveryTime,
    isDiskRestoredSingle,
    clear: () => {
      clearCachedLanguageServer();
    }
  };
}
