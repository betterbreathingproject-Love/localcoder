"""
Session KV Cache — Turn-to-Turn Prefix Reuse
─────────────────────────────────────────────

Problem we're solving:
    Each agent turn sends the full conversation (system + history + tool results
    + user messages + latest assistant turn). Without cross-request caching,
    the MLX server re-prefills all 27K tokens every turn — minute+ on M1 Max 35B.

Solution:
    Keep the last request's KV cache in memory. On each new request:
      1. Tokenize the current prompt
      2. Find the longest common prefix with the cached prompt (by tokens)
      3. If the cached KV covers the common prefix: trim it to that length
         and only prefill the delta (new tokens beyond the common prefix)
      4. Save the resulting cache for the next request

Correctness:
    - Tokens must match exactly, not just characters (whitespace differences)
    - mlx_lm.trim_prompt_cache only works on trim-able caches; hybrid models
      like Qwen3.6 have layers where trim isn't possible — fall back to full
      prefill in that case (same speed as today).
    - We ONLY cache up to a known-good token position; any change earlier in
      the prompt invalidates the entire cache.

Expected speedup on M1 Max 35B agent workload:
    - Cached prefix hit on 26K of 27K tokens:
      baseline 27K tokens prefill ~40s → cached: ~1.5s for 1K delta
      = ~25x faster TTFT per turn
    - On a 20-turn session: saves ~13 minutes of total prefill

Usage from server.py:
    from session_kv_cache import SessionKVCache

    session_cache = SessionKVCache()

    # In the completion handler:
    tokens = tokenizer.encode(full_prompt)
    hit = session_cache.try_match(tokens)
    if hit:
        kwargs['prompt_cache'] = hit.cache
        # Prefill only the delta
        delta_tokens = tokens[hit.prefix_len:]
        # ... run generate on delta ...
    else:
        # Normal full prefill
        cache = make_prompt_cache(model)
        kwargs['prompt_cache'] = cache
        # ... run generate on all tokens ...

    # After generation completes, save cache + final tokens for next turn
    session_cache.save(tokens + generated_tokens, cache)
"""

from __future__ import annotations

import sys
import time
from typing import Optional, Any

try:
    from mlx_lm.models.cache import (
        make_prompt_cache,
        trim_prompt_cache,
        can_trim_prompt_cache,
    )
    _MLX_CACHE_AVAILABLE = True
except Exception as e:
    print(f"[session-kv-cache] mlx_lm unavailable: {e}", file=sys.stderr)
    _MLX_CACHE_AVAILABLE = False


