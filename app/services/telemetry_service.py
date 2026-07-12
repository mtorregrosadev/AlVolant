"""Bounded Redis telemetry sink with short retention and server-side redaction."""

from __future__ import annotations

import asyncio
import hashlib
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from time import time
from typing import Any

import orjson

from app.cache.redis_manager import CacheManager
from app.core.logging import get_logger
from app.models.telemetry import ClientTelemetryEvent

logger = get_logger(__name__)

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]+")
_EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
_SECRET_RE = re.compile(
    r"(?i)(\b(?:x[_-]?)?(?:api[_-]?key|authorization|password|secret|token)\b"
    r"[\"']?\s*[:=]\s*)[\"']?(?:(?:bearer|basic)\s+)?[^\"'\s,;}\]]+[\"']?"
)
_USER_PATH_RE = re.compile(r"/(?:Users|home)/[^/\s]+/")
_COORDINATE_PAIR_RE = re.compile(r"(?<!\d)-?\d{1,3}\.\d{4,}\s*[,;]\s*-?\d{1,3}\.\d{4,}(?!\d)")
_COORDINATE_FIELD_RE = re.compile(
    r"(?i)\b(lat(?:itude)?|lon(?:gitude)?)\b[\"']?\s*[:=]\s*"
    r"[\"']?-?\d{1,3}(?:\.\d+)?[\"']?"
)
_URL_QUERY_RE = re.compile(r"(https?://[^\s?#]+)(?:[?#][^\s]*)?", re.IGNORECASE)

_ERROR_EVENTS = frozenset({"api_error", "render_error", "unhandled_error"})
_SENTINEL = object()


@dataclass(slots=True)
class TelemetryRecord:
    """Internal record. It never contains an IP address or a request body."""

    name: str
    context: dict[str, bool | int | float | str]
    received_at_ms: int
    session_hash: str | None = None
    sequence: int | None = None


