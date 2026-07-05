import asyncio
import httpx
import json

BASE_URL = "http://localhost:8000"

async def main():
    async with httpx.AsyncClient(timeout=10.0) as client:
        # 1. Find a route that actually has trip updates to get a rich sample
        print("🔍 Searching for an active route with trip updates...")
        r = await client.get(f"{BASE_URL}/api/v1/atm_rt/trips")
        if r.status_code != 200:
            print("Failed to fetch trips")
            return
            
        trips = r.json()
        if not trips:
            print("No active trips found anywhere. Falling back to M30.")
            target_route = "AMB_415" # M30 fallback
        else:
            # Group by route_id
            route_counts = {}
            for t in trips:
                rid = t.get("route_id")
                if rid:
                    route_counts[rid] = route_counts.get(rid, 0) + 1
            
            # Pick the route with the most trips
            if route_counts:
                target_route = max(route_counts, key=route_counts.get)
                print(f"🚌 Found active route: {target_route} with {route_counts[target_route]} trips!")
            else:
                print("No route_ids found in trips. Falling back to M30.")
                target_route = "AMB_415"

        print(f"\n📥 Fetching all data payloads for route {target_route}...")
        
        # 2. Fetch all endpoints
        shapes = await client.get(f"{BASE_URL}/api/v1/gtfs/shapes/{target_route}")
        stops = await client.get(f"{BASE_URL}/api/v1/gtfs/stops/{target_route}")
        rt_vehicles = await client.get(f"{BASE_URL}/api/v1/atm_rt/vehicles/{target_route}")
        rt_trips = await client.get(f"{BASE_URL}/api/v1/atm_rt/trips/{target_route}")
        rt_alerts = await client.get(f"{BASE_URL}/api/v1/atm_rt/alerts")

        # 3. Filter alerts for this route
        all_alerts = rt_alerts.json() if rt_alerts.status_code == 200 else []
        route_alerts = [a for a in all_alerts if target_route in a.get("affected_route_ids", [])]

        # 4. Construct merged payload
        merged_payload = {
            "metadata": {
                "route_id": target_route,
                "timestamp": __import__('datetime').datetime.now().isoformat()
            },
            "static_data": {
                "shapes": shapes.json() if shapes.status_code == 200 else None,
                "stops": stops.json() if stops.status_code == 200 else []
            },
            "realtime_data": {
                "vehicles": rt_vehicles.json() if rt_vehicles.status_code == 200 else [],
                "trip_updates": rt_trips.json() if rt_trips.status_code == 200 else [],
                "service_alerts": route_alerts
            }
        }

        # 5. Save to file
        with open("sample_route_data.json", "w", encoding="utf-8") as f:
            json.dump(merged_payload, f, indent=2, ensure_ascii=False)
            
        print("\n✅ Successfully saved COMPLETE payload to sample_route_data.json")
        print("\n📊 HIGH-LEVEL PAYLOAD SUMMARY:")
        print(f"  - Route ID: {target_route}")
        
        static = merged_payload["static_data"]
        rt = merged_payload["realtime_data"]
        
        if static["shapes"]:
            coords = static["shapes"].get("geojson", {}).get("geometry", {}).get("coordinates", [])
            print(f"  - Static Shapes: {len(coords)} points")
        else:
            print("  - Static Shapes: None")
            
        print(f"  - Static Stops: {len(static['stops'])} stops")
        print(f"  - Live Vehicles: {len(rt['vehicles'])}")
        print(f"  - Live Trip Updates: {len(rt['trip_updates'])}")
        print(f"  - Active Alerts: {len(rt['service_alerts'])}")
        
        print("\n  Sample Vehicle Keys:", list(rt['vehicles'][0].keys()) if rt['vehicles'] else "N/A")
        if rt['trip_updates'] and rt['trip_updates'][0].get("stop_time_updates"):
            print("  Sample Trip Update Keys:", list(rt['trip_updates'][0].keys()))
            print("  Sample Stop Time Update Keys:", list(rt['trip_updates'][0]["stop_time_updates"][0].keys()))

if __name__ == "__main__":
    asyncio.run(main())
