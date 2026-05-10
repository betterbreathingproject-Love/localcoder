<div align="center">

# 🧠 QwenCoder Mac Studio

**Local AI coding for Apple Silicon — no cloud, no API keys, no data leaving your Mac.**

[![Download DMG](https://img.shields.io/badge/Download-DMG%20for%20macOS-7c6af7?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/betterbreathingproject-Love/Qwencodermac-v2/releases/latest)
&nbsp;
[![License](https://img.shields.io/badge/License-MIT-4fc3f7?style=for-the-badge)](LICENSE)

*Runs Qwen 3.6 35B locally via MLX · Electron desktop app · Multi-agent orchestration*

</div>

---

## What is this?

QwenCoder Mac Studio is a native macOS app that bundles a local MLX inference server with a full coding IDE. You describe what you want to build, and a team of AI agents writes the code — reading files, running commands, searching your codebase, and verifying with the language server — all running on your Mac's GPU.

No API keys. No subscriptions. No internet required.

## ✨ Features

| | Feature | What it does |
|---|---|---|
| 🧠 | **Local LLM Inference** | Qwen 3.6 35B A3B runs on Apple Silicon via MLX. Streaming responses, OpenAI-compatible API. |
| 👁️ | **Vision Support** | Drop in screenshots or mockups. The vision model describes them and the agent acts on it. |
| 🛠️ | **Agentic Tool Use** | Reads/writes files, runs shell commands, searches code, browses the web via Playwright. |
| 📐 | **Spec-Driven Dev** | Requirements → Design → Tasks → Implementation. You control each step. |
| 🔀 | **Task Orchestration** | Complex features are broken into a DAG. Up to 3 agents run in parallel. |
| 🔭 | **LSP Safe Edits** | Blast-radius checks and diagnostic verification before every file write. |
| 💾 | **Memory System** | Knowledge graph + vector memory. The agent recalls context from past sessions. |
| ⚡ | **Dual-Model** | A fast 0.8B model handles routing, vision, and todos while the big model focuses on code. |
| 🍎 | **Swift & Xcode** | Build, test, and debug iOS/macOS apps with first-class Xcode integration. |
| 🌐 | **Browser Automation** | Playwright for testing, scraping, and interacting with web UIs. |
| 💬 | **Chat & Vibe Mode** | Ask questions or give tasks — it picks the right mode automatically. |
| 📱 | **Telegram Remote** | Monitor and control jobs from your phone. |

## 🚀 Getting Started

### 1. Download

Grab the latest `.dmg` from [**Releases**](https://github.com/betterbreathingproject-Love/Qwencodermac-v2/releases/latest). Open it and drag to Applications.

> Right-click → Open on first launch (ad-hoc signed).

### 2. Install models

Download MLX models to `~/.lmstudio/models/`:

| Model | Role | Size |
|---|---|---|
| `unsloth/Qwen3.6-35B-A3B-MLX-8bit` | Primary (coding) | ~20 GB |
| `mlx-community/Qwen3.5-0.8B-MLX-8bit` | Fast (routing, vision, todos) | ~0.5 GB |

You can use [LM Studio](https://lmstudio.ai) to download them, or grab them directly from Hugging Face.

### 3. Launch

The setup wizard walks you through Python detection, model selection, and server start. Then open a project folder and start coding.

## ⚡ Performance (v1.1.0)

Benchmarked on Mac with Qwen3.6-35B-A3B-MLX-8bit:

### Conversation Forking

Saves KV cache state after each turn. Next turn only prefills new content.

| Context Size | Without Fork | With Fork | Speedup |
|---|---|---|---|
| 5K chars (~1500 tok) | 7.4s | 0.3s | **25x** |
| 10K chars (~3200 tok) | 5.5s | 0.3s | **18x** |
| 20K chars (~6500 tok) | 11.2s | 0.3s | **37x** |

Real multi-turn session (Mario game, tools active):
- Turn 1 (cold): 2.7s
- Turn 2 (fork hit): 1.3s — **2.1x faster**
- Turn 3 (fork hit): 1.3s — **2.1x faster**

### Schema Pruning (Compact Mode)

Tool definitions sent to the model are compressed by 55%:

| Metric | Before | After |
|---|---|---|
| Tool schema tokens (18 tools) | 3,418 | 1,535 |
| Context budget used | 2.6% | 1.2% |
| TTFT saved per cold turn | — | ~2.8s |

### Prefill Step Size

Benchmarked optimal `prefill_step_size` for MoE model:

| Step Size | TTFT (realistic prompt) | Prefill Rate |
|---|---|---|
| 512 (MLX default) | 4,480ms | 403 tok/s |
| 1024 | 3,767ms | 479 tok/s |
| **2048 (optimal)** | **3,672ms** | **492 tok/s** |
| 4096 | 4,231ms | 427 tok/s |

### Prefix Cache (Semantic Splitting)

System block (tools + instructions + prompt) cached after first turn:
- Cold (no cache): 5.1s
- Warm (cache hit): 0.4s — **13x faster**

---

## 🤖 How It Works

```
You describe a feature
        ↓
   Agent generates a task graph (DAG)
        ↓
   Orchestrator dispatches tasks to specialised agents
        ↓
   Agents work in parallel: explore → gather context → implement → verify
        ↓
   You review, inject context, or redirect at any point
```

### Specialised Agents

The orchestrator routes each task to the right agent based on keywords:

- **Explorer** — investigates codebase structure
- **Context Gatherer** — finds the exact files and lines needed
- **Code Search** — pattern and symbol lookup
- **Debug** — diagnose-first bug fixing
- **Implementation** — writes and modifies code
- **Tester** — browser-based verification via Playwright
- **Requirements** — structured requirements authoring
- **Design** — architecture and interface design
- **General** — fallback for ambiguous tasks

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│  Electron (Renderer)                        │
│  Vanilla JS · Direct DOM · No framework     │
├─────────────────────────────────────────────┤
│  Electron (Main Process)                    │
│  ┌──────────┐ ┌───────────┐ ┌────────────┐ │
│  │ AgentPool │ │ DirectBridge│ │Orchestrator│ │
│  │ (routing) │ │ (tool loop)│ │ (DAG exec) │ │
│  └──────────┘ └───────────┘ └────────────┘ │
│  IPC modules: chat, files, tasks, terminal  │
├─────────────────────────────────────────────┤
│  Python (FastAPI · port 8090)               │
│  MLX inference · Vision · Memory bridge     │
│  OpenAI-compatible /v1/chat/completions     │
└─────────────────────────────────────────────┘
        ↕ Metal GPU (Apple Silicon)
```

## 🔧 Development

```bash
# Run in development
npm start

# Run tests
npm test

# Build .app (unpacked)
npm run build

# Build .dmg (distributable)
npm run dist
```

### Requirements

- macOS 14+ on Apple Silicon (M1/M2/M3/M4)
- Node.js 20+
- Python 3.12+ (for the MLX inference server)
- ~24 GB RAM recommended for the 35B model

### Project Structure

```
main.js                 # Electron entry point
config.js               # Token budgets, model paths (single source of truth)
direct-bridge.js        # System prompt builder + full tool execution loop
agent-pool.js           # Semaphore-based concurrency, keyword routing
orchestrator.js         # DAG execution engine
server.py               # FastAPI + MLX inference server
main/ipc-*.js           # IPC handler modules (one per domain)
renderer/               # Vanilla JS frontend
```

## 📄 License

MIT — do whatever you want with it.

---

<div align="center">

**Built with** Electron · MLX · FastAPI · Playwright

[Download](https://github.com/betterbreathingproject-Love/Qwencodermac-v2/releases/latest) · [Report a Bug](https://github.com/betterbreathingproject-Love/Qwencodermac-v2/issues)

</div>
