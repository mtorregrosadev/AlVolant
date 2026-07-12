"""Small ASGI security primitives applied before request parsing."""

from __future__ import annotations

import asyncio

import orjson
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class RequestBodyLimitMiddleware:
    """Reject oversized HTTP bodies before Starlette/Pydantic parse JSON."""

    def __init__(
        self,
        app: ASGIApp,
        max_bytes: int = 65_536,
        receive_timeout_seconds: float = 15.0,
    ) -> None:
        self.app = app
        self.max_bytes = max(1_024, min(max_bytes, 1_048_576))
        self.receive_timeout_seconds = max(1.0, min(receive_timeout_seconds, 120.0))

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        content_length = self._content_length(scope)
        if content_length is not None and content_length > self.max_bytes:
            await self._reject(send)
            return

        messages: list[Message] = []
        total = 0
        try:
            async with asyncio.timeout(self.receive_timeout_seconds):
                while True:
                    message = await receive()
                    messages.append(message)
                    if message["type"] == "http.disconnect":
                        return
                    if message["type"] != "http.request":
                        continue
                    total += len(message.get("body", b""))
                    if total > self.max_bytes:
                        await self._reject(send)
                        return
                    if not message.get("more_body", False):
                        break
        except TimeoutError:
            await self._reject_timeout(send)
            return

        iterator = iter(messages)

        async def replay() -> Message:
            try:
                return next(iterator)
            except StopIteration:
                return {"type": "http.request", "body": b"", "more_body": False}

        await self.app(scope, replay, send)

    @staticmethod
    def _content_length(scope: Scope) -> int | None:
        for name, value in scope.get("headers", []):
            if name.lower() != b"content-length":
                continue
            try:
                return int(value)
            except ValueError:
                return None
        return None

    async def _reject(self, send: Send) -> None:
        body = orjson.dumps({
            "error": "payload_too_large",
            "detail": f"Request body exceeds {self.max_bytes} bytes.",
        })
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
                (b"cache-control", b"no-store"),
            ],
        })
        await send({"type": "http.response.body", "body": body})

    @staticmethod
    async def _reject_timeout(send: Send) -> None:
        body = orjson.dumps({
            "error": "request_timeout",
            "detail": "Request body was not received within the allowed time.",
        })
        await send({
            "type": "http.response.start",
            "status": 408,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
                (b"cache-control", b"no-store"),
                (b"connection", b"close"),
            ],
        })
        await send({"type": "http.response.body", "body": body})


class SecurityHeadersMiddleware:
    """Apply non-cacheable API and browser hardening headers."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                security_headers = [
                    (b"cache-control", b"no-store"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"x-content-type-options", b"nosniff"),
                    (b"x-frame-options", b"DENY"),
                ]
                protected_names = {name for name, _ in security_headers}
                headers = [
                    (name, value)
                    for name, value in message.get("headers", [])
                    if name.lower() not in protected_names
                ]
                headers.extend(security_headers)
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)
