"""
ATM GTFS-Realtime Service.

Fetches the three unified ATM production feeds:
1. TripUpdates
2. VehiclePositions
3. ServiceAlerts

Parses the binary protobuf payloads and stores normalized entities in Redis.

Enhanced with:
- Subprocess timeout to prevent zombie curl processes
- Response size limits to prevent OOM
- Auto-classification of alerts (detour, stop cancellation, schedule info)
- Alternative stop extraction from description text
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone

import httpx
from google.transit import gtfs_realtime_pb2
from google.protobuf.message import DecodeError

from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.core.exceptions import ExternalAPIError, GTFSParseError
from app.core.logging import get_logger
from app.models.atm_rt import (
    AffectedStopDetail,
    AlertCause,
    AlertEffect,
    AlertSeverity,
    AlertType,
    AlternativeStop,
    ATMRealtimeFeed,
    ServiceAlert,
    StopStatus,
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

# Safety limits
_MAX_RESPONSE_BYTES = 50 * 1024 * 1024  # 50 MB
_CURL_TIMEOUT_SECONDS = 30

# Regex pattern to extract stop codes and names from Catalan alert descriptions
# Matches patterns like "009463 Jumilla, 53" or "105958 Metro Can Peixauet"
_STOP_CODE_PATTERN = re.compile(
    r"(\d{5,6})\s+([A-ZÀ-Ü][^-\n\d]{2,60}?)(?:\s*-\s*|\s*$)",
    re.MULTILINE,
)


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
        """Fetch a GTFS-RT protobuf feed using curl to bypass WAF.

        Includes a subprocess timeout to prevent zombie processes and
        a response size limit to prevent OOM.
        """
        if not url:
            return None

        logger.debug("Fetching %s from %s", name, url)
        try:
            proc = await asyncio.create_subprocess_exec(
                "curl", "-sL", "-A", "curl/8.20.0",
                "--max-filesize", str(_MAX_RESPONSE_BYTES),
                url,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(),
                    timeout=_CURL_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                raise ExternalAPIError(
                    "ATM",
                    f"Timeout fetching {name} (>{_CURL_TIMEOUT_SECONDS}s)",
                )

            if proc.returncode != 0:
                raise ExternalAPIError("ATM", f"curl failed for {name}: {stderr.decode()}")

            # Check if we got an HTML response instead of binary
            if stdout.startswith(b"<html") or stdout.startswith(b"<!DOC"):
                raise ExternalAPIError("ATM", f"Received HTML instead of protobuf for {name}")

            # Size check (belt and suspenders — curl --max-filesize should catch this)
            if len(stdout) > _MAX_RESPONSE_BYTES:
                raise ExternalAPIError(
                    "ATM",
                    f"Response for {name} exceeds size limit "
                    f"({len(stdout)} > {_MAX_RESPONSE_BYTES} bytes)",
                )

            return stdout
        except ExternalAPIError:
            raise
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
        """Extract a ServiceAlert entity with auto-classification.

        Enriches the standard GTFS-RT alert with:
        - ``alert_type``: Derived from effect + description analysis
        - ``severity``: Derived from effect
        - ``alternative_stops``: Parsed from description text
        - ``affected_stop_details``: Per-stop status
        - ``detour_description``: Extracted from description
        """
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

        # --- Auto-classification ---
        alert_type = self._classify_alert_type(effect_str, header, desc)
        severity = self._classify_severity(effect_str, alert_type)
        alternative_stops = self._extract_alternative_stops(desc)
        affected_details = self._build_affected_stop_details(stops, alert_type, header)
        detour_desc = self._extract_detour_description(desc) if alert_type == AlertType.DETOUR else ""

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
            alert_type=alert_type,
            severity=severity,
            affected_stop_details=affected_details,
            alternative_stops=alternative_stops,
            detour_description=detour_desc,
        )

    # ------------------------------------------------------------------
    # Alert Classification Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _classify_alert_type(effect: str, header: str, description: str) -> str:
        """Classify the alert into a high-level type.

        Uses the GTFS-RT effect field as primary signal, then falls back
        to keyword analysis of the Catalan description text.
        """
        header_lower = header.lower()
        desc_lower = description.lower()

        # DETOUR: explicit effect or keywords
        if effect == "DETOUR" or "desviament" in header_lower or "desviament" in desc_lower:
            # Check if it's actually a stop cancellation disguised as detour
            if "anul·la" in header_lower and "desviament" not in header_lower:
                return AlertType.STOP_CANCELLATION
            return AlertType.DETOUR

        # NO_SERVICE: stop or route is fully suspended
        if effect == "NO_SERVICE" or "anul·la" in header_lower:
            return AlertType.STOP_CANCELLATION

        # MODIFIED_SERVICE or REDUCED_SERVICE
        if effect in ("MODIFIED_SERVICE", "REDUCED_SERVICE"):
            return AlertType.SERVICE_CHANGE

        # Schedule/operational info (e.g. "parades d'origen i final de recorregut")
        if any(
            kw in desc_lower
            for kw in ("regulació horària", "origen i final", "sense haver de tornar")
        ):
            return AlertType.SCHEDULE_INFO

        return AlertType.GENERAL_INFO

    @staticmethod
    def _classify_severity(effect: str, alert_type: str) -> str:
        """Determine alert severity for UI prioritization."""
        if effect in ("NO_SERVICE",) or alert_type == AlertType.STOP_CANCELLATION:
            return AlertSeverity.SEVERE
        if effect in ("DETOUR", "MODIFIED_SERVICE") or alert_type == AlertType.DETOUR:
            return AlertSeverity.WARNING
        return AlertSeverity.INFO

    @staticmethod
    def _extract_alternative_stops(description: str) -> list[AlternativeStop]:
        """Parse alternative stop codes and names from description text.

        AMB alerts typically list alternatives as:
            ``Parades alternatives: - 009463 Jumilla, 53 - 009464 Almeria, 39``

        Returns a list of ``AlternativeStop`` objects.
        """
        alternatives: list[AlternativeStop] = []

        # Look for the "Parades alternatives:" section
        alt_match = re.search(
            r"[Pp]arad[ea]s?\s+alternativ[ea]s?\s*:?\s*(.*?)(?:Les\s+lín|L'itinerari|$)",
            description,
            re.DOTALL | re.IGNORECASE,
        )
        if not alt_match:
            return alternatives

        alt_text = alt_match.group(1)

        # Extract individual stop codes and names
        for m in _STOP_CODE_PATTERN.finditer(alt_text):
            code = m.group(1)
            name = m.group(2).strip().rstrip(" -")
            if name:
                alternatives.append(
                    AlternativeStop(
                        stop_id=f"AMB_{code}",
                        stop_name=name,
                    )
                )

        return alternatives

    @staticmethod
    def _build_affected_stop_details(
        stop_ids: list[str],
        alert_type: str,
        header: str,
    ) -> list[AffectedStopDetail]:
        """Build per-stop detail records for affected stops."""
        details: list[AffectedStopDetail] = []
        for stop_id in stop_ids:
            status = StopStatus.TEMPORARILY_CANCELED
            if alert_type == AlertType.DETOUR:
                status = StopStatus.TEMPORARILY_CANCELED
            elif alert_type == AlertType.SCHEDULE_INFO:
                status = StopStatus.ACTIVE

            details.append(
                AffectedStopDetail(
                    stop_id=stop_id,
                    status=status,
                    reason=header,
                )
            )
        return details

    @staticmethod
    def _extract_detour_description(description: str) -> str:
        """Extract a concise detour path description from the full text.

        Looks for the section describing the actual route modification.
        """
        # Look for "es modifica el recorregut habitual" pattern
        match = re.search(
            r"(es modifica el recorregut habitual.*?)(?:Parad[ea]s?\s+alternativ|$)",
            description,
            re.DOTALL | re.IGNORECASE,
        )
        if match:
            text = match.group(1).strip()
            # Clean up excessive whitespace
            text = re.sub(r"\s+", " ", text)
            return text[:500]  # Cap at 500 chars

        return ""

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
