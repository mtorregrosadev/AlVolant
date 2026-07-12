"""Write-only mobile telemetry endpoint.

Reports are deliberately not exposed through the HTTP API. Maintainers inspect
the short-lived Redis data locally with ``scripts/telemetry_report.py``.
"""

from fastapi import APIRouter, Depends, Request, status

from app.core.auth import require_api_key
from app.models.telemetry import TelemetryAccepted, TelemetryBatch

router = APIRouter(
    prefix="/telemetry",
    tags=["Telemetry"],
    dependencies=[Depends(require_api_key)],
)


@router.post(
    "/events",
    response_model=TelemetryAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def ingest_telemetry(batch: TelemetryBatch, request: Request) -> TelemetryAccepted:
    """Validate and enqueue a bounded batch without logging its request body."""
    telemetry = request.app.state.telemetry
    accepted = sum(1 for event in batch.events if telemetry.enqueue_client_event(event))
    return TelemetryAccepted(accepted=accepted, dropped=len(batch.events) - accepted)
