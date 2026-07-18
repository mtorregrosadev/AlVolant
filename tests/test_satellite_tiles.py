"""Bounded World Imagery satellite tile tests."""

from __future__ import annotations

import asyncio
import io
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.api.satellite import router as satellite_router
from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.services.satellite_tile_service import (
    SatelliteTileClientQuotaExceededError,
    SatelliteTileNotFoundError,
    SatelliteTileQuotaExceededError,
    SatelliteTileService,
    SatelliteTileUnavailableError,
    _tile_intersects_catalonia,
)


def _settings(settings: Settings, **updates: object) -> Settings:
    return settings.model_copy(
        update={"ARCGIS_API_KEY": "test-key", "ENVIRONMENT": "test", **updates}
    )


def _jpeg() -> bytes:
    with io.BytesIO() as output:
        Image.new("RGB", (256, 256), color=(35, 95, 45)).save(output, format="JPEG")
        return output.getvalue()


@pytest.mark.asyncio
async def test_satellite_tile_is_cached_and_coalesces_concurrent_requests(
    settings: Settings,
) -> None:
    service = SatelliteTileService(_settings(settings, SATELLITE_TILE_CACHE_ENTRIES=2))
    fetched = AsyncMock(return_value=_jpeg())
    service._fetch_provider_tile = fetched

    images = await asyncio.gather(*(service.get_tile(14, 8290, 6119) for _ in range(12)))

    assert all(image[:2] == b"\xff\xd8" for image in images)
    fetched.assert_awaited_once_with(14, 8290, 6119)
    assert await service.get_tile(14, 8290, 6119) == images[0]
    fetched.assert_awaited_once()


@pytest.mark.asyncio
async def test_satellite_cached_tiles_do_not_consume_client_quota(settings: Settings) -> None:
    service = SatelliteTileService(_settings(settings, SATELLITE_TILE_CACHE_ENTRIES=2))
    fetched = AsyncMock(return_value=_jpeg())
    service._fetch_provider_tile = fetched

    first = await service.get_tile(14, 8290, 6119)
    service._client_request_allowed = AsyncMock(return_value=False)

    cached = await service.get_tile(
        14,
        8290,
        6119,
        client_id="A" * 24,
        client_ip="127.0.0.1",
    )

    assert cached == first
    service._client_request_allowed.assert_not_awaited()
    fetched.assert_awaited_once_with(14, 8290, 6119)


@pytest.mark.asyncio
async def test_satellite_client_quota_is_reserved_only_for_cold_tiles(settings: Settings) -> None:
    service = SatelliteTileService(_settings(settings))
    service._client_request_allowed = AsyncMock(return_value=False)

    with pytest.raises(SatelliteTileClientQuotaExceededError):
        await service.get_tile(
            14,
            8290,
            6119,
            client_id="A" * 24,
            client_ip="127.0.0.1",
        )

    service._client_request_allowed.assert_awaited_once_with("A" * 24, "127.0.0.1")


@pytest.mark.asyncio
async def test_satellite_tiles_reject_outside_catalonia(settings: Settings) -> None:
    service = SatelliteTileService(_settings(settings))

    with pytest.raises(SatelliteTileNotFoundError):
        await service.get_tile(17, 0, 0)
    with pytest.raises(SatelliteTileNotFoundError):
        await service.get_tile(21, 1_061_850, 782_574)


@pytest.mark.asyncio
async def test_satellite_tiles_require_server_side_arcgis_key(settings: Settings) -> None:
    service = SatelliteTileService(settings.model_copy(update={"ARCGIS_API_KEY": ""}))

    with pytest.raises(SatelliteTileUnavailableError):
        await service.get_tile(14, 8290, 6119)


@pytest.mark.asyncio
async def test_world_imagery_fetch_uses_private_token_query_parameter(settings: Settings) -> None:
    service = SatelliteTileService(_settings(settings, ARCGIS_API_KEY="private-key"))
    request = httpx.Request("GET", "https://example.invalid/tile")
    response = httpx.Response(
        200,
        headers={"content-type": "image/jpeg"},
        content=_jpeg(),
        request=request,
    )
    client = AsyncMock()
    client.get = AsyncMock(return_value=response)
    service._client = client

    image = await service._fetch_provider_tile(14, 8290, 6119)

    assert image[:2] == b"\xff\xd8"
    client.get.assert_awaited_once()
    _, kwargs = client.get.call_args
    assert kwargs["params"] == {"token": "private-key"}
    assert "Authorization" not in kwargs


