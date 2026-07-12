"""
Redis cache manager with connection pooling and structured key namespacing.

This module provides the ``CacheManager`` class — the single point of contact
between the BFF application and Redis.  All cache reads and writes flow through
this manager, which enforces:

* **Namespaced keys** — e.g. ``tmb:ibus:1234``, ``amb:gtfsrt:feed``
* **Automatic JSON serialization** via ``orjson`` for sub-millisecond encode/decode
* **Configurable TTL** per write so stale data is evicted automatically
* **Connection pooling** via ``redis.asyncio.ConnectionPool``
* **TTL safety net** — warns if any write is made without a TTL

Usage:
    from app.cache.redis_manager import CacheManager

    cache = CacheManager(redis_url="redis://localhost:6379/0")
    await cache.connect()
    await cache.set_json("tmb:ibus:1234", {"line": "H6", "minutes": 3}, ttl=20)
    data = await cache.get_json("tmb:ibus:1234")
    await cache.close()
"""

from __future__ import annotations

import asyncio
from typing import Any

import orjson
import redis.asyncio as aioredis

from app.core.logging import get_logger

logger = get_logger(__name__)

# Safety net: maximum TTL (24 hours) applied when no TTL is specified
# to prevent immortal keys from accumulating in Redis.
_DEFAULT_MAX_TTL = 86400  # 24 hours
_DEFAULT_PIPELINE_BATCH_SIZE = 500
_DEFAULT_PIPELINE_BATCH_BYTES = 4 * 1024 * 1024


