"""
API endpoints for ATM GTFS-Realtime data.

Provides access to live vehicle positions, trip updates, and service alerts
fetched from the unified ATM production endpoints.

All endpoints require a valid ``X-API-Key`` header.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import ORJSONResponse

from app.core.auth import require_api_key
from app.models.atm_rt import ReliefCandidate, TripUpdate, VehiclePosition
from app.services.relief_matching_service import ReliefMatchingService

_MAX_ROUTE_ID_LENGTH = 128
_MAX_STOP_ID_LENGTH = 128
_MAX_RELIEF_CANDIDATES = 10
_ROUTE_ID_PATTERN = r"^[^\x00-\x1f\x7f/]+$"
_QUERY_ID_PATTERN = r"^[^\x00-\x1f\x7f]+$"
router = APIRouter(
    prefix="/atm_rt",
    tags=["ATM Real-Time"],
    dependencies=[Depends(require_api_key)],
)


@router.get(
    "/vehicles/{route_id}/near-stop",
    response_model=list[ReliefCandidate],
    response_class=ORJSONResponse,
    summary="Find realtime vehicles approaching a relief stop",
)
async def get_vehicles_near_stop(
    route_id: Annotated[
        str,
        Path(min_length=1, max_length=_MAX_ROUTE_ID_LENGTH, pattern=_ROUTE_ID_PATTERN),
    ],
    request: Request,
    direction_id: Annotated[int, Query(ge=0, le=1)],
    stop_id: Annotated[
        str,
        Query(min_length=1, max_length=_MAX_STOP_ID_LENGTH, pattern=_QUERY_ID_PATTERN),
    ],
    limit: Annotated[int, Query(ge=1, le=_MAX_RELIEF_CANDIDATES)] = 4,
) -> list[ReliefCandidate]:
    """Return bounded candidates without receiving or retaining user coordinates."""
    matcher = getattr(request.app.state, "relief_matching_service", None)
    if matcher is None:
        realtime = request.app.state.atm_rt_service
        matcher = ReliefMatchingService(
            realtime,
            request.app.state.gtfs_service,
            freshness_seconds=getattr(realtime, "freshness_window_seconds", 90),
        )

    candidates = await matcher.find_candidates(
        route_id=route_id,
        direction_id=direction_id,
        stop_id=stop_id,
        limit=limit,
    )
    if candidates is None:
        raise HTTPException(
            status_code=404,
            detail="The stop is not available for this route direction",
        )
    return candidates


@router.get(
    "/vehicles/{route_id}",
    response_model=list[VehiclePosition],
    response_class=ORJSONResponse,
    summary="Get vehicle positions for a specific route",
)
async def get_route_vehicles(
    route_id: Annotated[
        str,
        Path(min_length=1, max_length=_MAX_ROUTE_ID_LENGTH, pattern=_ROUTE_ID_PATTERN),
    ],
    request: Request,
) -> list[VehiclePosition]:
    """Retrieve the latest positions of vehicles currently serving the specified route."""
    service = request.app.state.atm_rt_service
    return await service.get_cached_vehicles_for_route(route_id)


@router.get(
    "/trips/{route_id}",
    response_model=list[TripUpdate],
    response_class=ORJSONResponse,
    summary="Get trip updates for a specific route",
)
async def get_route_trip_updates(
    route_id: Annotated[
        str,
        Path(min_length=1, max_length=_MAX_ROUTE_ID_LENGTH, pattern=_ROUTE_ID_PATTERN),
    ],
    request: Request,
) -> list[TripUpdate]:
    """Retrieve ETAs and delay predictions for trips on the specified route."""
    service = request.app.state.atm_rt_service
    return await service.get_cached_trips_for_route(route_id)
