"""TMB iBus endpoints for stop-level fleet context."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import ORJSONResponse

from app.core.auth import require_api_key
from app.models.ibus import IbusFleetLookupRequest, IbusFleetSummary

router = APIRouter(
    prefix="/ibus",
    tags=["TMB iBus"],
    dependencies=[Depends(require_api_key)],
)


@router.post(
    "/fleet",
    response_model=IbusFleetSummary,
    response_class=ORJSONResponse,
    summary="Get live iBus arrivals around a route stop",
)
async def get_fleet_summary(
    request: Request,
    payload: IbusFleetLookupRequest,
) -> IbusFleetSummary:
    """Use one cached iBus stop snapshot for every driver at that stop."""
    service = request.app.state.tmb_ibus_service
    return await service.get_fleet_summary(
        route_id=payload.route_id,
        trip_id=payload.trip_id,
        direction_id=payload.direction_id,
        stop_id=payload.stop_id,
        scheduled_departure_epoch=payload.scheduled_departure_epoch,
    )