class TelemetryService:
    """Asynchronous bounded sink so observability never blocks product traffic."""

    def __init__(
        self,
        cache: CacheManager,
        *,
        enabled: bool = True,
        retention_days: int = 3,
        max_events_per_day: int = 5_000,
        max_errors_per_day: int = 500,
        queue_size: int = 2_048,
    ) -> None:
        self._cache = cache
        self._enabled = enabled
        self._retention_seconds = max(1, min(retention_days, 30)) * 86_400
        self._max_events = max(100, min(max_events_per_day, 100_000))
        self._max_errors = max(20, min(max_errors_per_day, 5_000))
        self._queue: asyncio.Queue[TelemetryRecord | object] = asyncio.Queue(
            maxsize=max(100, min(queue_size, 10_000))
        )
        self._worker: asyncio.Task[None] | None = None
        self._dropped = 0

    @property
    def dropped_count(self) -> int:
        return self._dropped

    async def start(self) -> None:
        if not self._enabled or self._worker is not None:
            return
        self._worker = asyncio.create_task(self._run(), name="telemetry-writer")
        logger.info(
            "Privacy-first telemetry enabled with %d-day retention",
            self._retention_seconds // 86_400,
        )

    async def close(self) -> None:
        if self._worker is None:
            return
        await self.flush()
        await self._queue.put(_SENTINEL)
        await self._worker
        self._worker = None

    async def flush(self, timeout: float = 2.0) -> None:
        if self._worker is None:
            return
        try:
            await asyncio.wait_for(self._queue.join(), timeout=timeout)
        except TimeoutError:
            logger.warning("Telemetry queue did not flush within %.1fs", timeout)

    def enqueue_client_event(self, event: ClientTelemetryEvent) -> bool:
        record = TelemetryRecord(
            name=event.name,
            context=self._sanitize_context(event.context),
            received_at_ms=int(time() * 1000),
            session_hash=hashlib.sha256(event.session_id.encode("ascii")).hexdigest()[:16],
            sequence=event.sequence,
        )
        return self._enqueue(record)

    def record_server_request(
        self,
        *,
        endpoint: str,
        method: str,
        status: int,
        duration_ms: int,
    ) -> bool:
        return self._enqueue(TelemetryRecord(
            name="server_request",
            context=self._sanitize_context({
                "endpoint": endpoint,
                "method": method,
                "status": status,
                "duration_ms": duration_ms,
            }),
            received_at_ms=int(time() * 1000),
        ))

    def record_server_error(self, *, endpoint: str, error_type: str) -> bool:
        return self._enqueue(TelemetryRecord(
            name="server_error",
            context=self._sanitize_context({
                "endpoint": endpoint,
                "error_type": error_type,
            }),
            received_at_ms=int(time() * 1000),
        ))

    def _enqueue(self, record: TelemetryRecord) -> bool:
        if not self._enabled or self._worker is None:
            return False
        try:
            self._queue.put_nowait(record)
            return True
        except asyncio.QueueFull:
            self._dropped += 1
            return False

    async def _run(self) -> None:
        while True:
            first = await self._queue.get()
            if first is _SENTINEL:
                self._queue.task_done()
                return

            records = [first]
            while len(records) < 100:
                try:
                    candidate = self._queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                if candidate is _SENTINEL:
                    self._queue.task_done()
                    await self._queue.put(_SENTINEL)
                    break
                records.append(candidate)

            try:
                await self._write_batch(records)  # type: ignore[arg-type]
            except Exception:
                self._dropped += len(records)
                logger.exception("Telemetry batch write failed")
            finally:
                for _ in records:
                    self._queue.task_done()

    async def _write_batch(self, records: list[TelemetryRecord]) -> None:
        now_day = datetime.now(UTC).strftime("%Y-%m-%d")
        quota_key = f"telemetry:quota:{now_day}"
        quota_count = await self._cache.client.incrby(quota_key, len(records))
        if quota_count == len(records):
            await self._cache.client.expire(quota_key, self._retention_seconds)
        previous_count = quota_count - len(records)
        allowed_count = max(0, min(len(records), self._max_events - previous_count))
        if allowed_count < len(records):
            self._dropped += len(records) - allowed_count
            records = records[:allowed_count]
        if not records:
            return

        pipe = self._cache.client.pipeline(transaction=False)
        for record in records:
            day = datetime.fromtimestamp(
                record.received_at_ms / 1000,
                tz=UTC,
            ).strftime("%Y-%m-%d")
            counts_key = f"telemetry:counts:{day}"
            dimensions_key = f"telemetry:dimensions:{day}"
            events_key = f"telemetry:events:{day}"
            payload = {
                "name": record.name,
                "context": record.context,
                "received_at_ms": record.received_at_ms,
                **({"session": record.session_hash} if record.session_hash else {}),
                **({"sequence": record.sequence} if record.sequence is not None else {}),
            }

            pipe.hincrby(counts_key, record.name, 1)
            pipe.expire(counts_key, self._retention_seconds)

            dimension = self._dimension(record)
            if dimension:
                pipe.hincrby(dimensions_key, dimension, 1)
                pipe.expire(dimensions_key, self._retention_seconds)

            pipe.lpush(events_key, orjson.dumps(payload))
            pipe.ltrim(events_key, 0, self._max_events - 1)
            pipe.expire(events_key, self._retention_seconds)

            if record.name in _ERROR_EVENTS or record.name == "server_error":
                errors_key = f"telemetry:errors:{day}"
                pipe.lpush(errors_key, orjson.dumps(payload))
                pipe.ltrim(errors_key, 0, self._max_errors - 1)
                pipe.expire(errors_key, self._retention_seconds)

        await pipe.execute()

    def _sanitize_context(self, context: dict[str, Any]) -> dict[str, bool | int | float | str]:
        sanitized: dict[str, bool | int | float | str] = {}
        for key, value in context.items():
            clean_key = _CONTROL_RE.sub("", str(key))[:48]
            if not clean_key:
                continue
            if isinstance(value, bool):
                sanitized[clean_key] = value
            elif isinstance(value, int):
                sanitized[clean_key] = max(-1_000_000_000, min(value, 1_000_000_000))
            elif isinstance(value, float) and value == value:
                sanitized[clean_key] = round(max(-1_000_000_000.0, min(value, 1_000_000_000.0)), 3)
            elif isinstance(value, str):
                sanitized[clean_key] = self._sanitize_text(value, 160)
        return sanitized

    @staticmethod
    def _sanitize_text(value: str, limit: int) -> str:
        text = _CONTROL_RE.sub(" ", value)
        text = _EMAIL_RE.sub("[redacted-email]", text)
        text = _SECRET_RE.sub(r"\1[redacted]", text)
        text = _USER_PATH_RE.sub("/Users/[redacted]/", text)
        text = _COORDINATE_PAIR_RE.sub("[redacted-coordinates]", text)
        text = _COORDINATE_FIELD_RE.sub(r"\1=[redacted]", text)
        text = _URL_QUERY_RE.sub(r"\1", text)
        return " ".join(text.split())[:limit]

    @staticmethod
    def _dimension(record: TelemetryRecord) -> str | None:
        context = record.context
        if record.name in {"api_request", "api_error", "server_request"}:
            endpoint = context.get("endpoint", "unknown")
            status = context.get("status", "unknown")
            duration = context.get("duration_ms")
            bucket = (
                TelemetryService._duration_bucket(duration)
                if isinstance(duration, (int, float))
                else "unknown"
            )
            return f"{record.name}|{endpoint}|{status}|{bucket}"
        if record.name == "screen_view":
            return f"screen_view|{context.get('screen', 'unknown')}"
        if record.name == "preference_changed":
            setting = context.get("setting", "unknown")
            value = context.get("value", "unknown")
            return f"preference_changed|{setting}|{value}"
        if record.name == "map_match_changed":
            return f"map_match_changed|{context.get('mode', 'unknown')}"
        return None

    @staticmethod
    def _duration_bucket(value: int | float) -> str:
        if value < 100:
            return "<100ms"
        if value < 250:
            return "100-249ms"
        if value < 500:
            return "250-499ms"
        if value < 1_000:
            return "500-999ms"
        if value < 2_000:
            return "1-2s"
        if value < 5_000:
            return "2-5s"
        return ">=5s"
