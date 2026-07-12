"""Validation and WebSocket resource-limit tests for public API inputs."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.websockets import WebSocketState

from app.api.v1.gtfs import router as gtfs_router
from app.api.v1.ws import ClientMessage, ConnectionManager

_HEADERS = {"X-API-Key": "test-api-key"}


def _gtfs_client() -> TestClient:
    app = FastAPI()
    app.state.api_key = "test-api-key"
    app.state.gtfs_service = SimpleNamespace(
        get_route_shape=AsyncMock(),
        get_route_stops=AsyncMock(),
        get_upcoming_trips=AsyncMock(),
    )
    app.include_router(gtfs_router, prefix="/api/v1")
    return TestClient(app)


def test_bulk_shapes_endpoint_is_not_exposed() -> None:
    with _gtfs_client() as client:
        response = client.get("/api/v1/gtfs/shapes", headers=_HEADERS)

    assert response.status_code == 404


@pytest.mark.parametrize("direction", ["-1", "2", "999999"])
def test_shape_direction_is_bounded(direction: str) -> None:
    with _gtfs_client() as client:
        response = client.get(
            f"/api/v1/gtfs/shapes/AMB_415?direction_id={direction}",
            headers=_HEADERS,
        )

    assert response.status_code == 422


def test_shape_identifiers_are_bounded() -> None:
    long_id = "a" * 129
    with _gtfs_client() as client:
        route_response = client.get(
            f"/api/v1/gtfs/shapes/{long_id}",
            headers=_HEADERS,
        )
        trip_response = client.get(
            f"/api/v1/gtfs/shapes/AMB_415?trip_id={long_id}",
            headers=_HEADERS,
        )

    assert route_response.status_code == 422
    assert trip_response.status_code == 422


@pytest.mark.parametrize(
    "query",
    ["direction_id=-1", "direction_id=2", "direction_id=0&limit=0", "direction_id=0&limit=21"],
)
def test_upcoming_trip_direction_and_limit_are_bounded(query: str) -> None:
    with _gtfs_client() as client:
        response = client.get(
            f"/api/v1/gtfs/routes/AMB_415/upcoming-trips?{query}",
            headers=_HEADERS,
        )

    assert response.status_code == 422


@pytest.mark.parametrize(
    "payload",
    [
        {"action": ["ping"]},
        {"action": "delete"},
        {"action": "ping", "topics": []},
        {"action": "subscribe"},
        {"action": "subscribe", "topics": "atm_rt:vehicles"},
        {"action": "subscribe", "topics": [123]},
        {"action": "subscribe", "topics": ["admin:secrets"]},
        {"action": "subscribe", "topics": ["atm_rt:vehicles\nforged"]},
        {"action": "ping", "unexpected": True},
    ],
)
def test_websocket_protocol_rejects_arbitrary_types_and_topics(payload: object) -> None:
    with pytest.raises(ValidationError):
        ClientMessage.model_validate(payload)


def test_websocket_protocol_accepts_known_command_shape() -> None:
    command = ClientMessage.model_validate(
        {"action": "subscribe", "topics": ["atm_rt:vehicles", "gtfs:routes"]}
    )

    assert command.action == "subscribe"
    assert command.topics == ["atm_rt:vehicles", "gtfs:routes"]


class _FakeWebSocket:
    def __init__(self, ip: str) -> None:
        self.client = SimpleNamespace(host=ip)
        self.client_state = WebSocketState.DISCONNECTED
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True


@pytest.mark.asyncio
async def test_websocket_connections_are_capped_per_peer_ip() -> None:
    manager = ConnectionManager(
        max_connections=10,
        max_topics_per_client=2,
        max_connections_per_ip=2,
    )
    first = _FakeWebSocket("203.0.113.10")
    second = _FakeWebSocket("203.0.113.10")
    rejected = _FakeWebSocket("203.0.113.10")
    other_ip = _FakeWebSocket("203.0.113.11")

    assert await manager.connect(first) is True  # type: ignore[arg-type]
    assert await manager.connect(second) is True  # type: ignore[arg-type]
    assert await manager.connect(rejected) is False  # type: ignore[arg-type]
    assert await manager.connect(other_ip) is True  # type: ignore[arg-type]
    assert rejected.accepted is False

    await manager.disconnect(first)  # type: ignore[arg-type]
    assert await manager.connect(rejected) is True  # type: ignore[arg-type]
