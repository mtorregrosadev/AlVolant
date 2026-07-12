"""Tests for the privacy-preserving nearby GTFS route index and endpoint."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.gtfs import router as gtfs_router
from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.models.gtfs import NearbyRoute
from app.services.gtfs_service import (
    _KEY_PROXIMITY_INDEX,
    _KEY_ROUTES,
    _KEY_STOPS_PREFIX,
    GTFSService,
)


def _stops(*coordinates: tuple[float, float]) -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "Point", "coordinates": list(coordinate)},
            }
            for coordinate in coordinates
        ],
    }


@pytest.mark.asyncio
async def test_fresh_index_groups_under_canonical_route_id(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = GTFSService(settings=settings, cache=cache)
    route_infos = [
        {"route_id": "canonical-a", "route_ids": ["a-outbound", "a-inbound"]},
        {"route_id": "canonical-b", "route_ids": ["b"]},
    ]
    route_to_trip = {
        ("a-outbound", 0): "trip-a-0",
        ("a-inbound", 1): "trip-a-1",
        ("b", 0): "trip-b",
    }
    trip_stops = {
        "trip-a-0": _stops((2.1700, 41.3800), (2.1710, 41.3810)),
        "trip-a-1": _stops((2.1700, 41.3800), (2.1720, 41.3820)),
        "trip-b": _stops((2.2000, 41.4100)),
    }

    proximity_index = service._build_route_proximity_index(
        route_infos,
        route_to_trip,
        trip_stops,
    )
    await service._cache_route_proximity_index(proximity_index)

    assert set(proximity_index) == {"canonical-a", "canonical-b"}
    assert len(proximity_index["canonical-a"]) == 3
    nearby = await service.get_nearby_routes(41.3800, 2.1700, limit=2)
    assert [route.route_id for route in nearby] == ["canonical-a", "canonical-b"]
    assert nearby[0].distance_meters == 0

    cached = await cache.get_json(_KEY_PROXIMITY_INDEX)
    assert cached["routes"] == proximity_index
    ttl = await cache.client.ttl(_KEY_PROXIMITY_INDEX)
    assert 0 < ttl <= settings.CACHE_TTL_GTFS_SHAPES


@pytest.mark.asyncio
async def test_nearby_routes_lazily_rebuilds_from_existing_stop_keys(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = GTFSService(settings=settings, cache=cache)
    await cache.set_json(
        _KEY_ROUTES,
        [
            {"route_id": "canonical-a", "route_ids": ["raw-a"]},
            {"route_id": "canonical-b", "route_ids": ["raw-b"]},
        ],
        ttl=settings.CACHE_TTL_GTFS_SHAPES,
    )
    await cache.set_json(
        f"{_KEY_STOPS_PREFIX}:raw-a:0",
        _stops((2.2500, 41.4500)),
        ttl=settings.CACHE_TTL_GTFS_SHAPES,
    )
    await cache.set_json(
        f"{_KEY_STOPS_PREFIX}:raw-a:1",
        _stops((2.1701, 41.3801)),
        ttl=settings.CACHE_TTL_GTFS_SHAPES,
    )
    await cache.set_json(
        f"{_KEY_STOPS_PREFIX}:raw-b",
        _stops((2.1800, 41.3900)),
        ttl=settings.CACHE_TTL_GTFS_SHAPES,
    )

    nearby = await service.get_nearby_routes(41.3800, 2.1700, limit=2)

    assert [route.route_id for route in nearby] == ["canonical-a", "canonical-b"]
    cached = await cache.get_json(_KEY_PROXIMITY_INDEX)
    assert set(cached["routes"]) == {"canonical-a", "canonical-b"}
    cached_keys = {
        key.decode() if isinstance(key, bytes) else key
        async for key in cache.client.scan_iter(match="gtfs:*")
    }
    assert not any("41.38" in key or "2.17" in key for key in cached_keys)


def _nearby_test_client(result: list[NearbyRoute] | None = None) -> tuple[TestClient, AsyncMock]:
    service = SimpleNamespace(
        get_nearby_routes=AsyncMock(
            return_value=result
            or [NearbyRoute(route_id="canonical-a", distance_meters=12.3)]
        )
    )
    app = FastAPI()
    app.state.api_key = "test-api-key"
    app.state.gtfs_service = service
    app.include_router(gtfs_router, prefix="/api/v1")
    return TestClient(app), service.get_nearby_routes


def test_nearby_endpoint_is_authenticated_and_rejects_extra_fields() -> None:
    client, get_nearby_routes = _nearby_test_client()
    payload = {"latitude": 41.38, "longitude": 2.17, "limit": 4}

    assert client.post("/api/v1/gtfs/routes/nearby", json=payload).status_code == 401
    response = client.post(
        "/api/v1/gtfs/routes/nearby",
        headers={"X-API-Key": "test-api-key"},
        json={**payload, "unexpected": True},
    )

    assert response.status_code == 422
    get_nearby_routes.assert_not_awaited()


def test_nearby_endpoint_validates_bounds_and_returns_distances() -> None:
    client, get_nearby_routes = _nearby_test_client()
    headers = {"X-API-Key": "test-api-key"}

    invalid = client.post(
        "/api/v1/gtfs/routes/nearby",
        headers=headers,
        json={"latitude": 91.0, "longitude": 2.17, "limit": 4},
    )
    valid = client.post(
        "/api/v1/gtfs/routes/nearby",
        headers=headers,
        json={"latitude": 41.38, "longitude": 2.17, "limit": 4},
    )

    assert invalid.status_code == 422
    assert valid.status_code == 200
    assert valid.json() == [{"route_id": "canonical-a", "distance_meters": 12.3}]
    get_nearby_routes.assert_awaited_once_with(
        latitude=41.38,
        longitude=2.17,
        limit=4,
    )
