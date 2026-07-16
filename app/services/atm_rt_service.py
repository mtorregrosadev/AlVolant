"""
ATM GTFS-Realtime Service.

Fetches the three unified ATM production feeds:
1. TripUpdates
2. VehiclePositions
3. ServiceAlerts

Parses the binary protobuf payloads and stores normalized entities in Redis.

Enhanced with:
- Streamed HTTP reads with response limits
- Response size limits to prevent OOM
- Auto-classification of alerts (detour, stop cancellation, schedule info)
- Alternative stop extraction from description text
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from datetime import UTC, datetime
from urllib.parse import urljoin, urlsplit

import httpx
from google.protobuf.message import DecodeError
from google.transit import gtfs_realtime_pb2
from pydantic import ValidationError

from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.core.exceptions import ExternalAPIError, GTFSParseError
from app.core.logging import get_logger
from app.models.atm_rt import (
    AffectedEntity,
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
    VehicleStopStatus,
)

logger = get_logger(__name__)

# Redis key namespaces
_KEY_FEED_FULL = "atm_rt:feed:full"
_KEY_VEHICLES = "atm_rt:vehicles:all"
_KEY_TRIPS = "atm_rt:trips:all"
_KEY_ALERTS = "atm_rt:alerts:all"
_KEY_LAST_UPDATED = "atm_rt:meta:last_updated"
_KEY_COMPONENT_UPDATED_PREFIX = "atm_rt:meta:component"
_KEY_COMPONENT_PROVIDER_TIMESTAMP_PREFIX = "atm_rt:meta:provider_timestamp"
_KEY_VEHICLES_ROUTE_PREFIX = "atm_rt:vehicles:route"
_KEY_TRIPS_ROUTE_PREFIX = "atm_rt:trips:route"
_KEY_VEHICLE_ROUTES = "atm_rt:vehicles:route_ids"
_KEY_TRIP_ROUTES = "atm_rt:trips:route_ids"

# ATM uses both ``ca`` and ``cat`` for Catalan depending on the operator.
_LANG_PRIORITY = ("ca", "cat", "es", "en", "")

# Safety limits
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_MAX_PROTOBUF_ENTITIES = 50_000
_MAX_STOP_UPDATES_PER_TRIP = 500
_MAX_TOTAL_STOP_UPDATES = 50_000
_MAX_ID_LENGTH = 160
_MAX_ALERT_SELECTORS = 1_000
_MAX_TOTAL_ALERT_SELECTORS = 20_000
_MAX_TRANSLATIONS = 20
_MAX_ROUTE_ALERTS = 50
_SAFE_ID_PATTERN = re.compile(r"^[^\x00-\x1f\x7f]{1,160}$")
_MAX_REDIRECTS = 3
_MAX_PROVIDER_FUTURE_SKEW_SECONDS = 30
_ROUTE_INDEX_VERSION = 2
_ALLOWED_ATM_RT_HOSTS = frozenset({"t-mobilitat.atm.cat", "t-mobilitat.cat"})

# Regex pattern to extract stop codes and names from Catalan alert descriptions
# Matches patterns like "009463 Jumilla, 53" or "105958 Metro Can Peixauet"
_STOP_CODE_PATTERN = re.compile(
    r"(\d{5,6})\s+([A-ZÀ-Ü][^-\n\d]{2,60}?)(?:\s*-\s*|\s*$)",
    re.MULTILINE,
)


def _is_safe_id(value: str) -> bool:
    return _SAFE_ID_PATTERN.fullmatch(value) is not None


def _safe_timestamp_iso(value: int) -> str | None:
    try:
        return datetime.fromtimestamp(value, tz=UTC).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


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
        for name, url in self._urls.items():
            if url:
                self._validate_feed_url(url, name)
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=10.0),
            limits=httpx.Limits(max_connections=5, max_keepalive_connections=2),
            headers={"User-Agent": "curl/8.20.0"},
            follow_redirects=False,
            trust_env=False,
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

        successful_results = [result for result in results if isinstance(result, bytes) and result]
        if not successful_results:
            raise ExternalAPIError("ATM", "All realtime feeds are unavailable")

        component_names = ("trip_updates", "vehicle_positions", "alerts")
        display_names = ("TripUpdates", "VehiclePositions", "Alerts")
        parsed_components: dict[str, ATMRealtimeFeed] = {}
        provider_timestamps: dict[str, int] = {}
        unchanged_components: set[str] = set()
        for component, name, result in zip(
            component_names,
            display_names,
            results,
            strict=True,
        ):
            if isinstance(result, Exception):
                logger.warning("ATM %s feed unavailable (%s)", name, type(result).__name__)
            elif isinstance(result, bytes) and result:
                try:
                    parsed_result = await self._parse_component_payload(
                        result,
                        component,
                    )
                except GTFSParseError as exc:
                    logger.warning("ATM %s feed rejected (%s)", name, type(exc).__name__)
                    continue
                if parsed_result is None:
                    unchanged_components.add(component)
                    continue
                parsed, provider_timestamp = parsed_result
                parsed_components[component] = parsed
                provider_timestamps[component] = provider_timestamp

        if not parsed_components and not unchanged_components:
            raise GTFSParseError("feed.pb", "All available ATM realtime components were rejected")

        successful_components = set(parsed_components)

        # Start from the still-valid last-good component keys. A failed feed is
        # never overwritten with an empty list, while each successful feed gets
        # its own TTL refreshed below.
        feed = ATMRealtimeFeed(
            trip_updates=await self.get_cached_trips(),
            vehicle_positions=await self.get_cached_vehicles(),
            service_alerts=await self.get_cached_alerts(),
        )

        if parsed := parsed_components.get("trip_updates"):
            feed.trip_updates = parsed.trip_updates
        if parsed := parsed_components.get("vehicle_positions"):
            feed.vehicle_positions = parsed.vehicle_positions
        if parsed := parsed_components.get("alerts"):
            feed.service_alerts = parsed.service_alerts

        feed.entity_count = (
            len(feed.vehicle_positions) + len(feed.trip_updates) + len(feed.service_alerts)
        )

        if successful_components:
            await self._cache_feed(
                feed,
                successful_components,
                provider_timestamps=provider_timestamps,
            )

        logger.info(
            "Processed ATM GTFS-RT feeds: %d vehicles, %d trips, %d alerts",
            len(feed.vehicle_positions),
            len(feed.trip_updates),
            len(feed.service_alerts),
        )
        return feed

    async def _fetch_feed(self, url: str, name: str) -> bytes | None:
        """Stream a GTFS-RT protobuf feed with a hard response limit."""
        if not url:
            return None

        current_url = self._validate_feed_url(url, name)
        logger.debug("Fetching ATM %s feed", name)

        for redirect_count in range(_MAX_REDIRECTS + 1):
            try:
                payload = bytearray()
                async with self.http.stream(
                    "GET",
                    current_url,
                    follow_redirects=False,
                ) as response:
                    if response.is_redirect:
                        if redirect_count >= _MAX_REDIRECTS:
                            raise ExternalAPIError("ATM", f"Too many redirects fetching {name}")
                        location = response.headers.get("location")
                        if not location:
                            raise ExternalAPIError("ATM", f"Invalid redirect fetching {name}")
                        current_url = self._validate_feed_url(
                            urljoin(str(response.url), location),
                            name,
                        )
                        continue

                    response.raise_for_status()
                    content_length = response.headers.get("content-length")
                    if content_length:
                        try:
                            declared_size = int(content_length)
                        except ValueError:
                            raise ExternalAPIError(
                                "ATM",
                                f"Invalid response metadata for {name}",
                            ) from None
                        if declared_size < 0 or declared_size > _MAX_RESPONSE_BYTES:
                            raise ExternalAPIError(
                                "ATM",
                                f"{name} response exceeds size limit",
                            )

                    async for chunk in response.aiter_bytes():
                        payload.extend(chunk)
                        if len(payload) > _MAX_RESPONSE_BYTES:
                            raise ExternalAPIError(
                                "ATM",
                                f"{name} response exceeds size limit",
                            )

                content = bytes(payload)
                stripped = content.lstrip()
                if not content:
                    raise ExternalAPIError("ATM", f"Empty response fetching {name}")
                if stripped.startswith(b"<"):
                    raise ExternalAPIError("ATM", f"Received HTML instead of protobuf for {name}")
                if stripped.startswith((b"{", b"[")):
                    raise ExternalAPIError("ATM", f"Received JSON instead of protobuf for {name}")
                return content
            except ExternalAPIError:
                raise
            except httpx.TimeoutException as exc:
                raise ExternalAPIError("ATM", f"Timeout fetching {name}") from exc
            except httpx.HTTPStatusError as exc:
                raise ExternalAPIError(
                    "ATM",
                    f"HTTP {exc.response.status_code} fetching {name}",
                ) from exc
            except httpx.HTTPError as exc:
                raise ExternalAPIError("ATM", f"Connection failure fetching {name}") from exc
            except Exception as exc:
                raise ExternalAPIError("ATM", f"Invalid response fetching {name}") from exc

        raise ExternalAPIError("ATM", f"Redirect resolution failed for {name}")

    def _validate_feed_url(self, raw_url: str, name: str) -> str:
        """Accept only the official HTTPS Open Data origins and paths."""
        try:
            parsed = urlsplit(raw_url)
            port = parsed.port
        except (TypeError, ValueError):
            raise ExternalAPIError("ATM", f"Invalid endpoint configured for {name}") from None

        configured_hosts = {
            host.strip().lower()
            for host in self._settings.OUTBOUND_ALLOWED_HOSTS.split(",")
            if host.strip()
        }
        hostname = (parsed.hostname or "").lower()
        if (
            parsed.scheme != "https"
            or hostname not in _ALLOWED_ATM_RT_HOSTS
            or hostname not in configured_hosts
            or parsed.username is not None
            or parsed.password is not None
            or port not in (None, 443)
            or not parsed.path.startswith("/opendata/")
            or parsed.query
            or parsed.fragment
        ):
            raise ExternalAPIError("ATM", f"Unsafe endpoint configured for {name}")
        return raw_url

    # ------------------------------------------------------------------
    # Protobuf Parsing
    # ------------------------------------------------------------------

    def _parse_protobuf(self, raw_bytes: bytes, feed: ATMRealtimeFeed) -> ATMRealtimeFeed:
        """Parse binary protobuf into normalized pydantic models."""
        feed_message = self._decode_protobuf(raw_bytes)
        self._validate_feed_header(feed_message)
        self._validate_message_budget(feed_message)
        return self._model_feed_message(feed_message, feed)

    async def _parse_component_payload(
        self,
        raw_bytes: bytes,
        component: str,
    ) -> tuple[ATMRealtimeFeed, int] | None:
        """Validate one component fully before creating application models."""
        feed_message = self._decode_protobuf(raw_bytes)
        provider_timestamp = self._validate_feed_header(feed_message)
        if not await self._provider_timestamp_is_new(component, provider_timestamp):
            return None
        self._validate_component_entities(feed_message, component)
        self._validate_message_budget(feed_message)
        parsed = self._model_feed_message(feed_message, ATMRealtimeFeed())
        return parsed, provider_timestamp

    @staticmethod
    def _decode_protobuf(raw_bytes: bytes) -> gtfs_realtime_pb2.FeedMessage:
        """Decode one bounded protobuf payload without creating Pydantic models."""
        feed_message = gtfs_realtime_pb2.FeedMessage()
        try:
            feed_message.ParseFromString(raw_bytes)
        except DecodeError as exc:
            raise GTFSParseError("feed.pb", f"Failed to parse protobuf: {exc}") from exc

        if len(feed_message.entity) > _MAX_PROTOBUF_ENTITIES:
            raise GTFSParseError("feed.pb", "Feed entity limit exceeded")

        return feed_message

    def _validate_feed_header(self, feed_message: gtfs_realtime_pb2.FeedMessage) -> int:
        """Accept only current, full-snapshot feeds with a trustworthy timestamp."""
        header = feed_message.header
        if header.incrementality != gtfs_realtime_pb2.FeedHeader.FULL_DATASET:
            raise GTFSParseError("feed.pb", "Differential realtime feeds are unsupported")
        if not header.HasField("timestamp") or header.timestamp <= 0:
            raise GTFSParseError("feed.pb", "Feed header timestamp is required")

        provider_timestamp = int(header.timestamp)
        now_timestamp = int(datetime.now(tz=UTC).timestamp())
        if provider_timestamp < now_timestamp - self._freshness_window_seconds():
            raise GTFSParseError("feed.pb", "Provider feed is stale")
        if provider_timestamp > now_timestamp + _MAX_PROVIDER_FUTURE_SKEW_SECONDS:
            raise GTFSParseError("feed.pb", "Provider feed timestamp is in the future")
        return provider_timestamp

    async def _provider_timestamp_is_new(self, component: str, timestamp: int) -> bool:
        """Return false for an unchanged snapshot; reject older component replays."""
        raw_previous = await self._cache.get(
            f"{_KEY_COMPONENT_PROVIDER_TIMESTAMP_PREFIX}:{component}"
        )
        if not raw_previous:
            return True
        try:
            previous = int(raw_previous.decode("ascii"))
        except (UnicodeDecodeError, ValueError):
            logger.warning("Ignoring invalid ATM provider timestamp marker for %s", component)
            return True
        if timestamp < previous:
            raise GTFSParseError("feed.pb", f"{component} provider feed did not advance")
        return timestamp > previous

    @staticmethod
    def _validate_component_entities(
        feed_message: gtfs_realtime_pb2.FeedMessage,
        component: str,
    ) -> None:
        """Prevent a valid protobuf from replacing the wrong component snapshot."""
        expected_field = {
            "trip_updates": "trip_update",
            "vehicle_positions": "vehicle",
            "alerts": "alert",
        }[component]
        payload_fields = ("trip_update", "vehicle", "alert")
        for entity in feed_message.entity:
            if any(
                entity.HasField(field)
                for field in payload_fields
                if field != expected_field
            ):
                raise GTFSParseError("feed.pb", f"Unexpected entity in {component} feed")

    @staticmethod
    def _validate_message_budget(feed_message: gtfs_realtime_pb2.FeedMessage) -> None:
        """Bound nested repeated fields before any Pydantic object is allocated."""
        total_stop_updates = 0
        total_alert_selectors = 0
        for entity in feed_message.entity:
            if entity.HasField("trip_update"):
                stop_updates = len(entity.trip_update.stop_time_update)
                if stop_updates > _MAX_STOP_UPDATES_PER_TRIP:
                    raise GTFSParseError("feed.pb", "Trip stop-time update limit exceeded")
                total_stop_updates += stop_updates
                if total_stop_updates > _MAX_TOTAL_STOP_UPDATES:
                    raise GTFSParseError("feed.pb", "Feed stop-time update budget exceeded")
            elif entity.HasField("alert"):
                selectors = len(entity.alert.informed_entity)
                if selectors > _MAX_ALERT_SELECTORS:
                    raise GTFSParseError("feed.pb", "Alert selector limit exceeded")
                total_alert_selectors += selectors
                if total_alert_selectors > _MAX_TOTAL_ALERT_SELECTORS:
                    raise GTFSParseError("feed.pb", "Feed alert selector budget exceeded")

    def _model_feed_message(
        self,
        feed_message: gtfs_realtime_pb2.FeedMessage,
        feed: ATMRealtimeFeed,
    ) -> ATMRealtimeFeed:
        """Create normalized models after all whole-message limits pass."""

        invalid_entities = 0
        for entity in feed_message.entity:
            try:
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
            except (ValidationError, ValueError, OverflowError):
                invalid_entities += 1

        if invalid_entities:
            logger.warning("Dropped %d invalid ATM realtime entities", invalid_entities)

        return feed

    def _parse_vehicle(self, v: gtfs_realtime_pb2.VehiclePosition) -> VehiclePosition | None:
        """Extract a VehiclePosition entity."""
        vid = v.vehicle.id if v.HasField("vehicle") else ""
        if not _is_safe_id(vid):
            return None

        route_id = v.trip.route_id if v.HasField("trip") else ""
        trip_id = v.trip.trip_id if v.HasField("trip") else ""
        if (route_id and not _is_safe_id(route_id)) or (trip_id and not _is_safe_id(trip_id)):
            return None
        direction_id = (
            v.trip.direction_id
            if v.HasField("trip")
            and v.trip.HasField("direction_id")
            and v.trip.direction_id in (0, 1)
            else None
        )
        lat = v.position.latitude if v.HasField("position") else 0.0
        lon = v.position.longitude if v.HasField("position") else 0.0
        bearing = v.position.bearing if v.position.HasField("bearing") else None
        speed = v.position.speed if v.position.HasField("speed") else None
        current_stop_sequence = (
            v.current_stop_sequence if v.HasField("current_stop_sequence") else None
        )
        current_stop_id = v.stop_id if v.HasField("stop_id") else ""
        if current_stop_id and not _is_safe_id(current_stop_id):
            current_stop_id = ""
        current_status = None
        if v.HasField("current_status"):
            try:
                current_status = VehicleStopStatus(
                    gtfs_realtime_pb2.VehiclePosition.VehicleStopStatus.Name(v.current_status)
                )
            except (ValueError, KeyError):
                current_status = None
        timestamp = v.timestamp if v.HasField("timestamp") else 0

        # Basic validity check for coordinates (must be realistic for Earth)
        if lat == 0.0 and lon == 0.0:
            return None

        return VehiclePosition(
            vehicle_id=vid,
            route_id=route_id,
            trip_id=trip_id,
            direction_id=direction_id,
            latitude=lat,
            longitude=lon,
            bearing=bearing,
            speed=speed,
            current_stop_sequence=current_stop_sequence,
            stop_id=current_stop_id,
            current_status=current_status,
            timestamp=timestamp,
        )

    def _parse_trip_update(self, tu: gtfs_realtime_pb2.TripUpdate) -> TripUpdate | None:
        """Extract a TripUpdate entity."""
        trip_id = tu.trip.trip_id if tu.HasField("trip") else ""
        if not _is_safe_id(trip_id):
            return None

        route_id = tu.trip.route_id if tu.HasField("trip") else ""
        direction_id = (
            tu.trip.direction_id
            if tu.HasField("trip")
            and tu.trip.HasField("direction_id")
            and tu.trip.direction_id in (0, 1)
            else None
        )
        start_date = tu.trip.start_date if tu.trip.HasField("start_date") else ""
        vid = tu.vehicle.id if tu.HasField("vehicle") else ""
        if any(value and not _is_safe_id(value) for value in (route_id, vid, start_date)):
            return None
        timestamp = tu.timestamp if tu.HasField("timestamp") else 0

        updates = []
        for stu in tu.stop_time_update[:_MAX_STOP_UPDATES_PER_TRIP]:
            stop_id = stu.stop_id
            if not _is_safe_id(stop_id):
                continue

            arr_delay = (
                stu.arrival.delay
                if stu.HasField("arrival") and stu.arrival.HasField("delay")
                else None
            )
            dep_delay = (
                stu.departure.delay
                if stu.HasField("departure") and stu.departure.HasField("delay")
                else None
            )
            arrival_time = (
                stu.arrival.time
                if stu.HasField("arrival") and stu.arrival.HasField("time")
                else None
            )
            departure_time = (
                stu.departure.time
                if stu.HasField("departure") and stu.departure.HasField("time")
                else None
            )

            updates.append(
                StopTimeUpdate(
                    stop_id=stop_id,
                    stop_sequence=stu.stop_sequence,
                    arrival_delay=arr_delay,
                    departure_delay=dep_delay,
                    arrival_time=arrival_time,
                    departure_time=departure_time,
                )
            )

        return TripUpdate(
            trip_id=trip_id,
            route_id=route_id,
            vehicle_id=vid,
            direction_id=direction_id,
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
        if not _is_safe_id(entity_id):
            return None

        header = self._extract_translated_string(al.header_text)[:1_000]
        desc = self._extract_translated_string(al.description_text)[:10_000]
        url = self._extract_translated_string(al.url)[:2_048]

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
                start_iso = _safe_timestamp_iso(period.start)
            if period.HasField("end"):
                end_iso = _safe_timestamp_iso(period.end)

        # Extract affected routes/stops
        routes = []
        stops = []
        affected_entities = []
        for entity_selector in al.informed_entity[:_MAX_ALERT_SELECTORS]:
            route_id = ""
            stop_id = ""
            direction_id = None
            if entity_selector.HasField("route_id") and _is_safe_id(entity_selector.route_id):
                route_id = entity_selector.route_id
                routes.append(route_id)
            if entity_selector.HasField("stop_id") and _is_safe_id(entity_selector.stop_id):
                stop_id = entity_selector.stop_id
                stops.append(stop_id)
            if entity_selector.HasField("direction_id") and entity_selector.direction_id in (0, 1):
                direction_id = entity_selector.direction_id
            if route_id or stop_id or direction_id is not None:
                affected_entities.append(
                    AffectedEntity(
                        route_id=route_id,
                        stop_id=stop_id,
                        direction_id=direction_id,
                    )
                )

        # --- Auto-classification ---
        alert_type = self._classify_alert_type(effect_str, header, desc)
        severity = self._classify_severity(effect_str, alert_type)
        alternative_stops = self._extract_alternative_stops(desc)
        affected_details = self._build_affected_stop_details(stops, alert_type, header)
        detour_desc = (
            self._extract_detour_description(desc) if alert_type == AlertType.DETOUR else ""
        )

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
            affected_entities=affected_entities,
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

        translations = {
            t.language.lower()[:16]: t.text[:10_000] for t in ts.translation[:_MAX_TRANSLATIONS]
        }

        for lang in _LANG_PRIORITY:
            if lang in translations:
                return translations[lang]

            # ATM sometimes uses 'cat' instead of 'ca'
            if lang == "ca" and "cat" in translations:
                return translations["cat"]

        # If none of our priorities match, return the first one available
        return ts.translation[0].text[:10_000]

    # ------------------------------------------------------------------
    # Caching / Retrieval
    # ------------------------------------------------------------------

    async def _cache_feed(
        self,
        feed: ATMRealtimeFeed,
        components: set[str],
        *,
        provider_timestamps: dict[str, int] | None = None,
    ) -> None:
        """Refresh only successful components so failures retain last-good data."""
        ttl = self._settings.CACHE_TTL_ATM_REALTIME
        provider_timestamps = provider_timestamps or {}

        pipeline_data: dict[str, object] = {}
        if "vehicle_positions" in components:
            pipeline_data[_KEY_VEHICLES] = [
                item.model_dump(mode="json") for item in feed.vehicle_positions
            ]
        if "trip_updates" in components:
            pipeline_data[_KEY_TRIPS] = [item.model_dump(mode="json") for item in feed.trip_updates]
        if "alerts" in components:
            pipeline_data[_KEY_ALERTS] = [
                item.model_dump(mode="json") for item in feed.service_alerts
            ]
        if pipeline_data:
            await self._cache.mset_json(pipeline_data, ttl=ttl)
        if "vehicle_positions" in components:
            await self._replace_route_index(
                items=feed.vehicle_positions,
                prefix=_KEY_VEHICLES_ROUTE_PREFIX,
                route_list_key=_KEY_VEHICLE_ROUTES,
                ttl=ttl,
            )
        if "trip_updates" in components:
            await self._replace_route_index(
                items=feed.trip_updates,
                prefix=_KEY_TRIPS_ROUTE_PREFIX,
                route_list_key=_KEY_TRIP_ROUTES,
                ttl=ttl,
            )
        updated_at = feed.feed_timestamp.isoformat()
        await self._cache.set(
            _KEY_LAST_UPDATED,
            updated_at,
            ttl=ttl,
        )
        for component in components:
            await self._cache.set(
                f"{_KEY_COMPONENT_UPDATED_PREFIX}:{component}",
                updated_at,
                ttl=ttl,
            )
            if provider_timestamp := provider_timestamps.get(component):
                await self._cache.set(
                    f"{_KEY_COMPONENT_PROVIDER_TIMESTAMP_PREFIX}:{component}",
                    str(provider_timestamp),
                    ttl=ttl,
                )

    async def _replace_route_index(
        self,
        *,
        items: list[VehiclePosition] | list[TripUpdate],
        prefix: str,
        route_list_key: str,
        ttl: int,
    ) -> None:
        """Replace one bounded per-route index while stale generations expire."""
        grouped: dict[str, list[dict]] = {}
        for item in items:
            if not item.route_id:
                continue
            grouped.setdefault(item.route_id, []).append(item.model_dump(mode="json"))

        previous = await self._cache.get_json(route_list_key)
        previous_routes = self._route_ids_from_v2_marker(previous)
        if previous_routes is None:
            previous_routes = {
                route_id
                for route_id in (previous if isinstance(previous, list) else [])
                if isinstance(route_id, str) and route_id
            }
        current_routes = set(grouped)
        mapping: dict[str, object] = {
            self._route_cache_key(prefix, route_id): values for route_id, values in grouped.items()
        }
        mapping[route_list_key] = {
            "version": _ROUTE_INDEX_VERSION,
            "route_ids": sorted(current_routes),
        }
        await self._cache.mset_json(mapping, ttl=ttl)

        stale_keys = [
            self._route_cache_key(prefix, route_id) for route_id in previous_routes - current_routes
        ]
        for start in range(0, len(stale_keys), 100):
            await asyncio.gather(
                *(self._cache.delete(key) for key in stale_keys[start : start + 100])
            )

    @staticmethod
    def _route_cache_key(prefix: str, route_id: str) -> str:
        digest = hashlib.sha256(route_id.encode("utf-8")).hexdigest()[:24]
        return f"{prefix}:{digest}"

    @staticmethod
    def _route_ids_from_v2_marker(marker: object) -> set[str] | None:
        """Return indexed routes, or ``None`` for a pre-v2 migration marker."""
        if not isinstance(marker, dict) or marker.get("version") != _ROUTE_INDEX_VERSION:
            return None
        route_ids = marker.get("route_ids")
        if not isinstance(route_ids, list):
            return set()
        return {
            route_id for route_id in route_ids if isinstance(route_id, str) and route_id
        }

    def _freshness_window_seconds(self) -> int:
        return max(30, min(self._settings.ATM_RT_FRESHNESS_SECONDS, 600))

    @property
    def freshness_window_seconds(self) -> int:
        """Maximum accepted provider/entity age for realtime matching."""
        return self._freshness_window_seconds()

    async def _component_is_fresh(self, component: str) -> bool:
        raw = await self._cache.get(f"{_KEY_COMPONENT_PROVIDER_TIMESTAMP_PREFIX}:{component}")
        if not raw:
            return False
        try:
            provider_timestamp = int(raw.decode("ascii"))
        except (UnicodeDecodeError, ValueError):
            return False
        now_timestamp = int(datetime.now(tz=UTC).timestamp())
        return (
            now_timestamp - self._freshness_window_seconds()
            <= provider_timestamp
            <= now_timestamp
        )

    async def get_component_freshness(self) -> dict[str, bool]:
        """Report provider-time freshness without trusting local receipt time."""
        components = ("trip_updates", "vehicle_positions", "alerts")
        states = await asyncio.gather(
            *(self._component_is_fresh(component) for component in components)
        )
        return dict(zip(components, states, strict=True))

    async def get_cached_feed(self) -> ATMRealtimeFeed | None:
        """Assemble a snapshot from independently expiring component caches."""
        vehicles, trips, alerts = await asyncio.gather(
            self.get_cached_vehicles(),
            self.get_cached_trips(),
            self.get_cached_alerts(),
        )
        if not vehicles and not trips and not alerts:
            # Rolling fallback for cache data written by older releases.
            data = await self._cache.get_json(_KEY_FEED_FULL)
            if data:
                return ATMRealtimeFeed(**data)
            return None
        return ATMRealtimeFeed(
            vehicle_positions=vehicles,
            trip_updates=trips,
            service_alerts=alerts,
            entity_count=len(vehicles) + len(trips) + len(alerts),
        )

    async def get_cached_vehicles(self) -> list[VehiclePosition]:
        data = await self._cache.get_json(_KEY_VEHICLES)
        if not data:
            return []
        return [VehiclePosition(**v) for v in data]

    async def get_cached_vehicles_for_route(self, route_id: str) -> list[VehiclePosition]:
        if not await self._component_is_fresh("vehicle_positions"):
            return []
        data = await self._cache.get_json(
            self._route_cache_key(_KEY_VEHICLES_ROUTE_PREFIX, route_id)
        )
        if data is None:
            marker = await self._cache.get_json(_KEY_VEHICLE_ROUTES)
            if self._route_ids_from_v2_marker(marker) is not None:
                return []
            # Migration fallback for cache snapshots written before route-index v2.
            return [item for item in await self.get_cached_vehicles() if item.route_id == route_id]
        return [VehiclePosition(**item) for item in data[:2_000]]

    async def get_cached_trips(self) -> list[TripUpdate]:
        data = await self._cache.get_json(_KEY_TRIPS)
        if not data:
            return []
        return [TripUpdate(**t) for t in data]

    async def get_cached_trips_for_route(self, route_id: str) -> list[TripUpdate]:
        if not await self._component_is_fresh("trip_updates"):
            return []
        data = await self._cache.get_json(self._route_cache_key(_KEY_TRIPS_ROUTE_PREFIX, route_id))
        if data is None:
            marker = await self._cache.get_json(_KEY_TRIP_ROUTES)
            if self._route_ids_from_v2_marker(marker) is not None:
                return []
            # Migration fallback for cache snapshots written before route-index v2.
            return [item for item in await self.get_cached_trips() if item.route_id == route_id]
        return [TripUpdate(**item) for item in data[:2_000]]

    async def get_cached_alerts(self) -> list[ServiceAlert]:
        data = await self._cache.get_json(_KEY_ALERTS)
        if not data:
            return []
        return [ServiceAlert(**a) for a in data]

    async def get_cached_alerts_for_route(
        self,
        route_id: str,
        direction_id: int | None = None,
    ) -> list[ServiceAlert]:
        """Return fresh alerts applicable to one route and optional direction.

        Historic cache entries did not preserve the individual GTFS-RT
        selectors, so they use the route list as a backwards-compatible
        fallback.  New entries retain selectors and therefore honour a
        direction-specific alert without leaking it to the other direction.
        """
        if not await self._component_is_fresh("alerts"):
            return []

        applicable: list[ServiceAlert] = []
        for alert in await self.get_cached_alerts():
            if alert.affected_entities:
                if any(
                    entity.route_id == route_id
                    and (
                        direction_id is None
                        or entity.direction_id is None
                        or entity.direction_id == direction_id
                    )
                    for entity in alert.affected_entities
                ):
                    applicable.append(alert)
                continue

            if route_id in alert.affected_route_ids:
                applicable.append(alert)
        severity_rank = {AlertSeverity.SEVERE: 0, AlertSeverity.WARNING: 1, AlertSeverity.INFO: 2}
        return sorted(
            applicable,
            key=lambda alert: (severity_rank.get(alert.severity, 3), alert.alert_id),
        )[:_MAX_ROUTE_ALERTS]
