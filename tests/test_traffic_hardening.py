"""Privacy and resource-boundary tests for road traffic lookups."""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.services.traffic_service as traffic_module
from app.api.v1.traffic import router as traffic_router
from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.models.traffic import TrafficSummary
from app.services.traffic_service import TrafficService


def _summary() -> TrafficSummary:
    return TrafficSummary(
        label="Trànsit fluid",
        status="normal",
        source="tomtom",
        current_speed_kmh=40,
        free_flow_speed_kmh=45,
        delay_seconds=0,
        confidence=0.9,
        road_closure=False,
    )


def _settings(settings: Settings, **updates: object) -> Settings:
    return settings.model_copy(update={"TOMTOM_API_KEY": "test-secret", **updates})


@pytest.mark.asyncio
async def test_traffic_quantizes_before_provider_and_reuses_bucket(settings: Settings) -> None:
    service = TrafficService(_settings(settings))
    service._fetch_tomtom_flow = AsyncMock(return_value=_summary())

    first = await service.get_summary(41.38721, 2.16991)
    second = await service.get_summary(41.38739, 2.17014)

    assert first == second
    service._fetch_tomtom_flow.assert_awaited_once_with(41.387, 2.17)
    assert list(service._memory_cache) == [(41_387, 2_170)]


@pytest.mark.asyncio
async def test_traffic_concurrent_bucket_uses_single_provider_request(settings: Settings) -> None:
    service = TrafficService(_settings(settings))

    async def fetch(_latitude: float, _longitude: float) -> TrafficSummary:
        await asyncio.sleep(0.02)
        return _summary()

    service._fetch_tomtom_flow = AsyncMock(side_effect=fetch)
    results = await asyncio.gather(
        *(service.get_summary(41.38721, 2.16991) for _ in range(20))
    )

    assert all(result == _summary() for result in results)
    service._fetch_tomtom_flow.assert_awaited_once()


@pytest.mark.asyncio
async def test_traffic_shared_cache_reuses_a_zone_across_bff_instances(
    settings: Settings,
    cache: CacheManager,
) -> None:
    first_service = TrafficService(_settings(settings), cache)
    second_service = TrafficService(_settings(settings), cache)
    first_service._fetch_tomtom_flow = AsyncMock(return_value=_summary())
    second_service._fetch_tomtom_flow = AsyncMock(return_value=_summary())

    first = await first_service.get_summary(41.38721, 2.16991)
    second = await second_service.get_summary(41.38739, 2.17014)

    assert first == second == _summary()
    first_service._fetch_tomtom_flow.assert_awaited_once()
    second_service._fetch_tomtom_flow.assert_not_awaited()


@pytest.mark.asyncio
async def test_traffic_shared_lookup_lock_coalesces_concurrent_bff_instances(
    settings: Settings,
    cache: CacheManager,
) -> None:
    first_service = TrafficService(_settings(settings), cache)
    second_service = TrafficService(_settings(settings), cache)

    async def fetch(_latitude: float, _longitude: float) -> TrafficSummary:
        await asyncio.sleep(0.05)
        return _summary()

    first_service._fetch_tomtom_flow = AsyncMock(side_effect=fetch)
    second_service._fetch_tomtom_flow = AsyncMock(side_effect=fetch)

    first, second = await asyncio.gather(
        first_service.get_summary(41.38721, 2.16991),
        second_service.get_summary(41.38739, 2.17014),
    )

    assert first == second == _summary()
    assert (
        first_service._fetch_tomtom_flow.await_count
        + second_service._fetch_tomtom_flow.await_count
    ) == 1


