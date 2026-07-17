"""TMB iBus models exposed to the driver application."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class IbusFleetLookupRequest(BaseModel):
    """A bounded lookup for live iBus arrivals at one route stop."""

    model_config = ConfigDict(extra="forbid", strict=True)

    route_id: str = Field(min_length=1, max_length=128)
    direction_id: int = Field(ge=0, le=1)
    trip_id: str | None = Field(default=None, min_length=1, max_length=160)
    stop_id: str = Field(min_length=1, max_length=160)
    scheduled_departure_epoch: int | None = Field(
        default=None,
        ge=1_577_836_800,  # 2020-01-01; rejects malformed client clocks.
        le=4_102_444_800,  # 2100-01-01
    )


class IbusVehiclePrediction(BaseModel):
    """One iBus arrival prediction at a stop.

    TMB's current iBus response omits a physical vehicle identifier.  The
    optional field remains for compatibility if TMB restores it, but clients
    must treat this as a stop-arrival prediction rather than GPS telemetry.
    """

    vehicle_id: str = Field("", max_length=160)
    arrival_epoch: int = Field(ge=1_577_836_800, le=4_102_444_800)
    eta_seconds: int = Field(ge=0, le=14_400)
    destination_name: str = Field("", max_length=300)


class IbusAheadPosition(BaseModel):
    """A preceding service observed at a downstream route stop.

    This is a stop-arrival observation, not a GPS coordinate.  It is emitted
    only when its predicted arrival is materially earlier than the selected
    trip's scheduled arrival at that same downstream stop.
    """

    stop_id: str = Field(min_length=1, max_length=160)
    stop_name: str = Field("", max_length=500)
    stop_sequence: int = Field(ge=0, le=10_000)
    prediction: IbusVehiclePrediction


class IbusRoutePosition(BaseModel):
    """One inferred service position from a sampled route-stop prediction."""

    stop_id: str = Field(min_length=1, max_length=160)
    stop_name: str = Field("", max_length=500)
    stop_sequence: int = Field(ge=0, le=10_000)
    relation: Literal["ahead", "behind"]
    prediction: IbusVehiclePrediction


class IbusFleetSummary(BaseModel):
    """Best-effort predecessor/successor information from live stop predictions."""

    source: Literal["tmb_ibus", "amb_gtfs_rt"] = "tmb_ibus"
    status: Literal["available", "unconfigured", "rate_limited", "unavailable"]
    stop_id: str = Field(min_length=1, max_length=160)
    stop_name: str = Field("", max_length=500)
    reference_vehicle_id: str = Field("", max_length=160)
    reference_arrival_epoch: int | None = Field(
        default=None,
        ge=1_577_836_800,
        le=4_102_444_800,
    )
    reference_prediction: IbusVehiclePrediction | None = None
    reference_is_schedule_match: bool = False
    ahead_vehicle: IbusVehiclePrediction | None = None
    behind_vehicle: IbusVehiclePrediction | None = None
    ahead_position: IbusAheadPosition | None = None
    route_positions: list[IbusRoutePosition] = Field(default_factory=list, max_length=16)
