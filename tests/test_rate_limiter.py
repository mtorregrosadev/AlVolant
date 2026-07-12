"""Security tests for peer-IP HTTP and WebSocket rate limiting."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.core.rate_limiter import (
    RateLimiterMiddleware,
    _get_client_ip,
    _hash_client_identifier,
)


class _CountingRedis:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self.expirations: dict[str, int] = {}

    async def incr(self, key: str) -> int:
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key]

    async def expire(self, key: str, seconds: int) -> None:
        self.expirations[key] = seconds


def _request(*, peer: str | None, forwarded_for: str | None = None) -> Request:
    headers = []
    if forwarded_for is not None:
        headers.append((b"x-forwarded-for", forwarded_for.encode()))
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/resource",
        "raw_path": b"/resource",
        "query_string": b"",
        "headers": headers,
        "server": ("testserver", 80),
        "client": (peer, 12345) if peer is not None else None,
    }
    return Request(scope)


def test_client_ip_ignores_untrusted_forwarded_header() -> None:
    request = _request(peer="203.0.113.10", forwarded_for="198.51.100.99")

    assert _get_client_ip(request) == "203.0.113.10"


def test_client_ip_has_safe_fallback_without_peer() -> None:
    assert _get_client_ip(_request(peer=None, forwarded_for="198.51.100.99")) == "unknown"


def test_spoofed_forwarded_ips_share_the_real_peer_bucket() -> None:
    redis = _CountingRedis()
    app = FastAPI()
    app.state.cache = SimpleNamespace(client=redis)
    app.add_middleware(RateLimiterMiddleware, rpm=1)

    @app.get("/resource")
    async def resource() -> dict[str, bool]:
        return {"ok": True}

    with TestClient(app) as client:
        first = client.get("/resource", headers={"X-Forwarded-For": "198.51.100.1"})
        second = client.get("/resource", headers={"X-Forwarded-For": "198.51.100.2"})

    assert first.status_code == 200
    assert second.status_code == 429
    assert len(redis.counts) == 1
    key = next(iter(redis.counts))
    assert "testclient" not in key
    assert "198.51.100" not in key
    assert _hash_client_identifier("testclient", "") in key


def test_only_liveness_bypasses_dependency_rate_limit() -> None:
    redis = _CountingRedis()
    app = FastAPI()
    app.state.cache = SimpleNamespace(client=redis)
    app.add_middleware(RateLimiterMiddleware, rpm=1)

    @app.get("/health")
    async def liveness() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/health/ready")
    async def readiness() -> dict[str, bool]:
        return {"ok": True}

    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/health").status_code == 200
        assert client.get("/health/ready").status_code == 200
        assert client.get("/health/ready").status_code == 429

    assert len(redis.counts) == 1


def test_downstream_failure_is_not_executed_twice() -> None:
    redis = _CountingRedis()
    calls = 0
    app = FastAPI()
    app.state.cache = SimpleNamespace(client=redis)
    app.add_middleware(RateLimiterMiddleware, rpm=5)

    @app.get("/resource")
    async def resource() -> None:
        nonlocal calls
        calls += 1
        raise RuntimeError("boom")

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/resource")

    assert response.status_code == 500
    assert calls == 1


@pytest.mark.asyncio
async def test_redis_failure_fails_open_once() -> None:
    class _BrokenRedis:
        async def incr(self, _key: str) -> int:
            raise ConnectionError("redis unavailable")

    calls = 0
    app = FastAPI()
    app.state.cache = SimpleNamespace(client=_BrokenRedis())
    app.add_middleware(RateLimiterMiddleware, rpm=1)

    @app.get("/resource")
    async def resource() -> dict[str, bool]:
        nonlocal calls
        calls += 1
        return {"ok": True}

    with TestClient(app) as client:
        response = client.get("/resource")

    assert response.status_code == 200
    assert calls == 1
