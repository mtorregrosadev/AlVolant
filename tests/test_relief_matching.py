"""Realtime-to-stop matching for driver relief handovers."""

from __future__ import annotations

from collections.abc import Mapping
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.transit import gtfs_realtime_pb2

from app.api.v1.atm_rt import router as atm_router
from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.models.atm_rt import (
    ReliefCandidate,
    ReliefConfidence,
    ReliefPhase,
    StopTimeUpdate,
    TripUpdate,
    VehiclePosition,
    VehicleStopStatus,
)
from app.models.gtfs import RouteShape
from app.services.atm_rt_service import ATMRTService
from app.services.relief_matching_service import ReliefMatchingService

_NOW = 1_800_000_000
_ROUTE_A = "route-a"
_ROUTE_B = "route-b"
_STOP_ID = "stop-relief"
_STOP_SEQUENCE = 5
_STOP_LONGITUDE = 2.005
_STOP_LATITUDE = 41.0
_HEADERS = {"X-API-Key": "test-api-key"}


def _stop_collection(
    *,
    direction_id: int = 1,
    trip_id: str = "trip-1",
    include_stop: bool = True,
) -> dict:
    features = []
    if include_stop:
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "route_id": _ROUTE_B,
                    "direction_id": direction_id,
                    "trip_id": trip_id,
                    "stop_id": _STOP_ID,
                    "stop_sequence": _STOP_SEQUENCE,
                    "stop_name": "Parada del relleu",
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [_STOP_LONGITUDE, _STOP_LATITUDE],
                },
            }
        )
    return {
        "type": "FeatureCollection",
        "features": features,
        "route_id": _ROUTE_B,
        "direction_id": direction_id,
        "trip_id": trip_id,
        "stop_count": len(features),
    }


def _route_shape(*, direction_id: int = 1, trip_id: str = "trip-1") -> RouteShape:
    return RouteShape(
        route_id=_ROUTE_B,
        shape_id=f"shape-{trip_id}",
        direction_id=direction_id,
        trip_id=trip_id,
        geojson={
            "type": "Feature",
            "properties": {},
            "geometry": {
                "type": "LineString",
                "coordinates": [[2.0, _STOP_LATITUDE], [2.01, _STOP_LATITUDE]],
            },
        },
    )


class _FakeRealtime:
    def __init__(
        self,
        vehicles: Mapping[str, list[VehiclePosition]],
        updates: Mapping[str, list[TripUpdate]] | None = None,
    ) -> None:
        self.vehicles = vehicles
        self.updates = updates or {}
        self.vehicle_reads: list[str] = []
        self.trip_reads: list[str] = []

    async def get_cached_vehicles_for_route(self, route_id: str) -> list[VehiclePosition]:
        self.vehicle_reads.append(route_id)
        return self.vehicles.get(route_id, [])

    async def get_cached_trips_for_route(self, route_id: str) -> list[TripUpdate]:
        self.trip_reads.append(route_id)
        return self.updates.get(route_id, [])


class _FakeGTFS:
    def __init__(
        self,
        *,
        trip_directions: Mapping[str, int],
        include_stop: bool = True,
    ) -> None:
        self.trip_directions = trip_directions
        self.include_stop = include_stop

    async def resolve_group_route_ids(self, route_id: str) -> list[str]:
        assert route_id == _ROUTE_A
        return [_ROUTE_A, _ROUTE_B]

    async def get_trip_meta(self, trip_id: str) -> dict | None:
        direction_id = self.trip_directions.get(trip_id)
        if direction_id is None:
            return None
        return {
            "trip_id": trip_id,
            "route_id": _ROUTE_B,
            "direction_id": direction_id,
        }

    async def get_route_stops(
        self,
        route_id: str,
        direction_id: int | None = None,
        trip_id: str | None = None,
    ) -> dict | None:
        assert route_id == _ROUTE_A
        if trip_id is None:
            return _stop_collection(direction_id=direction_id or 0, include_stop=self.include_stop)
        trip_direction = self.trip_directions.get(trip_id)
        if trip_direction is None:
            return None
        return _stop_collection(
            direction_id=trip_direction,
            trip_id=trip_id,
            include_stop=self.include_stop,
        )

    async def get_route_shape(
        self,
        route_id: str,
        direction_id: int | None = None,
        trip_id: str | None = None,
    ) -> RouteShape | None:
        assert route_id == _ROUTE_A
        assert trip_id is not None
        trip_direction = self.trip_directions.get(trip_id)
        if trip_direction is None:
            return None
        return _route_shape(direction_id=trip_direction, trip_id=trip_id)


