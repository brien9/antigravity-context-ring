<div align="center">

# Antigravity Context Ring

**Native inline context window monitor & token usage telemetry for Google Antigravity Desktop App (Antigravity App)**  
*Zero-invasion, Connect-RPC ground-truth, 0ms instant switch, ~18MB footprint.*

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

## ⚡ Quick Start

Zero external dependencies. Hot-injected into running Antigravity App within seconds.

> [!TIP]
> **🤖 Agent Auto-Install (Recommended · Zero Terminal Interaction)**  
> Simply copy and send this prompt to your Antigravity Assistant:  
> `Clone https://github.com/brien9/antigravity-context-ring.git and run node manage.mjs install`

### 💻 Manual Installation

```bash
git clone https://github.com/brien9/antigravity-context-ring.git && cd antigravity-context-ring

# Run the installer for your environment:
node manage.mjs install    # Universal (Recommended)
.\install.ps1              # Windows (PowerShell)
sh ./install.sh            # macOS / Linux
```
<sub>Management: `node manage.mjs status` (inspect) · `node manage.mjs uninstall` (clean rollback, resets upon host restart)</sub>

---

## 💡 Why Context Ring?

Foundation models natively support ~1M context, but the Antigravity client enforces per-model & remote-experiment truncation thresholds (**256K** online baseline for most active models including Gemini 4 Hydrogen [with runtime dynamic calibration], **160K / 128K** legacy, **80K** for GPT-OSS 120B) and forces lossy compaction at those cutoffs. The native UI never shows remaining context and never warns before it happens.

**Context Ring** turns that real cutoff into a 19px inline ring:

| Dimension | Native Host UI | Heuristic Scripts / Approx | Antigravity Context Ring |
| :--- | :--- | :--- | :--- |
| **Denominator Baseline** | Silent auto-compaction at 80K / 128K / 160K / 256K | Often assumes 1M, missing actual limit | **Mapped to real multi-tier cutoffs + self-learning `maxContextTokens` sync** |
| **Token Measurement** | Internal tracking; no live indicator | Character approximations, misses cache tokens | **Connect-RPC snapshots** from real `modelUsage` |
| **UI Integration** | Clean, distraction-free | Detached floating window or CLI polling | **19px inline SVG ring** with frosted-glass HUD on hover |
| **Multi-Pane Concurrency**| Native split panes | Susceptible to global route crosstalk | **React Fiber & scope isolation** across Split View, `/btw`, Subagents & Swarm |
| **Host Footprint** | Official baseline | Some scripts patch `app.asar` | **CDP injection**, zero file changes, ~18MB RAM |

---

## 🎨 Visual States & Split View Isolation

### 1. State Progression & Color Feedback

The ring progresses smoothly with context usage. Standard conversations follow a four-tier palette (Electric Blue `<60%` ➔ Amber Yellow `60-80%` ➔ Warm Orange `80-90%` ➔ Pure Alert Red `≥90%`). Once context compaction is detected (manual `/compact` or auto-compaction), the safe phase (`<60%`) switches to a clear **Lavender Violet (`#a78bfa`)** to denote an active compacted session, smoothly connecting into the standard Amber ➔ Orange ➔ Pure Red alert stages at `≥60%`.

| 🟢 Healthy / Early Phase (`< 60%`) | 🟡 Transition / Moderate (`60% ~ 80%`) |
| :---: | :---: |
| <img src="assets/state-low.jpg" alt="Google Antigravity context usage low state (<60%) - native blue inline SVG ring" width="100%" style="border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);"> | <img src="assets/state-medium.jpg" alt="Google Antigravity context usage medium state (60-80%) - amber warning ring" width="100%" style="border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);"> |
| 🔴 Critical Threshold (`≥ 90%`) | 🟣 Compaction Triggered (`Compacted < 60%`) |
| <img src="assets/state-critical.jpg" alt="Google Antigravity context limit critical state (>=90%) - approaching 256K auto-compaction truncation threshold" width="100%" style="border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);"> | <img src="assets/state-compacted.jpg" alt="Google Antigravity auto-compaction triggered state - dual-track purple ring showing released context tokens" width="100%" style="border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);"> |

### 2. Split View Multi-Pane Isolation

