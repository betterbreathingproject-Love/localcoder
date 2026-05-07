"""
Quick comparison: 35B-A3B (your current) vs 27B (MTPLX target).
Single short coding prompt, 256 tokens, temp=0.6.
"""
import time
import gc
import mlx.core as mx
from mlx_lm import load, stream_generate

TARGETS = {
    "35B-A3B-8bit": "/Users/matt123/.lmstudio/models/unsloth/Qwen3.6-35B-A3B-MLX-8bit",
    # 27B MTPLX trunk — will run as plain AR via mlx-lm (MTP head ignored)
    "27B-MTPLX-Opt-Speed (AR)": "/Users/matt123/.mtplx/models/Youssofal--Qwen3.6-27B-MTPLX-Optimized-Speed",
}

DRAFT = "/Users/matt123/.lmstudio/models/mlx-community/Qwen3.5-0.8B-MLX-8bit"

PROMPT = (
    "<|im_start|>user\n"
    "Write a Python function that implements binary search on a sorted list. "
    "Include type hints and a docstring.\n"
    "<|im_end|>\n<|im_start|>assistant\n"
)

MAX_TOKENS = 256


def clear():
    gc.collect()
    mx.metal.clear_cache()


def run(model, tokenizer, draft_model=None, label=""):
    kwargs = dict(max_tokens=MAX_TOKENS)
    if draft_model is not None:
        kwargs["draft_model"] = draft_model
        kwargs["num_draft_tokens"] = 4

    # Warmup
    for _ in stream_generate(model, tokenizer, PROMPT, max_tokens=16):
        pass
    clear()

    last = None
    t0 = time.perf_counter()
    for chunk in stream_generate(model, tokenizer, PROMPT, **kwargs):
        last = chunk
    elapsed = time.perf_counter() - t0

    gen_tps = getattr(last, "generation_tps", 0)
    gen_tokens = getattr(last, "generation_tokens", 0)
    peak_gb = mx.metal.get_peak_memory() / 1e9
    print(f"  {label:<35} {gen_tps:>7.2f} tok/s  {gen_tokens:>4} tokens  {peak_gb:>5.2f} GB peak  {elapsed:>5.2f}s")
    clear()
    return gen_tps


def main():
    print("=" * 80)
    print("Quick comparison: 35B-A3B vs 27B (AR-only via mlx-lm)")
    print("=" * 80)

    # ── 35B-A3B with and without draft
    print("\n[1/2] 35B-A3B-8bit (your current production model)")
    model, tok = load(TARGETS["35B-A3B-8bit"])
    run(model, tok, label="AR baseline")

    print("  Loading 0.8B draft...")
    draft, _ = load(DRAFT)
    run(model, tok, draft_model=draft, label="Speculative (n=4, draft=0.8B)")

    del model, draft
    clear()

    # ── 27B-MTPLX-Optimized-Speed (AR only, since mlx-lm ignores MTP heads)
    print("\n[2/2] 27B-MTPLX-Optimized-Speed (AR via mlx-lm, MTP head ignored)")
    model, tok = load(TARGETS["27B-MTPLX-Opt-Speed (AR)"])
    run(model, tok, label="AR baseline (mlx-lm)")

    print("\n" + "=" * 80)
    print("Reference from MTPLX runtime (same 27B model):")
    print("  AR via mtplx:         13.17 tok/s")
    print("  MTP-D3 via mtplx:     15.17 tok/s (1.15x)")
    print("=" * 80)


if __name__ == "__main__":
    main()
