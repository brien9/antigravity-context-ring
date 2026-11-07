import { readFile, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

const bundleConfig = [
  {
    anchor: 'plugin-json',
    file: 'plugin.json',
    desc: '插件元数据声明与 Sidecar 启动配置',
    lang: 'json'
  },
  {
    anchor: 'install-ps1',
    file: 'install.ps1',
    desc: '一键安全安装脚本（含孤儿进程清理、无 BOM 写入与宿主绑定拉起）',
    lang: 'powershell'
  },
  {
    anchor: 'uninstall-ps1',
    file: 'uninstall.ps1',
    desc: '一键干净卸载脚本（精准杀灭 Sidecar、无 BOM 写入并清理目录）',
    lang: 'powershell'
  },
  {
    anchor: 'manage-mjs',
    file: 'manage.mjs',
    desc: '跨平台 CLI 生命周期管理与独立分发打包工具（install / status / uninstall / package）',
    lang: 'javascript'
  },
  {
    anchor: 'sidecars-ring-main-mjs',
    file: 'sidecars/ring/main.mjs',
    desc: 'Sidecar 守护进程入口、严格进程白名单、跨平台探针与安全看门狗空 PID 防自杀',
    lang: 'javascript'
  },
  {
    anchor: 'sidecars-ring-runtime-bridge-mjs',
    file: 'sidecars/ring/runtime-bridge.mjs',
    desc: 'CDP 目标发现、指令超时防死锁、防状态丢失 (syncPending) 与世代隔离引擎',
    lang: 'javascript'
  },
  {
    anchor: 'sidecars-ring-context-calculator-mjs',
    file: 'sidecars/ring/context-calculator.mjs',
    desc: '物理 Token 计算口径、工具输出重置顺序、长会话循环分页与模型三层解耦',
    lang: 'javascript'
  },
  {
    anchor: 'sidecars-ring-context-service-mjs',
    file: 'sidecars/ring/context-service.mjs',
    desc: '快照格式化、威胁等级优先级对齐、8s 内存穿透缓存与 RPC 自动重试自愈',
    lang: 'javascript'
  },
  {
    anchor: 'sidecars-ring-rpc-client-mjs',
    file: 'sidecars/ring/rpc-client.mjs',
    desc: 'Connect-RPC 底层网络通信客户端（含超时防挂起与 50MB 保护）',
    lang: 'javascript'
  },
  {
    anchor: 'sidecars-ring-ls-discovery-mjs',
    file: 'sidecars/ring/ls-discovery.mjs',
    desc: '语言服务进程发现、内存乐观缓存与跨平台 (Win/macOS/Linux) 端口探活探针',
    lang: 'javascript'
  },
  {
    anchor: 'sidecars-ring-model-limits-mjs',
    file: 'sidecars/ring/model-limits.mjs',
    desc: '各模型真实物理截断阈值静态映射表',
    lang: 'javascript'
  },
  {
    anchor: 'assets-ring-widget-cjs',
    file: 'assets/ring-widget.cjs',
    desc: '前端 DOM 注入微内核、输入框挂载、绝不清零防线、离线恢复状态同步、无泄漏监听与 SWR 缓存状态机',
    lang: 'javascript'
  },
  {
    anchor: 'tests-regression-p0-p1-test-mjs',
    file: 'tests/regression-p0-p1.test.mjs',
    desc: 'P0/P1/P2/P3 缺陷闭环专项回归测试套件（含离线恢复状态同步、CDP 超时防死锁、无泄漏监听）',
    lang: 'javascript'
  },
  {
    anchor: 'tests-regression-argon-fixes-test-mjs',
    file: 'tests/regression-argon-fixes.test.mjs',
    desc: 'Argon 专项审计与深度边界回归测试套件（含工具输出增量放行、测试沙箱进程隔离、L2 缓存回退、模型切换即时刷新与占位符分母映射）',
    lang: 'javascript'
  },
  {
    anchor: 'tests-stability-v1-1-test-mjs',
    file: 'tests/stability-v1-1.test.mjs',
    desc: '阶段四稳定性集成测试（syncPending、generation 隔离、真实 Windows CIM 误杀防范与看门狗实测）',
    lang: 'javascript'
  },
  {
    anchor: 'tests-clean-package-test-mjs',
    file: 'tests/clean-package.test.mjs',
    desc: '分发包端到端干净环境实测（ZIP 解压 -> 完整性清单 100% 断言 -> 无 BOM 检验 -> 心跳 200 -> 卸载闭环）',
    lang: 'javascript'
  }
];

async function generateBundle() {
  const lines = [];
  lines.push('# Antigravity Context Ring v1.1.0 核心代码与架构审查合集\n');
  lines.push('> 本文档为面向 AI / 架构师的代码审查专用单文件合集（Review Bundle）。');
  lines.push('> 汇集了 v1.1.0 深度审查及 P0/P1/P2/P3 全部闭环修复后的完整运行时源码、生命周期管理脚本以及端到端稳定性/回归测试。');
  lines.push('> 包含最新修复：CDP 命令超时防死锁、前端 updateView 绝不清零与离线恢复 DOM 同步、PowerShell 5.1 无 BOM 写入、非 Win 看门狗空 PID 防自杀、Connect-RPC 客户端收录、完整性断言 100% 覆盖。\n');
  lines.push('## 目录索引\n');

  bundleConfig.forEach((item, idx) => {
    lines.push(`${idx + 1}. [${item.file}](#${item.anchor}) - ${item.desc}`);
  });
  lines.push('\n---\n');

  for (const item of bundleConfig) {
    const rawContent = await readFile(join(ROOT, item.file), 'utf8');
    const content = rawContent.replace(/^\uFEFF/, '');
    lines.push(`## <a id="${item.anchor}"></a> ${item.file}\n`);
    lines.push(`* **作用说明**：${item.desc}`);
    lines.push(`* **文件路径**：\`${item.file}\`\n`);
    lines.push(`\`\`\`${item.lang}`);
    lines.push(content.trimEnd());
    lines.push('```\n');
    lines.push('---\n');
  }

  const output = lines.join('\n');
  const bundleFile = join(ROOT, 'REVIEW_BUNDLE_V1.1.0.md');
  const distBundleFile = join(ROOT, 'dist', 'REVIEW_BUNDLE_V1.1.0.md');
  await writeFile(bundleFile, output, 'utf8');
  await writeFile(distBundleFile, output, 'utf8');
  console.log(`Successfully generated review bundle: ${bundleFile}`);
}

generateBundle();
