"""
WebSocket hub for real-time data push to driver tablets.

Provides a persistent WebSocket connection per tablet that pushes updates
whenever the background workers refresh the cache.  Clients subscribe to
topics and receive JSON messages when new data arrives.

    WS /api/v1/ws/live → real-time data stream

Protocol:
    Client → Server (JSON):
        {"action": "subscribe", "topics": ["tmb:1234", "amb:vehicles"]}
        {"action": "unsubscribe", "topics": ["tmb:1234"]}
        {"action": "ping"}

    Server → Client (JSON):
        {"topic": "tmb:1234", "data": {...}, "timestamp": "..."}
        {"topic": "amb:vehicles", "data": [...], "timestamp": "..."}
        {"type": "pong"}
        {"type": "error", "message": "..."}
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import orjson
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/ws", tags=["WebSocket"])


class ConnectionManager:
    """Manages concurrent WebSocket connections and topic subscriptions.

    Designed to scale to hundreds of concurrent driver tablet connections.
    Each connection can subscribe to multiple topics (e.g. ``tmb:1234``,
    ``amb:vehicles``) and receives push messages only for subscribed topics.
    """

    def __init__(self) -> None:
        # Map of websocket → set of subscribed topics
        self._connections: dict[WebSocket, set[str]] = {}
        # Map of topic → set of subscribed websockets (reverse index)
        self._topic_subscribers: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    @property
    def connection_count(self) -> int:
        """Number of active WebSocket connections."""
        return len(self._connections)

    async def connect(self, websocket: WebSocket) -> None:
        """Accept and register a new WebSocket connection."""
        await websocket.accept()
        async with self._lock:
            self._connections[websocket] = set()
        logger.info(
            "WebSocket connected (%d total)",
            self.connection_count,
        )

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
        logger.info(
            "WebSocket disconnected (%d remaining)",
            self.connection_count,
        )

    async def subscribe(self, websocket: WebSocket, topics: list[str]) -> None:
        """Subscribe a connection to one or more topics."""
        async with self._lock:
            if websocket not in self._connections:
                return
            for topic in topics:
                self._connections[websocket].add(topic)
                if topic not in self._topic_subscribers:
                    self._topic_subscribers[topic] = set()
                self._topic_subscribers[topic].add(websocket)
        logger.debug("WebSocket subscribed to: %s", topics)

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

        Disconnected clients are cleaned up automatically.

        Args:
            topic: The topic name (e.g. ``"amb:vehicles"``).
            data: The JSON-serializable payload.
        """
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

        # Clean up stale connections
        for ws in stale:
            await self.disconnect(ws)

    def get_stats(self) -> dict:
        """Return connection/subscription statistics."""
        return {
            "active_connections": self.connection_count,
            "topics": {
                topic: len(subs)
                for topic, subs in self._topic_subscribers.items()
            },
        }


# Module-level connection manager (singleton)
ws_manager = ConnectionManager()


@router.websocket("/live")
async def websocket_live(websocket: WebSocket) -> None:
    """Main WebSocket endpoint for real-time data push to tablets.

    Handles client messages (subscribe, unsubscribe, ping) and maintains
    the connection until the client disconnects.
    """
    await ws_manager.connect(websocket)
    try:
        while True:
            # Receive and parse client messages
            raw = await websocket.receive_text()
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
                    await ws_manager.subscribe(websocket, topics)
                    await websocket.send_text(
                        orjson.dumps({
                            "type": "subscribed",
                            "topics": topics,
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
