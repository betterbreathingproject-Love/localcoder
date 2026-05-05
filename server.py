"""
MLX Vision Server — OpenAI-compatible API with vision + tool calling support.
Serves at http://localhost:8090/v1
"""

import os, base64, tempfile, time, uuid, json, asyncio, re, sys, threading
from pathlib import Path
from typing import Optional, Union, Any

import importlib
import signal

# ── Module identity fix ───────────────────────────────────────────────────────
# When run as `python server.py`, this module is registered as '__main__' in
# sys.modules. But memory-bridge.py imports it via importlib.import_module("server")
# which would create a SECOND module instance with a DIFFERENT _metal_lock.
# This caused concurrent Metal access crashes (both locks acquired independently).
# Fix: register this module as 'server' so all imports share the same instance.
if __name__ == '__main__' and 'server' not in sys.modules:
    sys.modules['server'] = sys.modules['__main__']

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── memory-bridge integration ─────────────────────────────────────────────────
# Import memory-bridge.py (hyphenated filename requires importlib).
# Wrapped in try/except so server continues if memory-bridge has issues.
_memory_bridge = None
try:
    _memory_bridge = importlib.import_module("memory-bridge")
except Exception as _mem_err:
    print(f"[server] WARNING: Failed to import memory-bridge: {_mem_err}", file=sys.stderr)
    _memory_bridge = None

# ── model state ───────────────────────────────────────────────────────────────
_model = None
_processor = None
_config = None
_model_id = None
_model_path = None
_chat_template = None
_model_is_vision = True  # False when loaded via mlx_lm (text-only fallback)
_models_root = Path.home() / ".lmstudio" / "models"

# ── speculative decoding state ────────────────────────────────────────────────
# When a draft model is loaded, stream_generate receives it as `draft_model`
# and uses speculative_generate_step internally.  The draft must share the
# same tokenizer as the target model (both are Qwen3.5 family here).
_draft_model = None          # nn.Module | None
_draft_model_path = None     # str | None
_speculative_enabled = False # toggled by /admin/speculative
_num_draft_tokens = 4        # sweet-spot for Qwen3.5 0.8B → 35B on Apple Silicon

# ── KV cache quantization state ───────────────────────────────────────────────
# kv_bits=8 halves KV cache memory vs fp16; kv_bits=4 quarters it.
# Passed directly to stream_generate / generate_step via kwargs.
# None = disabled (default, full precision).
_kv_bits: int | None = None  # 4 | 8 | None

# ── prefix cache state ────────────────────────────────────────────────────────
# After model load we prefill the system prompt once and save the KV state to
# disk (~/.qwencoder/cache/<model_key>-sysprompt.safetensors).
# On each request we load that file (0.001s) and pass only the delta tokens
# (everything after the system prompt) to stream_generate.
# Benchmark result: 1.8–3.1× TTFT speedup on typical agentic sessions.
#
# Works even on Qwen3.5's non-trimmable hybrid architecture because we load a
# fresh copy from disk each turn rather than rewinding in-memory state.
_prefix_cache_file: str | None = None   # path to saved .safetensors
_prefix_cache_prompt: str | None = None # the system prompt text that was cached
_prefix_cache_tokens: int = 0           # token count of the cached prefix
_prefix_cache_enabled: bool = True      # can be disabled via /admin/prefix-cache

# ── autotune: KV cache optimisation state ────────────────────────────────────
# Tracks the tokenized length of the system prompt so we can right-size
# max_tokens per request (dynamic KV sizing — autotune's #1 optimization).
# Reset whenever a new model is loaded.
_system_prompt_token_cache: dict = {}   # prompt_text → token_count
_last_metal_clear_time: float = 0.0     # throttle cache clears to once per 10s

# ── inference queue ───────────────────────────────────────────────────────────
# Instead of a single threading.Lock that blocks all callers, we use an
# asyncio.Queue(maxsize=1) as a semaphore. This lets FastAPI's event loop
# stay responsive while requests wait their turn, and enables fair FIFO
# ordering with a configurable queue depth.
_INFERENCE_QUEUE_SIZE = int(os.environ.get("MLX_QUEUE_SIZE", "4"))
_inference_semaphore: asyncio.Semaphore | None = None  # initialized at startup

# ── Metal GPU lock ────────────────────────────────────────────────────────────
# The asyncio semaphore serializes coroutines but can't block threads.
# The main model runs stream_generate in a thread (run_in_executor), while
# the fast model's _extract_generate is a synchronous blocking call.
# Without a threading lock, both can hit Metal simultaneously → SIGABRT
# ("encodeSignalEvent:value: with uncommitted encoder").
# Every code path that touches Metal (main inference, fast model, prefix
# cache build) must hold this lock.
_metal_lock = threading.Lock()

# ── Crash diagnostics: log Metal state on fatal signals ───────────────────────
# SIGABRT/SIGSEGV from Metal can't be prevented, but we can log what was
# happening right before the crash to help diagnose the root cause.
_metal_trace_state = {"last_op": "idle", "last_thread": None, "lock_held_by": None}

def _crash_signal_handler(signum, frame):
    """Log diagnostic info on SIGABRT/SIGSEGV before the process dies."""
    sig_name = signal.Signals(signum).name if hasattr(signal, 'Signals') else str(signum)
    try:
        import traceback
        print(f"\n{'='*60}", file=sys.stderr, flush=True)
        print(f"[CRASH] Signal {sig_name} received!", file=sys.stderr, flush=True)
        print(f"[CRASH] Metal trace state: {_metal_trace_state}", file=sys.stderr, flush=True)
        print(f"[CRASH] _metal_lock locked: {_metal_lock.locked()}", file=sys.stderr, flush=True)
        print(f"[CRASH] Active threads:", file=sys.stderr, flush=True)
        for t in threading.enumerate():
            print(f"[CRASH]   {t.name} (daemon={t.daemon}, alive={t.is_alive()})", file=sys.stderr, flush=True)
        try:
            import mlx.core as mx
            print(f"[CRASH] Metal active memory: {mx.metal.get_active_memory() / (1024**3):.2f} GB", file=sys.stderr, flush=True)
            print(f"[CRASH] Metal peak memory: {mx.metal.get_peak_memory() / (1024**3):.2f} GB", file=sys.stderr, flush=True)
        except Exception:
            print(f"[CRASH] Could not read Metal memory (GPU may be in bad state)", file=sys.stderr, flush=True)
        print(f"[CRASH] Stack trace:", file=sys.stderr, flush=True)
        traceback.print_stack(frame, file=sys.stderr)
        print(f"{'='*60}", file=sys.stderr, flush=True)
    except Exception:
        pass
    # Re-raise with default handler so the process actually terminates
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)

# Install crash handlers — SIGABRT is the one MLX Metal crashes produce
try:
    signal.signal(signal.SIGABRT, _crash_signal_handler)
    signal.signal(signal.SIGSEGV, _crash_signal_handler)
except Exception:
    pass  # some signals can't be caught on all platforms


def _get_inference_semaphore() -> asyncio.Semaphore:
    """Lazy-init the semaphore on the running event loop."""
    global _inference_semaphore
    if _inference_semaphore is None:
        # MLX is single-threaded on Metal, so concurrency=1 serializes inference
        # but the semaphore lets waiters queue without blocking the event loop.
        _inference_semaphore = asyncio.Semaphore(1)
    return _inference_semaphore


def get_metal_lock() -> threading.Lock:
    """Return the global Metal GPU lock. Used by memory-bridge too."""
    return _metal_lock


# ── autotune helpers ──────────────────────────────────────────────────────────

