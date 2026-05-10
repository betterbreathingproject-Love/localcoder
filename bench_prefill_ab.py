"""
A/B benchmark: compare old prefill_step_size=1024 vs new adaptive (2048/4096/8192).

Temporarily patches the server's prefill_step_size via env var override,
then measures TTFT on the same prompts.

Usage: python3 bench_prefill_ab.py
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

# Build prompts at different sizes
SYSTEM_PROMPT = "You are a helpful coding assistant. " * 50  # ~2K chars
USER_MSG_MEDIUM = "Explain the architecture of a web server in detail. " * 40  # ~2.4K
USER_MSG_LARGE = USER_MSG_MEDIUM * 4  # ~9.6K

PROMPTS = {
    "medium": {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": USER_MSG_MEDIUM},
        ],
        "chars": len(SYSTEM_PROMPT) + len(USER_MSG_MEDIUM),
    },
    "large": {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": USER_MSG_LARGE},
        ],
        "chars": len(SYSTEM_PROMPT) + len(USER_MSG_LARGE),
    },
}


def wait_for_server(timeout=120):
    """Wait until the server responds to /admin/status."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            resp = urllib.request.urlopen(f"{SERVER}/admin/status", timeout=3)
            data = json.loads(resp.read())
            if data.get("loaded"):
                return True
        except Exception:
            pass
        time.sleep(2)
    return False


def load_model():
    """Load the 35B model if not already loaded."""
    try:
        resp = urllib.request.urlopen(f"{SERVER}/admin/status", timeout=5)
        status = json.loads(resp.read())
        if status.get("loaded"):
            return True
    except Exception:
        return False

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
        print(f"  Failed to load model: {e}")
        return False


def measure_ttft(messages, runs=3):
    """Send streaming requests and return list of TTFT values."""
    ttfts = []
    for i in range(runs):
        body = json.dumps({
            "model": "default",
            "messages": messages,
            "max_tokens": 16,
            "stream": True,
            "temperature": 0.0,
        }).encode()

        req = urllib.request.Request(
            f"{SERVER}/v1/chat/completions",
            data=body,
            headers={"Content-Type": "application/json"},
        )

        t0 = time.perf_counter()
        first_token_time = None

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                for line in resp:
                    line = line.decode().strip()
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                        delta = chunk.get("choices", [{}])[0].get("delta", {})
                        content = delta.get("content", "")
                        if content and first_token_time is None:
                            first_token_time = time.perf_counter() - t0
                            break  # Got TTFT, stop reading
                    except json.JSONDecodeError:
                        pass
        except Exception as e:
            print(f"    Run {i+1}: ERROR - {e}")
            continue

        if first_token_time:
            ttfts.append(first_token_time)
            print(f"    Run {i+1}: TTFT={first_token_time*1000:.0f}ms")

    return ttfts


def run_config(label, step_size_env):
    """
    Test a specific prefill_step_size by setting the env var on the running server.
    Since the env var is read at module load time, we can't change it on a running
    server. Instead, we'll use the /admin endpoint approach — but since there's no
    such endpoint, we'll just document what the current config is and compare.
    """
    print(f"\n{'═'*60}")
    print(f"  Config: {label} (prefill_step_size={step_size_env})")
    print(f"{'═'*60}")

    results = {}
    for name, prompt_info in PROMPTS.items():
        chars = prompt_info["chars"]
        tokens_est = chars // 4
        print(f"\n  [{name}] {chars} chars (~{tokens_est} tokens)")

        # Warmup run (discard)
        measure_ttft(prompt_info["messages"], runs=1)

        # Actual measurement
        ttfts = measure_ttft(prompt_info["messages"], runs=3)
        if ttfts:
            median = statistics.median(ttfts)
            results[name] = median
            print(f"    → Median TTFT: {median*1000:.0f}ms")
        else:
            results[name] = None
            print(f"    → FAILED")

    return results