@pytest.mark.asyncio
async def test_satellite_global_daily_quota_disables_availability(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = SatelliteTileService(
        _settings(
            settings,
            SATELLITE_GLOBAL_REQUESTS_PER_MINUTE=2,
            SATELLITE_GLOBAL_REQUESTS_PER_DAY=1,
        ),
        cache,
    )

    assert await service._provider_request_allowed() is True
    assert await service._provider_request_allowed() is False
    assert await service.is_available() is False


@pytest.mark.asyncio
async def test_satellite_global_minute_quota_disables_availability(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = SatelliteTileService(
        _settings(
            settings,
            SATELLITE_GLOBAL_REQUESTS_PER_MINUTE=1,
            SATELLITE_GLOBAL_REQUESTS_PER_DAY=10,
        ),
        cache,
    )

    assert await service._provider_request_allowed() is True
    assert await service.is_available() is False


@pytest.mark.asyncio
async def test_satellite_status_keeps_a_cached_area_enabled_after_global_quota(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = SatelliteTileService(
        _settings(
            settings,
            SATELLITE_GLOBAL_REQUESTS_PER_MINUTE=1,
            SATELLITE_GLOBAL_REQUESTS_PER_DAY=1,
        ),
        cache,
    )
    service._fetch_provider_tile = AsyncMock(return_value=_jpeg())
    await service.get_tile(14, 8290, 6119)
    assert await service._provider_request_allowed() is True
    assert await service.is_available() is False

    assert await service.is_client_available(
        "A" * 24,
        "127.0.0.1",
        tile=(14, 8290, 6119),
    ) is True


@pytest.mark.asyncio
async def test_satellite_quota_prevents_an_upstream_request(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = SatelliteTileService(
        _settings(
            settings, SATELLITE_GLOBAL_REQUESTS_PER_MINUTE=1, SATELLITE_GLOBAL_REQUESTS_PER_DAY=1
        ),
        cache,
    )
    service._client = AsyncMock()

    assert await service._provider_request_allowed() is True
    with pytest.raises(SatelliteTileQuotaExceededError):
        await service._fetch_provider_tile(14, 8290, 6119)
    service._client.get.assert_not_awaited()


def test_satellite_guard_is_geographic() -> None:
    assert _tile_intersects_catalonia(14, 8290, 6119) is True
    assert _tile_intersects_catalonia(14, 0, 0) is False


def test_satellite_endpoint_is_public_but_tightly_bounded() -> None:
    image = _jpeg()
    get_tile = AsyncMock(return_value=image)
    app = FastAPI()
    app.state.satellite_tile_service = SimpleNamespace(get_tile=get_tile)
    app.include_router(satellite_router)
    client = TestClient(app)

    client_id = "A" * 24
    response = client.get(f"/maps/satellite/14/8290/6119.jpg?client_id={client_id}")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["cache-control"].startswith("public")
    assert response.content == image
    get_tile.assert_awaited_once_with(14, 8290, 6119, client_id=client_id, client_ip="testclient")


def test_satellite_status_does_not_expose_quota_or_credentials() -> None:
    app = FastAPI()
    available = AsyncMock(return_value=False)
    app.state.satellite_tile_service = SimpleNamespace(is_client_available=available)
    app.include_router(satellite_router)
    client = TestClient(app)

    response = client.get("/maps/satellite/status")

    assert response.status_code == 200
    assert response.json()["available"] is False
    assert len(response.json()["client_id"]) >= 24
    assert response.headers["cache-control"] == "no-store"
    available.assert_awaited_once()


def test_satellite_endpoint_returns_429_after_quota_exhaustion() -> None:
    get_tile = AsyncMock(side_effect=SatelliteTileQuotaExceededError)
    app = FastAPI()
    app.state.satellite_tile_service = SimpleNamespace(get_tile=get_tile)
    app.include_router(satellite_router)
    client = TestClient(app)

    response = client.get(f"/maps/satellite/14/8290/6119.jpg?client_id={'A' * 24}")

    assert response.status_code == 429
    assert response.headers["cache-control"] == "no-store"


def test_satellite_endpoint_returns_client_quota_marker() -> None:
    get_tile = AsyncMock(side_effect=SatelliteTileClientQuotaExceededError)
    app = FastAPI()
    app.state.satellite_tile_service = SimpleNamespace(get_tile=get_tile)
    app.include_router(satellite_router)
    client = TestClient(app)

    response = client.get(f"/maps/satellite/14/8290/6119.jpg?client_id={'A' * 24}")

    assert response.status_code == 429
    assert response.headers["x-satellite-disabled"] == "client-quota"


def test_satellite_style_binds_tiles_to_the_opaque_client_id() -> None:
    app = FastAPI()
    app.include_router(satellite_router)
    client = TestClient(app)
    client_id = "A" * 24

    response = client.get(f"/maps/satellite/style.json?client_id={client_id}")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    tile_url = response.json()["sources"]["satellite"]["tiles"][0]
    assert f"client_id={client_id}" in tile_url
    assert "token=" not in tile_url