def _estimate_prompt_tokens(prompt: str) -> int:
    """
    Estimate the token count of a prompt string using the loaded tokenizer.
    Falls back to char/4 heuristic if tokenizer is unavailable.
    This is the core of autotune's dynamic KV sizing — we need the actual
    token count to right-size max_tokens without over-allocating KV cache.
    """
    if _processor is None:
        return max(1, len(prompt) // 4)
    try:
        # mlx_lm tokenizer: _processor is a PreTrainedTokenizer
        if hasattr(_processor, 'encode'):
            return len(_processor.encode(prompt))
        # mlx_vlm processor: has a tokenizer attribute
        if hasattr(_processor, 'tokenizer') and hasattr(_processor.tokenizer, 'encode'):
            return len(_processor.tokenizer.encode(prompt))
    except Exception:
        pass
    return max(1, len(prompt) // 4)


def _get_context_window() -> int:
    """Return the model's context window size from config.

    Checks both top-level and nested text_config/llm_config for
    max_position_embeddings — VLM models (Qwen3.5-VL, Qwen3.6) store
    the value under text_config, not at the top level.
    """
    def _extract(cfg: dict) -> int | None:
        # Direct top-level value
        val = cfg.get("max_position_embeddings")
        if val and isinstance(val, int):
            return val
        # Nested under text_config or llm_config (common in VLM models)
        for nested_key in ("text_config", "llm_config"):
            nested = cfg.get(nested_key)
            if isinstance(nested, dict):
                val = nested.get("max_position_embeddings")
                if val and isinstance(val, int):
                    return val
        return None

    if _config and isinstance(_config, dict):
        return _extract(_config) or 32768
    if _model_path:
        try:
            cfg_path = Path(_model_path) / "config.json"
            if cfg_path.exists():
                with open(cfg_path) as f:
                    return _extract(json.load(f)) or 32768
        except Exception:
            pass
    return 32768


def _autotune_max_tokens(prompt: str, requested_max: int) -> int:
    """
    Dynamic KV sizing (autotune optimization #1):
    Cap max_tokens so that prompt_tokens + max_tokens + 256 buffer ≤ context_window.
    This prevents over-allocating KV cache for short prompts.

    On a 32k context model with a 2k token prompt:
      - Without autotune: allocates KV for 32k tokens
      - With autotune: allocates KV for ~3.3k tokens (10× less)
    """
    ctx = _get_context_window()
    prompt_tokens = _estimate_prompt_tokens(prompt)
    # Reserve 256 tokens as a safety buffer
    available = max(256, ctx - prompt_tokens - 256)
    # Cap at requested but never exceed what fits
    capped = min(requested_max, available)
    # Floor at 256 so we always generate something
    result = max(256, capped)
    if result < requested_max:
        print(f"[autotune] max_tokens capped: {requested_max} → {result} "
              f"(prompt={prompt_tokens} tok, ctx={ctx})", file=sys.stderr)
    return result


def _should_clear_metal_cache() -> bool:
    """
    Smart cache clearing (autotune optimization):
    Only clear Metal cache when memory pressure is actually high,
    not before every request. Clearing takes ~50ms and wastes time
    when memory is fine.

    IMPORTANT: Caller must already hold _metal_lock (or be inside a
    run_in_executor block that holds it) because mx.metal.get_active_memory()
    is a Metal API call that races with concurrent GPU work.
    """
    global _last_metal_clear_time
    try:
        import mlx.core as mx
        import subprocess
        active_gb = mx.metal.get_active_memory() / (1024**3)
        total_bytes = int(subprocess.check_output(
            ["sysctl", "-n", "hw.memsize"], timeout=1
        ).strip())
        total_gb = total_bytes / (1024**3)
        pressure = active_gb / total_gb
        # Clear if >65% memory used AND at least 10s since last clear
        now = time.time()
        if pressure > 0.65 and (now - _last_metal_clear_time) > 10.0:
            _last_metal_clear_time = now
            return True
        return False
    except Exception:
        return False


def find_models():
    models = []
    for cfg_path in sorted(_models_root.rglob("config.json")):
        rel = cfg_path.parent.relative_to(_models_root)
        try:
            with open(cfg_path) as f:
                cfg = json.load(f)
            model_type = cfg.get("model_type", "unknown")
            has_vision = "vision_config" in cfg or "image_token_id" in cfg

            # Check if vision weights actually exist in safetensors
            # (distilled text-only models may inherit vision config fields
            # from the base architecture without shipping the weights)
            if has_vision:
                idx_path = cfg_path.parent / "model.safetensors.index.json"
                if idx_path.exists():
                    try:
                        with open(idx_path) as f:
                            idx = json.load(f)
                        weight_keys = idx.get("weight_map", {}).keys()
                        has_vision = any("vision" in k for k in weight_keys)
                    except Exception:
                        pass

            models.append({
                "id": str(rel),
                "path": str(cfg_path.parent),
                "model_type": model_type,
                "vision": has_vision,
            })
        except Exception:
            pass
    return models


def _unload_model():
    """Release the current model and free Metal memory before loading a new one."""
    global _model, _processor, _config, _model_id, _model_path, _chat_template, _model_is_vision
    global _system_prompt_token_cache, _last_metal_clear_time
    global _draft_model, _draft_model_path, _speculative_enabled
    global _prefix_cache_file, _prefix_cache_prompt, _prefix_cache_tokens
    if _model is not None:
        print(f"[server] Unloading current model: {_model_id}")
        _model = None
        _processor = None
        _config = None
        _model_id = None
        _model_path = None
        _chat_template = None
        _model_is_vision = True
        _system_prompt_token_cache = {}
        _last_metal_clear_time = 0.0
        _draft_model = None
        _draft_model_path = None
        _speculative_enabled = False
        _prefix_cache_file = None
        _prefix_cache_prompt = None
        _prefix_cache_tokens = 0
        import gc
        gc.collect()
        try:
            import mlx.core as mx
            with _metal_lock:
                mx.metal.clear_cache()
        except Exception:
            pass
        print(f"[server] Model unloaded, Metal cache cleared")


def load_model(model_path: str):
    global _model, _processor, _config, _model_id, _model_path, _chat_template, _model_is_vision
    print(f"[server] Loading {model_path} ...")

    # ── Always load the primary model as text-only via mlx_lm ────────────────
    # Reason: mlx_vlm is ~2× slower for text generation (26 vs 53 tok/s on 35B).
    # Vision requests are delegated to the fast/extractor model (0.8B) which is
    # loaded separately via memory-bridge and handles images via mlx_vlm.
    # This gives full generation speed on all text tasks with no quality loss.
    try:
        from mlx_lm import load as lm_load
        _model, _processor = lm_load(model_path)
        _config = None
        _model_is_vision = False
        print(f"[server] Loaded as text-only model (mlx_lm) — vision delegated to fast model")
    except Exception as e:
        raise RuntimeError(f"Failed to load model via mlx_lm: {e}") from e

    _model_path = model_path

    raw_id = str(Path(model_path).relative_to(_models_root))

    # The Qwen SDK uses model ID regex to determine modality support.
    # It recognizes "qwen3-vl-*" as vision-capable. All models on this
    # server are Qwen vision models, so always alias to qwen3-vl-*.
    _model_id = f"qwen3-vl-{raw_id.replace('/', '-')}"
    print(f"[server] Reporting model as: {_model_id}")

    # load Jinja chat template for tool calling support
    _chat_template = None
    # Check for enhanced template first (preferred), then standard name
    jinja_path = Path(model_path) / "qwen3.5-enhanced.jinja"
    if not jinja_path.exists():
        jinja_path = Path(model_path) / "chat_template.jinja"
    if jinja_path.exists():
        _chat_template = jinja_path.read_text()
        print(f"[server] Loaded {jinja_path.name} (tool calling enabled)")
        # Log the tool call format the template instructs
        if '<tool_call>' in _chat_template:
            if '<function=' in _chat_template:
                print(f"[server] Template format: XML-parameter style (<function=name><parameter=key>value</parameter>)", file=sys.stderr)
            elif '"name"' in _chat_template or "'name'" in _chat_template:
                print(f"[server] Template format: JSON style ({{\"name\": ..., \"arguments\": ...}})", file=sys.stderr)
            else:
                print(f"[server] Template format: unknown tool_call style", file=sys.stderr)
        print(f"[server] Template length: {len(_chat_template)} chars", file=sys.stderr)
    else:
        # try tokenizer_config.json
        tok_cfg_path = Path(model_path) / "tokenizer_config.json"
        if tok_cfg_path.exists():
            with open(tok_cfg_path) as f:
                tok_cfg = json.load(f)
            if tok_cfg.get("chat_template"):
                _chat_template = tok_cfg["chat_template"]
                print(f"[server] Loaded chat_template from tokenizer_config.json")
    if not _chat_template:
        print(f"[server] WARNING: No chat template found — tool calling will not work")
    print(f"[server] Ready: {_model_id}")

    # ── autotune: Metal shader warm-up ────────────────────────────────────────
    # Run a minimal generation immediately after load to compile Metal shaders.
    # Without this, the first real inference call is 2-5s slower because MLX
    # compiles the GPU kernels on first use. Warm-up makes that cost invisible.
    try:
        _warmup_model()
    except Exception as _wu_err:
        print(f"[server] Warm-up skipped: {_wu_err}", file=sys.stderr)


def _warmup_model():
    """Run a minimal generation to pre-compile Metal shaders after model load."""
    if _model is None:
        return
    print(f"[server] Warming up Metal shaders...", file=sys.stderr)
    start = time.perf_counter()
    try:
        with _metal_lock:
            if _model_is_vision:
                from mlx_vlm import generate
                from mlx_vlm.prompt_utils import apply_chat_template
                warmup_prompt = apply_chat_template(
                    _processor, _config, "Hi",
                    num_images=0,
                )
                generate(_model, _processor, warmup_prompt, max_tokens=1, verbose=False)
            else:
                from mlx_lm import generate
                warmup_prompt = "<|im_start|>user\nHi<|im_end|>\n<|im_start|>assistant\n"
                generate(_model, _processor, warmup_prompt, max_tokens=1)
        elapsed = time.perf_counter() - start
        print(f"[server] Metal shaders warm — first-token latency pre-compiled ({elapsed:.2f}s)", file=sys.stderr)
    except Exception as e:
        print(f"[server] Warm-up generation failed (non-fatal): {e}", file=sys.stderr)


# ── prefix cache helpers ──────────────────────────────────────────────────────

def _prefix_cache_dir() -> Path:
    """Return the directory where prefix cache files are stored."""
    d = Path.home() / ".qwencoder" / "prefix-cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _prefix_cache_key(model_id: str, system_prompt: str) -> str:
    """Stable filename key for a (model, system_prompt) pair."""
    import hashlib
    prompt_hash = hashlib.sha256(system_prompt.encode()).hexdigest()[:16]
    safe_id = (model_id or "unknown").replace("/", "-").replace(":", "-")[-60:]
    return f"{safe_id}-{prompt_hash}.safetensors"


def _cleanup_prefix_caches(keep: int = 3):
    """Keep only the most recent `keep` cache files per model. Deletes the rest."""
    try:
        cache_dir = _prefix_cache_dir()
        files = sorted(cache_dir.glob("*.safetensors"), key=lambda f: f.stat().st_mtime, reverse=True)
        for f in files[keep:]:
            f.unlink()
            print(f"[prefix-cache] Cleaned up old cache: {f.name}", file=sys.stderr)
    except Exception as e:
        print(f"[prefix-cache] Cleanup failed: {e}", file=sys.stderr)


def _build_prefix_cache(system_prompt: str) -> bool:
    """
    Prefill the system prompt once and save the KV state to disk.
    Called after model load + warmup for text-only models.

    Returns True if cache was built successfully, False otherwise.
    """
    global _prefix_cache_file, _prefix_cache_prompt, _prefix_cache_tokens
    if _model is None or _model_is_vision or not _prefix_cache_enabled:
        return False

    try:
        from mlx_lm import stream_generate
        from mlx_lm.models.cache import make_prompt_cache, save_prompt_cache

        cache_path = _prefix_cache_dir() / _prefix_cache_key(_model_id, system_prompt)

        # If a valid cache already exists for this exact prompt, reuse it
        if cache_path.exists():
            print(f"[prefix-cache] Reusing existing cache: {cache_path.name}", file=sys.stderr)
            _prefix_cache_file = str(cache_path)
            _prefix_cache_prompt = system_prompt
            # Count tokens in the cached prompt
            _prefix_cache_tokens = _estimate_prompt_tokens(system_prompt)
            return True

        print(f"[prefix-cache] Building system prompt cache ({len(system_prompt)} chars)...", file=sys.stderr)
        t0 = time.perf_counter()

        with _metal_lock:
            cache_state = make_prompt_cache(_model)
            # Prefill the system prompt (generate 1 token to force full prefill)
            for _ in stream_generate(_model, _processor, system_prompt,
                                     max_tokens=1, prompt_cache=cache_state):
                pass

        # Count cached tokens from the cache offset
        cached_tokens = 0
        for c in cache_state:
            if hasattr(c, 'offset'):
                cached_tokens = c.offset
                break
        if cached_tokens == 0:
            cached_tokens = _estimate_prompt_tokens(system_prompt)

        save_prompt_cache(str(cache_path), cache_state,
                          metadata={"model_id": _model_id or "", "prompt_hash": _prefix_cache_key(_model_id, system_prompt)})

        elapsed = time.perf_counter() - t0
        size_mb = cache_path.stat().st_size / (1024 * 1024)
        print(f"[prefix-cache] Built in {elapsed:.2f}s — {cached_tokens} tokens, {size_mb:.1f} MB → {cache_path.name}", file=sys.stderr)

        _prefix_cache_file = str(cache_path)
        _prefix_cache_prompt = system_prompt
        _prefix_cache_tokens = cached_tokens
        _cleanup_prefix_caches(keep=3)
        return True

    except Exception as e:
        print(f"[prefix-cache] Build failed (non-fatal): {e}", file=sys.stderr)
        _prefix_cache_file = None
        _prefix_cache_prompt = None
        _prefix_cache_tokens = 0
        return False


def _load_prefix_cache():
    """
    Load the saved prefix cache from disk and return it.
    Returns None if no cache is available or loading fails.
    Each call returns a fresh copy — required because Qwen3.5's non-trimmable
    cache accumulates state and cannot be rewound in-memory.
    """
    if not _prefix_cache_enabled or not _prefix_cache_file:
        return None
    try:
        from mlx_lm.models.cache import load_prompt_cache
        return load_prompt_cache(_prefix_cache_file)
    except Exception as e:
        print(f"[prefix-cache] Load failed: {e}", file=sys.stderr)
        return None


def _extract_delta(full_prompt: str, system_prompt: str) -> str:
    """
    Return the portion of full_prompt that comes AFTER the system prompt.
    This is the delta that gets prefilled when the cache already holds the
    system prompt KV state.

    Falls back to the full prompt if the system prompt isn't found at the start.
    """
    if system_prompt and full_prompt.startswith(system_prompt):
        return full_prompt[len(system_prompt):]
    # System prompt not at start — can't use prefix cache for this request
    return full_prompt


# ── app ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="MLX Vision Server")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# ── register memory-bridge router ────────────────────────────────────────────
if _memory_bridge is not None:
    try:
        app.include_router(_memory_bridge.router)
        print("[server] Memory-bridge router registered (/memory/* endpoints)")
    except Exception as _router_err:
        print(f"[server] WARNING: Failed to register memory-bridge router: {_router_err}", file=sys.stderr)


@app.on_event("startup")
async def _startup_memory():
    """Initialize memory-bridge components in the background after server is ready.

    Runs as a fire-and-forget background task so the server starts accepting
    requests immediately — memory init (especially VectorMemory loading
    sentence-transformers) can take 2-5s and must not block startup.

    The fast extraction model is loaded by the Electron main process after the
    primary model loads successfully (via the load-model IPC handler), using
    the user's saved lastFastModelPath preference.
    """
    if _memory_bridge is not None:
        import asyncio
        async def _init_bg():
            try:
                await _memory_bridge.initialize()
                print("[server] Memory-bridge initialized ✅", flush=True)
            except Exception as e:
                print(f"[server] WARNING: Memory-bridge initialization failed: {e}", file=sys.stderr, flush=True)

        # Schedule as background task — server is already serving by the time this runs
        asyncio.create_task(_init_bg())


@app.on_event("shutdown")
async def _shutdown_memory():
    """Flush memory-bridge components on server shutdown."""
    if _memory_bridge is not None:
        try:
            await _memory_bridge.shutdown()
            print("[server] Memory-bridge shutdown complete")
        except Exception as e:
            print(f"[server] WARNING: Memory-bridge shutdown failed: {e}", file=sys.stderr)


# ── schemas ───────────────────────────────────────────────────────────────────
class Message(BaseModel):
    role: str
    content: Optional[Union[str, list]] = None
    tool_calls: Optional[list] = None
    tool_call_id: Optional[str] = None
    name: Optional[str] = None


class ToolFunction(BaseModel):
    name: str
    description: Optional[str] = None
    parameters: Optional[dict] = None


class Tool(BaseModel):
    type: str = "function"
    function: ToolFunction


class ChatRequest(BaseModel):
    model: Optional[str] = None
    messages: list[Message]
    max_tokens: Optional[int] = 8192
    temperature: Optional[float] = 0.6
    top_p: Optional[float] = 0.95
    repetition_penalty: Optional[float] = 1.05
    stream: Optional[bool] = False
    tools: Optional[list[Tool]] = None
    tool_choice: Optional[Any] = None


class LoadRequest(BaseModel):
    model_path: str


# ── tool call parsing ─────────────────────────────────────────────────────────
_TOOL_CALL_RE = re.compile(
    r'<tool_call>\s*<function=([^>]+)>(.*?)</function>\s*</tool_call>',
    re.DOTALL
)
# Fallback: <tool_call> blocks containing JSON (Qwen 2.5/3.x alternate format)
# Use greedy match to capture the full JSON including nested braces
_TOOL_CALL_JSON_RE = re.compile(
    r'<tool_call>\s*(\{.+\})\s*</tool_call>',
    re.DOTALL
)
_PARAM_RE = re.compile(
    r'<parameter=([^>]+)>\n?(.*?)\n?</parameter>',
    re.DOTALL
)


def parse_tool_calls(text: str):
    """Parse Qwen-format <tool_call> blocks into OpenAI tool_calls format.
    Supports both XML-parameter style and JSON style tool calls."""
    tool_calls = []
    for match in _TOOL_CALL_RE.finditer(text):
        func_name = match.group(1).strip()
        body = match.group(2)
        args = {}
        for pm in _PARAM_RE.finditer(body):
            param_name = pm.group(1).strip()
            param_value = pm.group(2).strip()
            # try to parse as JSON value, fall back to string
            try:
                args[param_name] = json.loads(param_value)
            except (json.JSONDecodeError, ValueError):
                args[param_name] = param_value
        tool_calls.append({
            "id": f"call_{uuid.uuid4().hex[:12]}",
            "type": "function",
            "function": {
                "name": func_name,
                "arguments": json.dumps(args),
            }
        })

    # Fallback: if no XML-style tool calls found, try JSON-style
    # e.g. <tool_call>{"name": "read_file", "arguments": {"path": "index.html"}}</tool_call>
    if not tool_calls:
        for match in _TOOL_CALL_JSON_RE.finditer(text):
            try:
                obj = json.loads(match.group(1))
                name = obj.get("name", "")
                arguments = obj.get("arguments", {})
                if name:
                    tool_calls.append({
                        "id": f"call_{uuid.uuid4().hex[:12]}",
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": json.dumps(arguments) if isinstance(arguments, dict) else str(arguments),
                        }
                    })
            except (json.JSONDecodeError, ValueError):
                pass

    return tool_calls


# ── incremental tool call parsing for streaming ──────────────────────────────
_FUNC_NAME_RE = re.compile(r'<function=([^>]+)>')

def parse_partial_tool_args(body: str) -> str:
    """Parse completed <parameter> tags from a partial tool call body into JSON.
    Returns the JSON-encoded arguments string built so far."""
    args = {}
    for pm in _PARAM_RE.finditer(body):
        param_name = pm.group(1).strip()
        param_value = pm.group(2).strip()
        try:
            args[param_name] = json.loads(param_value)
        except (json.JSONDecodeError, ValueError):
            args[param_name] = param_value

    # Also capture a parameter that's still being written (no closing tag yet)
    # e.g. <parameter=content>partial code here...
    last_open = body.rfind('<parameter=')
    if last_open != -1:
        after = body[last_open:]
        # Check if this parameter is NOT closed yet
        close_pos = after.find('</parameter>')
        if close_pos == -1:
            # Extract name and partial value
            name_match = re.match(r'<parameter=([^>]+)>\n?', after)
            if name_match:
                param_name = name_match.group(1).strip()
                partial_val = after[name_match.end():]
                if param_name not in args:
                    args[param_name] = partial_val

    return json.dumps(args)


def strip_tool_calls(text: str) -> str:
    """Remove <tool_call> blocks from text to get the content portion."""
    cleaned = _TOOL_CALL_RE.sub('', text).strip()
    return cleaned


def strip_thinking(text: str) -> str:
    """Remove <think>...</think> blocks from text."""
    return re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()


def extract_thinking(text: str) -> tuple[str | None, str]:
    """Separate <think>...</think> content from the rest of the response.

    Returns (reasoning_content, remaining_text).
    reasoning_content is None if no thinking block was found.
    """
    match = re.search(r'<think>(.*?)</think>', text, flags=re.DOTALL)
    if match:
        reasoning = match.group(1).strip()
        remaining = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()
        return (reasoning if reasoning else None), remaining
    # Handle unclosed think block (model hit max_tokens mid-think)
    unclosed = re.search(r'<think>(.*)', text, flags=re.DOTALL)
    if unclosed:
        reasoning = unclosed.group(1).strip()
        return (reasoning if reasoning else None), ''
    return None, text


# ── helpers ───────────────────────────────────────────────────────────────────
def extract_text_and_images(messages: list[Message]):
    """Return (last_user_text, [image_paths]) from a message list."""
    images, text = [], ""
    for msg in messages:
        if msg.role != "user":
            continue
        if isinstance(msg.content, str):
            text = msg.content
        elif isinstance(msg.content, list):
            parts_text = []
            for part in msg.content:
                p = part if isinstance(part, dict) else part.dict()
                if p.get("type") == "text":
                    parts_text.append(p.get("text", ""))
                elif p.get("type") == "image_url":
                    url = (p.get("image_url") or {}).get("url", "")
                    if url.startswith("data:image"):
                        header, b64 = url.split(",", 1)
                        ext = header.split("/")[1].split(";")[0]
                        img_bytes = base64.b64decode(b64)
                        # Resize large images to prevent MLX OOM
                        img_bytes = _resize_image(img_bytes, max_dim=768)
                        tmp = tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False)
                        tmp.write(img_bytes)
                        tmp.flush()
                        tmp.close()
                        images.append(tmp.name)
                    elif url:
                        images.append(url)
            text = " ".join(parts_text)
    return text, images


