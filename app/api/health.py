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

import asyncio

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

    Verifies core readiness with O(1) checks:
    - Redis connectivity
    - Presence of the active GTFS route index

    Realtime freshness is reported as a degraded feature, but an external ATM
    outage does not force the healthy BFF into an orchestrator restart loop.

    Returns 200 with a detailed status object if all checks pass,
    or 503 with degraded status if any dependency is unhealthy.
    """
    app = request.app

    # --- Redis health ---
    redis_ok = False
    try:
        cache = app.state.cache
        redis_ok, redis_writable = await asyncio.gather(
            cache.health_check(),
            cache.writable_health_check(),
        )
        redis_ok = redis_ok and redis_writable
    except Exception:
        logger.warning("Redis health check failed during readiness probe")

    # --- Worker health ---
    workers_status = {}
    atm_rt_worker = getattr(app.state, "atm_rt_worker", None)
    if atm_rt_worker:
        workers_status["atm_rt"] = atm_rt_worker.status()

    # --- Data freshness ---
    gtfs_ready = False
    try:
        gtfs_ready = await app.state.gtfs_service.has_complete_cache()
    except Exception:
        logger.warning("GTFS readiness check failed")

    component_freshness: dict[str, bool] = {}
    try:
        component_freshness = await app.state.atm_rt_service.get_component_freshness()
    except Exception:
        logger.warning("Realtime freshness check failed")
    worker_running = bool(
        atm_rt_worker
        and workers_status.get("atm_rt", {}).get("running")
    )
    realtime_fresh = (
        worker_running
        and component_freshness.get("trip_updates", False)
        and component_freshness.get("vehicle_positions", False)
    )

    # --- Overall status ---
    core_ready = redis_ok and gtfs_ready
    status = "ready" if core_ready else "not_ready"

    response_data = {
        "status": status,
        "checks": {
            "redis": {"connected": redis_ok},
            "gtfs": {"loaded": gtfs_ready},
            "realtime": {
                "running": worker_running,
                "fresh": realtime_fresh,
                "partial": any(component_freshness.values()) and not realtime_fresh,
            },
        },
        "degraded_features": [] if realtime_fresh else ["realtime"],
    }

    # An external ATM outage degrades live positions but must not cause a
    # restart loop while cached GTFS routes remain fully usable.
    if not core_ready:
        return ORJSONResponse(content=response_data, status_code=503)

    return response_data
