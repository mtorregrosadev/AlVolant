"""
Background worker for continuously polling ATM GTFS-Realtime feeds.

This worker runs in an infinite loop for the lifecycle of the FastAPI app,
fetching the unified real-time feeds at the configured interval, and triggering
the service to parse and cache them. It also broadcasts updates to connected
WebSockets via Redis PubSub if needed.
"""

from __future__ import annotations

import asyncio
from typing import Any

from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.core.exceptions import ExternalAPIError, GTFSParseError
from app.core.logging import get_logger
from app.services.atm_rt_service import ATMRTService

logger = get_logger(__name__)


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
            "running": self._running,
        }

    async def _poll_loop(self) -> None:
        """Infinite loop to fetch and cache data at set intervals."""
        while self._running:
            try:
                # 1. Fetch, parse, and cache the unified feeds
                feed = await self._service.fetch_and_parse_all()

                self.cycles_completed += 1

                # 2. Broadcast the update event to WebSocket clients
                #    In a production setup, we might diff the state to only
                #    push changed routes, but for now we broadcast a general ping
                #    or let the frontend fetch the new state.
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
                logger.error("ATM RT worker cycle #%d failed (total errors: %d)", self.cycles_completed + 1, self.errors)
                logger.exception(exc)
                # Sleep briefly before retrying
                await asyncio.sleep(5.0)
            except Exception as exc:
                self.errors += 1
                logger.error("Unexpected error in ATM RT worker", exc_info=exc)
                await asyncio.sleep(5.0)