def _resize_image(img_bytes: bytes, max_dim: int = 768) -> bytes:
    """Resize image if either dimension exceeds max_dim. Returns raw bytes."""
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(img_bytes))
        w, h = img.size
        if w <= max_dim and h <= max_dim:
            return img_bytes
        # Scale down preserving aspect ratio
        scale = max_dim / max(w, h)
        new_w, new_h = int(w * scale), int(h * scale)
        img = img.resize((new_w, new_h), Image.LANCZOS)
        buf = io.BytesIO()
        fmt = img.format or "PNG"
        if fmt.upper() == "JPEG" or img.mode == "RGB":
            img.save(buf, format="JPEG", quality=85)
        else:
            if img.mode == "RGBA":
                img.save(buf, format="PNG")
            else:
                img.save(buf, format="PNG")
        print(f"[server] Resized image {w}x{h} → {new_w}x{new_h}", file=sys.stderr)
        return buf.getvalue()
    except ImportError:
        print("[server] PIL not available, skipping image resize", file=sys.stderr)
        return img_bytes
    except Exception as e:
        print(f"[server] Image resize failed: {e}", file=sys.stderr)
        return img_bytes


def get_system_prompt(messages):
    for msg in messages:
        if msg.role == "system":
            return msg.content if isinstance(msg.content, str) else ""
    return None


def _cleanup_images(images):
    for img in images:
        if img.startswith(tempfile.gettempdir()):
            try: os.unlink(img)
            except: pass


# ── prompt building ───────────────────────────────────────────────────────────
def _build_prompt_with_tools(req: ChatRequest):
    """Build prompt using the Jinja chat template directly, with tools support."""
    from jinja2 import Environment, BaseLoader

    # convert messages to template format
    tmpl_messages = []
    for i, msg in enumerate(req.messages):
        m = {"role": msg.role}

        # Use 'developer' role for the first system message — Unsloth's Qwen3.6
        # models support this role for agentic coding tools (Codex, OpenCode, etc.)
        # and it signals trusted developer instructions vs user-injected content.
        if msg.role == "system" and i == 0:
            m["role"] = "developer"

        # Mid-conversation system messages (nudges, LSP diagnostics, warnings)
        # are silently dropped by the Jinja template's fix #4 (only the first
        # system/developer message is rendered). Convert them to user messages
        # with a [SYSTEM] prefix so they actually reach the model.
        elif msg.role == "system" and i > 0:
            m["role"] = "user"
            content = msg.content or ""
            if isinstance(content, list):
                content = " ".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
            m["content"] = f"[SYSTEM]: {content}"
            tmpl_messages.append(m)
            continue

        if msg.content is not None:
            if isinstance(msg.content, list):
                # flatten multimodal content to text for tool-calling path
                parts = []
                for p in msg.content:
                    pp = p if isinstance(p, dict) else p.dict()
                    if pp.get("type") == "text":
                        parts.append(pp["text"])
                m["content"] = " ".join(parts)
            else:
                m["content"] = msg.content
        else:
            m["content"] = ""
        if msg.tool_calls:
            # Ensure tool_call arguments are dicts (not JSON strings) so the
            # Jinja template's `arguments is mapping` check works correctly.
            # The template iterates over arguments as key-value pairs.
            fixed_tool_calls = []
            for tc in msg.tool_calls:
                tc_copy = dict(tc) if isinstance(tc, dict) else tc
                if isinstance(tc_copy, dict):
                    fn = tc_copy.get("function", {})
                    if isinstance(fn, dict) and isinstance(fn.get("arguments"), str):
                        try:
                            fn["arguments"] = json.loads(fn["arguments"])
                        except (json.JSONDecodeError, ValueError):
                            pass
                fixed_tool_calls.append(tc_copy)
            m["tool_calls"] = fixed_tool_calls
        if msg.tool_call_id:
            # tool result message — Qwen template expects role="tool"
            m["role"] = "tool"
        tmpl_messages.append(m)

    # convert tools to template format
    tmpl_tools = None
    if req.tools:
        tmpl_tools = []
        for t in req.tools:
            tmpl_tools.append({
                "type": "function",
                "function": {
                    "name": t.function.name,
                    "description": t.function.description or "",
                    "parameters": t.function.parameters or {},
                }
            })

    env = Environment(loader=BaseLoader(), keep_trailing_newline=True)
    env.globals["raise_exception"] = lambda msg: (_ for _ in ()).throw(Exception(msg))
    template = env.from_string(_chat_template)

    # Template kwargs — the enhanced Barubary template supports these:
    # - auto_disable_thinking_with_tools: prevents <tool_call> leaking into <think> blocks
    # - max_tool_response_chars: truncate large tool responses in history
    template_kwargs = {
        "messages": tmpl_messages,
        "tools": tmpl_tools,
        "add_generation_prompt": True,
        "enable_thinking": True,
        "auto_disable_thinking_with_tools": True,
        "max_tool_response_chars": 8000,
    }

    try:
        prompt = template.render(**template_kwargs)
    except Exception as e:
        print(f"[server] ❌ Jinja template render FAILED: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        # Fallback: render without tools
        prompt = template.render(
            messages=tmpl_messages,
            tools=None,
            add_generation_prompt=True,
            enable_thinking=True,
        )

    # Debug: log whether tools appear in the rendered prompt
    if tmpl_tools:
        tool_names_in_prompt = [t["function"]["name"] for t in tmpl_tools if t["function"]["name"] in prompt]
        if not tool_names_in_prompt:
            print(f"[server] ⚠️ WARNING: No tool names found in rendered prompt! Template may not be rendering tools.", file=sys.stderr)
            print(f"[server] Prompt first 500 chars: {prompt[:500]}", file=sys.stderr)
        else:
            print(f"[server] ✅ Tools in prompt: {tool_names_in_prompt[:5]}...", file=sys.stderr)

    return prompt


def _build_prompt_and_kwargs(req: ChatRequest):
    """Build prompt — uses Jinja template when tools present, mlx_vlm otherwise."""
    images = []
    if _model_is_vision:
        _, images = extract_text_and_images(req.messages)

    has_tools = bool(req.tools) and bool(_chat_template)

    if has_tools:
        prompt = _build_prompt_with_tools(req)
        print(f"[server] Built prompt with tools ({len(req.tools)} tools), len={len(prompt)}", file=sys.stderr)
    elif _model_is_vision:
        from mlx_vlm.prompt_utils import apply_chat_template
        text, _ = extract_text_and_images(req.messages)
        system = get_system_prompt(req.messages)
        prompt = apply_chat_template(
            _processor, _config, text,
            num_images=len(images),
            system_prompt=system,
        )
    else:
        # Text-only model (mlx_lm) — build prompt via chat template or manual concat
        if _chat_template:
            prompt = _build_prompt_with_tools(req)
        else:
            # Simple fallback: concatenate messages
            parts = []
            for msg in req.messages:
                content = msg.content if isinstance(msg.content, str) else str(msg.content or "")
                parts.append(f"<|im_start|>{msg.role}\n{content}<|im_end|>")
            parts.append("<|im_start|>assistant\n")
            prompt = "\n".join(parts)
        print(f"[server] Built text-only prompt, len={len(prompt)}", file=sys.stderr)

    kwargs = dict(max_tokens=min(req.max_tokens or 1024, 32768))
    if _model_is_vision:
        kwargs["verbose"] = False
    if req.temperature is not None:
        if _model_is_vision:
            kwargs["temp"] = req.temperature
        else:
            # mlx_lm uses a sampler callable for temperature control
            import mlx.core as mx
            t = req.temperature
            if t == 0:
                kwargs["sampler"] = lambda logits: mx.argmax(logits, axis=-1)
            else:
                def _temp_sampler(logits, _t=t):
                    return mx.random.categorical(logits / _t)
                kwargs["sampler"] = _temp_sampler
    if req.top_p is not None:
        if _model_is_vision:
            kwargs["top_p"] = req.top_p
    if req.repetition_penalty is not None:
        if _model_is_vision:
            kwargs["repetition_penalty"] = req.repetition_penalty
    if images:
        kwargs["image"] = images[0] if len(images) == 1 else images
    return prompt, kwargs, images


# ── routes ────────────────────────────────────────────────────────────────────
@app.get("/v1/models")
def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": f"qwen3-vl-{m['id'].replace('/', '-')}",
                "path": m["path"],
                "object": "model",
                "owned_by": "mlx",
                "model_type": m["model_type"],
                "vision": m["vision"],
                "capabilities": (["tool_use", "image_input"] if m["vision"]
                                 else ["tool_use"]),
                "architecture": {
                    "input_modalities": (["text", "image"] if m["vision"]
                                         else ["text"]),
                    "output_modalities": ["text"],
                },
            }
            for m in find_models()
        ],
    }


