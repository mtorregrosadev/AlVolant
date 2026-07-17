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
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress
from ipaddress import ip_network
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import ORJSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.health import router as health_router
from app.api.satellite import router as satellite_router
from app.api.v1.router import v1_router
from app.cache.redis_manager import CacheManager
from app.config import Settings, settings
from app.core.exceptions import register_exception_handlers
from app.core.logging import get_logger, setup_logging
from app.core.rate_limiter import RateLimiterMiddleware
from app.core.security import RequestBodyLimitMiddleware, SecurityHeadersMiddleware
from app.core.telemetry import TelemetryMiddleware
from app.services.atm_rt_service import ATMRTService
from app.services.gtfs_service import GTFSService
from app.services.relief_matching_service import ReliefMatchingService
from app.services.satellite_tile_service import SatelliteTileService
from app.services.telemetry_service import TelemetryService
from app.services.tmb_ibus_service import TMBIbusService
from app.services.traffic_service import TrafficService
from app.workers.atm_rt_worker import ATMRTWorker

logger = get_logger(__name__)

_INSECURE_SECRET_MARKERS = ("replace-", "replace_", "placeholder", "example", "change-me")


def _is_strong_runtime_secret(value: str, minimum_length: int = 32) -> bool:
    normalized = value.casefold()
    return (
        len(value.encode("utf-8")) >= minimum_length
        and len(set(value)) >= 8
        and not any(character.isspace() or ord(character) < 32 for character in value)
        and not any(marker in normalized for marker in _INSECURE_SECRET_MARKERS)
    )


def _read_runtime_secret(
    path_value: str,
    *,
    label: str,
    environment: str,
    minimum_bytes: int = 1,
) -> str:
    secret_path = Path(path_value)
    try:
        resolved_path = secret_path.resolve(strict=True)
    except OSError:
        raise RuntimeError(f"Unable to read the configured {label}") from None
    if environment == "production" and not resolved_path.is_relative_to(Path("/run/secrets")):
        raise RuntimeError(f"{label} must be mounted below /run/secrets in production")
    try:
        raw_value = resolved_path.read_bytes()
    except OSError:
        raise RuntimeError(f"Unable to read the configured {label}") from None
    if not 1 <= len(raw_value) <= 512 or b"\x00" in raw_value:
        raise RuntimeError(f"{label} has an invalid length or encoding")
    try:
        value = raw_value.decode("utf-8").strip()
    except UnicodeDecodeError:
        raise RuntimeError(f"{label} must be valid UTF-8") from None
    if len(value.encode("utf-8")) < minimum_bytes:
        raise RuntimeError(f"{label} is shorter than the required minimum")
    if not value or any(character.isspace() for character in value):
        raise RuntimeError(f"{label} cannot be empty or contain whitespace")
    if minimum_bytes >= 16 and not _is_strong_runtime_secret(value, minimum_bytes):
        raise RuntimeError(f"{label} does not contain enough entropy")
    return value


def _resolve_runtime_settings(app_settings: Settings) -> Settings:
    """Load Docker/Kubernetes secret files into an in-memory settings copy."""
    updates: dict[str, str] = {}
    for value_field, file_field, label, minimum_bytes in (
        ("BFF_API_KEY", "BFF_API_KEY_FILE", "BFF API key secret", 32),
        (
            "RATE_LIMIT_HASH_KEY",
            "RATE_LIMIT_HASH_KEY_FILE",
            "rate-limit HMAC secret",
            32,
        ),
        ("TOMTOM_API_KEY", "TOMTOM_API_KEY_FILE", "TomTom API key secret", 1),
        ("ARCGIS_API_KEY", "ARCGIS_API_KEY_FILE", "ArcGIS API key secret", 1),
        ("TMB_APP_ID", "TMB_APP_ID_FILE", "TMB app identifier secret", 1),
        ("TMB_APP_KEY", "TMB_APP_KEY_FILE", "TMB app key secret", 1),
    ):
        file_path = getattr(app_settings, file_field)
        if file_path:
            updates[value_field] = _read_runtime_secret(
                file_path,
                label=label,
                environment=app_settings.ENVIRONMENT,
                minimum_bytes=minimum_bytes,
            )
    return app_settings.model_copy(update=updates) if updates else app_settings


