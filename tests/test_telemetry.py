"""Privacy, bounds and retention tests for first-party telemetry."""

from __future__ import annotations

import asyncio
from typing import Any, Never

import orjson
import pytest
from pydantic import ValidationError

from app.cache.redis_manager import CacheManager
from app.models.telemetry import ClientTelemetryEvent, TelemetryBatch
from app.services.telemetry_service import TelemetryRecord, TelemetryService


def _event(**overrides: Any) -> ClientTelemetryEvent:
    payload = {
        "name": "api_error",
        "session_id": "session_12345678",
        "sequence": 1,
        "occurred_at_ms": 1_750_000_000_000,
        "context": {
            "endpoint": "traffic_summary",
            "error_type": "ApiError",
            "status": "network",
        },
    }
    payload.update(overrides)
    return ClientTelemetryEvent.model_validate(payload)


def test_batch_rejects_unknown_or_location_fields() -> None:
    with pytest.raises(ValidationError):
        _event(context={"latitude": 41.4})

    with pytest.raises(ValidationError):
        TelemetryBatch.model_validate({
            "schema_version": 1,
            "sent_at_ms": 1_750_000_000_000,
            "events": [_event().model_dump()] * 21,
        })


@pytest.mark.asyncio
async def test_service_hashes_session_redacts_secrets_and_sets_ttl(
    cache: CacheManager,
) -> None:
    service = TelemetryService(cache, retention_days=3, max_events_per_day=100)
    await service.start()
    event = _event(context={
        "endpoint": "traffic_summary",
        "error_type": "ApiError",
        "status": "network",
    })

    assert service.enqueue_client_event(event) is True
    await service.flush()

    keys = [key async for key in cache.client.scan_iter(match="telemetry:events:*")]
    assert len(keys) == 1
    raw = await cache.client.lindex(keys[0], 0)
    stored = orjson.loads(raw)
    assert stored["session"] != event.session_id
    assert 0 < await cache.client.ttl(keys[0]) <= 3 * 86_400

    dirty = (
        "token=top-secret at /Users/alice/project "
        "41.403812, 2.174532 user@example.com "
        "https://example.com/path?api_key=secret"
    )
    scrubbed = service._sanitize_text(dirty, 500)
    assert "top-secret" not in scrubbed
    assert "alice" not in scrubbed
    assert "41.403812" not in scrubbed
    assert "user@example.com" not in scrubbed

    await service.close()


@pytest.mark.asyncio
async def test_service_is_bounded_and_non_blocking_when_disabled(
    cache: CacheManager,
) -> None:
    disabled = TelemetryService(cache, enabled=False)
    await disabled.start()
    assert disabled.enqueue_client_event(_event()) is False

    service = TelemetryService(cache, queue_size=100, max_events_per_day=100)
    await service.start()
    for sequence in range(130):
        service.enqueue_client_event(_event(sequence=sequence))
    await service.flush()

    keys = [key async for key in cache.client.scan_iter(match="telemetry:events:*")]
    assert len(keys) == 1
    assert await cache.client.llen(keys[0]) <= 100
    quota_keys = [key async for key in cache.client.scan_iter(match="telemetry:quota:*")]
    assert len(quota_keys) == 1
    assert 0 < await cache.client.ttl(quota_keys[0]) <= 7 * 86_400
    await service.close()


@pytest.mark.asyncio
async def test_flush_does_not_hang_after_a_write_failure(
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = TelemetryService(cache)
    await service.start()

    async def fail(_records: list[TelemetryRecord]) -> Never:
        raise RuntimeError("redis unavailable")

    monkeypatch.setattr(service, "_write_batch", fail)
    service.enqueue_client_event(_event())
    await asyncio.wait_for(service.flush(), timeout=1)
    assert service.dropped_count == 1
    await service.close()