@app.post("/admin/load")
async def admin_load(req: LoadRequest):
    # Acquire the inference semaphore so we don't swap the model while an
    # inference request is in-flight.  This waits (without blocking the
    # event loop) until any running inference finishes.
    sem = _get_inference_semaphore()
    async with sem:
        try:
            # Free the old model *before* loading the new one so both don't
            # coexist in Metal memory (which causes OOM crashes).
            _unload_model()
            # load_model is CPU/IO-heavy — run in a thread so the event loop
            # stays responsive and the server doesn't appear to crash.
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, load_model, req.model_path)
            return {"status": "ok", "model_id": _model_id}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))


@app.get("/admin/status")
def admin_status():
    models = find_models()
    # alias all model IDs to qwen3-vl-* for SDK vision support
    for m in models:
        m["id"] = f"qwen3-vl-{m['id'].replace('/', '-')}"
    return {
        "loaded": _model_id,
        "models": models,
        "autotune_enabled": True,  # always active — built into server
        "autotune_features": ["dynamic_kv_sizing", "smart_cache_clearing", "prefill_batching"],
        # ── speculative decoding ──────────────────────────────────────────────
        "speculative_enabled": _speculative_enabled,
        "draft_model": _draft_model_path,
        "num_draft_tokens": _num_draft_tokens if _speculative_enabled else None,
        # ── KV cache quantization ─────────────────────────────────────────────
        "kv_bits": _kv_bits,
        # ── prefix cache ──────────────────────────────────────────────────────
        "prefix_cache_enabled": _prefix_cache_enabled,
        "prefix_cache_tokens": _prefix_cache_tokens,
        "prefix_cache_ready": _prefix_cache_file is not None,
    }


@app.get("/admin/autotune-stats")
def autotune_stats():
    """Return current autotune state and memory snapshot."""
    ctx = _get_context_window() if _model else 0
    try:
        import mlx.core as mx
        import subprocess
        with _metal_lock:
            active_gb = mx.metal.get_active_memory() / (1024**3)
            peak_gb = mx.metal.get_peak_memory() / (1024**3)
            cache_gb = mx.metal.get_cache_memory() / (1024**3)
        total_bytes = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], timeout=1).strip())
        total_gb = total_bytes / (1024**3)
        pressure_pct = round(active_gb / total_gb * 100, 1) if total_gb > 0 else 0
    except Exception:
        active_gb = peak_gb = cache_gb = total_gb = 0.0
        pressure_pct = 0.0
    return {
        "model_loaded": _model_id is not None,
        "context_window": ctx,
        "metal_active_gb": round(active_gb, 3),
        "metal_peak_gb": round(peak_gb, 3),
        "metal_cache_gb": round(cache_gb, 3),
        "total_ram_gb": round(total_gb, 1),
        "memory_pressure_pct": pressure_pct,
        "smart_clear_threshold_pct": 65,
        "prefill_batch_size": 1024,
        "features_active": ["dynamic_kv_sizing", "smart_cache_clearing", "prefill_batching"],
    }


# ── speculative decoding admin ────────────────────────────────────────────────

@app.post("/admin/unload")
async def admin_unload():
    """
    Unload the current model and free all Metal memory.
    Called by the Electron main process before app shutdown so GPU memory is
    released cleanly rather than waiting for the OS to reclaim it after SIGTERM.
    """
    sem = _get_inference_semaphore()
    async with sem:
        _unload_model()
    return {"ok": True, "message": "Model unloaded"}


class SpeculativeRequest(BaseModel):
    enabled: bool
    draft_model_path: Optional[str] = None  # required when enabled=True
    num_draft_tokens: Optional[int] = None  # default: 4


@app.post("/admin/speculative")
async def admin_speculative(req: SpeculativeRequest):
    """
    Enable or disable speculative decoding.

    When enabled, the draft model is loaded into memory alongside the target
    model.  Both models must share the same tokenizer (Qwen3.5 family).
    The draft model (0.8B) generates `num_draft_tokens` candidate tokens per
    step; the target model (35B) verifies them in a single forward pass.
    Typical speedup: 1.5–2.5× on Apple Silicon for coding tasks.

    POST /admin/speculative
    {"enabled": true, "draft_model_path": "/path/to/Qwen3.5-0.8B-MLX-8bit", "num_draft_tokens": 4}
    {"enabled": false}
    """
    global _draft_model, _draft_model_path, _speculative_enabled, _num_draft_tokens

    if not req.enabled:
        _draft_model = None
        _draft_model_path = None
        _speculative_enabled = False
        import gc; gc.collect()
        try:
            import mlx.core as mx
            with _metal_lock:
                mx.metal.clear_cache()
        except Exception:
            pass
        print("[server] Speculative decoding disabled, draft model unloaded")
        return {"status": "ok", "speculative_enabled": False}

    if not req.draft_model_path:
        raise HTTPException(400, "draft_model_path is required when enabling speculative decoding")
    if _model is None:
        raise HTTPException(503, "Target model must be loaded before enabling speculative decoding")
    if _model_is_vision:
        raise HTTPException(400, "Speculative decoding is only supported for text-only models (mlx_lm). "
                                 "Load the target model as text-only first.")

    sem = _get_inference_semaphore()
    async with sem:
        try:
            print(f"[server] Loading draft model for speculative decoding: {req.draft_model_path}")
            from mlx_lm import load as lm_load
            loop = asyncio.get_event_loop()
            draft_m, _ = await loop.run_in_executor(None, lm_load, req.draft_model_path)
            _draft_model = draft_m
            _draft_model_path = req.draft_model_path
            _speculative_enabled = True
            if req.num_draft_tokens is not None:
                _num_draft_tokens = max(1, min(req.num_draft_tokens, 16))
            print(f"[server] Speculative decoding enabled — draft={req.draft_model_path}, "
                  f"num_draft_tokens={_num_draft_tokens}")
            return {
                "status": "ok",
                "speculative_enabled": True,
                "draft_model": _draft_model_path,
                "num_draft_tokens": _num_draft_tokens,
            }
        except Exception as e:
            _draft_model = None
            _draft_model_path = None
            _speculative_enabled = False
            raise HTTPException(500, f"Failed to load draft model: {e}")


# ── KV cache quantization admin ───────────────────────────────────────────────

class KVCacheRequest(BaseModel):
    bits: Optional[int] = None  # 4 | 8 | None (None = disable)


@app.post("/admin/kv-cache")
async def admin_kv_cache(req: KVCacheRequest):
    """
    Configure KV cache quantization.

    Quantizing the KV cache reduces memory usage at the cost of a small
    quality degradation.  Useful for long-context requests on memory-constrained
    hardware.

    bits=8  → ~50% KV cache memory reduction vs fp16 (recommended)
    bits=4  → ~75% KV cache memory reduction (more aggressive, slight quality loss)
    bits=null → disable quantization (full fp16 precision)

    POST /admin/kv-cache
    {"bits": 8}   # enable 8-bit KV cache
    {"bits": null} # disable
    """
    global _kv_bits

    if req.bits is not None and req.bits not in (4, 8):
        raise HTTPException(400, "bits must be 4, 8, or null")

    _kv_bits = req.bits
    if _kv_bits is not None:
        print(f"[server] KV cache quantization enabled: {_kv_bits}-bit")
    else:
        print("[server] KV cache quantization disabled (full fp16)")
    return {"status": "ok", "kv_bits": _kv_bits}


# ── prefix cache admin ────────────────────────────────────────────────────────

class PrefixCacheRequest(BaseModel):
    enabled: Optional[bool] = None          # toggle on/off
    system_prompt: Optional[str] = None     # build cache for this system prompt
    rebuild: Optional[bool] = False         # force rebuild even if cache exists


@app.post("/admin/prefix-cache")
async def admin_prefix_cache(req: PrefixCacheRequest):
    """
    Manage the system-prompt prefix cache.

    Build:   POST {"system_prompt": "<|im_start|>system\\n...\\n<|im_end|>\\n"}
    Rebuild: POST {"system_prompt": "...", "rebuild": true}
    Disable: POST {"enabled": false}
    Enable:  POST {"enabled": true}
    Status:  GET  /admin/status  (includes prefix_cache fields)

    The cache is built automatically after model load when the first request
    arrives with a system prompt. This endpoint lets you pre-build it or
    rebuild after the system prompt changes.
    """
    global _prefix_cache_enabled, _prefix_cache_file, _prefix_cache_prompt, _prefix_cache_tokens

    if req.enabled is not None:
        _prefix_cache_enabled = req.enabled
        print(f"[prefix-cache] {'Enabled' if req.enabled else 'Disabled'}")

    if req.system_prompt is not None:
        if _model is None:
            raise HTTPException(503, "No model loaded")
        if _model_is_vision:
            raise HTTPException(400, "Prefix cache only supported for text-only models")

        # Delete existing cache file if rebuild requested
        if req.rebuild and _prefix_cache_file and Path(_prefix_cache_file).exists():
            try:
                Path(_prefix_cache_file).unlink()
                print(f"[prefix-cache] Deleted existing cache for rebuild")
            except Exception:
                pass
            _prefix_cache_file = None
            _prefix_cache_prompt = None
            _prefix_cache_tokens = 0

        sem = _get_inference_semaphore()
        async with sem:
            loop = asyncio.get_event_loop()
            ok = await loop.run_in_executor(None, _build_prefix_cache, req.system_prompt)

        if not ok:
            raise HTTPException(500, "Failed to build prefix cache")

    return {
        "status": "ok",
        "prefix_cache_enabled": _prefix_cache_enabled,
        "prefix_cache_file": _prefix_cache_file,
        "prefix_cache_tokens": _prefix_cache_tokens,
        "prefix_cache_prompt_len": len(_prefix_cache_prompt) if _prefix_cache_prompt else 0,
    }


@app.get("/admin/prefix-cache")
async def admin_prefix_cache_status():
    """Return current prefix cache state."""
    cache_size_mb = 0.0
    if _prefix_cache_file and Path(_prefix_cache_file).exists():
        cache_size_mb = round(Path(_prefix_cache_file).stat().st_size / (1024 * 1024), 1)
    return {
        "prefix_cache_enabled": _prefix_cache_enabled,
        "prefix_cache_file": _prefix_cache_file,
        "prefix_cache_tokens": _prefix_cache_tokens,
        "prefix_cache_prompt_len": len(_prefix_cache_prompt) if _prefix_cache_prompt else 0,
        "cache_size_mb": cache_size_mb,
    }


