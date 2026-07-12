"""
Pydantic models for ATM GTFS-Realtime data.

These models represent the normalized entities extracted from the ATM
Protocol Buffer feeds (TripUpdates, VehiclePositions, Alerts). The BFF
parses the binary feeds and stores these lightweight JSON-serializable
models in Redis for fast retrieval by the tablet clients.

Enhanced with rich alert classification to support:
- Detour descriptions with alternative stops
- Per-stop cancellation status
- Alert type classification (DETOUR, STOP_CANCELLATION, SCHEDULE_INFO)
"""

from __future__ import annotations

from datetime import UTC, datetime
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


class AlertType(StrEnum):
    """High-level classification of what the alert represents.

    Derived from the GTFS-RT ``effect`` field and description text analysis.
    This simplifies frontend rendering: the tablet can show different UI
    treatments for detours vs. stop cancellations vs. informational notices.
    """

    DETOUR = "DETOUR"
    STOP_CANCELLATION = "STOP_CANCELLATION"
    SCHEDULE_INFO = "SCHEDULE_INFO"
    SERVICE_CHANGE = "SERVICE_CHANGE"
    GENERAL_INFO = "GENERAL_INFO"


class StopStatus(StrEnum):
    """Operational status of a stop within a route context.

    Used in ``AffectedStopDetail`` to indicate whether a stop is
    temporarily canceled, moved, or has been added as a replacement.
    """

    ACTIVE = "ACTIVE"
    TEMPORARILY_CANCELED = "TEMPORARILY_CANCELED"
    MOVED = "MOVED"
    ADDED = "ADDED"


class AlertSeverity(StrEnum):
    """Alert severity level for UI prioritization."""

    INFO = "INFO"
    WARNING = "WARNING"
    SEVERE = "SEVERE"


# ---------------------------------------------------------------------------
# Sub-models for enriched alerts
# ---------------------------------------------------------------------------


class AffectedStopDetail(BaseModel):
    """Detailed status of a single stop affected by an alert.

    When a stop is temporarily canceled due to construction or a detour,
    this model captures its status and the reason for the disruption.
    """

    stop_id: str = Field(..., max_length=160, description="GTFS stop_id (with AMB_ prefix)")
    stop_name: str = Field("", max_length=300, description="Human-readable stop name")
    status: StopStatus = Field(
        StopStatus.TEMPORARILY_CANCELED,
        description="Current operational status of this stop",
    )
    reason: str = Field(
        "",
        max_length=1_000,
        description="Brief explanation of why the stop is affected",
    )


class AlternativeStop(BaseModel):
    """A replacement stop offered when the regular stop is canceled.

    Maps a canceled stop to its temporary replacement so the driver
    can navigate to the correct alternative location.
    """

    stop_id: str = Field(..., max_length=160, description="GTFS stop_id of the alternative stop")
    stop_name: str = Field("", max_length=300, description="Human-readable name of the alternative")
    replaces_stop_id: str = Field(
        "",
        max_length=160,
        description="GTFS stop_id of the canceled stop this replaces",
    )


# ---------------------------------------------------------------------------
# Core GTFS-RT models
# ---------------------------------------------------------------------------


class VehiclePosition(BaseModel):
    """Real-time position of a transit vehicle."""

    vehicle_id: str = Field(..., max_length=160, description="Unique vehicle identifier")
    route_id: str = Field("", max_length=160, description="GTFS route_id")
    trip_id: str = Field("", max_length=160, description="GTFS trip_id")
    latitude: float = Field(..., ge=-90, le=90, allow_inf_nan=False, description="WGS-84 latitude")
    longitude: float = Field(
        ...,
        ge=-180,
        le=180,
        allow_inf_nan=False,
        description="WGS-84 longitude",
    )
    bearing: float | None = Field(
        None,
        ge=0,
        lt=360,
        allow_inf_nan=False,
        description="Heading in degrees (0–360)",
    )
    speed: float | None = Field(
        None,
        ge=0,
        le=100,
        allow_inf_nan=False,
        description="Speed in m/s",
    )
    timestamp: int = Field(0, ge=0, le=10_000_000_000, description="POSIX report timestamp")


