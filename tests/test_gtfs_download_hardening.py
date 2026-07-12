"""Security limits for downloading and extracting the static GTFS feed."""

from __future__ import annotations

import io
import zipfile
from collections.abc import AsyncIterator

import httpx
import pytest

import app.services.gtfs_service as gtfs_module
from app.cache.redis_manager import CacheManager
from app.config import Settings
from app.core.exceptions import ExternalAPIError, GTFSParseError
from app.services.gtfs_service import GTFSService

_OFFICIAL_URL = "https://t-mobilitat.atm.cat/opendata/static/download/"


class _SingleChunkStream(httpx.AsyncByteStream):
    def __init__(self, content: bytes) -> None:
        self._content = content

    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield self._content

    async def aclose(self) -> None:
        return None


def _settings(settings: Settings, url: str = _OFFICIAL_URL) -> Settings:
    return settings.model_copy(update={"ATM_GTFS_URL": url})


def _archive(*, extra_entries: list[tuple[str, bytes]] | None = None) -> bytes:
    required = {
        "shapes.txt": b"shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n",
        "routes.txt": b"route_id,route_short_name,route_type\n",
        "trips.txt": b"route_id,service_id,trip_id,shape_id\n",
        "stops.txt": b"stop_id,stop_name,stop_lat,stop_lon\n",
        "stop_times.txt": b"trip_id,arrival_time,departure_time,stop_id,stop_sequence\n",
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, content in required.items():
            zf.writestr(name, content)
        for name, content in extra_entries or []:
            zf.writestr(name, content)
    return output.getvalue()


@pytest.mark.asyncio
async def test_download_rejects_non_https_and_non_official_hosts(
    settings: Settings,
    cache: CacheManager,
) -> None:
    for url in (
        "http://t-mobilitat.atm.cat/opendata/static/download/",
        "https://127.0.0.1/opendata/static/download/",
        "https://evil.invalid/opendata/static/download/",
    ):
        service = GTFSService(_settings(settings, url), cache)
        with pytest.raises(ExternalAPIError, match="origin is not allowed") as exc_info:
            await service._download_gtfs_zip()
        assert url not in str(exc_info.value)


@pytest.mark.asyncio
async def test_download_rejects_cross_origin_redirect_without_following_it(
    settings: Settings,
    cache: CacheManager,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(302, headers={"Location": "https://evil.invalid/feed.zip"})

    service = GTFSService(_settings(settings), cache)
    service._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ExternalAPIError, match="origin is not allowed") as exc_info:
            await service._download_gtfs_zip()
    finally:
        await service._http.aclose()

    assert len(requests) == 1
    assert "evil.invalid" not in str(exc_info.value)


@pytest.mark.asyncio
async def test_streaming_download_enforces_compressed_size_limit(
    settings: Settings,
    cache: CacheManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(gtfs_module, "_MAX_GTFS_ZIP_BYTES", 16)

    def handler(request: httpx.Request) -> httpx.Response:
        # No Content-Length: the incremental counter must still stop the body.
        return httpx.Response(200, stream=_SingleChunkStream(b"x" * 17))

    service = GTFSService(_settings(settings), cache)
    service._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ExternalAPIError, match="exceeds size limit"):
            await service._download_gtfs_zip()
    finally:
        await service._http.aclose()


def test_extract_accepts_bounded_flat_gtfs_archive() -> None:
    extracted = GTFSService._extract_gtfs_files(_archive())

    assert len(extracted) == 7
    assert extracted[0].startswith("shape_id,")
    assert extracted[5:] == ("", "")


@pytest.mark.parametrize(
    "unsafe_name",
    ["../escape.txt", "/absolute.txt", "folder/nested.txt", "folder\\nested.txt"],
)
def test_extract_rejects_unsafe_entry_names(unsafe_name: str) -> None:
    archive = _archive(extra_entries=[(unsafe_name, b"not trusted")])

    with pytest.raises(GTFSParseError, match="unsafe entries") as exc_info:
        GTFSService._extract_gtfs_files(archive)

    assert unsafe_name not in str(exc_info.value)


def test_extract_rejects_suspicious_compression_ratio() -> None:
    archive = _archive(extra_entries=[("padding.txt", b"A" * 1_000_000)])

    with pytest.raises(GTFSParseError, match="compression ratio is unsafe"):
        GTFSService._extract_gtfs_files(archive)


def test_extract_rejects_duplicate_entry_names() -> None:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("shapes.txt", b"first")
        with pytest.warns(UserWarning, match="Duplicate name"):
            zf.writestr("shapes.txt", b"second")

    with pytest.raises(GTFSParseError, match="unsafe entries"):
        GTFSService._extract_gtfs_files(output.getvalue())


def test_extract_enforces_declared_uncompressed_entry_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(gtfs_module, "_MAX_GTFS_ENTRY_UNCOMPRESSED_BYTES", 32)

    with pytest.raises(GTFSParseError, match="entry size limit exceeded"):
        GTFSService._extract_gtfs_files(_archive())


def test_extract_enforces_compressed_archive_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    archive = _archive()
    monkeypatch.setattr(gtfs_module, "_MAX_GTFS_ZIP_BYTES", len(archive) - 1)

    with pytest.raises(GTFSParseError, match="Archive size limit exceeded"):
        GTFSService._extract_gtfs_files(archive)


def test_csv_parsers_filter_non_bus_rows_and_store_compact_stop_times() -> None:
    parsed = GTFSService._parse_stop_times(
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "bus-trip,08:00:00,08:01:00,A,1\n"
        "rail-trip,08:00:00,08:01:00,B,1\n",
        {"bus-trip"},
    )

    assert parsed == {"bus-trip": [("A", 1, "08:01:00")]}


def test_csv_row_and_field_limits_are_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gtfs_module, "_MAX_ROUTE_ROWS", 1)
    with pytest.raises(GTFSParseError, match="row limit"):
        GTFSService._parse_routes(
            "route_id,route_short_name,route_type\n"
            "one,1,3\n"
            "two,2,3\n"
        )

    with pytest.raises(GTFSParseError, match="field limit"):
        GTFSService._parse_routes(
            "route_id,route_short_name,route_type\n"
            f"{'x' * 161},1,3\n"
        )
