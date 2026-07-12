"""Road traffic models used by the driver app."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class TrafficLookupRequest(BaseModel):
    """Exact GPS is accepted only in a JSON body, then quantized server-side."""

    model_config = ConfigDict(extra="forbid", strict=True)

    latitude: float = Field(ge=40.45, le=42.95)
    longitude: float = Field(ge=0.0, le=3.5)


class TrafficSummary(BaseModel):
    """Compact traffic condition near a single coordinate."""

    label: str = Field(..., max_length=100, description="Driver-facing traffic summary")
    status: Literal["normal", "dense", "slow", "jammed", "closed", "unavailable"] = Field(
        ...,
        description="Normalized traffic state",
    )
    source: Literal["tomtom"] = Field(..., description="Provider used for the summary")
    current_speed_kmh: float | None = Field(
        None,
        ge=0,
        le=500,
        allow_inf_nan=False,
        description="Observed traffic speed",
    )
    free_flow_speed_kmh: float | None = Field(
        None,
        ge=0,
        le=500,
        allow_inf_nan=False,
        description="Expected free-flow speed",
    )
    delay_seconds: int | None = Field(
        None,
        ge=0,
        le=86_400,
        description="Extra travel time on the sampled segment",
    )
    confidence: float | None = Field(
        None,
        ge=0,
        le=1,
        allow_inf_nan=False,
        description="Provider confidence where available",
    )
    road_closure: bool = Field(False, description="Whether the provider reports a closure")
