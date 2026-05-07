"""
Tests for session-kv-cache.py — verify prefix matching and cache reuse logic
without requiring a real MLX model.
"""
import importlib
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

session_kv_cache_mod = importlib.import_module("session-kv-cache")
SessionKVCache = session_kv_cache_mod.SessionKVCache
_lcp = session_kv_cache_mod._longest_common_prefix_length


def test_lcp_identical():
    assert _lcp([1, 2, 3, 4], [1, 2, 3, 4]) == 4


def test_lcp_partial():
    assert _lcp([1, 2, 3, 4, 5], [1, 2, 3, 9, 10]) == 3


def test_lcp_no_match():
    assert _lcp([5, 6, 7], [1, 2, 3]) == 0


def test_lcp_empty():
    assert _lcp([], [1, 2, 3]) == 0
    assert _lcp([1, 2, 3], []) == 0


def test_lcp_different_lengths():
    assert _lcp([1, 2, 3], [1, 2, 3, 4, 5]) == 3


def test_cache_initial_state():
    c = SessionKVCache()
    stats = c.stats()
    assert stats["hits"] == 0
    assert stats["misses"] == 0
    assert stats["cached_tokens"] == 0


def test_cache_below_min_match():
    c = SessionKVCache(min_match_tokens=128)
    # Save small cache
    c.save([1, 2, 3], "fake_state", model_id="m1")
    # Try to match against similar small — should miss because below min
    hit = c.try_match([1, 2, 3, 4, 5], model_id="m1")
    assert hit is None
    assert c.stats()["misses"] == 1


def test_cache_model_mismatch():
    c = SessionKVCache(min_match_tokens=1)
    c.save([1] * 200, "state_a", model_id="model-a")
    hit = c.try_match([1] * 200, model_id="model-b")
    assert hit is None


def test_cache_empty_state():
    c = SessionKVCache(min_match_tokens=1)
    # No save called — try_match must return None gracefully
    hit = c.try_match([1, 2, 3])
    assert hit is None


def test_cache_stats_after_operations():
    c = SessionKVCache(min_match_tokens=1)
    # Two misses
    c.try_match([1])
    c.try_match([2])
    c.record_full_prefill()
    stats = c.stats()
    assert stats["misses"] == 2
    assert stats["full_prefills"] == 1


def test_cache_invalidate():
    c = SessionKVCache(min_match_tokens=1)
    c.save([1, 2, 3], "state", model_id="m")
    c.invalidate()
    stats = c.stats()
    assert stats["cached_tokens"] == 0


if __name__ == "__main__":
    import traceback
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            print(f"✓ {t.__name__}")
            passed += 1
        except Exception as e:
            print(f"✗ {t.__name__}: {e}")
            traceback.print_exc()
            failed += 1
    print()
    print(f"{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
