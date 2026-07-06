"""
Tests for the Redis CacheManager.

Verifies JSON serialization/deserialization, TTL handling, bulk operations,
health checks, and pattern deletion using an in-memory fake Redis backend.
"""

from __future__ import annotations

import pytest

from app.cache.redis_manager import CacheManager


class TestCacheManagerJsonOps:
    """Test JSON get/set operations."""

    @pytest.mark.asyncio
    async def test_set_and_get_json(self, cache: CacheManager) -> None:
        """Values stored with set_json should be retrievable with get_json."""
        data = {"line": "H6", "minutes": 3, "destination": "Zona Universitària"}
        await cache.set_json("test:key:1", data)
        result = await cache.get_json("test:key:1")
        assert result == data

    @pytest.mark.asyncio
    async def test_get_json_missing_key(self, cache: CacheManager) -> None:
        """get_json should return None for non-existent keys."""
        result = await cache.get_json("nonexistent:key")
        assert result is None

    @pytest.mark.asyncio
    async def test_set_json_with_ttl(self, cache: CacheManager) -> None:
        """Values stored with a TTL should be retrievable immediately."""
        data = {"stop_id": "1234"}
        await cache.set_json("test:ttl:1", data, ttl=60)
        result = await cache.get_json("test:ttl:1")
        assert result == data

    @pytest.mark.asyncio
    async def test_set_json_overwrite(self, cache: CacheManager) -> None:
        """Setting the same key twice should overwrite the value."""
        await cache.set_json("test:overwrite", {"v": 1})
        await cache.set_json("test:overwrite", {"v": 2})
        result = await cache.get_json("test:overwrite")
        assert result == {"v": 2}

    @pytest.mark.asyncio
    async def test_nested_json(self, cache: CacheManager) -> None:
        """Complex nested structures should round-trip correctly."""
        data = {
            "stops": [
                {"id": "1", "arrivals": [{"line": "H6", "min": 3}]},
                {"id": "2", "arrivals": []},
            ],
            "metadata": {"count": 2, "cached": True},
        }
        await cache.set_json("test:nested", data)
        result = await cache.get_json("test:nested")
        assert result == data


class TestCacheManagerBulkOps:
    """Test bulk (pipeline) operations."""

    @pytest.mark.asyncio
    async def test_mset_and_mget_json(self, cache: CacheManager) -> None:
        """mset_json + mget_json should handle multiple keys atomically."""
        mapping = {
            "bulk:1": {"a": 1},
            "bulk:2": {"b": 2},
            "bulk:3": {"c": 3},
        }
        await cache.mset_json(mapping, ttl=60)
        results = await cache.mget_json(["bulk:1", "bulk:2", "bulk:3"])
        assert results == [{"a": 1}, {"b": 2}, {"c": 3}]

    @pytest.mark.asyncio
    async def test_mget_json_with_missing(self, cache: CacheManager) -> None:
        """mget_json should return None for missing keys in the list."""
        await cache.set_json("bulk:exists", {"x": 1})
        results = await cache.mget_json(["bulk:exists", "bulk:missing"])
        assert results == [{"x": 1}, None]


class TestCacheManagerDeleteOps:
    """Test delete operations."""

    @pytest.mark.asyncio
    async def test_delete_key(self, cache: CacheManager) -> None:
        """delete should remove a key and return 1."""
        await cache.set_json("delete:me", {"x": 1})
        removed = await cache.delete("delete:me")
        assert removed == 1
        assert await cache.get_json("delete:me") is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent(self, cache: CacheManager) -> None:
        """Deleting a non-existent key should return 0."""
        removed = await cache.delete("never:existed")
        assert removed == 0

    @pytest.mark.asyncio
    async def test_delete_pattern(self, cache: CacheManager) -> None:
        """delete_pattern should remove all keys matching the glob."""
        await cache.set_json("pattern:a:1", {"v": 1})
        await cache.set_json("pattern:a:2", {"v": 2})
        await cache.set_json("pattern:b:1", {"v": 3})

        removed = await cache.delete_pattern("pattern:a:*")
        assert removed == 2
        assert await cache.get_json("pattern:b:1") == {"v": 3}


class TestCacheManagerHealth:
    """Test health check."""

    @pytest.mark.asyncio
    async def test_health_check_passes(self, cache: CacheManager) -> None:
        """health_check should return True for a connected cache."""
        result = await cache.health_check()
        assert result is True
