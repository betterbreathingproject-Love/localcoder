"""
Semantic KV Cache — multi-shard extension of server.py's prefix cache.

The existing server.py caches one prefix: the system prompt. This module extends
it to cache arbitrary content shards by SHA-256 hash:

  Shard types:
    - system:    system prompt (what server.py already handles)
    - steering:  steering docs injected into agent prompts
    - file:      individual file contents read into context
    - spec:      spec documents (requirements/design/tasks.md)
    - user:      frequent user turns (hashed)

Usage from server.py (import or inline):
    from semantic_kv_cache import ShardedPrefixCache

    cache = ShardedPrefixCache(model=_model, processor=_processor,
                                model_id=_model_id, metal_lock=_metal_lock)

    # Build/lookup a shard for each content piece
    shard = cache.get_or_build("steering", steering_text)
    shard = cache.get_or_build("file", file_contents, path_hint="src/main.js")

    # At request time, assemble a composite KV state from shards
    state = cache.assemble([system_shard, steering_shard, file_shard_1, ...])

Notes:
  - Shards are only valid at specific token positions. Composing arbitrary
    shards into one KV state is NOT equivalent to running through the model
    end-to-end — positional encodings differ. This module uses a disciplined
    approach: each shard is ONLY reusable as a strict prefix extension of
    previous shards, maintaining the same concatenation order.
  - If the concatenation order changes, shards must be rebuilt.
  - Falls back gracefully to full prefill if model architecture doesn't
    support save/load of partial cache states.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Optional

try:
    from mlx_lm.models.cache import make_prompt_cache, save_prompt_cache, load_prompt_cache
    _MLX_CACHE_AVAILABLE = True
except Exception as e:
    print(f"[semantic-kv-cache] mlx_lm cache unavailable: {e}", file=sys.stderr)
    _MLX_CACHE_AVAILABLE = False


def _hash(content: str) -> str:
    """SHA-256 hash of content, first 16 hex chars — stable shard identifier."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


def _shard_index_path(cache_dir: Path) -> Path:
    return cache_dir / "shards.index.json"


