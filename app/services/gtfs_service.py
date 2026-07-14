"""
ATM T-mobilitat static GTFS service.

Downloads the static GTFS ZIP from the T-mobilitat Open Data portal and
extracts route shapes, route metadata, trips, and stop sequences.

The processed data is cached in Redis with both route-level and trip-level
indexes so clients can render exact trip variants on the map.
"""

from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import math
import stat
import uuid
import zipfile
from collections import defaultdict
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import PurePosixPath
from urllib.parse import urljoin, urlsplit

import httpx
import orjson

from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.core.exceptions import ExternalAPIError, GTFSParseError
from app.core.logging import get_logger
from app.models.gtfs import DirectionInfo, GTFSShapesResponse, NearbyRoute, RouteInfo, RouteShape

logger = get_logger(__name__)

# Redis key namespaces
_KEY_ALL_SHAPES = "gtfs:shapes:all"
_KEY_SHAPE_PREFIX = "gtfs:shapes:route"
_KEY_ROUTES = "gtfs:routes:all"
_KEY_STOPS_PREFIX = "gtfs:stops:route"
_KEY_LAST_UPDATED = "gtfs:meta:last_updated"
_KEY_CALENDAR = "gtfs:calendar"
_KEY_CALENDAR_DATES = "gtfs:calendar_dates"
_KEY_SCHEDULE_INDEX_ACTIVE = "gtfs:schedule:index:v2:active"
_KEY_SCHEDULE_INDEX_PREFIX = "gtfs:schedule:index:v2"
_KEY_TRIPS_PREFIX = "gtfs:trips:route"
_KEY_TRIP_META_PREFIX = "gtfs:trip:meta"
_KEY_TRIP_STOPS_PREFIX = "gtfs:trip:stops"
_KEY_TRIP_SHAPE_PREFIX = "gtfs:trip:shape"
_KEY_TRIP_INDEX_ACTIVE = "gtfs:trip:index:v2:active"
_KEY_TRIP_INDEX_PREFIX = "gtfs:trip:index:v2"
_KEY_SNAPSHOT_ACTIVE = "gtfs:snapshot:v2:active"
_KEY_PROXIMITY_INDEX = "gtfs:proximity:routes:v1"

_PROXIMITY_INDEX_VERSION = 1
_PROXIMITY_STOP_KEY_BATCH_SIZE = 500
_TRIP_INDEX_VERSION = 2
_SCHEDULE_INDEX_VERSION = 2
_SNAPSHOT_VERSION = 2
_TRIP_INDEX_WRITE_BATCH_SIZE = 500
_TRIP_INDEX_WRITE_BATCH_BYTES = 4 * 1024 * 1024
_TRIP_INDEX_CLEANUP_BATCH_SIZE = 250
_INDEX_ROLLOVER_GRACE_SECONDS = 259_200
_MAX_NEARBY_ROUTES = 40
_EARTH_RADIUS_METERS = 6_371_000.0

_ALLOWED_GTFS_DOWNLOAD_HOSTS = frozenset({"t-mobilitat.atm.cat", "t-mobilitat.cat"})
_MAX_GTFS_REDIRECTS = 3
_MAX_GTFS_ZIP_BYTES = 96 * 1024 * 1024
_MAX_GTFS_ZIP_ENTRIES = 128
_MAX_GTFS_ENTRY_NAME_LENGTH = 255
_MAX_GTFS_ENTRY_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
_MAX_GTFS_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
_MAX_GTFS_COMPRESSION_RATIO = 250
_GTFS_DOWNLOAD_CHUNK_BYTES = 64 * 1024
_ALLOWED_GTFS_COMPRESSION_TYPES = frozenset({zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED})
_REQUIRED_GTFS_FILES = ("shapes.txt", "routes.txt", "trips.txt", "stops.txt", "stop_times.txt")
_MAX_CSV_FIELD_BYTES = 16 * 1024
_MAX_ROUTE_ROWS = 20_000
_MAX_TRIP_ROWS = 500_000
_MAX_SHAPE_POINT_ROWS = 5_000_000
_MAX_STOP_ROWS = 500_000
_MAX_STOP_TIME_ROWS = 8_000_000
_MAX_CALENDAR_ROWS = 200_000
_MAX_CALENDAR_DATE_ROWS = 3_000_000

csv.field_size_limit(_MAX_CSV_FIELD_BYTES)

ProximityIndex = dict[str, list[list[float]]]
StopTimeRow = tuple[str, int, str]


