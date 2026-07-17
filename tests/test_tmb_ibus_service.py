"""Tests for the cache-first TMB iBus stop prediction adapter."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock

import httpx
import pytest
from google.transit import gtfs_realtime_pb2

from app.config import Settings
from app.services.tmb_ibus_service import (
    _AMBTripPrediction,
    TMBIbusService,
    _StopPrediction,
    _parse_amb_gtfs_rt_payload,
    _parse_arrival_epoch,
    _parse_tmb_ibus_payload,
    _provider_rate_limit_headers,
)


def test_parses_tmb_stop_payload_and_normalizes_milliseconds() -> None:
    now_epoch = 1_700_000_000
    payload = {
        "parades": [
            {
                "linies_trajectes": [
                    {
                        "codi_linia": "N9",
                        "desti_trajecte": "Cap a Plaça Catalunya",
                        "propers_busos": [
                            {"id_bus": "3042", "temps_arribada": (now_epoch + 90) * 1_000},
                            {"temps_arribada": 180},
                        ],
                    }
                ]
            }
        ]
    }

    predictions = _parse_tmb_ibus_payload(payload, now_epoch=now_epoch)

    assert [(item.vehicle_id, item.arrival_epoch) for item in predictions] == [
        ("3042", now_epoch + 90),
        ("", now_epoch + 180),
    ]
    assert _parse_arrival_epoch(True, now_epoch) is None


def test_keeps_only_safe_provider_rate_limit_headers() -> None:
    headers = httpx.Headers({
        "RateLimit-Limit": "60",
        "RateLimit-Remaining": "52",
        "X-RateLimit-Reset": "30",
        "Authorization": "Bearer must-not-appear",
    })

    assert _provider_rate_limit_headers(headers) == (
        ("ratelimit-limit", "60"),
        ("ratelimit-remaining", "52"),
        ("x-ratelimit-reset", "30"),
    )


def test_parses_amb_trip_updates_with_static_gtfs_identifiers() -> None:
    now_epoch = int(time.time())
    message = gtfs_realtime_pb2.FeedMessage()
    message.header.gtfs_realtime_version = "2.0"
    message.header.incrementality = gtfs_realtime_pb2.FeedHeader.FULL_DATASET
    message.header.timestamp = now_epoch
    entity = message.entity.add()
    entity.id = "m30-test"
    update = entity.trip_update
    update.trip.trip_id = "415.35.2.3.29"
    first = update.stop_time_update.add()
    first.stop_id = "107402"
    first.arrival.time = now_epoch + 90
    second = update.stop_time_update.add()
    second.stop_id = "101610"
    second.arrival.time = now_epoch + 300

    parsed = _parse_amb_gtfs_rt_payload(message.SerializeToString(), now_epoch=now_epoch)

    assert len(parsed) == 1
    assert parsed[0].route_id == "AMB_415"
    assert parsed[0].trip_id == "AMB_415.35.2.3.29"
    assert parsed[0].stop_arrivals == (
        ("AMB_107402", now_epoch + 90),
        ("AMB_101610", now_epoch + 300),
    )


@pytest.mark.asyncio
async def test_uses_shared_amb_feed_for_m30_positions() -> None:
    class FakeGTFS:
        async def get_trip_stop_contexts(
            self,
            route_id: str,
            trip_id: str,
            stop_id: str,
            *,
            max_stops: int,
            stop_stride: int,
        ) -> list[dict]:
            assert (route_id, trip_id, stop_id, max_stops, stop_stride) == (
                "AMB_415", "AMB_415.35.2.3.30", "AMB_107401", 128, 1,
            )
            return [
                {
                    "stop_id": "AMB_107401",
                    "stop_name": "Pl. de la Mare",
                    "stop_code": "107401",
                    "stop_sequence": 4,
                    "scheduled_offset_seconds": 0,
                    "route_short_name": "M30",
                },
                {
                    "stop_id": "AMB_107402",
                    "stop_name": "Monsolís",
                    "stop_code": "107402",
                    "stop_sequence": 5,
                    "scheduled_offset_seconds": 300,
                    "route_short_name": "M30",
                },
                {
                    "stop_id": "AMB_101610",
                    "stop_name": "Camí Ral",
                    "stop_code": "101610",
                    "stop_sequence": 6,
                    "scheduled_offset_seconds": 600,
                    "route_short_name": "M30",
                },
            ]

        async def get_trip_meta(self, trip_id: str) -> dict:
            assert trip_id in {"AMB_415.35.2.3.29", "AMB_415.35.2.3.30"}
            return {
                "route_id": "AMB_415",
                "direction_id": 1,
                "departure_time": "12:40:00" if trip_id.endswith(".29") else "12:50:00",
            }

    now_epoch = int(time.time())
    service = TMBIbusService(
        settings=Settings(TMB_APP_ID="", TMB_APP_KEY=""),
        cache=None,
        gtfs_service=FakeGTFS(),  # type: ignore[arg-type]
    )
    service._get_amb_trip_predictions = AsyncMock(  # type: ignore[method-assign]
        return_value=[_AMBTripPrediction(
            trip_id="AMB_415.35.2.3.29",
            route_id="AMB_415",
            stop_arrivals=(("AMB_107402", now_epoch + 120), ("AMB_101610", now_epoch + 360)),
        )],
    )

    summary = await service.get_fleet_summary(
        route_id="AMB_415",
        trip_id="AMB_415.35.2.3.30",
        direction_id=1,
        stop_id="AMB_107401",
        scheduled_departure_epoch=now_epoch,
    )

    assert summary.source == "amb_gtfs_rt"
    assert summary.status == "available"
    assert summary.route_positions[0].stop_id == "AMB_107402"
    assert summary.route_positions[0].relation == "ahead"


@pytest.mark.asyncio
async def test_amb_excludes_sibling_trip_with_the_selected_scheduled_departure() -> None:
    class FakeGTFS:
        async def get_trip_stop_contexts(
            self,
            route_id: str,
            trip_id: str,
            stop_id: str,
            *,
            max_stops: int,
            stop_stride: int,
        ) -> list[dict]:
            return [
                {
                    "stop_id": "AMB_107401",
                    "stop_name": "Camí d'Alella",
                    "stop_code": "107401",
                    "stop_sequence": 4,
                    "scheduled_offset_seconds": 0,
                    "route_short_name": "M30",
                },
                {
                    "stop_id": "AMB_107402",
                    "stop_name": "Pl. de la Mare",
                    "stop_code": "107402",
                    "stop_sequence": 5,
                    "scheduled_offset_seconds": 300,
                    "route_short_name": "M30",
                },
            ]

        async def get_trip_meta(self, trip_id: str) -> dict:
            departures = {
                "AMB_415.35.2.3.selected": "12:54:00",
                # AMB has replaced the selected static suffix with this one.
                "AMB_415.35.2.3.live-own": "12:54:00",
                "AMB_415.35.2.3.ahead": "12:44:00",
                "AMB_415.35.2.3.behind": "13:04:00",
            }
            return {
                "route_id": "AMB_415",
                "direction_id": 1,
                "departure_time": departures[trip_id],
            }

    now_epoch = int(time.time())
    service = TMBIbusService(
        settings=Settings(TMB_APP_ID="", TMB_APP_KEY=""),
        cache=None,
        gtfs_service=FakeGTFS(),  # type: ignore[arg-type]
    )
    service._get_amb_trip_predictions = AsyncMock(  # type: ignore[method-assign]
        return_value=[
            _AMBTripPrediction(
                trip_id="AMB_415.35.2.3.live-own",
                route_id="AMB_415",
                stop_arrivals=(("AMB_107401", now_epoch + 120),),
            ),
            _AMBTripPrediction(
                trip_id="AMB_415.35.2.3.ahead",
                route_id="AMB_415",
                stop_arrivals=(("AMB_107402", now_epoch + 100),),
            ),
            _AMBTripPrediction(
                trip_id="AMB_415.35.2.3.behind",
                route_id="AMB_415",
                stop_arrivals=(("AMB_107402", now_epoch + 600),),
            ),
        ],
    )

    summary = await service.get_fleet_summary(
        route_id="AMB_415",
        trip_id="AMB_415.35.2.3.selected",
        direction_id=1,
        stop_id="AMB_107401",
        scheduled_departure_epoch=now_epoch,
    )

    assert summary.reference_is_schedule_match is True
    assert summary.reference_prediction is not None
    assert summary.reference_prediction.eta_seconds == 120
    assert summary.ahead_vehicle is not None
    assert summary.ahead_vehicle.eta_seconds == 100
    assert summary.behind_vehicle is not None
    assert summary.behind_vehicle.eta_seconds == 600
    assert [position.relation for position in summary.route_positions] == ["ahead", "behind"]


@pytest.mark.asyncio
async def test_amb_never_labels_a_bus_at_the_driver_current_stop_as_ahead() -> None:
    class FakeGTFS:
        async def get_trip_stop_contexts(
            self,
            route_id: str,
            trip_id: str,
            stop_id: str,
            *,
            max_stops: int,
            stop_stride: int,
        ) -> list[dict]:
            return [
                {
                    "stop_id": "AMB_107401",
                    "stop_name": "La Virreina",
                    "stop_code": "107401",
                    "stop_sequence": 1,
                    "scheduled_offset_seconds": 0,
                    "route_short_name": "M30",
                },
                {
                    "stop_id": "AMB_107402",
                    "stop_name": "Camí d'Alella",
                    "stop_code": "107402",
                    "stop_sequence": 2,
                    "scheduled_offset_seconds": 300,
                    "route_short_name": "M30",
                },
            ]

        async def get_trip_meta(self, trip_id: str) -> dict:
            return {
                "route_id": "AMB_415",
                "direction_id": 1,
                "departure_time": "13:03:00" if trip_id.endswith("selected") else "12:53:00",
            }

    now_epoch = int(time.time())
    service = TMBIbusService(
        settings=Settings(TMB_APP_ID="", TMB_APP_KEY=""),
        cache=None,
        gtfs_service=FakeGTFS(),  # type: ignore[arg-type]
    )
    service._get_amb_trip_predictions = AsyncMock(  # type: ignore[method-assign]
        return_value=[_AMBTripPrediction(
            trip_id="AMB_415.35.2.3.unknown",
            route_id="AMB_415",
            stop_arrivals=(("AMB_107401", now_epoch + 30),),
        )],
    )

    summary = await service.get_fleet_summary(
        route_id="AMB_415",
        trip_id="AMB_415.35.2.3.selected",
        direction_id=1,
        stop_id="AMB_107401",
        scheduled_departure_epoch=now_epoch,
    )

    assert summary.reference_prediction is None
    assert summary.ahead_vehicle is None
    assert summary.behind_vehicle is None
    assert summary.route_positions == []


@pytest.mark.asyncio
async def test_matches_scheduled_trip_and_exposes_adjacent_buses() -> None:
    class FakeGTFS:
        async def get_trip_stop_context(self, route_id: str, trip_id: str, stop_id: str) -> dict:
            assert (route_id, trip_id, stop_id) == ("route-n9", "trip-n9", "AMB_000313")
            return {
                "stop_name": "Pg de Gràcia - Gran Via",
                "stop_code": "313",
                "scheduled_offset_seconds": 300,
                "route_short_name": "N9",
            }

    scheduled_departure = int(time.time())
    settings = Settings(
        TMB_APP_ID="test-app-id",
        TMB_APP_KEY="test-app-key",
    )
    service = TMBIbusService(settings=settings, cache=None, gtfs_service=FakeGTFS())  # type: ignore[arg-type]
    service._get_stop_predictions = AsyncMock(  # type: ignore[method-assign]
        return_value=(
            "available",
            [
                _StopPrediction("bus-ahead", "N9", "Centre", scheduled_departure + 240),
                _StopPrediction("bus-reference", "N9", "Centre", scheduled_departure + 300),
                _StopPrediction("bus-behind", "N9", "Centre", scheduled_departure + 420),
                _StopPrediction("other-line", "H12", "Altres", scheduled_departure + 300),
            ],
        )
    )

    summary = await service.get_fleet_summary(
        route_id="route-n9",
        trip_id="trip-n9",
        direction_id=0,
        stop_id="AMB_000313",
        scheduled_departure_epoch=scheduled_departure,
    )

    assert summary.status == "available"
    assert summary.reference_vehicle_id == "bus-reference"
    assert summary.reference_arrival_epoch == scheduled_departure + 300
    assert summary.ahead_vehicle is not None
    assert summary.ahead_vehicle.vehicle_id == "bus-ahead"
    assert summary.behind_vehicle is not None
    assert summary.behind_vehicle.vehicle_id == "bus-behind"


@pytest.mark.asyncio
async def test_reports_unconfigured_without_calling_tmb() -> None:
    class FakeGTFS:
        async def get_trip_stop_context(self, route_id: str, trip_id: str, stop_id: str) -> dict:
            return {
                "stop_name": "Pg de Gràcia - Gran Via",
                "stop_code": "313",
                "scheduled_offset_seconds": 0,
                "route_short_name": "N9",
            }

    service = TMBIbusService(
        settings=Settings(TMB_APP_ID="", TMB_APP_KEY=""),
        cache=None,
        gtfs_service=FakeGTFS(),  # type: ignore[arg-type]
    )
    service._get_stop_predictions = AsyncMock()  # type: ignore[method-assign]

    summary = await service.get_fleet_summary(
        route_id="route-n9",
        trip_id="trip-n9",
        direction_id=0,
        stop_id="AMB_000313",
        scheduled_departure_epoch=1_700_000_000,
    )

    assert summary.status == "unconfigured"
    service._get_stop_predictions.assert_not_awaited()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_uses_live_arrival_queue_without_a_selected_trip() -> None:
    class FakeGTFS:
        async def get_route_stop_context(
            self,
            route_id: str,
            direction_id: int,
            stop_id: str,
        ) -> dict:
            assert (route_id, direction_id, stop_id) == ("route-n9", 0, "AMB_000313")
            return {
                "stop_name": "Pg de Gràcia - Gran Via",
                "stop_code": "313",
                "route_short_name": "N9",
            }

    now = int(time.time())
    service = TMBIbusService(
        settings=Settings(TMB_APP_ID="test-app-id", TMB_APP_KEY="test-app-key"),
        cache=None,
        gtfs_service=FakeGTFS(),  # type: ignore[arg-type]
    )
    service._get_stop_predictions = AsyncMock(  # type: ignore[method-assign]
        return_value=(
            "available",
            [
                _StopPrediction("", "N9", "Centre", now + 90),
                _StopPrediction("", "N9", "Centre", now + 240),
            ],
        )
    )

    summary = await service.get_fleet_summary(
        route_id="route-n9",
        trip_id=None,
        direction_id=0,
        stop_id="AMB_000313",
        scheduled_departure_epoch=None,
    )

    assert summary.status == "available"
    assert summary.reference_is_schedule_match is False
    assert summary.reference_prediction is not None
    assert summary.reference_prediction.eta_seconds == 90
    assert summary.behind_vehicle is not None
    assert summary.behind_vehicle.eta_seconds == 240


@pytest.mark.asyncio
async def test_scans_downstream_stops_to_locate_preceding_service() -> None:
    class FakeGTFS:
        async def get_trip_stop_contexts(
            self,
            route_id: str,
            trip_id: str,
            stop_id: str,
            *,
            max_stops: int,
            stop_stride: int,
        ) -> list[dict]:
            assert (route_id, trip_id, stop_id, max_stops, stop_stride) == (
                "route-n9", "trip-n9", "AMB_000313", 16, 2,
            )
            return [
                {
                    "stop_id": "AMB_000313",
                    "stop_name": "Primera parada",
                    "stop_code": "313",
                    "stop_sequence": 1,
                    "scheduled_offset_seconds": 300,
                    "route_short_name": "N9",
                },
                {
                    "stop_id": "AMB_000315",
                    "stop_name": "Tercera parada",
                    "stop_code": "315",
                    "stop_sequence": 3,
                    "scheduled_offset_seconds": 900,
                    "route_short_name": "N9",
                },
                {
                    "stop_id": "AMB_000317",
                    "stop_name": "Cinquena parada",
                    "stop_code": "317",
                    "stop_sequence": 5,
                    "scheduled_offset_seconds": 1_500,
                    "route_short_name": "N9",
                },
            ]

    now = int(time.time())
    predictions_by_stop = {
        "313": [
            _StopPrediction("", "N9", "Centre", now + 120),
            _StopPrediction("", "N9", "Centre", now + 300),
        ],
        "315": [_StopPrediction("", "N9", "Centre", now + 900)],
        "317": [
            _StopPrediction("", "N9", "Centre", now + 60),
            _StopPrediction("", "N9", "Centre", now + 1_500),
        ],
    }
    service = TMBIbusService(
        settings=Settings(TMB_APP_ID="test-app-id", TMB_APP_KEY="test-app-key"),
        cache=None,
        gtfs_service=FakeGTFS(),  # type: ignore[arg-type]
    )
    service._get_stop_predictions = AsyncMock(  # type: ignore[method-assign]
        side_effect=lambda stop_code: ("available", predictions_by_stop[stop_code]),
    )

    summary = await service.get_fleet_summary(
        route_id="route-n9",
        trip_id="trip-n9",
        direction_id=0,
        stop_id="AMB_000313",
        scheduled_departure_epoch=now,
    )

    assert summary.reference_is_schedule_match is True
    assert summary.ahead_position is not None
    assert summary.ahead_position.stop_id == "AMB_000317"
    assert summary.ahead_position.stop_name == "Cinquena parada"
    assert summary.ahead_position.prediction.eta_seconds <= 60
    assert any(
        position.stop_id == "AMB_000317" and position.relation == "ahead"
        for position in summary.route_positions
    )


@pytest.mark.asyncio
async def test_keeps_scanning_downstream_when_current_stop_has_no_prediction() -> None:
    class FakeGTFS:
        async def get_trip_stop_contexts(
            self,
            route_id: str,
            trip_id: str,
            stop_id: str,
            *,
            max_stops: int,
            stop_stride: int,
        ) -> list[dict]:
            return [
                {
                    "stop_id": "AMB_000313",
                    "stop_name": "Primera parada",
                    "stop_code": "313",
                    "stop_sequence": 1,
                    "scheduled_offset_seconds": 300,
                    "route_short_name": "N9",
                },
                {
                    "stop_id": "AMB_000317",
                    "stop_name": "Cinquena parada",
                    "stop_code": "317",
                    "stop_sequence": 5,
                    "scheduled_offset_seconds": 1_500,
                    "route_short_name": "N9",
                },
            ]

    now = int(time.time())
    service = TMBIbusService(
        settings=Settings(TMB_APP_ID="test-app-id", TMB_APP_KEY="test-app-key"),
        cache=None,
        gtfs_service=FakeGTFS(),  # type: ignore[arg-type]
    )
    service._get_stop_predictions = AsyncMock(  # type: ignore[method-assign]
        side_effect=lambda stop_code: (
            "available",
            [] if stop_code == "313" else [_StopPrediction("", "N9", "Centre", now + 60)],
        ),
    )

    summary = await service.get_fleet_summary(
        route_id="route-n9",
        trip_id="trip-n9",
        direction_id=0,
        stop_id="AMB_000313",
        scheduled_departure_epoch=now,
    )

    assert summary.reference_prediction is None
    assert summary.ahead_position is not None
    assert summary.ahead_position.stop_id == "AMB_000317"
