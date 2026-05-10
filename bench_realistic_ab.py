"""
A/B test: find optimal prefill_step_size for realistic ~20K agentic prompt.

Restarts the server with each step size, loads the model, and measures TTFT.
Tests: 512, 768, 1024, 1536, 2048, 3072, 4096

Usage: python3 bench_realistic_ab.py
"""
import time
import json
import urllib.request
import statistics
import subprocess
import signal
import sys
import os

SERVER = "http://127.0.0.1:8090"
SERVER_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py")
MODEL_PATH = "/Users/matt123/.lmstudio/models/unsloth/Qwen3.6-35B-A3B-MLX-8bit"

# Import the realistic prompt from bench_realistic.py
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bench_realistic import build_messages

STEP_SIZES = [512, 768, 1024, 1536, 2048, 3072, 4096]


def kill_server():
    try:
        result = subprocess.run(["lsof", "-ti", ":8090"], capture_output=True, text=True)
        if result.stdout.strip():
            for pid in result.stdout.strip().split("\n"):
                try:
                    os.kill(int(pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
            time.sleep(2)
    except Exception:
        pass


def start_server(step_size):
    env = os.environ.copy()
    env["PREFILL_STEP_SIZE"] = str(step_size)
    proc = subprocess.Popen(
        [sys.executable, SERVER_PY],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return proc


def wait_for_server(timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            resp = urllib.request.urlopen(f"{SERVER}/admin/status", timeout=3)
            json.loads(resp.read())
            return True
        except Exception:
            pass
        time.sleep(1)
    return False


def load_model():
    body = json.dumps({"model_path": MODEL_PATH}).encode()
    req = urllib.request.Request(
        f"{SERVER}/admin/load",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        resp = urllib.request.urlopen(req, timeout=120)
        return resp.status == 200
    except Exception as e:
        print(f"    Load failed: {e}")
        return False


def measure_ttft(messages, runs=5):
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


def main():
    messages = build_messages()
    total_chars = sum(len(m["content"]) for m in messages)
    total_tokens_est = total_chars // 4

    print("╔══════════════════════════════════════════════════════════════╗")
    print("║  A/B: Optimal prefill_step_size for Mario Game Session      ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    print(f"\n  Prompt: {total_chars} chars (~{total_tokens_est} tokens)")
    print(f"  Testing step sizes: {STEP_SIZES}")
    print(f"  5 measured runs per config (+ 1 warmup)")
    print()

    results = {}

    for step_size in STEP_SIZES:
        print(f"{'─'*60}")
        print(f"  Testing prefill_step_size={step_size}")
        print(f"{'─'*60}")

        # Kill any existing server
        kill_server()
        time.sleep(1)

        # Start with this step size
        print(f"    Starting server...")
        proc = start_server(step_size)

        if not wait_for_server(timeout=20):
            print(f"    ❌ Server didn't start!")
            proc.terminate()
            continue

        # Load model
        print(f"    Loading model...")
        if not load_model():
            print(f"    ❌ Model load failed!")
            proc.terminate()
            continue

        # Verify config
        try:
            resp = urllib.request.urlopen(f"{SERVER}/admin/status", timeout=5)
            status = json.loads(resp.read())
            print(f"    Config confirmed: {status.get('prefill_step_size')}")
        except Exception:
            pass

        # Warmup
        print(f"    Warmup run...")
        measure_ttft(messages, runs=1)

        # Measure
        print(f"    Measuring (5 runs)...")
        ttfts = measure_ttft(messages, runs=5)

        if ttfts:
            med = statistics.median(ttfts)
            results[step_size] = {
                "median": med,
                "min": min(ttfts),
                "max": max(ttfts),
                "all": ttfts,
            }
            for i, t in enumerate(ttfts):
                print(f"      Run {i+1}: {t*1000:.0f}ms")
            print(f"    → Median: {med*1000:.0f}ms  (prefill: {total_tokens_est/med:.0f} tok/s)")
        else:
            print(f"    ❌ No results")

        # Stop server
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    # ── Final Results ─────────────────────────────────────────────────────────
    print(f"\n{'═'*60}")
    print(f"  RESULTS: Realistic Mario Game Session (~{total_tokens_est} tokens)")
    print(f"{'═'*60}")
    print(f"\n  {'Step Size':<12} {'Median TTFT':<14} {'tok/s':<8} {'vs Best':<10}")
    print(f"  {'─'*12} {'─'*14} {'─'*8} {'─'*10}")

    if results:
        best_med = min(r["median"] for r in results.values())
        for step_size in STEP_SIZES:
            if step_size in results:
                med = results[step_size]["median"]
                tok_s = total_tokens_est / med
                diff = ((med - best_med) / best_med) * 100
                marker = " ← BEST" if med == best_med else ""
                print(f"  {step_size:<12} {med*1000:<14.0f} {tok_s:<8.0f} {diff:+.1f}%{marker}")

        best_step = min(results, key=lambda k: results[k]["median"])
        print(f"\n  ✅ Optimal: prefill_step_size={best_step}")
        print(f"     TTFT: {results[best_step]['median']*1000:.0f}ms")
        print(f"     Prefill rate: {total_tokens_est/results[best_step]['median']:.0f} tok/s")

    print(f"\n  Note: Restart your server after this benchmark.")


if __name__ == "__main__":
    main()
