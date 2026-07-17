"""Public but tightly bounded satellite tiles for the native map renderer."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response

from app.services.satellite_tile_service import (
    SatelliteTileNotFoundError,
    SatelliteTileQuotaExceededError,
    SatelliteTileUnavailableError,
)

router = APIRouter(prefix="/maps/satellite", include_in_schema=False)

# World Imagery currently permits a 24-hour cache.  Keep the public cache to
# that same policy and avoid prefetching or keeping an indefinite mosaic.
_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800"


@router.get("/status")
async def get_satellite_status(request: Request) -> Response:
    """Expose only availability so the native client can disable the option."""
    available = await request.app.state.satellite_tile_service.is_available()
    return Response(
        content=f'{{"available":{str(available).lower()}}}',
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{z}/{x}/{y}.jpg")
async def get_satellite_tile(z: int, x: int, y: int, request: Request) -> Response:
    """Return a cached JPEG only for map tiles that intersect Catalonia."""
    try:
        image = await request.app.state.satellite_tile_service.get_tile(z, x, y)
    except SatelliteTileNotFoundError:
        return Response(status_code=404, headers={"Cache-Control": _CACHE_CONTROL})
    except SatelliteTileQuotaExceededError:
        return Response(status_code=429, headers={"Cache-Control": "no-store", "Retry-After": "60"})
    except SatelliteTileUnavailableError:
        return Response(status_code=503, headers={"Retry-After": "30"})
    return Response(
        content=image,
        media_type="image/jpeg",
        headers={"Cache-Control": _CACHE_CONTROL},
    )