@pytest.mark.asyncio
async def test_traffic_global_quota_bounds_unique_buckets(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = TrafficService(
        _settings(
            settings,
            TRAFFIC_GLOBAL_REQUESTS_PER_MINUTE=1,
            TRAFFIC_GLOBAL_REQUESTS_PER_DAY=1,
        ),
        cache,
    )
    service._fetch_tomtom_flow = AsyncMock(return_value=_summary())

    allowed = await service.get_summary(41.387, 2.170)
    limited = await service.get_summary(41.388, 2.170)

    assert allowed.status == "normal"
    assert limited.status == "unavailable"
    service._fetch_tomtom_flow.assert_awaited_once()


@pytest.mark.asyncio
async def test_traffic_429_opens_shared_circuit(
    settings: Settings,
    cache: CacheManager,
) -> None:
    requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(429, request=request)

    service = TrafficService(_settings(settings), cache)
    service._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        first = await service.get_summary(41.387, 2.170)
        second = await service.get_summary(41.388, 2.170)
    finally:
        await service.close()

    assert first.status == "unavailable"
    assert second.status == "unavailable"
    assert requests == 1
    assert await cache.exists(traffic_module._TRAFFIC_CIRCUIT_KEY) is True


@pytest.mark.asyncio
async def test_traffic_rejects_coordinates_outside_catalonia(settings: Settings) -> None:
    service = TrafficService(_settings(settings))
    service._fetch_tomtom_flow = AsyncMock(return_value=_summary())

    with pytest.raises(ValueError, match="service area"):
        await service.get_summary(39.5, 2.17)
    with pytest.raises(ValueError, match="service area"):
        await service.get_summary(41.38, -3.7)

    service._fetch_tomtom_flow.assert_not_awaited()


@pytest.mark.asyncio
async def test_traffic_cache_has_lru_and_ttl_caps(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(traffic_module, "_MAX_CACHE_ENTRIES", 3)
    monkeypatch.setattr(traffic_module.time, "monotonic", lambda: 100.0)
    service = TrafficService(_settings(settings, TRAFFIC_CACHE_TTL_SECONDS=9_999))
    service._fetch_tomtom_flow = AsyncMock(return_value=_summary())

    for latitude in (41.380, 41.381, 41.382, 41.383):
        await service.get_summary(latitude, 2.17)

    assert len(service._memory_cache) == 3
    assert (41_380, 2_170) not in service._memory_cache
    assert all(entry.expires_at == 3_700.0 for entry in service._memory_cache.values())


@pytest.mark.asyncio
async def test_traffic_provider_failure_log_redacts_request_data(
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    service = TrafficService(_settings(settings))
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(
            "failed https://api.tomtom.com/?key=test-secret&point=41.387,2.17",
            request=request,
        )

    service._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    try:
        with caplog.at_level(logging.WARNING, logger="app.services.traffic_service"):
            result = await service.get_summary(41.38721, 2.16991)
    finally:
        await service.close()

    assert result.status == "unavailable"
    assert "test-secret" not in caplog.text
    assert "41.387" not in caplog.text
    assert "api.tomtom.com" not in caplog.text


@pytest.mark.asyncio
async def test_traffic_stream_rejects_oversized_decoded_body(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(traffic_module, "_MAX_RESPONSE_BYTES", 32)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Type": "application/json"},
            content=b"{" + (b" " * 32) + b"}",
        )

    service = TrafficService(_settings(settings))
    service._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = await service.get_summary(41.38721, 2.16991)
    finally:
        await service.close()

    assert result.status == "unavailable"


def test_traffic_normalizer_rejects_non_finite_and_implausible_numbers(
    settings: Settings,
) -> None:
    service = TrafficService(_settings(settings))
    result = service._normalize_tomtom_flow({
        "flowSegmentData": {
            "currentSpeed": float("inf"),
            "freeFlowSpeed": 10**1_000,
            "currentTravelTime": float("nan"),
            "freeFlowTravelTime": -1,
            "confidence": 2,
        }
    })

    assert result.status == "unavailable"
    assert result.current_speed_kmh is None
    assert result.free_flow_speed_kmh is None


def test_traffic_endpoint_uses_bounded_json_body() -> None:
    get_summary = AsyncMock(return_value=_summary())
    app = FastAPI()
    app.state.api_key = "test-api-key"
    app.state.traffic_service = SimpleNamespace(get_summary=get_summary)
    app.include_router(traffic_router, prefix="/api/v1")
    client = TestClient(app)
    headers = {"X-API-Key": "test-api-key"}

    outside = client.post(
        "/api/v1/traffic/summary",
        json={"latitude": 39.5, "longitude": 2.17},
        headers=headers,
    )
    inside = client.post(
        "/api/v1/traffic/summary",
        json={"latitude": 41.38, "longitude": 2.17},
        headers=headers,
    )
    legacy_get = client.get(
        "/api/v1/traffic/summary?latitude=41.38&longitude=2.17",
        headers=headers,
    )

    assert outside.status_code == 422
    assert inside.status_code == 200
    assert legacy_get.status_code == 405
    get_summary.assert_awaited_once_with(latitude=41.38, longitude=2.17)
