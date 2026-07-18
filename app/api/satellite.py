"""Public but tightly bounded satellite tiles for the native map renderer."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import ORJSONResponse

from app.services.satellite_tile_service import (
    SatelliteTileClientQuotaExceededError,
    SatelliteTileNotFoundError,
    SatelliteTileQuotaExceededError,
    SatelliteTileUnavailableError,
    new_satellite_client_id,
    normalize_satellite_client_id,
)

router = APIRouter(prefix="/maps/satellite", include_in_schema=False)

# World Imagery permits a 24-hour cache. Do not extend it with a stale period:
# doing so would keep provider imagery beyond the policy used by this service.
_CACHE_CONTROL = "public, max-age=86400"


def _client_ip(request: Request) -> str:
    # Uvicorn only honours X-Forwarded-For from the configured local Caddy
    # proxy, so request.client cannot be selected by a direct remote client.
    return request.client.host if request.client else "unknown"


@router.get("/status")
async def get_satellite_status(
    request: Request,
    client_id: str | None = Query(default=None, max_length=100),
    z: int | None = Query(default=None, ge=0, le=20),
    x: int | None = Query(default=None, ge=0),
    y: int | None = Query(default=None, ge=0),
) -> ORJSONResponse:
    """Issue/return an opaque installation ID and current-area availability."""
    normalized_client_id = normalize_satellite_client_id(client_id) or new_satellite_client_id()
    tile = (z, x, y) if z is not None and x is not None and y is not None else None
    available = await request.app.state.satellite_tile_service.is_client_available(
        normalized_client_id,
        _client_ip(request),
        tile=tile,
    )
    return ORJSONResponse(
        {"available": available, "client_id": normalized_client_id},
        headers={"Cache-Control": "no-store"},
    )


@router.get("/style.json")
async def get_satellite_style(
    request: Request,
    client_id: str | None = Query(default=None, max_length=100),
) -> ORJSONResponse:
    """Return a non-cacheable style that binds tile requests to one installation."""
    normalized_client_id = normalize_satellite_client_id(client_id)
    if normalized_client_id is None:
        return ORJSONResponse({"error": "satellite_client_required"}, status_code=404)

    base_url = str(request.base_url).rstrip("/")
    tile_url = f"{base_url}/maps/satellite/{{z}}/{{x}}/{{y}}.jpg?client_id={normalized_client_id}"
    return ORJSONResponse(
        {
            "version": 8,
            "name": "AlVolant World Imagery",
            "sources": {
                "satellite": {
                    "type": "raster",
                    "tiles": [tile_url],
                    "tileSize": 256,
                    "minzoom": 0,
                    "maxzoom": 20,
                    "attribution": "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
                }
            },
            "layers": [{
                "id": "satellite",
                "type": "raster",
                "source": "satellite",
                "paint": {
                    "raster-saturation": -0.08,
                    "raster-contrast": 0.06,
                    "raster-fade-duration": 180,
                },
            }],
        },
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{z}/{x}/{y}.jpg")
async def get_satellite_tile(
    z: int,
    x: int,
    y: int,
    request: Request,
    client_id: str | None = Query(default=None, max_length=100),
) -> Response:
    """Return a cached JPEG only for map tiles that intersect Catalonia."""
    normalized_client_id = normalize_satellite_client_id(client_id)
    if normalized_client_id is None:
        # Keep the public source non-enumerable without handing MapLibre an
        # authentication detail that it cannot attach as a header.
        return Response(status_code=404, headers={"Cache-Control": "no-store"})
    try:
        image = await request.app.state.satellite_tile_service.get_tile(
            z,
            x,
            y,
            client_id=normalized_client_id,
            client_ip=_client_ip(request),
        )
    except SatelliteTileNotFoundError:
        return Response(status_code=404, headers={"Cache-Control": _CACHE_CONTROL})
    except SatelliteTileClientQuotaExceededError:
        return Response(
            status_code=429,
            headers={
                "Cache-Control": "no-store",
                "Retry-After": "60",
                "X-Satellite-Disabled": "client-quota",
            },
        )
    except SatelliteTileQuotaExceededError:
        return Response(status_code=429, headers={"Cache-Control": "no-store", "Retry-After": "60"})
    except SatelliteTileUnavailableError:
        return Response(status_code=503, headers={"Retry-After": "30"})
    return Response(
        content=image,
        media_type="image/jpeg",
        headers={"Cache-Control": _CACHE_CONTROL},
    )
