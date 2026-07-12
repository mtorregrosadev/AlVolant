"""Request correlation and safe server performance telemetry middleware."""

from __future__ import annotations

import secrets
import time

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response


class TelemetryMiddleware(BaseHTTPMiddleware):
    """Measure route templates without storing IPs, query strings or bodies."""

    async def dispatch(
        self,
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        started_at = time.perf_counter()
        request_id = secrets.token_hex(8)
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            response.headers["X-Request-ID"] = request_id
            return response
        finally:
            service = getattr(request.app.state, "telemetry", None)
            if service is not None:
                route = request.scope.get("route")
                endpoint = getattr(route, "path", None) or "unmatched"
                service.record_server_request(
                    endpoint=endpoint,
                    method=request.method,
                    status=status_code,
                    duration_ms=min(60_000, round((time.perf_counter() - started_at) * 1000)),
                )
