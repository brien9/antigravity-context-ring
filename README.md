<div align="center">

# Antigravity Context Ring

**专为 Google Antigravity 桌面客户端 (Antigravity App) 打造的原生级行内上下文长度监控圆环**  
*Native inline context telemetry for Google Antigravity Desktop App. Zero-invasion, RPC ground-truth, 0ms instant switch.*

[![Release](https://img.shields.io/badge/Release-v1.1.1-10b981?style=flat-square&logo=github)](https://github.com/brien9/antigravity-context-ring/releases)
[![Host](https://img.shields.io/badge/Host-Google%20Antigravity-4285f4?style=flat-square&logo=google&logoColor=white)](#)
[![Platforms](https://img.shields.io/badge/Platforms-Win%20%7C%20macOS%20%7C%20Linux-334155?style=flat-square)](#)

[![Telemetry](https://img.shields.io/badge/Telemetry-Connect--RPC%20Ground--Truth-06b6d4?style=flat-square)](#)
[![Non-Invasive](https://img.shields.io/badge/app.asar-100%25%20Untouched-3b82f6?style=flat-square)](#)
[![Latency](https://img.shields.io/badge/Session%20Switch-0ms%20SWR-6366f1?style=flat-square)](#)
[![Memory](https://img.shields.io/badge/Memory-~18MB%20Footprint-8b5cf6?style=flat-square)](#)

<a href="README.md">简体中文</a> | <a href="README_EN.md">English</a>

<br><br>

<img src="assets/hero-showcase.jpg" alt="Antigravity Context Ring - 19px native inline context window and token usage indicator for Google Antigravity App with frosted-glass HUD tooltip" width="580" style="max-width: 100%; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);">

</div>

---

## ⚡ 极速安装 · Quick Start

跨平台零外部依赖。若 Antigravity 正在运行，安装后数秒内自动热注入生效。

> [!TIP]
> **🤖 Agent 自动安装（推荐 · 零终端操作）**  
> 直接复制下方一句话发给你的 Antigravity 助理即可全自动装好：  
> `帮我克隆 https://github.com/brien9/antigravity-context-ring.git 并执行 node manage.mjs install`

### 💻 终端手动安装 · Manual

```bash
git clone https://github.com/brien9/antigravity-context-ring.git && cd antigravity-context-ring

# 执行对应平台安装：
node manage.mjs install    # 全平台通用（推荐）
.\install.ps1              # Windows (PowerShell)
sh ./install.sh            # macOS / Linux
```
<sub>运维管理：`node manage.mjs status`（状态检查） · `node manage.mjs uninstall`（一键干净卸载，重启宿主即恢复）</sub>

---

## 💡 为什么需要它？ · Why Context Ring?

底层模型原生的上下文多为 1M 级别，但 Antigravity 客户端按模型档案及远端策略执行分层物理截断（主流在役模型 **256K** / **Gemini 4 Hydrogen 256K** [运行时动态校准] / **GPT-OSS 120B 80K**），到点强制触发有损压缩，而官方 UI 全程不显示余量、压缩前也不预警。

Context Ring 把这根真实的截断线做成一颗 19px 的行内圆环：

| 核心维度 | 宿主原生默认 | 常见粗估方案 / 外部脚本 | Antigravity Context Ring |
| :--- | :--- | :--- | :--- |
| **截断分母基准** | 隐藏式管理，按模型与远端策略达 80K / 128K / 160K / 256K 自动压缩 | 多按 1M 或字符比估算，难反映实际截断线 | **对齐真实多级截断线**（主流 & Hydrogen 256K / GPT-OSS 80K）+ **动态限额自学习** |
| **Token 计量源** | 内部维持，界面未暴露实时读数 | 依赖字符估算，无法细分 Prompt Cache | **直读 Connect-RPC 快照**，解析真实 `modelUsage` |
| **交互形态** | 极简无额外元素 | 独立小窗口或终端命令打印 | **19px 原生行内圆环**，悬停即看毛玻璃 HUD |
| **多任务隔离** | 官方独立分屏 | 易受全局状态干扰，多屏时易混淆 | **React Fiber 与作用域隔离**，分屏 / `/btw` / Subagent / Swarm 互不串台 |
| **宿主安全性** | 官方原生 | 部分需解包修改 `app.asar` | **CDP 管道注入**，不改动宿主文件，常驻 ~18MB |

---

## 🎨 状态演进与分屏实测 · Visual States & Split View

### 1. 多阶状态演进与色彩反馈 (State Progression & Color Feedback)

圆环伴随上下文长度平滑演进。常规未压缩会话遵循四阶标准色标（科技蓝 `<60%` ➔ 琥珀黄 `60-80%` ➔ 暖橙 `80-90%` ➔ 纯正红 `≥90%`）；一旦检测到历史上下文发生过压缩（无论手动 `/compact` 还是自动压缩），在 `<60%` 安全期切换为清透的**薰衣草亮紫 (`#a78bfa`)** 标识“已压缩状态”，并在 `≥60%` 时自然衔接黄/橙/正红告警阶梯，直观清晰、不增加认知负担。

| 🟢 健康初期 (`< 60%`) | 🟡 注意过渡 (`60% ~ 80%`) |
| :---: | :---: |
| <img src="assets/state-low.jpg" alt="Google Antigravity context usage low state (<60%) - native blue inline SVG ring" width="100%" style="border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);"> | <img src="assets/state-medium.jpg" alt="Google Antigravity context usage medium state (60-80%) - amber warning ring" width="100%" style="border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);"> |
| 🔴 临限极危 (`≥ 90%`) | 🟣 历史已压缩 (`Compacted < 60%`) |
| <img src="assets/state-critical.jpg" alt="Google Antigravity context limit critical state (>=90%) - approaching 256K auto-compaction truncation threshold" width="100%" style="border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);"> | <img src="assets/state-compacted.jpg" alt="Google Antigravity auto-compaction triggered state - dual-track purple ring showing released context tokens" width="100%" style="border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);"> |

### 2. 多分屏独立隔离与实时联动 (Split View Isolation)

深度适配多 Composer 并行工作流，每个可见输入框拥有独立的生命周期与状态机实例（`Map<box, PaneRingInstance>`）：

<p align="center">
  <img src="assets/split-view-showcase.png" alt="Google Antigravity Split View multi-pane context monitoring isolated via React Fiber state tree" style="max-width: 100%; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.1);">
  <br>
  <em>多分屏实机：左屏 Gemini 3.8 Flash (草稿/健康) 与右屏 Gemini 4 Argon (活跃/警戒) 互不干扰，React Fiber 状态树天然隔离</em>
</p>

* **防串台铁律**：各分屏仅绑定自身 Fiber 节点，绝不回退读取全局路由，彻底杜绝“在右侧新建草稿却误偷左侧会话数据”的跨屏污染。
* **同会话跨屏共振**：当两个分屏同时打开同一个历史会话时，任一侧产生 Token 推进，两侧圆环毫秒级同步刷新。
* **全场景窗格与辅助视图适配**：全面覆盖主聊天分屏、分屏新建页、`/btw` 侧边提问，以及右侧辅助窗格中的 **Subagent / Swarm Worker** 对话标签页（`subagentView`）。通过独立作用域守卫避免将 Subagent / Swarm Worker 误判为 `/btw` 草稿态，在 `hideModelSelector` 无模型按钮或 Best-of-N 多选视图下直接读取 React Fiber `selectedModel`，并兼容 0 `USER_INPUT` 的消息驱动子代理轨迹。

---

## 🏗️ 核心工程机制 · Under the Hood

```mermaid
flowchart TD
    subgraph AntigravityHost["Google Antigravity 宿主环境"]
        LS["Language Server (Connect-RPC)"]
        Fiber["React Fiber 状态树 (agentStateProvider)"]
        UI["Composer 输入框容器 (Flexbox DOM)"]
    end

    subgraph SidecarEngine["Context Ring 守护进程 (~18MB)"]
        Discovery["ls-discovery<br/>环境变量直通与端口/CSRF 嗅探"]
        Rpc["rpc-client<br/>万步循环分页与防死锁"]
        Calc["context-calculator<br/>三层解耦、Plan-Execute 协同与动态自学习"]
        Bridge["runtime-bridge<br/>Target 过滤、CDP 安全注入与重载自愈"]
    end

    subgraph NativeWidget["前端微内核 (ring-widget.cjs)"]
        ShadowRoot["Shadow DOM 样式隔离"]
        RingDOM["19px SVG 原生圆环"]
        TooltipDOM["毛玻璃悬停胶囊 HUD"]
        SWRMap["双阶 SWR 缓存与限额自学习 (LocalStorage)"]
        FiberObserver["Fiber 事件管道 (onDidChange)"]
    end

    Discovery -->|"动态探针"| LS
    Rpc -->|"分页回溯 Checkpoint"| LS
    Rpc --> Calc
    Calc -->|"物理真值核算"| Bridge
    Bridge -->|"CDP 管道注入"| ShadowRoot
    ShadowRoot --> UI
    Fiber -->|"毫秒级状态共振"| FiberObserver
    FiberObserver --> SWRMap
    SWRMap --> RingDOM
    RingDOM -.->|"Hover 触发"| TooltipDOM
```

* **纯硬件级 RPC 快照（零字符猜测）**：遵循成熟 Harness 规范，直接从底层 Language Server 提取 `modelUsage` 结构，完整纳入输入、输出、`cacheReadTokens` 与 `cacheCreationTokens`。
* **三层模型解耦与 Plan-Execute 协同**：严格区分 `selectedModel`（UI 主选模型，唯一决定分母）、`executionModel`（当前步骤执行模型）与 `checkpointModel`（快照落盘模型）。既能根除普通 Subagent 临时调用轻量模型导致的进度条失真，也能精准识别 `Orchestrator (Argon)`（Plan `M668` ⇄ Execute 执行模型 `M669`）的同会话协同关系——锁住主分母不被执行模型篡改，同时允许执行步尾游标继续校准分母并准确捕获跨模型 `CHECKPOINT` 压缩；对 0 `USER_INPUT` 的 Swarm Worker 轨迹则结合 `SYSTEM_MESSAGE` 首轮估算与首个权威快照自动重锚定。
* **多级物理阈值与免维护动态自学习闭环**：基于 Language Server `model_profiles` 与实机 `CHECKPOINT` 触发点锁定真实分母——**Gemini 4 Hydrogen / Gemini 4 Argon / Orchestrator (Argon) / Gemini 4 Carbon / Gemini 3.8 Flash / Claude Opus & Sonnet 5.5 256K (256,000)**（注：Hydrogen 离线静态为 512K、线上默认压在 256K，Claude 5.5 命中 `claude-1m_840k` 等实验分支时按实测上限校准）、**Legacy M26/M35 & Claude 4 160K**、**Gemini 2.5 128K**、**GPT-OSS 120B 80K (80,000)**。通过尾游标 RPC `GetCascadeTrajectoryGeneratorMetadata` 读取运行态 `maxContextTokens` 与 `GetUserStatus`（兼容 `GetCascadeModelConfigData`）动态同步模型目录，将学到的限额与别名随快照透传并持久化至前端 `localStorage`，让草稿态与新模型无需手动更新静态表即可全自动对齐。
* **双阶 SWR 与 Never-Reset 防线**：内置 50 会话内存 LRU + 100 会话 LocalStorage 持久化快照。切换历史会话 0ms 渲染有效快照并后台静默校准；遇到窗口重载或 Language Server 偶发重启时，强制锁死最后一帧有效状态，绝不闪烁归零。
* **权威总步数 + 尾部窗口与重载自愈**：突破单次 RPC 查询的 1000 步限制，超过 5000 步时读取权威 `stepCount` 并聚焦最新 5000 步，确保当前 Checkpoint 不被旧前缀遮蔽；同时精确过滤 `data:` / `about:blank` / `plugin:` 等非应用 CDP Target，监听 `Runtime.executionContextCreated` 实现重载 0ms 瞬时重注，并优先通过宿主环境变量实现零进程扫描直连。

---

## ❓ 常见问题 · FAQ

<details>
<summary><strong>Q1: 如何在不修改 app.asar 文件的前提下，在 Google Antigravity 中实时查看 Token 消耗与上下文余量？</strong></summary>

> **A**: 本插件采用 **100% 零侵入架构**，绝不解包或修改任何宿主二进制及 `resources/app.asar` 文件。后台 Sidecar 守护进程通过 Chrome DevTools Protocol (CDP) 会话注入轻量级原生微内核，通过 Connect-RPC 协议与本地 Language Server 通信，直接读取 `modelUsage` 快照并挂载于输入框 DOM。宿主平滑更新不损坏，卸载后重启宿主即刻恢复出厂状态。
</details>

<details>
<summary><strong>Q2: 多 Agent（Subagent / Swarm）、/btw 侧边提问或多分屏编码时，如何避免进度条跳变与串台？</strong></summary>

> **A**: Context Ring 在前后端双向落实了**模型三层解耦**与**作用域隔离状态树**。分母容量严格由主选模型锁定，对 `Orchestrator (Argon)` 在 Plan（`M668`）与 Execution（`M669`）间双模型协同的场景也能锁死主分母并不断档追踪压缩；在前端，`Map<box, PaneRingInstance>` 严格区分主窗格、`/btw` 侧边提问（`sideQuestionView`）与右侧 Subagent / Swarm Worker 标签页（`subagentView`），在无模型按钮视图下通过 React Fiber `selectedModel` 直读模型提示，彻底杜绝串台与误判。
</details>

<details>
<summary><strong>Q3: 守护进程常驻后台是否会影响 Antigravity 性能或消耗大量内存？</strong></summary>

> **A**: **完全不会**。后端 Node.js 守护进程常驻内存仅约 **18MB**，CPU 占用接近 **0%**；前端注入层为纯原生 DOM + SVG 微内核（无 React/Vue 运行时开销），结合 250ms 智能防抖节流与宿主进程看门狗（宿主退出即自动协同退出），对编辑器渲染与打字输入零负担。
</details>

<details>
<summary><strong>Q4: Antigravity 客户端频繁更新、上线新模型或调整远端实验上限时，需要手动等插件发版吗？</strong></summary>

> **A**: **无需手动等待发版**。后端在运行态通过 `GetCascadeTrajectoryGeneratorMetadata` 捕获远端实际下发的 `maxContextTokens`，并按需结合 `GetUserStatus` 同步最新模型别名与目录，随即通过快照将动态限额字典透传给前端自学习并持久化到 `localStorage`。只要在客户端运行过一次，草稿态与跨重启冷启动即自动对齐最新上限。
</details>

---

## 📄 开源许可证 · License

本项目基于 [MIT 许可证](LICENSE) 开源发布。
