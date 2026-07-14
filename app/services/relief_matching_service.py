"""Privacy-preserving matching of realtime vehicles to a driver's relief stop."""

from __future__ import annotations

import asyncio
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

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

_EARTH_RADIUS_METERS = 6_371_000.0
_MAX_GROUP_ROUTE_IDS = 32
_MAX_SOURCE_VEHICLES = 128
_MAX_RESULT_LIMIT = 10
_MAX_APPROACH_DISTANCE_METERS = 5_000.0
_MAX_AT_STOP_DISTANCE_METERS = 500.0
_MAX_PASSED_DISTANCE_METERS = 750.0
_AT_STOP_DISTANCE_METERS = 45.0
_PASSED_TOLERANCE_METERS = 55.0
_MAX_ROUTE_CROSS_TRACK_METERS = 250.0
_ABSOLUTE_TIME_GRACE_SECONDS = 120
_MAX_ETA_SECONDS = 7_200


class RealtimeSource(Protocol):
    """Realtime reads required by the relief matcher."""

    async def get_cached_vehicles_for_route(self, route_id: str) -> list[VehiclePosition]: ...

    async def get_cached_trips_for_route(self, route_id: str) -> list[TripUpdate]: ...


class StaticGTFSProvider(Protocol):
    """Static GTFS reads required by the relief matcher."""

    async def resolve_group_route_ids(self, route_id: str) -> list[str]: ...

    async def get_trip_meta(self, trip_id: str) -> dict | None: ...

    async def get_route_stops(
        self,
        route_id: str,
        direction_id: int | None = None,
        trip_id: str | None = None,
    ) -> dict | None: ...

    async def get_route_shape(
        self,
        route_id: str,
        direction_id: int | None = None,
        trip_id: str | None = None,
    ) -> RouteShape | None: ...


@dataclass(frozen=True, slots=True)
class _StopReference:
    stop_id: str
    stop_name: str
    sequence: int
    longitude: float
    latitude: float


@dataclass(frozen=True, slots=True)
class _Projection:
    distance_along: float
    cross_track: float


@dataclass(frozen=True, slots=True)
class _RankedCandidate:
    candidate: ReliefCandidate
    remaining_route_m: float | None
    timestamp: int


