"""Tests for the compact, generation-based GTFS trip index."""

from __future__ import annotations

import asyncio
import time
from typing import Any
from unittest.mock import AsyncMock

import pytest

from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.models.gtfs import RouteShape
from app.services.gtfs_service import (
    _KEY_CALENDAR,
    _KEY_CALENDAR_DATES,
    _KEY_ROUTES,
    _KEY_SCHEDULE_INDEX_ACTIVE,
    _KEY_SNAPSHOT_ACTIVE,
    _KEY_TRIP_INDEX_ACTIVE,
    _KEY_TRIP_META_PREFIX,
    _KEY_TRIP_SHAPE_PREFIX,
    _KEY_TRIP_STOPS_PREFIX,
    _KEY_TRIPS_PREFIX,
    GTFSService,
)


def _source_data() -> tuple[list[dict], dict, dict, dict, dict, dict]:
    trips = [
        {
            "trip_id": "trip-out",
            "route_id": "route-1",
            "direction_id": 0,
            "service_id": "weekday",
            "trip_headsign": "Centre",
            "shape_id": "shared-shape",
        },
        {
            "trip_id": "trip-back",
            "route_id": "route-1",
            "direction_id": 1,
            "service_id": "weekday",
            "trip_headsign": "Estació",
            "shape_id": "shared-shape",
        },
    ]
    routes = {
        "route-1": {
            "route_short_name": "M30",
            "route_long_name": "Montgat - Santa Coloma",
            "route_color": "008C79",
            "route_text_color": "FFFFFF",
            "route_type": 3,
            "agency_id": "AMB",
        }
    }
    shapes = {
        "shared-shape": [
            {"lat": 41.1, "lon": 2.1, "sequence": 1},
            {"lat": 41.2, "lon": 2.2, "sequence": 2},
        ]
    }
    stops = {
        "A": {"lat": 41.1, "lon": 2.1, "name": "Origen"},
        "B": {"lat": 41.2, "lon": 2.2, "name": "Destí"},
    }
    stop_times = {
        trip_id: [
            ("A", 1, "08:00:00"),
            ("B", 2, "08:10:00"),
        ]
        for trip_id in ("trip-out", "trip-back")
    }
    start_times = {"trip-out": "08:00:00", "trip-back": "08:00:00"}
    return trips, routes, shapes, stops, stop_times, start_times


def _build_indexes(service: GTFSService) -> tuple[dict, dict, dict]:
    trips, routes, shapes, stops, stop_times, start_times = _source_data()
    return service._build_trip_indexes(
        trip_rows=trips,
        routes_by_id=routes,
        shapes_by_id=shapes,
        stops_by_id=stops,
        stop_times_by_trip=stop_times,
        trip_start_times=start_times,
    )


def _legacy_shape(trip_id: str = "legacy-trip") -> dict:
    return RouteShape(
        route_id="route-1",
        shape_id="legacy-shape",
        route_short_name="M30",
        direction_id=0,
        trip_id=trip_id,
        destination_name="Centre",
        geojson={
            "type": "Feature",
            "properties": {"route_id": "route-1", "trip_id": trip_id},
            "geometry": {
                "type": "LineString",
                "coordinates": [[2.1, 41.1], [2.2, 41.2]],
            },
        },
    ).model_dump(mode="json")


def _legacy_stops(trip_id: str = "legacy-trip") -> dict:
    return {
        "type": "FeatureCollection",
        "features": [],
        "route_id": "route-1",
        "direction_id": 0,
        "trip_id": trip_id,
        "stop_count": 0,
        "last_updated": "legacy",
    }


