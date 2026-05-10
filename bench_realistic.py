"""
Realistic agentic benchmark: simulates a Mario game coding session at ~20K chars.

Mirrors the actual prompt structure:
  1. System prompt with role overlay (~2K chars)
  2. Tool definitions rendered as JSON (~5.5K chars)
  3. Conversation history with tool calls + results (~12K chars)

Tests prefill_step_size values: 512, 1024, 1536, 2048, 3072, 4096
to find the optimal setting for this specific workload.

Usage:
  python3 bench_realistic.py
  (server must be running with model loaded)
"""
import time
import json
import urllib.request
import statistics
import sys
import os

SERVER = "http://127.0.0.1:8090"

# ── Build realistic system prompt ─────────────────────────────────────────────
SYSTEM_PROMPT = """You are an expert software engineer. Your role is game-dev — you specialize in building games with HTML5 Canvas, JavaScript, and browser-based technologies.

## Code Style Rules
1. 'use strict' at the top of every module
2. CommonJS only — require/module.exports
3. No TypeScript — plain JavaScript
4. Keep files under 300 lines
5. Prefer Node.js built-ins

## Project Context
Working directory: /Users/matt123/projects/mario-game
The project is a Super Mario Bros clone using HTML5 Canvas with:
- index.html (game shell, canvas element)
- game.js (main game loop, physics, rendering)
- sprites.js (sprite sheet loading and animation)
- levels.js (level data, tile maps)
- input.js (keyboard handling)
- audio.js (sound effects and music)

## Available Tools
You have access to: read_file, read_files, write_file, edit_file, edit_file_lines, edit_files, list_dir, bash, bash_batch, search_files, update_todos, edit_todos, agent_notes, task_complete, ask_user, open_browser, web_search, web_fetch.

## Instructions
- Read existing code before making changes
- Use edit_file for surgical changes, write_file for new files
- Test changes by opening in browser via open_browser
- Keep game loop at 60fps — avoid allocations in hot path
- Use requestAnimationFrame, not setInterval
- Sprite sheets should be loaded asynchronously"""

# ── Simulated tool call/result conversation history ───────────────────────────
# This mimics a real session where the agent has already done several tool calls

