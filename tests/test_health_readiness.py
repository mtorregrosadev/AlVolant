"""Readiness must distinguish core availability from external feed degradation."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.health import router as health_router


def _app(
    *,
    redis_ok: bool,
    gtfs_ok: bool,
    freshness: dict[str, bool],
    redis_writable: bool | None = None,
) -> FastAPI:
    app = FastAPI()
    app.state.cache = SimpleNamespace(
        health_check=AsyncMock(return_value=redis_ok),
        writable_health_check=AsyncMock(
            return_value=redis_ok if redis_writable is None else redis_writable
        ),
    )
    app.state.gtfs_service = SimpleNamespace(
        has_complete_cache=AsyncMock(return_value=gtfs_ok)
    )
    app.state.atm_rt_service = SimpleNamespace(
        get_component_freshness=AsyncMock(return_value=freshness)
    )
    app.state.atm_rt_worker = SimpleNamespace(
        status=lambda: {"running": True, "interval_seconds": 30}
    )
    app.include_router(health_router)
    return app


def test_readiness_stays_available_during_external_realtime_degradation() -> None:
    app = _app(
        redis_ok=True,
        gtfs_ok=True,
        freshness={"trip_updates": True, "vehicle_positions": False, "alerts": True},
    )

    with TestClient(app) as client:
        response = client.get("/health/ready")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ready",
        "checks": {
            "redis": {"connected": True},
            "gtfs": {"loaded": True},
            "realtime": {"running": True, "fresh": False, "partial": True},
        },
        "degraded_features": ["realtime"],
    }


def test_readiness_rejects_when_core_cache_or_routes_are_unavailable() -> None:
    app = _app(
        redis_ok=False,
        gtfs_ok=False,
        freshness={"trip_updates": False, "vehicle_positions": False, "alerts": False},
    )

    with TestClient(app) as client:
        response = client.get("/health/ready")

    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"


def test_readiness_rejects_read_only_or_out_of_memory_redis() -> None:
    app = _app(
        redis_ok=True,
        redis_writable=False,
        gtfs_ok=True,
        freshness={"trip_updates": True, "vehicle_positions": True, "alerts": True},
    )

    with TestClient(app) as client:
        response = client.get("/health/ready")

    assert response.status_code == 503
    assert response.json()["checks"]["redis"] == {"connected": False}
