"""
Redis-backed sliding window rate limiter middleware.

Limits the number of requests per IP address within a configurable window
to prevent DDoS attacks and API abuse.  Uses Redis INCR + EXPIRE for
an efficient, distributed counter.

The middleware is applied globally but exempts health-check paths so
orchestrators can always probe the server.

Implementation notes:
- Uses a sliding window approximation (fixed window with per-minute keys)
- Falls open on Redis errors (allows the request through) to avoid
  self-inflicted outages when Redis is temporarily unreachable
- Returns standard ``429 Too Many Requests`` with ``Retry-After`` header

Usage::

    from app.core.rate_limiter import RateLimiterMiddleware

    app.add_middleware(RateLimiterMiddleware, redis_url="redis://...", rpm=60)
"""

from __future__ import annotations

import time

import redis.asyncio as aioredis
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.core.logging import get_logger

logger = get_logger(__name__)

# Paths exempt from rate limiting (health probes, docs)
_EXEMPT_PATHS = frozenset({
    "/health",
    "/health/ready",
    "/docs",
    "/redoc",
    "/openapi.json",
})

_KEY_PREFIX = "rl:"


class RateLimiterMiddleware(BaseHTTPMiddleware):
    """HTTP middleware that enforces per-IP rate limits via Redis.

    Args:
        app: The ASGI application.
        rpm: Maximum requests per minute per IP address.
    """

    def __init__(self, app, rpm: int = 60) -> None:  # noqa: ANN001
        super().__init__(app)
        self.rpm = rpm
        self._window = 60  # seconds

    async def dispatch(
        self,
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        """Check rate limit before forwarding the request."""
        # Skip rate limiting for exempt paths
        if request.url.path in _EXEMPT_PATHS:
            return await call_next(request)

        # Skip WebSocket upgrades (handled separately inside the WS handler)
        if request.headers.get("upgrade", "").lower() == "websocket":
            return await call_next(request)

        # Extract client IP (support X-Forwarded-For for proxied setups)
        client_ip = _get_client_ip(request)

        # Build the per-minute key
        current_minute = int(time.time()) // self._window
        key = f"{_KEY_PREFIX}{client_ip}:{current_minute}"

        # Try to check/increment the counter in Redis
        try:
            cache = request.app.state.cache
            redis_client = cache.client

            # INCR is atomic — returns the new count after increment
            count = await redis_client.incr(key)

            # Set TTL only on the first request (count == 1)
            if count == 1:
                await redis_client.expire(key, self._window + 5)  # +5s buffer

            if count > self.rpm:
                retry_after = self._window - (int(time.time()) % self._window)
                logger.warning(
                    "Rate limit exceeded: %s (%d/%d) on %s %s",
                    client_ip,
                    count,
                    self.rpm,
                    request.method,
                    request.url.path,
                )
                return JSONResponse(
                    status_code=429,
                    content={
                        "error": "rate_limit_exceeded",
                        "detail": f"Too many requests. Limit: {self.rpm}/minute.",
                        "retry_after": retry_after,
                    },
                    headers={"Retry-After": str(retry_after)},
                )

            # Add rate limit headers to successful responses
            response = await call_next(request)
            response.headers["X-RateLimit-Limit"] = str(self.rpm)
            response.headers["X-RateLimit-Remaining"] = str(max(0, self.rpm - count))
            return response

        except Exception:
            # Fail open — if Redis is down, allow the request through
            # rather than causing a complete outage.
            logger.warning("Rate limiter Redis error — failing open for %s", client_ip)
            return await call_next(request)


def _get_client_ip(request: Request) -> str:
    """Extract the real client IP, respecting reverse proxy headers.

    Checks ``X-Forwarded-For`` first (common in Docker/K8s setups),
    then falls back to the direct connection IP.
    """
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        # X-Forwarded-For: client, proxy1, proxy2 — take the first
        return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


async def check_ws_rate_limit(
    redis_client: aioredis.Redis,
    client_ip: str,
    mpm: int = 120,
) -> bool:
    """Check WebSocket message rate limit (called per message).

    Args:
        redis_client: Active Redis client.
        client_ip: The client's IP address.
        mpm: Maximum messages per minute.

    Returns:
        ``True`` if the message is allowed, ``False`` if rate limited.
    """
    current_minute = int(time.time()) // 60
    key = f"{_KEY_PREFIX}ws:{client_ip}:{current_minute}"

    try:
        count = await redis_client.incr(key)
        if count == 1:
            await redis_client.expire(key, 65)
        return count <= mpm
    except Exception:
        # Fail open on Redis errors
        return True