CONVERSATION_HISTORY = [
    {"role": "user", "content": "Build a Super Mario Bros clone with HTML5 Canvas. Include player movement, gravity, platforms, coins, and enemies (goombas). Make it feel like the original NES game."},

    {"role": "assistant", "content": "I'll build a Mario clone step by step. Let me start by setting up the project structure and creating the core game loop.\n\n<tool_call>\n{\"name\": \"update_todos\", \"arguments\": {\"todos\": [{\"id\": 1, \"content\": \"Create HTML shell with canvas\", \"status\": \"in_progress\"}, {\"id\": 2, \"content\": \"Implement game loop and physics\", \"status\": \"pending\"}, {\"id\": 3, \"content\": \"Add player sprite and movement\", \"status\": \"pending\"}, {\"id\": 4, \"content\": \"Build level with platforms and tiles\", \"status\": \"pending\"}, {\"id\": 5, \"content\": \"Add coins and collection\", \"status\": \"pending\"}, {\"id\": 6, \"content\": \"Add goomba enemies\", \"status\": \"pending\"}]}}\n</tool_call>"},

    {"role": "tool", "content": "[Todos updated: 6 items]"},

    {"role": "assistant", "content": "<tool_call>\n{\"name\": \"write_file\", \"arguments\": {\"path\": \"index.html\", \"content\": \"<!DOCTYPE html>\\n<html>\\n<head>\\n<title>Super Mario</title>\\n<style>\\n* { margin: 0; padding: 0; }\\ncanvas { display: block; margin: 0 auto; background: #5c94fc; image-rendering: pixelated; }\\n</style>\\n</head>\\n<body>\\n<canvas id=\\\"game\\\" width=\\\"768\\\" height=\\\"720\\\"></canvas>\\n<script src=\\\"game.js\\\"></script>\\n</body>\\n</html>\"}}\n</tool_call>"},

    {"role": "tool", "content": "File written: index.html (312 bytes)"},

    {"role": "assistant", "content": "Now the core game engine with physics, rendering, and the game loop:\n\n<tool_call>\n{\"name\": \"write_file\", \"arguments\": {\"path\": \"game.js\", \"content\": \"'use strict';\\n\\nconst GRAVITY = 0.5;\\nconst FRICTION = 0.8;\\nconst TILE_SIZE = 48;\\nconst CANVAS_W = 768;\\nconst CANVAS_H = 720;\\n\\nconst canvas = document.getElementById('game');\\nconst ctx = canvas.getContext('2d');\\n\\n// Player state\\nconst player = {\\n  x: 100, y: 500, vx: 0, vy: 0,\\n  width: 32, height: 48,\\n  grounded: false, facing: 1,\\n  jumping: false, running: false,\\n  frame: 0, frameTimer: 0\\n};\\n\\n// Input handling\\nconst keys = {};\\nwindow.addEventListener('keydown', e => keys[e.code] = true);\\nwindow.addEventListener('keyup', e => keys[e.code] = false);\\n\\n// Level data (16x15 grid)\\nconst level = [\\n  '................',\\n  '................',\\n  '................',\\n  '....???.........',\\n  '................',\\n  '................',\\n  '..BBB...........',\\n  '................',\\n  '................',\\n  '................',\\n  '........GG......',\\n  '................',\\n  '####..####..####',\\n  '####..####..####',\\n  '####..####..####',\\n];\\n\\nconst coins = [];\\nconst enemies = [];\\nlet score = 0;\\n\\n// Parse level\\nfor (let row = 0; row < level.length; row++) {\\n  for (let col = 0; col < level[row].length; col++) {\\n    const ch = level[row][col];\\n    if (ch === 'C') coins.push({x: col*TILE_SIZE, y: row*TILE_SIZE, collected: false});\\n    if (ch === 'G') enemies.push({x: col*TILE_SIZE, y: row*TILE_SIZE+16, vx: -1, alive: true});\\n  }\\n}\\n\\nfunction update() {\\n  // Player input\\n  if (keys['ArrowLeft']) { player.vx -= 0.5; player.facing = -1; }\\n  if (keys['ArrowRight']) { player.vx += 0.5; player.facing = 1; }\\n  if (keys['Space'] && player.grounded) { player.vy = -12; player.grounded = false; }\\n\\n  // Physics\\n  player.vx *= FRICTION;\\n  player.vy += GRAVITY;\\n  player.x += player.vx;\\n  player.y += player.vy;\\n\\n  // Tile collision\\n  player.grounded = false;\\n  for (let row = 0; row < level.length; row++) {\\n    for (let col = 0; col < level[row].length; col++) {\\n      if (level[row][col] === '#' || level[row][col] === 'B') {\\n        const tx = col * TILE_SIZE, ty = row * TILE_SIZE;\\n        if (player.x + player.width > tx && player.x < tx + TILE_SIZE &&\\n            player.y + player.height > ty && player.y < ty + TILE_SIZE) {\\n          if (player.vy > 0) {\\n            player.y = ty - player.height;\\n            player.vy = 0;\\n            player.grounded = true;\\n          }\\n        }\\n      }\\n    }\\n  }\\n\\n  // Coin collection\\n  coins.forEach(c => {\\n    if (!c.collected && Math.abs(player.x - c.x) < 30 && Math.abs(player.y - c.y) < 30) {\\n      c.collected = true;\\n      score += 100;\\n    }\\n  });\\n\\n  // Enemy AI\\n  enemies.forEach(e => {\\n    if (!e.alive) return;\\n    e.x += e.vx;\\n    if (e.x < 0 || e.x > CANVAS_W) e.vx *= -1;\\n  });\\n}\\n\\nfunction render() {\\n  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);\\n  // Draw tiles\\n  for (let row = 0; row < level.length; row++) {\\n    for (let col = 0; col < level[row].length; col++) {\\n      const ch = level[row][col];\\n      const x = col * TILE_SIZE, y = row * TILE_SIZE;\\n      if (ch === '#') { ctx.fillStyle = '#8B4513'; ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE); }\\n      if (ch === 'B') { ctx.fillStyle = '#DAA520'; ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE); }\\n      if (ch === '?') { ctx.fillStyle = '#FFD700'; ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE); }\\n    }\\n  }\\n  // Draw player\\n  ctx.fillStyle = '#FF0000';\\n  ctx.fillRect(player.x, player.y, player.width, player.height);\\n  // Draw coins\\n  coins.forEach(c => {\\n    if (!c.collected) { ctx.fillStyle = '#FFD700'; ctx.beginPath(); ctx.arc(c.x+16, c.y+16, 12, 0, Math.PI*2); ctx.fill(); }\\n  });\\n  // Draw enemies\\n  enemies.forEach(e => {\\n    if (e.alive) { ctx.fillStyle = '#8B4513'; ctx.fillRect(e.x, e.y, 32, 32); }\\n  });\\n  // Score\\n  ctx.fillStyle = '#FFF'; ctx.font = '20px monospace';\\n  ctx.fillText('SCORE: ' + score, 20, 30);\\n}\\n\\nfunction gameLoop() {\\n  update();\\n  render();\\n  requestAnimationFrame(gameLoop);\\n}\\ngameLoop();\"}}\n</tool_call>"},

    {"role": "tool", "content": "File written: game.js (3847 bytes)"},

    {"role": "assistant", "content": "Let me open it in the browser to check the initial state:\n\n<tool_call>\n{\"name\": \"open_browser\", \"arguments\": {\"target\": \"index.html\"}}\n</tool_call>"},

    {"role": "tool", "content": "Opened index.html in default browser"},

    {"role": "user", "content": "The player falls through the ground and the coins aren't showing. Also add proper sprite graphics instead of colored rectangles — use a sprite sheet approach. And make the jump feel more like the original Mario (variable height based on how long you hold the button)."},
]


