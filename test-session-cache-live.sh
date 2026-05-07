#!/bin/bash
# Live test: send two identical-prefix requests and check session cache stats

set -e

echo "=== Before any requests ==="
curl -s http://127.0.0.1:8090/admin/session-cache | python3 -m json.tool
echo ""

echo "=== Request 1 (cold, full prefill) ==="
time curl -s -X POST http://127.0.0.1:8090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"qwen3-vl-unsloth-Qwen3.6-35B-A3B-MLX-8bit",
    "messages":[
      {"role":"system","content":"You are a helpful assistant."},
      {"role":"user","content":"Count from 1 to 3. Just the numbers, nothing else."}
    ],
    "max_tokens":50,
    "stream":true
  }' 2>&1 | tail -5

echo ""
echo "=== After request 1 ==="
curl -s http://127.0.0.1:8090/admin/session-cache | python3 -m json.tool
echo ""

echo "=== Request 2 (same prompt + one extra message — should HIT session cache) ==="
time curl -s -X POST http://127.0.0.1:8090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"qwen3-vl-unsloth-Qwen3.6-35B-A3B-MLX-8bit",
    "messages":[
      {"role":"system","content":"You are a helpful assistant."},
      {"role":"user","content":"Count from 1 to 3. Just the numbers, nothing else."},
      {"role":"assistant","content":"1, 2, 3"},
      {"role":"user","content":"Now count to 5."}
    ],
    "max_tokens":50,
    "stream":true
  }' 2>&1 | tail -5

echo ""
echo "=== After request 2 ==="
curl -s http://127.0.0.1:8090/admin/session-cache | python3 -m json.tool
