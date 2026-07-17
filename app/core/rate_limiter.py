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

import hashlib
import hmac
import time
from typing import Literal

import redis.asyncio as aioredis
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.core.logging import get_logger

logger = get_logger(__name__)

# Only the cheap process-liveness probe bypasses Redis. Readiness and docs are
# rate-limited because they perform dependency work and must not be amplifiers.
_EXEMPT_PATHS = frozenset({"/health"})
# MapLibre cannot attach a private API-key header to a raster tile source.
# These tiles are nevertheless bounded at the route handler to Catalonia and
# fetched from a fixed provider; running the general API limiter on every
# image would make a normal map pan exceed the 60 RPM API budget.
_EXEMPT_PATH_PREFIXES = ("/maps/satellite/",)

_KEY_PREFIX = "rl:"
RateLimitDecision = Literal["allowed", "limited", "unavailable"]


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
        if request.url.path in _EXEMPT_PATHS or request.url.path.startswith(_EXEMPT_PATH_PREFIXES):
            return await call_next(request)

        # Skip WebSocket upgrades (handled separately inside the WS handler)
        if request.headers.get("upgrade", "").lower() == "websocket":
            return await call_next(request)

        # The ASGI server is the trust boundary for proxy handling.  Reading
        # X-Forwarded-For here would let direct clients choose their own rate
        # limit bucket unless every deployment had a correctly configured
        # trusted-proxy allowlist.
        client_ip = _get_client_ip(request)
        client_bucket = _hash_client_identifier(
            client_ip,
            getattr(request.app.state, "rate_limit_hash_key", ""),
        )

        # Build the per-minute key
        current_minute = int(time.time()) // self._window
        key = f"{_KEY_PREFIX}{client_bucket}:{current_minute}"

        # Check/increment the counter in Redis.  Keep the downstream request
        # outside this try block so an application exception is never mistaken
        # for a Redis outage and executed a second time.
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
                    "Rate limit exceeded (%d/%d) on %s %s",
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

        except Exception:
            settings = getattr(request.app.state, "settings", None)
            if getattr(settings, "ENVIRONMENT", "development") == "production":
                logger.error("Rate limiter unavailable — rejecting production request")
                return JSONResponse(
                    status_code=503,
                    content={
                        "error": "rate_limiter_unavailable",
                        "detail": "Request protection is temporarily unavailable.",
                    },
                    headers={"Retry-After": "5"},
                )
            # Local development remains usable if its optional Redis process
            # is briefly restarting.
            logger.warning("Rate limiter unavailable — development request allowed")
            return await call_next(request)

        # Add rate limit headers to successful responses.
        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(self.rpm)
        response.headers["X-RateLimit-Remaining"] = str(max(0, self.rpm - count))
        return response


def _get_client_ip(request: Request) -> str:
    """Return the peer IP supplied by the ASGI server.

    Proxy headers are intentionally not parsed here.  A deployment that sits
    behind a reverse proxy must configure its ASGI server's trusted-proxy
    policy; after that validation, ``request.client.host`` is the appropriate
    source of truth.
    """
    if request.client:
        return request.client.host
    return "unknown"


def _hash_client_identifier(client_ip: str, secret: str) -> str:
    """Create a daily-rotating, non-reversible bucket without persisting an IP."""
    key = (secret or "development-rate-limit-salt").encode("utf-8")
    epoch_day = int(time.time()) // 86_400
    message = f"{epoch_day}:{client_ip}".encode()
    return hmac.new(key, message, hashlib.sha256).hexdigest()[:24]


async def check_ws_rate_limit(
    redis_client: aioredis.Redis,
    client_bucket: str,
    mpm: int = 120,
    *,
    fail_closed: bool = False,
) -> RateLimitDecision:
    """Check WebSocket message rate limit (called per message).

    Args:
        redis_client: Active Redis client.
        client_ip: The client's IP address.
        mpm: Maximum messages per minute.

    Returns:
        ``True`` if the message is allowed, ``False`` if rate limited.
    """
    current_minute = int(time.time()) // 60
    key = f"{_KEY_PREFIX}ws:{client_bucket}:{current_minute}"

    try:
        count = await redis_client.incr(key)
        if count == 1:
            await redis_client.expire(key, 65)
        return "allowed" if count <= mpm else "limited"
    except Exception:
        return "unavailable" if fail_closed else "allowed"