# ── benchmark ─────────────────────────────────────────────────────────────────
BENCHMARK_PROMPT = (
    "You are a helpful coding assistant. Explain step by step how to implement "
    "a binary search algorithm in Python. Include the function signature, the "
    "base case for an empty array, the midpoint calculation using integer "
    "division, the comparison logic for the target value against the middle "
    "element, and the recursive calls for the left and right halves of the "
    "array. Also describe the time complexity and space complexity of the "
    "algorithm, and give an example of calling the function with a sorted "
    "list of integers and a target value that exists in the list."
)


class BenchmarkResponse(BaseModel):
    generation_tps: float
    prompt_tps: float
    peak_memory_gb: float
    available_memory_gb: float
    context_window: int


@app.post("/admin/abort")
async def admin_abort():
    """
    Signal the current inference to stop and wait until the semaphore is free.
    Called by the client after destroying the SSE connection to ensure the
    inference thread has fully released Metal resources before the next request.
    Times out after 8s and returns regardless — the semaphore will be released
    eventually by the inference thread's finally block.
    """
    sem = _get_inference_semaphore()
    try:
        # Try to acquire the semaphore — this blocks until the inference thread
        # releases it (i.e. Metal cleanup is done). Timeout after 8s.
        await asyncio.wait_for(sem.acquire(), timeout=8.0)
        sem.release()  # immediately release — we just wanted to confirm it's free
        return {"ok": True, "idle": True}
    except asyncio.TimeoutError:
        # Inference thread is taking too long — return anyway, client will retry
        return {"ok": True, "idle": False, "note": "timed out waiting for inference to finish"}


