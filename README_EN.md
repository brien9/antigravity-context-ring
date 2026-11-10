<div align="center">

# Antigravity Context Ring

**Native inline context window monitor & token usage telemetry for Google Antigravity Desktop App (Antigravity App)**  
*Zero-invasion, Connect-RPC ground-truth, 0ms instant switch, ~18MB footprint.*

[![Release](https://img.shields.io/badge/Release-v1.1.0-10b981?style=flat-square&logo=github)](https://github.com/brien9/antigravity-context-ring/releases)
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

Foundation models natively support ~1M context, but the Antigravity client hard-caps truncation at **256K** and forces lossy compaction at that point. The native UI never shows remaining context and never warns before it happens.

**Context Ring** turns that real cutoff into a 19px inline ring:

| Dimension | Native Host UI | Heuristic Scripts / Approx | Antigravity Context Ring |
| :--- | :--- | :--- | :--- |
| **Denominator Baseline** | Silent auto-compaction at 256K | Often assumes 1M, missing actual limit | **Locked to 256K physical boundary** with visual alert |
| **Token Measurement** | Internal tracking; no live indicator | Character approximations, misses cache tokens | **Connect-RPC snapshots** from real `modelUsage` |
| **UI Integration** | Clean, distraction-free | Detached floating window or CLI polling | **19px inline SVG ring** with frosted-glass HUD on hover |
| **Multi-Pane Concurrency**| Native split panes | Susceptible to global route crosstalk | **React Fiber state tree isolation** per active pane |
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
        Discovery["ls-discovery<br/>Port & CSRF Token Sniffing"]
        Rpc["rpc-client<br/>Paginated Step Traversal & Deadlock Guard"]
        Calc["context-calculator<br/>Three-Tier Model Decoupling & Limits"]
        Bridge["runtime-bridge<br/>Non-Invasive CDP Injection & Locks"]
    end

    subgraph NativeWidget["Frontend Microkernel (ring-widget.cjs)"]
        ShadowRoot["Shadow DOM Style Isolation"]
        RingDOM["19px SVG Native Ring"]
        TooltipDOM["Frosted-Glass Capsule HUD"]
        SWRMap["Dual-Tier Cache (50 LRU + 100 LocalStorage)"]
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
* **Three-Tier Model Decoupling Engine**: Decouples `selectedModel` (the UI-selected model that strictly dictates capacity denominator), `executionModel` (the subtask execution model), and `checkpointModel` (the snapshot model), preventing lightweight subagents (e.g. `flash_lite`) from distorting primary telemetry.
* **Dual-Tier SWR & Never-Reset Guard**: 50-session in-memory LRU + 100-session persistent LocalStorage cache. Switching historical conversations renders valid snapshots in 0ms followed by silent background calibration. On host reloads or transient disconnects, the ring locks the latest verified state rather than blinking to zero.
* **Authoritative Total + Tail Window**: Bypasses the 1,000-step ceiling of a single RPC query. For trajectories over 5,000 steps, it reads the authoritative `stepCount` and analyzes the newest 5,000-step window, so the current checkpoint is never hidden by an old prefix and the tooltip explicitly marks a long-session tail window.

---

## ❓ Frequently Asked Questions (FAQ)

<details>
<summary><strong>Q1: How does Context Ring monitor real-time token usage in Google Antigravity without modifying the app.asar file?</strong></summary>

> **A**: The plugin uses a **100% non-invasive architecture**. It never unpacks, patches, or modifies host binaries or `resources/app.asar`. Instead, a lightweight background sidecar connects to the client runtime via the standard Chrome DevTools Protocol (CDP), injecting a zero-dependency vanilla JS microkernel. The sidecar queries the local Language Server via Connect-RPC for `modelUsage` metrics and attaches the inline SVG ring to the composer DOM. Host app updates remain completely frictionless, and uninstalling leaves zero residue.
</details>

<details>
<summary><strong>Q2: When using concurrent subagents or Split View panes, how does Context Ring avoid token spikes and cross-pane pollution?</strong></summary>

> **A**: Context Ring enforces **three-tier model decoupling** and **pane-isolated state trees** across frontend and backend. The denominator capacity is solely locked by the primary user-selected model (`selectedModel`), so subagents invoking lightweight helper models will never tamper with the main progress ratio. In the UI, each input container is managed independently (`Map<box, PaneRingInstance>`) and binds exclusively to its own React Fiber node, completely preventing cross-talk between split panes.
</details>

<details>
<summary><strong>Q3: Does the background daemon affect Antigravity performance or consume significant memory?</strong></summary>

> **A**: **Not at all**. The background Node.js sidecar daemon maintains an ultra-light footprint of approximately **~18MB of RAM** and near-**0% CPU** consumption. The frontend injection layer consists of lightweight native DOM and SVG elements with zero framework dependencies (no React/Vue overhead). Combined with a 250ms debounced event throttle and a host-bound watchdog that terminates automatically when the app closes, it introduces zero overhead to typing or client rendering.
</details>

---

## 📄 License

This project is open-source and licensed under the [MIT License](LICENSE).
