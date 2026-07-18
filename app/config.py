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
    OUTBOUND_ALLOWED_HOSTS: str = (
        "t-mobilitat.atm.cat,t-mobilitat.cat,api.tomtom.com,api.tmb.cat,"
        "www.ambmobilitat.cat"
    )

    # -------------------------------------------------------------------------
    # ATM T-mobilitat Real-Time (GTFS-RT)
    # -------------------------------------------------------------------------
    ATM_RT_TRIP_UPDATES_URL: str = (
        "https://t-mobilitat.atm.cat/opendata/trip_updates/user/token/open"
    )
    ATM_RT_ALERTS_URL: str = "https://t-mobilitat.atm.cat/opendata/alerts/user/token/open"
    ATM_RT_VEHICLE_POSITIONS_URL: str = (
        "https://t-mobilitat.atm.cat/opendata/vehicle_positions/user/token/open"
    )
    ATM_RT_POLL_INTERVAL_SECONDS: int = Field(default=30, ge=5, le=3_600)

    # -------------------------------------------------------------------------
    # TMB iBus (stop-level, live arrival predictions)
    # -------------------------------------------------------------------------
    # Keep both credential values on the BFF. The Expo bundle never receives
    # them, because iBus is requested through /api/v1/ibus/fleet only.
    TMB_APP_ID: str = ""
    TMB_APP_ID_FILE: str = ""
    TMB_APP_KEY: str = ""
    TMB_APP_KEY_FILE: str = ""
    TMB_API_BASE_URL: str = "https://api.tmb.cat/v1"
    TMB_IBUS_CACHE_TTL_SECONDS: int = Field(default=30, ge=15, le=120)
    # Every-other-stop route scan used to position nearby services. A 120 s
    # shared scan window keeps a full normal bus line below the daily quota.
    TMB_IBUS_ROUTE_SCAN_MAX_STOPS: int = Field(default=16, ge=2, le=64)
    TMB_IBUS_ROUTE_SCAN_TTL_SECONDS: int = Field(default=120, ge=30, le=600)
    TMB_IBUS_STOP_STRIDE: int = Field(default=2, ge=1, le=5)
    TMB_IBUS_GLOBAL_REQUESTS_PER_MINUTE: int = Field(default=60, ge=1, le=10_000)
    TMB_IBUS_GLOBAL_REQUESTS_PER_DAY: int = Field(default=15_000, ge=1, le=1_000_000)
    TMB_IBUS_PROVIDER_CIRCUIT_SECONDS: int = Field(default=60, ge=5, le=3_600)

    # AMB publishes the non-TMB metropolitan bus predictions in one GTFS-RT
    # feed.  It complements iBus for operators such as Direxis TUSGSAL (M30).
    # The BFF shares this small snapshot across every active driver.
    AMB_RT_TRIP_UPDATES_URL: str = (
        "https://www.ambmobilitat.cat/transit/trips-updates/trips.bin"
    )
    AMB_RT_CACHE_TTL_SECONDS: int = Field(default=30, ge=15, le=120)

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
    TRAFFIC_CACHE_TTL_SECONDS: int = Field(default=900, ge=1, le=3_600)
    TRAFFIC_GLOBAL_REQUESTS_PER_MINUTE: int = Field(default=120, ge=1, le=10_000)
    # Stay inside TomTom's daily free allowance until usage justifies a paid budget.
    TRAFFIC_GLOBAL_REQUESTS_PER_DAY: int = Field(default=2_300, ge=1, le=1_000_000)
    TRAFFIC_PROVIDER_CIRCUIT_SECONDS: int = Field(default=60, ge=5, le=3_600)

    # -------------------------------------------------------------------------
    # Satellite basemap
    # -------------------------------------------------------------------------
    # The key is held by the BFF only.  The public tile endpoint proxies a
    # fixed Esri World Imagery URL, so clients cannot recover this credential.
    ARCGIS_API_KEY: str = ""
    ARCGIS_API_KEY_FILE: str = ""
    SATELLITE_TILES_ENABLED: bool = True
    # Esri currently publishes World Imagery with max-age=86400.  Never keep
    # the server or client cache beyond that upstream policy.
    SATELLITE_TILE_CACHE_TTL_SECONDS: int = Field(default=86_400, ge=300, le=86_400)
    SATELLITE_TILE_CACHE_ENTRIES: int = Field(default=512, ge=32, le=4_096)
    # 50,000 cold upstream tiles/day is a conservative 1.55M maximum in a
    # 31-day month, below Esri's 2M free basemap tile allowance. Cache hits
    # never consume this budget; the higher minute cap avoids a normal map
    # load tripping the safety guard before the day budget is relevant.
    SATELLITE_GLOBAL_REQUESTS_PER_MINUTE: int = Field(default=600, ge=1, le=10_000)
    SATELLITE_GLOBAL_REQUESTS_PER_DAY: int = Field(default=50_000, ge=1, le=2_000_000)
    # A mobile installation receives a private opaque identifier used only to
    # account for satellite tiles. Redis stores an HMAC digest, never that ID.
    # The IP ceiling prevents an abusive client from evading its device quota
    # just by repeatedly clearing local storage.
    SATELLITE_CLIENT_REQUESTS_PER_MINUTE: int = Field(default=300, ge=1, le=10_000)
    SATELLITE_CLIENT_REQUESTS_PER_DAY: int = Field(default=3_000, ge=1, le=100_000)
    SATELLITE_IP_REQUESTS_PER_MINUTE: int = Field(default=600, ge=1, le=10_000)
    SATELLITE_IP_REQUESTS_PER_DAY: int = Field(default=6_000, ge=1, le=200_000)
    SATELLITE_PROVIDER_CIRCUIT_SECONDS: int = Field(default=3_600, ge=5, le=86_400)

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
        if self.TMB_IBUS_GLOBAL_REQUESTS_PER_MINUTE > self.TMB_IBUS_GLOBAL_REQUESTS_PER_DAY:
            raise ValueError(
                "TMB_IBUS_GLOBAL_REQUESTS_PER_MINUTE cannot exceed the daily iBus limit"
            )
        if self.SATELLITE_GLOBAL_REQUESTS_PER_MINUTE > self.SATELLITE_GLOBAL_REQUESTS_PER_DAY:
            raise ValueError(
                "SATELLITE_GLOBAL_REQUESTS_PER_MINUTE cannot exceed the daily satellite limit"
            )
        if self.SATELLITE_CLIENT_REQUESTS_PER_MINUTE > self.SATELLITE_CLIENT_REQUESTS_PER_DAY:
            raise ValueError(
                "SATELLITE_CLIENT_REQUESTS_PER_MINUTE cannot exceed the daily client limit"
            )
        if self.SATELLITE_IP_REQUESTS_PER_MINUTE > self.SATELLITE_IP_REQUESTS_PER_DAY:
            raise ValueError(
                "SATELLITE_IP_REQUESTS_PER_MINUTE cannot exceed the daily IP limit"
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
