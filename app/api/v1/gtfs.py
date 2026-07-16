"""GTFS static data REST API endpoints."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import ORJSONResponse

from app.core.auth import require_api_key
from app.core.logging import get_logger
from app.models.gtfs import (
    NearbyRoute,
    NearbyRoutesRequest,
    RouteInfo,
    RouteShape,
    RouteStopsResponse,
)

_MAX_GTFS_ID_LENGTH = 128
# ATM identifiers legitimately contain spaces and pipes.  Reject only path
# separators and control characters, which have no valid role in an ID and can
# corrupt logs or cache-key diagnostics.
_PATH_ID_PATTERN = r"^[^\x00-\x1f\x7f/]+$"
_QUERY_ID_PATTERN = r"^[^\x00-\x1f\x7f]+$"
_DEPARTURE_GRACE_MINUTES = 5
_MAX_PAST_DEPARTURES_MINUTES = 180

logger = get_logger(__name__)

router = APIRouter(
    prefix="/gtfs",
    tags=["GTFS Static"],
    dependencies=[Depends(require_api_key)],
)


@router.get(
    "/shapes/{route_id}",
    summary="Get shape for a single route",
    response_model=RouteShape,
    response_class=ORJSONResponse,
)
async def get_route_shape(
    route_id: Annotated[
        str,
        Path(
            min_length=1,
            max_length=_MAX_GTFS_ID_LENGTH,
            pattern=_PATH_ID_PATTERN,
        ),
    ],
    request: Request,
    direction_id: Annotated[int | None, Query(ge=0, le=1)] = None,
    trip_id: Annotated[
        str | None,
        Query(
            min_length=1,
            max_length=_MAX_GTFS_ID_LENGTH,
            pattern=_QUERY_ID_PATTERN,
        ),
    ] = None,
) -> RouteShape:
    """Return route shape, optionally resolved for a specific trip variant."""
    gtfs_service = request.app.state.gtfs_service
    shape = await gtfs_service.get_route_shape(
        route_id=route_id,
        direction_id=direction_id,
        trip_id=trip_id,
    )
    if shape is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No shape found for route '{route_id}' "
                f"(direction={direction_id}, trip_id={trip_id})"
            ),
        )
    return shape


@router.get(
    "/stops/{route_id}",
    summary="Get stops for a single route",
    response_model=RouteStopsResponse,
    response_class=ORJSONResponse,
)
async def get_route_stops(
    route_id: Annotated[
        str,
        Path(
            min_length=1,
            max_length=_MAX_GTFS_ID_LENGTH,
            pattern=_PATH_ID_PATTERN,
        ),
    ],
    request: Request,
    direction_id: Annotated[int | None, Query(ge=0, le=1)] = None,
    trip_id: Annotated[
        str | None,
        Query(
            min_length=1,
            max_length=_MAX_GTFS_ID_LENGTH,
            pattern=_QUERY_ID_PATTERN,
        ),
    ] = None,
) -> RouteStopsResponse:
    """Return route stops, optionally resolved for a specific trip variant."""
    gtfs_service = request.app.state.gtfs_service
    stops = await gtfs_service.get_route_stops(
        route_id=route_id,
        direction_id=direction_id,
        trip_id=trip_id,
    )
    if stops is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No stops found for route '{route_id}' "
                f"(direction={direction_id}, trip_id={trip_id})"
            ),
        )
    return stops


@router.get(
    "/routes",
    summary="List all route metadata",
    response_model=list[RouteInfo],
    response_class=ORJSONResponse,
)
async def get_routes(request: Request) -> list[RouteInfo]:
    gtfs_service = request.app.state.gtfs_service
    return await gtfs_service.get_all_routes()


@router.post(
    "/routes/nearby",
    summary="List routes ordered by proximity to their closest stop",
    response_model=list[NearbyRoute],
)
async def get_nearby_routes(
    payload: NearbyRoutesRequest,
    request: Request,
) -> list[NearbyRoute]:
    """Calculate proximity without persisting or logging the submitted location."""
    gtfs_service = request.app.state.gtfs_service
    return await gtfs_service.get_nearby_routes(
        latitude=payload.latitude,
        longitude=payload.longitude,
        limit=payload.limit,
    )


def _get_first_stop_delay_seconds(rt_trip: object) -> int | None:
    """Return delay only when first stop update exists (stop_sequence <= 1)."""
    updates = getattr(rt_trip, "stop_time_updates", None)
    if not updates:
        return None

    first_stop_candidates = [
        update
        for update in updates
        if getattr(update, "stop_sequence", None) is not None
        and update.stop_sequence <= 1
    ]
    if not first_stop_candidates:
        return None

    first_stop_candidates.sort(key=lambda u: u.stop_sequence)
    first_update = first_stop_candidates[0]
    departure_delay = getattr(first_update, "departure_delay", None)
    arrival_delay = getattr(first_update, "arrival_delay", None)
    if departure_delay is not None:
        return departure_delay
    if arrival_delay is not None:
        return arrival_delay
    return None


@router.get(
    "/routes/{route_id}/upcoming-trips",
    summary="Get upcoming departures for a single route",
    response_class=ORJSONResponse,
)
async def get_upcoming_trips(
    route_id: Annotated[
        str,
        Path(
            min_length=1,
            max_length=_MAX_GTFS_ID_LENGTH,
            pattern=_PATH_ID_PATTERN,
        ),
    ],
    direction_id: Annotated[int, Query(ge=0, le=1)],
    request: Request,
    limit: Annotated[int, Query(ge=1, le=20)] = 4,
    past_minutes: Annotated[int, Query(ge=0, le=_MAX_PAST_DEPARTURES_MINUTES)] = 0,
) -> list[dict]:
    """Return enriched upcoming trips with origin, destination label, and status."""
    gtfs_service = request.app.state.gtfs_service

    try:
        import zoneinfo

        now_local = datetime.now(zoneinfo.ZoneInfo("Europe/Madrid"))
    except Exception:
        now_local = datetime.now()

    # A driver can still select a departure just after its scheduled minute.
    # Keep a small window here (rather than relying on realtime data, which
    # may arrive late) so a 20:20 service remains selectable until 20:25.
    lookback_minutes = max(_DEPARTURE_GRACE_MINUTES, past_minutes)
    lookup_local = now_local - timedelta(minutes=lookback_minutes)
    date_str = lookup_local.strftime("%Y%m%d")
    time_str = lookup_local.strftime("%H:%M:%S")

    calendar_exists = await gtfs_service._cache.get_json("gtfs:calendar")
    if not calendar_exists:
        return [
            {
                "trip_id": "MAINTENANCE_FALLBACK",
                "is_maintenance": True,
                "trip_headsign": "Service unavailable",
                "departure_time": "00:00:00",
                "delay_seconds": None,
                "origin_stop_name": "",
                "destination_name": "",
                "towards_label": "",
                "trip_status": "scheduled",
            }
        ]

    trips = await gtfs_service.get_upcoming_trips(
        route_id=route_id,
        direction_id=direction_id,
        date_str=date_str,
        time_str=time_str,
        limit=max(limit * 4, 20),
    )
    if past_minutes > _DEPARTURE_GRACE_MINUTES:
        # The explicit history request should start with the latest completed
        # departures, not the oldest one inside the lookback window.
        trips = sorted(
            (
                trip for trip in trips
                if int(trip.get("scheduled_epoch", 0) or 0) <= int(now_local.timestamp())
            ),
            key=lambda trip: int(trip.get("scheduled_epoch", 0) or 0),
            reverse=True,
        )

    try:
        rt_trips = []
        for candidate_route_id in await gtfs_service._resolve_group_route_ids(route_id):
            rt_trips.extend(
                await request.app.state.atm_rt_service.get_cached_trips_for_route(
                    candidate_route_id
                )
            )
    except Exception:
        rt_trips = []

    rt_by_trip_id = {trip.trip_id: trip for trip in rt_trips}

    enriched: list[dict] = []
    now_epoch = int(now_local.timestamp())

    for trip in trips:
        trip_id = trip.get("trip_id", "")
        if not trip_id:
            continue

        rt_trip = rt_by_trip_id.get(trip_id)
        first_stop_delay_seconds = _get_first_stop_delay_seconds(rt_trip) if rt_trip else None

        scheduled_epoch = int(trip.get("scheduled_epoch", 0) or 0)
        effective_delay = first_stop_delay_seconds if first_stop_delay_seconds is not None else 0
        expected_departure_epoch = scheduled_epoch + effective_delay

        # Remove stale trips that are too far in the past after delay adjustment.
        if expected_departure_epoch and expected_departure_epoch < (
            now_epoch - lookback_minutes * 60
        ):
            continue

        seconds_until_expected = expected_departure_epoch - now_epoch
        has_first_stop_rt = first_stop_delay_seconds is not None

        if has_first_stop_rt and first_stop_delay_seconds > 0:
            trip_status = "delayed"
        elif has_first_stop_rt and first_stop_delay_seconds < 0:
            trip_status = "early"
        elif has_first_stop_rt and seconds_until_expected <= 600:
            trip_status = "on_time"
        else:
            trip_status = "scheduled"

        destination_name = (trip.get("destination_name") or trip.get("trip_headsign") or "").strip()
        towards_label = (
            trip.get("towards_label")
            or (f"Towards {destination_name}" if destination_name else "")
        ).strip()

        enriched.append(
            {
                "trip_id": trip_id,
                "route_id": trip.get("route_id", route_id),
                "service_id": trip.get("service_id", ""),
                "trip_headsign": trip.get("trip_headsign", ""),
                "departure_time": trip.get("departure_time", ""),
                "scheduled_epoch": scheduled_epoch,
                "expected_departure_epoch": expected_departure_epoch,
                "delay_seconds": first_stop_delay_seconds,
                "has_rt_first_stop_update": has_first_stop_rt,
                "origin_stop_name": trip.get("origin_stop_name", ""),
                "destination_name": destination_name,
                "towards_label": towards_label,
                "trip_status": trip_status,
            }
        )

        if len(enriched) >= limit:
            break

    return enriched
