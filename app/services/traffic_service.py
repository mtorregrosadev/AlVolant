"""Road traffic provider integration."""

from __future__ import annotations

import asyncio
import math
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx
import orjson

from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.core.logging import get_logger
from app.models.traffic import TrafficSummary

logger = get_logger(__name__)

# Traffic is only an operational feature inside Catalonia. Keeping this guard
# in the service as well as the API prevents accidental forwarding of arbitrary
# user coordinates to the provider from background jobs or future call sites.
TRAFFIC_MIN_LATITUDE = 40.45
TRAFFIC_MAX_LATITUDE = 42.95
TRAFFIC_MIN_LONGITUDE = 0.00
TRAFFIC_MAX_LONGITUDE = 3.50

_COORDINATE_GRID = 1_000  # Three decimals: roughly 80-110 m in Catalonia.
_MAX_CACHE_ENTRIES = 2_048
_MIN_CACHE_TTL_SECONDS = 10
_MAX_CACHE_TTL_SECONDS = 300
_ALLOWED_TOMTOM_HOSTS = frozenset({"api.tomtom.com"})
_MAX_RESPONSE_BYTES = 128 * 1024
_TRAFFIC_QUOTA_MINUTE_PREFIX = "rl:traffic:minute"
_TRAFFIC_QUOTA_DAY_PREFIX = "rl:traffic:day"
_TRAFFIC_CIRCUIT_KEY = "rl:traffic:circuit"


@dataclass(frozen=True, slots=True)
class _CacheEntry:
    expires_at: float
    summary: TrafficSummary


class TrafficService:
    """Fetch and normalize road traffic data near a coordinate."""

    def __init__(self, settings: Settings, cache: CacheManager | None = None) -> None:
        self._settings = settings
        self._cache = cache
        self._client: httpx.AsyncClient | None = None
        self._memory_cache: OrderedDict[tuple[int, int], _CacheEntry] = OrderedDict()
        self._inflight: dict[tuple[int, int], asyncio.Task[TrafficSummary]] = {}
        self._inflight_lock = asyncio.Lock()
        self._circuit_open_until = 0.0

    async def start(self) -> None:
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=3.0, read=6.0, write=3.0, pool=3.0),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
            follow_redirects=False,
            trust_env=False,
        )

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def get_summary(self, latitude: float, longitude: float) -> TrafficSummary:
        """Return a driver-facing traffic summary for the nearest road segment."""
        latitude_bucket, longitude_bucket = _quantize_coordinate(latitude, longitude)

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

        cache_key = (latitude_bucket, longitude_bucket)
        cached = self._memory_cache.get(cache_key)
        now = time.monotonic()
        if cached and cached.expires_at > now:
            self._memory_cache.move_to_end(cache_key)
            return cached.summary
        if cached:
            self._memory_cache.pop(cache_key, None)

        async with self._inflight_lock:
            task = self._inflight.get(cache_key)
            if task is None:
                task = asyncio.create_task(
                    self._lookup_and_cache(cache_key, latitude_bucket, longitude_bucket),
                    name="traffic-provider-lookup",
                )
                self._inflight[cache_key] = task
        try:
            return await asyncio.shield(task)
        finally:
            if task.done():
                async with self._inflight_lock:
                    if self._inflight.get(cache_key) is task:
                        self._inflight.pop(cache_key, None)

    async def _lookup_and_cache(
        self,
        cache_key: tuple[int, int],
        latitude_bucket: int,
        longitude_bucket: int,
    ) -> TrafficSummary:
        """Run one quota-controlled provider lookup for a quantized bucket."""
        now = time.monotonic()
        cached = self._memory_cache.get(cache_key)
        if cached and cached.expires_at > now:
            self._memory_cache.move_to_end(cache_key)
            return cached.summary

        if await self._provider_request_allowed():
            # The provider receives the coarse grid centre, never the raw GPS fix.
            summary = await self._fetch_tomtom_flow(
                latitude_bucket / _COORDINATE_GRID,
                longitude_bucket / _COORDINATE_GRID,
            )
        else:
            summary = _unavailable_summary()

        ttl = min(
            _MAX_CACHE_TTL_SECONDS,
            max(_MIN_CACHE_TTL_SECONDS, self._settings.TRAFFIC_CACHE_TTL_SECONDS),
        )
        self._memory_cache[cache_key] = _CacheEntry(
            expires_at=time.monotonic() + ttl,
            summary=summary,
        )
        self._memory_cache.move_to_end(cache_key)
        while len(self._memory_cache) > _MAX_CACHE_ENTRIES:
            self._memory_cache.popitem(last=False)
        return summary

    async def _provider_request_allowed(self) -> bool:
        """Apply local circuit state and distributed minute/day provider quotas."""
        if time.monotonic() < self._circuit_open_until:
            return False
        if self._cache is None:
            return True

        try:
            if await self._cache.exists(_TRAFFIC_CIRCUIT_KEY):
                return False
            now = int(time.time())
            minute_key = f"{_TRAFFIC_QUOTA_MINUTE_PREFIX}:{now // 60}"
            day_key = f"{_TRAFFIC_QUOTA_DAY_PREFIX}:{now // 86_400}"
            pipe = self._cache.client.pipeline(transaction=True)
            pipe.incr(minute_key)
            pipe.expire(minute_key, 65)
            pipe.incr(day_key)
            pipe.expire(day_key, 86_405)
            minute_count, _minute_expiry, day_count, _day_expiry = await pipe.execute()
            return bool(
                int(minute_count) <= self._settings.TRAFFIC_GLOBAL_REQUESTS_PER_MINUTE
                and int(day_count) <= self._settings.TRAFFIC_GLOBAL_REQUESTS_PER_DAY
            )
        except Exception:
            if self._settings.ENVIRONMENT == "production":
                logger.error("Traffic provider quota unavailable — lookup rejected")
                return False
            logger.warning("Traffic provider quota unavailable — development lookup allowed")
            return True

    async def _open_provider_circuit(self) -> None:
        ttl = self._settings.TRAFFIC_PROVIDER_CIRCUIT_SECONDS
        self._circuit_open_until = time.monotonic() + ttl
        if self._cache is None:
            return
        try:
            await self._cache.set(_TRAFFIC_CIRCUIT_KEY, b"1", ttl=ttl)
        except Exception:
            logger.warning("Traffic provider circuit marker could not be persisted")

    async def _fetch_tomtom_flow(self, latitude: float, longitude: float) -> TrafficSummary:
        if not self._client:
            await self.start()

        assert self._client is not None
        url = f"{self._settings.TOMTOM_TRAFFIC_BASE_URL}/flowSegmentData/relative/10/json"

        if not _is_allowed_tomtom_endpoint(url):
            logger.warning("Traffic provider configuration rejected")
            return _unavailable_summary()

        try:
            body = bytearray()
            async with self._client.stream(
                "GET",
                url,
                params={
                    "point": f"{latitude},{longitude}",
                    "unit": "KMPH",
                    "key": self._settings.TOMTOM_API_KEY,
                },
            ) as response:
                response.raise_for_status()
                content_type = response.headers.get("content-type", "").lower()
                if content_type and "json" not in content_type:
                    raise TypeError
                content_length = response.headers.get("content-length")
                if content_length:
                    try:
                        declared_size = int(content_length)
                    except ValueError:
                        raise TypeError from None
                    if declared_size < 0 or declared_size > _MAX_RESPONSE_BYTES:
                        raise ValueError
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > _MAX_RESPONSE_BYTES:
                        raise ValueError

            payload = orjson.loads(body)
            if not isinstance(payload, dict):
                raise TypeError
            return self._normalize_tomtom_flow(payload)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 429:
                await self._open_provider_circuit()
            logger.warning("Traffic provider lookup failed")
            return _unavailable_summary()
        except (httpx.HTTPError, ValueError, TypeError, AttributeError, OverflowError):
            # Never interpolate the exception: httpx errors may contain the
            # request URL, API key and quantized location.
            logger.warning("Traffic provider lookup failed")
            return _unavailable_summary()

    def _normalize_tomtom_flow(self, payload: dict[str, Any]) -> TrafficSummary:
        flow = payload.get("flowSegmentData") or {}
        current_speed = _bounded_float(flow.get("currentSpeed"), 0, 500)
        free_flow_speed = _bounded_float(flow.get("freeFlowSpeed"), 0, 500)
        current_travel_time = _bounded_float(flow.get("currentTravelTime"), 0, 86_400)
        free_flow_travel_time = _bounded_float(flow.get("freeFlowTravelTime"), 0, 86_400)
        confidence = _bounded_float(flow.get("confidence"), 0, 1)
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


