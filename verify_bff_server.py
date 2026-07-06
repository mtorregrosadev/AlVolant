#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║         Route-TMB BFF — Unified ATM Integration Verification                 ║
║                                                                              ║
║  Acts as a dummy driver-tablet client. Queries the unified ATM endpoints     ║
║  for a specific route to validate the full data contract.                    ║
║                                                                              ║
║  Usage:                                                                      ║
║      python verify_bff_server.py --route-id M30                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime
from typing import Any

import httpx

# ─────────────────────────────────────────────────────────────────────────────
# ANSI color codes for beautiful terminal output
# ─────────────────────────────────────────────────────────────────────────────
C_RESET = "\033[0m"
C_BOLD = "\033[1m"
C_DIM = "\033[2m"
C_GREEN = "\033[92m"
C_RED = "\033[91m"
C_YELLOW = "\033[93m"
C_CYAN = "\033[96m"
C_MAGENTA = "\033[95m"
C_BLUE = "\033[94m"
C_WHITE = "\033[97m"

BOX_H = "─"
BOX_V = "│"
BOX_TL = "┌"
BOX_TR = "┐"
BOX_BL = "└"
BOX_BR = "┘"

CHECK = f"{C_GREEN}✔{C_RESET}"
CROSS = f"{C_RED}✘{C_RESET}"
WARN = f"{C_YELLOW}⚠{C_RESET}"
ARROW = f"{C_CYAN}→{C_RESET}"
BUS = "🚌"
MAP = "🗺️ "
ALERT_ICON = "🚨"


def banner(title: str) -> None:
    width = 72
    print(f"\n{C_CYAN}{BOX_TL}{BOX_H * width}{BOX_TR}{C_RESET}")
    print(f"{C_CYAN}{BOX_V}{C_BOLD}{C_WHITE}  {title:<{width - 2}}{C_RESET}{C_CYAN}{BOX_V}{C_RESET}")
    print(f"{C_CYAN}{BOX_BL}{BOX_H * width}{BOX_BR}{C_RESET}")


def result_line(label: str, value: Any, status: str = "ok") -> None:
    icon = CHECK if status == "ok" else (CROSS if status == "fail" else WARN)
    print(f"  {icon}  {C_BOLD}{label:<30}{C_RESET} {C_WHITE}{value}{C_RESET}")


async def safe_get(client: httpx.AsyncClient, url: str) -> tuple[Any, int]:
    """Make a GET request and return JSON and status code."""
    try:
        resp = await client.get(url)
        if resp.status_code == 200:
            return resp.json(), 200
        return None, resp.status_code
    except Exception:
        return None, 0


