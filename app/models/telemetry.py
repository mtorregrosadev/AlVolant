"""Strict, privacy-preserving telemetry contracts.

The client cannot submit arbitrary properties. In particular, location,
search text, stop names, trip IDs, vehicle IDs, headers and URLs are absent
from the allow-list by design.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

TelemetryEventName = Literal[
    "app_started",
    "app_backgrounded",
    "screen_view",
    "route_selected",
    "route_started",
    "map_loaded",
    "map_match_changed",
    "api_request",
    "api_error",
    "render_error",
    "unhandled_error",
    "memory_warning",
    "preference_changed",
]

ShortString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
TelemetryValue = bool | int | float | ShortString

_ALLOWED_CONTEXT_KEYS = frozenset({
    "app_version",
    "assigned",
    "direction",
    "duration_ms",
    "endpoint",
    "error_type",
    "is_fatal",
    "language",
    "method",
    "mode",
    "phase",
    "platform",
    "screen",
    "setting",
    "source",
    "status",
    "value",
})

_ALLOWED_ENDPOINTS = frozenset({
    "live_websocket",
    "nearby_routes",
    "route_shape",
    "route_stops",
    "route_updates",
    "route_vehicles",
    "routes",
    "traffic_summary",
    "upcoming_trips",
})
_ALLOWED_SCREENS = frozenset({"Home", "Map", "Routes", "Settings"})
_ALLOWED_METHODS = frozenset({"GET", "POST", "WS"})
_ALLOWED_STATUSES = frozenset({
    "close",
    "error",
    "network",
    "open",
    "parse",
    "success",
    "timeout",
})
_ALLOWED_PHASES = frozenset({
    "global",
    "map_data",
    "map_feature_query",
    "preferences_read",
    "preferences_write",
    "render",
})
_ALLOWED_SETTINGS = frozenset({"language", "vehicle_color"})
_ALLOWED_VALUES = frozenset({"ca", "es", "green", "red", "route", "yellow"})
_ALLOWED_MODES = frozenset({"off_route", "snapped"})


class ClientTelemetryEvent(BaseModel):
    """One typed client event with a short-lived in-memory session ID."""

    model_config = ConfigDict(extra="forbid", strict=True)

    name: TelemetryEventName
    session_id: Annotated[
        str,
        StringConstraints(pattern=r"^[A-Za-z0-9_-]{12,64}$"),
    ]
    sequence: int = Field(ge=0, le=1_000_000_000)
    occurred_at_ms: int = Field(ge=0, le=10_000_000_000_000)
    context: dict[str, TelemetryValue] = Field(default_factory=dict, max_length=16)

    @field_validator("context")
    @classmethod
    def validate_context(cls, value: dict[str, TelemetryValue]) -> dict[str, TelemetryValue]:
        unknown = set(value) - _ALLOWED_CONTEXT_KEYS
        if unknown:
            raise ValueError(f"Unsupported telemetry context keys: {sorted(unknown)}")

        for key, item in value.items():
            if not key.isascii() or not key.replace("_", "").isalnum():
                raise ValueError("Telemetry context keys must be simple ASCII identifiers")
            if isinstance(item, str) and len(item) > 160:
                raise ValueError(f"Telemetry context value '{key}' is too long")

        cls._validate_dimension(value, "endpoint", _ALLOWED_ENDPOINTS)
        cls._validate_dimension(value, "screen", _ALLOWED_SCREENS)
        cls._validate_dimension(value, "method", _ALLOWED_METHODS)
        cls._validate_dimension(value, "phase", _ALLOWED_PHASES)
        cls._validate_dimension(value, "setting", _ALLOWED_SETTINGS)
        cls._validate_dimension(value, "value", _ALLOWED_VALUES)
        cls._validate_dimension(value, "mode", _ALLOWED_MODES)

        status = value.get("status")
        if isinstance(status, str) and status not in _ALLOWED_STATUSES:
            raise ValueError("Unsupported telemetry status")
        if isinstance(status, int) and not 100 <= status <= 599:
            raise ValueError("Telemetry HTTP status is out of range")
        if "duration_ms" in value:
            duration = value["duration_ms"]
            if isinstance(duration, bool) or not isinstance(duration, (int, float)):
                raise ValueError("Telemetry duration must be numeric")
            if not 0 <= duration <= 60_000:
                raise ValueError("Telemetry duration is out of range")
        if "direction" in value and value["direction"] not in (0, 1):
            raise ValueError("Telemetry direction must be 0 or 1")
        return value

    @staticmethod
    def _validate_dimension(
        context: dict[str, TelemetryValue],
        key: str,
        allowed: frozenset[str],
    ) -> None:
        if key not in context:
            return
        value = context[key]
        if not isinstance(value, str) or value not in allowed:
            raise ValueError(f"Unsupported telemetry dimension '{key}'")


class TelemetryBatch(BaseModel):
    """Bounded batch accepted from the mobile app."""

    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal[1]
    sent_at_ms: int = Field(ge=0, le=10_000_000_000_000)
    events: list[ClientTelemetryEvent] = Field(min_length=1, max_length=20)


class TelemetryAccepted(BaseModel):
    """Acknowledgement that reports whether the in-memory queue accepted data."""

    accepted: int = Field(ge=0, le=20)
    dropped: int = Field(ge=0, le=20)
