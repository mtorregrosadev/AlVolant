"""
API Key authentication for the BFF server.

Implements a machine-to-machine API key scheme using the ``X-API-Key``
header for both HTTP and WebSocket clients.

Health-check endpoints (``/health``, ``/health/ready``) are exempt so that
orchestrators and load balancers can probe without credentials.

Usage (REST)::

    from app.core.auth import require_api_key

    @router.get("/data", dependencies=[Depends(require_api_key)])
    async def get_data(): ...

Usage (WebSocket)::

    from app.core.auth import verify_ws_api_key

    @router.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket):
        if not verify_ws_api_key(websocket):
            await websocket.close(code=4401)
            return
        ...
"""

from __future__ import annotations

import hmac
import secrets

from fastapi import Depends, HTTPException, Request, WebSocket, status
from fastapi.security import APIKeyHeader

from app.core.logging import get_logger

logger = get_logger(__name__)

# Header-based API key extractor (auto_error=False so we can return a
# custom 401 body instead of FastAPI's default).
_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def _get_api_key(request: Request) -> str:
    """Retrieve the configured BFF API key from application state.

    The key is loaded once during startup and stored on ``app.state``.
    """
    key: str | None = getattr(request.app.state, "api_key", None)
    if not key:
        raise RuntimeError(
            "BFF_API_KEY is not configured. Set the BFF_API_KEY environment variable."
        )
    return key


async def require_api_key(
    request: Request,
    api_key: str | None = Depends(_api_key_header),
) -> str:
    """FastAPI dependency that enforces API key authentication.

    Compares the ``X-API-Key`` header value against the configured
    ``BFF_API_KEY`` using constant-time comparison to prevent timing attacks.

    Returns:
        The validated API key string.

    Raises:
        HTTPException(401): If the key is missing or invalid.
    """
    expected = _get_api_key(request)

    if api_key is None:
        logger.warning(
            "Unauthenticated request: %s %s",
            request.method,
            request.url.path,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing API key. Provide a valid X-API-Key header.",
            headers={"WWW-Authenticate": "ApiKey"},
        )

    if not hmac.compare_digest(api_key, expected):
        logger.warning(
            "Invalid API key on %s %s",
            request.method,
            request.url.path,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key.",
            headers={"WWW-Authenticate": "ApiKey"},
        )

    return api_key


def verify_ws_api_key(websocket: WebSocket, expected_key: str) -> bool:
    """Validate the API key provided during a WebSocket handshake.

    React Native sends ``X-API-Key`` as a handshake header, which avoids
    exposing credentials in URLs and access logs.

    Args:
        websocket: The WebSocket connection (pre-accept).
        expected_key: The configured BFF_API_KEY.

    Returns:
        ``True`` if the token is valid, ``False`` otherwise.
    """
    api_key = websocket.headers.get("x-api-key", "")
    if not api_key or not hmac.compare_digest(api_key, expected_key):
        logger.warning(
            "WebSocket authentication failed",
        )
        return False
    return True


def generate_api_key() -> str:
    """Generate a cryptographically secure API key (utility for onboarding).

    Returns:
        A 64-character URL-safe token.
    """
    return secrets.token_urlsafe(48)
