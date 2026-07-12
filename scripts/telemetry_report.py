#!/usr/bin/env python3
"""Read a local, privacy-scrubbed telemetry report directly from Redis."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from datetime import UTC, datetime, timedelta
from typing import Any

import orjson
from redis.asyncio import Redis


def _decode_hash(value: dict[bytes, bytes]) -> dict[str, int]:
    return {
        key.decode("utf-8", errors="replace"): int(count)
        for key, count in value.items()
    }


async def build_report(redis_url: str, days: int, error_limit: int) -> dict[str, Any]:
    client = Redis.from_url(redis_url, decode_responses=False)
    counts: dict[str, int] = {}
    dimensions: dict[str, int] = {}
    errors: list[dict[str, Any]] = []
    day_labels = [
        (datetime.now(UTC) - timedelta(days=offset)).strftime("%Y-%m-%d")
        for offset in range(days)
    ]

    try:
        for day in day_labels:
            for target, key in (
                (counts, f"telemetry:counts:{day}"),
                (dimensions, f"telemetry:dimensions:{day}"),
            ):
                for name, count in _decode_hash(await client.hgetall(key)).items():
                    target[name] = target.get(name, 0) + count

            raw_errors = await client.lrange(f"telemetry:errors:{day}", 0, error_limit - 1)
            errors.extend(orjson.loads(raw) for raw in raw_errors)
    finally:
        await client.aclose()

    errors.sort(key=lambda item: item.get("received_at_ms", 0), reverse=True)
    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "days": day_labels,
        "counts": dict(sorted(counts.items())),
        "dimensions": dict(sorted(dimensions.items())),
        "recent_errors": errors[:error_limit],
    }


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7, choices=range(1, 31))
    parser.add_argument("--errors", type=int, default=50, choices=range(1, 501))
    parser.add_argument("--redis-url", default=os.getenv("REDIS_URL", "redis://localhost:6379/0"))
    args = parser.parse_args()
    report = await build_report(args.redis_url, args.days, args.errors)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