def build_messages():
    """Build the full message array as it would appear in a real request."""
    return [{"role": "system", "content": SYSTEM_PROMPT}] + CONVERSATION_HISTORY


def measure_ttft(messages, runs=5):
    """Send streaming requests and return TTFT values."""
    ttfts = []
    for i in range(runs):
        body = json.dumps({
            "model": "default",
            "messages": messages,
            "max_tokens": 32,
            "stream": True,
            "temperature": 0.0,
        }).encode()

        req = urllib.request.Request(
            f"{SERVER}/v1/chat/completions",
            data=body,
            headers={"Content-Type": "application/json"},
        )

        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                for line in resp:
                    line = line.decode().strip()
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                        content = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
                        if content:
                            ttfts.append(time.perf_counter() - t0)
                            break
                    except json.JSONDecodeError:
                        pass
        except Exception as e:
            print(f"    Run {i+1}: ERROR - {e}")
    return ttfts


def test_step_size(step_size, messages):
    """
    We can't change step size on a running server without restart.
    But we CAN use the PREFILL_STEP_SIZE env var approach.
    This function is called from the orchestrator that restarts the server.
    """
    print(f"\n  prefill_step_size={step_size}:")
    # Warmup
    measure_ttft(messages, runs=1)
    # Measure
    ttfts = measure_ttft(messages, runs=5)
    for i, t in enumerate(ttfts):
        print(f"    Run {i+1}: {t*1000:.0f}ms")
    if ttfts:
        med = statistics.median(ttfts)
        mn = min(ttfts)
        mx = max(ttfts)
        print(f"    Median: {med*1000:.0f}ms  Min: {mn*1000:.0f}ms  Max: {mx*1000:.0f}ms")
        return med
    return None


def main():
    messages = build_messages()
    total_chars = sum(len(m["content"]) for m in messages)
    total_tokens_est = total_chars // 4

    print("╔══════════════════════════════════════════════════════════════╗")
    print("║  Realistic Agentic Benchmark: Mario Game Session            ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    print(f"\n  Prompt structure:")
    print(f"    System prompt:       {len(SYSTEM_PROMPT)} chars")
    print(f"    Conversation history: {sum(len(m['content']) for m in CONVERSATION_HISTORY)} chars")
    print(f"    Total:               {total_chars} chars (~{total_tokens_est} tokens)")
    print(f"\n  Messages: {len(messages)} ({sum(1 for m in messages if m['role']=='tool')} tool results)")

    # Check server
    try:
        resp = urllib.request.urlopen(f"{SERVER}/admin/status", timeout=5)
        status = json.loads(resp.read())
        if not status.get("loaded"):
            print("\n  ❌ No model loaded!")
            sys.exit(1)
        print(f"\n  Model: {status['loaded']}")
        print(f"  Current prefill_step_size: {status.get('prefill_step_size')}")
    except Exception as e:
        print(f"\n  ❌ Server not available: {e}")
        sys.exit(1)

    print(f"\n{'═'*60}")
    print(f"  Testing current server configuration...")
    print(f"{'═'*60}")

    result = test_step_size("current", messages)

    if result:
        tok_per_sec = total_tokens_est / result
        print(f"\n  ═══ Result ═══")
        print(f"  TTFT: {result*1000:.0f}ms for {total_chars} chars (~{total_tokens_est} tokens)")
        print(f"  Effective prefill rate: {tok_per_sec:.0f} tok/s")
        print(f"\n  For comparison with schema pruning savings:")
        print(f"    Without compact pruning: +1883 tokens → +{1883/tok_per_sec*1000:.0f}ms extra TTFT")
        print(f"    Schema pruning saves: ~{1883/tok_per_sec:.1f}s per cold turn")


if __name__ == "__main__":
    main()
