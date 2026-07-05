"""
Health check and readiness probe endpoints.

These endpoints are used by orchestrators (Docker, Kubernetes) and load
balancers to determine the application's liveness and readiness status.

    GET /health       → Liveness probe (always 200 if the process is alive)
    GET /health/ready → Readiness probe (checks Redis + worker status)
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import ORJSONResponse

from app.core.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/health", tags=["Health"])


@router.get(
    "",
    summary="Liveness probe",
    response_class=ORJSONResponse,
)
async def liveness() -> dict:
    """Return 200 OK if the server process is running.

    This endpoint does NOT check backend dependencies — it only
    confirms that the FastAPI process is alive and accepting requests.
    """
    return {"status": "alive"}


@router.get(
    "/ready",
    summary="Readiness probe",
    response_class=ORJSONResponse,
)
async def readiness(request: Request) -> dict:
    """Check whether all backend dependencies are healthy.

    Verifies:
    - Redis connectivity (PING)
    - Background worker status (AMB, TMB)

    Returns 200 with a detailed status object if all checks pass,
    or 503 with degraded status if any dependency is unhealthy.
    """
    app = request.app

    # --- Redis health ---
    redis_ok = False
    try:
        cache = app.state.cache
        redis_ok = await cache.health_check()
    except Exception:
        logger.warning("Redis health check failed during readiness probe")

    # --- Worker health ---
    workers_status = {}
    amb_worker = getattr(app.state, "amb_worker", None)
    tmb_worker = getattr(app.state, "tmb_worker", None)

    if amb_worker:
        workers_status["amb"] = amb_worker.stats
    if tmb_worker:
        workers_status["tmb"] = tmb_worker.stats

    # --- Overall status ---
    all_healthy = redis_ok
    status = "ready" if all_healthy else "degraded"

    response_data = {
        "status": status,
        "checks": {
            "redis": {"connected": redis_ok},
            "workers": workers_status,
        },
    }

    if not all_healthy:
        return ORJSONResponse(content=response_data, status_code=503)

    return response_data