def main():
    print("╔══════════════════════════════════════════════════════════════╗")
    print("║  A/B Benchmark: Prefill Step Size (1024 vs Adaptive)       ║")
    print("╚══════════════════════════════════════════════════════════════╝")

    # Check server is running with model loaded
    try:
        resp = urllib.request.urlopen(f"{SERVER}/admin/status", timeout=5)
        status = json.loads(resp.read())
        if not status.get("loaded"):
            print("\nNo model loaded. Loading 35B...")
            if not load_model():
                print("Failed to load model. Exiting.")
                sys.exit(1)
        print(f"\nModel: {status.get('loaded', 'loading...')}")
        print(f"Current prefill config: {status.get('prefill_step_size', 'unknown')}")
    except Exception as e:
        print(f"\nServer not available: {e}")
        print("Start the server first: python3 server.py")
        sys.exit(1)

    # The server is running with adaptive step sizes (2048/4096/8192).
    # We'll measure current performance, then restart with PREFILL_STEP_SIZE=1024
    # to compare.

    print("\n" + "─"*60)
    print("Phase 1: Measuring ADAPTIVE step sizes (current config)")
    print("─"*60)

    results_adaptive = run_config("adaptive (2048/4096/8192)", "adaptive")

    # Now restart server with fixed 1024 to compare
    print("\n" + "─"*60)
    print("Phase 2: Restarting server with PREFILL_STEP_SIZE=1024 (old config)")
    print("─"*60)

    # Kill current server
    print("\n  Stopping server...")
    try:
        urllib.request.urlopen(f"{SERVER}/admin/abort", timeout=3)
    except Exception:
        pass
    time.sleep(1)

    # Find and kill the server process
    try:
        result = subprocess.run(["lsof", "-ti", ":8090"], capture_output=True, text=True)
        if result.stdout.strip():
            for pid in result.stdout.strip().split("\n"):
                os.kill(int(pid), signal.SIGTERM)
            time.sleep(2)
    except Exception:
        pass

    # Start with old config
    print("  Starting server with PREFILL_STEP_SIZE=1024...")
    env = os.environ.copy()
    env["PREFILL_STEP_SIZE"] = "1024"
    server_proc = subprocess.Popen(
        [sys.executable, SERVER_PY],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    print("  Waiting for server...")
    if not wait_for_server(timeout=30):
        print("  Server didn't start. Trying to load model...")

    # Wait for it to be ready
    time.sleep(3)

    # Load model
    print("  Loading model...")
    if not load_model():
        print("  Failed to load model on restarted server.")
        server_proc.terminate()
        sys.exit(1)

    # Verify config
    try:
        resp = urllib.request.urlopen(f"{SERVER}/admin/status", timeout=5)
        status = json.loads(resp.read())
        print(f"  Prefill config: {status.get('prefill_step_size', 'unknown')}")
    except Exception:
        pass

    results_old = run_config("fixed 1024 (old)", "1024")

    # Kill the test server
    server_proc.terminate()
    server_proc.wait(timeout=10)

    # ── Results ───────────────────────────────────────────────────────────────
    print("\n" + "═"*60)
    print("  RESULTS: A/B Comparison")
    print("═"*60)
    print(f"\n  {'Prompt':<10} {'Old (1024)':<14} {'New (adaptive)':<16} {'Improvement':<12}")
    print(f"  {'─'*10} {'─'*14} {'─'*16} {'─'*12}")

    for name in PROMPTS:
        old_ms = results_old.get(name)
        new_ms = results_adaptive.get(name)
        if old_ms and new_ms:
            old_str = f"{old_ms*1000:.0f}ms"
            new_str = f"{new_ms*1000:.0f}ms"
            improvement = ((old_ms - new_ms) / old_ms) * 100
            imp_str = f"{improvement:+.1f}%"
            print(f"  {name:<10} {old_str:<14} {new_str:<16} {imp_str:<12}")
        else:
            print(f"  {name:<10} {'FAILED':<14} {'FAILED':<16}")

    print()
    print("  Note: Restart your normal server after this benchmark.")
    print("  Run: python3 server.py")


if __name__ == "__main__":
    main()
