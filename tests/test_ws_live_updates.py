"""Realtime invalidations must reach subscribed clients as bounded JSON text."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import orjson
import pytest

from app.api.v1 import ws as ws_module
from app.api.v1.ws import ConnectionManager, ws_manager
from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.workers.atm_rt_worker import ATMRTWorker


class _TextWebSocket:
    def __init__(self) -> None:
        self.messages: list[str] = []

    async def send_text(self, message: str) -> None:
        self.messages.append(message)


class _BlockedWebSocket(_TextWebSocket):
    async def send_text(self, message: str) -> None:
        await asyncio.Event().wait()


@pytest.mark.asyncio
async def test_topic_broadcast_uses_json_text_frame() -> None:
    manager = ConnectionManager()
    websocket = _TextWebSocket()
    unsubscribed = _TextWebSocket()
    manager._connections[websocket] = set()  # type: ignore[index]
    manager._connections[unsubscribed] = set()  # type: ignore[index]

    accepted = await manager.subscribe(websocket, ["atm_rt:updates"])  # type: ignore[arg-type]
    await manager.broadcast_to_topic(
        "atm_rt:updates",
        {"type": "invalidate", "timestamp": "2026-07-12T12:00:00Z"},
    )

    assert accepted == ["atm_rt:updates"]
    assert len(websocket.messages) == 1
    assert unsubscribed.messages == []
    message = orjson.loads(websocket.messages[0])
    assert message["topic"] == "atm_rt:updates"
    assert message["data"]["type"] == "invalidate"


@pytest.mark.asyncio
async def test_worker_notifier_broadcasts_one_invalidation(
    settings: Settings,
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = ATMRTWorker(settings, SimpleNamespace(), cache)  # type: ignore[arg-type]
    publish = AsyncMock(return_value=1)
    broadcast = AsyncMock()
    monkeypatch.setattr(cache.client, "publish", publish)
    monkeypatch.setattr(ws_manager, "broadcast_to_topic", broadcast)

    await worker._notify_live_update("2026-07-12T12:00:00+00:00")

    publish.assert_awaited_once()
    channel, raw_payload = publish.await_args.args
    assert channel == "channel:atm_rt:updates"
    assert orjson.loads(raw_payload) == {
        "type": "invalidate",
        "timestamp": "2026-07-12T12:00:00+00:00",
    }
    broadcast.assert_awaited_once_with(
        "atm_rt:updates",
        {
            "type": "invalidate",
            "timestamp": "2026-07-12T12:00:00+00:00",
        },
    )


@pytest.mark.asyncio
async def test_slow_subscriber_does_not_block_other_clients(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = ConnectionManager()
    fast = _TextWebSocket()
    blocked = _BlockedWebSocket()
    manager._connections[fast] = set()  # type: ignore[index]
    manager._connections[blocked] = set()  # type: ignore[index]
    await manager.subscribe(fast, ["atm_rt:updates"])  # type: ignore[arg-type]
    await manager.subscribe(blocked, ["atm_rt:updates"])  # type: ignore[arg-type]
    monkeypatch.setattr(ws_module, "_SEND_TIMEOUT_SECONDS", 0.01)

    await asyncio.wait_for(
        manager.broadcast_to_topic(
            "atm_rt:updates",
            {"type": "invalidate", "timestamp": "2026-07-12T12:00:00Z"},
        ),
        timeout=0.2,
    )

    assert len(fast.messages) == 1
    assert blocked not in manager._connections


@pytest.mark.asyncio
async def test_redis_notification_failure_keeps_websocket_delivery(
    settings: Settings,
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = ATMRTWorker(settings, SimpleNamespace(), cache)  # type: ignore[arg-type]
    publish = AsyncMock(side_effect=RuntimeError("redis unavailable"))
    broadcast = AsyncMock()
    monkeypatch.setattr(cache.client, "publish", publish)
    monkeypatch.setattr(ws_manager, "broadcast_to_topic", broadcast)

    await worker._notify_live_update("2026-07-12T12:00:00+00:00")

    broadcast.assert_awaited_once()


@pytest.mark.asyncio
async def test_websocket_notification_failure_does_not_fail_cached_cycle(
    settings: Settings,
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = ATMRTWorker(settings, SimpleNamespace(), cache)  # type: ignore[arg-type]
    publish = AsyncMock(return_value=1)
    broadcast = AsyncMock(side_effect=RuntimeError("client unavailable"))
    monkeypatch.setattr(cache.client, "publish", publish)
    monkeypatch.setattr(ws_manager, "broadcast_to_topic", broadcast)

    await worker._notify_live_update("2026-07-12T12:00:00+00:00")

    publish.assert_awaited_once()
