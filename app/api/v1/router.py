"""
Aggregated v1 API router.

Mounts all v1 sub-routers (ATM RT, GTFS, WebSocket) under the
``/api/v1`` prefix.
"""

from fastapi import APIRouter

from app.api.v1.atm_rt import router as atm_rt_router
from app.api.v1.gtfs import router as gtfs_router
from app.api.v1.traffic import router as traffic_router
from app.api.v1.ws import router as ws_router

v1_router = APIRouter(prefix="/api/v1")

v1_router.include_router(atm_rt_router)
v1_router.include_router(gtfs_router)
v1_router.include_router(traffic_router)
v1_router.include_router(ws_router)
