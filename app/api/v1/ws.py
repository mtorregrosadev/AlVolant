"""
WebSocket hub for real-time data push to driver tablets.

Provides a persistent WebSocket connection per tablet that pushes updates
whenever the background workers refresh the cache.  Clients subscribe to
topics and receive JSON messages when new data arrives.

    WS /api/v1/ws/live → real-time data stream

Security:
    - Requires a valid ``X-API-Key`` handshake header
    - Enforces connection cap (MAX_WS_CONNECTIONS)
    - Rate-limits incoming messages (RATE_LIMIT_WS_MPM)
    - Validates topic names and caps subscriptions per client
    - Rejects oversized messages (MAX_WS_MESSAGE_BYTES)

Protocol:
    Client → Server (JSON):
        {"action": "subscribe", "topics": ["atm_rt:vehicles", "atm_rt:alerts"]}
        {"action": "unsubscribe", "topics": ["atm_rt:vehicles"]}
        {"action": "ping"}

    Server → Client (JSON):
        {"topic": "atm_rt:vehicles", "data": {...}, "timestamp": "..."}
        {"type": "pong"}
        {"type": "error", "message": "..."}
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import orjson
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from app.core.auth import verify_ws_api_key
from app.core.logging import get_logger
from app.core.rate_limiter import check_ws_rate_limit

logger = get_logger(__name__)

router = APIRouter(prefix="/ws", tags=["WebSocket"])

# Allowed topic prefixes — clients can only subscribe to known namespaces
_ALLOWED_TOPIC_PREFIXES = ("atm_rt:", "gtfs:")


class ConnectionManager:
    """Manages concurrent WebSocket connections and topic subscriptions.

    Designed to scale to hundreds of concurrent driver tablet connections.
    Each connection can subscribe to multiple topics (e.g. ``atm_rt:vehicles``,
    ``atm_rt:alerts``) and receives push messages only for subscribed topics.

    Security hardening:
    - Enforces a hard cap on total connections (``max_connections``)
    - Limits topics per client (``max_topics_per_client``)
    - Validates topic names against allowed prefixes
    - Releases the lock before I/O-bound broadcast to prevent blocking
    """

    def __init__(
        self,
        max_connections: int = 200,
        max_topics_per_client: int = 20,
    ) -> None:
        # Map of websocket → set of subscribed topics
        self._connections: dict[WebSocket, set[str]] = {}
        # Map of topic → set of subscribed websockets (reverse index)
        self._topic_subscribers: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()
        self._max_connections = max_connections
        self._max_topics_per_client = max_topics_per_client

    @property
    def connection_count(self) -> int:
        """Number of active WebSocket connections."""
        return len(self._connections)

    async def connect(self, websocket: WebSocket) -> bool:
        """Accept and register a new WebSocket connection.

        Returns:
            ``True`` if the connection was accepted, ``False`` if the
            server has reached its connection cap.
        """
        async with self._lock:
            if len(self._connections) >= self._max_connections:
                logger.warning(
                    "WebSocket connection rejected — cap reached (%d/%d)",
                    len(self._connections),
                    self._max_connections,
                )
                return False

            await websocket.accept()
            self._connections[websocket] = set()

        logger.info(
            "WebSocket connected (%d total)",
            self.connection_count,
        )
        return True

    async def disconnect(self, websocket: WebSocket) -> None:
        """Remove a WebSocket connection and all its subscriptions."""
        async with self._lock:
            topics = self._connections.pop(websocket, set())
            for topic in topics:
                subs = self._topic_subscribers.get(topic)
                if subs:
                    subs.discard(websocket)
                    if not subs:
                        del self._topic_subscribers[topic]

        # Graceful close — ignore if already closed
        try:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close()
        except Exception:
            pass

        logger.info(
            "WebSocket disconnected (%d remaining)",
            self.connection_count,
        )

    async def subscribe(self, websocket: WebSocket, topics: list[str]) -> list[str]:
        """Subscribe a connection to one or more topics.

        Validates topic names against allowed prefixes and enforces the
        per-client topic cap.

        Returns:
            List of topics that were actually subscribed (after validation).
        """
        valid_topics: list[str] = []
        async with self._lock:
            if websocket not in self._connections:
                return []

            current_count = len(self._connections[websocket])

            for topic in topics:
                # Validate topic prefix
                if not any(topic.startswith(p) for p in _ALLOWED_TOPIC_PREFIXES):
                    logger.warning("Rejected invalid topic: %s", topic)
                    continue

                # Enforce per-client cap
                if current_count >= self._max_topics_per_client:
                    logger.warning(
                        "Topic cap reached for client (%d/%d)",
                        current_count,
                        self._max_topics_per_client,
                    )
                    break

                self._connections[websocket].add(topic)
                if topic not in self._topic_subscribers:
                    self._topic_subscribers[topic] = set()
                self._topic_subscribers[topic].add(websocket)
                valid_topics.append(topic)
                current_count += 1

        if valid_topics:
            logger.debug("WebSocket subscribed to: %s", valid_topics)
        return valid_topics

    async def unsubscribe(self, websocket: WebSocket, topics: list[str]) -> None:
        """Unsubscribe a connection from one or more topics."""
        async with self._lock:
            if websocket not in self._connections:
                return
            for topic in topics:
                self._connections[websocket].discard(topic)
                subs = self._topic_subscribers.get(topic)
                if subs:
                    subs.discard(websocket)
                    if not subs:
                        del self._topic_subscribers[topic]

    async def broadcast_to_topic(self, topic: str, data: dict | list) -> None:
        """Push a message to all subscribers of a topic.

        The lock is held only to snapshot the subscriber set; the actual
        I/O (``send_bytes``) runs outside the lock to avoid blocking
        subscribe/unsubscribe operations during broadcast.

        Args:
            topic: The topic name (e.g. ``"atm_rt:vehicles"``).
            data: The JSON-serializable payload.
        """
        # Snapshot subscribers under lock, then release
        async with self._lock:
            subscribers = list(self._topic_subscribers.get(topic, set()))

        if not subscribers:
            return

        message = orjson.dumps({
            "topic": topic,
            "data": data,
            "timestamp": datetime.now(tz=timezone.utc).isoformat(),
        })

        stale: list[WebSocket] = []
        for ws in subscribers:
            try:
                await ws.send_bytes(message)
            except Exception:
                stale.append(ws)

        # Clean up stale connections outside the broadcast loop
        for ws in stale:
            await self.disconnect(ws)

    def get_stats(self) -> dict:
        """Return connection/subscription statistics."""
        return {
            "active_connections": self.connection_count,
            "max_connections": self._max_connections,
            "topics": {
                topic: len(subs)
                for topic, subs in self._topic_subscribers.items()
            },
        }


# Module-level connection manager (singleton)
# Configuration is applied at startup via the endpoint handler
ws_manager = ConnectionManager()


@router.websocket("/live")
async def websocket_live(websocket: WebSocket) -> None:
    """Main WebSocket endpoint for real-time data push to tablets.

    Security flow:
    1. Validate the ``X-API-Key`` handshake header before accepting
    2. Check connection cap
    3. Rate-limit incoming messages
    4. Handle subscribe/unsubscribe/ping actions

    React Native clients connect with an ``X-API-Key`` handshake header.
    """
    # --- 0. Read settings ---
    app_settings = getattr(websocket.app.state, "settings", None)
    api_key = getattr(websocket.app.state, "api_key", "")
    max_msg_bytes = app_settings.MAX_WS_MESSAGE_BYTES if app_settings else 4096
    ws_mpm = app_settings.RATE_LIMIT_WS_MPM if app_settings else 120

    # Apply runtime configuration to manager
    if app_settings:
        ws_manager._max_connections = app_settings.MAX_WS_CONNECTIONS
        ws_manager._max_topics_per_client = app_settings.MAX_WS_TOPICS_PER_CLIENT

    # --- 1. Authentication ---
    if not api_key or not verify_ws_api_key(websocket, api_key):
        await websocket.close(code=4401, reason="Authentication required")
        return

    # --- 2. Connection cap ---
    if not await ws_manager.connect(websocket):
        # connect() already logged the rejection; close with policy violation
        await websocket.close(code=1008, reason="Connection limit reached")
        return

    # --- 3. Get Redis client for rate limiting ---
    cache = getattr(websocket.app.state, "cache", None)
    redis_client = cache.client if cache else None
    client_ip = websocket.client.host if websocket.client else "unknown"

    try:
        while True:
            # Receive and parse client messages
            raw = await websocket.receive_text()

            # --- Message size check ---
            if len(raw.encode("utf-8")) > max_msg_bytes:
                await websocket.send_text(
                    orjson.dumps({
                        "type": "error",
                        "message": f"Message too large (max {max_msg_bytes} bytes)",
                    }).decode()
                )
                continue

            # --- Rate limit check ---
            if redis_client:
                allowed = await check_ws_rate_limit(redis_client, client_ip, ws_mpm)
                if not allowed:
                    await websocket.send_text(
                        orjson.dumps({
                            "type": "error",
                            "message": "Rate limit exceeded. Slow down.",
                        }).decode()
                    )
                    continue

            # --- Parse message ---
            try:
                message = orjson.loads(raw)
            except orjson.JSONDecodeError:
                await websocket.send_text(
                    orjson.dumps({"type": "error", "message": "Invalid JSON"}).decode()
                )
                continue

            action = message.get("action", "")

            if action == "subscribe":
                topics = message.get("topics", [])
                if isinstance(topics, list) and topics:
                    accepted = await ws_manager.subscribe(websocket, topics)
                    await websocket.send_text(
                        orjson.dumps({
                            "type": "subscribed",
                            "topics": accepted,
                        }).decode()
                    )

            elif action == "unsubscribe":
                topics = message.get("topics", [])
                if isinstance(topics, list) and topics:
                    await ws_manager.unsubscribe(websocket, topics)
                    await websocket.send_text(
                        orjson.dumps({
                            "type": "unsubscribed",
                            "topics": topics,
                        }).decode()
                    )

            elif action == "ping":
                await websocket.send_text(
                    orjson.dumps({"type": "pong"}).decode()
                )

            else:
                await websocket.send_text(
                    orjson.dumps({
                        "type": "error",
                        "message": f"Unknown action: {action}",
                    }).decode()
                )

    except WebSocketDisconnect:
        await ws_manager.disconnect(websocket)
    except Exception:
        logger.exception("WebSocket error")
        await ws_manager.disconnect(websocket)