@app.post("/admin/benchmark")
async def benchmark():
    """Run a short inference pass and return performance metrics."""
    if _model is None:
        raise HTTPException(status_code=503, detail="No model loaded")

    sem = _get_inference_semaphore()
    async with sem:
        try:
            import mlx.core as mx

            # Build a simple text prompt for benchmarking
            if _model_is_vision:
                from mlx_vlm import generate
                from mlx_vlm.prompt_utils import apply_chat_template
                prompt = apply_chat_template(
                    _processor, _config, BENCHMARK_PROMPT,
                    num_images=0,
                )
                gen_kwargs = dict(max_tokens=200, verbose=False)
            else:
                from mlx_lm import generate
                # Build prompt using chat template or simple fallback
                if _chat_template:
                    from jinja2 import Environment, BaseLoader
                    env = Environment(loader=BaseLoader(), keep_trailing_newline=True)
                    env.globals["raise_exception"] = lambda msg: (_ for _ in ()).throw(Exception(msg))
                    template = env.from_string(_chat_template)
                    prompt = template.render(
                        messages=[{"role": "user", "content": BENCHMARK_PROMPT}],
                        tools=None,
                        add_generation_prompt=True,
                        enable_thinking=False,
                    )
                else:
                    prompt = f"<|im_start|>user\n{BENCHMARK_PROMPT}<|im_end|>\n<|im_start|>assistant\n"
                gen_kwargs = dict(max_tokens=200)

            # Run generation in a thread to keep the event loop responsive.
            # Hold _metal_lock so the benchmark doesn't race with the fast
            # model or prefix-cache build — contention would skew the result.
            loop = asyncio.get_event_loop()

            def _run_benchmark():
                with _metal_lock:
                    return generate(_model, _processor, prompt, **gen_kwargs)

            start = time.perf_counter()
            result = await loop.run_in_executor(None, _run_benchmark)
            elapsed = time.perf_counter() - start

            # Prefer MLX's own TPS metrics — they measure each phase separately
            # and match what users see during normal inference.
            gen_tps = getattr(result, 'generation_tps', None)
            prompt_tps = getattr(result, 'prompt_tps', None)

            # Fallback: estimate from token counts / total elapsed (less accurate)
            if gen_tps is None or prompt_tps is None:
                gen_tokens = getattr(result, 'generation_tokens', None)
                prompt_tokens = getattr(result, 'prompt_tokens', None)
                if gen_tokens is None:
                    result_text = result.text if hasattr(result, 'text') else str(result)
                    gen_tokens = max(1, len(result_text.split()))
                if prompt_tokens is None:
                    prompt_tokens = max(1, len(BENCHMARK_PROMPT.split()))
                if gen_tps is None:
                    gen_tps = gen_tokens / elapsed if elapsed > 0 else 0
                if prompt_tps is None:
                    prompt_tps = prompt_tokens / elapsed if elapsed > 0 else 0

            with _metal_lock:
                peak_mem = mx.metal.get_peak_memory() / (1024**3)
                active_mem = mx.metal.get_active_memory() / (1024**3)
            # Available memory = total system memory minus what MLX is actively using
            import os
            total_mem = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') / (1024**3)
            avail_mem = max(0, total_mem - active_mem)

            # Read context window from model config
            ctx_window = _get_context_window()

            return BenchmarkResponse(
                generation_tps=round(gen_tps, 2),
                prompt_tps=round(prompt_tps, 2),
                peak_memory_gb=round(peak_mem, 3),
                available_memory_gb=round(avail_mem, 3),
                context_window=ctx_window,
            )
        except Exception as e:
            # Task 3.2: Metal memory error handling
            if "metal" in str(e).lower() or "mps" in str(e).lower():
                try:
                    import mlx.core as mx
                    with _metal_lock:
                        mx.metal.clear_cache()
                    import gc
                    gc.collect()
                except Exception:
                    pass
                raise HTTPException(status_code=500, detail=f"Metal memory error: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))


async def _route_vision_request(req: ChatRequest):
    """
    Route an image-containing request to the fast model via memory-bridge.

    Extracts all images from the request, calls memory-bridge's _handle_vision
    for each image, then returns a standard OpenAI chat completion response.
    Falls back gracefully if the fast model isn't loaded.
    
    Acquires the inference semaphore to properly serialize with main model
    inference — prevents the next main model request from starting while
    vision is still using the GPU (which would block on _metal_lock and
    cause client-side timeouts).
    """
    import uuid as _uuid
    import base64 as _b64

    # Acquire inference semaphore so the main model waits for vision to finish
    # before starting its next turn. Without this, the main model's request
    # arrives while vision holds _metal_lock → blocks → client times out.
    sem = _get_inference_semaphore()
    await sem.acquire()
    try:
        return await _route_vision_request_inner(req)
    finally:
        sem.release()


async def _route_vision_request_inner(req: ChatRequest):
    """Inner implementation of vision routing (called under semaphore)."""
    import uuid as _uuid
    import base64 as _b64

    text, images = extract_text_and_images(req.messages)
    user_prompt = text or "Describe this image in detail."

    descriptions = []
    errors = []

    for img_path in images:
        try:
            with open(img_path, "rb") as f:
                img_bytes = f.read()
            img_b64 = _b64.b64encode(img_bytes).decode()
            ext = img_path.rsplit(".", 1)[-1].lower() if "." in img_path else "png"
            mime = f"image/{'jpeg' if ext in ('jpg', 'jpeg') else ext}"

            if _memory_bridge is not None and hasattr(_memory_bridge, '_handle_vision'):
                payload = {"image_b64": img_b64, "mime_type": mime, "prompt": user_prompt}
                result = await _memory_bridge._handle_vision(payload)
                if result and result.result:
                    descriptions.append(result.result)
                else:
                    # Log the actual state to help diagnose
                    has_vision_flag = getattr(_memory_bridge, '_extract_model_has_vision', 'N/A')
                    model_loaded = getattr(_memory_bridge, '_extract_model', None) is not None
                    print(f"[server] _handle_vision returned None — model_loaded={model_loaded}, has_vision={has_vision_flag}", file=sys.stderr)
                    errors.append("Vision model not loaded — load the 0.8B fast model to enable screenshot analysis")
            else:
                errors.append("Vision model not available — load the 0.8B fast model in the app")
        except Exception as e:
            errors.append(f"Vision analysis failed: {e}")
            print(f"[server] Vision routing error: {e}", file=sys.stderr)
        finally:
            _cleanup_images([img_path])

    if descriptions:
        content = "\n\n".join(descriptions)
        if errors:
            content += f"\n\n(Note: {len(errors)} image(s) could not be analyzed)"
    elif errors:
        # Fast model not loaded — give the agent a clear, non-blocking message
        # so it can continue working without vision rather than getting stuck
        content = f"[Screenshot captured but vision model not loaded — load the 0.8B fast model to enable image analysis. Proceed based on what you expect to see on screen.]"
    else:
        content = "No images could be processed."

    cid = f"chatcmpl-{_uuid.uuid4().hex[:12]}"
    return {
        "id": cid,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": _model_id or "fast-vision",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 0, "completion_tokens": len(content) // 4, "total_tokens": len(content) // 4},
    }


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatRequest):
    if _model is None:
        raise HTTPException(503, "No model loaded.")

    has_tools = bool(req.tools)
    _, images_check = extract_text_and_images(req.messages)
    has_images = bool(images_check)
    # clean up the check images (they'll be re-extracted in _build_prompt_and_kwargs)
    _cleanup_images(images_check)

    # ── vision routing: delegate image requests to the fast model ─────────────
    # The primary model is loaded as text-only (mlx_lm) for 2× generation speed.
    # Image requests are routed to the fast/extractor model (0.8B) via the
    # memory-bridge /memory/assist vision endpoint, which uses mlx_vlm.
    # Falls back to the primary model if it has vision weights, or processes
    # text-only if neither model can handle images.
    if has_images:
        if _model_is_vision:
            # Primary model has vision weights — handle directly (no fast model needed)
            pass  # fall through to normal inference path below
        else:
            # Route to fast model; _route_vision_request handles the "not loaded" case
            return await _route_vision_request(req)

    # ── auto-build prefix cache on first request with a system prompt ─────────
    # If no cache exists yet and this request has a system prompt, schedule
    # a background build after this inference completes. The first request
    # runs without prefix cache (no TTFT benefit); subsequent requests get it.
    # Building synchronously before inference caused hangs on large-context
    # models where make_prompt_cache + prefill took 10-30s.
    _pending_cache_build = None
    if (not _model_is_vision and _prefix_cache_enabled
            and _prefix_cache_file is None and not has_images):
        sys_prompt_text = get_system_prompt(req.messages)
        if sys_prompt_text:
            print(f"[prefix-cache] Will build cache after first inference completes...", file=sys.stderr)
            _pending_cache_build = sys_prompt_text

    # Smart cache clearing and memory pressure checks.
    # These Metal API calls must hold _metal_lock to avoid racing with
    # inference threads that are submitting Metal command buffers.
    # Without the lock, concurrent mx.metal.get_active_memory() / clear_cache()
    # can trigger "addCompletedHandler: on committed buffer" → SIGABRT.
    def _pre_inference_metal_checks():
        """Run Metal memory checks under _metal_lock. Returns error string or None."""
        import threading as _thr
        _tid = _thr.current_thread().name
        _metal_trace_state["last_op"] = "_pre_inference_metal_checks:waiting_lock"
        _metal_trace_state["last_thread"] = _tid
        print(f"[metal-trace] _pre_inference_metal_checks: acquiring _metal_lock (thread={_tid})", file=sys.stderr, flush=True)
        with _metal_lock:
            _metal_trace_state["last_op"] = "_pre_inference_metal_checks:checking"
            _metal_trace_state["lock_held_by"] = _tid
            if _should_clear_metal_cache():
                try:
                    import mlx.core as mx
                    import gc
                    gc.collect()
                    mx.metal.clear_cache()
                    print("[autotune] Metal cache cleared (memory pressure >65%)", file=sys.stderr)
                except Exception:
                    pass
            try:
                import mlx.core as mx
                mem_active = mx.metal.get_active_memory() / (1024**3)
                import subprocess
                total_mem_bytes = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"]).strip())
                total_mem_gb = total_mem_bytes / (1024**3)
                threshold_gb = total_mem_gb * 0.80
                if mem_active > threshold_gb:
                    print(f"[server] ⚠️ Metal memory too high: {mem_active:.2f} GB / {total_mem_gb:.1f} GB (threshold: {threshold_gb:.1f} GB)", file=sys.stderr)
                    mx.metal.clear_cache()
                    import gc
                    gc.collect()
                    mem_after = mx.metal.get_active_memory() / (1024**3)
                    if mem_after > threshold_gb:
                        return f"Server busy — Metal memory too high ({mem_after:.1f}/{total_mem_gb:.1f} GB). Retry after a moment."
            except Exception:
                pass
            return None

    _mem_err = await asyncio.get_event_loop().run_in_executor(None, _pre_inference_metal_checks)
    if _mem_err:
        raise HTTPException(503, _mem_err)

    # Preventive guard: reject dangerously large prompts
    # Context budget is centrally configured in config.js; server uses CTX_WINDOW env var
    # or defaults to 84000 tokens to match. Model's actual context window takes precedence.
    ctx_window = int(os.environ.get("CTX_WINDOW", 0)) or 84000
    model_ctx = _get_context_window()
    if model_ctx > ctx_window:
        ctx_window = model_ctx
    prompt_limit = int(ctx_window * 0.9)  # 90% of context window

    total_chars = sum(len(str(msg.content or '')) for msg in req.messages)
    # For vision messages with images, base64 data inflates char count massively
    # but MLX VLM processes images as ~1000-2000 tokens regardless of base64 size.
    # Subtract base64 image data from the char count and add a flat token estimate.
    image_chars = 0
    image_count = 0
    for msg in req.messages:
        if isinstance(msg.content, list):
            for part in msg.content:
                if isinstance(part, dict) and part.get('type') == 'image_url':
                    url = part.get('image_url', {}).get('url', '')
                    if url.startswith('data:'):
                        image_chars += len(url)
                        image_count += 1
    # Each image is ~1500 tokens in MLX VLM, not len(base64)/4
    adjusted_chars = total_chars - image_chars
    estimated_tokens = max(0, adjusted_chars // 4) + (image_count * 1500)

    if estimated_tokens > prompt_limit:
        print(f"[server] ⚠️ Prompt too large: ~{estimated_tokens} estimated tokens ({total_chars} chars, limit={prompt_limit})", file=sys.stderr)
        raise HTTPException(413, json.dumps({
            "error": "Prompt too large",
            "estimated_tokens": estimated_tokens,
            "limit": prompt_limit,
        }))

    # debug logging
    for msg in req.messages:
        if isinstance(msg.content, list):
            types = [p.get("type") if isinstance(p, dict) else "?" for p in msg.content]
            print(f"[server] msg role={msg.role} content_parts={types}", file=sys.stderr)
        else:
            clen = len(str(msg.content)) if msg.content else 0
            print(f"[server] msg role={msg.role} content=str({clen} chars)", file=sys.stderr)
    if has_tools:
        tool_names = [t.function.name for t in req.tools]
        print(f"[server] tools={tool_names}", file=sys.stderr)

    # ── streaming ─────────────────────────────────────────────────────────────
    if req.stream:
        if _model_is_vision:
            from mlx_vlm import stream_generate
        else:
            from mlx_lm import stream_generate

        prompt, kwargs, images = _build_prompt_and_kwargs(req)
        cid = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        created = int(time.time())

        # ── autotune: dynamic KV sizing + prefill batching ────────────────────
        # Right-size max_tokens so KV cache only covers what's actually needed.
        # This is autotune's #1 optimization: on a 32k context model with a 2k
        # token prompt, this reduces KV allocation from 32k → ~3.3k tokens.
        if not _model_is_vision:
            # Only apply to text models — VLM image tokens complicate sizing
            original_max = kwargs.get('max_tokens', 1024)
            kwargs['max_tokens'] = _autotune_max_tokens(prompt, original_max)

        # ── memory-adaptive max_tokens cap ────────────────────────────────────
        # When Metal memory is above 60%, cap max_tokens to prevent the
        # generation from exhausting remaining RAM and causing a SIGABRT crash.
        # Each token uses ~2-4 MB of KV cache on the 35B model.
        # NOTE: mx.metal.get_active_memory() is a Metal API call that must be
        # serialized with GPU work. We read it under _metal_lock to avoid
        # racing with an inference thread's command buffer submissions.
        try:
            import mlx.core as mx
            import subprocess
            with _metal_lock:
                _mem_active = mx.metal.get_active_memory() / (1024**3)
            _total_bytes = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"]).strip())
            _total_gb = _total_bytes / (1024**3)
            _pressure = _mem_active / _total_gb
            if _pressure > 0.60:
                # Scale max_tokens down: at 60% pressure allow 4096, at 75%+ allow 1024
                _mem_cap = max(1024, int(4096 * (1.0 - (_pressure - 0.60) / 0.15)))
                _current_max = kwargs.get('max_tokens', 4096)
                if _current_max > _mem_cap:
                    print(f"[server] ⚠️ Memory pressure {_pressure:.0%} — capping max_tokens {_current_max}→{_mem_cap}", file=sys.stderr)
                    kwargs['max_tokens'] = _mem_cap
        except Exception:
            pass

        # Prefill batching (autotune optimization #6):
        # Larger batch = fewer Metal kernel dispatches for long prompts.
        # MLX default is 512; we use 1024 for prompts >2000 chars.
        # This reduces TTFT on long-context requests by ~20-30%.
        if not _model_is_vision and len(prompt) > 2000:
            kwargs['prefill_step_size'] = 1024

        print(f"[server] Streaming: prompt_len={len(prompt)}, max_tokens={kwargs.get('max_tokens')}, "
              f"temp={kwargs.get('temp', 'default')}, top_p={kwargs.get('top_p', 'default')}", file=sys.stderr)

        # ── speculative decoding ──────────────────────────────────────────────
        # Inject draft_model when speculative decoding is enabled and the target
        # is a text-only model (mlx_lm).  VLM path doesn't support it.
        _effective_draft = None
        if _speculative_enabled and _draft_model is not None and not _model_is_vision:
            _effective_draft = _draft_model
            kwargs['num_draft_tokens'] = _num_draft_tokens
            print(f"[server] Speculative decoding active: draft_tokens={_num_draft_tokens}", file=sys.stderr)

        # ── KV cache quantization ─────────────────────────────────────────────
        # kv_bits is passed through to generate_step via stream_generate kwargs.
        # Only applies to text-only models; VLM path uses mlx_vlm which doesn't
        # expose this parameter.
        if _kv_bits is not None and not _model_is_vision:
            kwargs['kv_bits'] = _kv_bits
            print(f"[server] KV cache quantization: {_kv_bits}-bit", file=sys.stderr)

        # ── prefix cache ──────────────────────────────────────────────────────
        # Load the saved system-prompt KV state from disk and pass only the
        # delta tokens (everything after the system prompt) to stream_generate.
        # Benchmark: 1.8–3.1× TTFT speedup on typical agentic sessions.
        # Only applies to text-only models with a matching cached system prompt.
        _active_prefix_cache = None
        _prompt_for_inference = prompt  # may be replaced with delta below
        if not _model_is_vision and _prefix_cache_enabled and _prefix_cache_file and _prefix_cache_prompt:
            sys_prompt_text = get_system_prompt(req.messages)
            if sys_prompt_text and _prefix_cache_prompt == sys_prompt_text:
                # Build the rendered system prompt prefix as it appears in the
                # full prompt string, so we can extract the delta correctly.
                # The Jinja template wraps it as <|im_start|>system\n...<|im_end|>\n
                rendered_sys = f"<|im_start|>system\n{sys_prompt_text}<|im_end|>\n"
                delta = _extract_delta(prompt, rendered_sys)
                if delta != prompt:  # extraction succeeded
                    _active_prefix_cache = _load_prefix_cache()
                    if _active_prefix_cache is not None:
                        _prompt_for_inference = delta
                        kwargs['prompt_cache'] = _active_prefix_cache
                        print(f"[prefix-cache] Active: {len(prompt) - len(delta)} chars skipped, "
                              f"delta={len(delta)} chars", file=sys.stderr)

        # Clear cache before large prompts (>50k chars) to maximize available memory
        if len(prompt) > 50000:
            try:
                import mlx.core as mx
                with _metal_lock:
                    mx.metal.clear_cache()
            except Exception:
                pass

        async def event_stream():
            sem = _get_inference_semaphore()
            loop = asyncio.get_running_loop()
            queue: asyncio.Queue = asyncio.Queue()
            full_text_parts = []
            _cancelled = threading.Event()  # Signal to stop inference thread on client disconnect

            # The semaphore is released by the inference thread itself (via
            # loop.call_soon_threadsafe(sem.release)) rather than by the generator.
            # This ensures that even if the client disconnects and the generator
            # is closed/garbage-collected, the semaphore stays held until Metal
            # inference actually finishes — preventing concurrent Metal operations
            # that crash the process.
            print(f"[inference] Waiting for semaphore (value={sem._value})...", file=sys.stderr, flush=True)
            try:
                await asyncio.wait_for(sem.acquire(), timeout=120.0)
            except asyncio.TimeoutError:
                print(f"[inference] ⚠️ Semaphore stuck for 120s — force-releasing and retrying", file=sys.stderr, flush=True)
                # Force-release the stuck semaphore so inference can proceed
                sem.release()
                await sem.acquire()
            print(f"[inference] Semaphore acquired, starting inference", file=sys.stderr, flush=True)

            def run_stream():
                import threading as _thr
                _tid = _thr.current_thread().name
                _metal_trace_state["last_op"] = "run_stream:waiting_lock"
                _metal_trace_state["last_thread"] = _tid
                print(f"[metal-trace] run_stream: acquiring _metal_lock id={id(_metal_lock)} (thread={_tid})", file=sys.stderr, flush=True)
                with _metal_lock:
                    _metal_trace_state["last_op"] = "run_stream:stream_generate"
                    _metal_trace_state["lock_held_by"] = _tid
                    print(f"[metal-trace] run_stream: _metal_lock acquired, starting stream_generate (thread={_tid})", file=sys.stderr, flush=True)
                    try:
                        gen = stream_generate(_model, _processor, _prompt_for_inference,
                                             draft_model=_effective_draft, **kwargs)
                        last_result = None
                        _first_token = True
                        _prefill_start = time.perf_counter()
                        for chunk in gen:
                            if _cancelled.is_set():
                                break
                            text = chunk.text if hasattr(chunk, 'text') else str(chunk)
                            if text:
                                if _first_token:
                                    _first_token = False
                                    _ttft = time.perf_counter() - _prefill_start
                                    loop.call_soon_threadsafe(queue.put_nowait, ("prefill_done", _ttft))
                                loop.call_soon_threadsafe(queue.put_nowait, ("token", text))
                            last_result = chunk
                        if not _cancelled.is_set() and last_result and hasattr(last_result, 'prompt_tps'):
                            loop.call_soon_threadsafe(queue.put_nowait, ("stats", last_result))
                    except Exception as e:
                        if _cancelled.is_set():
                            print(f"[server] Inference interrupted (client disconnected): {type(e).__name__}", file=sys.stderr)
                        else:
                            import traceback
                            print(f"[server] ❌ Stream inference error ({type(e).__name__}): {e}", file=sys.stderr)
                            traceback.print_exc(file=sys.stderr)
                            try:
                                import mlx.core as mx
                                mem_active = mx.metal.get_active_memory() / (1024**3)
                                mem_peak = mx.metal.get_peak_memory() / (1024**3)
                                print(f"[server] Metal memory — active: {mem_active:.2f} GB, peak: {mem_peak:.2f} GB", file=sys.stderr)
                            except Exception:
                                pass
                            loop.call_soon_threadsafe(queue.put_nowait, ("error", str(e)))
                    finally:
                        # Drain pending Metal command buffer completion handlers
                        # before releasing the lock. mx.synchronize() ensures all
                        # enqueued GPU work finishes — prevents the next lock holder
                        # from hitting "addCompletedHandler: on committed buffer".
                        try:
                            import mlx.core as mx
                            print(f"[metal-trace] run_stream finally: calling mx.synchronize() (thread={_tid})", file=sys.stderr, flush=True)
                            _metal_trace_state["last_op"] = "run_stream:synchronize"
                            mx.synchronize()
                            print(f"[metal-trace] run_stream finally: mx.synchronize() done (thread={_tid})", file=sys.stderr, flush=True)
                        except Exception as _sync_err:
                            print(f"[metal-trace] run_stream finally: mx.synchronize() FAILED: {_sync_err} (thread={_tid})", file=sys.stderr, flush=True)
                            # Fallback: brief sleep if synchronize fails
                            import time
                            time.sleep(0.05)
                        # Smart post-inference cache clearing — only when memory pressure warrants it
                        if _should_clear_metal_cache():
                            try:
                                import mlx.core as mx
                                print(f"[metal-trace] run_stream finally: clearing Metal cache (thread={_tid})", file=sys.stderr, flush=True)
                                mx.metal.clear_cache()
                            except Exception:
                                pass
                        print(f"[metal-trace] run_stream: releasing _metal_lock (thread={_tid})", file=sys.stderr, flush=True)
                        _metal_trace_state["lock_held_by"] = None
                    # Use try/except on call_soon_threadsafe in case the event loop
                    # was closed before the thread finished (e.g. server shutdown).
                _metal_trace_state["last_op"] = "run_stream:done"
                print(f"[metal-trace] run_stream: _metal_lock released, signaling done+sem.release (thread={_tid})", file=sys.stderr, flush=True)
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, ("done", None))
                except Exception:
                    pass
                # Release semaphore from the thread — guarantees no concurrent
                # Metal inference even if the async generator was closed early.
                try:
                    loop.call_soon_threadsafe(sem.release)
                except Exception:
                    # Loop is gone — release directly to unblock any waiting coroutine
                    sem.release()
                print(f"[metal-trace] run_stream: sem.release scheduled (thread={_tid})", file=sys.stderr, flush=True)

            loop.run_in_executor(None, run_stream)

            # Emit prompt processing start event so the client can show real progress
            _est_prompt_tokens = _estimate_prompt_tokens(_prompt_for_inference)
            prefill_start_chunk = {
                "id": cid, "object": "chat.completion.chunk",
                "created": created, "model": _model_id,
                "choices": [{"index": 0, "delta": {}, "finish_reason": None}],
                "x_progress": {"stage": "processing", "prompt_tokens": _est_prompt_tokens},
            }
            yield f"data: {json.dumps(prefill_start_chunk)}\n\n"

            accumulated = ""
            _content_sent_len = 0
            _in_tool_call = False
            _tool_call_buf = ""
            _tc_index = 0
            _tc_id = ""
            _tc_func_name = ""
            _tc_name_sent = False
            _tc_last_args_len = 0
            _tc_json_args = None
            _tc_completed = []
            _TOOL_OPEN = "<tool_call>"
            _TOOL_CLOSE = "</tool_call>"
            _PARTIAL_TAGS = ("<", "<t", "<to", "<too", "<tool",
                             "<tool_", "<tool_c", "<tool_ca",
                             "<tool_cal", "<tool_call")

            # ── Thinking token tracking for streaming ─────────────────────────
            # Stream thinking content as reasoning_content deltas in real-time
            # so the client can show it in the UI, while also buffering it for
            # the final response's reasoning_content field.
            _in_thinking = False
            _thinking_buf = ""
            _thinking_done = False  # True once </think> is seen
            _thinking_sent_len = 0  # how much of _thinking_buf has been streamed
            _THINK_OPEN = "<think>"
            _THINK_CLOSE = "</think>"
            _PARTIAL_THINK_TAGS = ("<", "<t", "<th", "<thi", "<thin", "<think")
            _PARTIAL_THINK_CLOSE = ("</", "</t", "</th", "</thi", "</thin", "</think")

            # Race condition fix: _cancelled must be set whenever the generator
            # exits for ANY reason — including GeneratorExit from client disconnect.
            # Without this, the inference thread keeps running Metal ops while the
            # next request also starts Metal → concurrent Metal access → crash.
            try:
                while True:
                    kind, data = await queue.get()
                    if kind == "prefill_done":
                        # Prompt processing complete — emit timing so client can show real TTFT
                        prefill_done_chunk = {
                            "id": cid, "object": "chat.completion.chunk",
                            "created": created, "model": _model_id,
                            "choices": [{"index": 0, "delta": {}, "finish_reason": None}],
                            "x_progress": {"stage": "done", "ttft_ms": round(data * 1000, 1), "prompt_tokens": _est_prompt_tokens},
                        }
                        yield f"data: {json.dumps(prefill_done_chunk)}\n\n"
                        continue
                    if kind == "token":
                        accumulated += data
                        full_text_parts.append(data)

                        # ── Thinking token buffering ──────────────────────────
                        # Intercept <think>...</think> blocks: stream them as
                        # reasoning_content deltas and buffer for final response.
                        if not _thinking_done and not _in_tool_call:
                            # Detect <think> open
                            if not _in_thinking:
                                think_open_pos = accumulated.find(_THINK_OPEN)
                                if think_open_pos != -1:
                                    _in_thinking = True
                                    # Send any content before <think> as a delta
                                    pre_think = accumulated[_content_sent_len:think_open_pos]
                                    if pre_think:
                                        chunk_data = {
                                            "id": cid, "object": "chat.completion.chunk",
                                            "created": created, "model": _model_id,
                                            "choices": [{"index": 0, "delta": {"content": pre_think}, "finish_reason": None}],
                                        }
                                        yield f"data: {json.dumps(chunk_data)}\n\n"
                                    _thinking_buf = accumulated[think_open_pos + len(_THINK_OPEN):]
                                    _thinking_sent_len = 0
                                    _content_sent_len = len(accumulated)
                                    # Stream initial reasoning_content delta
                                    if _thinking_buf:
                                        rc_delta = {
                                            "id": cid, "object": "chat.completion.chunk",
                                            "created": created, "model": _model_id,
                                            "choices": [{"index": 0, "delta": {"reasoning_content": _thinking_buf}, "finish_reason": None}],
                                        }
                                        yield f"data: {json.dumps(rc_delta)}\n\n"
                                        _thinking_sent_len = len(_thinking_buf)
                                    continue
                                else:
                                    # Check for partial <think tag at end — hold back
                                    tail = accumulated[-8:] if len(accumulated) >= 8 else accumulated
                                    if any(tail.endswith(pt) for pt in _PARTIAL_THINK_TAGS):
                                        continue

                            # Inside thinking block — buffer and stream incrementally
                            if _in_thinking:
                                _thinking_buf = accumulated[accumulated.find(_THINK_OPEN) + len(_THINK_OPEN):]
                                think_close_pos = _thinking_buf.find(_THINK_CLOSE)
                                if think_close_pos != -1:
                                    _thinking_buf = _thinking_buf[:think_close_pos].strip()
                                    _in_thinking = False
                                    _thinking_done = True
                                    # Stream final reasoning_content delta
                                    if len(_thinking_buf) > _thinking_sent_len:
                                        rc_delta = {
                                            "id": cid, "object": "chat.completion.chunk",
                                            "created": created, "model": _model_id,
                                            "choices": [{"index": 0, "delta": {"reasoning_content": _thinking_buf[_thinking_sent_len:]}, "finish_reason": None}],
                                        }
                                        yield f"data: {json.dumps(rc_delta)}\n\n"
                                    # Reset content tracking to after </think>
                                    full_close = accumulated.find(_THINK_CLOSE)
                                    _content_sent_len = full_close + len(_THINK_CLOSE) if full_close != -1 else len(accumulated)
                                else:
                                    # Stream new reasoning_content since last send
                                    if len(_thinking_buf) > _thinking_sent_len:
                                        new_thinking = _thinking_buf[_thinking_sent_len:]
                                        # Check for partial </think at end — hold back that part
                                        tail = _thinking_buf[-9:] if len(_thinking_buf) >= 9 else _thinking_buf
                                        if any(tail.endswith(pt) for pt in _PARTIAL_THINK_CLOSE):
                                            # Don't stream the partial tag suffix
                                            safe_end = len(_thinking_buf)
                                            for pt in _PARTIAL_THINK_CLOSE:
                                                if tail.endswith(pt):
                                                    safe_end = len(_thinking_buf) - len(pt)
                                                    break
                                            if safe_end > _thinking_sent_len:
                                                rc_delta = {
                                                    "id": cid, "object": "chat.completion.chunk",
                                                    "created": created, "model": _model_id,
                                                    "choices": [{"index": 0, "delta": {"reasoning_content": _thinking_buf[_thinking_sent_len:safe_end]}, "finish_reason": None}],
                                                }
                                                yield f"data: {json.dumps(rc_delta)}\n\n"
                                                _thinking_sent_len = safe_end
                                        else:
                                            rc_delta = {
                                                "id": cid, "object": "chat.completion.chunk",
                                                "created": created, "model": _model_id,
                                                "choices": [{"index": 0, "delta": {"reasoning_content": new_thinking}, "finish_reason": None}],
                                            }
                                            yield f"data: {json.dumps(rc_delta)}\n\n"
                                            _thinking_sent_len = len(_thinking_buf)
                                _content_sent_len = len(accumulated)
                                continue

                        if not _in_tool_call:
                            tc_start = accumulated.find(_TOOL_OPEN, _content_sent_len)
                            if tc_start != -1:
                                _in_tool_call = True
                                _tc_id = f"call_{uuid.uuid4().hex[:12]}"
                                _tc_func_name = ""
                                _tc_name_sent = False
                                _tc_last_args_len = 0
                                _tc_json_args = None
                                unsent = accumulated[_content_sent_len:tc_start]
                                if unsent:
                                    chunk_data = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{"index": 0, "delta": {"content": unsent}, "finish_reason": None}],
                                    }
                                    yield f"data: {json.dumps(chunk_data)}\n\n"
                                _tool_call_buf = accumulated[tc_start + len(_TOOL_OPEN):]
                            else:
                                tail = accumulated[-11:] if len(accumulated) >= 11 else accumulated
                                if any(tail.endswith(pt) for pt in _PARTIAL_TAGS):
                                    continue
                                unsent = accumulated[_content_sent_len:]
                                if unsent:
                                    chunk_data = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{"index": 0, "delta": {"content": unsent}, "finish_reason": None}],
                                    }
                                    yield f"data: {json.dumps(chunk_data)}\n\n"
                                    _content_sent_len = len(accumulated)
                        else:
                            _tool_call_buf += data
                            close_pos = _tool_call_buf.find("</function>")
                            tc_close = _tool_call_buf.find(_TOOL_CLOSE)

                            if not _tc_func_name:
                                fn_match = _FUNC_NAME_RE.search(_tool_call_buf)
                                if fn_match:
                                    _tc_func_name = fn_match.group(1).strip()
                                elif tc_close != -1:
                                    json_body = _tool_call_buf[:tc_close].strip()
                                    try:
                                        obj = json.loads(json_body)
                                        _tc_func_name = obj.get("name", "")
                                        _tc_json_args = obj.get("arguments", {})
                                        print(f"[server] 🔧 JSON-style tool call detected: func={_tc_func_name}, args={json.dumps(_tc_json_args)[:200]}", file=sys.stderr)
                                    except (json.JSONDecodeError, ValueError):
                                        print(f"[server] ⚠️ Tool call block has no <function=> and is not valid JSON: {repr(json_body[:200])}", file=sys.stderr)

                            if _tc_func_name:
                                if _tc_json_args is not None:
                                    current_args = json.dumps(_tc_json_args)
                                else:
                                    fn_tag_end = _tool_call_buf.find(">", _tool_call_buf.find("<function="))
                                    func_body = _tool_call_buf[fn_tag_end + 1:] if fn_tag_end != -1 else ""
                                    clean_body = func_body.replace("</function>", "").replace("</tool_call>", "")
                                    current_args = parse_partial_tool_args(clean_body)
                                if tc_close != -1 or close_pos != -1:
                                    print(f"[server] 🔧 Tool call complete: func={_tc_func_name}, parsed_args={current_args[:200]}", file=sys.stderr)

                                if not _tc_name_sent:
                                    tc_delta = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{"index": 0, "delta": {"tool_calls": [{"index": _tc_index, "id": _tc_id, "type": "function", "function": {"name": _tc_func_name, "arguments": current_args}}]}, "finish_reason": None}],
                                    }
                                    yield f"data: {json.dumps(tc_delta)}\n\n"
                                    _tc_name_sent = True
                                    _tc_last_args_len = len(current_args)
                                elif len(current_args) > _tc_last_args_len:
                                    tc_delta = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{"index": 0, "delta": {"tool_calls": [{"index": _tc_index, "function": {"arguments": current_args}}]}, "finish_reason": None}],
                                    }
                                    yield f"data: {json.dumps(tc_delta)}\n\n"
                                    _tc_last_args_len = len(current_args)

                            if tc_close != -1:
                                if _tc_func_name:
                                    if _tc_json_args is not None:
                                        final_args = json.dumps(_tc_json_args)
                                    else:
                                        fn_tag_end = _tool_call_buf.find(">", _tool_call_buf.find("<function="))
                                        func_body = _tool_call_buf[fn_tag_end + 1:] if fn_tag_end != -1 else ""
                                        clean_body = func_body.replace("</function>", "").replace("</tool_call>", "")
                                        final_args = parse_partial_tool_args(clean_body)
                                    tc_final = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{"index": 0, "delta": {"tool_calls": [{"index": _tc_index, "function": {"arguments": final_args}}]}, "finish_reason": None}],
                                    }
                                    yield f"data: {json.dumps(tc_final)}\n\n"
                                _in_tool_call = False
                                _tool_call_buf = ""
                                _tc_index += 1
                                after_close = accumulated[accumulated.rfind(_TOOL_CLOSE) + len(_TOOL_CLOSE):]
                                if after_close.strip():
                                    accumulated = after_close
                    elif kind == "stats":
                        stats_chunk = {
                            "id": cid, "object": "chat.completion.chunk",
                            "created": created, "model": _model_id,
                            "choices": [{"index": 0, "delta": {}, "finish_reason": None}],
                            "usage": {
                                "prompt_tokens": getattr(data, "prompt_tokens", 0),
                                "completion_tokens": getattr(data, "generation_tokens", 0),
                                "total_tokens": getattr(data, "total_tokens", 0),
                            },
                            "x_stats": {
                                "prompt_tps": round(getattr(data, "prompt_tps", 0), 2),
                                "generation_tps": round(getattr(data, "generation_tps", 0), 2),
                                "peak_memory_gb": round(getattr(data, "peak_memory", 0), 3),
                                "prompt_tokens_actual": _estimate_prompt_tokens(prompt),
                                "context_window": _get_context_window(),
                                "speculative_enabled": _speculative_enabled,
                                "kv_bits": _kv_bits,
                            },
                        }
                        yield f"data: {json.dumps(stats_chunk)}\n\n"
                    elif kind == "error":
                        yield f"event: error\ndata: {json.dumps({'error': data, 'type': 'server_error'})}\n\n"
                        break
                    elif kind == "done":
                        full_text = "".join(full_text_parts)

                        # Extract reasoning_content from the full text for the
                        # final response. During streaming we already sent
                        # reasoning_content incrementally as deltas. Re-extract
                        # from full_text as the authoritative source for the
                        # conversation history field (sent via the resolve value,
                        # not as an SSE chunk — client already has the streamed version).
                        _final_reasoning = _thinking_buf.strip() if _thinking_buf else None
                        if not _final_reasoning:
                            _fr, _ = extract_thinking(full_text)
                            _final_reasoning = _fr

                        # NOTE: reasoning_content was already streamed incrementally
                        # during generation. No need to emit it again here.

                        if has_tools:
                            tool_calls = parse_tool_calls(full_text)
                            if tool_calls:
                                print(f"[server] 🔧 Final parse_tool_calls found {len(tool_calls)} call(s)", file=sys.stderr)
                                for i, tc in enumerate(tool_calls):
                                    print(f"[server]   [{i}] {tc['function']['name']}: {tc['function']['arguments'][:200]}", file=sys.stderr)
                            elif '<tool_call>' in full_text or 'read_file' in full_text:
                                print(f"[server] ⚠️ Tool call parse FAILED. Raw text (last 500 chars): {repr(full_text[-500:])}", file=sys.stderr)
                            if tool_calls:
                                if _tc_index > 0:
                                    for i, tc in enumerate(tool_calls):
                                        tc_final_chunk = {
                                            "id": cid, "object": "chat.completion.chunk",
                                            "created": created, "model": _model_id,
                                            "choices": [{"index": 0, "delta": {"tool_calls": [{"index": i, "id": tc["id"], "type": "function", "function": {"name": tc["function"]["name"], "arguments": tc["function"]["arguments"]}}]}, "finish_reason": None}],
                                        }
                                        yield f"data: {json.dumps(tc_final_chunk)}\n\n"
                                    finish_chunk = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                                    }
                                    yield f"data: {json.dumps(finish_chunk)}\n\n"
                                else:
                                    tc_chunk = {
                                        "id": cid, "object": "chat.completion.chunk",
                                        "created": created, "model": _model_id,
                                        "choices": [{"index": 0, "delta": {"tool_calls": tool_calls}, "finish_reason": "tool_calls"}],
                                    }
                                    yield f"data: {json.dumps(tc_chunk)}\n\n"
                                yield "data: [DONE]\n\n"
                                break

                        final = {
                            "id": cid, "object": "chat.completion.chunk",
                            "created": created, "model": _model_id,
                            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                        }
                        yield f"data: {json.dumps(final)}\n\n"
                        yield "data: [DONE]\n\n"
                        break

            finally:
                # Always signal the inference thread to stop — covers
                # GeneratorExit (client disconnect) and normal completion.
                _cancelled.set()
                _cleanup_images(images)

        # Post-request cache clearing — done under _metal_lock to avoid racing
        # with any concurrent Metal work (e.g. deferred prefix cache build).
        try:
            import mlx.core as mx
            with _metal_lock:
                mx.metal.clear_cache()
        except Exception:
            pass

        response = StreamingResponse(event_stream(), media_type="text/event-stream")

        # Deferred prefix cache build — runs after the first inference response
        # is fully sent, so the user isn't blocked waiting for cache allocation.
        if _pending_cache_build:
            _deferred_prompt = _pending_cache_build
            async def _deferred_cache_build():
                sem = _get_inference_semaphore()
                async with sem:
                    await asyncio.get_event_loop().run_in_executor(
                        None, _build_prefix_cache, _deferred_prompt)
            asyncio.ensure_future(_deferred_cache_build())

        return response


    # ── non-streaming ─────────────────────────────────────────────────────────
    if _model_is_vision:
        from mlx_vlm import generate
    else:
        from mlx_lm import generate

    prompt, kwargs, images = _build_prompt_and_kwargs(req)

    # ── autotune: dynamic KV sizing + prefill batching (non-streaming) ────────
    if not _model_is_vision:
        original_max = kwargs.get('max_tokens', 1024)
        kwargs['max_tokens'] = _autotune_max_tokens(prompt, original_max)
        if len(prompt) > 2000:
            kwargs['prefill_step_size'] = 1024

    # ── speculative decoding (non-streaming) ──────────────────────────────────
    _ns_draft = None
    if _speculative_enabled and _draft_model is not None and not _model_is_vision:
        _ns_draft = _draft_model
        kwargs['num_draft_tokens'] = _num_draft_tokens
        print(f"[server] Non-streaming speculative decoding: draft_tokens={_num_draft_tokens}", file=sys.stderr)

    # ── KV cache quantization (non-streaming) ─────────────────────────────────
    if _kv_bits is not None and not _model_is_vision:
        kwargs['kv_bits'] = _kv_bits

    # ── prefix cache (non-streaming) ──────────────────────────────────────────
    _ns_prefix_cache = None
    _ns_prompt = prompt
    if not _model_is_vision and _prefix_cache_enabled and _prefix_cache_file and _prefix_cache_prompt:
        sys_prompt_text = get_system_prompt(req.messages)
        if sys_prompt_text and _prefix_cache_prompt == sys_prompt_text:
            rendered_sys = f"<|im_start|>system\n{sys_prompt_text}<|im_end|>\n"
            delta = _extract_delta(prompt, rendered_sys)
            if delta != prompt:
                _ns_prefix_cache = _load_prefix_cache()
                if _ns_prefix_cache is not None:
                    _ns_prompt = delta
                    kwargs['prompt_cache'] = _ns_prefix_cache

    def _run_generate():
        import threading as _thr
        _tid = _thr.current_thread().name
        _metal_trace_state["last_op"] = "_run_generate:waiting_lock"
        _metal_trace_state["last_thread"] = _tid
        print(f"[metal-trace] _run_generate: acquiring _metal_lock (thread={_tid})", file=sys.stderr, flush=True)
        with _metal_lock:
            _metal_trace_state["last_op"] = "_run_generate:generate"
            _metal_trace_state["lock_held_by"] = _tid
            print(f"[metal-trace] _run_generate: _metal_lock acquired (thread={_tid})", file=sys.stderr, flush=True)
            if _ns_draft is not None:
                result = generate(_model, _processor, _ns_prompt, draft_model=_ns_draft, **kwargs)
            else:
                result = generate(_model, _processor, _ns_prompt, **kwargs)
            # Drain pending Metal completion handlers before releasing the lock
            try:
                import mlx.core as mx
                mx.synchronize()
            except Exception:
                import time
                time.sleep(0.05)
            if images:
                try:
                    import mlx.core as mx
                    mx.metal.clear_cache()
                except Exception:
                    pass
            return result

    try:
        sem = _get_inference_semaphore()
        async with sem:
            result = await asyncio.get_event_loop().run_in_executor(None, _run_generate)
    except Exception as e:
        import traceback
        print(f"[server] ❌ Inference error ({type(e).__name__}): {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        try:
            import mlx.core as mx
            with _metal_lock:
                mem_active = mx.metal.get_active_memory() / (1024**3)
                mem_peak = mx.metal.get_peak_memory() / (1024**3)
                mem_cache = mx.metal.get_cache_memory() / (1024**3)
            print(f"[server] Metal memory — active: {mem_active:.2f} GB, peak: {mem_peak:.2f} GB, cache: {mem_cache:.2f} GB", file=sys.stderr)
        except Exception:
            pass
        _cleanup_images(images)
        raise HTTPException(500, f"Inference error: {str(e)}")
    _cleanup_images(images)

    # Post-request cache clearing — only when memory pressure warrants it
    # Must hold _metal_lock since _should_clear_metal_cache reads Metal state
    with _metal_lock:
        if _should_clear_metal_cache():
            try:
                import mlx.core as mx
                mx.metal.clear_cache()
            except Exception:
                pass

    response_text = result.text if hasattr(result, "text") else str(result)

    # check for tool calls in the response
    tool_calls = []
    finish_reason = "stop"
    content = response_text

    # Extract thinking/reasoning content separately so it can be preserved
    # in conversation history. The Jinja template uses reasoning_content to
    # maintain the model's chain-of-thought across tool loop iterations.
    reasoning_content, stripped_text = extract_thinking(response_text)

    if has_tools:
        tool_calls = parse_tool_calls(response_text)
        if tool_calls:
            finish_reason = "tool_calls"
            content = strip_tool_calls(stripped_text) or None
        else:
            content = stripped_text or response_text
    else:
        content = stripped_text or response_text

    message = {"role": "assistant", "content": content}
    if reasoning_content:
        message["reasoning_content"] = reasoning_content
    if tool_calls:
        message["tool_calls"] = tool_calls

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": _model_id,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": {
            "prompt_tokens": getattr(result, "prompt_tokens", 0),
            "completion_tokens": getattr(result, "generation_tokens", 0),
            "total_tokens": getattr(result, "total_tokens", 0),
        },
        "x_stats": {
            "prompt_tps": round(getattr(result, "prompt_tps", 0), 2),
            "generation_tps": round(getattr(result, "generation_tps", 0), 2),
            "peak_memory_gb": round(getattr(result, "peak_memory", 0), 3),
            "speculative_enabled": _speculative_enabled,
            "kv_bits": _kv_bits,
        },
    }


