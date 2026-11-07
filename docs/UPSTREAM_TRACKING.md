# 双上游项目持续跟踪与技术吸收档案 (UPSTREAM_TRACKING)

> **核心原则**：双上游持续进化，优秀能力择优吸收，产品架构独立维护。吸收上游的技术进步，不照搬上游的功能复杂度。

---

## 一、上游项目档案与跟踪基线

### 1. 上游 A：Antigrative Dashboard
- **GitHub 仓库**：[YOU-SHOULD-KNOW-ME/antigrative-dashboard](https://github.com/YOU-SHOULD-KNOW-ME/antigrative-dashboard)
- **原始参考领域**：UI 挂载与宿主集成机制（CDP、Sidecar、页面生命周期、DOM 挂载与恢复、缓存管理）
- **当前跟踪基准版本**：待初始化基线（待排查首个接入版本）
- **最近检查 Commit SHA**：`HEAD` (待确认)
- **最后检查日期**：2026-10-31
- **重点跟踪领域**：
  - Antigravity 页面及 Composer 的 UI 挂载机制
  - CDP 连接和页面通信
  - Sidecar 运行及生命周期管理
  - DOM 定位和页面重新挂载
  - 会话识别与数据通信
  - 缓存管理、持久化和请求去重
  - 后台任务、异步任务及并发控制
  - 页面刷新、宿主重启后的恢复机制
  - 插件安装、卸载与版本兼容
  - Antigravity 新版本带来的宿主集成变化

### 2. 上游 B：Antigravity Context Window Monitor
- **GitHub 仓库**：[AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor](https://github.com/AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor)
- **原始参考领域**：上下文追踪口径与模型阈值映射（Language Server/Hub、RPC 接口、Token 计算、压缩检测）
- **当前跟踪基准版本**：待初始化基线（待排查首个接入版本）
- **最近检查 Commit SHA**：`HEAD` (待确认)
- **最后检查日期**：2026-10-31
- **重点跟踪领域**：
  - Language Server 及 Hub 发现机制
  - RPC 接口变化和会话轨迹读取
  - 长会话完整分页读取
  - PlannerResponse 和 Checkpoint 数据提取
  - TokenUsage 精确用量与增量估算
  - Cache Read / Cache Creation Tokens
  - 模型身份识别及模型元数据
  - Platform Compression Limit 映射
  - Checkpoint 触发、上下文压缩与 Rewind 检测
  - 新模型适配及计算算法修复
  - 异常数据处理和准确性测试

---

## 二、技术领域跟踪优先级矩阵

| 技术领域 | Antigrative Dashboard | Context Window Monitor | 处置策略 |
|---|---|---|---|
| **UI 挂载与 DOM** | 重点 | 参考 | 以 Dashboard 方案为主，极简适配 |
| **CDP / Sidecar** | 重点 | 参考 | 以 Dashboard 方案为主，控制资源占用 |
| **页面生命周期** | 重点 | 参考 | 以 Dashboard 为主，确保刷新后恢复 |
| **缓存与持久化** | 重点 | 重点 | 横向对比，择优吸收，支持无感恢复 |
| **RPC / Language Server** | 参考 | 重点 | 以 Context Monitor 为主，对齐底层协议 |
| **会话轨迹读取** | 参考 | 重点 | 以 Context Monitor 为主，防长会话截断 |
| **TokenUsage 计算** | 参考 | 重点 | 以 Context Monitor 为主，保障精准度 |
| **模型识别与限额** | 参考 | 重点 | 以 Context Monitor 为主，快速跟进新模型 |
| **上下文压缩检测** | 参考 | 重点 | 以 Context Monitor 为主，监测 Rewind/压缩 |
| **异常恢复** | 重点 | 重点 | 结合两者，宿主断线与数据异常双重兜底 |
| **版本兼容** | 重点 | 重点 | 密切关注 Antigravity 宿主 API 变动 |

---

## 三、更新筛选标准与状态定义

### 1. 价值分类标准
- **A. 必须吸收**：核心功能正确性（Token 准确性、RPC/Hub 兼容、新模型识别、长会话修复、致命宿主兼容错误）。
- **B. 值得吸收**：体验与鲁棒性优化（请求合并、快照持久化、后台任务优化、Undo/Rewind 兜底、测试用例）。
- **C. 暂缓吸收**：有价值但需较重重构、增加外部依赖或当前阶段不经济的改动（必须记录原因，防止重复调研）。
- **D. 不吸收**：与极简上下文圆环无关的功能（完整统计面板、计费账本、配额管理系统、过重第三方依赖）。

### 2. 吸收状态状态机
- `待评估`：已发现上游更新，排队分析中。
- `准备吸收`：确认具备实际工程价值，进入待排期。
- `实施中`：正在本地分支进行移植、改造与测试。
- `已吸收`：已合并到本项目主干并完成回归测试。
- `暂缓`：技术上有可取之处，但当前阶段暂不引入（附原因）。
- `不吸收`：明确拒绝，不符合极简定位或 ROI 过低（附原因）。

---

## 四、上游更新审查记录流水

### 1. Antigrative Dashboard 追踪流水
| 检查日期 | 版本 / Commit | 涉及模块 | 更新摘要 | 价值评估 | 决策状态 | 本地影响文件 | 备注 / 暂缓原因 |
|---|---|---|---|---|---|---|---|
| 2026-10-31 | Initial | 基础设施 | 建立上游跟踪基线与归档机制 | - | 待评估 | - | 待获取上游最新 Release & Commit |
| 2026-10-31 | Phase 4 | CDP 与运行时 | 吸收 CDP 同步锁防并发重入与单例互斥看门狗 | B (值得) | 已吸收 | `runtime-bridge.mjs`, `main.mjs`, `tests/*` | 落实 `syncInFlight` 与 `--sidecar=antigravity-context-ring` 专属进程识别 |

### 2. Antigravity Context Window Monitor 追踪流水
| 检查日期 | 版本 / Commit | 涉及模块 | 更新摘要 | 价值评估 | 决策状态 | 本地影响文件 | 备注 / 暂缓原因 |
|---|---|---|---|---|---|---|---|
| 2026-10-31 | Initial | 基础设施 | 建立上游跟踪基线与归档机制 | - | 待评估 | - | 待获取上游最新 Release & Commit |
| 2026-10-31 | Phase 3 | 计算与 RPC | 吸收模型三层解耦、长会话分页拉取与 Cache Tokens 硬件核算 | A (必须) | 已吸收 | `context-calculator.mjs`, `context-service.mjs`, `tests/*` | 彻底杜绝子 Agent 篡改分母与 1000 步截断 |
| 2026-10-31 | Phase 4 | 服务发现与安全 | 吸收 `agy --hub` 进程识别、多格式/多参数 CSRF 兜底与跨平台健壮性 | A (必须) | 已吸收 | `ls-discovery.mjs`, `tests/*` | 支持中划线、引号包裹 CSRF Token，消除 Linux/macOS `extractFlag` 引用错误 |

---

## 五、单次审查与吸收标准流程模版

```markdown
### [YYYY-MM-DD] 双上游检查报告

#### 1. 检查摘要
| 上游项目 | 新版本 / Commit | 核心改动 | 实际价值 | 决策 |
|---|---|---|---|---|
| Antigrative Dashboard | - | - | 高 / 中 / 低 | 吸收 / 暂缓 / 不吸收 |
| Context Window Monitor | - | - | 高 / 中 / 低 | 吸收 / 暂缓 / 不吸收 |

#### 2. 深度评估问答
1. **上游有什么新东西？** 
2. **对我们的 Ring 有什么实际好处？** 
3. **我们当前是否已经具备？** 
4. **吸收需要修改哪些文件？** 
5. **是否会增加复杂度或引入兼容风险？** 
6. **最终决策与执行计划**：
```

---

## 六、版权与来源归属备忘
- 对于继承、移植或修改自上游的代码，必须在文件头部保留原作者的 MIT License 与 Copyright 声明。
- 在本地实现中明确标注：
  - `[Direct Port]`：直接移植代码
  - `[Adapted / Refactored]`：结合本项目架构重写实现
  - `[Inspired By]`：借鉴核心设计思想自主开发
- 禁止为了追求“代码整洁”抹去上游作者的版权归属信息。
