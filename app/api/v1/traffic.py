"""Road traffic REST API endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import ORJSONResponse

from app.core.auth import require_api_key
from app.models.traffic import TrafficLookupRequest, TrafficSummary

router = APIRouter(
    prefix="/traffic",
    tags=["Road Traffic"],
    dependencies=[Depends(require_api_key)],
)


@router.post(
    "/summary",
    summary="Get road traffic near a coordinate",
    response_model=TrafficSummary,
    response_class=ORJSONResponse,
)
async def get_traffic_summary(
    request: Request,
    payload: TrafficLookupRequest,
) -> TrafficSummary:
    """Keep exact coordinates out of URLs/access logs and quantize in the service."""
    traffic_service = request.app.state.traffic_service
    return await traffic_service.get_summary(
        latitude=payload.latitude,
        longitude=payload.longitude,
    )