if __name__ == "__main__":
    # ── CRITICAL: Register this module as "server" in sys.modules ─────────────
    # When server.py runs as __main__, importlib.import_module("server") creates
    # a SECOND module instance with its own _metal_lock, _inference_semaphore, etc.
    # This causes memory-bridge.py to get a different lock than the one protecting
    # Metal inference here — leading to concurrent Metal access and SIGABRT.
    # By aliasing __main__ as "server", all importlib calls return THIS instance.
    sys.modules["server"] = sys.modules[__name__]

    import uvicorn, argparse, signal

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--model", type=str, default=None)
    args = parser.parse_args()
    if args.model:
        load_model(args.model)

    # Graceful shutdown: unload model, shutdown memory, and clear Metal cache on SIGTERM
    def _handle_sigterm(signum, frame):
        print("[server] Received SIGTERM, cleaning up...", file=sys.stderr)

        # Shutdown memory-bridge (flush Archive writes, close SQLite connections)
        if _memory_bridge is not None:
            try:
                import asyncio as _asyncio
                loop = _asyncio.get_event_loop()
                if loop.is_running():
                    loop.create_task(_memory_bridge.shutdown())
                else:
                    loop.run_until_complete(_memory_bridge.shutdown())
                print("[server] Memory-bridge shutdown complete", file=sys.stderr)
            except Exception as e:
                print(f"[server] WARNING: Memory-bridge shutdown error: {e}", file=sys.stderr)

        # Use the proper unload function — clears model, draft model, prefix cache,
        # vision state, token cache, and calls gc.collect() + mx.metal.clear_cache()
        try:
            _unload_model()
        except Exception as e:
            print(f"[server] WARNING: Model unload error during shutdown: {e}", file=sys.stderr)

        sys.exit(0)

    signal.signal(signal.SIGTERM, _handle_sigterm)

    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info", loop="asyncio")
