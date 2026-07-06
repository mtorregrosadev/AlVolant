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

from typing import Any

import orjson
import redis.asyncio as aioredis

from app.core.logging import get_logger

logger = get_logger(__name__)

# Safety net: maximum TTL (24 hours) applied when no TTL is specified
# to prevent immortal keys from accumulating in Redis.
_DEFAULT_MAX_TTL = 86400  # 24 hours


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
            decode_responses=False,  # We handle decoding ourselves via orjson
        )
        self._client = aioredis.Redis(connection_pool=self._pool)
        logger.info("Redis connection pool established → %s", self.redis_url)

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
    ) -> None:
        """Store multiple JSON values in a single pipeline.

        Args:
            mapping: Dictionary of ``{key: value}`` pairs.
            ttl: Time-to-live in seconds applied to all keys.
                 Falls back to safety-net TTL if not provided.
        """
        effective_ttl = ttl if ttl is not None else _DEFAULT_MAX_TTL
        pipe = self.client.pipeline(transaction=False)
        for key, value in mapping.items():
            serialized = orjson.dumps(value)
            pipe.setex(key, effective_ttl, serialized)
        await pipe.execute()
