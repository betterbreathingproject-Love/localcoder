#!/bin/bash
# Benchmark: MTPLX with the 35B-A3B model
# Tests both AR mode (--no-mtp) and MTP mode (if available)
# Reports tok/s via --stats --json

MODEL="$HOME/.lmstudio/models/unsloth/Qwen3.6-35B-A3B-MLX-8bit"
PROMPT="Write a Python function that implements binary search on a sorted list. Include type hints and a docstring."
MAX_TOKENS=256

echo "============================================================"
echo "MTPLX Benchmark — Qwen3.6-35B-A3B-MLX-8bit"
echo "============================================================"
echo ""

echo "--- Test 1: AR mode (--no-mtp, baseline) ---"
mtplx ask \
  --model "$MODEL" \
  --unsafe-force-unverified --yes \
  --no-mtp \
  --max-tokens $MAX_TOKENS \
  --temperature 0.6 \
  --top-p 0.95 \
  --reasoning off \
  --stats --json \
  --prompt "$PROMPT" 2>&1

echo ""
echo "--- Test 2: MTP mode (speculative, if heads available) ---"
mtplx ask \
  --model "$MODEL" \
  --unsafe-force-unverified --yes \
  --mtp \
  --max-tokens $MAX_TOKENS \
  --temperature 0.6 \
  --top-p 0.95 \
  --reasoning off \
  --stats --json \
  --prompt "$PROMPT" 2>&1

echo ""
echo "============================================================"
echo "Done."
