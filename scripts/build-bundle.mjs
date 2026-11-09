import { readFile, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

const bundleConfig = [
  {
    anchor: 'docs-llms-txt',
    file: 'docs/llms.txt',
    desc: '架构设计规约、模型物理截断阈值定义与核心机制说明',
    lang: 'markdown'
  },
  {
    anchor: 'sidecars-ring-sidecar-json',
    file: 'sidecars/ring/sidecar.json',
    desc: 'Antigravity 原生 Sidecar 元数据与生命周期守护配置',
    lang: 'json'
  },
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
    desc: '物理 Token 计算口径、工具输出重置顺序、模型切换重锚定与三层解耦',
    lang: 'javascript'
  },
  {
    anchor: 'sidecars-ring-context-service-mjs',
    file: 'sidecars/ring/context-service.mjs',
    desc: '快照格式化、权威总步数尾部窗口、会话识别失败防伪 0%、8s 缓存与 RPC 自愈',
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
    anchor: 'tests-integration-test-mjs',
    file: 'tests/integration.test.mjs',
    desc: '核心链路全场景与阶段三长会话分页熔断防死循环集成测试套件',
    lang: 'javascript'
  },
  {
    anchor: 'tests-clean-package-test-mjs',
    file: 'tests/clean-package.test.mjs',
    desc: '分发包端到端干净环境实测（ZIP 解压 -> 完整性清单 100% 断言 -> 无 BOM 检验 -> 心跳 200 -> 卸载闭环）',
    lang: 'javascript'
  },
  {
    anchor: 'tests-behavior-v1-2-test-mjs',
    file: 'tests/behavior-v1-2.test.mjs',
    desc: '行为级契约集成测试（组件轮询阶梯退避时序、CDP生命周期与在途请求追跑最新模型提示）',
    lang: 'javascript'
  },
  {
    anchor: 'tests-cache-v1-1-test-mjs',
    file: 'tests/cache-v1-1.test.mjs',
    desc: '双阶缓存架构与23项端到端验收场景回归测试套件（LRU淘汰、自愈、时序防线与去预热）',
    lang: 'javascript'
  },
  {
    anchor: 'tests-calculator-test-mjs',
    file: 'tests/calculator.test.mjs',
    desc: '物理Token计算核心与模型分母解耦单测套件（Checkpoint精确提取、工具增量叠加与压缩识别）',
    lang: 'javascript'
  },
  {
    anchor: 'tests-regression-v1-1-final-test-mjs',
    file: 'tests/regression-v1-1-final.test.mjs',
    desc: 'v1.1.0 最终封板专项回归测试套件（首页欢迎识别、冷会话防护、无障碍占位词清洗、尾部窗口去重与步号偏移）',
    lang: 'javascript'
  }
];

async function generateBundle() {
  const lines = [];
  lines.push('# Antigravity Context Ring v1.1.0 核心代码与架构审查合集\n');
  lines.push('> 本文档为面向 AI / 架构师的代码审查专用单文件合集（Review Bundle）。');
  lines.push('> 汇集了 v1.1.0 深度审查及 P0/P1/P2/P3 全部闭环修复后的完整运行时源码、生命周期管理脚本以及端到端稳定性/回归测试。');
  lines.push('> 包含最新修复：模型混合切换时由后续权威 Checkpoint 重锚定分母；超过 5000 步时读取权威总步数并聚焦最新尾部窗口；恰好 5000 步不再误报截断；新会话欢迎页（空白草稿）自适应精准识别（防伪装 0% 与真草稿兼顾）；PowerShell 空插件对象幂等更新；以及长会话分页熔断、CDP 超时防死锁、离线保帧、看门狗防自杀与 Connect-RPC 客户端收录。\n');
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
