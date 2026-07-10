"""Road traffic provider integration."""

from __future__ import annotations

import time
from typing import Any

import httpx

from app.config import Settings
from app.core.logging import get_logger
from app.models.traffic import TrafficSummary

logger = get_logger(__name__)


class TrafficService:
    """Fetch and normalize road traffic data near a coordinate."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: httpx.AsyncClient | None = None
        self._memory_cache: dict[str, tuple[float, TrafficSummary]] = {}

    async def start(self) -> None:
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(6.0))

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def get_summary(self, latitude: float, longitude: float) -> TrafficSummary:
        """Return a driver-facing traffic summary for the nearest road segment."""
        if not self._settings.TOMTOM_API_KEY:
            return TrafficSummary(
                label="Trànsit: clau pendent",
                status="unavailable",
                source="tomtom",
                current_speed_kmh=None,
                free_flow_speed_kmh=None,
                delay_seconds=None,
                confidence=None,
                road_closure=False,
            )

        cache_key = f"{round(latitude, 4)}:{round(longitude, 4)}"
        cached = self._memory_cache.get(cache_key)
        now = time.monotonic()
        if cached and cached[0] > now:
            return cached[1]

        summary = await self._fetch_tomtom_flow(latitude, longitude)
        self._memory_cache[cache_key] = (
            now + max(10, self._settings.TRAFFIC_CACHE_TTL_SECONDS),
            summary,
        )
        return summary

    async def _fetch_tomtom_flow(self, latitude: float, longitude: float) -> TrafficSummary:
        if not self._client:
            await self.start()

        assert self._client is not None
        url = f"{self._settings.TOMTOM_TRAFFIC_BASE_URL}/flowSegmentData/relative/10/json"

        try:
            response = await self._client.get(
                url,
                params={
                    "point": f"{latitude},{longitude}",
                    "unit": "KMPH",
                    "key": self._settings.TOMTOM_API_KEY,
                },
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            logger.warning("TomTom traffic lookup failed: %s", exc)
            return TrafficSummary(
                label="Trànsit: no disponible",
                status="unavailable",
                source="tomtom",
                current_speed_kmh=None,
                free_flow_speed_kmh=None,
                delay_seconds=None,
                confidence=None,
                road_closure=False,
            )

        return self._normalize_tomtom_flow(payload)

    def _normalize_tomtom_flow(self, payload: dict[str, Any]) -> TrafficSummary:
        flow = payload.get("flowSegmentData") or {}
        current_speed = _to_float(flow.get("currentSpeed"))
        free_flow_speed = _to_float(flow.get("freeFlowSpeed"))
        current_travel_time = _to_float(flow.get("currentTravelTime"))
        free_flow_travel_time = _to_float(flow.get("freeFlowTravelTime"))
        confidence = _to_float(flow.get("confidence"))
        road_closure = bool(flow.get("roadClosure"))

        delay_seconds: int | None = None
        if current_travel_time is not None and free_flow_travel_time is not None:
            delay_seconds = max(0, int(round(current_travel_time - free_flow_travel_time)))

        if road_closure:
            return TrafficSummary(
                label="Trànsit: via tallada",
                status="closed",
                source="tomtom",
                current_speed_kmh=current_speed,
                free_flow_speed_kmh=free_flow_speed,
                delay_seconds=delay_seconds,
                confidence=confidence,
                road_closure=True,
            )

        ratio = None
        if current_speed is not None and free_flow_speed and free_flow_speed > 0:
            ratio = current_speed / free_flow_speed

        if ratio is None:
            label = "Trànsit: dades parcials"
            status = "unavailable"
        elif ratio >= 0.85:
            label = "Trànsit fluid"
            status = "normal"
        elif ratio >= 0.65:
            label = "Trànsit dens"
            status = "dense"
        elif ratio >= 0.4:
            label = "Trànsit lent"
            status = "slow"
        else:
            label = "Retencions"
            status = "jammed"

        if delay_seconds and delay_seconds >= 60:
            label = f"{label} · +{round(delay_seconds / 60)} min"

        return TrafficSummary(
            label=label,
            status=status,
            source="tomtom",
            current_speed_kmh=current_speed,
            free_flow_speed_kmh=free_flow_speed,
            delay_seconds=delay_seconds,
            confidence=confidence,
            road_closure=False,
        )


def _to_float(value: Any) -> float | None:
    if isinstance(value, int | float):
        return float(value)

    return None
