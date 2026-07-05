"""
ATM GTFS-Realtime Service.

Fetches the three unified ATM production feeds:
1. TripUpdates
2. VehiclePositions
3. ServiceAlerts

Parses the binary protobuf payloads and stores normalized entities in Redis.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import httpx
from google.transit import gtfs_realtime_pb2
from google.protobuf.message import DecodeError

from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.core.exceptions import ExternalAPIError, GTFSParseError
from app.core.logging import get_logger
from app.models.atm_rt import (
    AlertCause,
    AlertEffect,
    ATMRealtimeFeed,
    ServiceAlert,
    StopTimeUpdate,
    TripUpdate,
    VehiclePosition,
)

logger = get_logger(__name__)

# Redis key namespaces
_KEY_FEED_FULL = "atm_rt:feed:full"
_KEY_VEHICLES = "atm_rt:vehicles:all"
_KEY_TRIPS = "atm_rt:trips:all"
_KEY_ALERTS = "atm_rt:alerts:all"
_KEY_LAST_UPDATED = "atm_rt:meta:last_updated"

# ATM language priority mapping (ca = Catalan, es = Spanish, en = English)
_LANG_PRIORITY = ("ca", "es", "en", "")


class ATMRTService:
    """Service to fetch, parse, and cache ATM Real-Time GTFS feeds.

    Args:
        settings: Application settings (injected).
        cache: Redis cache manager (injected).
    """

    def __init__(self, settings: Settings, cache: CacheManager) -> None:
        self._settings = settings
        self._cache = cache
        self._http: httpx.AsyncClient | None = None

        self._urls = {
            "trip_updates": settings.ATM_RT_TRIP_UPDATES_URL,
            "vehicle_positions": settings.ATM_RT_VEHICLE_POSITIONS_URL,
            "alerts": settings.ATM_RT_ALERTS_URL,
        }

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Initialize the HTTP client for polling."""
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=10.0),
            limits=httpx.Limits(max_connections=5, max_keepalive_connections=2),
            headers={"User-Agent": "curl/8.20.0"},
            http2=True,
            follow_redirects=True,
        )
        logger.info("ATM GTFS-RT client initialized")

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._http:
            await self._http.aclose()
            logger.info("ATM GTFS-RT client closed")

    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            raise RuntimeError("ATMRTService.start() has not been called")
        return self._http

    # ------------------------------------------------------------------
    # Data Fetching
    # ------------------------------------------------------------------

    async def fetch_and_parse_all(self) -> ATMRealtimeFeed:
        """Fetch all RT feeds concurrently, parse, and cache the data.

        If a feed returns a 404 or fails, we catch the error, log a warning,
        and proceed with the other feeds.
        """
        logger.debug("Fetching ATM GTFS-RT feeds")

        tasks = [
            self._fetch_feed(self._urls["trip_updates"], "TripUpdates"),
            self._fetch_feed(self._urls["vehicle_positions"], "VehiclePositions"),
            self._fetch_feed(self._urls["alerts"], "Alerts"),
        ]

        results = await asyncio.gather(*tasks, return_exceptions=True)

        raw_tu = results[0] if not isinstance(results[0], Exception) else b""
        raw_vp = results[1] if not isinstance(results[1], Exception) else b""
        raw_al = results[2] if not isinstance(results[2], Exception) else b""

        if isinstance(results[0], Exception):
            logger.warning(f"Failed to fetch TripUpdates: {results[0]}")
        if isinstance(results[1], Exception):
            logger.warning(f"Failed to fetch VehiclePositions: {results[1]}")
        if isinstance(results[2], Exception):
            logger.warning(f"Failed to fetch Alerts: {results[2]}")

        feed = ATMRealtimeFeed()

        # Parse each feed if data exists
        if raw_tu:
            feed = self._parse_protobuf(raw_tu, feed)
        if raw_vp:
            feed = self._parse_protobuf(raw_vp, feed)
        if raw_al:
            feed = self._parse_protobuf(raw_al, feed)

        feed.entity_count = (
            len(feed.vehicle_positions)
            + len(feed.trip_updates)
            + len(feed.service_alerts)
        )

        await self._cache_feed(feed)

        logger.info(
            "Parsed and cached ATM GTFS-RT feeds: "
            "%d vehicles, %d trips, %d alerts",
            len(feed.vehicle_positions),
            len(feed.trip_updates),
            len(feed.service_alerts),
        )
        return feed

    async def _fetch_feed(self, url: str, name: str) -> bytes | None:
        """Fetch a GTFS-RT protobuf feed using curl to bypass WAF."""
        if not url:
            return None

        logger.debug("Fetching %s from %s", name, url)
        try:
            proc = await asyncio.create_subprocess_exec(
                "curl", "-sL", "-A", "curl/8.20.0", url,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()
            if proc.returncode != 0:
                raise ExternalAPIError("ATM", f"curl failed for {name}: {stderr.decode()}")
            
            # Check if we got an HTML response instead of binary
            if stdout.startswith(b"<html") or stdout.startswith(b"<!DOC"):
                raise ExternalAPIError("ATM", f"Received HTML instead of protobuf for {name}")
                
            return stdout
        except Exception as exc:
            raise ExternalAPIError("ATM", f"Failed to fetch {name}: {exc}") from exc

    # ------------------------------------------------------------------
    # Protobuf Parsing
    # ------------------------------------------------------------------

    def _parse_protobuf(self, raw_bytes: bytes, feed: ATMRealtimeFeed) -> ATMRealtimeFeed:
        """Parse binary protobuf into normalized pydantic models."""
        feed_message = gtfs_realtime_pb2.FeedMessage()
        try:
            feed_message.ParseFromString(raw_bytes)
        except DecodeError as exc:
            raise GTFSParseError("feed.pb", f"Failed to parse protobuf: {exc}") from exc

        for entity in feed_message.entity:
            if entity.HasField("vehicle"):
                vp = self._parse_vehicle(entity.vehicle)
                if vp:
                    feed.vehicle_positions.append(vp)
            elif entity.HasField("trip_update"):
                tu = self._parse_trip_update(entity.trip_update)
                if tu:
                    feed.trip_updates.append(tu)
            elif entity.HasField("alert"):
                al = self._parse_alert(entity.id, entity.alert)
                if al:
                    feed.service_alerts.append(al)

        return feed

    def _parse_vehicle(self, v: gtfs_realtime_pb2.VehiclePosition) -> VehiclePosition | None:
        """Extract a VehiclePosition entity."""
        vid = v.vehicle.id if v.HasField("vehicle") else ""
        if not vid:
            return None

        route_id = v.trip.route_id if v.HasField("trip") else ""
        trip_id = v.trip.trip_id if v.HasField("trip") else ""
        lat = v.position.latitude if v.HasField("position") else 0.0
        lon = v.position.longitude if v.HasField("position") else 0.0
        bearing = v.position.bearing if v.position.HasField("bearing") else None
        speed = v.position.speed if v.position.HasField("speed") else None
        timestamp = v.timestamp if v.HasField("timestamp") else 0

        # Basic validity check for coordinates (must be realistic for Earth)
        if lat == 0.0 and lon == 0.0:
            return None

        return VehiclePosition(
            vehicle_id=vid,
            route_id=route_id,
            trip_id=trip_id,
            latitude=lat,
            longitude=lon,
            bearing=bearing,
            speed=speed,
            timestamp=timestamp,
        )

    def _parse_trip_update(self, tu: gtfs_realtime_pb2.TripUpdate) -> TripUpdate | None:
        """Extract a TripUpdate entity."""
        trip_id = tu.trip.trip_id if tu.HasField("trip") else ""
        if not trip_id:
            return None

        route_id = tu.trip.route_id if tu.HasField("trip") else ""
        start_date = tu.trip.start_date if tu.trip.HasField("start_date") else ""
        vid = tu.vehicle.id if tu.HasField("vehicle") else ""
        timestamp = tu.timestamp if tu.HasField("timestamp") else 0

        updates = []
        for stu in tu.stop_time_update:
            stop_id = stu.stop_id
            if not stop_id:
                continue

            arr_delay = stu.arrival.delay if stu.HasField("arrival") else 0
            dep_delay = stu.departure.delay if stu.HasField("departure") else 0

            updates.append(
                StopTimeUpdate(
                    stop_id=stop_id,
                    stop_sequence=stu.stop_sequence,
                    arrival_delay=arr_delay,
                    departure_delay=dep_delay,
                )
            )

        return TripUpdate(
            trip_id=trip_id,
            route_id=route_id,
            vehicle_id=vid,
            start_date=start_date,
            stop_time_updates=updates,
            timestamp=timestamp,
        )

    def _parse_alert(self, entity_id: str, al: gtfs_realtime_pb2.Alert) -> ServiceAlert | None:
        """Extract a ServiceAlert entity, enforcing Catalan language priority."""
        if not entity_id:
            return None

        header = self._extract_translated_string(al.header_text)
        desc = self._extract_translated_string(al.description_text)
        url = self._extract_translated_string(al.url)

        # Fallback enums if standard parsing fails
        try:
            cause_str = gtfs_realtime_pb2.Alert.Cause.Name(al.cause)
        except ValueError:
            cause_str = "UNKNOWN_CAUSE"

        try:
            effect_str = gtfs_realtime_pb2.Alert.Effect.Name(al.effect)
        except ValueError:
            effect_str = "UNKNOWN_EFFECT"

        # Extract active periods and convert to ISO 8601
        start_iso, end_iso = None, None
        if al.active_period:
            period = al.active_period[0]
            if period.HasField("start"):
                start_iso = datetime.fromtimestamp(period.start, tz=timezone.utc).isoformat()
            if period.HasField("end"):
                end_iso = datetime.fromtimestamp(period.end, tz=timezone.utc).isoformat()

        # Extract affected routes/stops
        routes = []
        stops = []
        for entity_selector in al.informed_entity:
            if entity_selector.HasField("route_id"):
                routes.append(entity_selector.route_id)
            if entity_selector.HasField("stop_id"):
                stops.append(entity_selector.stop_id)

        return ServiceAlert(
            alert_id=entity_id,
            header_text=header,
            description_text=desc,
            cause=getattr(AlertCause, cause_str, AlertCause.UNKNOWN_CAUSE),
            effect=getattr(AlertEffect, effect_str, AlertEffect.UNKNOWN_EFFECT),
            url=url,
            active_period_start=start_iso,
            active_period_end=end_iso,
            affected_route_ids=routes,
            affected_stop_ids=stops,
        )

    def _extract_translated_string(self, ts: gtfs_realtime_pb2.TranslatedString) -> str:
        """Extract the preferred translation from a TranslatedString."""
        if not ts.translation:
            return ""

        translations = {t.language.lower(): t.text for t in ts.translation}

        for lang in _LANG_PRIORITY:
            if lang in translations:
                return translations[lang]

            # ATM sometimes uses 'cat' instead of 'ca'
            if lang == "ca" and "cat" in translations:
                return translations["cat"]

        # If none of our priorities match, return the first one available
        return ts.translation[0].text

    # ------------------------------------------------------------------
    # Caching / Retrieval
    # ------------------------------------------------------------------

    async def _cache_feed(self, feed: ATMRealtimeFeed) -> None:
        """Cache the parsed feed and its collections in Redis."""
        ttl = self._settings.CACHE_TTL_ATM_REALTIME

        # Pipeline dictionary for batched saving
        pipeline_data = {
            _KEY_FEED_FULL: feed.model_dump(mode="json"),
            _KEY_VEHICLES: [v.model_dump(mode="json") for v in feed.vehicle_positions],
            _KEY_TRIPS: [t.model_dump(mode="json") for t in feed.trip_updates],
            _KEY_ALERTS: [a.model_dump(mode="json") for a in feed.service_alerts],
        }

        await self._cache.mset_json(pipeline_data, ttl=ttl)
        await self._cache.set(
            _KEY_LAST_UPDATED,
            feed.feed_timestamp.isoformat(),
            ttl=ttl,
        )

    async def get_cached_feed(self) -> ATMRealtimeFeed | None:
        """Retrieve the full feed snapshot from cache."""
        data = await self._cache.get_json(_KEY_FEED_FULL)
        if not data:
            return None
        return ATMRealtimeFeed(**data)

    async def get_cached_vehicles(self) -> list[VehiclePosition]:
        data = await self._cache.get_json(_KEY_VEHICLES)
        if not data:
            return []
        return [VehiclePosition(**v) for v in data]

    async def get_cached_trips(self) -> list[TripUpdate]:
        data = await self._cache.get_json(_KEY_TRIPS)
        if not data:
            return []
        return [TripUpdate(**t) for t in data]

    async def get_cached_alerts(self) -> list[ServiceAlert]:
        data = await self._cache.get_json(_KEY_ALERTS)
        if not data:
            return []
        return [ServiceAlert(**a) for a in data]