class ReliefMatchingService:
    """Associate cached GTFS-RT vehicles with one route stop.

    The caller supplies a GTFS ``stop_id`` selected locally on the device. No
    user coordinates enter this service, its logs, or its cache keys.
    """

    def __init__(
        self,
        realtime: RealtimeSource,
        gtfs: StaticGTFSProvider,
        *,
        freshness_seconds: int = 90,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._realtime = realtime
        self._gtfs = gtfs
        self._freshness_seconds = max(5, min(int(freshness_seconds), 600))
        self._now = now

    async def find_candidates(
        self,
        route_id: str,
        direction_id: int,
        stop_id: str,
        limit: int = 4,
    ) -> list[ReliefCandidate] | None:
        """Return ordered candidates, or ``None`` when the stop is not on the direction."""
        if direction_id not in (0, 1):
            raise ValueError("direction_id must be 0 or 1")
        if not 1 <= limit <= _MAX_RESULT_LIMIT:
            raise ValueError(f"limit must be between 1 and {_MAX_RESULT_LIMIT}")
        if not route_id or not stop_id:
            raise ValueError("route_id and stop_id are required")

        resolved_route_ids = await self._gtfs.resolve_group_route_ids(route_id)
        route_ids = list(dict.fromkeys(resolved_route_ids[:_MAX_GROUP_ROUTE_IDS]))
        if not route_ids:
            route_ids = [route_id]

        representative_stops = await self._gtfs.get_route_stops(
            route_id,
            direction_id=direction_id,
        )
        requested_stop = _extract_stop(representative_stops, stop_id)
        if requested_stop is None or _collection_direction(representative_stops) != direction_id:
            return None

        vehicle_results, trip_results = await asyncio.gather(
            asyncio.gather(
                *(self._realtime.get_cached_vehicles_for_route(item) for item in route_ids),
                return_exceptions=True,
            ),
            asyncio.gather(
                *(self._realtime.get_cached_trips_for_route(item) for item in route_ids),
                return_exceptions=True,
            ),
        )
        vehicles = _deduplicate_vehicles(vehicle_results, route_ids)
        updates = _deduplicate_trip_updates(trip_results, route_ids)
        if not vehicles:
            return []

        now_epoch = int(self._now())
        fresh_vehicles = [
            vehicle
            for vehicle in vehicles
            if _is_fresh_timestamp(vehicle.timestamp, now_epoch, self._freshness_seconds)
        ]
        fresh_vehicles.sort(
            key=lambda vehicle: (
                _haversine_meters(
                    vehicle.latitude,
                    vehicle.longitude,
                    requested_stop.latitude,
                    requested_stop.longitude,
                ),
                vehicle.vehicle_id,
            )
        )
        fresh_vehicles = fresh_vehicles[:_MAX_SOURCE_VEHICLES]
        if not fresh_vehicles:
            return []

        updates = [
            update
            for update in updates
            if _is_fresh_timestamp(update.timestamp, now_epoch, self._freshness_seconds)
        ]
        updates_by_trip = {update.trip_id: update for update in updates if update.trip_id}
        updates_by_vehicle = _latest_updates_by_vehicle(updates)
        evaluated = await asyncio.gather(
            *(
                self._evaluate_vehicle(
                    route_id=route_id,
                    route_ids=set(route_ids),
                    direction_id=direction_id,
                    stop_id=stop_id,
                    vehicle=vehicle,
                    update_by_trip=updates_by_trip.get(vehicle.trip_id),
                    update_by_vehicle=updates_by_vehicle.get(vehicle.vehicle_id),
                    now_epoch=now_epoch,
                )
                for vehicle in fresh_vehicles
            ),
            return_exceptions=True,
        )
        ranked = [item for item in evaluated if isinstance(item, _RankedCandidate)]
        ranked.sort(key=_candidate_sort_key)
        return [item.candidate for item in ranked[:limit]]

    async def _evaluate_vehicle(
        self,
        *,
        route_id: str,
        route_ids: set[str],
        direction_id: int,
        stop_id: str,
        vehicle: VehiclePosition,
        update_by_trip: TripUpdate | None,
        update_by_vehicle: TripUpdate | None,
        now_epoch: int,
    ) -> _RankedCandidate | None:
        update = update_by_trip
        if update is not None and update.vehicle_id and update.vehicle_id != vehicle.vehicle_id:
            update = None
        if (
            update is None
            and update_by_vehicle is not None
            and (not vehicle.trip_id or update_by_vehicle.trip_id == vehicle.trip_id)
        ):
            update = update_by_vehicle

        trip_id = vehicle.trip_id or (update.trip_id if update is not None else "")
        if not trip_id:
            return None

        try:
            trip_meta = await self._gtfs.get_trip_meta(trip_id)
        except Exception:
            trip_meta = None
        meta_route_id = trip_meta.get("route_id") if isinstance(trip_meta, dict) else None
        if isinstance(meta_route_id, str) and meta_route_id and meta_route_id not in route_ids:
            return None

        directions = [vehicle.direction_id]
        if update is not None:
            directions.append(update.direction_id)
        if isinstance(trip_meta, dict):
            meta_direction = trip_meta.get("direction_id")
            if isinstance(meta_direction, int) and not isinstance(meta_direction, bool):
                directions.append(meta_direction)
        known_directions = [item for item in directions if item is not None]
        if not known_directions or any(item != direction_id for item in known_directions):
            return None

        trip_stops = await self._gtfs.get_route_stops(route_id, trip_id=trip_id)
        if _collection_direction(trip_stops) != direction_id:
            return None
        target_stop = _extract_stop(trip_stops, stop_id)
        if target_stop is None:
            return None

        distance_to_stop = _haversine_meters(
            vehicle.latitude,
            vehicle.longitude,
            target_stop.latitude,
            target_stop.longitude,
        )
        target_update = _find_stop_update(update, target_stop) if update is not None else None
        phase, confidence = _phase_from_realtime(
            vehicle,
            target_stop,
            target_update,
            update,
            distance_to_stop,
            now_epoch,
        )

        remaining_route_m: float | None = None
        try:
            route_shape = await self._gtfs.get_route_shape(route_id, trip_id=trip_id)
        except Exception:
            route_shape = None
        coordinates = _shape_coordinates(route_shape)
        if coordinates:
            vehicle_projection = _project_on_route(
                vehicle.longitude,
                vehicle.latitude,
                coordinates,
            )
            stop_projection = _project_on_route(
                target_stop.longitude,
                target_stop.latitude,
                coordinates,
            )
            if (
                vehicle_projection is not None
                and stop_projection is not None
                and vehicle_projection.cross_track <= _MAX_ROUTE_CROSS_TRACK_METERS
            ):
                remaining_route_m = (
                    stop_projection.distance_along - vehicle_projection.distance_along
                )
                if phase is None:
                    phase = _phase_from_route_progress(remaining_route_m, distance_to_stop)
                    confidence = ReliefConfidence.LOW

        if phase is None:
            return None
        if not _within_phase_bounds(phase, distance_to_stop, remaining_route_m):
            return None

        eta_seconds = _eta_seconds(
            phase=phase,
            target_update=target_update,
            now_epoch=now_epoch,
            remaining_route_m=remaining_route_m,
            distance_to_stop_m=distance_to_stop,
            speed_mps=vehicle.speed,
        )
        candidate = ReliefCandidate(
            vehicle_id=vehicle.vehicle_id,
            trip_id=trip_id,
            phase=phase,
            eta_seconds=eta_seconds,
            distance_to_stop_m=round(distance_to_stop, 1),
            confidence=confidence,
            stop_name=target_stop.stop_name,
        )
        return _RankedCandidate(
            candidate=candidate,
            remaining_route_m=remaining_route_m,
            timestamp=vehicle.timestamp,
        )


def _extract_stop(collection: object, stop_id: str) -> _StopReference | None:
    if not isinstance(collection, dict) or not isinstance(collection.get("features"), list):
        return None
    for feature in collection["features"]:
        if not isinstance(feature, dict):
            continue
        properties = feature.get("properties")
        geometry = feature.get("geometry")
        if not isinstance(properties, dict) or properties.get("stop_id") != stop_id:
            continue
        if not isinstance(geometry, dict) or geometry.get("type") != "Point":
            continue
        coordinates = geometry.get("coordinates")
        if (
            not isinstance(coordinates, list)
            or len(coordinates) < 2
            or isinstance(coordinates[0], bool)
            or isinstance(coordinates[1], bool)
            or not isinstance(coordinates[0], (int, float))
            or not isinstance(coordinates[1], (int, float))
        ):
            continue
        longitude = float(coordinates[0])
        latitude = float(coordinates[1])
        sequence = properties.get("stop_sequence")
        if (
            not math.isfinite(longitude)
            or not math.isfinite(latitude)
            or not -180 <= longitude <= 180
            or not -90 <= latitude <= 90
            or not isinstance(sequence, int)
            or isinstance(sequence, bool)
            or not 0 <= sequence <= 10_000
        ):
            continue
        stop_name = properties.get("stop_name", "")
        return _StopReference(
            stop_id=stop_id,
            stop_name=stop_name if isinstance(stop_name, str) else "",
            sequence=sequence,
            longitude=longitude,
            latitude=latitude,
        )
    return None


def _collection_direction(collection: object) -> int | None:
    if not isinstance(collection, dict):
        return None
    direction = collection.get("direction_id")
    if direction in (0, 1) and not isinstance(direction, bool):
        return direction
    features = collection.get("features")
    if isinstance(features, list) and features:
        first = features[0]
        if isinstance(first, dict) and isinstance(first.get("properties"), dict):
            direction = first["properties"].get("direction_id")
            if direction in (0, 1) and not isinstance(direction, bool):
                return direction
    return None


def _deduplicate_vehicles(
    batches: list[list[VehiclePosition] | BaseException],
    route_ids: list[str],
) -> list[VehiclePosition]:
    allowed_routes = set(route_ids)
    latest: dict[str, VehiclePosition] = {}
    for batch in batches:
        if isinstance(batch, BaseException):
            continue
        for vehicle in batch:
            if not vehicle.vehicle_id or vehicle.route_id not in allowed_routes:
                continue
            current = latest.get(vehicle.vehicle_id)
            if current is None or vehicle.timestamp >= current.timestamp:
                latest[vehicle.vehicle_id] = vehicle
    return list(latest.values())


def _deduplicate_trip_updates(
    batches: list[list[TripUpdate] | BaseException],
    route_ids: list[str],
) -> list[TripUpdate]:
    allowed_routes = set(route_ids)
    latest: dict[str, TripUpdate] = {}
    for batch in batches:
        if isinstance(batch, BaseException):
            continue
        for update in batch:
            if not update.trip_id or update.route_id not in allowed_routes:
                continue
            current = latest.get(update.trip_id)
            if current is None or update.timestamp >= current.timestamp:
                latest[update.trip_id] = update
    return list(latest.values())


def _latest_updates_by_vehicle(updates: list[TripUpdate]) -> dict[str, TripUpdate]:
    latest: dict[str, TripUpdate] = {}
    for update in updates:
        if not update.vehicle_id:
            continue
        current = latest.get(update.vehicle_id)
        if current is None or update.timestamp >= current.timestamp:
            latest[update.vehicle_id] = update
    return latest


def _is_fresh_timestamp(timestamp: int, now_epoch: int, freshness_seconds: int) -> bool:
    if timestamp == 0:
        return True
    age = now_epoch - timestamp
    return -30 <= age <= freshness_seconds


def _find_stop_update(
    update: TripUpdate | None,
    stop: _StopReference,
) -> StopTimeUpdate | None:
    if update is None:
        return None
    by_id = next((item for item in update.stop_time_updates if item.stop_id == stop.stop_id), None)
    if by_id is not None:
        return by_id
    return next(
        (item for item in update.stop_time_updates if item.stop_sequence == stop.sequence),
        None,
    )


def _phase_from_realtime(
    vehicle: VehiclePosition,
    stop: _StopReference,
    stop_update: StopTimeUpdate | None,
    trip_update: TripUpdate | None,
    distance_to_stop_m: float,
    now_epoch: int,
) -> tuple[ReliefPhase | None, ReliefConfidence]:
    stop_matches = vehicle.stop_id == stop.stop_id if vehicle.stop_id else False
    sequence = vehicle.current_stop_sequence

    if stop_matches:
        if vehicle.current_status == VehicleStopStatus.STOPPED_AT:
            return ReliefPhase.AT_STOP, ReliefConfidence.HIGH
        if vehicle.current_status in (
            VehicleStopStatus.INCOMING_AT,
            VehicleStopStatus.IN_TRANSIT_TO,
        ):
            return ReliefPhase.APPROACHING, ReliefConfidence.HIGH
        if distance_to_stop_m <= _AT_STOP_DISTANCE_METERS:
            return ReliefPhase.AT_STOP, ReliefConfidence.MEDIUM
        return ReliefPhase.APPROACHING, ReliefConfidence.MEDIUM

    if sequence is not None:
        if sequence > stop.sequence:
            return ReliefPhase.PASSED, ReliefConfidence.MEDIUM
        if sequence < stop.sequence:
            return ReliefPhase.APPROACHING, ReliefConfidence.MEDIUM
        if vehicle.current_status == VehicleStopStatus.STOPPED_AT:
            return ReliefPhase.AT_STOP, ReliefConfidence.MEDIUM
        if distance_to_stop_m <= _AT_STOP_DISTANCE_METERS:
            return ReliefPhase.AT_STOP, ReliefConfidence.MEDIUM
        return ReliefPhase.APPROACHING, ReliefConfidence.MEDIUM

    event_time = _stop_event_time(stop_update)
    if event_time is not None:
        if event_time < now_epoch - _ABSOLUTE_TIME_GRACE_SECONDS:
            return ReliefPhase.PASSED, ReliefConfidence.MEDIUM
        if (
            distance_to_stop_m <= _AT_STOP_DISTANCE_METERS
            and event_time <= now_epoch + _ABSOLUTE_TIME_GRACE_SECONDS
        ):
            return ReliefPhase.AT_STOP, ReliefConfidence.MEDIUM
        return ReliefPhase.APPROACHING, ReliefConfidence.MEDIUM

    if trip_update is not None and trip_update.stop_time_updates:
        sequences = [item.stop_sequence for item in trip_update.stop_time_updates]
        if min(sequences) > stop.sequence:
            return ReliefPhase.PASSED, ReliefConfidence.LOW
        if max(sequences) < stop.sequence:
            return ReliefPhase.APPROACHING, ReliefConfidence.LOW

    return None, ReliefConfidence.LOW


def _phase_from_route_progress(
    remaining_route_m: float,
    distance_to_stop_m: float,
) -> ReliefPhase:
    if abs(remaining_route_m) <= _PASSED_TOLERANCE_METERS or (
        distance_to_stop_m <= _AT_STOP_DISTANCE_METERS
    ):
        return ReliefPhase.AT_STOP
    if remaining_route_m > 0:
        return ReliefPhase.APPROACHING
    return ReliefPhase.PASSED


def _within_phase_bounds(
    phase: ReliefPhase,
    distance_to_stop_m: float,
    remaining_route_m: float | None,
) -> bool:
    route_distance = abs(remaining_route_m) if remaining_route_m is not None else None
    if phase == ReliefPhase.AT_STOP:
        return distance_to_stop_m <= _MAX_AT_STOP_DISTANCE_METERS
    if phase == ReliefPhase.PASSED:
        metric = route_distance if route_distance is not None else distance_to_stop_m
        return metric <= _MAX_PASSED_DISTANCE_METERS
    metric = max(0.0, remaining_route_m) if remaining_route_m is not None else distance_to_stop_m
    return metric <= _MAX_APPROACH_DISTANCE_METERS


def _stop_event_time(stop_update: StopTimeUpdate | None) -> int | None:
    if stop_update is None:
        return None
    for value in (stop_update.arrival_time, stop_update.departure_time):
        if value is not None and value > 0:
            return value
    return None


def _eta_seconds(
    *,
    phase: ReliefPhase,
    target_update: StopTimeUpdate | None,
    now_epoch: int,
    remaining_route_m: float | None,
    distance_to_stop_m: float,
    speed_mps: float | None,
) -> int | None:
    if phase == ReliefPhase.AT_STOP:
        return 0
    if phase == ReliefPhase.PASSED:
        return None

    event_time = _stop_event_time(target_update)
    if event_time is not None:
        eta = max(0, event_time - now_epoch)
        return eta if eta <= _MAX_ETA_SECONDS else None

    if speed_mps is None or speed_mps < 0.5:
        return None
    distance = max(0.0, remaining_route_m) if remaining_route_m is not None else distance_to_stop_m
    eta = round(distance / speed_mps)
    return min(max(0, eta), _MAX_ETA_SECONDS)


def _shape_coordinates(shape: RouteShape | None) -> list[tuple[float, float]]:
    if shape is None or not isinstance(shape.geojson, dict):
        return []
    geometry = shape.geojson.get("geometry")
    if not isinstance(geometry, dict) or geometry.get("type") != "LineString":
        return []
    raw_coordinates = geometry.get("coordinates")
    if not isinstance(raw_coordinates, list) or len(raw_coordinates) < 2:
        return []
    coordinates: list[tuple[float, float]] = []
    for coordinate in raw_coordinates:
        if (
            not isinstance(coordinate, list)
            or len(coordinate) < 2
            or isinstance(coordinate[0], bool)
            or isinstance(coordinate[1], bool)
            or not isinstance(coordinate[0], (int, float))
            or not isinstance(coordinate[1], (int, float))
        ):
            return []
        longitude = float(coordinate[0])
        latitude = float(coordinate[1])
        if not math.isfinite(longitude) or not math.isfinite(latitude):
            return []
        coordinates.append((longitude, latitude))
    return coordinates


def _project_on_route(
    longitude: float,
    latitude: float,
    coordinates: list[tuple[float, float]],
) -> _Projection | None:
    if len(coordinates) < 2:
        return None
    best_cross_track = math.inf
    best_distance_along = 0.0
    accumulated = 0.0
    for start, end in zip(coordinates, coordinates[1:], strict=False):
        segment_length = _haversine_meters(start[1], start[0], end[1], end[0])
        if segment_length <= 0:
            continue
        reference_latitude = math.radians((latitude + start[1] + end[1]) / 3)
        start_x = math.radians(start[0] - longitude) * math.cos(reference_latitude)
        start_y = math.radians(start[1] - latitude)
        end_x = math.radians(end[0] - longitude) * math.cos(reference_latitude)
        end_y = math.radians(end[1] - latitude)
        delta_x = end_x - start_x
        delta_y = end_y - start_y
        denominator = delta_x * delta_x + delta_y * delta_y
        if denominator <= 0:
            accumulated += segment_length
            continue
        fraction = max(0.0, min(1.0, -(start_x * delta_x + start_y * delta_y) / denominator))
        projected_x = start_x + fraction * delta_x
        projected_y = start_y + fraction * delta_y
        cross_track = math.hypot(projected_x, projected_y) * _EARTH_RADIUS_METERS
        if cross_track < best_cross_track:
            best_cross_track = cross_track
            best_distance_along = accumulated + fraction * segment_length
        accumulated += segment_length
    if not math.isfinite(best_cross_track):
        return None
    return _Projection(distance_along=best_distance_along, cross_track=best_cross_track)


def _haversine_meters(
    latitude_a: float,
    longitude_a: float,
    latitude_b: float,
    longitude_b: float,
) -> float:
    latitude_a_radians = math.radians(latitude_a)
    latitude_b_radians = math.radians(latitude_b)
    latitude_delta = math.radians(latitude_b - latitude_a)
    longitude_delta = math.radians(longitude_b - longitude_a)
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(latitude_a_radians)
        * math.cos(latitude_b_radians)
        * math.sin(longitude_delta / 2) ** 2
    )
    angular_distance = 2 * math.atan2(
        math.sqrt(haversine),
        math.sqrt(max(0.0, 1 - haversine)),
    )
    return _EARTH_RADIUS_METERS * angular_distance


def _candidate_sort_key(item: _RankedCandidate) -> tuple[int, float, float, int, str]:
    phase_priority = {
        ReliefPhase.AT_STOP: 0,
        ReliefPhase.APPROACHING: 1,
        ReliefPhase.PASSED: 2,
    }
    eta = float(item.candidate.eta_seconds) if item.candidate.eta_seconds is not None else math.inf
    remaining = (
        abs(item.remaining_route_m)
        if item.remaining_route_m is not None
        else item.candidate.distance_to_stop_m
    )
    return (
        phase_priority[item.candidate.phase],
        eta,
        remaining,
        -item.timestamp,
        item.candidate.vehicle_id,
    )
