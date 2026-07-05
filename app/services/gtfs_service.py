"""
ATM T-mobilitat static GTFS service.

Downloads the static GTFS ZIP from the T-mobilitat Open Data portal and
extracts route shapes (``shapes.txt``), route metadata (``routes.txt``),
and trip→shape mappings (``trips.txt``).

The processed shapes are stored in Redis as GeoJSON LineString features
so the tablet frontend can render route polylines directly on the map
without any client-side conversion.

Shapes are refreshed daily (configurable via ``ATM_GTFS_REFRESH_HOURS``).
"""

from __future__ import annotations

import csv
import io
import zipfile
from collections import defaultdict
from datetime import datetime, timezone

import httpx

from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.core.exceptions import ExternalAPIError, GTFSParseError
from app.core.logging import get_logger
from app.models.gtfs import GTFSShapesResponse, RouteInfo, RouteShape

logger = get_logger(__name__)

# Redis key namespaces
_KEY_ALL_SHAPES = "gtfs:shapes:all"
_KEY_SHAPE_PREFIX = "gtfs:shapes:route"
_KEY_ROUTES = "gtfs:routes:all"
_KEY_LAST_UPDATED = "gtfs:meta:last_updated"


class GTFSService:
    """Loader and cache writer for ATM T-mobilitat static GTFS data.

    Args:
        settings: Application settings (injected).
        cache: Redis cache manager (injected).
    """

    def __init__(self, settings: Settings, cache: CacheManager) -> None:
        self._settings = settings
        self._cache = cache
        self._gtfs_url = settings.ATM_GTFS_URL
        self._http: httpx.AsyncClient | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Initialize the HTTP client for GTFS downloads."""
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=15.0, read=120.0, write=5.0, pool=10.0),
            limits=httpx.Limits(max_connections=3, max_keepalive_connections=1),
            headers={"User-Agent": "curl/8.20.0"},
            http2=True,
            follow_redirects=True,
        )
        logger.info("GTFS HTTP client initialized → %s", self._gtfs_url)

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

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def load_and_cache_shapes(self) -> int:
        """Download the GTFS ZIP, parse shapes, and cache as GeoJSON.

        This is intended to be called:
        - Once on application startup
        - Periodically (daily) by a refresh task

        Returns:
            Number of route shapes loaded and cached.

        Raises:
            ExternalAPIError: If the download fails.
            GTFSParseError: If required GTFS files are missing or malformed.
        """
        logger.info("Starting GTFS shapes load from %s", self._gtfs_url)

        zip_bytes = await self._download_gtfs_zip()
        shapes_data, routes_data, trips_data = self._extract_gtfs_files(zip_bytes)

        # Parse CSV files
        shapes_by_id = self._parse_shapes(shapes_data)
        routes_by_id = self._parse_routes(routes_data)
        route_to_shape = self._parse_trips_mapping(trips_data)

        # Build GeoJSON features per route
        route_shapes: list[RouteShape] = []
        for route_id, shape_id in route_to_shape.items():
            if shape_id not in shapes_by_id:
                continue

            route_info = routes_by_id.get(route_id, {})
            points = shapes_by_id[shape_id]

            # GeoJSON coordinates: [longitude, latitude] per spec
            coordinates = [[p["lon"], p["lat"]] for p in points]

            geojson_feature = {
                "type": "Feature",
                "properties": {
                    "route_id": route_id,
                    "shape_id": shape_id,
                    "route_short_name": route_info.get("route_short_name", ""),
                    "route_long_name": route_info.get("route_long_name", ""),
                    "route_color": route_info.get("route_color", ""),
                    "route_text_color": route_info.get("route_text_color", ""),
                    "route_type": int(route_info.get("route_type", 3)),
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
                    geojson=geojson_feature,
                )
            )

        # Cache everything
        await self._cache_shapes(route_shapes, routes_by_id)

        logger.info("GTFS shapes loaded: %d routes cached", len(route_shapes))
        return len(route_shapes)

    async def get_all_shapes(self) -> GTFSShapesResponse | None:
        """Retrieve all route shapes from cache as a GeoJSON FeatureCollection.

        Returns:
            GeoJSON FeatureCollection or ``None`` if not loaded yet.
        """
        data = await self._cache.get_json(_KEY_ALL_SHAPES)
        if data is None:
            return None
        return GTFSShapesResponse(**data)

    async def get_route_shape(self, route_id: str) -> RouteShape | None:
        """Retrieve the shape for a single route from cache.

        Args:
            route_id: GTFS route_id.

        Returns:
            Route shape with GeoJSON geometry, or ``None``.
        """
        data = await self._cache.get_json(f"{_KEY_SHAPE_PREFIX}:{route_id}")
        if data is None:
            return None
        return RouteShape(**data)

    async def get_all_routes(self) -> list[RouteInfo]:
        """Retrieve route metadata (without geometry) from cache.

        Returns:
            List of route info objects.
        """
        data = await self._cache.get_json(_KEY_ROUTES)
        if data is None:
            return []
        return [RouteInfo(**r) for r in data]

    # ------------------------------------------------------------------
    # Private — Download
    # ------------------------------------------------------------------

    async def _download_gtfs_zip(self) -> bytes:
        """Download the GTFS ZIP file.

        Returns:
            Raw ZIP bytes.

        Raises:
            ExternalAPIError: On network/HTTP errors.
        """
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
            raise ExternalAPIError(
                "ATM",
                f"Connection error downloading GTFS ZIP: {exc}",
            ) from exc

    # ------------------------------------------------------------------
    # Private — ZIP Extraction
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_gtfs_files(zip_bytes: bytes) -> tuple[str, str, str]:
        """Extract shapes.txt, routes.txt, and trips.txt from the ZIP.

        Args:
            zip_bytes: Raw ZIP file content.

        Returns:
            Tuple of (shapes_csv, routes_csv, trips_csv) as strings.

        Raises:
            GTFSParseError: If required files are missing.
        """
        try:
            with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
                file_list = zf.namelist()
                logger.debug("GTFS ZIP contents: %s", file_list)

                required = ["shapes.txt", "routes.txt", "trips.txt"]
                missing = [f for f in required if f not in file_list]
                if missing:
                    raise GTFSParseError(
                        "gtfs.zip",
                        f"Missing required files: {', '.join(missing)}",
                    )

                shapes_data = zf.read("shapes.txt").decode("utf-8-sig")
                routes_data = zf.read("routes.txt").decode("utf-8-sig")
                trips_data = zf.read("trips.txt").decode("utf-8-sig")

                return shapes_data, routes_data, trips_data
        except zipfile.BadZipFile as exc:
            raise GTFSParseError("gtfs.zip", f"Invalid ZIP file: {exc}") from exc

    # ------------------------------------------------------------------
    # Private — CSV Parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_shapes(csv_data: str) -> dict[str, list[dict]]:
        """Parse shapes.txt into a dict of shape_id → sorted points.

        Args:
            csv_data: Contents of shapes.txt.

        Returns:
            Dict mapping shape_id to a list of point dicts sorted by sequence.
        """
        shapes: dict[str, list[dict]] = defaultdict(list)
        reader = csv.DictReader(io.StringIO(csv_data))

        for row in reader:
            shape_id = row.get("shape_id", "").strip()
            if not shape_id:
                continue
            shapes[shape_id].append(
                {
                    "lat": float(row.get("shape_pt_lat", 0)),
                    "lon": float(row.get("shape_pt_lon", 0)),
                    "sequence": int(row.get("shape_pt_sequence", 0)),
                    "dist": float(row.get("shape_dist_traveled", 0) or 0),
                }
            )

        # Sort each shape's points by sequence
        for shape_id in shapes:
            shapes[shape_id].sort(key=lambda p: p["sequence"])

        logger.debug("Parsed %d shapes from shapes.txt", len(shapes))
        return dict(shapes)

    @staticmethod
    def _parse_routes(csv_data: str) -> dict[str, dict]:
        """Parse routes.txt into a dict of route_id → route metadata.

        Args:
            csv_data: Contents of routes.txt.

        Returns:
            Dict mapping route_id to route metadata dicts.
        """
        routes: dict[str, dict] = {}
        reader = csv.DictReader(io.StringIO(csv_data))

        for row in reader:
            route_id = row.get("route_id", "").strip()
            if not route_id:
                continue
            routes[route_id] = {
                "route_short_name": row.get("route_short_name", "").strip(),
                "route_long_name": row.get("route_long_name", "").strip(),
                "route_color": row.get("route_color", "").strip(),
                "route_text_color": row.get("route_text_color", "").strip(),
                "route_type": row.get("route_type", "3").strip(),
                "agency_id": row.get("agency_id", "").strip(),
            }

        logger.debug("Parsed %d routes from routes.txt", len(routes))
        return routes

    @staticmethod
    def _parse_trips_mapping(csv_data: str) -> dict[str, str]:
        """Parse trips.txt to extract route_id → shape_id mapping.

        When multiple trips map a route to different shapes, we keep the
        first occurrence.  The T-mobilitat "simplified" dataset should
        already have deduplicated these.

        Args:
            csv_data: Contents of trips.txt.

        Returns:
            Dict mapping route_id to its shape_id.
        """
        route_to_shape: dict[str, str] = {}
        reader = csv.DictReader(io.StringIO(csv_data))

        for row in reader:
            route_id = row.get("route_id", "").strip()
            shape_id = row.get("shape_id", "").strip()
            if route_id and shape_id and route_id not in route_to_shape:
                route_to_shape[route_id] = shape_id

        logger.debug("Mapped %d routes to shapes from trips.txt", len(route_to_shape))
        return route_to_shape

    # ------------------------------------------------------------------
    # Private — Caching
    # ------------------------------------------------------------------

    async def _cache_shapes(
        self,
        route_shapes: list[RouteShape],
        routes_metadata: dict[str, dict],
    ) -> None:
        """Write processed shapes and route metadata to Redis.

        Caches:
        - Individual route shapes: ``gtfs:shapes:route:{route_id}``
        - All shapes as FeatureCollection: ``gtfs:shapes:all``
        - Route metadata list: ``gtfs:routes:all``
        - Last update timestamp: ``gtfs:meta:last_updated``

        Args:
            route_shapes: List of processed route shapes.
            routes_metadata: Raw route metadata dict.
        """
        ttl = self._settings.CACHE_TTL_GTFS_SHAPES
        now_iso = datetime.now(tz=timezone.utc).isoformat()

        # Build the FeatureCollection
        feature_collection = GTFSShapesResponse(
            type="FeatureCollection",
            features=[rs.geojson for rs in route_shapes],
            route_count=len(route_shapes),
            last_updated=now_iso,
        )

        # Cache the full FeatureCollection
        await self._cache.set_json(
            _KEY_ALL_SHAPES,
            feature_collection.model_dump(mode="json"),
            ttl=ttl,
        )

        # Cache individual route shapes (pipeline for speed)
        individual_mapping: dict[str, dict] = {}
        for rs in route_shapes:
            individual_mapping[f"{_KEY_SHAPE_PREFIX}:{rs.route_id}"] = rs.model_dump(
                mode="json"
            )
        if individual_mapping:
            await self._cache.mset_json(individual_mapping, ttl=ttl)

        # Cache route metadata list
        route_infos = [
            RouteInfo(
                route_id=rid,
                route_short_name=rdata.get("route_short_name", ""),
                route_long_name=rdata.get("route_long_name", ""),
                route_color=rdata.get("route_color", ""),
                route_text_color=rdata.get("route_text_color", ""),
                route_type=int(rdata.get("route_type", 3)),
                agency_id=rdata.get("agency_id", ""),
            ).model_dump(mode="json")
            for rid, rdata in routes_metadata.items()
        ]
        await self._cache.set_json(_KEY_ROUTES, route_infos, ttl=ttl)

        # Store timestamp
        await self._cache.set(_KEY_LAST_UPDATED, now_iso, ttl=ttl)

        logger.info(
            "Cached %d route shapes + %d route metadata entries (TTL=%ds)",
            len(route_shapes),
            len(route_infos),
            ttl,
        )
