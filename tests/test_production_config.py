"""Fail-fast tests for security-critical production settings."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.main import _validate_security_settings


def _production(**updates: object) -> Settings:
    values: dict[str, object] = {
        "ENVIRONMENT": "production",
        "BFF_API_KEY": "Bff_7Jx2kQ9mV4pL8sN3dR6tY1wC5hF0aZ",
        "RATE_LIMIT_HASH_KEY": "Rate_4pL8sN3dR6tY1wC5hF0aZ7Jx2kQ9mV",
        "TRUSTED_HOSTS": "api.example.cat",
        "CORS_ALLOWED_ORIGINS": "",
        "DOCS_ENABLED": False,
        "REDIS_URL": "redis://alvolant:Redis_9mV4pL8sN3dR6tY1wC5hF0aZ7Jx2kQ@redis:6379/0",
    }
    values.update(updates)
    return Settings(**values)


def test_safe_single_host_production_configuration_is_accepted() -> None:
    _validate_security_settings(_production())


@pytest.mark.parametrize(
    "redis_url",
    [
        "redis://localhost:6379/0",
        "redis://user@evil@localhost:6379/0",
        "http://user:password@localhost:6379/0",
        "redis://user:password@remote.example:6379/0",
        "redis://user:password@localhost:70000/0",
        "rediss://user:password@remote.example:6379/0?ssl_cert_reqs=none",
        "redis://default:password@redis:6379/0",
        "redis://alvolant:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@redis:6379/0",
        "redis://alvolant:replace_with_a_different_random_password_2026@redis:6379/0",
    ],
)
def test_unsafe_redis_urls_are_rejected(redis_url: str) -> None:
    with pytest.raises(RuntimeError, match="Redis|REDIS"):
        _validate_security_settings(_production(REDIS_URL=redis_url))


@pytest.mark.parametrize(
    "updates",
    [
        {"BFF_API_KEY": "short"},
        {"RATE_LIMIT_HASH_KEY": "public-or-short"},
        {"TRUSTED_HOSTS": "*"},
        {"CORS_ALLOWED_ORIGINS": "*"},
        {"DOCS_ENABLED": True},
        {"FORWARDED_ALLOW_IPS": "*"},
        {"FORWARDED_ALLOW_IPS": "not-an-ip"},
        {"FORWARDED_ALLOW_IPS": "0.0.0.0/0"},
        {"FORWARDED_ALLOW_IPS": "::/0"},
        {"BFF_API_KEY": "replace-with-at-least-32-random-characters"},
        {"RATE_LIMIT_HASH_KEY": "replace-with-a-separate-32-character-server-secret"},
    ],
)
def test_other_unsafe_production_boundaries_fail_fast(updates: dict[str, object]) -> None:
    with pytest.raises(RuntimeError, match="Unsafe production configuration"):
        _validate_security_settings(_production(**updates))


@pytest.mark.parametrize(
    "updates",
    [
        {"RATE_LIMIT_RPM": 0},
        {"ATM_RT_POLL_INTERVAL_SECONDS": 0},
        {"CACHE_TTL_ATM_REALTIME": 0},
        {"MAX_WS_CONNECTIONS": -1},
        {"MAX_REQUEST_BODY_BYTES": 64 * 1024 * 1024},
        {"REDIS_PORT": 70_000},
        {"ATM_RT_FRESHNESS_SECONDS": 181, "CACHE_TTL_ATM_REALTIME": 180},
        {
            "TRAFFIC_GLOBAL_REQUESTS_PER_MINUTE": 101,
            "TRAFFIC_GLOBAL_REQUESTS_PER_DAY": 100,
        },
    ],
)
def test_resource_limits_fail_validation(updates: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        _production(**updates)