def _vehicle(
    vehicle_id: str,
    trip_id: str,
    *,
    direction_id: int | None = 1,
    current_stop_sequence: int | None = _STOP_SEQUENCE,
    stop_id: str = _STOP_ID,
    current_status: VehicleStopStatus | None = VehicleStopStatus.INCOMING_AT,
    longitude: float = 2.004,
    timestamp: int = _NOW,
) -> VehiclePosition:
    return VehiclePosition(
        vehicle_id=vehicle_id,
        route_id=_ROUTE_B,
        trip_id=trip_id,
        direction_id=direction_id,
        latitude=_STOP_LATITUDE,
        longitude=longitude,
        speed=8,
        current_stop_sequence=current_stop_sequence,
        stop_id=stop_id,
        current_status=current_status,
        timestamp=timestamp,
    )


@pytest.mark.asyncio
async def test_parser_preserves_vehicle_progress_and_trip_stop_times(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = ATMRTService(settings, cache)
    vehicle = gtfs_realtime_pb2.VehiclePosition()
    vehicle.vehicle.id = "vehicle-7"
    vehicle.trip.route_id = _ROUTE_B
    vehicle.trip.trip_id = "trip-7"
    vehicle.trip.direction_id = 1
    vehicle.position.latitude = _STOP_LATITUDE
    vehicle.position.longitude = _STOP_LONGITUDE
    vehicle.current_stop_sequence = _STOP_SEQUENCE
    vehicle.stop_id = _STOP_ID
    vehicle.current_status = gtfs_realtime_pb2.VehiclePosition.STOPPED_AT

    parsed_vehicle = service._parse_vehicle(vehicle)

    assert parsed_vehicle is not None
    assert parsed_vehicle.direction_id == 1
    assert parsed_vehicle.current_stop_sequence == _STOP_SEQUENCE
    assert parsed_vehicle.stop_id == _STOP_ID
    assert parsed_vehicle.current_status == VehicleStopStatus.STOPPED_AT

    trip = gtfs_realtime_pb2.TripUpdate()
    trip.trip.trip_id = "trip-7"
    trip.trip.route_id = _ROUTE_B
    trip.trip.direction_id = 1
    trip.vehicle.id = "vehicle-7"
    update = trip.stop_time_update.add(stop_id=_STOP_ID, stop_sequence=_STOP_SEQUENCE)
    update.arrival.delay = 15
    update.arrival.time = _NOW + 60
    update.departure.delay = 20
    update.departure.time = _NOW + 75

    parsed_trip = service._parse_trip_update(trip)

    assert parsed_trip is not None
    assert parsed_trip.direction_id == 1
    assert parsed_trip.stop_time_updates == [
        StopTimeUpdate(
            stop_id=_STOP_ID,
            stop_sequence=_STOP_SEQUENCE,
            arrival_delay=15,
            departure_delay=20,
            arrival_time=_NOW + 60,
            departure_time=_NOW + 75,
        )
    ]


@pytest.mark.asyncio
async def test_parser_does_not_confuse_absent_zero_enums_with_real_values(
    settings: Settings,
    cache: CacheManager,
) -> None:
    service = ATMRTService(settings, cache)
    vehicle = gtfs_realtime_pb2.VehiclePosition()
    vehicle.vehicle.id = "vehicle-8"
    vehicle.trip.route_id = _ROUTE_B
    vehicle.trip.trip_id = "trip-8"
    vehicle.position.latitude = _STOP_LATITUDE
    vehicle.position.longitude = _STOP_LONGITUDE

    parsed = service._parse_vehicle(vehicle)

    assert parsed is not None
    assert parsed.direction_id is None
    assert parsed.current_stop_sequence is None
    assert parsed.stop_id == ""
    assert parsed.current_status is None

    trip = gtfs_realtime_pb2.TripUpdate()
    trip.trip.trip_id = "trip-8"
    trip.trip.route_id = _ROUTE_B
    trip.stop_time_update.add(stop_id=_STOP_ID, stop_sequence=_STOP_SEQUENCE)

    parsed_trip = service._parse_trip_update(trip)

    assert parsed_trip is not None
    assert parsed_trip.stop_time_updates == [
        StopTimeUpdate(
            stop_id=_STOP_ID,
            stop_sequence=_STOP_SEQUENCE,
            arrival_delay=None,
            departure_delay=None,
            arrival_time=None,
            departure_time=None,
        )
    ]


@pytest.mark.asyncio
async def test_matcher_resolves_route_group_and_rejects_the_wrong_direction() -> None:
    correct = _vehicle("vehicle-correct", "trip-correct")
    wrong = _vehicle("vehicle-wrong", "trip-wrong", direction_id=0)
    realtime = _FakeRealtime({_ROUTE_A: [wrong], _ROUTE_B: [correct]})
    gtfs = _FakeGTFS(trip_directions={"trip-correct": 1, "trip-wrong": 0})
    matcher = ReliefMatchingService(realtime, gtfs, freshness_seconds=90, now=lambda: _NOW)

    candidates = await matcher.find_candidates(_ROUTE_A, 1, _STOP_ID)

    assert candidates is not None
    assert [item.vehicle_id for item in candidates] == ["vehicle-correct"]
    assert set(realtime.vehicle_reads) == {_ROUTE_A, _ROUTE_B}
    assert set(realtime.trip_reads) == {_ROUTE_A, _ROUTE_B}


@pytest.mark.parametrize(
    ("vehicle", "expected_phase", "expected_eta", "expected_confidence"),
    [
        (
            _vehicle(
                "vehicle-at-stop",
                "trip-at-stop",
                current_status=VehicleStopStatus.STOPPED_AT,
                longitude=_STOP_LONGITUDE,
            ),
            ReliefPhase.AT_STOP,
            0,
            ReliefConfidence.HIGH,
        ),
        (
            _vehicle("vehicle-approaching", "trip-approaching"),
            ReliefPhase.APPROACHING,
            60,
            ReliefConfidence.HIGH,
        ),
        (
            _vehicle(
                "vehicle-passed",
                "trip-passed",
                current_stop_sequence=_STOP_SEQUENCE + 1,
                stop_id="stop-after",
                current_status=VehicleStopStatus.IN_TRANSIT_TO,
                longitude=2.006,
            ),
            ReliefPhase.PASSED,
            None,
            ReliefConfidence.MEDIUM,
        ),
    ],
)
@pytest.mark.asyncio
async def test_matcher_classifies_stop_phases(
    vehicle: VehiclePosition,
    expected_phase: ReliefPhase,
    expected_eta: int | None,
    expected_confidence: ReliefConfidence,
) -> None:
    stop_update = StopTimeUpdate(
        stop_id=_STOP_ID,
        stop_sequence=_STOP_SEQUENCE,
        arrival_time=_NOW + 60,
    )
    trip_update = TripUpdate(
        trip_id=vehicle.trip_id,
        route_id=_ROUTE_B,
        vehicle_id=vehicle.vehicle_id,
        direction_id=1,
        stop_time_updates=[stop_update],
        timestamp=_NOW,
    )
    realtime = _FakeRealtime({_ROUTE_B: [vehicle]}, {_ROUTE_B: [trip_update]})
    gtfs = _FakeGTFS(trip_directions={vehicle.trip_id: 1})
    matcher = ReliefMatchingService(realtime, gtfs, freshness_seconds=90, now=lambda: _NOW)

    candidates = await matcher.find_candidates(_ROUTE_A, 1, _STOP_ID)

    assert candidates is not None and len(candidates) == 1
    assert candidates[0].phase == expected_phase
    assert candidates[0].eta_seconds == expected_eta
    assert candidates[0].confidence == expected_confidence
    assert candidates[0].stop_name == "Parada del relleu"


@pytest.mark.asyncio
async def test_matcher_uses_trip_direction_and_shape_as_a_bounded_fallback() -> None:
    vehicle = _vehicle(
        "vehicle-shape",
        "trip-shape",
        direction_id=None,
        current_stop_sequence=None,
        stop_id="",
        current_status=None,
        longitude=2.004,
    )
    trip_update = TripUpdate(
        trip_id="trip-shape",
        route_id=_ROUTE_B,
        vehicle_id="vehicle-shape",
        direction_id=1,
        timestamp=_NOW,
    )
    matcher = ReliefMatchingService(
        _FakeRealtime({_ROUTE_B: [vehicle]}, {_ROUTE_B: [trip_update]}),
        _FakeGTFS(trip_directions={"trip-shape": 1}),
        freshness_seconds=90,
        now=lambda: _NOW,
    )

    candidates = await matcher.find_candidates(_ROUTE_A, 1, _STOP_ID)

    assert candidates is not None and len(candidates) == 1
    assert candidates[0].phase == ReliefPhase.APPROACHING
    assert candidates[0].confidence == ReliefConfidence.LOW
    assert 5 <= (candidates[0].eta_seconds or 0) <= 20


@pytest.mark.asyncio
async def test_matcher_orders_at_stop_before_approaching_and_bounds_the_result() -> None:
    at_stop = _vehicle(
        "vehicle-at-stop",
        "trip-at-stop",
        current_status=VehicleStopStatus.STOPPED_AT,
        longitude=_STOP_LONGITUDE,
    )
    approaching = _vehicle("vehicle-approaching", "trip-approaching", longitude=2.004)
    passed = _vehicle(
        "vehicle-passed",
        "trip-passed",
        current_stop_sequence=_STOP_SEQUENCE + 1,
        stop_id="stop-after",
        longitude=2.006,
    )
    trips = {vehicle.trip_id: 1 for vehicle in (at_stop, approaching, passed)}
    matcher = ReliefMatchingService(
        _FakeRealtime({_ROUTE_B: [passed, approaching, at_stop]}),
        _FakeGTFS(trip_directions=trips),
        freshness_seconds=90,
        now=lambda: _NOW,
    )

    candidates = await matcher.find_candidates(_ROUTE_A, 1, _STOP_ID, limit=2)

    assert candidates is not None
    assert [(item.vehicle_id, item.phase) for item in candidates] == [
        ("vehicle-at-stop", ReliefPhase.AT_STOP),
        ("vehicle-approaching", ReliefPhase.APPROACHING),
    ]


@pytest.mark.asyncio
async def test_matcher_filters_stale_entities_and_handles_empty_or_unknown_stops() -> None:
    stale = _vehicle("vehicle-stale", "trip-stale", timestamp=_NOW - 31)
    realtime = _FakeRealtime({_ROUTE_B: [stale]})
    gtfs = _FakeGTFS(trip_directions={"trip-stale": 1})
    matcher = ReliefMatchingService(realtime, gtfs, freshness_seconds=30, now=lambda: _NOW)

    assert await matcher.find_candidates(_ROUTE_A, 1, _STOP_ID) == []

    empty_matcher = ReliefMatchingService(
        _FakeRealtime({}),
        gtfs,
        freshness_seconds=30,
        now=lambda: _NOW,
    )
    assert await empty_matcher.find_candidates(_ROUTE_A, 1, _STOP_ID) == []

    unknown_stop_matcher = ReliefMatchingService(
        _FakeRealtime({_ROUTE_B: [_vehicle("vehicle-1", "trip-1")]}),
        _FakeGTFS(trip_directions={"trip-1": 1}, include_stop=False),
        freshness_seconds=30,
        now=lambda: _NOW,
    )
    assert await unknown_stop_matcher.find_candidates(_ROUTE_A, 1, _STOP_ID) is None


def _api_client(matcher: object) -> TestClient:
    app = FastAPI()
    app.state.api_key = "test-api-key"
    app.state.relief_matching_service = matcher
    app.include_router(atm_router, prefix="/api/v1")
    return TestClient(app)


def test_near_stop_endpoint_returns_bounded_privacy_safe_payload() -> None:
    matcher = SimpleNamespace(
        find_candidates=AsyncMock(
            return_value=[
                ReliefCandidate(
                    vehicle_id="vehicle-1",
                    trip_id="trip-1",
                    phase=ReliefPhase.APPROACHING,
                    eta_seconds=45,
                    distance_to_stop_m=120.5,
                    confidence=ReliefConfidence.HIGH,
                    stop_name="Parada del relleu",
                )
            ]
        )
    )

    with _api_client(matcher) as client:
        response = client.get(
            f"/api/v1/atm_rt/vehicles/{_ROUTE_A}/near-stop",
            params={"direction_id": 1, "stop_id": _STOP_ID, "limit": 1},
            headers=_HEADERS,
        )

    assert response.status_code == 200
    assert response.json() == [
        {
            "vehicle_id": "vehicle-1",
            "trip_id": "trip-1",
            "phase": "approaching",
            "eta_seconds": 45,
            "distance_to_stop_m": 120.5,
            "confidence": "high",
            "stop_name": "Parada del relleu",
        }
    ]
    assert "latitude" not in response.text
    assert "longitude" not in response.text
    matcher.find_candidates.assert_awaited_once_with(
        route_id=_ROUTE_A,
        direction_id=1,
        stop_id=_STOP_ID,
        limit=1,
    )


@pytest.mark.parametrize(
    "path",
    [
        f"/api/v1/atm_rt/vehicles/{_ROUTE_A}/near-stop?direction_id=-1&stop_id={_STOP_ID}",
        f"/api/v1/atm_rt/vehicles/{_ROUTE_A}/near-stop?direction_id=2&stop_id={_STOP_ID}",
        f"/api/v1/atm_rt/vehicles/{_ROUTE_A}/near-stop?direction_id=1&stop_id={_STOP_ID}&limit=0",
        f"/api/v1/atm_rt/vehicles/{_ROUTE_A}/near-stop?direction_id=1&stop_id={_STOP_ID}&limit=11",
        f"/api/v1/atm_rt/vehicles/{_ROUTE_A}/near-stop?direction_id=1&stop_id={'x' * 129}",
        f"/api/v1/atm_rt/vehicles/{'x' * 129}/near-stop?direction_id=1&stop_id={_STOP_ID}",
        f"/api/v1/atm_rt/vehicles/{_ROUTE_A}/near-stop?direction_id=1",
    ],
)
def test_near_stop_endpoint_validates_all_bounds(path: str) -> None:
    matcher = SimpleNamespace(find_candidates=AsyncMock(return_value=[]))

    with _api_client(matcher) as client:
        response = client.get(path, headers=_HEADERS)

    assert response.status_code == 422
    matcher.find_candidates.assert_not_awaited()


def test_near_stop_endpoint_returns_not_found_for_stop_outside_direction() -> None:
    matcher = SimpleNamespace(find_candidates=AsyncMock(return_value=None))

    with _api_client(matcher) as client:
        response = client.get(
            f"/api/v1/atm_rt/vehicles/{_ROUTE_A}/near-stop",
            params={"direction_id": 1, "stop_id": "unknown-stop"},
            headers=_HEADERS,
        )

    assert response.status_code == 404