Engineered for power users with multi-composer parallel workflows. Each visible input box is managed by an independent state-machine lifecycle (`Map<box, PaneRingInstance>`):

<p align="center">
  <img src="assets/split-view-showcase.png" alt="Google Antigravity Split View multi-pane context monitoring isolated via React Fiber state tree" style="max-width: 100%; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.1);">
  <br>
  <em>Split View in action: Left pane Gemini 3.8 Flash (draft/healthy) & right pane Gemini 4 Argon (active/alert) operate with zero cross-talk</em>
</p>

* **Zero Cross-Talk Guarantee**: Each pane binds directly to its corresponding Fiber node without falling back to global route state, preventing draft boxes on the right from reflecting data from active sessions on the left.
* **Same-Session Synchronization**: When two panes view the same conversation, token increments on either pane reflect instantaneously across both rings.
* **Full-Pane & Auxiliary View Support**: Covers main Split View panes, split new-pane draft views, `/btw` side questions (`sideQuestionView`), and right-side auxiliary **Subagent / Swarm Worker** tabs (`subagentView`). Dedicated scope guards isolate Subagent / Swarm Worker panels from `/btw` drafts, read React Fiber `selectedModel` directly under `hideModelSelector` or Best-of-N views, and support zero-`USER_INPUT` message-driven trajectories.

---

## 🏗️ Under the Hood

```mermaid
flowchart TD
    subgraph AntigravityHost["Google Antigravity Host App"]
        LS["Language Server (Connect-RPC)"]
        Fiber["React Fiber State Tree (agentStateProvider)"]
        UI["Composer Input Box Container (Flexbox DOM)"]
    end

    subgraph SidecarEngine["Context Ring Sidecar Daemon (~18MB)"]
        Discovery["ls-discovery<br/>Env Fast-Path & Port/CSRF Sniffing"]
        Rpc["rpc-client<br/>Paginated Step Traversal & Deadlock Guard"]
        Calc["context-calculator<br/>Three-Tier Decoupling, Plan-Execute & Self-Learning"]
        Bridge["runtime-bridge<br/>Target Filtering, CDP Injection & Reload Recovery"]
    end

    subgraph NativeWidget["Frontend Microkernel (ring-widget.cjs)"]
        ShadowRoot["Shadow DOM Style Isolation"]
        RingDOM["19px SVG Native Ring"]
        TooltipDOM["Frosted-Glass Capsule HUD"]
        SWRMap["Dual-Tier SWR + Self-Learned Limits (LocalStorage)"]
        FiberObserver["Fiber Event Pipeline (onDidChange)"]
    end

    Discovery -->|"Dynamic Probe"| LS
    Rpc -->|"Paginated Step Checkpoints"| LS
    Rpc --> Calc
    Calc -->|"Hardware Ground Truth"| Bridge
    Bridge -->|"CDP Pipeline Injection"| ShadowRoot
    ShadowRoot --> UI
    Fiber -->|"Sub-ms State Sync"| FiberObserver
    FiberObserver --> SWRMap
    SWRMap --> RingDOM
    RingDOM -.->|"Hover Trigger"| TooltipDOM
```