class SessionKVCache:
    """
    Single-slot in-memory cache that keeps the last request's KV state.
    Subsequent requests that share a long prefix reuse the cache by trimming
    it to the common prefix length.
    """

    def __init__(self, min_match_tokens: int = 128):
        """
        Args:
            min_match_tokens: Minimum prefix overlap required to reuse the cache.
                Below this, full prefill is faster than the trim + partial prefill.
        """
        self._min_match = min_match_tokens
        self._cached_tokens: list[int] = []
        self._cached_state: Optional[list[Any]] = None
        self._model_id: str = ""
        self._hits = 0
        self._misses = 0
        self._full_prefills = 0
        self._last_hit_ratio = 0.0
        # Architecture support — detected on first save(). Hybrid models
        # (Qwen3.6-A3B with mixed linear/full attention) have non-trimmable
        # caches and cannot participate in turn-to-turn prefix reuse.
        self._arch_checked = False
        self._arch_trimmable = True  # optimistic default until proven otherwise

    def try_match(self, tokens: list[int], model_id: str = "") -> Optional[dict]:
        """
        Check if the cached state can be reused for the given token sequence.

        Returns a dict with:
            cache: the trimmed cache state
            prefix_len: how many tokens of the input are already in the cache
            delta_tokens: tokens that need fresh prefill
        Or None if no reusable match.
        """
        if not _MLX_CACHE_AVAILABLE or self._cached_state is None:
            if self._cached_state is None:
                print(f"[session-kv-cache] miss: no cached state yet", file=sys.stderr)
            self._misses += 1
            return None

        # Model mismatch — invalidate
        if model_id and self._model_id and model_id != self._model_id:
            print(f"[session-kv-cache] Model changed ({self._model_id} → {model_id}), invalidating",
                  file=sys.stderr)
            self.invalidate()
            self._misses += 1
            return None

        # Find longest matching prefix (token-exact)
        match_len = _longest_common_prefix_length(tokens, self._cached_tokens)
        print(f"[session-kv-cache] prefix match: {match_len}/{len(tokens)} tokens "
              f"(cached: {len(self._cached_tokens)} tokens, min_match: {self._min_match})",
              file=sys.stderr)

        if match_len < self._min_match:
            self._misses += 1
            return None

        # Check if we can trim the cache to exactly match_len
        # (can't trim all cache types, e.g. some hybrid model caches)
        try:
            trimmable = can_trim_prompt_cache(self._cached_state)
            print(f"[session-kv-cache] can_trim={trimmable}", file=sys.stderr)
        except Exception as e:
            print(f"[session-kv-cache] can_trim check failed: {e}", file=sys.stderr)
            trimmable = False
        if not trimmable:
            print(f"[session-kv-cache] miss: cache not trimmable (hybrid model?)", file=sys.stderr)
            self._misses += 1
            return None

        # Trim to match_len: the cache currently holds len(_cached_tokens) tokens;
        # we need to trim off (len - match_len) to get down to match_len.
        to_trim = len(self._cached_tokens) - match_len
        if to_trim < 0:
            # Cache has fewer tokens than match — impossible but guard anyway
            self._misses += 1
            return None

        try:
            if to_trim > 0:
                trimmed = trim_prompt_cache(self._cached_state, to_trim)
                if trimmed != to_trim:
                    # Trim didn't work as expected
                    print(f"[session-kv-cache] Trim returned {trimmed} (wanted {to_trim}), abort reuse",
                          file=sys.stderr)
                    self._misses += 1
                    return None
        except Exception as e:
            print(f"[session-kv-cache] Trim error: {e}", file=sys.stderr)
            self._misses += 1
            return None

        self._hits += 1
        self._last_hit_ratio = match_len / max(1, len(tokens))
        delta_tokens = tokens[match_len:]
        print(
            f"[session-kv-cache] HIT: prefix={match_len} tokens, "
            f"delta={len(delta_tokens)} tokens, "
            f"reuse_ratio={self._last_hit_ratio:.1%}",
            file=sys.stderr,
        )
        return {
            "cache": self._cached_state,
            "prefix_len": match_len,
            "delta_tokens": delta_tokens,
        }

    def save(self, final_tokens: list[int], final_state: Any, model_id: str = ""):
        """
        Save the final prompt tokens (including any generated response tokens)
        along with the KV cache state. Called after a generation completes.
        """
        if not _MLX_CACHE_AVAILABLE:
            return
        # Check architecture support on first save — many hybrid models
        # (e.g. Qwen3.6-A3B, Qwen3.6-27B with linear/full mixed attention)
        # have non-trimmable caches. Save is pointless in that case.
        if not self._arch_checked and final_state is not None:
            self._arch_checked = True
            try:
                trimmable = can_trim_prompt_cache(final_state)
                self._arch_trimmable = trimmable
                if not trimmable:
                    layer_info = []
                    for i, c in enumerate(final_state[:5]):
                        tname = type(c).__name__
                        layer_info.append(f"L{i}={tname}")
                    print(f"[session-kv-cache] ⚠️  Hybrid model detected — cache is NOT "
                          f"trimmable (layers: {', '.join(layer_info)}...). "
                          f"Turn-to-turn prefix reuse disabled. Per-layer trim support "
                          f"would require custom kernels. Other optimizations (post-write "
                          f"cache, tool speculator, cascade router) still active.",
                          file=sys.stderr)
                else:
                    print(f"[session-kv-cache] ✓ Model supports cache trimming — "
                          f"turn-to-turn prefix reuse active", file=sys.stderr)
            except Exception as e:
                print(f"[session-kv-cache] arch check error: {e}", file=sys.stderr)
                self._arch_trimmable = False
        # Only save if architecture supports it
        if not self._arch_trimmable:
            return
        self._cached_tokens = list(final_tokens)
        self._cached_state = final_state
        self._model_id = model_id
        # Note: we don't track full_prefills here anymore because save() is
        # always called at end — caller should increment full_prefills on miss
        # before calling save.

    def invalidate(self):
        """Drop the cache — e.g. on model swap or error."""
        self._cached_tokens = []
        self._cached_state = None

    def record_full_prefill(self):
        """Called when a request had to do a full prefill due to miss."""
        self._full_prefills += 1

    def stats(self) -> dict:
        total = self._hits + self._misses
        return {
            "hits": self._hits,
            "misses": self._misses,
            "full_prefills": self._full_prefills,
            "hit_rate": self._hits / total if total > 0 else 0.0,
            "cached_tokens": len(self._cached_tokens),
            "last_reuse_ratio": self._last_hit_ratio,
            "model_id": self._model_id,
            "arch_trimmable": self._arch_trimmable,
            "arch_checked": self._arch_checked,
        }


def _longest_common_prefix_length(a: list[int], b: list[int]) -> int:
    """Return the length of the longest common prefix of two token lists."""
    n = min(len(a), len(b))
    # Vectorized would be faster with numpy, but token lists are small enough
    # that a tight Python loop is fine (<1ms for 30k tokens).
    for i in range(n):
        if a[i] != b[i]:
            return i
    return n
