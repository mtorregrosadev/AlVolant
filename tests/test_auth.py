"""Security tests for BFF API key validation."""

from types import SimpleNamespace

from app.core.auth import verify_ws_api_key


def _websocket(headers: dict[str, str], query: dict[str, str] | None = None):
    return SimpleNamespace(
        headers=headers,
        query_params=query or {},
        client=SimpleNamespace(host="127.0.0.1"),
    )


def test_websocket_accepts_api_key_header() -> None:
    websocket = _websocket({"x-api-key": "valid-key"})

    assert verify_ws_api_key(websocket, "valid-key") is True


def test_websocket_rejects_invalid_api_key_header() -> None:
    websocket = _websocket({"x-api-key": "invalid-key"})

    assert verify_ws_api_key(websocket, "valid-key") is False


def test_websocket_rejects_api_key_in_query_string() -> None:
    websocket = _websocket({}, {"token": "valid-key"})

    assert verify_ws_api_key(websocket, "valid-key") is False
