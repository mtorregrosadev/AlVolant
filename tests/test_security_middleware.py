"""Request-size, response-header and log-redaction security tests."""

from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from app.core.logging import redact_log_text
from app.core.rate_limiter import RateLimiterMiddleware
from app.core.security import RequestBodyLimitMiddleware, SecurityHeadersMiddleware
from app.main import app as production_app


def _test_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(RequestBodyLimitMiddleware, max_bytes=1_024)
    app.add_middleware(SecurityHeadersMiddleware)

    @app.post("/echo")
    async def echo(request: Request) -> dict[str, int]:
        return {"size": len(await request.body())}

    return app


def test_request_body_limit_rejects_before_endpoint() -> None:
    with TestClient(_test_app()) as client:
        accepted = client.post("/echo", content=b"a" * 1_024)
        rejected = client.post("/echo", content=b"a" * 1_025)

    assert accepted.status_code == 200
    assert rejected.status_code == 413
    assert rejected.json()["error"] == "payload_too_large"


def test_rate_limit_runs_before_request_body_buffering() -> None:
    middleware_order = [middleware.cls for middleware in production_app.user_middleware]

    assert middleware_order.index(RateLimiterMiddleware) < middleware_order.index(
        RequestBodyLimitMiddleware
    )


@pytest.mark.asyncio
async def test_slow_request_body_is_closed_on_deadline() -> None:
    endpoint_called = False
    sent: list[dict] = []

    async def endpoint(_scope: dict, _receive, _send) -> None:  # noqa: ANN001
        nonlocal endpoint_called
        endpoint_called = True

    async def receive() -> dict:
        await asyncio.sleep(1)
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    middleware = RequestBodyLimitMiddleware(endpoint)
    middleware.receive_timeout_seconds = 0.01
    await middleware(
        {"type": "http", "headers": []},
        receive,
        send,
    )

    assert endpoint_called is False
    assert sent[0]["status"] == 408
    assert (b"connection", b"close") in sent[0]["headers"]


def test_security_headers_are_applied() -> None:
    with TestClient(_test_app()) as client:
        response = client.post("/echo", content=b"ok")

    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_security_headers_cover_rate_limit_and_cors_early_responses() -> None:
    class _Redis:
        def __init__(self) -> None:
            self.count = 0

        async def incr(self, _key: str) -> int:
            self.count += 1
            return self.count

        async def expire(self, _key: str, _seconds: int) -> None:
            return None

    app = FastAPI()
    app.state.cache = type("Cache", (), {"client": _Redis()})()

    @app.get("/resource")
    async def resource() -> dict[str, bool]:
        return {"ok": True}

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["https://app.example"],
        allow_methods=["GET"],
    )
    app.add_middleware(RateLimiterMiddleware, rpm=1)
    app.add_middleware(SecurityHeadersMiddleware)

    with TestClient(app) as client:
        assert client.get("/resource").status_code == 200
        limited = client.get("/resource")
        preflight = client.options(
            "/resource",
            headers={
                "Origin": "https://app.example",
                "Access-Control-Request-Method": "GET",
            },
        )

    assert limited.status_code == 429
    assert limited.headers["x-content-type-options"] == "nosniff"
    assert preflight.headers["x-content-type-options"] == "nosniff"


def test_log_redactor_removes_credentials_queries_and_coordinates() -> None:
    dirty = (
        "redis://user:password@redis:6379/0 "
        "https://api.tomtom.com/path?key=top-secret&point=41.403812,2.174532 "
        "token=another-secret Authorization: Bearer SUPERSECRET "
        "latitude=41.403812 longitude:2.174532 41.403812, 2.174532 "
        "headers={'X-API-Key': 'quoted-secret', 'Authorization': 'Bearer quoted-bearer'} "
        "payload={'password': 'quoted-password', 'latitude': '41.403812'}"
    )
    clean = redact_log_text(dirty)

    assert "user:password@" not in clean
    assert "top-secret" not in clean
    assert "another-secret" not in clean
    assert "SUPERSECRET" not in clean
    assert "quoted-secret" not in clean
    assert "quoted-bearer" not in clean
    assert "quoted-password" not in clean
    assert "41.403812" not in clean
    assert "2.174532" not in clean
