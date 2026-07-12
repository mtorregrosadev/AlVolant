"""
Custom exception classes and FastAPI exception handlers.

Provides a hierarchy of domain-specific exceptions that map cleanly to
HTTP status codes, plus handler functions that return consistent JSON
error responses to the tablet clients.

Usage:
    from app.core.exceptions import ExternalAPIError, CacheError

    raise ExternalAPIError("TMB", "Connection timeout after 5s")
"""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.core.logging import get_logger

logger = get_logger(__name__)


# =============================================================================
# Exception Classes
# =============================================================================


class BFFBaseError(Exception):
    """Base exception for all BFF-specific errors."""

    def __init__(self, message: str = "An unexpected error occurred") -> None:
        self.message = message
        super().__init__(self.message)


class ExternalAPIError(BFFBaseError):
    """Raised when an external API (TMB, AMB, ATM) request fails.

    Attributes:
        source: Name of the external service (e.g., "TMB", "AMB").
        detail: Human-readable description of what went wrong.
    """

    def __init__(self, source: str, detail: str) -> None:
        self.source = source
        self.detail = detail
        super().__init__(f"[{source}] {detail}")


class CacheError(BFFBaseError):
    """Raised when a Redis cache operation fails."""

    def __init__(self, operation: str, detail: str) -> None:
        self.operation = operation
        self.detail = detail
        super().__init__(f"Cache {operation} failed: {detail}")


class GTFSParseError(BFFBaseError):
    """Raised when a GTFS file cannot be parsed."""

    def __init__(self, filename: str, detail: str) -> None:
        self.filename = filename
        self.detail = detail
        super().__init__(f"Failed to parse GTFS file '{filename}': {detail}")


class ServiceUnavailableError(BFFBaseError):
    """Raised when a required backend service is not available."""

    def __init__(self, service: str) -> None:
        self.service = service
        super().__init__(f"Service '{service}' is currently unavailable")


# =============================================================================
# FastAPI Exception Handlers
# =============================================================================


def register_exception_handlers(app: FastAPI) -> None:
    """Register all custom exception handlers on the FastAPI application.

    Args:
        app: The FastAPI application instance.
    """

    @app.exception_handler(ExternalAPIError)
    async def handle_external_api_error(
        request: Request,
        exc: ExternalAPIError,
    ) -> JSONResponse:
        logger.error("External provider failure: %s", exc.source)
        return JSONResponse(
            status_code=502,
            content={
                "error": "external_api_error",
                "source": exc.source,
                "detail": "The upstream provider could not complete the request.",
            },
        )

    @app.exception_handler(CacheError)
    async def handle_cache_error(
        request: Request,
        exc: CacheError,
    ) -> JSONResponse:
        logger.error("Cache operation failed: %s", exc.operation)
        return JSONResponse(
            status_code=503,
            content={
                "error": "cache_error",
                "detail": "The cache service is temporarily unavailable.",
            },
        )

    @app.exception_handler(ServiceUnavailableError)
    async def handle_service_unavailable(
        request: Request,
        exc: ServiceUnavailableError,
    ) -> JSONResponse:
        logger.error("Service unavailable: %s", exc.service)
        return JSONResponse(
            status_code=503,
            content={
                "error": "service_unavailable",
                "service": exc.service,
            },
        )

    @app.exception_handler(Exception)
    async def handle_unhandled_exception(
        request: Request,
        exc: Exception,
    ) -> JSONResponse:
        telemetry = getattr(request.app.state, "telemetry", None)
        if telemetry is not None:
            route = request.scope.get("route")
            telemetry.record_server_error(
                endpoint=getattr(route, "path", None) or "unmatched",
                error_type=type(exc).__name__,
            )
        logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={
                "error": "internal_server_error",
                "detail": "An unexpected error occurred. Please try again later.",
            },
        )