class StopTimeUpdate(BaseModel):
    """Predicted arrival/departure at a single stop within a trip."""

    stop_id: str = Field(..., max_length=160, description="GTFS stop_id")
    stop_sequence: int = Field(0, ge=0, le=10_000, description="Order of this stop in the trip")
    arrival_delay: int = Field(
        0,
        ge=-86_400,
        le=604_800,
        description="Delay in seconds relative to the schedule (positive = late)",
    )
    departure_delay: int = Field(
        0,
        ge=-86_400,
        le=604_800,
        description="Departure delay in seconds",
    )


class TripUpdate(BaseModel):
    """Real-time update for a single trip."""

    trip_id: str = Field(..., max_length=160, description="GTFS trip_id")
    route_id: str = Field("", max_length=160, description="GTFS route_id")
    vehicle_id: str = Field("", max_length=160, description="Vehicle serving this trip")
    start_date: str = Field("", max_length=8, description="Service date (YYYYMMDD)")
    stop_time_updates: list[StopTimeUpdate] = Field(
        default_factory=list,
        max_length=500,
        description="Per-stop arrival/departure predictions",
    )
    timestamp: int = Field(0, ge=0, le=10_000_000_000, description="POSIX update timestamp")


class ServiceAlert(BaseModel):
    """A service alert/incident from the GTFS-RT feed.

    Text fields are pre-filtered to Catalan (``ca`` or ``cat``) when available.
    Timestamps are normalized to ISO 8601 strings.

    Enhanced with classification fields for rich driver-facing UI:
    - ``alert_type``: High-level classification (DETOUR, STOP_CANCELLATION, etc.)
    - ``severity``: UI prioritization level
    - ``affected_stop_details``: Per-stop status with reasons
    - ``alternative_stops``: Replacement stops for canceled ones
    - ``detour_description``: Human-readable detour path
    """

    alert_id: str = Field(..., max_length=160, description="Unique alert identifier from the feed")
    header_text: str = Field("", max_length=1_000, description="Alert title (Catalan preferred)")
    description_text: str = Field(
        "",
        max_length=10_000,
        description="Alert body (Catalan preferred)",
    )
    cause: str = Field(AlertCause.UNKNOWN_CAUSE, description="GTFS-RT alert cause")
    effect: str = Field(AlertEffect.UNKNOWN_EFFECT, description="GTFS-RT alert effect")
    url: str = Field("", max_length=2_048, description="More-info URL (Catalan preferred)")
    active_period_start: str | None = Field(
        None,
        max_length=64,
        description="ISO 8601 start of the alert's active period",
    )
    active_period_end: str | None = Field(
        None,
        max_length=64,
        description="ISO 8601 end of the alert's active period",
    )
    affected_route_ids: list[str] = Field(
        default_factory=list,
        max_length=1_000,
        description="List of GTFS route_ids affected by this alert",
    )
    affected_stop_ids: list[str] = Field(
        default_factory=list,
        max_length=1_000,
        description="List of GTFS stop_ids affected by this alert",
    )

    # --- Enhanced classification fields ---
    alert_type: str = Field(
        AlertType.GENERAL_INFO,
        description="High-level alert classification for UI rendering",
    )
    severity: str = Field(
        AlertSeverity.INFO,
        description="Alert severity level (INFO, WARNING, SEVERE)",
    )
    affected_stop_details: list[AffectedStopDetail] = Field(
        default_factory=list,
        max_length=1_000,
        description="Per-stop status and reason details",
    )
    alternative_stops: list[AlternativeStop] = Field(
        default_factory=list,
        max_length=1_000,
        description="Replacement stops for temporarily canceled ones",
    )
    detour_description: str = Field(
        "",
        max_length=1_000,
        description="Human-readable description of the detour path",
    )


class ATMRealtimeFeed(BaseModel):
    """Complete parsed ATM GTFS-RT feed snapshot containing data from all feeds."""

    feed_timestamp: datetime = Field(
        default_factory=lambda: datetime.now(tz=UTC),
        description="UTC time when the feeds were fetched and parsed",
    )
    vehicle_positions: list[VehiclePosition] = Field(default_factory=list, max_length=50_000)
    trip_updates: list[TripUpdate] = Field(default_factory=list, max_length=50_000)
    service_alerts: list[ServiceAlert] = Field(default_factory=list, max_length=10_000)
    entity_count: int = Field(0, ge=0, le=110_000, description="Total entities stored")
