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
from app.services.atm_rt_service import ATMRTService
from app.services.gtfs_service import GTFSService
from app.workers.atm_rt_worker import ATMRTWorker

logger = get_logger(__name__)


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

    # --- 3. Load Static GTFS Shapes ---
    try:
        route_count = await gtfs_service.load_and_cache_shapes()
        logger.info("Loaded %d route shapes into cache", route_count)
    except Exception:
        logger.exception(
            "Failed to load GTFS shapes on startup — shapes will be unavailable "
            "until the next scheduled refresh or manual reload"
        )

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

    # --- Close services ---
    await atm_rt_service.close()
    await gtfs_service.close()

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
    version="0.1.0",
    lifespan=lifespan,
    default_response_class=ORJSONResponse,
    docs_url="/docs",
    redoc_url="/redoc",
)

# --- CORS Middleware ---
# Allow tablet app origins.  In production, restrict to the specific
# domain/IP of the tablet fleet management system.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: Restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Exception Handlers ---
register_exception_handlers(app)

# --- Routers ---
app.include_router(health_router)
app.include_router(v1_router)
