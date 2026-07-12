"""
Shared pytest fixtures for the Route-TMB BFF test suite.

Provides:
- A fake Redis instance (in-memory, no real Redis needed)
- A configured CacheManager using fake Redis
- Pre-configured service instances for testing
- A FastAPI test client
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from unittest.mock import AsyncMock

import fakeredis.aioredis
import pytest
import pytest_asyncio

from app.cache.redis_manager import CacheManager
from app.config import Settings


@pytest.fixture
def settings() -> Settings:
    """Return test settings with safe defaults."""
    return Settings(
        ATM_RT_TRIP_UPDATES_URL="https://example.com/trip_updates.pb",
        ATM_RT_ALERTS_URL="https://example.com/alerts.pb",
        ATM_RT_VEHICLE_POSITIONS_URL="https://example.com/vehicle_positions.pb",
        ATM_RT_POLL_INTERVAL_SECONDS=30,
        ATM_GTFS_URL="https://example.com/gtfs.zip",
        REDIS_URL="redis://localhost:6379/0",
        CACHE_TTL_ATM_REALTIME=35,
        ATM_RT_FRESHNESS_SECONDS=30,
        CACHE_TTL_GTFS_SHAPES=86400,
    )


@pytest_asyncio.fixture
async def fake_redis() -> AsyncIterator[fakeredis.aioredis.FakeRedis]:
    """Provide an in-memory fake Redis instance."""
    server = fakeredis.aioredis.FakeServer()
    client = fakeredis.aioredis.FakeRedis(server=server, decode_responses=False)
    yield client
    await client.aclose()


@pytest_asyncio.fixture
async def cache(
    fake_redis: fakeredis.aioredis.FakeRedis,
) -> AsyncIterator[CacheManager]:
    """Provide a CacheManager backed by fake Redis.

    This overrides the internal client directly so we don't need
    a real Redis connection.
    """
    manager = CacheManager(redis_url="redis://fake:6379/0")
    # Bypass the normal connect() flow and inject the fake client
    manager._client = fake_redis
    yield manager


@pytest.fixture
def mock_http_client() -> AsyncMock:
    """Provide a mock httpx.AsyncClient for testing services."""
    return AsyncMock()