def _resolve_redis_url(app_settings: Settings) -> str:
    """Resolve an optional runtime secret file without exposing it to logs/env."""
    if not app_settings.REDIS_PASSWORD_FILE:
        return app_settings.REDIS_URL

    password = _read_runtime_secret(
        app_settings.REDIS_PASSWORD_FILE,
        label="Redis password secret",
        environment=app_settings.ENVIRONMENT,
        minimum_bytes=32,
    )

    username = app_settings.REDIS_USERNAME.strip()
    if not username or any(character.isspace() for character in username):
        raise RuntimeError("REDIS_USERNAME is required when using a password secret")
    if not 1 <= app_settings.REDIS_PORT <= 65_535 or not 0 <= app_settings.REDIS_DB <= 15:
        raise RuntimeError("Redis port or database number is outside the supported range")
    scheme = "rediss" if app_settings.REDIS_USE_TLS else "redis"
    return (
        f"{scheme}://{quote(username, safe='')}:{quote(password, safe='')}@"
        f"{app_settings.REDIS_HOST}:{app_settings.REDIS_PORT}/{app_settings.REDIS_DB}"
    )


def _validate_security_settings(
    app_settings: Settings = settings,
    redis_connection_url: str | None = None,
) -> None:
    """Fail fast on configurations that are unsafe outside development."""
    if app_settings.ENVIRONMENT != "production":
        return

    errors: list[str] = []
    if not _is_strong_runtime_secret(app_settings.BFF_API_KEY):
        errors.append("BFF_API_KEY must be a high-entropy value of at least 32 characters")
    if not _is_strong_runtime_secret(app_settings.RATE_LIMIT_HASH_KEY):
        errors.append("RATE_LIMIT_HASH_KEY must be a high-entropy server-only secret")
    trusted_hosts = {item.strip() for item in app_settings.TRUSTED_HOSTS.split(",") if item.strip()}
    if not trusted_hosts or "*" in trusted_hosts:
        errors.append("TRUSTED_HOSTS must be an explicit production allow-list")
    cors_origins = {
        item.strip() for item in app_settings.CORS_ALLOWED_ORIGINS.split(",") if item.strip()
    }
    if "*" in cors_origins:
        errors.append("CORS_ALLOWED_ORIGINS cannot contain '*' in production")
    if app_settings.DOCS_ENABLED:
        errors.append("DOCS_ENABLED must be false in production")
    forwarded_allow_ips = [
        item.strip() for item in app_settings.FORWARDED_ALLOW_IPS.split(",") if item.strip()
    ]
    if not forwarded_allow_ips or "*" in forwarded_allow_ips:
        errors.append("FORWARDED_ALLOW_IPS must be an explicit trusted proxy allow-list")
    else:
        try:
            for item in forwarded_allow_ips:
                network = ip_network(item, strict=False)
                minimum_prefix = 8 if network.version == 4 else 32
                if network.prefixlen < minimum_prefix:
                    raise ValueError
        except ValueError:
            errors.append("FORWARDED_ALLOW_IPS contains an invalid IP address or network")
    try:
        redis_url = urlsplit(redis_connection_url or app_settings.REDIS_URL)
        redis_port = redis_url.port
    except ValueError:
        redis_url = None
        redis_port = None
    if (
        redis_url is None
        or redis_url.scheme not in {"redis", "rediss"}
        or not redis_url.hostname
        or redis_url.password is None
        or not redis_url.password
        or not redis_url.username
        or redis_url.username.lower() == "default"
        or redis_url.fragment
        or redis_url.query
        or not redis_url.path.removeprefix("/").isdigit()
        or redis_port is not None
        and not 1 <= redis_port <= 65_535
    ):
        errors.append("REDIS_URL must be a valid authenticated redis:// or rediss:// URL")
    elif not _is_strong_runtime_secret(unquote(redis_url.password)):
        errors.append("Redis authentication must use a high-entropy password")
    elif redis_url.scheme != "rediss" and redis_url.hostname not in {
        "redis",
        "localhost",
        "127.0.0.1",
        "::1",
    }:
        errors.append("Remote Redis connections must use TLS (rediss://)")
    if errors:
        raise RuntimeError("Unsafe production configuration: " + "; ".join(errors))