def _bounded_float(value: Any, minimum: float, maximum: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        normalized = float(value)
    except (OverflowError, ValueError):
        return None
    if math.isfinite(normalized) and minimum <= normalized <= maximum:
        return normalized

    return None


def _quantize_coordinate(latitude: float, longitude: float) -> tuple[int, int]:
    """Validate the operational bbox and return coarse cache buckets."""
    if (
        isinstance(latitude, bool)
        or not isinstance(latitude, (int, float))
        or not math.isfinite(latitude)
        or not TRAFFIC_MIN_LATITUDE <= latitude <= TRAFFIC_MAX_LATITUDE
    ):
        raise ValueError("latitude is outside the traffic service area")
    if (
        isinstance(longitude, bool)
        or not isinstance(longitude, (int, float))
        or not math.isfinite(longitude)
        or not TRAFFIC_MIN_LONGITUDE <= longitude <= TRAFFIC_MAX_LONGITUDE
    ):
        raise ValueError("longitude is outside the traffic service area")

    return (
        round(latitude * _COORDINATE_GRID),
        round(longitude * _COORDINATE_GRID),
    )


def _is_allowed_tomtom_endpoint(raw_url: str) -> bool:
    try:
        parsed_url = urlsplit(raw_url)
        port = parsed_url.port
    except (TypeError, ValueError):
        return False
    return (
        parsed_url.scheme == "https"
        and parsed_url.hostname in _ALLOWED_TOMTOM_HOSTS
        and parsed_url.username is None
        and parsed_url.password is None
        and port in (None, 443)
    )


def _unavailable_summary() -> TrafficSummary:
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