class GTFSService:
    """Loader and cache writer for ATM T-mobilitat static GTFS data."""

    def __init__(self, settings: Settings, cache: CacheManager) -> None:
        self._settings = settings
        self._cache = cache
        self._gtfs_url = settings.ATM_GTFS_URL
        self._http: httpx.AsyncClient | None = None
        self._proximity_index_lock = asyncio.Lock()

    async def start(self) -> None:
        """Initialize the HTTP client for GTFS downloads."""
        self._validate_gtfs_download_url(self._gtfs_url)
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=15.0, read=120.0, write=5.0, pool=10.0),
            limits=httpx.Limits(max_connections=3, max_keepalive_connections=1),
            headers={"User-Agent": "AlVolant-BFF/0.3"},
            follow_redirects=False,
            trust_env=False,
        )
        logger.info("GTFS HTTP client initialized")

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._http:
            await self._http.aclose()
            logger.info("GTFS HTTP client closed")

    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            raise RuntimeError("GTFSService.start() has not been called")
        return self._http

    async def load_and_cache_shapes(self) -> int:
        """Download GTFS ZIP, parse static entities, and cache route/trip indexes."""
        logger.info("Starting GTFS load")

        zip_bytes = await self._download_gtfs_zip()
        (
            route_shapes,
            deduped_routes,
            route_to_trip,
            representative_stops,
            proximity_index,
            trip_meta_by_id,
            stop_patterns_by_id,
            shape_geometries_by_id,
            calendar,
            calendar_dates,
            trips_by_route_dir,
        ) = await asyncio.to_thread(self._prepare_gtfs_snapshot, zip_bytes)
        zip_bytes = b""

        # Invalidate readiness before mutating the fixed representative keys.
        # If any later publication step fails, the old process stays alive but
        # load balancers stop routing traffic until a complete retry succeeds.
        snapshot_id = uuid.uuid4().hex
        await self._cache.unlink(_KEY_SNAPSHOT_ACTIVE)

        await self._cache_shapes(route_shapes, deduped_routes)
        await self._cache_stops(route_to_trip, representative_stops)
        await self._cache_route_proximity_index(proximity_index)
        trip_manifest = await self._cache_trip_indexes(
            trip_meta_by_id,
            stop_patterns_by_id,
            shape_geometries_by_id,
            snapshot_id=snapshot_id,
        )
        # Publish schedules only after the corresponding trip index is active.
        # Readers retain the previous complete trip generation during the
        # cross-manifest switch window and after an interrupted refresh.
        schedule_manifest = await self._cache_calendar_and_trips(
            calendar,
            calendar_dates,
            trips_by_route_dir,
            trip_generation=trip_manifest["generation"],
            snapshot_id=snapshot_id,
        )
        ttl = self._settings.CACHE_TTL_GTFS_SHAPES
        await self._cache.set_json(
            _KEY_SNAPSHOT_ACTIVE,
            {
                "version": _SNAPSHOT_VERSION,
                "snapshot_id": snapshot_id,
                "trip_generation": trip_manifest["generation"],
                "schedule_generation": schedule_manifest["generation"],
                "last_updated": datetime.now(tz=UTC).isoformat(),
            },
            ttl=ttl,
        )
        # Legacy trip details are the only coherent fallback during the first
        # v1→v2 migration. Reclaim them only after the full snapshot commits.
        await self._cleanup_legacy_trip_indexes()
        # The unauthenticated bulk endpoint was removed; retain only bounded
        # representative route keys and reclaim any legacy 24 MB aggregate.
        await self._cache.unlink(_KEY_ALL_SHAPES)

        logger.info(
            "GTFS load complete: %d route-direction shapes, %d trips, "
            "%d stop patterns, %d geometries",
            len(route_shapes),
            len(trip_meta_by_id),
            len(stop_patterns_by_id),
            len(shape_geometries_by_id),
        )
        return len(route_shapes)

    def _prepare_gtfs_snapshot(self, zip_bytes: bytes) -> tuple:
        """Parse and assemble a snapshot off the asyncio event-loop thread."""
        (
            shapes_data,
            routes_data,
            trips_data,
            stops_data,
            stop_times_data,
            calendar_data,
            calendar_dates_data,
        ) = self._extract_gtfs_files(zip_bytes)

        routes_by_id = self._parse_routes(routes_data)
        routes_data = ""
        bus_route_ids = {
            route_id
            for route_id, route in routes_by_id.items()
            if int(route.get("route_type", 3)) == 3
        }
        trip_rows = self._parse_trip_rows(trips_data, bus_route_ids)
        trips_data = ""
        bus_trip_ids = {trip["trip_id"] for trip in trip_rows}
        used_shape_ids = {trip["shape_id"] for trip in trip_rows if trip.get("shape_id")}
        used_service_ids = {
            trip["service_id"] for trip in trip_rows if trip.get("service_id")
        }
        stop_times_by_trip = self._parse_stop_times(stop_times_data, bus_trip_ids)
        stop_times_data = ""
        trip_start_times = self._parse_first_stop_departures(stop_times_by_trip)
        used_stop_ids = {stop[0] for stops in stop_times_by_trip.values() for stop in stops}
        stops_by_id = self._parse_stops(stops_data, used_stop_ids)
        stops_data = ""
        shapes_by_id = self._parse_shapes(shapes_data, used_shape_ids)
        shapes_data = ""

        route_to_shape, route_to_trip = self._build_representative_mappings(trip_rows)
        trip_meta_by_id, stop_patterns_by_id, shape_geometries_by_id = self._build_trip_indexes(
            trip_rows=trip_rows,
            routes_by_id=routes_by_id,
            shapes_by_id=shapes_by_id,
            stops_by_id=stops_by_id,
            stop_times_by_trip=stop_times_by_trip,
            trip_start_times=trip_start_times,
        )
        route_shapes = self._build_route_shapes(
            route_to_shape=route_to_shape,
            shapes_by_id=shapes_by_id,
            routes_by_id=routes_by_id,
            route_to_trip=route_to_trip,
            trip_meta_by_id=trip_meta_by_id,
        )
        deduped_routes = self._build_deduplicated_routes(routes_by_id, trip_meta_by_id)
        trips_by_route_dir = self._build_trips_by_route_direction(
            trip_rows,
            trip_start_times,
            trip_meta_by_id,
        )
        calendar = self._parse_calendar(calendar_data, used_service_ids)
        calendar_dates = self._parse_calendar_dates(calendar_dates_data, used_service_ids)
        representative_stops = self._build_representative_stop_collections(
            route_to_trip=route_to_trip,
            trip_meta_by_id=trip_meta_by_id,
            stop_patterns_by_id=stop_patterns_by_id,
        )
        proximity_index = self._build_route_proximity_index(
            route_infos=deduped_routes,
            route_to_trip=route_to_trip,
            trip_stops_by_id=representative_stops,
        )
        return (
            route_shapes,
            deduped_routes,
            route_to_trip,
            representative_stops,
            proximity_index,
            trip_meta_by_id,
            stop_patterns_by_id,
            shape_geometries_by_id,
            calendar,
            calendar_dates,
            trips_by_route_dir,
        )

    async def get_all_shapes(self) -> GTFSShapesResponse | None:
        data = await self._cache.get_json(_KEY_ALL_SHAPES)
        if data is None:
            return None
        return GTFSShapesResponse(**data)

    async def get_route_shape(
        self,
        route_id: str,
        direction_id: int | None = None,
        trip_id: str | None = None,
    ) -> RouteShape | None:
        if trip_id:
            trip_meta, manifest = await self._get_trip_meta_record(trip_id)
            if not trip_meta or not await self._trip_matches_route(
                route_id,
                trip_id,
                trip_meta=trip_meta,
            ):
                return None

            if manifest is not None:
                geometry = await self._cache.hget_json(
                    self._trip_index_key(manifest["generation"], "shapes"),
                    trip_meta.get("shape_id", ""),
                )
                reconstructed = self._build_trip_route_shape(trip_meta, geometry)
                if reconstructed is not None:
                    return reconstructed

            trip_shape = await self._cache.get_json(f"{_KEY_TRIP_SHAPE_PREFIX}:{trip_id}")
            if trip_shape is not None:
                return RouteShape(**trip_shape)

        for candidate_route_id in await self._resolve_group_route_ids(route_id):
            data = None
            if direction_id is not None:
                data = await self._cache.get_json(
                    f"{_KEY_SHAPE_PREFIX}:{candidate_route_id}:{direction_id}"
                )
            if data is None:
                data = await self._cache.get_json(f"{_KEY_SHAPE_PREFIX}:{candidate_route_id}")
            if data is not None:
                return RouteShape(**data)

        return None

    async def get_route_stops(
        self,
        route_id: str,
        direction_id: int | None = None,
        trip_id: str | None = None,
    ) -> dict | None:
        if trip_id:
            trip_meta, manifest = await self._get_trip_meta_record(trip_id)
            if not trip_meta or not await self._trip_matches_route(
                route_id,
                trip_id,
                trip_meta=trip_meta,
            ):
                return None

            if manifest is not None:
                stop_pattern = await self._cache.hget_json(
                    self._trip_index_key(manifest["generation"], "stops"),
                    trip_meta.get("stop_pattern_id", ""),
                )
                reconstructed = self._build_trip_stop_collection(
                    trip_meta,
                    stop_pattern,
                    manifest.get("last_updated", ""),
                )
                if reconstructed is not None:
                    return reconstructed

            trip_stops = await self._cache.get_json(f"{_KEY_TRIP_STOPS_PREFIX}:{trip_id}")
            if trip_stops is not None:
                return trip_stops

        for candidate_route_id in await self._resolve_group_route_ids(route_id):
            data = None
            if direction_id is not None:
                data = await self._cache.get_json(
                    f"{_KEY_STOPS_PREFIX}:{candidate_route_id}:{direction_id}"
                )
            if data is None:
                data = await self._cache.get_json(f"{_KEY_STOPS_PREFIX}:{candidate_route_id}")
            if data is not None:
                return data

        return None

    async def get_all_routes(self) -> list[RouteInfo]:
        data = await self._cache.get_json(_KEY_ROUTES)
        if data is None:
            return []
        return [RouteInfo(**route) for route in data]

    async def has_cached_routes(self) -> bool:
        """Return GTFS readiness in O(1), without decoding the route catalog."""
        return await self._cache.exists(_KEY_ROUTES)

    async def has_complete_cache(self) -> bool:
        """Require a coherent, fully published v2 snapshot before readiness."""
        routes_present, trip_manifest, schedule_manifest, snapshot = await asyncio.gather(
            self._cache.exists(_KEY_ROUTES),
            self._get_active_trip_index(),
            self._get_active_schedule_index(),
            self._get_active_snapshot(),
        )
        if not routes_present or not trip_manifest or not schedule_manifest or not snapshot:
            return False
        references_match = bool(
            snapshot.get("snapshot_id") == trip_manifest.get("snapshot_id")
            and snapshot.get("snapshot_id") == schedule_manifest.get("snapshot_id")
            and snapshot.get("trip_generation") == trip_manifest.get("generation")
            and snapshot.get("schedule_generation") == schedule_manifest.get("generation")
            and schedule_manifest.get("trip_generation") == trip_manifest.get("generation")
        )
        if not references_match:
            return False

        trip_generation = trip_manifest["generation"]
        trip_components = await asyncio.gather(
            *(
                self._cache.exists(self._trip_index_key(trip_generation, component))
                for component in ("meta", "stops", "shapes")
            )
        )
        if not all(trip_components):
            return False

        counts = schedule_manifest.get("component_counts")
        if not isinstance(counts, dict):
            return False
        schedule_generation = schedule_manifest["generation"]
        for component in ("calendar", "exceptions", "trips"):
            expected_count = counts.get(component)
            if not isinstance(expected_count, int) or expected_count < 0:
                return False
            if expected_count and not await self._cache.exists(
                self._schedule_index_key(schedule_generation, component)
            ):
                return False
        return True

    async def seconds_until_refresh(self) -> int:
        """Schedule refresh before any active v2 manifest can expire."""
        ttls = await asyncio.gather(
            self._cache.ttl(_KEY_ROUTES),
            self._cache.ttl(_KEY_TRIP_INDEX_ACTIVE),
            self._cache.ttl(_KEY_SCHEDULE_INDEX_ACTIVE),
            self._cache.ttl(_KEY_SNAPSHOT_ACTIVE),
        )
        positive_ttls = [ttl for ttl in ttls if ttl > 0]
        if len(positive_ttls) != 4:
            return 0
        configured = max(900, self._settings.ATM_GTFS_REFRESH_HOURS * 3_600)
        return max(60, min(configured, min(positive_ttls) // 2))

    async def get_nearby_routes(
        self,
        latitude: float,
        longitude: float,
        limit: int = 20,
    ) -> list[NearbyRoute]:
        """Return canonical routes ordered by distance to their closest cached stop.

        User coordinates are used only for this in-memory calculation. They are
        deliberately not logged, persisted, or included in a Redis cache key.
        """
        if (
            isinstance(latitude, bool)
            or not isinstance(latitude, (int, float))
            or not math.isfinite(latitude)
            or latitude < -90
            or latitude > 90
        ):
            raise ValueError("latitude must be a finite WGS-84 coordinate")
        if (
            isinstance(longitude, bool)
            or not isinstance(longitude, (int, float))
            or not math.isfinite(longitude)
            or longitude < -180
            or longitude > 180
        ):
            raise ValueError("longitude must be a finite WGS-84 coordinate")
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= _MAX_NEARBY_ROUTES
        ):
            raise ValueError(f"limit must be between 1 and {_MAX_NEARBY_ROUTES}")

        proximity_index = await self._get_or_build_route_proximity_index()
        distances: list[tuple[float, str]] = []

        for route_id, stop_coordinates in proximity_index.items():
            closest_distance = math.inf
            for stop_longitude, stop_latitude in stop_coordinates:
                distance = self._haversine_distance_meters(
                    latitude,
                    longitude,
                    stop_latitude,
                    stop_longitude,
                )
                if distance < closest_distance:
                    closest_distance = distance

            if math.isfinite(closest_distance):
                distances.append((closest_distance, route_id))

        distances.sort(key=lambda item: (item[0], item[1]))
        return [
            NearbyRoute(route_id=route_id, distance_meters=round(distance, 1))
            for distance, route_id in distances[:limit]
        ]

    async def get_trip_meta(self, trip_id: str) -> dict | None:
        trip_meta, _manifest = await self._get_trip_meta_record(trip_id)
        return trip_meta

    async def resolve_group_route_ids(self, route_id: str) -> list[str]:
        """Return every underlying GTFS route id represented by a catalog route."""
        return await self._resolve_group_route_ids(route_id)

    async def _get_trip_meta_record(self, trip_id: str) -> tuple[dict | None, dict | None]:
        """Read v2 metadata first and retain per-trip legacy compatibility."""
        manifest = await self._get_active_trip_index()
        if manifest is not None:
            generations = [manifest["generation"]]
            previous_generation = manifest.get("previous_generation")
            if (
                isinstance(previous_generation, str)
                and len(previous_generation) == 32
                and all(character in "0123456789abcdef" for character in previous_generation)
            ):
                generations.append(previous_generation)
            for generation in generations:
                trip_meta = await self._cache.hget_json(
                    self._trip_index_key(generation, "meta"),
                    trip_id,
                )
                if isinstance(trip_meta, dict):
                    return trip_meta, {**manifest, "generation": generation}

        legacy_meta = await self._cache.get_json(f"{_KEY_TRIP_META_PREFIX}:{trip_id}")
        return (legacy_meta, None) if isinstance(legacy_meta, dict) else (None, None)

    async def _get_active_trip_index(self) -> dict | None:
        manifest = await self._cache.get_json(_KEY_TRIP_INDEX_ACTIVE)
        return self._validate_index_manifest(manifest, _TRIP_INDEX_VERSION)

    async def _get_active_schedule_index(self) -> dict | None:
        manifest = await self._cache.get_json(_KEY_SCHEDULE_INDEX_ACTIVE)
        return self._validate_index_manifest(manifest, _SCHEDULE_INDEX_VERSION)

    async def _get_active_snapshot(self) -> dict | None:
        manifest = await self._cache.get_json(_KEY_SNAPSHOT_ACTIVE)
        if not isinstance(manifest, dict) or manifest.get("version") != _SNAPSHOT_VERSION:
            return None
        snapshot_id = manifest.get("snapshot_id")
        trip_generation = manifest.get("trip_generation")
        schedule_generation = manifest.get("schedule_generation")
        if not all(
            isinstance(value, str)
            and len(value) == 32
            and all(character in "0123456789abcdef" for character in value)
            for value in (snapshot_id, trip_generation, schedule_generation)
        ):
            return None
        return manifest

    @staticmethod
    def _validate_index_manifest(manifest: object, version: int) -> dict | None:
        if not isinstance(manifest, dict) or manifest.get("version") != version:
            return None

        generation = manifest.get("generation")
        if (
            not isinstance(generation, str)
            or len(generation) != 32
            or any(character not in "0123456789abcdef" for character in generation)
        ):
            return None
        return manifest

    @staticmethod
    def _trip_index_key(generation: str, component: str) -> str:
        return f"{_KEY_TRIP_INDEX_PREFIX}:{generation}:{component}"

    @staticmethod
    def _schedule_index_key(generation: str, component: str) -> str:
        return f"{_KEY_SCHEDULE_INDEX_PREFIX}:{generation}:{component}"

    @staticmethod
    def _build_trip_route_shape(trip_meta: dict, geometry: object) -> RouteShape | None:
        if (
            not isinstance(geometry, dict)
            or geometry.get("type") != "LineString"
            or not isinstance(geometry.get("coordinates"), list)
        ):
            return None

        route_id = trip_meta.get("route_id")
        trip_id = trip_meta.get("trip_id")
        shape_id = trip_meta.get("shape_id")
        if not all(isinstance(value, str) and value for value in (route_id, trip_id, shape_id)):
            return None

        destination_name = trip_meta.get("destination_name", "")
        towards_label = trip_meta.get("towards_label", "")
        properties = {
            "route_id": route_id,
            "direction_id": trip_meta.get("direction_id", 0),
            "shape_id": shape_id,
            "trip_id": trip_id,
            "route_short_name": trip_meta.get("route_short_name", ""),
            "route_long_name": trip_meta.get("route_long_name", ""),
            "route_color": trip_meta.get("route_color", ""),
            "route_text_color": trip_meta.get("route_text_color", ""),
            "route_type": int(trip_meta.get("route_type", 3)),
            "destination_name": destination_name,
            "towards_label": towards_label,
        }
        return RouteShape(
            route_id=route_id,
            shape_id=shape_id,
            route_short_name=properties["route_short_name"],
            route_long_name=properties["route_long_name"],
            route_color=properties["route_color"],
            route_text_color=properties["route_text_color"],
            route_type=properties["route_type"],
            direction_id=properties["direction_id"],
            trip_id=trip_id,
            destination_name=destination_name,
            towards_label=towards_label,
            geojson={
                "type": "Feature",
                "properties": properties,
                "geometry": geometry,
            },
        )

    @staticmethod
    def _build_trip_stop_collection(
        trip_meta: dict,
        stop_pattern: object,
        last_updated: str,
    ) -> dict | None:
        if not isinstance(stop_pattern, dict) or not isinstance(stop_pattern.get("stops"), list):
            return None

        route_id = trip_meta.get("route_id")
        trip_id = trip_meta.get("trip_id")
        if not all(isinstance(value, str) and value for value in (route_id, trip_id)):
            return None

        direction_id = trip_meta.get("direction_id", 0)
        features: list[dict] = []
        for stop in stop_pattern["stops"]:
            if not isinstance(stop, dict):
                return None
            coordinates = stop.get("coordinates")
            stop_id = stop.get("stop_id")
            if not isinstance(coordinates, list) or not isinstance(stop_id, str):
                return None
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "route_id": route_id,
                        "direction_id": direction_id,
                        "trip_id": trip_id,
                        "stop_id": stop_id,
                        "stop_sequence": stop.get("sequence", 0),
                        "stop_name": stop.get("stop_name", ""),
                    },
                    "geometry": {"type": "Point", "coordinates": coordinates},
                }
            )

        return {
            "type": "FeatureCollection",
            "features": features,
            "route_id": route_id,
            "direction_id": direction_id,
            "trip_id": trip_id,
            "stop_count": len(features),
            "last_updated": last_updated,
        }

    async def get_upcoming_trips(
        self,
        route_id: str,
        direction_id: int,
        date_str: str,
        time_str: str,
        limit: int = 4,
    ) -> list[dict]:
        """Fetch upcoming trips for route/direction with calendar-aware service-day logic."""
        from datetime import timedelta

        try:
            import zoneinfo

            local_tz = zoneinfo.ZoneInfo("Europe/Madrid")
        except Exception:
            local_tz = None

        route_ids = await self._resolve_group_route_ids(route_id)
        schedule_manifest = await self._get_active_schedule_index()
        schedule_generation = await self._select_schedule_generation(schedule_manifest)
        if schedule_manifest is not None and schedule_generation is None:
            return []
        grouped_trips = await self._load_route_schedule_trips(
            route_ids,
            direction_id,
            generation=schedule_generation,
        )

        if not grouped_trips:
            return []

        try:
            query_dt = datetime.strptime(f"{date_str} {time_str}", "%Y%m%d %H:%M:%S")
            if local_tz:
                query_dt = query_dt.replace(tzinfo=local_tz)
        except Exception:
            query_dt = datetime.now(tz=local_tz) if local_tz else datetime.now()

        service_days = [query_dt - timedelta(days=1), query_dt, query_dt + timedelta(days=1)]
        service_date_strings = [service_day.strftime("%Y%m%d") for service_day in service_days]
        service_ids = sorted(
            {
                service_id
                for trip in grouped_trips
                if isinstance((service_id := trip.get("service_id")), str) and service_id
            }
        )
        calendar_by_service, exceptions_by_date = await self._load_schedule_window(
            service_ids,
            service_date_strings,
            generation=schedule_generation,
        )
        candidates: list[dict] = []

        for service_day in service_days:
            service_date_str = service_day.strftime("%Y%m%d")
            service_weekday = service_day.strftime("%A").lower()
            service_midnight = datetime(service_day.year, service_day.month, service_day.day)
            if local_tz:
                service_midnight = service_midnight.replace(tzinfo=local_tz)

            for trip in grouped_trips:
                service_id = trip.get("service_id", "")
                if not service_id:
                    continue

                date_exceptions = exceptions_by_date.get(service_date_str, {})
                is_active = False
                if service_id in date_exceptions.get("added", set()):
                    is_active = True
                elif service_id in date_exceptions.get("removed", set()):
                    is_active = False
                else:
                    cal = calendar_by_service.get(service_id)
                    if cal:
                        in_range = cal["start_date"] <= service_date_str <= cal["end_date"]
                        runs_on_weekday = cal.get(service_weekday, 0) == 1
                        is_active = in_range and runs_on_weekday

                if not is_active:
                    continue

                dep_time_str = trip.get("departure_time")
                if not dep_time_str:
                    continue

                try:
                    parts = dep_time_str.split(":")
                    hours = int(parts[0])
                    minutes = int(parts[1])
                    seconds = int(parts[2]) if len(parts) > 2 else 0
                except Exception:
                    continue

                trip_dep_dt = service_midnight + timedelta(
                    hours=hours,
                    minutes=minutes,
                    seconds=seconds,
                )
                if trip_dep_dt >= query_dt:
                    trip_copy = dict(trip)
                    trip_copy["_abs_dep"] = trip_dep_dt
                    trip_copy["scheduled_epoch"] = int(trip_dep_dt.timestamp())
                    candidates.append(trip_copy)

        candidates.sort(key=lambda item: item["_abs_dep"])

        seen_trip_ids: set[str] = set()
        final_trips: list[dict] = []
        for candidate in candidates:
            trip_id = candidate.get("trip_id")
            if not trip_id or trip_id in seen_trip_ids:
                continue

            seen_trip_ids.add(trip_id)
            normalized = dict(candidate)
            normalized.pop("_abs_dep", None)
            final_trips.append(normalized)

            if len(final_trips) >= max(limit * 5, 20):
                break

        return final_trips

    async def _load_route_schedule_trips(
        self,
        route_ids: list[str],
        direction_id: int,
        *,
        generation: str | None,
    ) -> list[dict]:
        """Load route trips from the same generation as its calendar rules."""
        fields = [f"{route_id}:{direction_id}" for route_id in route_ids]
        if generation is not None:
            values = await self._cache.hmget_json(
                self._schedule_index_key(generation, "trips"),
                fields,
            )
            return [
                trip
                for value in values
                if isinstance(value, list)
                for trip in value
                if isinstance(trip, dict)
            ]

        grouped_trips: list[dict] = []
        for route_id in route_ids:
            value = await self._cache.get_json(
                f"{_KEY_TRIPS_PREFIX}:{route_id}:{direction_id}"
            )
            if isinstance(value, list):
                grouped_trips.extend(trip for trip in value if isinstance(trip, dict))
        return grouped_trips

    async def _load_schedule_window(
        self,
        service_ids: list[str],
        service_dates: list[str],
        *,
        generation: str | None,
    ) -> tuple[dict[str, dict], dict[str, dict[str, set[str]]]]:
        """Load only requested services and dates from the compact v2 index."""
        if generation is not None:
            calendar_values = await self._cache.hmget_json(
                self._schedule_index_key(generation, "calendar"),
                service_ids,
            )
            exception_values = await self._cache.hmget_json(
                self._schedule_index_key(generation, "exceptions"),
                service_dates,
            )
            calendar_by_service = {
                service_id: value
                for service_id, value in zip(service_ids, calendar_values, strict=True)
                if isinstance(value, dict)
            }
            exceptions_by_date = {
                service_date: self._normalize_date_exceptions(value)
                for service_date, value in zip(service_dates, exception_values, strict=True)
            }
            return calendar_by_service, exceptions_by_date

        # Rolling-migration fallback. Once a validated v2 manifest is present,
        # production requests never deserialize the legacy 79 MB document.
        calendar = await self._cache.get_json(_KEY_CALENDAR) or []
        calendar_dates = await self._cache.get_json(_KEY_CALENDAR_DATES) or []
        calendar_by_service = {
            row["service_id"]: row
            for row in calendar
            if isinstance(row, dict) and row.get("service_id") in service_ids
        }
        relevant_dates = set(service_dates)
        exception_states: dict[str, dict[str, int]] = defaultdict(dict)
        for row in calendar_dates:
            if not isinstance(row, dict) or row.get("date") not in relevant_dates:
                continue
            service_id = row.get("service_id")
            exception_type = row.get("exception_type")
            if isinstance(service_id, str) and exception_type in (1, 2):
                exception_states[row["date"]][service_id] = exception_type

        exceptions_by_date = {
            service_date: {
                "added": {
                    service_id
                    for service_id, exception_type in exception_states[service_date].items()
                    if exception_type == 1
                },
                "removed": {
                    service_id
                    for service_id, exception_type in exception_states[service_date].items()
                    if exception_type == 2
                },
            }
            for service_date in service_dates
        }
        return calendar_by_service, exceptions_by_date

    async def _select_schedule_generation(self, manifest: dict | None) -> str | None:
        """Choose one complete schedule generation without mixing snapshots."""
        if manifest is None:
            return None

        counts = manifest.get("component_counts")
        for index, generation in enumerate(
            (manifest.get("generation"), manifest.get("previous_generation"))
        ):
            if (
                not isinstance(generation, str)
                or len(generation) != 32
                or any(character not in "0123456789abcdef" for character in generation)
            ):
                continue
            keys = [
                self._schedule_index_key(generation, component)
                for component in ("calendar", "exceptions", "trips")
            ]
            present = await asyncio.gather(*(self._cache.exists(key) for key in keys))
            if index == 0 and isinstance(counts, dict):
                expected = [
                    counts.get(component)
                    for component in ("calendar", "exceptions", "trips")
                ]
                if all(
                    isinstance(count, int)
                    and count >= 0
                    and (count == 0 or exists)
                    for count, exists in zip(expected, present, strict=True)
                ):
                    return generation
            elif all(present):
                return generation
        return None

    @staticmethod
    def _normalize_date_exceptions(value: object) -> dict[str, set[str]]:
        if not isinstance(value, dict):
            return {"added": set(), "removed": set()}
        return {
            "added": {
                service_id
                for service_id in value.get("added", [])
                if isinstance(service_id, str) and service_id
            },
            "removed": {
                service_id
                for service_id in value.get("removed", [])
                if isinstance(service_id, str) and service_id
            },
        }

    async def _download_gtfs_zip(self) -> bytes:
        """Stream the static archive through strict origin and size limits."""
        current_url = self._validate_gtfs_download_url(self._gtfs_url)

        for redirect_count in range(_MAX_GTFS_REDIRECTS + 1):
            try:
                async with self.http.stream(
                    "GET",
                    current_url,
                    follow_redirects=False,
                ) as response:
                    if response.is_redirect:
                        if redirect_count >= _MAX_GTFS_REDIRECTS:
                            raise ExternalAPIError("ATM", "Too many GTFS download redirects")
                        location = response.headers.get("location")
                        if not location:
                            raise ExternalAPIError("ATM", "Invalid GTFS download redirect")
                        current_url = self._validate_gtfs_download_url(
                            urljoin(str(response.url), location)
                        )
                        continue

                    response.raise_for_status()
                    self._validate_gtfs_content_length(response.headers.get("content-length"))

                    archive = io.BytesIO()
                    downloaded_bytes = 0
                    async for chunk in response.aiter_bytes(_GTFS_DOWNLOAD_CHUNK_BYTES):
                        downloaded_bytes += len(chunk)
                        if downloaded_bytes > _MAX_GTFS_ZIP_BYTES:
                            raise ExternalAPIError("ATM", "GTFS archive exceeds size limit")
                        archive.write(chunk)

                    if downloaded_bytes == 0:
                        raise ExternalAPIError("ATM", "GTFS archive is empty")
                    return archive.getvalue()
            except ExternalAPIError:
                raise
            except httpx.TimeoutException:
                raise ExternalAPIError("ATM", "GTFS download timed out") from None
            except httpx.HTTPStatusError as exc:
                raise ExternalAPIError(
                    "ATM",
                    f"GTFS provider returned HTTP {exc.response.status_code}",
                ) from None
            except httpx.HTTPError:
                # httpx exception strings may expose redirect URLs or credentials.
                raise ExternalAPIError("ATM", "GTFS download connection failed") from None

        raise ExternalAPIError("ATM", "GTFS download redirect failed")

    @staticmethod
    def _validate_gtfs_download_url(raw_url: str) -> str:
        """Allow only the official HTTPS origin, including redirect targets."""
        try:
            parsed = urlsplit(raw_url)
            port = parsed.port
        except (TypeError, ValueError):
            raise ExternalAPIError("ATM", "Invalid GTFS download configuration") from None

        if (
            parsed.scheme != "https"
            or parsed.hostname not in _ALLOWED_GTFS_DOWNLOAD_HOSTS
            or parsed.username is not None
            or parsed.password is not None
            or port not in (None, 443)
            or not parsed.path.startswith("/opendata/")
            or parsed.fragment
        ):
            raise ExternalAPIError("ATM", "GTFS download origin is not allowed")
        return raw_url

    @staticmethod
    def _validate_gtfs_content_length(raw_content_length: str | None) -> None:
        if raw_content_length is None:
            return
        try:
            content_length = int(raw_content_length)
        except ValueError:
            raise ExternalAPIError("ATM", "Invalid GTFS download metadata") from None
        if content_length <= 0:
            raise ExternalAPIError("ATM", "GTFS archive is empty")
        if content_length > _MAX_GTFS_ZIP_BYTES:
            raise ExternalAPIError("ATM", "GTFS archive exceeds size limit")

    @staticmethod
    def _extract_gtfs_files(zip_bytes: bytes) -> tuple[str, str, str, str, str, str, str]:
        if not zip_bytes or len(zip_bytes) > _MAX_GTFS_ZIP_BYTES:
            raise GTFSParseError("gtfs.zip", "Archive size limit exceeded")
        try:
            with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
                GTFSService._validate_gtfs_archive(zf)
                file_list = set(zf.namelist())
                missing = [name for name in _REQUIRED_GTFS_FILES if name not in file_list]
                if missing:
                    raise GTFSParseError("gtfs.zip", "Required GTFS data is missing")

                extracted = {
                    name: GTFSService._read_gtfs_text(zf, name) for name in _REQUIRED_GTFS_FILES
                }
                calendar_data = (
                    GTFSService._read_gtfs_text(zf, "calendar.txt")
                    if "calendar.txt" in file_list
                    else ""
                )
                calendar_dates_data = (
                    GTFSService._read_gtfs_text(zf, "calendar_dates.txt")
                    if "calendar_dates.txt" in file_list
                    else ""
                )

                return (
                    extracted["shapes.txt"],
                    extracted["routes.txt"],
                    extracted["trips.txt"],
                    extracted["stops.txt"],
                    extracted["stop_times.txt"],
                    calendar_data,
                    calendar_dates_data,
                )
        except GTFSParseError:
            raise
        except (zipfile.BadZipFile, UnicodeDecodeError, NotImplementedError, RuntimeError, OSError):
            # Archive/parser errors can contain untrusted entry names. Keep the
            # externally logged exception deliberately generic.
            raise GTFSParseError("gtfs.zip", "Archive failed integrity checks") from None

    @staticmethod
    def _validate_gtfs_archive(zf: zipfile.ZipFile) -> None:
        entries = zf.infolist()
        if not entries or len(entries) > _MAX_GTFS_ZIP_ENTRIES:
            raise GTFSParseError("gtfs.zip", "Archive entry limit exceeded")

        seen_names: set[str] = set()
        total_uncompressed = 0
        for info in entries:
            name = info.filename
            path = PurePosixPath(name)
            unix_mode = (info.external_attr >> 16) & 0xFFFF
            unsafe_name = (
                not name
                or len(name) > _MAX_GTFS_ENTRY_NAME_LENGTH
                or "\\" in name
                or "\x00" in name
                or path.is_absolute()
                or len(path.parts) != 1
                or any(part in {"", ".", ".."} for part in path.parts)
            )
            if unsafe_name or name in seen_names or info.is_dir():
                raise GTFSParseError("gtfs.zip", "Archive contains unsafe entries")
            seen_names.add(name)

            if (
                info.flag_bits & 0x1
                or (unix_mode and stat.S_ISLNK(unix_mode))
                or info.compress_type not in _ALLOWED_GTFS_COMPRESSION_TYPES
            ):
                raise GTFSParseError("gtfs.zip", "Archive contains unsupported entries")
            if (
                info.file_size < 0
                or info.compress_size < 0
                or info.file_size > _MAX_GTFS_ENTRY_UNCOMPRESSED_BYTES
            ):
                raise GTFSParseError("gtfs.zip", "Archive entry size limit exceeded")

            total_uncompressed += info.file_size
            if total_uncompressed > _MAX_GTFS_TOTAL_UNCOMPRESSED_BYTES:
                raise GTFSParseError("gtfs.zip", "Archive total size limit exceeded")
            if info.file_size and (
                info.compress_size == 0
                or info.file_size / info.compress_size > _MAX_GTFS_COMPRESSION_RATIO
            ):
                raise GTFSParseError("gtfs.zip", "Archive compression ratio is unsafe")

    @staticmethod
    def _read_gtfs_text(zf: zipfile.ZipFile, name: str) -> str:
        """Read one validated member without a single unbounded allocation."""
        output = io.BytesIO()
        extracted_bytes = 0
        with zf.open(name, "r") as source:
            while chunk := source.read(_GTFS_DOWNLOAD_CHUNK_BYTES):
                extracted_bytes += len(chunk)
                if extracted_bytes > _MAX_GTFS_ENTRY_UNCOMPRESSED_BYTES:
                    raise GTFSParseError("gtfs.zip", "Archive entry size limit exceeded")
                output.write(chunk)
        return output.getvalue().decode("utf-8-sig")

    @staticmethod
    def _iter_bounded_rows(
        csv_data: str,
        *,
        filename: str,
        max_rows: int,
    ) -> Iterator[dict[str, str | None]]:
        """Yield CSV rows under hard field/row limits with generic errors."""
        try:
            reader = csv.DictReader(io.StringIO(csv_data))
            for index, row in enumerate(reader, start=1):
                if index > max_rows:
                    raise GTFSParseError(filename, "CSV row limit exceeded")
                yield row
        except csv.Error:
            raise GTFSParseError(filename, "CSV integrity check failed") from None

    @staticmethod
    def _bounded_text(
        row: dict[str, str | None],
        key: str,
        *,
        max_length: int,
    ) -> str:
        value = (row.get(key) or "").strip()
        if len(value) > max_length or any(ord(character) < 32 for character in value):
            raise GTFSParseError("gtfs.csv", "CSV field limit exceeded")
        return value

    @classmethod
    def _parse_shapes(
        cls,
        csv_data: str,
        allowed_shape_ids: set[str] | None = None,
    ) -> dict[str, list[dict]]:
        shapes: dict[str, list[dict]] = defaultdict(list)
        for row in cls._iter_bounded_rows(
            csv_data,
            filename="shapes.txt",
            max_rows=_MAX_SHAPE_POINT_ROWS,
        ):
            shape_id = cls._bounded_text(row, "shape_id", max_length=160)
            if not shape_id or allowed_shape_ids is not None and shape_id not in allowed_shape_ids:
                continue

            try:
                latitude = float(row.get("shape_pt_lat", 0) or 0)
                longitude = float(row.get("shape_pt_lon", 0) or 0)
                sequence = int(row.get("shape_pt_sequence", 0) or 0)
            except (TypeError, ValueError, OverflowError):
                continue
            if (
                not math.isfinite(latitude)
                or not math.isfinite(longitude)
                or not 40.0 <= latitude <= 43.5
                or not -0.5 <= longitude <= 4.0
                or not 0 <= sequence <= _MAX_SHAPE_POINT_ROWS
            ):
                continue

            shapes[shape_id].append(
                {"lat": latitude, "lon": longitude, "sequence": sequence}
            )

        for shape_id in shapes:
            shapes[shape_id].sort(key=lambda point: point["sequence"])

        return dict(shapes)

    @classmethod
    def _parse_routes(cls, csv_data: str) -> dict[str, dict]:
        routes: dict[str, dict] = {}
        for row in cls._iter_bounded_rows(
            csv_data,
            filename="routes.txt",
            max_rows=_MAX_ROUTE_ROWS,
        ):
            route_id = cls._bounded_text(row, "route_id", max_length=160)
            if not route_id:
                continue

            route_type_raw = (row.get("route_type") or "3").strip()
            try:
                route_type = int(route_type_raw)
            except ValueError:
                route_type = 3

            routes[route_id] = {
                "route_short_name": cls._bounded_text(
                    row, "route_short_name", max_length=80
                ),
                "route_long_name": cls._bounded_text(row, "route_long_name", max_length=300),
                "route_color": cls._bounded_text(row, "route_color", max_length=8),
                "route_text_color": cls._bounded_text(
                    row, "route_text_color", max_length=8
                ),
                "route_type": route_type,
                "agency_id": cls._bounded_text(row, "agency_id", max_length=160),
            }

        return routes

    @classmethod
    def _parse_trip_rows(cls, csv_data: str, bus_route_ids: set[str]) -> list[dict]:
        trip_rows: list[dict] = []
        for row in cls._iter_bounded_rows(
            csv_data,
            filename="trips.txt",
            max_rows=_MAX_TRIP_ROWS,
        ):
            route_id = cls._bounded_text(row, "route_id", max_length=160)
            trip_id = cls._bounded_text(row, "trip_id", max_length=160)
            if not route_id or not trip_id or route_id not in bus_route_ids:
                continue

            direction_raw = (row.get("direction_id") or "0").strip()
            try:
                direction_id = int(direction_raw)
            except ValueError:
                continue
            if direction_id not in (0, 1):
                continue

            trip_rows.append(
                {
                    "route_id": route_id,
                    "direction_id": direction_id,
                    "trip_id": trip_id,
                    "service_id": cls._bounded_text(row, "service_id", max_length=160),
                    "trip_headsign": cls._bounded_text(
                        row, "trip_headsign", max_length=300
                    ),
                    "shape_id": cls._bounded_text(row, "shape_id", max_length=160),
                }
            )

        return trip_rows

    @classmethod
    def _parse_stops(
        cls,
        csv_data: str,
        allowed_stop_ids: set[str] | None = None,
    ) -> dict[str, dict]:
        stops: dict[str, dict] = {}
        for row in cls._iter_bounded_rows(
            csv_data,
            filename="stops.txt",
            max_rows=_MAX_STOP_ROWS,
        ):
            stop_id = cls._bounded_text(row, "stop_id", max_length=160)
            if not stop_id or allowed_stop_ids is not None and stop_id not in allowed_stop_ids:
                continue

            try:
                latitude = float(row.get("stop_lat", 0) or 0)
                longitude = float(row.get("stop_lon", 0) or 0)
            except (TypeError, ValueError, OverflowError):
                continue
            if (
                not math.isfinite(latitude)
                or not math.isfinite(longitude)
                or not 40.0 <= latitude <= 43.5
                or not -0.5 <= longitude <= 4.0
            ):
                continue

            stops[stop_id] = {
                "lat": latitude,
                "lon": longitude,
                "name": cls._bounded_text(row, "stop_name", max_length=500),
            }

        return stops

    @classmethod
    def _parse_stop_times(
        cls,
        csv_data: str,
        allowed_trip_ids: set[str] | None = None,
    ) -> dict[str, list[StopTimeRow]]:
        trip_stops: dict[str, list[StopTimeRow]] = defaultdict(list)
        for row in cls._iter_bounded_rows(
            csv_data,
            filename="stop_times.txt",
            max_rows=_MAX_STOP_TIME_ROWS,
        ):
            trip_id = cls._bounded_text(row, "trip_id", max_length=160)
            if not trip_id or allowed_trip_ids is not None and trip_id not in allowed_trip_ids:
                continue

            stop_id = cls._bounded_text(row, "stop_id", max_length=160)
            try:
                sequence = int(row.get("stop_sequence", 0) or 0)
            except (TypeError, ValueError, OverflowError):
                continue
            if not stop_id or not 0 <= sequence <= 10_000:
                continue
            departure = cls._bounded_text(row, "departure_time", max_length=9)
            if not departure:
                departure = cls._bounded_text(row, "arrival_time", max_length=9)
            trip_stops[trip_id].append((stop_id, sequence, departure))

        for trip_id in trip_stops:
            trip_stops[trip_id].sort(key=lambda stop: stop[1])

        return dict(trip_stops)

    @staticmethod
    def _parse_first_stop_departures(
        stop_times_by_trip: dict[str, list[StopTimeRow]],
    ) -> dict[str, str]:
        first_departures: dict[str, str] = {}
        for trip_id, stops in stop_times_by_trip.items():
            if not stops:
                continue

            first = min(stops, key=lambda stop: stop[1])
            departure = first[2]
            if departure:
                first_departures[trip_id] = departure

        return first_departures

    @staticmethod
    def _build_representative_mappings(
        trip_rows: list[dict],
    ) -> tuple[dict[tuple[str, int], str], dict[tuple[str, int], str]]:
        route_to_shape: dict[tuple[str, int], str] = {}
        route_to_trip: dict[tuple[str, int], str] = {}

        for trip in trip_rows:
            key = (trip["route_id"], trip["direction_id"])
            if key not in route_to_shape and trip.get("shape_id"):
                route_to_shape[key] = trip["shape_id"]
            if key not in route_to_trip:
                route_to_trip[key] = trip["trip_id"]

        return route_to_shape, route_to_trip

    @staticmethod
    def _towards_label(destination_name: str) -> str:
        clean_destination = destination_name.strip()
        return f"Towards {clean_destination}" if clean_destination else ""

    def _build_trip_indexes(
        self,
        trip_rows: list[dict],
        routes_by_id: dict[str, dict],
        shapes_by_id: dict[str, list[dict]],
        stops_by_id: dict[str, dict],
        stop_times_by_trip: dict[str, list[StopTimeRow]],
        trip_start_times: dict[str, str],
    ) -> tuple[dict[str, dict], dict[str, dict], dict[str, dict]]:
        trip_meta_by_id: dict[str, dict] = {}
        stop_patterns_by_id: dict[str, dict] = {}
        shape_geometries_by_id: dict[str, dict] = {}

        for trip in trip_rows:
            trip_id = trip["trip_id"]
            route_id = trip["route_id"]
            direction_id = trip["direction_id"]
            shape_id = trip.get("shape_id", "")
            route_info = routes_by_id.get(route_id, {})

            stop_rows = stop_times_by_trip.get(trip_id, [])
            pattern_stops: list[dict] = []
            origin_stop_name = ""
            destination_stop_name = ""
            origin_stop_id = ""
            destination_stop_id = ""

            if stop_rows:
                first = stop_rows[0]
                last = stop_rows[-1]
                origin_stop_id = first[0]
                destination_stop_id = last[0]
                origin_stop_name = stops_by_id.get(origin_stop_id, {}).get("name", "")
                destination_stop_name = stops_by_id.get(destination_stop_id, {}).get("name", "")

            for stop in stop_rows:
                stop_id = stop[0]
                stop_info = stops_by_id.get(stop_id)
                if not stop_info:
                    continue

                pattern_stops.append(
                    {
                        "stop_id": stop_id,
                        "sequence": stop[1],
                        "stop_name": stop_info.get("name", ""),
                        "coordinates": [stop_info.get("lon", 0), stop_info.get("lat", 0)],
                    }
                )

            stop_pattern = {"stops": pattern_stops}
            stop_pattern_id = hashlib.sha256(
                orjson.dumps(stop_pattern, option=orjson.OPT_SORT_KEYS)
            ).hexdigest()
            stop_patterns_by_id.setdefault(stop_pattern_id, stop_pattern)

            destination_name = trip.get("trip_headsign") or destination_stop_name
            trip_meta = {
                "trip_id": trip_id,
                "route_id": route_id,
                "direction_id": direction_id,
                "service_id": trip.get("service_id", ""),
                "trip_headsign": trip.get("trip_headsign", ""),
                "shape_id": shape_id,
                "stop_pattern_id": stop_pattern_id,
                "departure_time": trip_start_times.get(trip_id, ""),
                "origin_stop_name": origin_stop_name,
                "destination_stop_name": destination_stop_name,
                "origin_stop_id": origin_stop_id,
                "destination_stop_id": destination_stop_id,
                "towards_label": self._towards_label(destination_name),
                "destination_name": destination_name,
                "route_short_name": route_info.get("route_short_name", ""),
                "route_long_name": route_info.get("route_long_name", ""),
                "route_color": route_info.get("route_color", ""),
                "route_text_color": route_info.get("route_text_color", ""),
                "route_type": int(route_info.get("route_type", 3)),
                "agency_id": route_info.get("agency_id", ""),
            }
            trip_meta_by_id[trip_id] = trip_meta

            if shape_id in shapes_by_id and shape_id not in shape_geometries_by_id:
                points = shapes_by_id[shape_id]
                coordinates = [[point["lon"], point["lat"]] for point in points]
                shape_geometries_by_id[shape_id] = {
                    "type": "LineString",
                    "coordinates": coordinates,
                }

        return trip_meta_by_id, stop_patterns_by_id, shape_geometries_by_id

    def _build_representative_stop_collections(
        self,
        route_to_trip: dict[tuple[str, int], str],
        trip_meta_by_id: dict[str, dict],
        stop_patterns_by_id: dict[str, dict],
    ) -> dict[str, dict]:
        """Materialize only the few route-level stop collections kept for compatibility."""
        now_iso = datetime.now(tz=UTC).isoformat()
        representative_stops: dict[str, dict] = {}

        for trip_id in dict.fromkeys(route_to_trip.values()):
            trip_meta = trip_meta_by_id.get(trip_id)
            if trip_meta is None:
                continue
            stop_pattern = stop_patterns_by_id.get(trip_meta.get("stop_pattern_id", ""))
            collection = self._build_trip_stop_collection(trip_meta, stop_pattern, now_iso)
            if collection is not None:
                representative_stops[trip_id] = collection

        return representative_stops

    def _build_route_shapes(
        self,
        route_to_shape: dict[tuple[str, int], str],
        shapes_by_id: dict[str, list[dict]],
        routes_by_id: dict[str, dict],
        route_to_trip: dict[tuple[str, int], str],
        trip_meta_by_id: dict[str, dict],
    ) -> list[RouteShape]:
        route_shapes: list[RouteShape] = []

        for (route_id, direction_id), shape_id in route_to_shape.items():
            if shape_id not in shapes_by_id:
                continue

            route_info = routes_by_id.get(route_id, {})
            if int(route_info.get("route_type", 3)) != 3:
                continue

            representative_trip_id = route_to_trip.get((route_id, direction_id))
            representative_meta = trip_meta_by_id.get(representative_trip_id or "", {})
            destination_name = representative_meta.get("destination_name", "")
            towards_label = representative_meta.get("towards_label", "")

            coordinates = [[point["lon"], point["lat"]] for point in shapes_by_id[shape_id]]
            geojson_feature = {
                "type": "Feature",
                "properties": {
                    "route_id": route_id,
                    "direction_id": direction_id,
                    "shape_id": shape_id,
                    "trip_id": representative_trip_id,
                    "route_short_name": route_info.get("route_short_name", ""),
                    "route_long_name": route_info.get("route_long_name", ""),
                    "route_color": route_info.get("route_color", ""),
                    "route_text_color": route_info.get("route_text_color", ""),
                    "route_type": int(route_info.get("route_type", 3)),
                    "destination_name": destination_name,
                    "towards_label": towards_label,
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": coordinates,
                },
            }

            route_shapes.append(
                RouteShape(
                    route_id=route_id,
                    shape_id=shape_id,
                    route_short_name=route_info.get("route_short_name", ""),
                    route_long_name=route_info.get("route_long_name", ""),
                    route_color=route_info.get("route_color", ""),
                    route_text_color=route_info.get("route_text_color", ""),
                    route_type=int(route_info.get("route_type", 3)),
                    direction_id=direction_id,
                    trip_id=representative_trip_id,
                    destination_name=destination_name,
                    towards_label=towards_label,
                    geojson=geojson_feature,
                )
            )

        return route_shapes

    def _build_deduplicated_routes(
        self, routes_by_id: dict[str, dict], trip_meta_by_id: dict[str, dict]
    ) -> list[dict]:
        grouped: dict[str, list[str]] = defaultdict(list)

        for route_id, route_info in routes_by_id.items():
            if int(route_info.get("route_type", 3)) != 3:
                continue
            short_name = (route_info.get("route_short_name") or route_id).strip().upper()
            grouped[short_name].append(route_id)

        route_infos: list[dict] = []
        for grouped_route_ids in grouped.values():
            grouped_route_ids.sort()
            canonical_route_id = grouped_route_ids[0]
            canonical = routes_by_id.get(canonical_route_id, {})

            direction_destinations: list[DirectionInfo] = []
            by_direction: dict[int, str] = {}
            for trip_meta in trip_meta_by_id.values():
                if trip_meta.get("route_id") not in grouped_route_ids:
                    continue
                direction_id = int(trip_meta.get("direction_id", 0))
                if direction_id in by_direction and by_direction[direction_id]:
                    continue
                destination_name = (
                    trip_meta.get("trip_headsign")
                    or trip_meta.get("destination_stop_name")
                    or canonical.get("route_long_name", "")
                )
                by_direction[direction_id] = destination_name

            for direction_id in sorted(by_direction.keys()):
                destination_name = by_direction[direction_id]
                direction_destinations.append(
                    DirectionInfo(
                        direction_id=direction_id,
                        destination_name=destination_name,
                        label=self._towards_label(destination_name),
                    )
                )

            route_infos.append(
                RouteInfo(
                    route_id=canonical_route_id,
                    route_short_name=canonical.get("route_short_name", ""),
                    route_long_name=canonical.get("route_long_name", ""),
                    route_color=canonical.get("route_color", ""),
                    route_text_color=canonical.get("route_text_color", ""),
                    route_type=int(canonical.get("route_type", 3)),
                    agency_id=canonical.get("agency_id", ""),
                    route_ids=grouped_route_ids,
                    direction_destinations=direction_destinations,
                    display_name=(
                        f"{canonical.get('route_short_name', '').strip()} "
                        f"{canonical.get('route_long_name', '').strip()}"
                    ).strip(),
                ).model_dump(mode="json")
            )

        route_infos.sort(
            key=lambda route: (route.get("route_short_name") or "", route.get("route_id") or "")
        )
        return route_infos

    @staticmethod
    def _build_trips_by_route_direction(
        trip_rows: list[dict],
        trip_start_times: dict[str, str],
        trip_meta_by_id: dict[str, dict],
    ) -> dict[tuple[str, int], list[dict]]:
        trips_by_route_dir: dict[tuple[str, int], list[dict]] = defaultdict(list)

        for trip in trip_rows:
            trip_id = trip["trip_id"]
            departure_time = trip_start_times.get(trip_id)
            if not departure_time:
                continue

            meta = trip_meta_by_id.get(trip_id, {})
            key = (trip["route_id"], trip["direction_id"])
            trips_by_route_dir[key].append(
                {
                    "trip_id": trip_id,
                    "route_id": trip["route_id"],
                    "service_id": trip.get("service_id", ""),
                    "trip_headsign": trip.get("trip_headsign", ""),
                    "departure_time": departure_time,
                    "origin_stop_name": meta.get("origin_stop_name", ""),
                    "destination_stop_name": meta.get("destination_stop_name", ""),
                    "towards_label": meta.get("towards_label", ""),
                    "destination_name": meta.get("destination_name", ""),
                    "shape_id": trip.get("shape_id", ""),
                }
            )

        for route_key in trips_by_route_dir:
            trips_by_route_dir[route_key].sort(key=lambda item: item.get("departure_time", ""))

        return dict(trips_by_route_dir)

    @staticmethod
    def _canonical_route_groups(route_infos: list[dict]) -> dict[str, list[str]]:
        """Map each canonical route to every underlying GTFS route identifier."""
        groups: dict[str, list[str]] = {}

        for raw_route in route_infos:
            route = (
                raw_route.model_dump(mode="json") if isinstance(raw_route, RouteInfo) else raw_route
            )
            if not isinstance(route, dict):
                continue

            canonical_route_id = route.get("route_id")
            if not isinstance(canonical_route_id, str) or not canonical_route_id:
                continue

            identifiers = [canonical_route_id]
            grouped_route_ids = route.get("route_ids")
            if isinstance(grouped_route_ids, list):
                identifiers.extend(
                    route_id
                    for route_id in grouped_route_ids
                    if isinstance(route_id, str) and route_id
                )

            groups[canonical_route_id] = list(dict.fromkeys(identifiers))

        return groups

    @staticmethod
    def _normalize_stop_coordinate(coordinate: object) -> tuple[float, float] | None:
        if not isinstance(coordinate, (list, tuple)) or len(coordinate) < 2:
            return None

        longitude, latitude = coordinate[0], coordinate[1]
        if (
            isinstance(longitude, bool)
            or isinstance(latitude, bool)
            or not isinstance(longitude, (int, float))
            or not isinstance(latitude, (int, float))
        ):
            return None

        normalized_longitude = float(longitude)
        normalized_latitude = float(latitude)
        if (
            not math.isfinite(normalized_longitude)
            or not math.isfinite(normalized_latitude)
            or normalized_longitude < -180
            or normalized_longitude > 180
            or normalized_latitude < -90
            or normalized_latitude > 90
        ):
            return None

        # Six decimal places retain sub-metre precision while keeping the index compact.
        return round(normalized_longitude, 6), round(normalized_latitude, 6)

    @classmethod
    def _add_stop_collection(
        cls,
        route_points: dict[str, set[tuple[float, float]]],
        canonical_route_id: str,
        stop_collection: object,
    ) -> None:
        if not isinstance(stop_collection, dict):
            return

        features = stop_collection.get("features")
        if not isinstance(features, list):
            return

        for feature in features:
            if not isinstance(feature, dict):
                continue
            geometry = feature.get("geometry")
            if not isinstance(geometry, dict) or geometry.get("type") != "Point":
                continue
            coordinate = cls._normalize_stop_coordinate(geometry.get("coordinates"))
            if coordinate is not None:
                route_points[canonical_route_id].add(coordinate)

    @staticmethod
    def _finalize_route_points(
        route_points: dict[str, set[tuple[float, float]]],
    ) -> ProximityIndex:
        return {
            route_id: [[longitude, latitude] for longitude, latitude in sorted(points)]
            for route_id, points in sorted(route_points.items())
            if points
        }

    @classmethod
    def _build_route_proximity_index(
        cls,
        route_infos: list[dict],
        route_to_trip: dict[tuple[str, int], str],
        trip_stops_by_id: dict[str, dict],
    ) -> ProximityIndex:
        """Build a compact canonical route-to-stops index during a GTFS refresh."""
        groups = cls._canonical_route_groups(route_infos)
        canonical_by_route_id = {
            route_id: canonical_route_id
            for canonical_route_id, route_ids in groups.items()
            for route_id in route_ids
        }
        route_points: dict[str, set[tuple[float, float]]] = defaultdict(set)

        for (route_id, _direction_id), trip_id in route_to_trip.items():
            canonical_route_id = canonical_by_route_id.get(route_id)
            if canonical_route_id is None:
                continue
            cls._add_stop_collection(
                route_points,
                canonical_route_id,
                trip_stops_by_id.get(trip_id),
            )

        return cls._finalize_route_points(route_points)

    @classmethod
    def _deserialize_route_proximity_index(cls, cached: object) -> ProximityIndex | None:
        """Validate a cached index and discard malformed coordinates defensively."""
        if not isinstance(cached, dict) or cached.get("version") != _PROXIMITY_INDEX_VERSION:
            return None
        cached_routes = cached.get("routes")
        if not isinstance(cached_routes, dict):
            return None

        route_points: dict[str, set[tuple[float, float]]] = defaultdict(set)
        for route_id, coordinates in cached_routes.items():
            if not isinstance(route_id, str) or not route_id or not isinstance(coordinates, list):
                continue
            for coordinate in coordinates:
                normalized = cls._normalize_stop_coordinate(coordinate)
                if normalized is not None:
                    route_points[route_id].add(normalized)

        return cls._finalize_route_points(route_points)

    async def _cache_route_proximity_index(self, proximity_index: ProximityIndex) -> None:
        await self._cache.set_json(
            _KEY_PROXIMITY_INDEX,
            {"version": _PROXIMITY_INDEX_VERSION, "routes": proximity_index},
            ttl=self._settings.CACHE_TTL_GTFS_SHAPES,
        )

    async def _build_route_proximity_index_from_cached_stops(
        self,
        route_infos: list[dict],
    ) -> ProximityIndex:
        """Lazily rebuild the index for Redis data written by earlier app versions."""
        groups = self._canonical_route_groups(route_infos)
        stop_key_owners: dict[str, str] = {}

        for canonical_route_id, route_ids in groups.items():
            for route_id in route_ids:
                for suffix in ("", ":0", ":1"):
                    stop_key_owners.setdefault(
                        f"{_KEY_STOPS_PREFIX}:{route_id}{suffix}",
                        canonical_route_id,
                    )

        route_points: dict[str, set[tuple[float, float]]] = defaultdict(set)
        stop_key_items = list(stop_key_owners.items())
        for start in range(0, len(stop_key_items), _PROXIMITY_STOP_KEY_BATCH_SIZE):
            batch = stop_key_items[start : start + _PROXIMITY_STOP_KEY_BATCH_SIZE]
            collections = await self._cache.mget_json([key for key, _owner in batch])
            for (_key, canonical_route_id), stop_collection in zip(
                batch,
                collections,
                strict=True,
            ):
                self._add_stop_collection(route_points, canonical_route_id, stop_collection)

        return self._finalize_route_points(route_points)

    async def _get_or_build_route_proximity_index(self) -> ProximityIndex:
        cached = await self._cache.get_json(_KEY_PROXIMITY_INDEX)
        proximity_index = self._deserialize_route_proximity_index(cached)
        if proximity_index is not None:
            return proximity_index

        async with self._proximity_index_lock:
            cached = await self._cache.get_json(_KEY_PROXIMITY_INDEX)
            proximity_index = self._deserialize_route_proximity_index(cached)
            if proximity_index is not None:
                return proximity_index

            route_infos = await self._cache.get_json(_KEY_ROUTES)
            if not isinstance(route_infos, list):
                return {}

            proximity_index = await self._build_route_proximity_index_from_cached_stops(route_infos)
            if proximity_index:
                await self._cache_route_proximity_index(proximity_index)
            return proximity_index

    @staticmethod
    def _haversine_distance_meters(
        from_latitude: float,
        from_longitude: float,
        to_latitude: float,
        to_longitude: float,
    ) -> float:
        from_latitude_radians = math.radians(from_latitude)
        to_latitude_radians = math.radians(to_latitude)
        latitude_delta = math.radians(to_latitude - from_latitude)
        longitude_delta = math.radians(to_longitude - from_longitude)
        haversine = (
            math.sin(latitude_delta / 2) ** 2
            + math.cos(from_latitude_radians)
            * math.cos(to_latitude_radians)
            * math.sin(longitude_delta / 2) ** 2
        )
        angular_distance = 2 * math.atan2(
            math.sqrt(haversine),
            math.sqrt(max(0.0, 1 - haversine)),
        )
        return _EARTH_RADIUS_METERS * angular_distance

    async def _cache_shapes(self, route_shapes: list[RouteShape], route_infos: list[dict]) -> None:
        ttl = self._settings.CACHE_TTL_GTFS_SHAPES
        now_iso = datetime.now(tz=UTC).isoformat()
        await self._cache.set_json(_KEY_ROUTES, route_infos, ttl=ttl)
        await self._cache.set(_KEY_LAST_UPDATED, now_iso, ttl=ttl)

        individual_mapping: dict[str, dict] = {}
        for route_shape in route_shapes:
            direction_id = route_shape.direction_id if route_shape.direction_id is not None else 0
            individual_mapping[f"{_KEY_SHAPE_PREFIX}:{route_shape.route_id}:{direction_id}"] = (
                route_shape.model_dump(mode="json")
            )
            if direction_id == 0:
                individual_mapping[f"{_KEY_SHAPE_PREFIX}:{route_shape.route_id}"] = (
                    route_shape.model_dump(mode="json")
                )

        if individual_mapping:
            await self._cache.mset_json(individual_mapping, ttl=ttl)

    async def _cache_stops(
        self, route_to_trip: dict[tuple[str, int], str], trip_stops_by_id: dict[str, dict]
    ) -> None:
        ttl = self._settings.CACHE_TTL_GTFS_SHAPES
        mapping: dict[str, dict] = {}

        for (route_id, direction_id), trip_id in route_to_trip.items():
            route_stops = trip_stops_by_id.get(trip_id)
            if route_stops is None:
                continue

            mapping[f"{_KEY_STOPS_PREFIX}:{route_id}:{direction_id}"] = route_stops
            if direction_id == 0:
                mapping[f"{_KEY_STOPS_PREFIX}:{route_id}"] = route_stops

        if mapping:
            await self._cache.mset_json(mapping, ttl=ttl)

    async def _cache_calendar_and_trips(
        self,
        calendar: list[dict],
        calendar_dates: dict[str, dict[str, list[str]]],
        trips_by_route_dir: dict[tuple[str, int], list[dict]],
        *,
        trip_generation: str | None = None,
        snapshot_id: str | None = None,
    ) -> dict:
        ttl = self._settings.CACHE_TTL_GTFS_SHAPES
        trips_by_field = {
            f"{route_id}:{direction_id}": trips
            for (route_id, direction_id), trips in trips_by_route_dir.items()
        }

        calendar_by_service = {
            row["service_id"]: {key: value for key, value in row.items() if key != "service_id"}
            for row in calendar
            if isinstance(row.get("service_id"), str) and row["service_id"]
        }
        previous_manifest = await self._get_active_schedule_index()
        if previous_manifest is not None:
            obsolete_generation = previous_manifest.get("previous_generation")
            if isinstance(obsolete_generation, str) and len(obsolete_generation) == 32:
                await self._cache.unlink(
                    self._schedule_index_key(obsolete_generation, "calendar"),
                    self._schedule_index_key(obsolete_generation, "exceptions"),
                    self._schedule_index_key(obsolete_generation, "trips"),
                )
        generation = uuid.uuid4().hex
        calendar_key = self._schedule_index_key(generation, "calendar")
        exceptions_key = self._schedule_index_key(generation, "exceptions")
        trips_key = self._schedule_index_key(generation, "trips")

        try:
            if calendar_by_service:
                await self._cache.hset_json_batched(
                    calendar_key,
                    calendar_by_service,
                    ttl=ttl,
                    batch_size=_TRIP_INDEX_WRITE_BATCH_SIZE,
                    max_batch_bytes=_TRIP_INDEX_WRITE_BATCH_BYTES,
                )
            if calendar_dates:
                await self._cache.hset_json_batched(
                    exceptions_key,
                    calendar_dates,
                    ttl=ttl,
                    batch_size=_TRIP_INDEX_WRITE_BATCH_SIZE,
                    max_batch_bytes=_TRIP_INDEX_WRITE_BATCH_BYTES,
                )
            if trips_by_field:
                await self._cache.hset_json_batched(
                    trips_key,
                    trips_by_field,
                    ttl=ttl,
                    batch_size=_TRIP_INDEX_WRITE_BATCH_SIZE,
                    max_batch_bytes=_TRIP_INDEX_WRITE_BATCH_BYTES,
                )

            actual_counts = await asyncio.gather(
                self._cache.hash_length(calendar_key),
                self._cache.hash_length(exceptions_key),
                self._cache.hash_length(trips_key),
            )
            if actual_counts != [
                len(calendar_by_service),
                len(calendar_dates),
                len(trips_by_field),
            ]:
                raise RuntimeError("GTFS schedule index cardinality mismatch")

            expiry_targets = [
                key
                for key, expected_count in (
                    (calendar_key, len(calendar_by_service)),
                    (exceptions_key, len(calendar_dates)),
                    (trips_key, len(trips_by_field)),
                )
                if expected_count
            ]
            if expiry_targets:
                expiry_results = await asyncio.gather(
                    *(self._cache.expire(key, ttl) for key in expiry_targets)
                )
                if not all(expiry_results):
                    raise RuntimeError("GTFS schedule index expiry failed")

            manifest = {
                "version": _SCHEDULE_INDEX_VERSION,
                "generation": generation,
                "last_updated": datetime.now(tz=UTC).isoformat(),
                "component_counts": {
                    "calendar": len(calendar_by_service),
                    "exceptions": len(calendar_dates),
                    "trips": len(trips_by_field),
                },
            }
            if trip_generation is not None:
                manifest["trip_generation"] = trip_generation
            if snapshot_id is not None:
                manifest["snapshot_id"] = snapshot_id
            if previous_manifest is not None:
                manifest["previous_generation"] = previous_manifest["generation"]
            await self._cache.set_json(_KEY_SCHEDULE_INDEX_ACTIVE, manifest, ttl=ttl)
        except Exception:
            await self._cache.unlink(calendar_key, exceptions_key, trips_key)
            raise

        try:
            # Compatibility marker for older API workers that only test the
            # legacy calendar key's truthiness before serving departures.
            await self._cache.set_json(
                _KEY_CALENDAR,
                {"version": _SCHEDULE_INDEX_VERSION, "generation": generation},
                ttl=ttl,
            )
        except Exception:
            logger.warning("GTFS schedule compatibility marker was not refreshed")

        try:
            previous_generation = (
                previous_manifest.get("generation") if previous_manifest is not None else None
            )
            if isinstance(previous_generation, str) and len(previous_generation) == 32:
                grace_ttl = min(
                    _INDEX_ROLLOVER_GRACE_SECONDS,
                    self._settings.CACHE_TTL_GTFS_SHAPES,
                )
                await asyncio.gather(
                    self._cache.expire(
                        self._schedule_index_key(previous_generation, "calendar"), grace_ttl
                    ),
                    self._cache.expire(
                        self._schedule_index_key(previous_generation, "exceptions"), grace_ttl
                    ),
                    self._cache.expire(
                        self._schedule_index_key(previous_generation, "trips"), grace_ttl
                    ),
                )
            # Remove the old 79 MB monolith only after a validated v2 index is active.
            await self._cache.unlink(_KEY_CALENDAR_DATES)
        except Exception:
            logger.warning("Deferred GTFS schedule-index cleanup did not complete")
        return manifest

    async def _cache_trip_indexes(
        self,
        trip_meta_by_id: dict[str, dict],
        stop_patterns_by_id: dict[str, dict],
        shape_geometries_by_id: dict[str, dict],
        *,
        snapshot_id: str | None = None,
    ) -> dict:
        """Publish a complete deduplicated generation, then retire legacy keys.

        The active pointer is written only after every hash has the expected
        cardinality. Readers therefore see either the previous complete index
        or the new complete one, never a partially populated refresh.
        """
        ttl = self._settings.CACHE_TTL_GTFS_SHAPES
        if not trip_meta_by_id or not stop_patterns_by_id or not shape_geometries_by_id:
            raise GTFSParseError("gtfs.zip", "Trip index is incomplete")

        previous_manifest = await self._get_active_trip_index()
        if previous_manifest is not None:
            obsolete_generation = previous_manifest.get("previous_generation")
            active_schedule = await self._get_active_schedule_index()
            referenced_trip_generation = (
                active_schedule.get("trip_generation")
                if active_schedule is not None
                else None
            )
            if (
                isinstance(obsolete_generation, str)
                and len(obsolete_generation) == 32
                and (
                    active_schedule is None
                    or referenced_trip_generation is not None
                    and obsolete_generation != referenced_trip_generation
                )
            ):
                await self._cache.unlink(
                    self._trip_index_key(obsolete_generation, "meta"),
                    self._trip_index_key(obsolete_generation, "stops"),
                    self._trip_index_key(obsolete_generation, "shapes"),
                )
        generation = uuid.uuid4().hex
        meta_key = self._trip_index_key(generation, "meta")
        stops_key = self._trip_index_key(generation, "stops")
        shapes_key = self._trip_index_key(generation, "shapes")

        try:
            await self._cache.hset_json_batched(
                meta_key,
                trip_meta_by_id,
                ttl=ttl,
                batch_size=_TRIP_INDEX_WRITE_BATCH_SIZE,
                max_batch_bytes=_TRIP_INDEX_WRITE_BATCH_BYTES,
            )
            await self._cache.hset_json_batched(
                stops_key,
                stop_patterns_by_id,
                ttl=ttl,
                batch_size=_TRIP_INDEX_WRITE_BATCH_SIZE,
                max_batch_bytes=_TRIP_INDEX_WRITE_BATCH_BYTES,
            )
            await self._cache.hset_json_batched(
                shapes_key,
                shape_geometries_by_id,
                ttl=ttl,
                batch_size=_TRIP_INDEX_WRITE_BATCH_SIZE,
                max_batch_bytes=_TRIP_INDEX_WRITE_BATCH_BYTES,
            )

            actual_counts = await asyncio.gather(
                self._cache.hash_length(meta_key),
                self._cache.hash_length(stops_key),
                self._cache.hash_length(shapes_key),
            )
            expected_counts = [
                len(trip_meta_by_id),
                len(stop_patterns_by_id),
                len(shape_geometries_by_id),
            ]
            if actual_counts != expected_counts:
                raise RuntimeError("GTFS trip index cardinality mismatch")

            # Align expiries immediately before publication so the manifest can
            # never outlive a hash because an earlier batch took longer to write.
            expiry_results = await asyncio.gather(
                self._cache.expire(meta_key, ttl),
                self._cache.expire(stops_key, ttl),
                self._cache.expire(shapes_key, ttl),
            )
            if not all(expiry_results):
                raise RuntimeError("GTFS trip index expiry failed")

            manifest = {
                "version": _TRIP_INDEX_VERSION,
                "generation": generation,
                "last_updated": datetime.now(tz=UTC).isoformat(),
            }
            if snapshot_id is not None:
                manifest["snapshot_id"] = snapshot_id
            if previous_manifest is not None:
                manifest["previous_generation"] = previous_manifest["generation"]
            await self._cache.set_json(_KEY_TRIP_INDEX_ACTIVE, manifest, ttl=ttl)
        except Exception:
            # A failed generation was never published. UNLINK keeps reclamation
            # asynchronous even when one geometry hash is large.
            await self._cache.unlink(meta_key, stops_key, shapes_key)
            raise

        await self._cleanup_published_trip_indexes(previous_manifest)
        return manifest

    async def _cleanup_published_trip_indexes(self, previous_manifest: dict | None) -> None:
        """Bound legacy memory after publication without blocking Redis."""
        try:
            # A short grace lets in-flight readers finish while avoiding a
            # second full generation living for the 72-hour dataset TTL.
            previous_generation = (
                previous_manifest.get("generation") if previous_manifest is not None else None
            )
            if isinstance(previous_generation, str) and len(previous_generation) == 32:
                grace_ttl = min(
                    _INDEX_ROLLOVER_GRACE_SECONDS,
                    self._settings.CACHE_TTL_GTFS_SHAPES,
                )
                await asyncio.gather(
                    self._cache.expire(
                        self._trip_index_key(previous_generation, "meta"), grace_ttl
                    ),
                    self._cache.expire(
                        self._trip_index_key(previous_generation, "stops"), grace_ttl
                    ),
                    self._cache.expire(
                        self._trip_index_key(previous_generation, "shapes"), grace_ttl
                    ),
                )

        except Exception:
            # Publication already succeeded; stale keys retain a TTL and must
            # not make the usable GTFS refresh fail.
            logger.warning("Deferred GTFS trip-index cleanup did not complete")

    async def _cleanup_legacy_trip_indexes(self) -> None:
        """Reclaim v1 per-trip keys only after the full v2 snapshot commits."""
        try:
            for pattern in (
                f"{_KEY_TRIP_META_PREFIX}:*",
                f"{_KEY_TRIP_STOPS_PREFIX}:*",
                f"{_KEY_TRIP_SHAPE_PREFIX}:*",
            ):
                await self._cache.unlink_pattern(
                    pattern,
                    batch_size=_TRIP_INDEX_CLEANUP_BATCH_SIZE,
                )
        except Exception:
            logger.warning("Deferred legacy GTFS trip-index cleanup did not complete")

    @classmethod
    def _parse_calendar(
        cls,
        csv_data: str,
        allowed_service_ids: set[str] | None = None,
    ) -> list[dict]:
        if not csv_data:
            return []

        calendar = []
        for row in cls._iter_bounded_rows(
            csv_data,
            filename="calendar.txt",
            max_rows=_MAX_CALENDAR_ROWS,
        ):
            service_id = cls._bounded_text(row, "service_id", max_length=160)
            if not service_id or (
                allowed_service_ids is not None and service_id not in allowed_service_ids
            ):
                continue
            start_date = cls._bounded_text(row, "start_date", max_length=8)
            end_date = cls._bounded_text(row, "end_date", max_length=8)
            if not (start_date.isdigit() and end_date.isdigit()):
                continue
            calendar.append(
                {
                    "service_id": service_id,
                    "monday": int(row.get("monday", 0) or 0),
                    "tuesday": int(row.get("tuesday", 0) or 0),
                    "wednesday": int(row.get("wednesday", 0) or 0),
                    "thursday": int(row.get("thursday", 0) or 0),
                    "friday": int(row.get("friday", 0) or 0),
                    "saturday": int(row.get("saturday", 0) or 0),
                    "sunday": int(row.get("sunday", 0) or 0),
                    "start_date": start_date,
                    "end_date": end_date,
                }
            )

        return calendar

    @classmethod
    def _parse_calendar_dates(
        cls,
        csv_data: str,
        allowed_service_ids: set[str] | None = None,
    ) -> dict[str, dict[str, list[str]]]:
        """Group exceptions by date to avoid a million-row JSON document."""
        if not csv_data:
            return {}

        states_by_date: dict[str, dict[str, int]] = defaultdict(dict)
        for row in cls._iter_bounded_rows(
            csv_data,
            filename="calendar_dates.txt",
            max_rows=_MAX_CALENDAR_DATE_ROWS,
        ):
            service_id = cls._bounded_text(row, "service_id", max_length=160)
            date = cls._bounded_text(row, "date", max_length=8)
            if allowed_service_ids is not None and service_id not in allowed_service_ids:
                continue
            try:
                exception_type = int(row.get("exception_type", 1) or 1)
            except ValueError:
                continue
            if service_id and len(date) == 8 and date.isdigit() and exception_type in (1, 2):
                # Match the previous dict-comprehension semantics: a duplicate
                # (service, date) row is resolved by its final occurrence.
                states_by_date[date][service_id] = exception_type

        grouped_exceptions: dict[str, dict[str, list[str]]] = {}
        while states_by_date:
            date, service_states = states_by_date.popitem()
            grouped_exceptions[date] = {
                "added": sorted(
                    service_id
                    for service_id, exception_type in service_states.items()
                    if exception_type == 1
                ),
                "removed": sorted(
                    service_id
                    for service_id, exception_type in service_states.items()
                    if exception_type == 2
                ),
            }
        return grouped_exceptions

    async def _resolve_group_route_ids(self, route_id: str) -> list[str]:
        route_data = await self._cache.get_json(_KEY_ROUTES)
        if not route_data:
            return [route_id]

        for item in route_data:
            canonical_route_id = item.get("route_id")
            grouped_route_ids = item.get("route_ids") or []
            if route_id == canonical_route_id or route_id in grouped_route_ids:
                return (
                    grouped_route_ids or [canonical_route_id] if canonical_route_id else [route_id]
                )

        return [route_id]

    async def _trip_matches_route(
        self,
        route_id: str,
        trip_id: str,
        trip_meta: dict | None = None,
    ) -> bool:
        if trip_meta is None:
            trip_meta = await self.get_trip_meta(trip_id)
        if not trip_meta:
            return False

        route_ids = await self._resolve_group_route_ids(route_id)
        return trip_meta.get("route_id") in route_ids