async def _refresh_gtfs_cache(gtfs_service: GTFSService) -> bool:
    """Refresh static GTFS data without blocking API startup."""
    try:
        route_count = await gtfs_service.load_and_cache_shapes()
        logger.info("Loaded %d route shapes into cache", route_count)
        return True
    except asyncio.CancelledError:
        logger.info("GTFS cache refresh cancelled")
        raise
    except Exception:
        logger.exception(
            "Failed to refresh GTFS shapes — cached shapes remain available until the next refresh"
        )
        return False


async def _periodic_gtfs_refresh(
    gtfs_service: GTFSService,
    *,
    refresh_immediately: bool,
) -> None:
    """Refresh before expiry and retry provider failures with bounded backoff."""
    delay = 0 if refresh_immediately else await gtfs_service.seconds_until_refresh()
    failure_delay = 60
    while True:
        if delay:
            await asyncio.sleep(delay)
        succeeded = await _refresh_gtfs_cache(gtfs_service)
        if succeeded:
            failure_delay = 60
            delay = await gtfs_service.seconds_until_refresh()
        else:
            delay = failure_delay
            failure_delay = min(failure_delay * 3, 900)


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
    runtime_settings = _resolve_runtime_settings(settings)
    setup_logging(
        runtime_settings.LOG_LEVEL,
        json_logs=runtime_settings.ENVIRONMENT == "production",
    )
    redis_connection_url = _resolve_redis_url(runtime_settings)
    _validate_security_settings(runtime_settings, redis_connection_url)
    logger.info("=" * 60)
    logger.info("Route-TMB BFF starting up...")
    logger.info("=" * 60)

    # --- 0. Security Configuration ---
    if not runtime_settings.BFF_API_KEY:
        logger.warning(
            "⚠️  BFF_API_KEY is not set! All authenticated endpoints will "
            "reject requests. Set BFF_API_KEY in .env for production."
        )
    app.state.api_key = runtime_settings.BFF_API_KEY
    app.state.rate_limit_hash_key = runtime_settings.RATE_LIMIT_HASH_KEY
    app.state.settings = runtime_settings

    # --- 1. Redis Cache ---
    cache = CacheManager(redis_url=redis_connection_url)
    await cache.connect()
    app.state.cache = cache

    telemetry = TelemetryService(
        cache,
        enabled=runtime_settings.TELEMETRY_ENABLED,
        retention_days=runtime_settings.TELEMETRY_RETENTION_DAYS,
        max_events_per_day=runtime_settings.TELEMETRY_MAX_EVENTS_PER_DAY,
        max_errors_per_day=runtime_settings.TELEMETRY_MAX_ERRORS_PER_DAY,
        queue_size=runtime_settings.TELEMETRY_QUEUE_SIZE,
    )
    await telemetry.start()
    app.state.telemetry = telemetry

    # --- 2. Services ---
    atm_rt_service = ATMRTService(settings=runtime_settings, cache=cache)
    await atm_rt_service.start()
    app.state.atm_rt_service = atm_rt_service

    gtfs_service = GTFSService(settings=runtime_settings, cache=cache)
    await gtfs_service.start()
    app.state.gtfs_service = gtfs_service

    app.state.relief_matching_service = ReliefMatchingService(
        atm_rt_service,
        gtfs_service,
        freshness_seconds=atm_rt_service.freshness_window_seconds,
    )

    traffic_service = TrafficService(settings=runtime_settings, cache=cache)
    await traffic_service.start()
    app.state.traffic_service = traffic_service

    tmb_ibus_service = TMBIbusService(
        settings=runtime_settings,
        cache=cache,
        gtfs_service=gtfs_service,
    )
    await tmb_ibus_service.start()
    app.state.tmb_ibus_service = tmb_ibus_service

    satellite_tile_service = SatelliteTileService(settings=runtime_settings, cache=cache)
    await satellite_tile_service.start()
    app.state.satellite_tile_service = satellite_tile_service

    # --- 3. Refresh Static GTFS Shapes ---
    # Keep startup fast: if Redis already has static GTFS data, serve it
    # immediately and avoid blocking the API with a heavy parse pass.
    cache_complete = await gtfs_service.has_complete_cache()
    cached_routes = await gtfs_service.get_all_routes()
    if cache_complete:
        logger.info("Using %d cached GTFS routes", len(cached_routes))
    elif cached_routes:
        logger.info("Legacy/incomplete GTFS cache detected — starting v2 migration refresh")
    gtfs_refresh_task = asyncio.create_task(
        _periodic_gtfs_refresh(
            gtfs_service,
            refresh_immediately=not cache_complete,
        ),
        name="gtfs-periodic-refresh",
    )
    app.state.gtfs_refresh_task = gtfs_refresh_task

    # --- 4. Background Workers ---
    atm_rt_worker = ATMRTWorker(
        settings=runtime_settings,
        service=atm_rt_service,
        cache=cache,
    )
    app.state.atm_rt_worker = atm_rt_worker
    await atm_rt_worker.start()

    logger.info("All services and workers started successfully")
    logger.info("=" * 60)
    logger.info(
        "Route-TMB BFF ready — listening on %s:%d",
        runtime_settings.SERVER_HOST,
        runtime_settings.SERVER_PORT,
    )
    if runtime_settings.DOCS_ENABLED:
        logger.info(
            "API docs available at http://%s:%d/docs",
            runtime_settings.SERVER_HOST,
            runtime_settings.SERVER_PORT,
        )
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
    gtfs_refresh_task.cancel()
    with suppress(asyncio.CancelledError):
        await gtfs_refresh_task

    # --- Close services ---
    await atm_rt_service.close()
    await gtfs_service.close()
    await traffic_service.close()
    await tmb_ibus_service.close()
    await satellite_tile_service.close()

    # Flush diagnostics while Redis is still available.
    await telemetry.close()

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
    docs_url="/docs" if settings.DOCS_ENABLED else None,
    redoc_url="/redoc" if settings.DOCS_ENABLED else None,
    openapi_url="/openapi.json" if settings.DOCS_ENABLED else None,
)