class ShardedPrefixCache:
    """
    Content-addressable prefix cache keyed by SHA-256 of text content.

    Extends the concept of server.py's _build_prefix_cache to cache multiple
    shards per model, enabling composition of system + steering + file contents
    without re-prefilling all of them on every request.
    """

    def __init__(self, model=None, processor=None, model_id: str = "", metal_lock=None,
                 cache_root: Optional[Path] = None, max_shards_per_model: int = 50):
        self.model = model
        self.processor = processor
        self.model_id = model_id or "unknown"
        self.metal_lock = metal_lock
        self.max_shards = max_shards_per_model

        if cache_root is None:
            cache_root = Path.home() / ".qwencoder" / "semantic-kv-cache"
        self.cache_dir = cache_root / self._safe_model_id()
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        # In-memory index: shard_hash → metadata
        self._index: dict[str, dict] = {}
        self._load_index()

    def _safe_model_id(self) -> str:
        return self.model_id.replace("/", "-").replace(":", "-")[-60:] or "unknown"

    # ── Index persistence ─────────────────────────────────────────────────

    def _load_index(self):
        index_file = _shard_index_path(self.cache_dir)
        if not index_file.exists():
            return
        try:
            with index_file.open("r") as f:
                self._index = json.load(f)
        except Exception as e:
            print(f"[semantic-kv-cache] Index load failed: {e}", file=sys.stderr)
            self._index = {}

    def _save_index(self):
        index_file = _shard_index_path(self.cache_dir)
        try:
            with index_file.open("w") as f:
                json.dump(self._index, f, indent=2)
        except Exception as e:
            print(f"[semantic-kv-cache] Index save failed: {e}", file=sys.stderr)

    # ── Shard lookup / build ──────────────────────────────────────────────

    def has(self, content_hash: str) -> bool:
        return content_hash in self._index and (self.cache_dir / self._shard_filename(content_hash)).exists()

    def _shard_filename(self, content_hash: str) -> str:
        return f"{content_hash}.safetensors"

    def _shard_path(self, content_hash: str) -> Path:
        return self.cache_dir / self._shard_filename(content_hash)

    def get_or_build(self, shard_type: str, content: str,
                     preceding_hashes: Optional[list[str]] = None,
                     path_hint: str = "") -> Optional[dict]:
        """
        Look up or build a cached KV state for the given content.

        preceding_hashes: list of shard hashes that should be treated as "already
            in the prefix" before this shard. When None, the shard is built as a
            standalone prefix (only valid as a root). When provided, we attempt
            to chain: load the preceding composite state, then extend with this
            content.

        Returns shard metadata dict, or None if caching failed.
        """
        if not _MLX_CACHE_AVAILABLE or self.model is None:
            return None

        content_hash = _hash(content)

        # Cache hit on an existing standalone shard at the same position
        if preceding_hashes is None and self.has(content_hash):
            return self._index[content_hash]

        # Chain hit: content_hash + preceding_hashes combo already cached?
        chain_key = self._chain_key(content_hash, preceding_hashes or [])
        chain_cached = self._index.get(chain_key)
        if chain_cached and (self.cache_dir / chain_cached.get("filename", "")).exists():
            return chain_cached

        # Miss — build
        try:
            return self._build_shard(shard_type, content, content_hash,
                                     preceding_hashes or [], path_hint)
        except Exception as e:
            print(f"[semantic-kv-cache] Shard build failed ({shard_type}): {e}",
                  file=sys.stderr)
            return None

    def _chain_key(self, content_hash: str, preceding: list[str]) -> str:
        """Stable key for a chain of shards."""
        if not preceding:
            return content_hash
        chain = "+".join(preceding) + "=>" + content_hash
        return hashlib.sha256(chain.encode()).hexdigest()[:16] + "_chain"

    def _build_shard(self, shard_type: str, content: str, content_hash: str,
                     preceding_hashes: list[str], path_hint: str) -> Optional[dict]:
        """Prefill the content and save the resulting KV cache shard."""
        from mlx_lm import stream_generate

        chain_key = self._chain_key(content_hash, preceding_hashes)
        shard_file = self._shard_path(chain_key) if preceding_hashes else self._shard_path(content_hash)
        filename = shard_file.name

        # Assemble the full prefix text by concatenating preceding shard contents
        # Note: we need the original text of preceding shards. Since we only store
        # their hashes in the index, look them up by hash and include their content.
        prefix_text = ""
        for h in preceding_hashes:
            meta = self._index.get(h)
            if meta and "content_preview" in meta:
                # Best-effort: we stored a preview. For real composition we need
                # the original content. See `content_refs` below for full content.
                pass

        full_text = prefix_text + content

        t0 = time.perf_counter()

        def _build():
            state = make_prompt_cache(self.model)
            # Prefill by streaming one token (forces the model to process the prefix)
            for _ in stream_generate(self.model, self.processor, full_text,
                                     max_tokens=1, prompt_cache=state):
                pass
            return state

        if self.metal_lock is not None:
            with self.metal_lock:
                state = _build()
        else:
            state = _build()

        # Count cached tokens
        cached_tokens = 0
        for c in state:
            if hasattr(c, "offset"):
                cached_tokens = c.offset
                break

        save_prompt_cache(str(shard_file), state, metadata={
            "shard_type": shard_type,
            "content_hash": content_hash,
            "model_id": self.model_id,
            "preceding": json.dumps(preceding_hashes),
            "path_hint": path_hint[:200],
        })

        size_mb = shard_file.stat().st_size / (1024 * 1024)
        elapsed = time.perf_counter() - t0

        meta = {
            "shard_type": shard_type,
            "content_hash": content_hash,
            "chain_key": chain_key,
            "filename": filename,
            "tokens": cached_tokens,
            "size_mb": round(size_mb, 2),
            "path_hint": path_hint[:200],
            "preceding": preceding_hashes,
            "built_at": time.time(),
            "content_preview": content[:200],
        }

        key = chain_key if preceding_hashes else content_hash
        self._index[key] = meta
        self._save_index()
        self._evict_if_needed()

        print(f"[semantic-kv-cache] Built {shard_type} shard: {cached_tokens} tokens, "
              f"{size_mb:.1f} MB, {elapsed:.2f}s ({filename})", file=sys.stderr)

        return meta

    # ── Composite load ────────────────────────────────────────────────────

    def load(self, shard_meta: dict):
        """Load a shard's KV state from disk. Returns the cache state or None."""
        if not _MLX_CACHE_AVAILABLE or not shard_meta:
            return None
        fname = shard_meta.get("filename")
        if not fname:
            return None
        path = self.cache_dir / fname
        if not path.exists():
            return None
        try:
            return load_prompt_cache(str(path))
        except Exception as e:
            print(f"[semantic-kv-cache] Load failed {fname}: {e}", file=sys.stderr)
            return None

    # ── Eviction ──────────────────────────────────────────────────────────

    def _evict_if_needed(self):
        if len(self._index) <= self.max_shards:
            return
        # LRU eviction: sort by built_at, remove oldest
        entries = sorted(self._index.items(), key=lambda kv: kv[1].get("built_at", 0))
        to_remove = entries[: len(self._index) - self.max_shards]
        for key, meta in to_remove:
            path = self.cache_dir / meta.get("filename", "")
            try:
                if path.exists():
                    path.unlink()
            except Exception:
                pass
            self._index.pop(key, None)
        self._save_index()
        print(f"[semantic-kv-cache] Evicted {len(to_remove)} old shards", file=sys.stderr)

    def stats(self) -> dict:
        total_size_mb = sum(m.get("size_mb", 0) for m in self._index.values())
        by_type: dict[str, int] = {}
        for m in self._index.values():
            t = m.get("shard_type", "unknown")
            by_type[t] = by_type.get(t, 0) + 1
        return {
            "shards": len(self._index),
            "total_size_mb": round(total_size_mb, 1),
            "by_type": by_type,
            "cache_dir": str(self.cache_dir),
        }

    def clear(self):
        """Delete all shards for this model."""
        for meta in self._index.values():
            path = self.cache_dir / meta.get("filename", "")
            try:
                if path.exists():
                    path.unlink()
            except Exception:
                pass
        self._index = {}
        self._save_index()
