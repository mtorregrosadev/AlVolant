"""
GTFS static data REST API endpoints (ATM T-mobilitat shapes).

Serves the processed route shapes as GeoJSON for direct map rendering
on the driver tablets.

    GET /api/v1/gtfs/shapes              → all routes as GeoJSON FeatureCollection
    GET /api/v1/gtfs/shapes/{route_id}   → single route GeoJSON
    GET /api/v1/gtfs/routes              → route metadata listing

All endpoints require a valid ``X-API-Key`` header.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import ORJSONResponse

from app.core.auth import require_api_key
from app.core.logging import get_logger
from app.models.gtfs import GTFSShapesResponse, RouteInfo, RouteShape

logger = get_logger(__name__)

router = APIRouter(
    prefix="/gtfs",
    tags=["GTFS Static"],
    dependencies=[Depends(require_api_key)],
)


@router.get(
    "/shapes",
    summary="Get all route shapes (GeoJSON FeatureCollection)",
    response_model=GTFSShapesResponse,
    response_class=ORJSONResponse,
)
async def get_all_shapes(request: Request) -> GTFSShapesResponse:
    """Return all bus route shapes as a GeoJSON FeatureCollection.

    Each feature is a LineString representing the geographic path of a
    bus route.  Properties include route name, color, and type.

    This data is loaded from the ATM T-mobilitat static GTFS file and
    refreshed daily.
    """
    gtfs_service = request.app.state.gtfs_service
    shapes = await gtfs_service.get_all_shapes()
    if shapes is None:
        raise HTTPException(
            status_code=503,
            detail="GTFS shapes not yet loaded. Server may still be initializing.",
        )
    return shapes


@router.get(
    "/shapes/{route_id}",
    summary="Get shape for a single route",
    response_model=RouteShape,
    response_class=ORJSONResponse,
)
async def get_route_shape(route_id: str, request: Request) -> RouteShape:
    """Return the GeoJSON shape for a specific route.

    Args:
        route_id: GTFS route_id.

    Returns:
        Route metadata + GeoJSON LineString geometry.
    """
    gtfs_service = request.app.state.gtfs_service
    shape = await gtfs_service.get_route_shape(route_id)
    if shape is None:
        raise HTTPException(
            status_code=404,
            detail=f"No shape found for route '{route_id}'",
        )
    return shape


@router.get(
    "/routes",
    summary="List all route metadata",
    response_model=list[RouteInfo],
    response_class=ORJSONResponse,
)
async def get_routes(request: Request) -> list[RouteInfo]:
    """Return metadata for all routes (without geometry).

    Useful for building route selection UIs on the tablet.
    """
    gtfs_service = request.app.state.gtfs_service
    return await gtfs_service.get_all_routes()
