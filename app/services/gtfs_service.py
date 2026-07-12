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
import io
import math
import zipfile
from collections import defaultdict
from datetime import datetime, timezone

import httpx

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
_KEY_TRIPS_PREFIX = "gtfs:trips:route"
_KEY_TRIP_META_PREFIX = "gtfs:trip:meta"
_KEY_TRIP_STOPS_PREFIX = "gtfs:trip:stops"
_KEY_TRIP_SHAPE_PREFIX = "gtfs:trip:shape"
_KEY_PROXIMITY_INDEX = "gtfs:proximity:routes:v1"

_PROXIMITY_INDEX_VERSION = 1
_PROXIMITY_STOP_KEY_BATCH_SIZE = 500
_MAX_NEARBY_ROUTES = 40
_EARTH_RADIUS_METERS = 6_371_000.0

ProximityIndex = dict[str, list[list[float]]]


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
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=15.0, read=120.0, write=5.0, pool=10.0),
            limits=httpx.Limits(max_connections=3, max_keepalive_connections=1),
            headers={"User-Agent": "curl/8.20.0"},
            http2=True,
            follow_redirects=True,
        )
        logger.info("GTFS HTTP client initialized -> %s", self._gtfs_url)

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
        logger.info("Starting GTFS load from %s", self._gtfs_url)

        zip_bytes = await self._download_gtfs_zip()
        (
            shapes_data,
            routes_data,
            trips_data,
            stops_data,
            stop_times_data,
            calendar_data,
            calendar_dates_data,
        ) = self._extract_gtfs_files(zip_bytes)

        shapes_by_id = self._parse_shapes(shapes_data)
        routes_by_id = self._parse_routes(routes_data)
        bus_route_ids = {
            route_id
            for route_id, route in routes_by_id.items()
            if int(route.get("route_type", 3)) == 3
        }

        trip_rows = self._parse_trip_rows(trips_data, bus_route_ids)
        stops_by_id = self._parse_stops(stops_data)
        stop_times_by_trip = self._parse_stop_times(stop_times_data)
        trip_start_times = self._parse_first_stop_departures(stop_times_by_trip)

        route_to_shape, route_to_trip = self._build_representative_mappings(trip_rows)
        trip_meta_by_id, trip_stops_by_id, trip_shapes_by_id = self._build_trip_indexes(
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
        calendar = self._parse_calendar(calendar_data)
        calendar_dates = self._parse_calendar_dates(calendar_dates_data)

        await self._cache_shapes(route_shapes, deduped_routes)
        await self._cache_stops(route_to_trip, trip_stops_by_id)
        proximity_index = self._build_route_proximity_index(
            route_infos=deduped_routes,
            route_to_trip=route_to_trip,
            trip_stops_by_id=trip_stops_by_id,
        )
        await self._cache_route_proximity_index(proximity_index)
        await self._cache_calendar_and_trips(calendar, calendar_dates, trips_by_route_dir)
        await self._cache_trip_indexes(trip_meta_by_id, trip_stops_by_id, trip_shapes_by_id)

        logger.info(
            "GTFS load complete: %d route-direction shapes, %d trip indexes",
            len(route_shapes),
            len(trip_meta_by_id),
        )
        return len(route_shapes)

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
            if not await self._trip_matches_route(route_id, trip_id):
                return None
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
            if not await self._trip_matches_route(route_id, trip_id):
                return None
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
        return await self._cache.get_json(f"{_KEY_TRIP_META_PREFIX}:{trip_id}")

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
        grouped_trips: list[dict] = []
        for candidate_route_id in route_ids:
            trips_key = f"{_KEY_TRIPS_PREFIX}:{candidate_route_id}:{direction_id}"
            grouped_trips.extend(await self._cache.get_json(trips_key) or [])

        if not grouped_trips:
            return []

        calendar = await self._cache.get_json(_KEY_CALENDAR) or []
        calendar_dates = await self._cache.get_json(_KEY_CALENDAR_DATES) or []

        calendar_by_service = {c["service_id"]: c for c in calendar}
        exceptions_by_service_date = {
            (cd["service_id"], cd["date"]): cd["exception_type"]
            for cd in calendar_dates
        }

        try:
            query_dt = datetime.strptime(f"{date_str} {time_str}", "%Y%m%d %H:%M:%S")
            if local_tz:
                query_dt = query_dt.replace(tzinfo=local_tz)
        except Exception:
            query_dt = datetime.now(tz=local_tz) if local_tz else datetime.now()

        service_days = [query_dt - timedelta(days=1), query_dt, query_dt + timedelta(days=1)]
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

                exception_type = exceptions_by_service_date.get((service_id, service_date_str))
                is_active = False
                if exception_type == 1:
                    is_active = True
                elif exception_type == 2:
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

    async def _download_gtfs_zip(self) -> bytes:
        try:
            response = await self.http.get(self._gtfs_url)
            response.raise_for_status()
            return response.content
        except httpx.TimeoutException as exc:
            raise ExternalAPIError("ATM", "Timeout downloading GTFS ZIP") from exc
        except httpx.HTTPStatusError as exc:
            raise ExternalAPIError(
                "ATM",
                f"HTTP {exc.response.status_code} downloading GTFS ZIP",
            ) from exc
        except httpx.HTTPError as exc:
            raise ExternalAPIError("ATM", f"Connection error downloading GTFS ZIP: {exc}") from exc

    @staticmethod
    def _extract_gtfs_files(zip_bytes: bytes) -> tuple[str, str, str, str, str, str, str]:
        try:
            with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
                file_list = zf.namelist()
                required = ["shapes.txt", "routes.txt", "trips.txt", "stops.txt", "stop_times.txt"]
                missing = [file_name for file_name in required if file_name not in file_list]
                if missing:
                    raise GTFSParseError("gtfs.zip", f"Missing required files: {', '.join(missing)}")

                shapes_data = zf.read("shapes.txt").decode("utf-8-sig")
                routes_data = zf.read("routes.txt").decode("utf-8-sig")
                trips_data = zf.read("trips.txt").decode("utf-8-sig")
                stops_data = zf.read("stops.txt").decode("utf-8-sig")
                stop_times_data = zf.read("stop_times.txt").decode("utf-8-sig")
                calendar_data = zf.read("calendar.txt").decode("utf-8-sig") if "calendar.txt" in file_list else ""
                calendar_dates_data = (
                    zf.read("calendar_dates.txt").decode("utf-8-sig") if "calendar_dates.txt" in file_list else ""
                )

                return (
                    shapes_data,
                    routes_data,
                    trips_data,
                    stops_data,
                    stop_times_data,
                    calendar_data,
                    calendar_dates_data,
                )
        except zipfile.BadZipFile as exc:
            raise GTFSParseError("gtfs.zip", f"Invalid ZIP file: {exc}") from exc

    @staticmethod
    def _parse_shapes(csv_data: str) -> dict[str, list[dict]]:
        shapes: dict[str, list[dict]] = defaultdict(list)
        reader = csv.DictReader(io.StringIO(csv_data))

        for row in reader:
            shape_id = row.get("shape_id", "").strip()
            if not shape_id:
                continue

            shapes[shape_id].append(
                {
                    "lat": float(row.get("shape_pt_lat", 0) or 0),
                    "lon": float(row.get("shape_pt_lon", 0) or 0),
                    "sequence": int(row.get("shape_pt_sequence", 0) or 0),
                }
            )

        for shape_id in shapes:
            shapes[shape_id].sort(key=lambda point: point["sequence"])

        return dict(shapes)

    @staticmethod
    def _parse_routes(csv_data: str) -> dict[str, dict]:
        routes: dict[str, dict] = {}
        reader = csv.DictReader(io.StringIO(csv_data))

        for row in reader:
            route_id = row.get("route_id", "").strip()
            if not route_id:
                continue

            route_type_raw = row.get("route_type", "3").strip()
            try:
                route_type = int(route_type_raw)
            except ValueError:
                route_type = 3

            routes[route_id] = {
                "route_short_name": row.get("route_short_name", "").strip(),
                "route_long_name": row.get("route_long_name", "").strip(),
                "route_color": row.get("route_color", "").strip(),
                "route_text_color": row.get("route_text_color", "").strip(),
                "route_type": route_type,
                "agency_id": row.get("agency_id", "").strip(),
            }

        return routes

    @staticmethod
    def _parse_trip_rows(csv_data: str, bus_route_ids: set[str]) -> list[dict]:
        trip_rows: list[dict] = []
        reader = csv.DictReader(io.StringIO(csv_data))

        for row in reader:
            route_id = row.get("route_id", "").strip()
            trip_id = row.get("trip_id", "").strip()
            if not route_id or not trip_id or route_id not in bus_route_ids:
                continue

            direction_raw = row.get("direction_id", "0").strip()
            try:
                direction_id = int(direction_raw)
            except ValueError:
                direction_id = 0

            trip_rows.append(
                {
                    "route_id": route_id,
                    "direction_id": direction_id,
                    "trip_id": trip_id,
                    "service_id": row.get("service_id", "").strip(),
                    "trip_headsign": row.get("trip_headsign", "").strip(),
                    "shape_id": row.get("shape_id", "").strip(),
                }
            )

        return trip_rows

    @staticmethod
    def _parse_stops(csv_data: str) -> dict[str, dict]:
        stops: dict[str, dict] = {}
        reader = csv.DictReader(io.StringIO(csv_data))

        for row in reader:
            stop_id = row.get("stop_id", "").strip()
            if not stop_id:
                continue

            stops[stop_id] = {
                "lat": float(row.get("stop_lat", 0) or 0),
                "lon": float(row.get("stop_lon", 0) or 0),
                "name": row.get("stop_name", "").strip(),
            }

        return stops

    @staticmethod
    def _parse_stop_times(csv_data: str) -> dict[str, list[dict]]:
        trip_stops: dict[str, list[dict]] = defaultdict(list)
        reader = csv.DictReader(io.StringIO(csv_data))

        for row in reader:
            trip_id = row.get("trip_id", "").strip()
            if not trip_id:
                continue

            trip_stops[trip_id].append(
                {
                    "stop_id": row.get("stop_id", "").strip(),
                    "sequence": int(row.get("stop_sequence", 0) or 0),
                    "arrival_time": row.get("arrival_time", "").strip(),
                    "departure_time": row.get("departure_time", "").strip(),
                }
            )

        for trip_id in trip_stops:
            trip_stops[trip_id].sort(key=lambda stop: stop["sequence"])

        return dict(trip_stops)

    @staticmethod
    def _parse_first_stop_departures(stop_times_by_trip: dict[str, list[dict]]) -> dict[str, str]:
        first_departures: dict[str, str] = {}
        for trip_id, stops in stop_times_by_trip.items():
            if not stops:
                continue

            first = min(stops, key=lambda stop: stop["sequence"])
            departure = first.get("departure_time") or first.get("arrival_time")
            if departure:
                first_departures[trip_id] = departure

        return first_departures

    @staticmethod
    def _build_representative_mappings(trip_rows: list[dict]) -> tuple[dict[tuple[str, int], str], dict[tuple[str, int], str]]:
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
        stop_times_by_trip: dict[str, list[dict]],
        trip_start_times: dict[str, str],
    ) -> tuple[dict[str, dict], dict[str, dict], dict[str, dict]]:
        now_iso = datetime.now(tz=timezone.utc).isoformat()
        trip_meta_by_id: dict[str, dict] = {}
        trip_stops_by_id: dict[str, dict] = {}
        trip_shapes_by_id: dict[str, dict] = {}

        for trip in trip_rows:
            trip_id = trip["trip_id"]
            route_id = trip["route_id"]
            direction_id = trip["direction_id"]
            shape_id = trip.get("shape_id", "")
            route_info = routes_by_id.get(route_id, {})

            stop_rows = stop_times_by_trip.get(trip_id, [])
            stop_features: list[dict] = []
            origin_stop_name = ""
            destination_stop_name = ""
            origin_stop_id = ""
            destination_stop_id = ""

            if stop_rows:
                first = stop_rows[0]
                last = stop_rows[-1]
                origin_stop_id = first.get("stop_id", "")
                destination_stop_id = last.get("stop_id", "")
                origin_stop_name = stops_by_id.get(origin_stop_id, {}).get("name", "")
                destination_stop_name = stops_by_id.get(destination_stop_id, {}).get("name", "")

            for stop in stop_rows:
                stop_id = stop.get("stop_id", "")
                stop_info = stops_by_id.get(stop_id)
                if not stop_info:
                    continue

                stop_features.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "route_id": route_id,
                            "direction_id": direction_id,
                            "trip_id": trip_id,
                            "stop_id": stop_id,
                            "stop_sequence": stop.get("sequence", 0),
                            "stop_name": stop_info.get("name", ""),
                        },
                        "geometry": {
                            "type": "Point",
                            "coordinates": [stop_info.get("lon", 0), stop_info.get("lat", 0)],
                        },
                    }
                )

            destination_name = trip.get("trip_headsign") or destination_stop_name
            trip_meta = {
                "trip_id": trip_id,
                "route_id": route_id,
                "direction_id": direction_id,
                "service_id": trip.get("service_id", ""),
                "trip_headsign": trip.get("trip_headsign", ""),
                "shape_id": shape_id,
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

            trip_stops_by_id[trip_id] = {
                "type": "FeatureCollection",
                "features": stop_features,
                "route_id": route_id,
                "direction_id": direction_id,
                "trip_id": trip_id,
                "stop_count": len(stop_features),
                "last_updated": now_iso,
            }

            if shape_id in shapes_by_id:
                points = shapes_by_id[shape_id]
                coordinates = [[point["lon"], point["lat"]] for point in points]
                geojson_feature = {
                    "type": "Feature",
                    "properties": {
                        "route_id": route_id,
                        "direction_id": direction_id,
                        "shape_id": shape_id,
                        "trip_id": trip_id,
                        "route_short_name": route_info.get("route_short_name", ""),
                        "route_long_name": route_info.get("route_long_name", ""),
                        "route_color": route_info.get("route_color", ""),
                        "route_text_color": route_info.get("route_text_color", ""),
                        "route_type": int(route_info.get("route_type", 3)),
                        "destination_name": destination_name,
                        "towards_label": self._towards_label(destination_name),
                    },
                    "geometry": {
                        "type": "LineString",
                        "coordinates": coordinates,
                    },
                }

                trip_shapes_by_id[trip_id] = RouteShape(
                    route_id=route_id,
                    shape_id=shape_id,
                    route_short_name=route_info.get("route_short_name", ""),
                    route_long_name=route_info.get("route_long_name", ""),
                    route_color=route_info.get("route_color", ""),
                    route_text_color=route_info.get("route_text_color", ""),
                    route_type=int(route_info.get("route_type", 3)),
                    direction_id=direction_id,
                    trip_id=trip_id,
                    destination_name=destination_name,
                    towards_label=self._towards_label(destination_name),
                    geojson=geojson_feature,
                ).model_dump(mode="json")

        return trip_meta_by_id, trip_stops_by_id, trip_shapes_by_id

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

    def _build_deduplicated_routes(self, routes_by_id: dict[str, dict], trip_meta_by_id: dict[str, dict]) -> list[dict]:
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
                        f"{canonical.get('route_short_name', '').strip()} {canonical.get('route_long_name', '').strip()}"
                    ).strip(),
                ).model_dump(mode="json")
            )

        route_infos.sort(key=lambda route: (route.get("route_short_name") or "", route.get("route_id") or ""))
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
                raw_route.model_dump(mode="json")
                if isinstance(raw_route, RouteInfo)
                else raw_route
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

            proximity_index = await self._build_route_proximity_index_from_cached_stops(
                route_infos
            )
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
        now_iso = datetime.now(tz=timezone.utc).isoformat()

        feature_collection = GTFSShapesResponse(
            type="FeatureCollection",
            features=[route_shape.geojson for route_shape in route_shapes],
            route_count=len(route_shapes),
            last_updated=now_iso,
        )

        await self._cache.set_json(_KEY_ALL_SHAPES, feature_collection.model_dump(mode="json"), ttl=ttl)
        await self._cache.set_json(_KEY_ROUTES, route_infos, ttl=ttl)
        await self._cache.set(_KEY_LAST_UPDATED, now_iso, ttl=ttl)

        individual_mapping: dict[str, dict] = {}
        for route_shape in route_shapes:
            direction_id = route_shape.direction_id if route_shape.direction_id is not None else 0
            individual_mapping[
                f"{_KEY_SHAPE_PREFIX}:{route_shape.route_id}:{direction_id}"
            ] = route_shape.model_dump(mode="json")
            if direction_id == 0:
                individual_mapping[f"{_KEY_SHAPE_PREFIX}:{route_shape.route_id}"] = route_shape.model_dump(mode="json")

        if individual_mapping:
            await self._cache.mset_json(individual_mapping, ttl=ttl)

    async def _cache_stops(self, route_to_trip: dict[tuple[str, int], str], trip_stops_by_id: dict[str, dict]) -> None:
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
        calendar_dates: list[dict],
        trips_by_route_dir: dict[tuple[str, int], list[dict]],
    ) -> None:
        ttl = self._settings.CACHE_TTL_GTFS_SHAPES
        await self._cache.set_json(_KEY_CALENDAR, calendar, ttl=ttl)
        await self._cache.set_json(_KEY_CALENDAR_DATES, calendar_dates, ttl=ttl)

        mapping = {
            f"{_KEY_TRIPS_PREFIX}:{route_id}:{direction_id}": trips
            for (route_id, direction_id), trips in trips_by_route_dir.items()
        }
        if mapping:
            await self._cache.mset_json(mapping, ttl=ttl)

    async def _cache_trip_indexes(
        self,
        trip_meta_by_id: dict[str, dict],
        trip_stops_by_id: dict[str, dict],
        trip_shapes_by_id: dict[str, dict],
    ) -> None:
        ttl = self._settings.CACHE_TTL_GTFS_SHAPES

        meta_mapping = {
            f"{_KEY_TRIP_META_PREFIX}:{trip_id}": meta
            for trip_id, meta in trip_meta_by_id.items()
        }
        if meta_mapping:
            await self._cache.mset_json(meta_mapping, ttl=ttl)

        stop_mapping = {
            f"{_KEY_TRIP_STOPS_PREFIX}:{trip_id}": stops
            for trip_id, stops in trip_stops_by_id.items()
        }
        if stop_mapping:
            await self._cache.mset_json(stop_mapping, ttl=ttl)

        shape_mapping = {
            f"{_KEY_TRIP_SHAPE_PREFIX}:{trip_id}": shape
            for trip_id, shape in trip_shapes_by_id.items()
        }
        if shape_mapping:
            await self._cache.mset_json(shape_mapping, ttl=ttl)

    @staticmethod
    def _parse_calendar(csv_data: str) -> list[dict]:
        if not csv_data:
            return []

        calendar = []
        reader = csv.DictReader(io.StringIO(csv_data))
        for row in reader:
            calendar.append(
                {
                    "service_id": row.get("service_id", "").strip(),
                    "monday": int(row.get("monday", 0) or 0),
                    "tuesday": int(row.get("tuesday", 0) or 0),
                    "wednesday": int(row.get("wednesday", 0) or 0),
                    "thursday": int(row.get("thursday", 0) or 0),
                    "friday": int(row.get("friday", 0) or 0),
                    "saturday": int(row.get("saturday", 0) or 0),
                    "sunday": int(row.get("sunday", 0) or 0),
                    "start_date": row.get("start_date", "").strip(),
                    "end_date": row.get("end_date", "").strip(),
                }
            )

        return calendar

    @staticmethod
    def _parse_calendar_dates(csv_data: str) -> list[dict]:
        if not csv_data:
            return []

        calendar_dates = []
        reader = csv.DictReader(io.StringIO(csv_data))
        for row in reader:
            calendar_dates.append(
                {
                    "service_id": row.get("service_id", "").strip(),
                    "date": row.get("date", "").strip(),
                    "exception_type": int(row.get("exception_type", 1) or 1),
                }
            )

        return calendar_dates

    async def _resolve_group_route_ids(self, route_id: str) -> list[str]:
        route_data = await self._cache.get_json(_KEY_ROUTES)
        if not route_data:
            return [route_id]

        for item in route_data:
            canonical_route_id = item.get("route_id")
            grouped_route_ids = item.get("route_ids") or []
            if route_id == canonical_route_id or route_id in grouped_route_ids:
                return grouped_route_ids or [canonical_route_id] if canonical_route_id else [route_id]

        return [route_id]

    async def _trip_matches_route(self, route_id: str, trip_id: str) -> bool:
        trip_meta = await self.get_trip_meta(trip_id)
        if not trip_meta:
            return False

        route_ids = await self._resolve_group_route_ids(route_id)
        return trip_meta.get("route_id") in route_ids
