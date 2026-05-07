#!/bin/bash
# ============================================================
# MTPLX Full Benchmark — M1 Max 64GB
# ============================================================
# Tests:
#   1. AR baseline (no MTP) on the MTPLX-Optimized checkpoint
#   2. MTP speculative decoding (D3) on the same checkpoint
#   3. Optionally: unverified 8-bit model with MTP tensors
#
# Prerequisites:
#   brew install youssofal/mtplx/mtplx
#   OR: pip install mtplx
#
# Models (auto-downloaded on first run, or pre-pull):
#   mtplx pull Youssofal/Qwen3.6-27B-MTPLX-Optimized
# ============================================================

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────
VERIFIED_MODEL="Youssofal/Qwen3.6-27B-MTPLX-Optimized"
UNVERIFIED_8BIT="trevon/Qwen3.6-27B-mtp"  # MXFP8 with MTP tensors

MAX_TOKENS=512
TEMPERATURE=0.6
TOP_P=0.95
TOP_K=20

# Coding prompts (where MTP shines)
PROMPT_SHORT="Write a Python function that implements binary search on a sorted list. Include type hints and a docstring."
PROMPT_MEDIUM="Write a complete Python implementation of a thread-safe LRU cache with TTL expiration. Include type hints, docstrings, and handle edge cases."
PROMPT_LONG="Implement a Python async HTTP client with connection pooling, retry logic with exponential backoff, circuit breaker pattern, and request/response interceptors. Use only the standard library asyncio module. Include comprehensive error handling and type hints."

# ── Helpers ────────────────────────────────────────────────────
divider() {
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "$1"
  echo "════════════════════════════════════════════════════════════════"
}

run_bench() {
  local label="$1"
  local model="$2"
  local mtp_flag="$3"
  local prompt="$4"
  local extra_flags="${5:-}"

  echo ""
  echo "── $label ──"
  echo "   Prompt: ${prompt:0:80}..."
  echo ""

  mtplx ask \
    --model "$model" \
    $extra_flags \
    $mtp_flag \
    --max-tokens $MAX_TOKENS \
    --temperature $TEMPERATURE \
    --top-p $TOP_P \
    --top-k $TOP_K \
    --reasoning off \
    --stats --json \
    --prompt "$prompt" 2>&1 | tee /tmp/mtplx_bench_last.json

  echo ""
}

# ── Pre-flight ─────────────────────────────────────────────────
divider "MTPLX Benchmark Suite — $(date)"
echo "Machine: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'Apple Silicon')"
echo "Memory:  $(sysctl -n hw.memsize | awk '{printf "%.0f GB", $1/1073741824}')"
echo "Model:   $VERIFIED_MODEL"
echo "Tokens:  $MAX_TOKENS | Temp: $TEMPERATURE | Top-P: $TOP_P | Top-K: $TOP_K"

# Check mtplx is installed
if ! command -v mtplx &>/dev/null; then
  echo ""
  echo "ERROR: mtplx not found. Install with:"
  echo "  brew install youssofal/mtplx/mtplx"
  echo "  OR: pip install mtplx"
  exit 1
fi

echo ""
echo "MTPLX version: $(mtplx --version 2>/dev/null || echo 'unknown')"

# ── Test 1: Verified model — AR baseline ──────────────────────
divider "TEST 1: AR Baseline (no MTP) — $VERIFIED_MODEL"

run_bench "Short coding (AR)" "$VERIFIED_MODEL" "--no-mtp" "$PROMPT_SHORT"
run_bench "Medium coding (AR)" "$VERIFIED_MODEL" "--no-mtp" "$PROMPT_MEDIUM"
run_bench "Long coding (AR)" "$VERIFIED_MODEL" "--no-mtp" "$PROMPT_LONG"

# ── Test 2: Verified model — MTP speculative ──────────────────
divider "TEST 2: MTP Speculative (D3) — $VERIFIED_MODEL"

run_bench "Short coding (MTP)" "$VERIFIED_MODEL" "--mtp" "$PROMPT_SHORT"
run_bench "Medium coding (MTP)" "$VERIFIED_MODEL" "--mtp" "$PROMPT_MEDIUM"
run_bench "Long coding (MTP)" "$VERIFIED_MODEL" "--mtp" "$PROMPT_LONG"

# ── Test 3: Unverified MXFP8 model (optional) ─────────────────
divider "TEST 3 (OPTIONAL): MXFP8 8-bit with MTP — $UNVERIFIED_8BIT"
echo "This test uses --unsafe-force-unverified. Skip with Ctrl+C if not downloaded."
echo "Waiting 5s... (Ctrl+C to skip)"

if sleep 5 2>/dev/null; then
  run_bench "Short coding (MTP, MXFP8)" "$UNVERIFIED_8BIT" "--mtp" "$PROMPT_SHORT" "--unsafe-force-unverified --yes"
  run_bench "Medium coding (MTP, MXFP8)" "$UNVERIFIED_8BIT" "--mtp" "$PROMPT_MEDIUM" "--unsafe-force-unverified --yes"
  run_bench "Long coding (MTP, MXFP8)" "$UNVERIFIED_8BIT" "--mtp" "$PROMPT_LONG" "--unsafe-force-unverified --yes"
fi

# ── Summary ────────────────────────────────────────────────────
divider "BENCHMARK COMPLETE"
echo ""
echo "Key metrics to compare:"
echo "  • tok/s (generation speed)"
echo "  • mean_speedup_vs_ar (MTP multiplier)"
echo "  • acceptance rates at D1/D2/D3"
echo "  • peak memory usage"
echo ""
echo "Expected on M1 Max 64GB (~400 GB/s bandwidth):"
echo "  AR baseline:  ~14 tok/s"
echo "  MTP (D3):     ~28-31 tok/s (2.0-2.24x)"
echo ""
echo "If MTP shows < 1.5x, check:"
echo "  1. Thermal throttling (Activity Monitor → CPU)"
echo "  2. Memory pressure (other apps using unified memory)"
echo "  3. mtplx doctor --deep --json"
echo ""