@pytest.mark.asyncio
async def test_trip_indexes_deduplicate_shapes_and_stop_patterns(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = GTFSService(settings=settings, cache=cache)
    assert await service.has_cached_routes() is False

    trip_meta, stop_patterns, shape_geometries = _build_indexes(service)

    assert len(trip_meta) == 2
    assert len(stop_patterns) == 1
    assert len(shape_geometries) == 1
    assert trip_meta["trip-out"]["shape_id"] == "shared-shape"
    assert trip_meta["trip-out"]["stop_pattern_id"] == trip_meta["trip-back"]["stop_pattern_id"]


@pytest.mark.asyncio
async def test_v2_index_reconstructs_trip_specific_shape_and_stops(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = GTFSService(settings=settings, cache=cache)
    trip_meta, stop_patterns, shape_geometries = _build_indexes(service)
    await cache.set_json(
        _KEY_ROUTES,
        [{"route_id": "route-1", "route_ids": ["route-1"]}],
        ttl=settings.CACHE_TTL_GTFS_SHAPES,
    )
    legacy_keys = [
        f"{_KEY_TRIP_META_PREFIX}:obsolete",
        f"{_KEY_TRIP_STOPS_PREFIX}:obsolete",
        f"{_KEY_TRIP_SHAPE_PREFIX}:obsolete",
    ]
    for legacy_key in legacy_keys:
        await cache.set_json(legacy_key, {"obsolete": True}, ttl=60)

    await service._cache_trip_indexes(trip_meta, stop_patterns, shape_geometries)

    outbound_shape = await service.get_route_shape("route-1", trip_id="trip-out")
    return_shape = await service.get_route_shape("route-1", trip_id="trip-back")
    outbound_stops = await service.get_route_stops("route-1", trip_id="trip-out")
    return_stops = await service.get_route_stops("route-1", trip_id="trip-back")

    assert outbound_shape is not None and return_shape is not None
    assert outbound_shape.geojson["geometry"] == return_shape.geojson["geometry"]
    assert outbound_shape.geojson["properties"]["trip_id"] == "trip-out"
    assert return_shape.geojson["properties"]["trip_id"] == "trip-back"
    assert outbound_shape.destination_name == "Centre"
    assert return_shape.destination_name == "Estació"
    assert outbound_stops is not None and return_stops is not None
    assert outbound_stops["features"][0]["properties"]["trip_id"] == "trip-out"
    assert return_stops["features"][0]["properties"]["trip_id"] == "trip-back"
    assert outbound_stops["direction_id"] == 0
    assert return_stops["direction_id"] == 1
    assert await service.has_cached_routes() is True

    manifest = await cache.get_json(_KEY_TRIP_INDEX_ACTIVE)
    assert await cache.hash_length(service._trip_index_key(manifest["generation"], "meta")) == 2
    assert await cache.hash_length(service._trip_index_key(manifest["generation"], "stops")) == 1
    assert await cache.hash_length(service._trip_index_key(manifest["generation"], "shapes")) == 1
    for legacy_key in legacy_keys:
        assert await cache.exists(legacy_key) is True
    await service._cleanup_legacy_trip_indexes()
    for legacy_key in legacy_keys:
        assert await cache.exists(legacy_key) is False


@pytest.mark.asyncio
async def test_trip_reads_fall_back_to_legacy_keys_during_migration(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = GTFSService(settings=settings, cache=cache)
    generation = "a" * 32
    await cache.set_json(
        _KEY_TRIP_INDEX_ACTIVE,
        {"version": 2, "generation": generation, "last_updated": "new"},
        ttl=60,
    )
    await cache.set_json(
        _KEY_ROUTES,
        [{"route_id": "route-1", "route_ids": ["route-1"]}],
        ttl=60,
    )
    await cache.set_json(
        f"{_KEY_TRIP_META_PREFIX}:legacy-trip",
        {"trip_id": "legacy-trip", "route_id": "route-1", "direction_id": 0},
        ttl=60,
    )
    await cache.set_json(
        f"{_KEY_TRIP_SHAPE_PREFIX}:legacy-trip",
        _legacy_shape(),
        ttl=60,
    )
    await cache.set_json(
        f"{_KEY_TRIP_STOPS_PREFIX}:legacy-trip",
        _legacy_stops(),
        ttl=60,
    )

    shape = await service.get_route_shape("route-1", trip_id="legacy-trip")
    stops = await service.get_route_stops("route-1", trip_id="legacy-trip")

    assert shape is not None and shape.trip_id == "legacy-trip"
    assert stops is not None and stops["last_updated"] == "legacy"


@pytest.mark.asyncio
async def test_failed_generation_does_not_publish_or_delete_legacy_data(
    settings: Settings,
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GTFSService(settings=settings, cache=cache)
    trip_meta, stop_patterns, shape_geometries = _build_indexes(service)
    legacy_key = f"{_KEY_TRIP_META_PREFIX}:keep-me"
    await cache.set_json(legacy_key, {"trip_id": "keep-me"}, ttl=60)
    monkeypatch.setattr(cache, "hash_length", AsyncMock(side_effect=[0, 0, 0]))

    with pytest.raises(RuntimeError, match="cardinality"):
        await service._cache_trip_indexes(trip_meta, stop_patterns, shape_geometries)

    assert await cache.get_json(_KEY_TRIP_INDEX_ACTIVE) is None
    assert await cache.get_json(legacy_key) == {"trip_id": "keep-me"}


@pytest.mark.asyncio
async def test_trip_index_rollover_never_keeps_three_generations(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = GTFSService(settings=settings, cache=cache)
    trip_meta, stop_patterns, shape_geometries = _build_indexes(service)

    await service._cache_trip_indexes(trip_meta, stop_patterns, shape_geometries)
    first = await cache.get_json(_KEY_TRIP_INDEX_ACTIVE)
    await service._cache_trip_indexes(trip_meta, stop_patterns, shape_geometries)
    second = await cache.get_json(_KEY_TRIP_INDEX_ACTIVE)

    first_meta_key = service._trip_index_key(first["generation"], "meta")
    assert 0 < await cache.client.ttl(first_meta_key) <= settings.CACHE_TTL_GTFS_SHAPES

    await service._cache_trip_indexes(trip_meta, stop_patterns, shape_geometries)
    third = await cache.get_json(_KEY_TRIP_INDEX_ACTIVE)
    second_meta_key = service._trip_index_key(second["generation"], "meta")

    assert len({first["generation"], second["generation"], third["generation"]}) == 3
    assert await cache.exists(first_meta_key) is False
    assert 0 < await cache.client.ttl(second_meta_key) <= settings.CACHE_TTL_GTFS_SHAPES


@pytest.mark.asyncio
async def test_hash_writes_and_unlink_cleanup_use_bounded_batches(
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    batch_sizes: list[int] = []
    original_write = cache._write_hash_batch

    async def recording_write(
        key: str,
        batch: list[tuple[str, bytes]],
        initial_ttl: int | None = None,
    ) -> None:
        batch_sizes.append(len(batch))
        await original_write(key, batch, initial_ttl=initial_ttl)

    monkeypatch.setattr(cache, "_write_hash_batch", recording_write)
    mapping = {f"field-{index}": {"index": index} for index in range(7)}

    written = await cache.hset_json_batched(
        "hash:bounded",
        mapping,
        ttl=60,
        batch_size=3,
        max_batch_bytes=1024,
    )

    assert written == 7
    assert batch_sizes == [3, 3, 1]
    assert await cache.hget_json("hash:bounded", "field-4") == {"index": 4}
    assert await cache.exists("hash:bounded") is True

    for index in range(7):
        await cache.set_json(f"legacy:trip:{index}", {"index": index}, ttl=60)
    removed = await cache.unlink_pattern("legacy:trip:*", batch_size=2)
    assert removed == 7
    assert await cache.exists("legacy:trip:0") is False


@pytest.mark.asyncio
async def test_partial_hash_generation_has_ttl_if_a_later_batch_fails(
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_write = cache._write_hash_batch
    calls = 0

    async def fail_second_batch(
        key: str,
        batch: list[tuple[str, bytes]],
        initial_ttl: int | None = None,
    ) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise ConnectionError("simulated disconnect")
        await original_write(key, batch, initial_ttl=initial_ttl)

    monkeypatch.setattr(cache, "_write_hash_batch", fail_second_batch)

    with pytest.raises(ConnectionError, match="simulated"):
        await cache.hset_json_batched(
            "hash:partial",
            {f"field-{index}": {"index": index} for index in range(5)},
            ttl=60,
            batch_size=2,
        )

    assert await cache.hash_length("hash:partial") == 2
    assert 0 < await cache.client.ttl("hash:partial") <= 60


@pytest.mark.asyncio
async def test_v2_upcoming_query_reads_only_requested_schedule_hash_fields(
    settings: Settings,
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GTFSService(settings=settings, cache=cache)
    await cache.set_json(
        _KEY_ROUTES,
        [{"route_id": "route-1", "route_ids": ["route-1"]}],
        ttl=60,
    )
    trips = {
        ("route-1", 0): [
            {
                "trip_id": "special-trip",
                "route_id": "route-1",
                "service_id": "special-service",
                "departure_time": "09:00:00",
            }
        ]
    }
    calendar = [
        {
            "service_id": "special-service",
            "monday": 0,
            "tuesday": 0,
            "wednesday": 0,
            "thursday": 0,
            "friday": 0,
            "saturday": 0,
            "sunday": 0,
            "start_date": "20260101",
            "end_date": "20261231",
        }
    ]
    exceptions = {
        "20260105": {"added": ["special-service"], "removed": []},
        "20261231": {"added": ["unused-service"], "removed": []},
    }
    await service._cache_calendar_and_trips(calendar, exceptions, trips)

    requested_string_keys: list[str] = []
    original_get_json = cache.get_json

    async def recording_get_json(key: str) -> Any:
        requested_string_keys.append(key)
        return await original_get_json(key)

    monkeypatch.setattr(cache, "get_json", recording_get_json)
    result = await service.get_upcoming_trips(
        "route-1",
        direction_id=0,
        date_str="20260105",
        time_str="08:00:00",
    )

    assert [trip["trip_id"] for trip in result] == ["special-trip"]
    assert _KEY_CALENDAR not in requested_string_keys
    assert _KEY_CALENDAR_DATES not in requested_string_keys
    assert not any(key.startswith(_KEY_TRIPS_PREFIX) for key in requested_string_keys)


@pytest.mark.asyncio
async def test_trip_lookup_falls_back_to_retained_previous_generation(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = GTFSService(settings=settings, cache=cache)
    trip_meta, stop_patterns, shape_geometries = _build_indexes(service)
    previous_generation = "a" * 32
    current_generation = "b" * 32
    await cache.hset_json_batched(
        service._trip_index_key(previous_generation, "meta"),
        trip_meta,
        ttl=60,
    )
    await cache.hset_json_batched(
        service._trip_index_key(previous_generation, "stops"),
        stop_patterns,
        ttl=60,
    )
    await cache.hset_json_batched(
        service._trip_index_key(previous_generation, "shapes"),
        shape_geometries,
        ttl=60,
    )
    await cache.set_json(
        _KEY_TRIP_INDEX_ACTIVE,
        {
            "version": 2,
            "generation": current_generation,
            "previous_generation": previous_generation,
            "last_updated": "new",
        },
        ttl=60,
    )
    await cache.set_json(
        _KEY_ROUTES,
        [{"route_id": "route-1", "route_ids": ["route-1"]}],
        ttl=60,
    )

    shape = await service.get_route_shape("route-1", trip_id="trip-out")
    stops = await service.get_route_stops("route-1", trip_id="trip-out")

    assert shape is not None and shape.trip_id == "trip-out"
    assert stops is not None and stops["trip_id"] == "trip-out"


@pytest.mark.asyncio
async def test_complete_cache_and_refresh_deadline_require_both_v2_manifests(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = GTFSService(settings=settings, cache=cache)
    await cache.set_json(_KEY_ROUTES, [{"route_id": "route-1"}], ttl=120)
    assert await service.has_complete_cache() is False

    snapshot_id = "b" * 32
    trip_manifest = {
        "version": 2,
        "generation": "a" * 32,
        "snapshot_id": snapshot_id,
        "last_updated": "now",
    }
    schedule_manifest = {
        **trip_manifest,
        "trip_generation": trip_manifest["generation"],
        "component_counts": {"calendar": 0, "exceptions": 0, "trips": 0},
    }
    snapshot = {
        "version": 2,
        "snapshot_id": snapshot_id,
        "trip_generation": trip_manifest["generation"],
        "schedule_generation": schedule_manifest["generation"],
        "last_updated": "now",
    }
    await cache.set_json(_KEY_TRIP_INDEX_ACTIVE, trip_manifest, ttl=120)
    await cache.set_json(_KEY_SCHEDULE_INDEX_ACTIVE, schedule_manifest, ttl=120)
    await cache.set_json(_KEY_SNAPSHOT_ACTIVE, snapshot, ttl=120)
    for component in ("meta", "stops", "shapes"):
        await cache.hset_json_batched(
            service._trip_index_key(trip_manifest["generation"], component),
            {"value": {}},
            ttl=120,
        )

    assert await service.has_complete_cache() is True
    assert 50 <= await service.seconds_until_refresh() <= 60

    mismatched = {**snapshot, "schedule_generation": "c" * 32}
    await cache.set_json(_KEY_SNAPSHOT_ACTIVE, mismatched, ttl=120)
    assert await service.has_complete_cache() is False


@pytest.mark.asyncio
async def test_retry_keeps_trip_generation_referenced_by_active_schedule(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = GTFSService(settings=settings, cache=cache)
    trip_meta, stop_patterns, shape_geometries = _build_indexes(service)

    first = await service._cache_trip_indexes(trip_meta, stop_patterns, shape_geometries)
    await service._cache_calendar_and_trips(
        [],
        {"20260105": {"added": ["weekday"], "removed": []}},
        {
            ("route-1", 0): [
                {
                    "trip_id": "trip-out",
                    "route_id": "route-1",
                    "service_id": "weekday",
                    "departure_time": "08:00:00",
                }
            ]
        },
        trip_generation=first["generation"],
    )
    await service._cache_trip_indexes(trip_meta, stop_patterns, shape_geometries)
    await service._cache_trip_indexes(trip_meta, stop_patterns, shape_geometries)

    first_meta_key = service._trip_index_key(first["generation"], "meta")
    assert await cache.exists(first_meta_key) is True


@pytest.mark.asyncio
async def test_gtfs_parsing_does_not_block_the_event_loop(
    settings: Settings,
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = GTFSService(settings=settings, cache=cache)

    async def download() -> bytes:
        return b"archive"

    def prepare(_archive: bytes) -> tuple:
        time.sleep(0.1)
        return ([], [], {}, {}, {}, {"trip": {}}, {"stops": {}}, {"shape": {}}, [], {}, {})

    monkeypatch.setattr(service, "_download_gtfs_zip", download)
    monkeypatch.setattr(service, "_prepare_gtfs_snapshot", prepare)
    monkeypatch.setattr(service, "_cache_shapes", AsyncMock())
    monkeypatch.setattr(service, "_cache_stops", AsyncMock())
    monkeypatch.setattr(service, "_cache_route_proximity_index", AsyncMock())
    monkeypatch.setattr(
        service,
        "_cache_trip_indexes",
        AsyncMock(return_value={"generation": "a" * 32}),
    )
    monkeypatch.setattr(
        service,
        "_cache_calendar_and_trips",
        AsyncMock(return_value={"generation": "b" * 32}),
    )
    monkeypatch.setattr(service, "_cleanup_legacy_trip_indexes", AsyncMock())

    started = asyncio.get_running_loop().time()
    refresh = asyncio.create_task(service.load_and_cache_shapes())
    await asyncio.sleep(0.02)
    elapsed = asyncio.get_running_loop().time() - started

    assert elapsed < 0.08
    assert not refresh.done()
    assert await refresh == 0


@pytest.mark.asyncio
async def test_upcoming_query_falls_back_to_small_legacy_schedule(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = GTFSService(settings=settings, cache=cache)
    await cache.set_json(
        _KEY_ROUTES,
        [{"route_id": "route-1", "route_ids": ["route-1"]}],
        ttl=60,
    )
    await cache.set_json(
        "gtfs:trips:route:route-1:0",
        [
            {
                "trip_id": "legacy-scheduled-trip",
                "route_id": "route-1",
                "service_id": "legacy-service",
                "departure_time": "09:00:00",
            }
        ],
        ttl=60,
    )
    await cache.set_json(
        _KEY_CALENDAR,
        [
            {
                "service_id": "legacy-service",
                "monday": 0,
                "start_date": "20260101",
                "end_date": "20261231",
            }
        ],
        ttl=60,
    )
    await cache.set_json(
        _KEY_CALENDAR_DATES,
        [
            {
                "service_id": "legacy-service",
                "date": "20260105",
                "exception_type": 1,
            }
        ],
        ttl=60,
    )

    result = await service.get_upcoming_trips(
        "route-1",
        direction_id=0,
        date_str="20260105",
        time_str="08:00:00",
    )

    assert [trip["trip_id"] for trip in result] == ["legacy-scheduled-trip"]


def test_calendar_dates_are_grouped_compactly_with_last_row_winning() -> None:
    parsed = GTFSService._parse_calendar_dates(
        "service_id,date,exception_type\n"
        "weekday,20260105,1\n"
        "weekend,20260105,2\n"
        "weekday,20260105,2\n"
        "special,20260106,1\n"
    )

    assert parsed == {
        "20260105": {"added": [], "removed": ["weekday", "weekend"]},
        "20260106": {"added": ["special"], "removed": []},
    }


@pytest.mark.asyncio
async def test_gtfs_client_ignores_process_proxy_environment(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = GTFSService(
        settings.model_copy(
            update={"ATM_GTFS_URL": "https://t-mobilitat.atm.cat/opendata/static/download/"}
        ),
        cache,
    )

    await service.start()
    try:
        assert service.http._trust_env is False
    finally:
        await service.close()
