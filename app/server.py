"""Hardened single-process Uvicorn launcher for the production image."""

from __future__ import annotations

import uvicorn

from app.config import settings


def main() -> None:
    """Start Uvicorn with bounded concurrency and an explicit proxy trust list."""
    uvicorn.run(
        "app.main:app",
        host=settings.SERVER_HOST,
        port=settings.SERVER_PORT,
        loop="uvloop",
        http="httptools",
        ws="websockets",
        ws_max_size=settings.MAX_WS_MESSAGE_BYTES,
        ws_max_queue=32,
        ws_ping_interval=20,
        ws_ping_timeout=20,
        ws_per_message_deflate=False,
        workers=1,
        log_level=settings.LOG_LEVEL,
        access_log=False,
        server_header=False,
        forwarded_allow_ips=settings.FORWARDED_ALLOW_IPS,
        limit_concurrency=200,
        limit_max_requests=10_000,
        backlog=512,
        timeout_keep_alive=5,
        timeout_graceful_shutdown=30,
    )


if __name__ == "__main__":
    main()
