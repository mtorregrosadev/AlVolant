"""
Pydantic models for ATM GTFS-Realtime data.

These models represent the normalized entities extracted from the ATM
Protocol Buffer feeds (TripUpdates, VehiclePositions, Alerts). The BFF
parses the binary feeds and stores these lightweight JSON-serializable
models in Redis for fast retrieval by the tablet clients.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Alert enums
# ---------------------------------------------------------------------------

class AlertCause(StrEnum):
    """GTFS-RT alert cause categories."""
    UNKNOWN_CAUSE = "UNKNOWN_CAUSE"
    TECHNICAL_PROBLEM = "TECHNICAL_PROBLEM"
    STRIKE = "STRIKE"
    DEMONSTRATION = "DEMONSTRATION"
    ACCIDENT = "ACCIDENT"
    HOLIDAY = "HOLIDAY"
    WEATHER = "WEATHER"
    MAINTENANCE = "MAINTENANCE"
    CONSTRUCTION = "CONSTRUCTION"
    POLICE_ACTIVITY = "POLICE_ACTIVITY"
    MEDICAL_EMERGENCY = "MEDICAL_EMERGENCY"
    OTHER_CAUSE = "OTHER_CAUSE"


class AlertEffect(StrEnum):
    """GTFS-RT alert effect categories."""
    NO_SERVICE = "NO_SERVICE"
    REDUCED_SERVICE = "REDUCED_SERVICE"
    SIGNIFICANT_DELAYS = "SIGNIFICANT_DELAYS"
    DETOUR = "DETOUR"
    ADDITIONAL_SERVICE = "ADDITIONAL_SERVICE"
    MODIFIED_SERVICE = "MODIFIED_SERVICE"
    OTHER_EFFECT = "OTHER_EFFECT"
    UNKNOWN_EFFECT = "UNKNOWN_EFFECT"
    STOP_MOVED = "STOP_MOVED"
    NO_EFFECT = "NO_EFFECT"
    ACCESSIBILITY_ISSUE = "ACCESSIBILITY_ISSUE"


class VehiclePosition(BaseModel):
    """Real-time position of a transit vehicle."""

    vehicle_id: str = Field(..., description="Unique vehicle identifier")
    route_id: str = Field("", description="GTFS route_id")
    trip_id: str = Field("", description="GTFS trip_id")
    latitude: float = Field(..., description="WGS-84 latitude")
    longitude: float = Field(..., description="WGS-84 longitude")
    bearing: float | None = Field(None, description="Heading in degrees (0–360)")
    speed: float | None = Field(None, description="Speed in m/s")
    timestamp: int = Field(0, description="POSIX timestamp of the position report")


class StopTimeUpdate(BaseModel):
    """Predicted arrival/departure at a single stop within a trip."""

    stop_id: str = Field(..., description="GTFS stop_id")
    stop_sequence: int = Field(0, description="Order of this stop in the trip")
    arrival_delay: int = Field(
        0,
        description="Delay in seconds relative to the schedule (positive = late)",
    )
    departure_delay: int = Field(0, description="Departure delay in seconds")


class TripUpdate(BaseModel):
    """Real-time update for a single trip."""

    trip_id: str = Field(..., description="GTFS trip_id")
    route_id: str = Field("", description="GTFS route_id")
    vehicle_id: str = Field("", description="Vehicle serving this trip")
    start_date: str = Field("", description="Service date (YYYYMMDD)")
    stop_time_updates: list[StopTimeUpdate] = Field(
        default_factory=list,
        description="Per-stop arrival/departure predictions",
    )
    timestamp: int = Field(0, description="POSIX timestamp of the update")


class ServiceAlert(BaseModel):
    """A service alert/incident from the GTFS-RT feed.

    Text fields are pre-filtered to Catalan (``ca`` or ``cat``) when available.
    Timestamps are normalized to ISO 8601 strings.
    """

    alert_id: str = Field(..., description="Unique alert identifier from the feed")
    header_text: str = Field("", description="Alert title (Catalan preferred)")
    description_text: str = Field("", description="Alert body (Catalan preferred)")
    cause: str = Field(AlertCause.UNKNOWN_CAUSE, description="GTFS-RT alert cause")
    effect: str = Field(AlertEffect.UNKNOWN_EFFECT, description="GTFS-RT alert effect")
    url: str = Field("", description="More-info URL (Catalan preferred)")
    active_period_start: str | None = Field(
        None,
        description="ISO 8601 start of the alert's active period",
    )
    active_period_end: str | None = Field(
        None,
        description="ISO 8601 end of the alert's active period",
    )
    affected_route_ids: list[str] = Field(
        default_factory=list,
        description="List of GTFS route_ids affected by this alert",
    )
    affected_stop_ids: list[str] = Field(
        default_factory=list,
        description="List of GTFS stop_ids affected by this alert",
    )


class ATMRealtimeFeed(BaseModel):
    """Complete parsed ATM GTFS-RT feed snapshot containing data from all feeds."""

    feed_timestamp: datetime = Field(
        default_factory=datetime.utcnow,
        description="UTC time when the feeds were fetched and parsed",
    )
    vehicle_positions: list[VehiclePosition] = Field(default_factory=list)
    trip_updates: list[TripUpdate] = Field(default_factory=list)
    service_alerts: list[ServiceAlert] = Field(default_factory=list)
    entity_count: int = Field(0, description="Total number of entities stored")
