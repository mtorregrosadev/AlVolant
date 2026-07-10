"""
Pydantic models for static GTFS data (ATM T-mobilitat).

These models represent the processed shapes and route metadata extracted
from the static GTFS ZIP file.  Shapes are stored as GeoJSON-compatible
structures so the tablet frontend can render them directly on a map
(Leaflet / MapLibre GL) without any client-side conversion.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ShapePoint(BaseModel):
    """A single point in a GTFS shape polyline."""

    latitude: float = Field(..., description="WGS-84 latitude")
    longitude: float = Field(..., description="WGS-84 longitude")
    sequence: int = Field(..., description="Order of this point in the shape")
    dist_traveled: float = Field(
        0.0,
        description="Cumulative distance traveled along the shape (meters)",
    )


class RouteShape(BaseModel):
    """GeoJSON-compatible shape for a single transit route.

    The ``coordinates`` field is a list of ``[longitude, latitude]`` pairs
    following the GeoJSON convention (lon before lat).
    """

    route_id: str = Field(..., description="GTFS route_id")
    shape_id: str = Field(..., description="GTFS shape_id")
    route_short_name: str = Field("", description="Short name (e.g. 'H6')")
    route_long_name: str = Field("", description="Full route name")
    route_color: str = Field("", description="Hex color code (e.g. 'FF0000')")
    route_text_color: str = Field("", description="Text color for contrast")
    route_type: int = Field(
        3,
        description="GTFS route type (3 = bus)",
    )
    direction_id: int | None = Field(None, description="GTFS direction_id")
    trip_id: str | None = Field(None, description="GTFS trip_id used to resolve this shape")
    destination_name: str = Field("", description="Destination for this route direction")
    towards_label: str = Field("", description="Human-readable direction label")
    geojson: dict = Field(
        default_factory=dict,
        description="GeoJSON LineString Feature for this route shape",
    )


class DirectionInfo(BaseModel):
    """Direction metadata derived from representative GTFS trips."""

    direction_id: int = Field(..., description="GTFS direction_id")
    destination_name: str = Field("", description="Destination stop/headsign")
    label: str = Field("", description="Rendered direction label")


class RouteInfo(BaseModel):
    """Lightweight route metadata (without geometry) for listing endpoints."""

    route_id: str
    route_short_name: str = ""
    route_long_name: str = ""
    route_color: str = ""
    route_text_color: str = ""
    route_type: int = 3
    agency_id: str = ""
    route_ids: list[str] = Field(
        default_factory=list,
        description="Merged GTFS route_ids for this route_short_name",
    )
    direction_destinations: list[DirectionInfo] = Field(
        default_factory=list,
        description="Dynamic direction labels for tabs/headers",
    )
    display_name: str = Field("", description="Combined route display name")


class GTFSShapesResponse(BaseModel):
    """Response containing all route shapes as a GeoJSON FeatureCollection."""

    type: str = Field("FeatureCollection", description="GeoJSON type")
    features: list[dict] = Field(
        default_factory=list,
        description="List of GeoJSON Feature objects (LineString per route)",
    )
    route_count: int = Field(0, description="Total number of routes included")
    last_updated: str = Field("", description="ISO timestamp of last GTFS refresh")

class RouteStopsResponse(BaseModel):
    """Response containing all stops for a specific route as a GeoJSON FeatureCollection."""

    type: str = Field("FeatureCollection", description="GeoJSON type")
    features: list[dict] = Field(
        default_factory=list,
        description="List of GeoJSON Feature objects (Point per stop)",
    )
    route_id: str = Field("", description="GTFS route_id")
    direction_id: int | None = Field(None, description="GTFS direction_id")
    stop_count: int = Field(0, description="Total number of stops included")
    last_updated: str = Field("", description="ISO timestamp of last GTFS refresh")
