"""
Health check and readiness probe endpoints.

These endpoints are used by orchestrators (Docker, Kubernetes) and load
balancers to determine the application's liveness and readiness status.

    GET /health       → Liveness probe (always 200 if the process is alive)
    GET /health/ready → Readiness probe (checks Redis + worker status)

These endpoints are EXEMPT from API key authentication so that
orchestrators can probe without credentials.
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
    - Redis connectivity (PING) and key count
    - Background worker status (ATM RT)

    Returns 200 with a detailed status object if all checks pass,
    or 503 with degraded status if any dependency is unhealthy.
    """
    app = request.app

    # --- Redis health ---
    redis_ok = False
    redis_keys = -1
    try:
        cache = app.state.cache
        redis_ok = await cache.health_check()
        if redis_ok:
            redis_keys = await cache.key_count()
    except Exception:
        logger.warning("Redis health check failed during readiness probe")

    # --- Worker health ---
    workers_status = {}
    atm_rt_worker = getattr(app.state, "atm_rt_worker", None)
    if atm_rt_worker:
        workers_status["atm_rt"] = atm_rt_worker.status()

    # --- Overall status ---
    all_healthy = redis_ok
    status = "ready" if all_healthy else "degraded"

    response_data = {
        "status": status,
        "checks": {
            "redis": {
                "connected": redis_ok,
                "key_count": redis_keys,
            },
            "workers": workers_status,
        },
    }

    if not all_healthy:
        return ORJSONResponse(content=response_data, status_code=503)

    return response_data