* **Hardware-Grade RPC Ground Truth (Zero Character Guessing)**: Adhering to professional harness engineering standards, telemetry reads `modelUsage` structures directly from the local Language Server over Connect-RPC, capturing input, output, `cacheReadTokens`, and `cacheCreationTokens`.
* **Three-Tier Model Decoupling & Plan-Execute Pairing**: Decouples `selectedModel` (the primary model dictating capacity denominator), `executionModel` (the subtask execution model), and `checkpointModel` (the snapshot model). Beyond isolating lightweight subagents (`flash_lite`), it pairs `Orchestrator (Argon)` (`M668` in Plan mode ⇄ `M669` in Execution mode) within the same trajectory — preserving the primary denominator, allowing execution-step tail cursors to calibrate limits, and detecting cross-model `CHECKPOINT` compactions without false resets; zero-`USER_INPUT` Swarm Worker trajectories combine initial `SYSTEM_MESSAGE` estimation with checkpoint re-anchoring.
* **Multi-Tier Cutoffs & Zero-Maintenance Self-Learning Loop**: Grounded in Language Server `model_profiles` and live `CHECKPOINT` telemetry — **256K (256,000)** online baseline for Gemini 4 Hydrogen (512K offline static, overridden to 256K by AICode Mendel), Gemini 4 Argon / Orchestrator (Argon) / Gemini 4 Carbon / Gemini 3.8 Flash / Claude Opus & Sonnet 5.5 (calibrating to experiment limits such as `claude-1m_840k` when active); **160K** for Legacy M26/M35 & Claude 4; **128K** for Gemini 2.5; and **80K (80,000)** for GPT-OSS 120B. Lightweight tail-cursor `GetCascadeTrajectoryGeneratorMetadata` RPCs and `GetUserStatus` / `GetCascadeModelConfigData` catalog sync feed learned limits and aliases into snapshots, which the frontend persists in `localStorage` so drafts and future models align automatically without code updates.
* **Dual-Tier SWR & Never-Reset Guard**: 50-session in-memory LRU + 100-session persistent LocalStorage cache. Switching historical conversations renders valid snapshots in 0ms followed by silent background calibration. On host reloads or transient disconnects, the ring locks the latest verified state rather than blinking to zero.
* **Authoritative Total, Tail Window & Self-Healing Bridge**: Bypasses the 1,000-step RPC ceiling by tracking `stepCount` and focusing the newest 5,000-step window so current checkpoints are never masked. On the host bridge side, non-app CDP targets (`data:`, `about:blank`, `plugin:`) are filtered out, `Runtime.executionContextCreated` triggers instant re-injection on reloads, and host-injected LS env vars enable `<3ms` zero-spawn discovery.

---

## ❓ Frequently Asked Questions (FAQ)

<details>
<summary><strong>Q1: How does Context Ring monitor real-time token usage in Google Antigravity without modifying the app.asar file?</strong></summary>

> **A**: The plugin uses a **100% non-invasive architecture**. It never unpacks, patches, or modifies host binaries or `resources/app.asar`. Instead, a lightweight background sidecar connects to the client runtime via the standard Chrome DevTools Protocol (CDP), injecting a zero-dependency vanilla JS microkernel. The sidecar queries the local Language Server via Connect-RPC for `modelUsage` metrics and attaches the inline SVG ring to the composer DOM. Host app updates remain completely frictionless, and uninstalling leaves zero residue.
</details>

<details>
<summary><strong>Q2: When using Subagents / Swarm Workers, /btw side questions, or Split View panes, how does Context Ring avoid jumps and cross-pane pollution?</strong></summary>

> **A**: Context Ring enforces **three-tier model decoupling** and **scope-isolated pane state trees** across frontend and backend. The denominator is anchored to the primary model, with `Orchestrator (Argon)` Plan-Execute pairing (`M668` ⇄ `M669`) recognized natively so execution steps never hijack the denominator or drop compaction tracking. In the UI, `Map<box, PaneRingInstance>` separates main composers, `/btw` (`sideQuestionView`), and right-side Subagent / Swarm Worker tabs (`subagentView`), reading React Fiber `selectedModel` directly even when `hideModelSelector` hides the model button.
</details>

<details>
<summary><strong>Q3: Does the background daemon affect Antigravity performance or consume significant memory?</strong></summary>

> **A**: **Not at all**. The background Node.js sidecar daemon maintains an ultra-light footprint of approximately **~18MB of RAM** and near-**0% CPU** consumption. The frontend injection layer consists of lightweight native DOM and SVG elements with zero framework dependencies (no React/Vue overhead). Combined with a 250ms debounced event throttle and a host-bound watchdog that terminates automatically when the app closes, it introduces zero overhead to typing or client rendering.
</details>

<details>
<summary><strong>Q4: Do I need to wait for a plugin update when Antigravity ships new models or adjusts remote context limits?</strong></summary>

> **A**: **No manual update needed**. Whenever a model runs or appears in the host catalog, the backend learns its `maxContextTokens` and aliases via `GetCascadeTrajectoryGeneratorMetadata` and `GetUserStatus`, ships those learned limits inside snapshots, and the frontend persists them in `localStorage`. Draft views and cold restarts immediately reflect the updated limits.
</details>

---

## 📄 License

This project is open-source and licensed under the [MIT License](LICENSE).
