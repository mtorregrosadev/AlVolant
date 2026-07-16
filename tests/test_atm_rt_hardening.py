"""Security, freshness and resource-boundary tests for ATM realtime feeds."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.transit import gtfs_realtime_pb2

import app.services.atm_rt_service as atm_module
from app.api.v1.atm_rt import router as atm_router
from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.core.exceptions import ExternalAPIError, GTFSParseError
from app.models.atm_rt import (
    AffectedEntity,
    ATMRealtimeFeed,
    ServiceAlert,
    TripUpdate,
    VehiclePosition,
)
from app.services.atm_rt_service import ATMRTService

_TRIP_URL = "https://t-mobilitat.atm.cat/opendata/trip_updates/user/token/open"


def _settings(settings: Settings, **updates: object) -> Settings:
    return settings.model_copy(update={
        "ATM_RT_TRIP_UPDATES_URL": _TRIP_URL,
        "ATM_RT_VEHICLE_POSITIONS_URL": (
            "https://t-mobilitat.atm.cat/opendata/vehicle_positions/user/token/open"
        ),
        "ATM_RT_ALERTS_URL": "https://t-mobilitat.atm.cat/opendata/alerts/user/token/open",
        "OUTBOUND_ALLOWED_HOSTS": "t-mobilitat.atm.cat,t-mobilitat.cat,api.tomtom.com",
        "CACHE_TTL_ATM_REALTIME": 180,
        "ATM_RT_FRESHNESS_SECONDS": 90,
        **updates,
    })


def _provider_timestamp(offset_seconds: int = 0) -> int:
    return int(datetime.now(tz=UTC).timestamp()) + offset_seconds


def _set_header(
    feed: gtfs_realtime_pb2.FeedMessage,
    *,
    timestamp: int | None = None,
    incrementality: int = gtfs_realtime_pb2.FeedHeader.FULL_DATASET,
) -> None:
    feed.header.gtfs_realtime_version = "2.0"
    feed.header.timestamp = timestamp if timestamp is not None else _provider_timestamp()
    feed.header.incrementality = incrementality


def _trip_feed(*, timestamp: int | None = None, trip_id: str = "trip-1") -> bytes:
    feed = gtfs_realtime_pb2.FeedMessage()
    _set_header(feed, timestamp=timestamp)
    update = feed.entity.add()
    update.id = "trip-entity"
    update.trip_update.trip.trip_id = trip_id
    update.trip_update.trip.route_id = "route-1"
    return feed.SerializeToString()


def _vehicle_feed(*, timestamp: int | None = None, vehicle_id: str = "vehicle-1") -> bytes:
    feed = gtfs_realtime_pb2.FeedMessage()
    _set_header(feed, timestamp=timestamp)
    entity = feed.entity.add(id="vehicle-entity")
    entity.vehicle.vehicle.id = vehicle_id
    entity.vehicle.trip.trip_id = "trip-1"
    entity.vehicle.trip.route_id = "route-1"
    entity.vehicle.position.latitude = 41.45
    entity.vehicle.position.longitude = 2.25
    return feed.SerializeToString()


def _alert_feed(*, timestamp: int | None = None) -> bytes:
    feed = gtfs_realtime_pb2.FeedMessage()
    _set_header(feed, timestamp=timestamp)
    alert = feed.entity.add()
    alert.id = "alert-1"
    alert.alert.header_text.translation.add(text="Avís", language="ca")
    return feed.SerializeToString()


def test_alert_parser_preserves_route_direction_selector(
    settings: Settings,
    cache: CacheManager,
) -> None:
    feed = gtfs_realtime_pb2.FeedMessage()
    _set_header(feed)
    entity = feed.entity.add(id="alert-direction")
    entity.alert.header_text.translation.add(text="Detour", language="en")
    entity.alert.header_text.translation.add(text="Desviament puntual", language="cat")
    selector = entity.alert.informed_entity.add()
    selector.route_id = "AMB_148"
    selector.direction_id = 1
    selector.stop_id = "AMB_12345"

    result = ATMRTService(_settings(settings), cache)._parse_protobuf(
        feed.SerializeToString(),
        ATMRealtimeFeed(),
    )

    assert result.service_alerts[0].affected_entities == [
        AffectedEntity(
            route_id="AMB_148",
            direction_id=1,
            stop_id="AMB_12345",
        )
    ]
    assert result.service_alerts[0].header_text == "Desviament puntual"


@pytest.mark.asyncio
async def test_route_alerts_are_fresh_and_respect_the_selected_direction(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = ATMRTService(_settings(settings), cache)
    alerts = [
        ServiceAlert(
            alert_id="one-way",
            header_text="Afecta només l'anada",
            affected_route_ids=["AMB_148"],
            affected_entities=[AffectedEntity(route_id="AMB_148", direction_id=1)],
        ),
        ServiceAlert(
            alert_id="both-ways",
            header_text="Afecta tota la línia",
            affected_route_ids=["AMB_148"],
            affected_entities=[AffectedEntity(route_id="AMB_148")],
        ),
        ServiceAlert(
            alert_id="other-route",
            header_text="Una altra línia",
            affected_route_ids=["AMB_415"],
            affected_entities=[AffectedEntity(route_id="AMB_415", direction_id=1)],
        ),
    ]
    await service._cache_feed(
        ATMRealtimeFeed(service_alerts=alerts, entity_count=len(alerts)),
        {"alerts"},
        provider_timestamps={"alerts": _provider_timestamp()},
    )

    outbound = await service.get_cached_alerts_for_route("AMB_148", direction_id=1)
    inbound = await service.get_cached_alerts_for_route("AMB_148", direction_id=0)

    assert [alert.alert_id for alert in outbound] == ["both-ways", "one-way"]
    assert [alert.alert_id for alert in inbound] == ["both-ways"]


@pytest.mark.asyncio
async def test_realtime_redirect_is_followed_only_across_official_origins(
    settings: Settings,
    cache: CacheManager,
) -> None:
    requests: list[httpx.Request] = []
    expected_payload = _trip_feed()

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.host == "t-mobilitat.atm.cat":
            return httpx.Response(
                301,
                headers={"Location": "https://t-mobilitat.cat/opendata/trip_updates/user/token/open"},
            )
        return httpx.Response(200, content=expected_payload)

    service = ATMRTService(_settings(settings), cache)
    service._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        payload = await service._fetch_feed(_TRIP_URL, "TripUpdates")
    finally:
        await service._http.aclose()

    assert payload == expected_payload
    assert [request.url.host for request in requests] == [
        "t-mobilitat.atm.cat",
        "t-mobilitat.cat",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "location",
    [
        "https://evil.invalid/opendata/feed.pb",
        "https://mant.t-mobilitat.cat/opendata/feed.pb",
        "http://t-mobilitat.cat/opendata/feed.pb",
    ],
)
async def test_realtime_redirect_rejects_unsafe_targets(
    settings: Settings,
    cache: CacheManager,
    location: str,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(302, headers={"Location": location})

    service = ATMRTService(_settings(settings), cache)
    service._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ExternalAPIError, match="Unsafe endpoint"):
            await service._fetch_feed(_TRIP_URL, "TripUpdates")
    finally:
        await service._http.aclose()

    assert len(requests) == 1
    assert location not in str(requests[0].headers)


@pytest.mark.asyncio
async def test_partial_refresh_preserves_failed_last_good_component(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = ATMRTService(_settings(settings), cache)
    old_vehicle = VehiclePosition(
        vehicle_id="vehicle-old",
        route_id="route-1",
        trip_id="trip-1",
        latitude=41.45,
        longitude=2.25,
    )
    await service._cache_feed(
        ATMRealtimeFeed(vehicle_positions=[old_vehicle], entity_count=1),
        {"vehicle_positions"},
        provider_timestamps={"vehicle_positions": _provider_timestamp(-5)},
    )
    service._fetch_feed = AsyncMock(side_effect=[
        _trip_feed(),
        ExternalAPIError("ATM", "vehicles unavailable"),
        _alert_feed(),
    ])

    result = await service.fetch_and_parse_all()
    vehicles = await service.get_cached_vehicles_for_route("route-1")
    freshness = await service.get_component_freshness()

    assert [vehicle.vehicle_id for vehicle in vehicles] == ["vehicle-old"]
    assert [trip.trip_id for trip in result.trip_updates] == ["trip-1"]
    assert [alert.alert_id for alert in result.service_alerts] == ["alert-1"]
    assert freshness == {
        "trip_updates": True,
        "vehicle_positions": True,
        "alerts": True,
    }


@pytest.mark.asyncio
async def test_total_provider_failure_does_not_overwrite_cache(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = ATMRTService(_settings(settings), cache)
    old_vehicle = VehiclePosition(
        vehicle_id="vehicle-old",
        route_id="route-1",
        latitude=41.45,
        longitude=2.25,
    )
    await service._cache_feed(
        ATMRealtimeFeed(vehicle_positions=[old_vehicle], entity_count=1),
        {"vehicle_positions"},
        provider_timestamps={"vehicle_positions": _provider_timestamp(-5)},
    )
    service._fetch_feed = AsyncMock(side_effect=ExternalAPIError("ATM", "unavailable"))

    with pytest.raises(ExternalAPIError, match="All realtime feeds"):
        await service.fetch_and_parse_all()

    assert [
        vehicle.vehicle_id for vehicle in await service.get_cached_vehicles_for_route("route-1")
    ] == ["vehicle-old"]


@pytest.mark.asyncio
async def test_component_freshness_expires_independently(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = ATMRTService(_settings(settings, ATM_RT_FRESHNESS_SECONDS=30), cache)
    await cache.set(
        "atm_rt:meta:provider_timestamp:vehicle_positions",
        str(_provider_timestamp(-31)),
        ttl=180,
    )

    freshness = await service.get_component_freshness()

    assert freshness["vehicle_positions"] is False
    assert freshness["trip_updates"] is False


def test_protobuf_entity_limit_is_enforced(
    settings: Settings,
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(atm_module, "_MAX_PROTOBUF_ENTITIES", 1)
    feed = gtfs_realtime_pb2.FeedMessage()
    _set_header(feed)
    feed.entity.add(id="one")
    feed.entity.add(id="two")
    service = ATMRTService(_settings(settings), cache)

    with pytest.raises(GTFSParseError, match="entity limit"):
        service._parse_protobuf(feed.SerializeToString(), ATMRealtimeFeed())


@pytest.mark.asyncio
async def test_provider_response_is_rejected_above_four_mib(
    settings: Settings,
    cache: CacheManager,
) -> None:
    assert atm_module._MAX_RESPONSE_BYTES == 4 * 1024 * 1024

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"x",
            headers={"content-length": str(atm_module._MAX_RESPONSE_BYTES + 1)},
            request=request,
        )

    service = ATMRTService(_settings(settings), cache)
    service._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ExternalAPIError, match="size limit"):
            await service._fetch_feed(_TRIP_URL, "TripUpdates")
    finally:
        await service._http.aclose()


def test_global_stop_update_budget_precedes_model_creation(
    settings: Settings,
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(atm_module, "_MAX_TOTAL_STOP_UPDATES", 2)
    feed = gtfs_realtime_pb2.FeedMessage()
    _set_header(feed)
    for entity_number in range(2):
        update = feed.entity.add(id=f"trip-{entity_number}").trip_update
        update.trip.trip_id = f"trip-{entity_number}"
        for stop_number in range(2):
            update.stop_time_update.add(stop_id=f"stop-{stop_number}")

    service = ATMRTService(_settings(settings), cache)
    model_trip = Mock(side_effect=AssertionError("model creation must not run"))
    monkeypatch.setattr(service, "_parse_trip_update", model_trip)

    with pytest.raises(GTFSParseError, match="stop-time update budget"):
        service._parse_protobuf(feed.SerializeToString(), ATMRealtimeFeed())
    model_trip.assert_not_called()


def test_global_alert_selector_budget_precedes_model_creation(
    settings: Settings,
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(atm_module, "_MAX_TOTAL_ALERT_SELECTORS", 2)
    feed = gtfs_realtime_pb2.FeedMessage()
    _set_header(feed)
    for entity_number in range(2):
        alert = feed.entity.add(id=f"alert-{entity_number}").alert
        for selector_number in range(2):
            alert.informed_entity.add(route_id=f"route-{selector_number}")

    service = ATMRTService(_settings(settings), cache)
    model_alert = Mock(side_effect=AssertionError("model creation must not run"))
    monkeypatch.setattr(service, "_parse_alert", model_alert)

    with pytest.raises(GTFSParseError, match="alert selector budget"):
        service._parse_protobuf(feed.SerializeToString(), ATMRealtimeFeed())
    model_alert.assert_not_called()


@pytest.mark.asyncio
async def test_corrupt_component_is_isolated_and_keeps_last_good_snapshot(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = ATMRTService(_settings(settings), cache)
    old_timestamp = _provider_timestamp(-5)
    old_trip = TripUpdate(trip_id="trip-old", route_id="route-1")
    await service._cache_feed(
        ATMRealtimeFeed(trip_updates=[old_trip], entity_count=1),
        {"trip_updates"},
        provider_timestamps={"trip_updates": old_timestamp},
    )
    service._fetch_feed = AsyncMock(
        side_effect=[
            b"\x80",
            _vehicle_feed(vehicle_id="vehicle-new"),
            _alert_feed(),
        ]
    )

    result = await service.fetch_and_parse_all()

    assert [trip.trip_id for trip in result.trip_updates] == ["trip-old"]
    assert [vehicle.vehicle_id for vehicle in result.vehicle_positions] == ["vehicle-new"]
    assert [alert.alert_id for alert in result.service_alerts] == ["alert-1"]
    assert [
        trip.trip_id for trip in await service.get_cached_trips_for_route("route-1")
    ] == ["trip-old"]
    assert await cache.get("atm_rt:meta:provider_timestamp:trip_updates") == str(
        old_timestamp
    ).encode()


@pytest.mark.asyncio
async def test_stale_component_does_not_overwrite_last_good_snapshot(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = ATMRTService(_settings(settings, ATM_RT_FRESHNESS_SECONDS=30), cache)
    old_timestamp = _provider_timestamp(-5)
    old_vehicle = VehiclePosition(
        vehicle_id="vehicle-old",
        route_id="route-1",
        latitude=41.45,
        longitude=2.25,
    )
    await service._cache_feed(
        ATMRealtimeFeed(vehicle_positions=[old_vehicle], entity_count=1),
        {"vehicle_positions"},
        provider_timestamps={"vehicle_positions": old_timestamp},
    )
    service._fetch_feed = AsyncMock(
        side_effect=[
            ExternalAPIError("ATM", "trips unavailable"),
            _vehicle_feed(timestamp=_provider_timestamp(-31), vehicle_id="vehicle-stale"),
            _alert_feed(),
        ]
    )

    result = await service.fetch_and_parse_all()

    assert [vehicle.vehicle_id for vehicle in result.vehicle_positions] == ["vehicle-old"]
    assert [
        vehicle.vehicle_id
        for vehicle in await service.get_cached_vehicles_for_route("route-1")
    ] == ["vehicle-old"]
    assert await cache.get("atm_rt:meta:provider_timestamp:vehicle_positions") == str(
        old_timestamp
    ).encode()


@pytest.mark.asyncio
async def test_provider_marker_is_published_after_snapshot_and_route_index(
    settings: Settings,
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ATMRTService(_settings(settings), cache)
    vehicle = VehiclePosition(
        vehicle_id="vehicle-1",
        route_id="route-1",
        latitude=41.45,
        longitude=2.25,
    )
    calls = Mock()
    mset_spy = AsyncMock(wraps=cache.mset_json)
    set_spy = AsyncMock(wraps=cache.set)
    calls.attach_mock(mset_spy, "mset")
    calls.attach_mock(set_spy, "set")
    monkeypatch.setattr(cache, "mset_json", mset_spy)
    monkeypatch.setattr(cache, "set", set_spy)

    await service._cache_feed(
        ATMRealtimeFeed(vehicle_positions=[vehicle], entity_count=1),
        {"vehicle_positions"},
        provider_timestamps={"vehicle_positions": _provider_timestamp()},
    )

    snapshot_call = next(
        index
        for index, call in enumerate(calls.mock_calls)
        if call[0] == "mset" and "atm_rt:vehicles:all" in call.args[0]
    )
    route_index_call = next(
        index
        for index, call in enumerate(calls.mock_calls)
        if call[0] == "mset" and "atm_rt:vehicles:route_ids" in call.args[0]
    )
    provider_marker_call = next(
        index
        for index, call in enumerate(calls.mock_calls)
        if call[0] == "set"
        and call.args[0] == "atm_rt:meta:provider_timestamp:vehicle_positions"
    )
    assert snapshot_call < route_index_call < provider_marker_call


def test_differential_feed_is_rejected_before_model_creation(
    settings: Settings,
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    feed = gtfs_realtime_pb2.FeedMessage()
    _set_header(feed, incrementality=gtfs_realtime_pb2.FeedHeader.DIFFERENTIAL)
    entity = feed.entity.add(id="trip")
    entity.trip_update.trip.trip_id = "trip-1"
    service = ATMRTService(_settings(settings), cache)
    model_trip = Mock(side_effect=AssertionError("model creation must not run"))
    monkeypatch.setattr(service, "_parse_trip_update", model_trip)

    with pytest.raises(GTFSParseError, match="Differential"):
        service._parse_protobuf(feed.SerializeToString(), ATMRealtimeFeed())
    model_trip.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("offset", "message"),
    [
        (-31, "stale"),
        (31, "future"),
    ],
)
async def test_invalid_provider_time_is_rejected_before_model_creation(
    settings: Settings,
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
    offset: int,
    message: str,
) -> None:
    service = ATMRTService(_settings(settings, ATM_RT_FRESHNESS_SECONDS=30), cache)
    model_feed = Mock(side_effect=AssertionError("model creation must not run"))
    monkeypatch.setattr(service, "_model_feed_message", model_feed)

    with pytest.raises(GTFSParseError, match=message):
        await service._parse_component_payload(
            _trip_feed(timestamp=_provider_timestamp(offset)),
            "trip_updates",
        )
    model_feed.assert_not_called()


@pytest.mark.asyncio
async def test_equal_provider_timestamp_is_a_cache_noop(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = ATMRTService(_settings(settings), cache)
    timestamp = _provider_timestamp()
    old_trip = TripUpdate(trip_id="trip-old", route_id="route-1")
    await service._cache_feed(
        ATMRealtimeFeed(trip_updates=[old_trip], entity_count=1),
        {"trip_updates"},
        provider_timestamps={"trip_updates": timestamp},
    )
    service._fetch_feed = AsyncMock(
        side_effect=[
            _trip_feed(timestamp=timestamp, trip_id="trip-replayed"),
            ExternalAPIError("ATM", "vehicles unavailable"),
            ExternalAPIError("ATM", "alerts unavailable"),
        ]
    )
    service._cache_feed = AsyncMock()

    result = await service.fetch_and_parse_all()

    assert [trip.trip_id for trip in result.trip_updates] == ["trip-old"]
    service._cache_feed.assert_not_awaited()
    assert await cache.get("atm_rt:meta:provider_timestamp:trip_updates") == str(
        timestamp
    ).encode()


@pytest.mark.asyncio
async def test_older_provider_timestamp_is_rejected_as_replay(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = ATMRTService(_settings(settings), cache)
    timestamp = _provider_timestamp()
    await cache.set(
        "atm_rt:meta:provider_timestamp:trip_updates",
        str(timestamp),
        ttl=180,
    )

    with pytest.raises(GTFSParseError, match="did not advance"):
        await service._parse_component_payload(
            _trip_feed(timestamp=timestamp - 1),
            "trip_updates",
        )


@pytest.mark.asyncio
async def test_provider_time_controls_live_route_visibility(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = ATMRTService(_settings(settings, ATM_RT_FRESHNESS_SECONDS=30), cache)
    vehicle = VehiclePosition(
        vehicle_id="vehicle-old",
        route_id="route-1",
        latitude=41.45,
        longitude=2.25,
    )
    await service._cache_feed(
        ATMRealtimeFeed(vehicle_positions=[vehicle], entity_count=1),
        {"vehicle_positions"},
        provider_timestamps={"vehicle_positions": _provider_timestamp(-31)},
    )

    assert await service.get_cached_vehicles_for_route("route-1") == []
    assert (await service.get_component_freshness())["vehicle_positions"] is False

    await cache.set(
        "atm_rt:meta:provider_timestamp:vehicle_positions",
        str(_provider_timestamp(1)),
        ttl=180,
    )
    assert await service.get_cached_vehicles_for_route("route-1") == []


@pytest.mark.asyncio
async def test_v2_route_marker_skips_global_blob_for_absent_route(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = ATMRTService(_settings(settings), cache)
    timestamp = _provider_timestamp()
    for component in ("vehicle_positions", "trip_updates"):
        await cache.set(
            f"atm_rt:meta:provider_timestamp:{component}",
            str(timestamp),
            ttl=180,
        )
    await cache.set_json(
        "atm_rt:vehicles:route_ids",
        {"version": 2, "route_ids": ["route-known"]},
        ttl=180,
    )
    await cache.set_json(
        "atm_rt:trips:route_ids",
        {"version": 2, "route_ids": ["route-known"]},
        ttl=180,
    )
    service.get_cached_vehicles = AsyncMock(side_effect=AssertionError("global blob read"))
    service.get_cached_trips = AsyncMock(side_effect=AssertionError("global blob read"))

    assert await service.get_cached_vehicles_for_route("route-absent") == []
    assert await service.get_cached_trips_for_route("route-absent") == []
    service.get_cached_vehicles.assert_not_awaited()
    service.get_cached_trips.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_v2_marker_uses_global_blob_only_for_migration(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = ATMRTService(_settings(settings), cache)
    vehicle = VehiclePosition(
        vehicle_id="vehicle-legacy",
        route_id="route-legacy",
        latitude=41.45,
        longitude=2.25,
    )
    await cache.set_json(
        "atm_rt:vehicles:all",
        [vehicle.model_dump(mode="json")],
        ttl=180,
    )
    await cache.set(
        "atm_rt:meta:provider_timestamp:vehicle_positions",
        str(_provider_timestamp()),
        ttl=180,
    )

    vehicles = await service.get_cached_vehicles_for_route("route-legacy")

    assert [item.vehicle_id for item in vehicles] == ["vehicle-legacy"]


def test_bulk_realtime_endpoints_are_not_exposed_and_route_ids_are_bounded() -> None:
    app = FastAPI()
    app.state.api_key = "test-api-key"
    app.state.atm_rt_service = SimpleNamespace(
        get_cached_vehicles_for_route=AsyncMock(return_value=[]),
        get_cached_trips_for_route=AsyncMock(return_value=[]),
    )
    app.include_router(atm_router, prefix="/api/v1")
    headers = {"X-API-Key": "test-api-key"}

    with TestClient(app) as client:
        for path in ("realtime", "vehicles", "trips", "alerts"):
            assert client.get(f"/api/v1/atm_rt/{path}", headers=headers).status_code == 404
        assert client.get(
            f"/api/v1/atm_rt/vehicles/{'x' * 129}",
            headers=headers,
        ).status_code == 422


def test_route_alert_endpoint_is_bounded_and_passes_direction_to_realtime_service() -> None:
    alert = ServiceAlert(
        alert_id="closure",
        header_text="Servei interromput",
        effect="NO_SERVICE",
        affected_route_ids=["AMB_148"],
    )
    service = SimpleNamespace(get_cached_alerts_for_route=AsyncMock(return_value=[alert]))
    app = FastAPI()
    app.state.api_key = "test-api-key"
    app.state.atm_rt_service = service
    app.include_router(atm_router, prefix="/api/v1")

    with TestClient(app) as client:
        response = client.get(
            "/api/v1/atm_rt/alerts/AMB_148",
            params={"direction_id": 1},
            headers={"X-API-Key": "test-api-key"},
        )
        invalid = client.get(
            "/api/v1/atm_rt/alerts/AMB_148",
            params={"direction_id": 2},
            headers={"X-API-Key": "test-api-key"},
        )

    assert response.status_code == 200
    assert response.json()[0]["alert_id"] == "closure"
    assert invalid.status_code == 422
    service.get_cached_alerts_for_route.assert_awaited_once_with("AMB_148", 1)
