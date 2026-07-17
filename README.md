<div align="center">

<img src="assets/localcoder-icon.png" width="128" alt="LocalCoder Mac Studio logo">

# LocalCoder Mac Studio

**Local AI coding for Apple Silicon — no cloud, no API keys, no data leaving your Mac.**

[![Download DMG](https://img.shields.io/badge/Download-DMG%20for%20macOS-7c6af7?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/betterbreathingproject-Love/localcoder/releases/latest)
&nbsp;
[![License](https://img.shields.io/badge/License-MIT-4fc3f7?style=for-the-badge)](LICENSE)

*Runs Qwen 3.6 35B locally via MLX · Electron desktop app · Multi-agent orchestration*

</div>

---

## What is this?

LocalCoder Mac Studio is a native macOS app that bundles a local MLX inference server with a full coding IDE. You describe what you want to build, and a team of AI agents writes the code — reading files, running commands, searching your codebase, and verifying with the language server — all running on your Mac's GPU.

No API keys. No subscriptions. No internet required.

## ✨ Features

**Build & edit — visually or in code**
- 🎨 **WebDesigner** — Click any element on your live page and edit it visually; changes write straight back to the source.
- 📝 **In-app code editor** — Open and edit any project file directly, with a file tree and symbol outline.
- 👁️ **Live preview** — HTML the agent builds renders instantly in an embedded preview pane, at mobile or desktop widths.
- 🎮 **Game scaffolding** — Generate complete, runnable 2D and 3D game projects from a one-line prompt.

**A team of local AI agents**
- 🧠 **On-device inference** — Qwen 3.6 35B (plus a fast 0.8B assistant) run on your Mac's GPU via MLX. OpenAI-compatible API, fully offline.
- 🔀 **Multi-agent orchestration** — Features are split into a task graph; up to 3 specialised agents work in parallel.
- 🧩 **Subagents** — The main agent spawns read-only helper agents on a separate inference slot for research and search.
- 🩹 **Learned auto-fixer** — Records its own bad→good code fixes and auto-applies them the next time it hits the same mistake.
- 🔭 **LSP-safe edits** — Language-server blast-radius and diagnostic checks before every file write.

**See, browse & automate**
- 🖼️ **Vision** — Drop in screenshots or mockups; the agent reads them, and screenshots its own pages to check its work.
- 🌐 **Browser automation** — Drives a real browser (Playwright) to test, click, type, and screenshot web UIs.
- 🔍 **Deep-research browser** — A dedicated research toolset fetches pages, extracts content, and synthesises findings.
- 🖥️ **Desktop automation & OCR** — Screenshot the whole desktop and read on-screen text.

**Create & ship**
- 🎨 **Local image generation** — Make brand-new images from text prompts on-device (Z-Image-Turbo) — no cloud.
- 📱 **Mobile apps** — Scaffold and build cross-platform apps with Capacitor (iOS + Android).
- 🍎 **Xcode integration** — Build, test, and run in the simulator; auto-generates a valid Xcode project.

**Remember & extend**
- 💾 **Memory** — A knowledge graph plus vector memory lets the agent recall context across sessions.
- 🛠️ **Custom Tool Creator** — Build your own tools from shell-command templates that the agent can call.
- 💬 **Telegram remote** — Launch, monitor, and control jobs from your phone via a Telegram mini-app.

## 🚀 Getting Started

### 1. Download

Grab the latest `.dmg` from [**Releases**](https://github.com/betterbreathingproject-Love/localcoder/releases/latest). Open it and drag to Applications.

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

Across a full session, prefix caching compounds: on a 20-turn agent session (~27K token context), reusing 26K cached tokens cuts per-turn time-to-first-token from ~40s to ~1.5s — roughly **13 minutes saved** over the session.

### Speculative Decoding (Draft Model)

The fast 0.8B model proposes several tokens per step that the 35B model verifies in a single pass. Draft depth adapts to context size (benchmarked on M1 Max, Qwen3.6-35B-A3B):

| Context | Draft depth | Acceptance | Speedup |
|---|---|---|---|
| < 15K tokens | 6 | ~65% | **1.8×** |
| 15–30K | 4 | ~50% | 1.4× |
| 30–50K | 3 | ~35% | 1.2× |
| > 50K | 2 | ~25% | 1.1× |

Typical coding-task speedup: **1.5–2.5×**.

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

[Download](https://github.com/betterbreathingproject-Love/localcoder/releases/latest) · [Report a Bug](https://github.com/betterbreathingproject-Love/localcoder/issues)

</div>