app.add_middleware(GZipMiddleware, minimum_size=max(500, settings.GZIP_MINIMUM_SIZE))

# --- CORS Middleware ---
# Parse allowed origins from configuration.  Empty string means no
# cross-origin requests are allowed (same-origin only).
_cors_origins: list[str] = [
    origin.strip() for origin in settings.CORS_ALLOWED_ORIGINS.split(",") if origin.strip()
]

if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["X-API-Key", "Content-Type", "Accept"],
        expose_headers=["X-Request-ID"],
    )
    logger.info("CORS enabled for origins: %s", _cors_origins)
else:
    # No CORS at all — only same-origin requests allowed
    logger.info("CORS disabled — same-origin only")

# Telemetry stays inside request-size and rate boundaries, so rejected or
# deliberately slow bodies cannot occupy the diagnostics queue.
app.add_middleware(TelemetryMiddleware)

# Buffer only bounded bodies. The rate limiter is added afterwards and is
# therefore outside this middleware, so a client consumes its bucket before
# the server waits for a chunked request body.
app.add_middleware(
    RequestBodyLimitMiddleware,
    max_bytes=settings.MAX_REQUEST_BODY_BYTES,
    receive_timeout_seconds=settings.REQUEST_BODY_TIMEOUT_SECONDS,
)

app.add_middleware(
    RateLimiterMiddleware,
    rpm=settings.RATE_LIMIT_RPM,
)

# Keep host and response-header checks outermost. This guarantees uniform
# headers even on 413/429/503/CORS responses.
_trusted_hosts = [host.strip() for host in settings.TRUSTED_HOSTS.split(",") if host.strip()]
if _trusted_hosts:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=_trusted_hosts)
app.add_middleware(SecurityHeadersMiddleware)

# --- Exception Handlers ---
register_exception_handlers(app)

# --- Routers ---
app.include_router(health_router)
app.include_router(satellite_router)
app.include_router(v1_router)
