"""Road traffic models used by the driver app."""

from __future__ import annotations

from pydantic import BaseModel, Field


class TrafficSummary(BaseModel):
    """Compact traffic condition near a single coordinate."""

    label: str = Field(..., description="Driver-facing traffic summary")
    status: str = Field(..., description="normal, dense, slow, jammed, closed, unavailable")
    source: str = Field(..., description="Provider used for the summary")
    current_speed_kmh: float | None = Field(None, description="Observed traffic speed")
    free_flow_speed_kmh: float | None = Field(None, description="Expected free-flow speed")
    delay_seconds: int | None = Field(None, description="Extra travel time on the sampled segment")
    confidence: float | None = Field(None, description="Provider confidence where available")
    road_closure: bool = Field(False, description="Whether the provider reports a closure")
