"""Bounded Esri World Imagery tiles for the driver map.

The native MapLibre client cannot add an authorization header to a raster
source.  This service is therefore the sole holder of the ArcGIS API key: it
requests one fixed World Imagery endpoint, returns only valid XYZ tiles that
intersect Catalonia, and keeps a small in-memory cache.  It is deliberately
not a generic image proxy.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import math
import re
import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass

import httpx

from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# Keep this provider URL fixed.  Accepting a URL from the request or from a
# broad environment setting would turn this public route into an SSRF proxy.
_ESRI_WORLD_IMAGERY_TILE_URL = (
    "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
)
_TILE_SIZE = 256
_MAX_SOURCE_IMAGE_BYTES = 512 * 1024
# World Imagery's published metadata includes 23 levels, but the Barcelona
# coverage currently ends at level 20.  Advertising a higher zoom makes
# MapLibre request guaranteed 404s instead of overzooming the level-20 image.
_MAX_OUTPUT_ZOOM = 20
_MIN_LATITUDE = 40.45
_MAX_LATITUDE = 42.95
_MIN_LONGITUDE = 0.00
_MAX_LONGITUDE = 3.50
_SATELLITE_QUOTA_MINUTE_PREFIX = "rl:satellite:minute"
_SATELLITE_QUOTA_DAY_PREFIX = "rl:satellite:day"
_SATELLITE_CIRCUIT_KEY = "rl:satellite:circuit"
_SATELLITE_CLIENT_QUOTA_PREFIX = "rl:satellite:client"
_SATELLITE_IP_QUOTA_PREFIX = "rl:satellite:ip"
_CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{24,80}$")


class SatelliteTileNotFoundError(ValueError):
    """Raised when a requested tile is outside the allowed map area."""


class SatelliteTileUnavailableError(RuntimeError):
    """Raised when the provider cannot return a valid imagery tile."""


class SatelliteTileQuotaExceededError(SatelliteTileUnavailableError):
    """Raised once the configured shared provider budget is exhausted."""


class SatelliteTileClientQuotaExceededError(SatelliteTileUnavailableError):
    """Raised when one installation or IP has exhausted its imagery budget."""


@dataclass(frozen=True, slots=True)
class _CacheEntry:
    expires_at: float
    image: bytes


class SatelliteTileService:
    """Serve bounded, cached Web Mercator World Imagery tiles."""

    def __init__(self, settings: Settings, cache: CacheManager | None = None) -> None:
        self._settings = settings
        self._cache = cache
        self._client: httpx.AsyncClient | None = None
        self._memory_cache: OrderedDict[tuple[int, int, int], _CacheEntry] = OrderedDict()
        self._inflight: dict[tuple[int, int, int], asyncio.Task[bytes]] = {}
        self._inflight_lock = asyncio.Lock()
        # A single style refresh can request dozens of cold tiles.  Bound the
        # upstream concurrency so the server stays responsive and avoids a
        # burst of billable requests.
        self._provider_semaphore = asyncio.Semaphore(4)

    async def start(self) -> None:
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=3.0, read=10.0, write=3.0, pool=20.0),
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=4),
            follow_redirects=False,
            trust_env=False,
            headers={"User-Agent": "AlVolant/1.0 satellite-cache", "Accept": "image/jpeg"},
        )

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def get_tile(
        self,
        z: int,
        x: int,
        y: int,
        *,
        client_id: str | None = None,
        client_ip: str | None = None,
    ) -> bytes:
        """Return a bounded, cached XYZ JPEG tile for a visible map area."""
        key = _validate_tile_coordinates(z, x, y)
        if not self._settings.SATELLITE_TILES_ENABLED or not _tile_intersects_catalonia(*key):
            raise SatelliteTileNotFoundError
        if not self._settings.ARCGIS_API_KEY:
            raise SatelliteTileUnavailableError

        cached = self._cached_image(key)
        if cached is not None:
            return cached

        async with self._inflight_lock:
            task = self._inflight.get(key)
            if task is None:
                # A client consumes its allowance only when this process has
                # to start a new cold-tile fetch. Returning an in-memory tile
                # or joining an already-running fetch remains free: it does
                # not add an Esri request and must not make a cached area
                # unusable once the daily allowance has been reached.
                if client_id is not None:
                    if not client_ip or not await self._client_request_allowed(client_id, client_ip):
                        raise SatelliteTileClientQuotaExceededError
                task = asyncio.create_task(self._fetch_and_cache(key), name="satellite-tile-fetch")
                self._inflight[key] = task
        try:
            return await asyncio.shield(task)
        finally:
            if task.done():
                async with self._inflight_lock:
                    if self._inflight.get(key) is task:
                        self._inflight.pop(key, None)

    async def is_available(self) -> bool:
        """Return whether the UI may offer satellite imagery right now."""
        if not self._settings.SATELLITE_TILES_ENABLED or not self._settings.ARCGIS_API_KEY:
            return False
        if self._cache is None:
            # A production server must account for every upstream request. A
            # local development server can still render imagery without Redis.
            return self._settings.ENVIRONMENT != "production"

        try:
            if await self._cache.exists(_SATELLITE_CIRCUIT_KEY):
                return False
            minute_key = f"{_SATELLITE_QUOTA_MINUTE_PREFIX}:{int(time.time()) // 60}"
            day_key = f"{_SATELLITE_QUOTA_DAY_PREFIX}:{int(time.time()) // 86_400}"
            raw_minute_count, raw_day_count = await asyncio.gather(
                self._cache.get(minute_key),
                self._cache.get(day_key),
            )
            minute_count = int(raw_minute_count) if raw_minute_count else 0
            day_count = int(raw_day_count) if raw_day_count else 0
            return bool(
                minute_count < self._settings.SATELLITE_GLOBAL_REQUESTS_PER_MINUTE
                and day_count < self._settings.SATELLITE_GLOBAL_REQUESTS_PER_DAY
            )
        except (TypeError, ValueError):
            logger.warning("Satellite imagery quota state is invalid")
            return False
        except Exception:
            if self._settings.ENVIRONMENT == "production":
                logger.error("Satellite imagery quota unavailable — imagery disabled")
                return False
            logger.warning("Satellite imagery quota unavailable — development imagery allowed")
            return True

    async def is_client_available(
        self,
        client_id: str,
        client_ip: str,
        *,
        tile: tuple[int, int, int] | None = None,
    ) -> bool:
        """Return whether satellite can be used in the requested map area.

        A cached tile stays available even after a client, IP, or shared
        upstream allowance has been exhausted.  This matters while a driver
        is moving through an area already loaded by the BFF: serving the cache
        neither calls Esri nor consumes a quota token.
        """
        if not self._settings.SATELLITE_TILES_ENABLED or not self._settings.ARCGIS_API_KEY:
            return False
        if tile is not None and self.has_cached_tile(*tile):
            return True
        if not await self.is_available():
            return False
        return await self._client_quota_has_capacity(client_id, client_ip)

    def has_cached_tile(self, z: int, x: int, y: int) -> bool:
        """Return whether an allowed map tile remains in the process cache."""
        try:
            key = _validate_tile_coordinates(z, x, y)
        except SatelliteTileNotFoundError:
            return False
        if not self._settings.SATELLITE_TILES_ENABLED or not _tile_intersects_catalonia(*key):
            return False
        return self._cached_image(key) is not None

    def _cached_image(self, key: tuple[int, int, int]) -> bytes | None:
        """Read an unexpired tile and remove expired entries eagerly."""
        cached = self._memory_cache.get(key)
        if cached is None:
            return None
        if cached.expires_at <= time.monotonic():
            self._memory_cache.pop(key, None)
            return None
        self._memory_cache.move_to_end(key)
        return cached.image

    async def _client_quota_has_capacity(self, client_id: str, client_ip: str) -> bool:
        """Check limits without reserving a tile fetch."""
        if self._cache is None:
            return self._settings.ENVIRONMENT != "production"

        try:
            now = int(time.time())
            client_digest = self._quota_digest(client_id)
            ip_digest = self._quota_digest(client_ip)
            client_minute_key = self._client_quota_key("minute", client_digest, now)
            client_day_key = self._client_quota_key("day", client_digest, now)
            ip_minute_key = self._ip_quota_key("minute", ip_digest, now)
            ip_day_key = self._ip_quota_key("day", ip_digest, now)
            raw_counts = await asyncio.gather(
                self._cache.get(client_minute_key),
                self._cache.get(client_day_key),
                self._cache.get(ip_minute_key),
                self._cache.get(ip_day_key),
            )
            counts = [int(value) if value else 0 for value in raw_counts]
            return bool(
                counts[0] < self._settings.SATELLITE_CLIENT_REQUESTS_PER_MINUTE
                and counts[1] < self._settings.SATELLITE_CLIENT_REQUESTS_PER_DAY
                and counts[2] < self._settings.SATELLITE_IP_REQUESTS_PER_MINUTE
                and counts[3] < self._settings.SATELLITE_IP_REQUESTS_PER_DAY
            )
        except (TypeError, ValueError):
            logger.warning("Satellite client quota state is invalid")
            return False
        except Exception:
            if self._settings.ENVIRONMENT == "production":
                logger.error("Satellite client quota unavailable — imagery disabled")
                return False
            logger.warning("Satellite client quota unavailable — development imagery allowed")
            return True

    async def _fetch_and_cache(self, key: tuple[int, int, int]) -> bytes:
        image = await self._fetch_provider_tile(*key)
        self._memory_cache[key] = _CacheEntry(
            expires_at=time.monotonic() + self._settings.SATELLITE_TILE_CACHE_TTL_SECONDS,
            image=image,
        )
        self._memory_cache.move_to_end(key)
        while len(self._memory_cache) > self._settings.SATELLITE_TILE_CACHE_ENTRIES:
            self._memory_cache.popitem(last=False)
        return image

    async def _fetch_provider_tile(self, z: int, x: int, y: int) -> bytes:
        if not self._client:
            await self.start()
        assert self._client is not None

        if not await self._provider_request_allowed():
            raise SatelliteTileQuotaExceededError

        try:
            async with self._provider_semaphore:
                response = await self._client.get(
                    _ESRI_WORLD_IMAGERY_TILE_URL.format(z=z, x=x, y=y),
                    # World Imagery's MapServer uses the token query parameter.
                    # This URL is never returned, logged, or exposed to the app.
                    params={"token": self._settings.ARCGIS_API_KEY},
                )
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").lower()
            if (
                "image/jpeg" not in content_type
                or not 0 < len(response.content) <= _MAX_SOURCE_IMAGE_BYTES
            ):
                raise ValueError
            return response.content
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 429:
                await self._open_provider_circuit()
            logger.warning("World Imagery tile request failed")
            raise SatelliteTileUnavailableError from None
        except (httpx.HTTPError, ValueError):
            # Do not include upstream URLs, request coordinates, or token data
            # in production logs.
            logger.warning("World Imagery tile request failed")
            raise SatelliteTileUnavailableError from None

    async def _provider_request_allowed(self) -> bool:
        """Reserve one shared cold-tile request inside minute and daily caps."""
        if self._cache is None:
            return self._settings.ENVIRONMENT != "production"

        try:
            if await self._cache.exists(_SATELLITE_CIRCUIT_KEY):
                return False
            now = int(time.time())
            minute_key = f"{_SATELLITE_QUOTA_MINUTE_PREFIX}:{now // 60}"
            day_key = f"{_SATELLITE_QUOTA_DAY_PREFIX}:{now // 86_400}"
            pipe = self._cache.client.pipeline(transaction=True)
            pipe.incr(minute_key)
            pipe.expire(minute_key, 65)
            pipe.incr(day_key)
            pipe.expire(day_key, 86_405)
            minute_count, _minute_expiry, day_count, _day_expiry = await pipe.execute()
            return bool(
                int(minute_count) <= self._settings.SATELLITE_GLOBAL_REQUESTS_PER_MINUTE
                and int(day_count) <= self._settings.SATELLITE_GLOBAL_REQUESTS_PER_DAY
            )
        except Exception:
            if self._settings.ENVIRONMENT == "production":
                logger.error("Satellite imagery quota unavailable — tile rejected")
                return False
            logger.warning("Satellite imagery quota unavailable — development tile allowed")
            return True

    async def _client_request_allowed(self, client_id: str, client_ip: str) -> bool:
        """Reserve one tile request for a hashed installation and IP bucket."""
        if self._cache is None:
            return self._settings.ENVIRONMENT != "production"

        try:
            now = int(time.time())
            client_digest = self._quota_digest(client_id)
            ip_digest = self._quota_digest(client_ip)
            client_minute_key = self._client_quota_key("minute", client_digest, now)
            client_day_key = self._client_quota_key("day", client_digest, now)
            ip_minute_key = self._ip_quota_key("minute", ip_digest, now)
            ip_day_key = self._ip_quota_key("day", ip_digest, now)
            pipe = self._cache.client.pipeline(transaction=True)
            for key, ttl in (
                (client_minute_key, 65),
                (client_day_key, 86_405),
                (ip_minute_key, 65),
                (ip_day_key, 86_405),
            ):
                pipe.incr(key)
                pipe.expire(key, ttl)
            (
                client_minute_count,
                _client_minute_expiry,
                client_day_count,
                _client_day_expiry,
                ip_minute_count,
                _ip_minute_expiry,
                ip_day_count,
                _ip_day_expiry,
            ) = await pipe.execute()
            return bool(
                int(client_minute_count) <= self._settings.SATELLITE_CLIENT_REQUESTS_PER_MINUTE
                and int(client_day_count) <= self._settings.SATELLITE_CLIENT_REQUESTS_PER_DAY
                and int(ip_minute_count) <= self._settings.SATELLITE_IP_REQUESTS_PER_MINUTE
                and int(ip_day_count) <= self._settings.SATELLITE_IP_REQUESTS_PER_DAY
            )
        except Exception:
            if self._settings.ENVIRONMENT == "production":
                logger.error("Satellite client quota unavailable — tile rejected")
                return False
            logger.warning("Satellite client quota unavailable — development tile allowed")
            return True

    def _quota_digest(self, identifier: str) -> str:
        secret = self._settings.RATE_LIMIT_HASH_KEY or "development-satellite-quota-salt"
        return hmac.new(
            secret.encode("utf-8"),
            identifier.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()[:24]

    @staticmethod
    def _client_quota_key(bucket: str, digest: str, now: int) -> str:
        period = now // (60 if bucket == "minute" else 86_400)
        return f"{_SATELLITE_CLIENT_QUOTA_PREFIX}:{bucket}:{digest}:{period}"

    @staticmethod
    def _ip_quota_key(bucket: str, digest: str, now: int) -> str:
        period = now // (60 if bucket == "minute" else 86_400)
        return f"{_SATELLITE_IP_QUOTA_PREFIX}:{bucket}:{digest}:{period}"

    async def _open_provider_circuit(self) -> None:
        if self._cache is None:
            return
        try:
            await self._cache.set(
                _SATELLITE_CIRCUIT_KEY,
                b"1",
                ttl=self._settings.SATELLITE_PROVIDER_CIRCUIT_SECONDS,
            )
        except Exception:
            logger.warning("Satellite imagery provider circuit marker could not be persisted")


def _validate_tile_coordinates(z: int, x: int, y: int) -> tuple[int, int, int]:
    if (
        isinstance(z, bool)
        or isinstance(x, bool)
        or isinstance(y, bool)
        or not all(isinstance(value, int) for value in (z, x, y))
        or not 0 <= z <= _MAX_OUTPUT_ZOOM
    ):
        raise SatelliteTileNotFoundError
    tile_count = 2**z
    if not 0 <= x < tile_count or not 0 <= y < tile_count:
        raise SatelliteTileNotFoundError
    return z, x, y


def normalize_satellite_client_id(value: str | None) -> str | None:
    """Accept only opaque server-issued installation identifiers."""
    if not value:
        return None
    normalized = value.strip()
    return normalized if _CLIENT_ID_RE.fullmatch(normalized) else None


def new_satellite_client_id() -> str:
    """Create a high-entropy opaque identifier; it is never persisted raw server-side."""
    return secrets.token_urlsafe(24)


def _tile_intersects_catalonia(z: int, x: int, y: int) -> bool:
    west, north, east, south = _mercator_tile_bounds(z, x, y)
    return (
        east >= _MIN_LONGITUDE
        and west <= _MAX_LONGITUDE
        and north >= _MIN_LATITUDE
        and south <= _MAX_LATITUDE
    )


def _mercator_tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    tile_count = 2**z
    west = x / tile_count * 360 - 180
    east = (x + 1) / tile_count * 360 - 180
    north = _mercator_y_to_latitude(y / tile_count)
    south = _mercator_y_to_latitude((y + 1) / tile_count)
    return west, north, east, south


def _mercator_y_to_latitude(normalized_y: float) -> float:
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * normalized_y))))