async def main(base_url: str, route_id: str) -> int:
    start_time = time.monotonic()

    print(f"\n  {C_BOLD}{C_WHITE}╔{'═' * 70}╗{C_RESET}")
    print(f"  {C_BOLD}{C_WHITE}║  {BUS} Route-TMB BFF — Unified ATM Route Verification{' ' * 19}║{C_RESET}")
    print(f"  {C_BOLD}{C_WHITE}╚{'═' * 70}╝{C_RESET}")
    print(f"\n  {C_DIM}Server:{C_RESET}   {C_CYAN}{base_url}{C_RESET}")
    print(f"  {C_DIM}Route ID:{C_RESET} {C_CYAN}{route_id}{C_RESET}")
    print(f"  {C_DIM}Time:{C_RESET}     {C_CYAN}{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}{C_RESET}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Pre-check health
        data, code = await safe_get(client, f"{base_url}/health")
        if code == 0:
            print(f"\n  {CROSS}  {C_RED}{C_BOLD}Cannot connect to {base_url}. Is the server running?{C_RESET}\n")
            return 1

        # 0. RESOLVE ROUTE ID
        routes, r_code = await safe_get(client, f"{base_url}/api/v1/gtfs/routes")
        internal_route_id = route_id
        if r_code == 200 and isinstance(routes, list):
            for r in routes:
                if r.get("route_short_name") == route_id or r.get("route_id") == route_id:
                    internal_route_id = r.get("route_id")
                    break

        if internal_route_id != route_id:
            print(f"  {C_DIM}Resolved {route_id} to internal GTFS ID:{C_RESET} {C_CYAN}{internal_route_id}{C_RESET}\n")

        # 1. STATIC SHAPES
        banner(f"{MAP} 1 · STATIC GEOMETRY FOR {internal_route_id}")
        data, code = await safe_get(client, f"{base_url}/api/v1/gtfs/shapes/{internal_route_id}")
        if code == 200 and data:
            props = data.get("geojson", {}).get("properties", {})
            coords = data.get("geojson", {}).get("geometry", {}).get("coordinates", [])
            route_name = props.get("route_short_name", "") or props.get("route_long_name", "")
            color = props.get("route_color", "FFFFFF")

            result_line("Route Name", route_name)
            result_line("Color", f"#{color}")
            result_line("Points in Shape", len(coords), "ok" if len(coords) > 0 else "warn")
            if coords:
                result_line("Start Coord", f"[{coords[0][0]:.5f}, {coords[0][1]:.5f}]")
                result_line("End Coord", f"[{coords[-1][0]:.5f}, {coords[-1][1]:.5f}]")
        elif code == 503:
            result_line("Static Data", "Cache warming up (503)", "warn")
        else:
            result_line("Static Data", f"Not found or error (HTTP {code})", "fail")

        # 2. LIVE VEHICLES & ETAS
        banner(f"{BUS} 2 · LIVE DATA FOR {internal_route_id}")
        
        # Vehicles
        vehicles, v_code = await safe_get(client, f"{base_url}/api/v1/atm_rt/vehicles/{internal_route_id}")
        if v_code == 200 and isinstance(vehicles, list):
            result_line("Active Vehicles", len(vehicles), "ok" if vehicles else "warn")
            for i, v in enumerate(vehicles[:3]):
                vid = v.get("vehicle_id", "?")
                lat = v.get("latitude", 0)
                lon = v.get("longitude", 0)
                spd = v.get("speed", 0) or 0
                print(f"      {ARROW} {C_BOLD}{vid}{C_RESET} at [{lat:.4f}, {lon:.4f}] — {spd:.1f} m/s")
            if len(vehicles) > 3:
                print(f"      {C_DIM}... and {len(vehicles) - 3} more{C_RESET}")
        elif v_code == 503:
            result_line("Vehicles", "Cache warming up (503)", "warn")
        else:
            result_line("Vehicles", f"Failed (HTTP {v_code})", "fail")

        # Trips
        trips, t_code = await safe_get(client, f"{base_url}/api/v1/atm_rt/trips/{internal_route_id}")
        if t_code == 200 and isinstance(trips, list):
            result_line("Active Trip Updates", len(trips), "ok" if trips else "warn")
            for t in trips[:3]:
                tid = t.get("trip_id", "?")
                vid = t.get("vehicle_id", "(none)")
                stops = t.get("stop_time_updates", [])
                if stops:
                    s0 = stops[0]
                    delay = s0.get("arrival_delay", 0)
                    delay_str = f"{C_RED}+{delay}s late{C_RESET}" if delay > 0 else (f"{C_CYAN}{delay}s early{C_RESET}" if delay < 0 else f"{C_GREEN}on time{C_RESET}")
                    print(f"      {ARROW} Trip {C_BOLD}{tid}{C_RESET} (Bus {vid}): next stop {s0.get('stop_id')} is {delay_str}")
                else:
                    print(f"      {ARROW} Trip {C_BOLD}{tid}{C_RESET}: no stop predictions")
        else:
            result_line("Trip Updates", f"Failed (HTTP {t_code})", "fail")

        # 3. ALERTS
        banner(f"{ALERT_ICON} 3 · ACTIVE ALERTS FOR {internal_route_id}")
        alerts, a_code = await safe_get(client, f"{base_url}/api/v1/atm_rt/alerts")
        if a_code == 200 and isinstance(alerts, list):
            route_alerts = [a for a in alerts if internal_route_id in a.get("affected_route_ids", [])]
            result_line(f"Alerts mapped to {internal_route_id}", len(route_alerts), "ok" if not route_alerts else "warn")
            
            for a in route_alerts:
                header = a.get("header_text", "(no title)")
                cause = a.get("cause", "?")
                print(f"      {ALERT_ICON} {C_YELLOW}{header}{C_RESET}")
                print(f"         {C_DIM}Cause: {cause}{C_RESET}")
        else:
            result_line("Alerts", f"Failed (HTTP {a_code})", "fail")

    print()
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Verify unified ATM BFF server")
    parser.add_argument("--base-url", default="http://localhost:8000")
    parser.add_argument("--route-id", default="M30", help="Route ID to query")
    args = parser.parse_args()

    exit_code = asyncio.run(main(args.base_url, args.route_id))
    sys.exit(exit_code)
