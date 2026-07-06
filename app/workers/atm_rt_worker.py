"""
Background worker for continuously polling ATM GTFS-Realtime feeds.

This worker runs in an infinite loop for the lifecycle of the FastAPI app,
fetching the unified real-time feeds at the configured interval, and triggering
the service to parse and cache them. It also broadcasts updates to connected
WebSockets via Redis PubSub if needed.

Resilience features:
- Exponential backoff on errors (5s → 10s → 20s → max 60s)
- Circuit breaker: pauses for 5 minutes after 10 consecutive failures
- Telemetry: tracks cycles, errors, and last success timestamp
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.core.exceptions import ExternalAPIError, GTFSParseError
from app.core.logging import get_logger
from app.services.atm_rt_service import ATMRTService

logger = get_logger(__name__)

# Circuit breaker constants
_MAX_CONSECUTIVE_ERRORS = 10
_CIRCUIT_BREAKER_PAUSE_SECONDS = 300  # 5 minutes
_MIN_BACKOFF_SECONDS = 5.0
_MAX_BACKOFF_SECONDS = 60.0


class ATMRTWorker:
    """Background worker for polling ATM Real-Time data.

    Args:
        settings: Application settings.
        service: The ATM RT service instance.
        cache: The Redis cache manager for pub/sub broadcasting.
    """

    def __init__(
        self,
        settings: Settings,
        service: ATMRTService,
        cache: CacheManager,
    ) -> None:
        self._interval = settings.ATM_RT_POLL_INTERVAL_SECONDS
        self._service = service
        self._cache = cache
        self._running = False
        self._task: asyncio.Task[None] | None = None

        # Telemetry
        self.cycles_completed = 0
        self.errors = 0
        self._consecutive_errors = 0
        self._current_backoff = _MIN_BACKOFF_SECONDS
        self.last_success: str | None = None

    async def start(self) -> None:
        """Start the background polling loop."""
        if self._running:
            return

        self._running = True
        self._task = asyncio.create_task(self._poll_loop())
        logger.info("ATM RT worker started — polling every %ds", self._interval)

    async def stop(self) -> None:
        """Stop the background polling loop."""
        if not self._running:
            return

        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

        logger.info("ATM RT worker stopped")

    def status(self) -> dict[str, Any]:
        """Return the current health status of the worker."""
        return {
            "worker": "atm_rt",
            "interval_seconds": self._interval,
            "cycles_completed": self.cycles_completed,
            "errors": self.errors,
            "consecutive_errors": self._consecutive_errors,
            "last_success": self.last_success,
            "running": self._running,
        }

    async def _poll_loop(self) -> None:
        """Infinite loop to fetch and cache data at set intervals.

        Implements exponential backoff on errors and a circuit breaker
        that pauses polling after too many consecutive failures.
        """
        while self._running:
            try:
                # --- Circuit breaker check ---
                if self._consecutive_errors >= _MAX_CONSECUTIVE_ERRORS:
                    logger.critical(
                        "Circuit breaker OPEN — %d consecutive errors. "
                        "Pausing for %ds before retrying.",
                        self._consecutive_errors,
                        _CIRCUIT_BREAKER_PAUSE_SECONDS,
                    )
                    await asyncio.sleep(_CIRCUIT_BREAKER_PAUSE_SECONDS)
                    self._consecutive_errors = 0  # Reset after pause
                    self._current_backoff = _MIN_BACKOFF_SECONDS

                # 1. Fetch, parse, and cache the unified feeds
                feed = await self._service.fetch_and_parse_all()

                self.cycles_completed += 1
                self._consecutive_errors = 0
                self._current_backoff = _MIN_BACKOFF_SECONDS
                self.last_success = datetime.now(tz=timezone.utc).isoformat()

                # 2. Broadcast the update event to WebSocket clients
                await self._cache.client.publish(
                    "channel:atm_rt:updates",
                    f'{{"type": "update", "timestamp": "{feed.feed_timestamp.isoformat()}"}}',
                )

                # 3. Sleep until the next cycle
                await asyncio.sleep(self._interval)

            except asyncio.CancelledError:
                break
            except (ExternalAPIError, GTFSParseError) as exc:
                self.errors += 1
                self._consecutive_errors += 1
                logger.error(
                    "ATM RT worker cycle failed (%d consecutive, %d total): %s",
                    self._consecutive_errors,
                    self.errors,
                    exc,
                )

                # Exponential backoff
                await asyncio.sleep(self._current_backoff)
                self._current_backoff = min(
                    self._current_backoff * 2,
                    _MAX_BACKOFF_SECONDS,
                )
            except Exception as exc:
                self.errors += 1
                self._consecutive_errors += 1
                logger.error(
                    "Unexpected error in ATM RT worker (%d consecutive): %s",
                    self._consecutive_errors,
                    exc,
                    exc_info=True,
                )

                await asyncio.sleep(self._current_backoff)
                self._current_backoff = min(
                    self._current_backoff * 2,
                    _MAX_BACKOFF_SECONDS,
                )
