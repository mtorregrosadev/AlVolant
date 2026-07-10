"""
Route-TMB BFF — Main Application Entry Point.

This is the FastAPI application factory.  It wires together all components
(cache, services, workers, routers) using the ``lifespan`` context manager
pattern for clean startup and shutdown.

Startup sequence:
    1. Configure logging
    2. Connect to Redis
    3. Initialize HTTP clients for TMB, AMB, ATM services
    4. Load static GTFS shapes into Redis
    5. Start AMB background worker (30-second polling loop)
    6. Start TMB background worker (configurable polling loop)

Shutdown sequence:
    1. Stop background workers (graceful cancellation)
    2. Close HTTP clients
    3. Close Redis connection pool

Usage:
    uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse

from app.api.health import router as health_router
from app.api.v1.router import v1_router
from app.cache.redis_manager import CacheManager
from app.config import settings
from app.core.exceptions import register_exception_handlers
from app.core.logging import get_logger, setup_logging
from app.core.rate_limiter import RateLimiterMiddleware
from app.services.atm_rt_service import ATMRTService
from app.services.gtfs_service import GTFSService
from app.services.traffic_service import TrafficService
from app.workers.atm_rt_worker import ATMRTWorker

logger = get_logger(__name__)


async def _refresh_gtfs_cache(gtfs_service: GTFSService) -> None:
    """Refresh static GTFS data without blocking API startup."""
    try:
        route_count = await gtfs_service.load_and_cache_shapes()
        logger.info("Loaded %d route shapes into cache", route_count)
    except asyncio.CancelledError:
        logger.info("GTFS cache refresh cancelled")
        raise
    except Exception:
        logger.exception(
            "Failed to refresh GTFS shapes — cached shapes remain available "
            "until the next refresh"
        )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan context manager.

    Handles all startup initialization and shutdown cleanup in a single,
    readable block.  All stateful objects are stored on ``app.state`` so
    they can be accessed by route handlers via ``request.app.state``.
    """
    # =================================================================
    # STARTUP
    # =================================================================
    setup_logging(settings.LOG_LEVEL)
    logger.info("=" * 60)
    logger.info("Route-TMB BFF starting up...")
    logger.info("=" * 60)

    # --- 0. Security Configuration ---
    if not settings.BFF_API_KEY:
        logger.warning(
            "⚠️  BFF_API_KEY is not set! All authenticated endpoints will "
            "reject requests. Set BFF_API_KEY in .env for production."
        )
    app.state.api_key = settings.BFF_API_KEY
    app.state.settings = settings

    # --- 1. Redis Cache ---
    cache = CacheManager(redis_url=settings.REDIS_URL)
    await cache.connect()
    app.state.cache = cache

    # --- 2. Services ---
    atm_rt_service = ATMRTService(settings=settings, cache=cache)
    await atm_rt_service.start()
    app.state.atm_rt_service = atm_rt_service

    gtfs_service = GTFSService(settings=settings, cache=cache)
    await gtfs_service.start()
    app.state.gtfs_service = gtfs_service

    traffic_service = TrafficService(settings=settings)
    await traffic_service.start()
    app.state.traffic_service = traffic_service

    # --- 3. Refresh Static GTFS Shapes ---
    # Keep startup fast: if Redis already has static GTFS data, serve it
    # immediately and avoid blocking the API with a heavy parse pass.
    gtfs_load_task: asyncio.Task[None] | None = None
    cached_routes = await gtfs_service.get_all_routes()
    if cached_routes:
        logger.info("Using %d cached GTFS routes", len(cached_routes))
    else:
        gtfs_load_task = asyncio.create_task(_refresh_gtfs_cache(gtfs_service))
    app.state.gtfs_load_task = gtfs_load_task

    # --- 4. Background Workers ---
    atm_rt_worker = ATMRTWorker(
        settings=settings,
        service=atm_rt_service,
        cache=cache,
    )
    app.state.atm_rt_worker = atm_rt_worker
    await atm_rt_worker.start()

    logger.info("All services and workers started successfully")
    logger.info("=" * 60)
    logger.info("Route-TMB BFF ready — listening on %s:%d", settings.SERVER_HOST, settings.SERVER_PORT)
    logger.info("API docs available at http://%s:%d/docs", settings.SERVER_HOST, settings.SERVER_PORT)
    logger.info("=" * 60)

    # --- Hand control to the application ---
    yield

    # =================================================================
    # SHUTDOWN
    # =================================================================
    logger.info("Route-TMB BFF shutting down...")

    # --- Stop workers ---
    await atm_rt_worker.stop()

    # --- Stop cache refresh ---
    if gtfs_load_task:
        gtfs_load_task.cancel()
        try:
            await gtfs_load_task
        except asyncio.CancelledError:
            pass

    # --- Close services ---
    await atm_rt_service.close()
    await gtfs_service.close()
    await traffic_service.close()

    # --- Close Redis ---
    await cache.close()

    logger.info("Route-TMB BFF shutdown complete")


# =========================================================================
# Application Factory
# =========================================================================

app = FastAPI(
    title="Route-TMB BFF",
    description=(
        "Backend-for-Frontend server providing real-time transit data "
        "for Barcelona bus driver tablets. Aggregates ATM "
        "GTFS-Realtime and static GTFS data behind a Redis cache layer."
    ),
    version="0.2.0",
    lifespan=lifespan,
    default_response_class=ORJSONResponse,
    docs_url="/docs",
    redoc_url="/redoc",
)

# --- CORS Middleware ---
# Parse allowed origins from configuration.  Empty string means no
# cross-origin requests are allowed (same-origin only).
_cors_origins: list[str] = [
    origin.strip()
    for origin in settings.CORS_ALLOWED_ORIGINS.split(",")
    if origin.strip()
]

if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "OPTIONS"],
        allow_headers=["X-API-Key", "Content-Type", "Accept"],
    )
    logger.info("CORS enabled for origins: %s", _cors_origins)
else:
    # No CORS at all — only same-origin requests allowed
    logger.info("CORS disabled — same-origin only")

# --- Rate Limiter Middleware ---
app.add_middleware(
    RateLimiterMiddleware,
    rpm=settings.RATE_LIMIT_RPM,
)

# --- Exception Handlers ---
register_exception_handlers(app)

# --- Routers ---
app.include_router(health_router)
app.include_router(v1_router)
