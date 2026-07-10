"""Road traffic REST API endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import ORJSONResponse

from app.core.auth import require_api_key
from app.models.traffic import TrafficSummary

router = APIRouter(
    prefix="/traffic",
    tags=["Road Traffic"],
    dependencies=[Depends(require_api_key)],
)


@router.get(
    "/summary",
    summary="Get road traffic near a coordinate",
    response_model=TrafficSummary,
    response_class=ORJSONResponse,
)
async def get_traffic_summary(
    request: Request,
    latitude: float = Query(..., ge=-90, le=90),
    longitude: float = Query(..., ge=-180, le=180),
) -> TrafficSummary:
    traffic_service = request.app.state.traffic_service
    return await traffic_service.get_summary(latitude=latitude, longitude=longitude)
