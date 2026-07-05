"""
API endpoints for ATM GTFS-Realtime data.

Provides access to live vehicle positions, trip updates, and service alerts
fetched from the unified ATM production endpoints.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import ORJSONResponse

from app.models.atm_rt import (
    ATMRealtimeFeed,
    ServiceAlert,
    TripUpdate,
    VehiclePosition,
)
from app.services.atm_rt_service import ATMRTService

router = APIRouter(prefix="/atm_rt", tags=["ATM Real-Time"])


@router.get(
    "/realtime",
    response_model=ATMRealtimeFeed,
    response_class=ORJSONResponse,
    summary="Get full ATM GTFS-RT feed snapshot",
)
async def get_full_realtime_feed(request: Request) -> ATMRealtimeFeed:
    """Retrieve the complete, parsed snapshot of the unified ATM feeds."""
    service = request.app.state.atm_rt_service
    feed = await service.get_cached_feed()
    if not feed:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Real-time data not yet available. Workers may still be initializing.",
        )
    return feed


@router.get(
    "/vehicles",
    response_model=list[VehiclePosition],
    response_class=ORJSONResponse,
    summary="Get all vehicle positions",
)
async def get_all_vehicles(request: Request) -> list[VehiclePosition]:
    """Retrieve the latest positions of all active vehicles."""
    service = request.app.state.atm_rt_service
    return await service.get_cached_vehicles()


@router.get(
    "/vehicles/{route_id}",
    response_model=list[VehiclePosition],
    response_class=ORJSONResponse,
    summary="Get vehicle positions for a specific route",
)
async def get_route_vehicles(route_id: str, request: Request) -> list[VehiclePosition]:
    """Retrieve the latest positions of vehicles currently serving the specified route."""
    service = request.app.state.atm_rt_service
    vehicles = await service.get_cached_vehicles()
    return [v for v in vehicles if v.route_id == route_id]


@router.get(
    "/trips",
    response_model=list[TripUpdate],
    response_class=ORJSONResponse,
    summary="Get all trip updates",
)
async def get_all_trip_updates(request: Request) -> list[TripUpdate]:
    """Retrieve ETAs and delay predictions for all active trips."""
    service = request.app.state.atm_rt_service
    return await service.get_cached_trips()


@router.get(
    "/trips/{route_id}",
    response_model=list[TripUpdate],
    response_class=ORJSONResponse,
    summary="Get trip updates for a specific route",
)
async def get_route_trip_updates(route_id: str, request: Request) -> list[TripUpdate]:
    """Retrieve ETAs and delay predictions for trips on the specified route."""
    service = request.app.state.atm_rt_service
    trips = await service.get_cached_trips()
    return [t for t in trips if t.route_id == route_id]


@router.get(
    "/alerts",
    response_model=list[ServiceAlert],
    response_class=ORJSONResponse,
    summary="Get active service alerts",
)
async def get_service_alerts(request: Request) -> list[ServiceAlert]:
    """Retrieve all active service alerts and incidents."""
    service = request.app.state.atm_rt_service
    return await service.get_cached_alerts()