class CacheManager:
    """Async Redis cache manager with connection pooling.

    Attributes:
        redis_url: Full Redis connection URI.
    """

    def __init__(self, redis_url: str) -> None:
        self.redis_url = redis_url
        self._pool: aioredis.ConnectionPool | None = None
        self._client: aioredis.Redis | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> None:
        """Establish the Redis connection pool.

        This must be called once during application startup (inside the
        FastAPI lifespan context manager).
        """
        self._pool = aioredis.ConnectionPool.from_url(
            self.redis_url,
            max_connections=50,
            socket_connect_timeout=3.0,
            socket_timeout=3.0,
            health_check_interval=30,
            retry_on_timeout=False,
            decode_responses=False,  # We handle decoding ourselves via orjson
        )
        self._client = aioredis.Redis(connection_pool=self._pool)
        logger.info("Redis connection pool established")

    async def close(self) -> None:
        """Gracefully close the Redis connection pool.

        Called during application shutdown.
        """
        if self._client:
            await self._client.aclose()
        if self._pool:
            await self._pool.disconnect()
        logger.info("Redis connection pool closed")

    @property
    def client(self) -> aioredis.Redis:
        """Return the active Redis client, raising if not connected."""
        if self._client is None:
            raise RuntimeError("CacheManager is not connected. Call connect() first.")
        return self._client

    # ------------------------------------------------------------------
    # Health & Monitoring
    # ------------------------------------------------------------------

    async def health_check(self) -> bool:
        """Ping Redis to verify connectivity.

        Returns:
            ``True`` if Redis responds to PING, ``False`` otherwise.
        """
        try:
            return await self.client.ping()
        except Exception:
            logger.warning("Redis health check failed")
            return False

    async def writable_health_check(self) -> bool:
        """Verify Redis can still accept writes under a no-eviction policy."""
        key = "rl:health:write-canary"
        try:
            await self.client.set(key, b"1", ex=5)
            await self.client.unlink(key)
            return True
        except Exception:
            logger.warning("Redis write health check failed")
            return False

    async def key_count(self) -> int:
        """Return the total number of keys in the current Redis database.

        Useful for monitoring memory usage and detecting key leaks.
        """
        try:
            return await self.client.dbsize()
        except Exception:
            logger.warning("Failed to get Redis key count")
            return -1

    # ------------------------------------------------------------------
    # Raw String Operations
    # ------------------------------------------------------------------

    async def get(self, key: str) -> bytes | None:
        """Retrieve a raw bytes value from the cache.

        Args:
            key: The cache key (should be pre-namespaced by the caller).

        Returns:
            Raw bytes if the key exists, ``None`` otherwise.
        """
        return await self.client.get(key)

    async def exists(self, key: str) -> bool:
        """Check key presence without fetching or deserializing its value."""
        return bool(await self.client.exists(key))

    async def ttl(self, key: str) -> int:
        """Return a key TTL without fetching its payload."""
        return int(await self.client.ttl(key))

    async def set(
        self,
        key: str,
        value: str | bytes,
        ttl: int | None = None,
    ) -> None:
        """Store a raw string/bytes value in the cache.

        If no TTL is provided, a safety-net TTL of 24 hours is applied
        to prevent immortal keys from accumulating in Redis.

        Args:
            key: The cache key.
            value: The value to store.
            ttl: Time-to-live in seconds. ``None`` applies the safety-net TTL.
        """
        if ttl is None:
            logger.debug(
                "No TTL provided for key '%s' — applying safety-net TTL of %ds",
                key,
                _DEFAULT_MAX_TTL,
            )
            ttl = _DEFAULT_MAX_TTL

        await self.client.setex(key, ttl, value)

    async def delete(self, key: str) -> int:
        """Delete a key from the cache.

        Args:
            key: The cache key to delete.

        Returns:
            Number of keys removed (0 or 1).
        """
        return await self.client.delete(key)

    async def delete_pattern(self, pattern: str) -> int:
        """Delete all keys matching a glob pattern using pipelined batches.

        Args:
            pattern: Redis glob pattern (e.g. ``tmb:ibus:*``).

        Returns:
            Number of keys removed.
        """
        count = 0
        batch: list[bytes | str] = []
        batch_size = 100

        async for key in self.client.scan_iter(match=pattern, count=batch_size):
            batch.append(key)
            if len(batch) >= batch_size:
                pipe = self.client.pipeline(transaction=False)
                for k in batch:
                    pipe.delete(k)
                await pipe.execute()
                count += len(batch)
                batch.clear()

        # Flush remaining
        if batch:
            pipe = self.client.pipeline(transaction=False)
            for k in batch:
                pipe.delete(k)
            await pipe.execute()
            count += len(batch)

        return count

    async def unlink(self, *keys: str) -> int:
        """Asynchronously reclaim one or more keys without blocking Redis."""
        if not keys:
            return 0
        return int(await self.client.unlink(*keys))

    async def unlink_pattern(
        self,
        pattern: str,
        batch_size: int = 250,
        max_passes: int = 32,
    ) -> int:
        """SCAN and UNLINK matching keys in bounded, event-loop-friendly batches."""
        if batch_size < 1 or max_passes < 1:
            raise ValueError("cleanup limits must be positive")

        count = 0
        for _pass in range(max_passes):
            pass_count = 0
            batch: list[bytes | str] = []
            async for key in self.client.scan_iter(match=pattern, count=batch_size):
                batch.append(key)
                if len(batch) >= batch_size:
                    removed = int(await self.client.unlink(*batch))
                    count += removed
                    pass_count += removed
                    batch.clear()
                    await asyncio.sleep(0)

            if batch:
                removed = int(await self.client.unlink(*batch))
                count += removed
                pass_count += removed

            if pass_count == 0:
                break
        else:
            logger.warning("Redis pattern cleanup reached its pass limit")

        return count

    # ------------------------------------------------------------------
    # JSON Operations (orjson for speed)
    # ------------------------------------------------------------------

    async def get_json(self, key: str) -> Any | None:
        """Retrieve and deserialize a JSON value from the cache.

        Args:
            key: The cache key.

        Returns:
            Deserialized Python object (dict, list, etc.) or ``None``.
        """
        raw = await self.get(key)
        if raw is None:
            return None
        try:
            return orjson.loads(raw)
        except orjson.JSONDecodeError:
            logger.warning("Failed to decode JSON for key: %s", key)
            return None

    async def hget_json(self, key: str, field: str) -> Any | None:
        """Retrieve one JSON value from a Redis hash field."""
        raw = await self.client.hget(key, field)
        if raw is None:
            return None
        try:
            return orjson.loads(raw)
        except orjson.JSONDecodeError:
            logger.warning("Failed to decode JSON hash field for key: %s", key)
            return None

    async def hmget_json(
        self,
        key: str,
        fields: list[str],
        batch_size: int = 1000,
    ) -> list[Any | None]:
        """Retrieve selected JSON hash fields using bounded Redis commands."""
        if batch_size < 1:
            raise ValueError("batch_size must be positive")
        if not fields:
            return []

        results: list[Any | None] = []
        for start in range(0, len(fields), batch_size):
            raw_values = await self.client.hmget(key, fields[start : start + batch_size])
            for raw in raw_values:
                if raw is None:
                    results.append(None)
                    continue
                try:
                    results.append(orjson.loads(raw))
                except orjson.JSONDecodeError:
                    results.append(None)
        return results

    async def set_json(
        self,
        key: str,
        value: Any,
        ttl: int | None = None,
    ) -> None:
        """Serialize a Python object to JSON and store it in the cache.

        Uses ``orjson`` for high-performance serialization (handles datetime,
        UUID, dataclass, and Pydantic model instances natively).

        Args:
            key: The cache key.
            value: Any JSON-serializable Python object.
            ttl: Time-to-live in seconds.
        """
        serialized = orjson.dumps(value)
        await self.set(key, serialized, ttl=ttl)

    # ------------------------------------------------------------------
    # Bulk Operations
    # ------------------------------------------------------------------

    async def mget_json(self, keys: list[str]) -> list[Any | None]:
        """Retrieve multiple JSON values in a single round-trip.

        Args:
            keys: List of cache keys.

        Returns:
            List of deserialized values (``None`` for missing keys).
        """
        raw_values = await self.client.mget(keys)
        results: list[Any | None] = []
        for raw in raw_values:
            if raw is None:
                results.append(None)
            else:
                try:
                    results.append(orjson.loads(raw))
                except orjson.JSONDecodeError:
                    results.append(None)
        return results

    async def mset_json(
        self,
        mapping: dict[str, Any],
        ttl: int | None = None,
        batch_size: int = _DEFAULT_PIPELINE_BATCH_SIZE,
        max_batch_bytes: int = _DEFAULT_PIPELINE_BATCH_BYTES,
    ) -> None:
        """Store multiple JSON values using bounded pipelines.

        Args:
            mapping: Dictionary of ``{key: value}`` pairs.
            ttl: Time-to-live in seconds applied to all keys.
                 Falls back to safety-net TTL if not provided.
            batch_size: Maximum number of commands per Redis pipeline.
            max_batch_bytes: Approximate maximum serialized payload per pipeline.
        """
        if batch_size < 1 or max_batch_bytes < 1:
            raise ValueError("pipeline batch limits must be positive")

        effective_ttl = ttl if ttl is not None else _DEFAULT_MAX_TTL
        batch: list[tuple[str, bytes]] = []
        batch_bytes = 0

        for key, value in mapping.items():
            serialized = orjson.dumps(value)
            item_bytes = len(key.encode("utf-8")) + len(serialized)
            if batch and (len(batch) >= batch_size or batch_bytes + item_bytes > max_batch_bytes):
                await self._write_string_batch(batch, effective_ttl)
                batch.clear()
                batch_bytes = 0
            batch.append((key, serialized))
            batch_bytes += item_bytes

        if batch:
            await self._write_string_batch(batch, effective_ttl)

    async def hset_json_batched(
        self,
        key: str,
        mapping: dict[str, Any],
        ttl: int | None = None,
        batch_size: int = _DEFAULT_PIPELINE_BATCH_SIZE,
        max_batch_bytes: int = _DEFAULT_PIPELINE_BATCH_BYTES,
    ) -> int:
        """Store JSON values as fields in one hash using bounded pipelines."""
        if batch_size < 1 or max_batch_bytes < 1:
            raise ValueError("pipeline batch limits must be positive")

        effective_ttl = ttl if ttl is not None else _DEFAULT_MAX_TTL
        batch: list[tuple[str, bytes]] = []
        batch_bytes = 0
        written = 0
        first_batch = True

        for field, value in mapping.items():
            serialized = orjson.dumps(value)
            item_bytes = len(field.encode("utf-8")) + len(serialized)
            if batch and (len(batch) >= batch_size or batch_bytes + item_bytes > max_batch_bytes):
                await self._write_hash_batch(
                    key,
                    batch,
                    initial_ttl=effective_ttl if first_batch else None,
                )
                written += len(batch)
                first_batch = False
                batch.clear()
                batch_bytes = 0
            batch.append((field, serialized))
            batch_bytes += item_bytes

        if batch:
            await self._write_hash_batch(
                key,
                batch,
                initial_ttl=effective_ttl if first_batch else None,
            )
            written += len(batch)

        if written:
            await self.client.expire(key, effective_ttl)
        return written

    async def hash_length(self, key: str) -> int:
        """Return the number of fields in a Redis hash."""
        return int(await self.client.hlen(key))

    async def expire(self, key: str, ttl: int) -> bool:
        """Refresh a key's expiry after a multi-stage cache publication."""
        if ttl < 1:
            raise ValueError("ttl must be positive")
        return bool(await self.client.expire(key, ttl))

    async def _write_string_batch(self, batch: list[tuple[str, bytes]], ttl: int) -> None:
        pipe = self.client.pipeline(transaction=False)
        for key, serialized in batch:
            pipe.setex(key, ttl, serialized)
        await pipe.execute()

    async def _write_hash_batch(
        self,
        key: str,
        batch: list[tuple[str, bytes]],
        initial_ttl: int | None = None,
    ) -> None:
        # The first batch and its TTL are atomic. A SIGKILL during later batches
        # can therefore leave only an expiring, unpublished generation.
        pipe = self.client.pipeline(transaction=initial_ttl is not None)
        for field, serialized in batch:
            pipe.hset(key, field, serialized)
        if initial_ttl is not None:
            pipe.expire(key, initial_ttl)
        await pipe.execute()
