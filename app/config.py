"""
Centralized application configuration loaded from environment variables.

All secrets and tunables are defined here via Pydantic Settings.
Values are read from environment variables or a .env file at the project root.

Usage:
    from app.config import settings
    print(settings.TMB_APP_ID)
"""

from functools import lru_cache

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
    # ATM T-mobilitat Real-Time (GTFS-RT)
    # -------------------------------------------------------------------------
    ATM_RT_TRIP_UPDATES_URL: str = "https://t-mobilitat.atm.cat/opendata/trip_updates/user/token/open"
    ATM_RT_ALERTS_URL: str = "https://t-mobilitat.atm.cat/opendata/alerts/user/token/open"
    ATM_RT_VEHICLE_POSITIONS_URL: str = "https://t-mobilitat.atm.cat/opendata/vehicle_positions/user/token/open"
    ATM_RT_POLL_INTERVAL_SECONDS: int = 30

    # -------------------------------------------------------------------------
    # ATM T-mobilitat Static GTFS
    # -------------------------------------------------------------------------
    ATM_GTFS_URL: str = "https://t-mobilitat.atm.cat/opendata/static/download/"
    ATM_GTFS_REFRESH_HOURS: int = 24

    # -------------------------------------------------------------------------
    # Redis
    # -------------------------------------------------------------------------
    REDIS_URL: str = "redis://localhost:6379/0"

    # -------------------------------------------------------------------------
    # Cache TTLs (seconds)
    # -------------------------------------------------------------------------
    CACHE_TTL_ATM_REALTIME: int = 35
    CACHE_TTL_GTFS_SHAPES: int = 86400  # 24 hours

    # -------------------------------------------------------------------------
    # Server
    # -------------------------------------------------------------------------
    SERVER_HOST: str = "0.0.0.0"
    SERVER_PORT: int = 8000
    LOG_LEVEL: str = "info"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached singleton of the application settings.

    Using lru_cache ensures the .env file is read only once.
    """
    return Settings()


# Module-level convenience alias
settings = get_settings()
