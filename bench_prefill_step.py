"""
Quick benchmark: measure TTFT at different prefill_step_size values.
Sends the same prompt 3 times per configuration and reports median TTFT.

Usage: python3 bench_prefill_step.py
"""
import time
import json
import urllib.request
import statistics
import sys

SERVER = "http://127.0.0.1:8090"

# Build a realistic prompt (~8K chars = ~2K tokens, typical agentic turn)
SYSTEM_PROMPT = "You are a helpful coding assistant. " * 50  # ~2K chars
USER_MSG = "Explain the architecture of a web server in detail. " * 40  # ~2.4K chars

# Larger prompt for testing the 4096/8192 tiers
LARGE_USER_MSG = USER_MSG * 4  # ~9.6K chars total with system = ~12K

def make_request(messages, max_tokens=32):
    """Send a streaming chat request and measure TTFT."""
    body = json.dumps({
        "model": "default",
        "messages": messages,
        "max_tokens": max_tokens,
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
    total_tokens = 0

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
                    if content:
                        total_tokens += 1
                except json.JSONDecodeError:
                    pass
    except Exception as e:
        return None, str(e)

    elapsed = time.perf_counter() - t0
    return first_token_time, elapsed


def run_benchmark(label, messages, runs=3):
    """Run multiple requests and report median TTFT."""
    ttfts = []
    for i in range(runs):
        ttft, elapsed = make_request(messages)
        if ttft is None:
            print(f"  Run {i+1}: FAILED")
            continue
        ttfts.append(ttft)
        print(f"  Run {i+1}: TTFT={ttft*1000:.0f}ms, total={elapsed:.2f}s")

    if ttfts:
        median = statistics.median(ttfts)
        print(f"  → Median TTFT: {median*1000:.0f}ms ({label})")
        return median
    return None


def main():
    # Check server is up
    try:
        resp = urllib.request.urlopen(f"{SERVER}/admin/status", timeout=5)
        status = json.loads(resp.read())
        print(f"Model: {status['loaded']}")
        print(f"Prefill config: {status.get('prefill_step_size', 'unknown')}")
        print()
    except Exception as e:
        print(f"Server not available: {e}")
        sys.exit(1)

    # ── Test 1: Medium prompt (~4K chars → should use 2048 step size) ─────────
    messages_medium = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": USER_MSG},
    ]
    prompt_chars = len(SYSTEM_PROMPT) + len(USER_MSG)
    print(f"═══ Test 1: Medium prompt ({prompt_chars} chars, ~{prompt_chars//4} tokens) ═══")
    print(f"    Expected prefill_step_size: 2048")
    median_medium = run_benchmark("medium", messages_medium)
    print()

    # ── Test 2: Large prompt (~12K chars → should use 4096 step size) ─────────
    messages_large = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": LARGE_USER_MSG},
    ]
    prompt_chars_large = len(SYSTEM_PROMPT) + len(LARGE_USER_MSG)
    print(f"═══ Test 2: Large prompt ({prompt_chars_large} chars, ~{prompt_chars_large//4} tokens) ═══")
    print(f"    Expected prefill_step_size: 4096")
    median_large = run_benchmark("large", messages_large)
    print()

    # ── Test 3: Very large prompt (~25K chars → should use 8192 step size) ────
    messages_xlarge = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": LARGE_USER_MSG * 2},
    ]
    prompt_chars_xl = len(SYSTEM_PROMPT) + len(LARGE_USER_MSG) * 2
    print(f"═══ Test 3: XL prompt ({prompt_chars_xl} chars, ~{prompt_chars_xl//4} tokens) ═══")
    print(f"    Expected prefill_step_size: 8192")
    median_xl = run_benchmark("xlarge", messages_xlarge)
    print()

    # ── Summary ───────────────────────────────────────────────────────────────
    print("═══ Summary ═══")
    if median_medium:
        print(f"  Medium ({prompt_chars} chars):  {median_medium*1000:.0f}ms TTFT")
    if median_large:
        print(f"  Large  ({prompt_chars_large} chars): {median_large*1000:.0f}ms TTFT")
    if median_xl:
        print(f"  XL     ({prompt_chars_xl} chars): {median_xl*1000:.0f}ms TTFT")

    if median_medium and median_xl:
        ratio = median_xl / median_medium
        print(f"\n  Scaling: XL is {ratio:.1f}x slower than medium")
        print(f"  (Linear would be {prompt_chars_xl/prompt_chars:.1f}x — sub-linear = chunked prefill working)")


if __name__ == "__main__":
    main()
