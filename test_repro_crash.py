"""Test: after disk prefix cache is active (delta-only prompt), add a fresh cache too.
Simulates the exact path my session-cache code takes on second request."""
import sys
import traceback
from mlx_lm import load, stream_generate
from mlx_lm.models.cache import make_prompt_cache, save_prompt_cache, load_prompt_cache

MODEL_PATH = '/Users/matt123/.lmstudio/models/unsloth/Qwen3.6-35B-A3B-MLX-8bit'

print("Loading model...")
model, tokenizer = load(MODEL_PATH)
print("Loaded.")

SYS_PROMPT = "You are a helpful assistant."
sys_rendered = f"<|im_start|>system\n{SYS_PROMPT}<|im_end|>\n"

# Build prefix cache from system prompt (like server does)
print("Building prefix cache...")
cache = make_prompt_cache(model)
for _ in stream_generate(model, tokenizer, sys_rendered, max_tokens=1, prompt_cache=cache):
    pass
tmp_path = "/tmp/test-prefix-cache.safetensors"
save_prompt_cache(tmp_path, cache, metadata={})
print("Saved disk prefix cache")

# Simulate 1st request: full prompt + fresh cache (my session-cache fallback path)
FULL_PROMPT_1 = f"{sys_rendered}<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n"

print("\n=== Request 1: fresh cache + FULL prompt ===")
fresh = make_prompt_cache(model)
try:
    for resp in stream_generate(model, tokenizer, FULL_PROMPT_1, max_tokens=3, prompt_cache=fresh):
        print(f"  token: {resp.text!r}")
    print("SUCCESS")
except Exception as e:
    print(f"CRASHED: {type(e).__name__}: {e}")
    traceback.print_exc()

# Simulate 2nd request: loaded disk cache + delta (prefix-cache path)
# BUT ALSO simulate my session cache attempting to set fresh cache if 'prompt_cache' not in kwargs
FULL_PROMPT_2 = f"{sys_rendered}<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\nHi!<|im_end|>\n<|im_start|>user\nhow r u<|im_end|>\n<|im_start|>assistant\n"
delta = FULL_PROMPT_2[len(sys_rendered):]

print("\n=== Request 2: loaded prefix cache + DELTA ===")
loaded = load_prompt_cache(tmp_path)
try:
    for resp in stream_generate(model, tokenizer, delta, max_tokens=3, prompt_cache=loaded):
        print(f"  token: {resp.text!r}")
    print("SUCCESS")
except Exception as e:
    print(f"CRASHED: {type(e).__name__}: {e}")
    traceback.print_exc()
