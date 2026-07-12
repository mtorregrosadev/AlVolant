"""
Centralized application configuration loaded from environment variables.

All secrets and tunables are defined here via Pydantic Settings.
Values are read from environment variables or a .env file at the project root.

Usage:
    from app.config import settings
    print(settings.TMB_APP_ID)
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables.

    Environment variables take precedence over .env file values.
    See .env.example for documentation of each variable.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # -------------------------------------------------------------------------
    # Security & Authentication
    # -------------------------------------------------------------------------
    BFF_API_KEY: str = ""  # Machine-to-machine API key (REQUIRED in production)
    BFF_API_KEY_FILE: str = ""
    RATE_LIMIT_HASH_KEY: str = ""  # Server-only HMAC key; never bundle in Expo
    RATE_LIMIT_HASH_KEY_FILE: str = ""
    ENVIRONMENT: Literal["development", "test", "production"] = "development"

    # -------------------------------------------------------------------------
    # Privacy-first observability
    # -------------------------------------------------------------------------
    TELEMETRY_ENABLED: bool = True
    TELEMETRY_RETENTION_DAYS: int = Field(default=3, ge=1, le=30)
    TELEMETRY_MAX_EVENTS_PER_DAY: int = Field(default=5_000, ge=100, le=100_000)
    TELEMETRY_MAX_ERRORS_PER_DAY: int = Field(default=500, ge=20, le=5_000)
    TELEMETRY_QUEUE_SIZE: int = Field(default=2_048, ge=100, le=10_000)

    # -------------------------------------------------------------------------
    # Rate Limiting
    # -------------------------------------------------------------------------
    RATE_LIMIT_RPM: int = Field(default=60, ge=1, le=10_000)
    RATE_LIMIT_WS_MPM: int = Field(default=120, ge=1, le=10_000)

    # -------------------------------------------------------------------------
    # WebSocket
    # -------------------------------------------------------------------------
    MAX_WS_CONNECTIONS: int = Field(default=200, ge=1, le=10_000)
    MAX_WS_CONNECTIONS_PER_IP: int = Field(default=20, ge=1, le=500)
    MAX_WS_TOPICS_PER_CLIENT: int = Field(default=20, ge=1, le=100)
    MAX_WS_MESSAGE_BYTES: int = Field(default=4_096, ge=1_024, le=65_536)

    # -------------------------------------------------------------------------
    # CORS
    # -------------------------------------------------------------------------
    CORS_ALLOWED_ORIGINS: str = ""  # Comma-separated origins, empty = same-origin only
    TRUSTED_HOSTS: str = "*"  # Comma-separated Host allow-list; wildcard is forbidden in production
    OUTBOUND_ALLOWED_HOSTS: str = "t-mobilitat.atm.cat,t-mobilitat.cat,api.tomtom.com"

    # -------------------------------------------------------------------------
    # ATM T-mobilitat Real-Time (GTFS-RT)
    # -------------------------------------------------------------------------
    ATM_RT_TRIP_UPDATES_URL: str = "https://t-mobilitat.atm.cat/opendata/trip_updates/user/token/open"
    ATM_RT_ALERTS_URL: str = "https://t-mobilitat.atm.cat/opendata/alerts/user/token/open"
    ATM_RT_VEHICLE_POSITIONS_URL: str = "https://t-mobilitat.atm.cat/opendata/vehicle_positions/user/token/open"
    ATM_RT_POLL_INTERVAL_SECONDS: int = Field(default=30, ge=5, le=3_600)

    # -------------------------------------------------------------------------
    # ATM T-mobilitat Static GTFS
    # -------------------------------------------------------------------------
    ATM_GTFS_URL: str = "https://t-mobilitat.atm.cat/opendata/static/download/"
    ATM_GTFS_REFRESH_HOURS: int = Field(default=24, ge=1, le=168)

    # -------------------------------------------------------------------------
    # Road Traffic Provider
    # -------------------------------------------------------------------------
    TOMTOM_API_KEY: str = ""
    TOMTOM_API_KEY_FILE: str = ""
    TOMTOM_TRAFFIC_BASE_URL: str = "https://api.tomtom.com/traffic/services/4"
    TRAFFIC_CACHE_TTL_SECONDS: int = Field(default=60, ge=1, le=3_600)
    TRAFFIC_GLOBAL_REQUESTS_PER_MINUTE: int = Field(default=120, ge=1, le=10_000)
    TRAFFIC_GLOBAL_REQUESTS_PER_DAY: int = Field(default=5_000, ge=1, le=1_000_000)
    TRAFFIC_PROVIDER_CIRCUIT_SECONDS: int = Field(default=60, ge=5, le=3_600)

    # -------------------------------------------------------------------------
    # Redis
    # -------------------------------------------------------------------------
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = Field(default=6_379, ge=1, le=65_535)
    REDIS_DB: int = Field(default=0, ge=0, le=15)
    REDIS_USERNAME: str = ""
    REDIS_PASSWORD_FILE: str = ""
    REDIS_USE_TLS: bool = False

    # -------------------------------------------------------------------------
    # Cache TTLs (seconds)
    # -------------------------------------------------------------------------
    CACHE_TTL_ATM_REALTIME: int = Field(default=180, ge=30, le=3_600)
    ATM_RT_FRESHNESS_SECONDS: int = Field(default=90, ge=5, le=3_600)
    CACHE_TTL_GTFS_SHAPES: int = Field(default=259_200, ge=3_600, le=604_800)

    # -------------------------------------------------------------------------
    # Server
    # -------------------------------------------------------------------------
    SERVER_HOST: str = "0.0.0.0"
    SERVER_PORT: int = Field(default=8_000, ge=1, le=65_535)
    FORWARDED_ALLOW_IPS: str = "127.0.0.1"
    LOG_LEVEL: str = "info"
    DOCS_ENABLED: bool = True
    MAX_REQUEST_BODY_BYTES: int = Field(default=32_768, ge=1_024, le=1_048_576)
    REQUEST_BODY_TIMEOUT_SECONDS: float = Field(default=15.0, ge=1.0, le=120.0)
    GZIP_MINIMUM_SIZE: int = Field(default=1_024, ge=500, le=1_048_576)

    @model_validator(mode="after")
    def validate_related_limits(self) -> Settings:
        """Reject internally contradictory resource limits at startup."""
        if self.MAX_WS_CONNECTIONS_PER_IP > self.MAX_WS_CONNECTIONS:
            raise ValueError("MAX_WS_CONNECTIONS_PER_IP cannot exceed MAX_WS_CONNECTIONS")
        if self.TELEMETRY_MAX_ERRORS_PER_DAY > self.TELEMETRY_MAX_EVENTS_PER_DAY:
            raise ValueError(
                "TELEMETRY_MAX_ERRORS_PER_DAY cannot exceed TELEMETRY_MAX_EVENTS_PER_DAY"
            )
        if self.ATM_RT_FRESHNESS_SECONDS > self.CACHE_TTL_ATM_REALTIME:
            raise ValueError("ATM_RT_FRESHNESS_SECONDS cannot exceed CACHE_TTL_ATM_REALTIME")
        if self.TRAFFIC_GLOBAL_REQUESTS_PER_MINUTE > self.TRAFFIC_GLOBAL_REQUESTS_PER_DAY:
            raise ValueError(
                "TRAFFIC_GLOBAL_REQUESTS_PER_MINUTE cannot exceed the daily traffic limit"
            )
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached singleton of the application settings.

    Using lru_cache ensures the .env file is read only once.
    """
    return Settings()


# Module-level convenience alias
settings = get_settings()
