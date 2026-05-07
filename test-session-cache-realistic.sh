#!/bin/bash
# More realistic test: send two requests with a ~2000-token shared prefix
set -e

# Build a long context message (reused between both requests)
LONG_CTX=$(python3 -c "
import json
# Simulate a system prompt + some agent context — enough to beat min_match_tokens=256
parts = []
for i in range(60):
    parts.append(f'Note {i}: The user is working on a Python project with modules A, B, C. Module A handles authentication. Module B handles data processing. Module C handles output formatting. There are known issues with edge cases in unicode handling.')
sys_prompt = 'You are an expert coding assistant. ' + ' '.join(parts)
print(json.dumps(sys_prompt))
")

echo "=== Reset (invalidate) ==="
curl -s -X POST http://127.0.0.1:8090/admin/session-cache/invalidate | python3 -m json.tool
echo ""

echo "=== Request 1 (cold) ==="
time curl -s -X POST http://127.0.0.1:8090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d "{
    \"model\":\"qwen3-vl-unsloth-Qwen3.6-35B-A3B-MLX-8bit\",
    \"messages\":[
      {\"role\":\"system\",\"content\":$LONG_CTX},
      {\"role\":\"user\",\"content\":\"Say OK.\"}
    ],
    \"max_tokens\":5,
    \"stream\":true
  }" | grep -v "^$" | tail -2

echo ""
echo "=== Stats after Request 1 ==="
curl -s http://127.0.0.1:8090/admin/session-cache | python3 -m json.tool
echo ""

echo "=== Request 2 (same system prompt + additional turn — should HIT) ==="
time curl -s -X POST http://127.0.0.1:8090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d "{
    \"model\":\"qwen3-vl-unsloth-Qwen3.6-35B-A3B-MLX-8bit\",
    \"messages\":[
      {\"role\":\"system\",\"content\":$LONG_CTX},
      {\"role\":\"user\",\"content\":\"Say OK.\"},
      {\"role\":\"assistant\",\"content\":\"OK.\"},
      {\"role\":\"user\",\"content\":\"Now say HI.\"}
    ],
    \"max_tokens\":5,
    \"stream\":true
  }" | grep -v "^$" | tail -2

echo ""
echo "=== Stats after Request 2 ==="
curl -s http://127.0.0.1:8090/admin/session-cache | python3 -m json.tool
