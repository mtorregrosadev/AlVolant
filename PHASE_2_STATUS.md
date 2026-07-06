# Phase 2 Status: Frontend MVP

## Where We Left Off

We have officially kickstarted the Phase 2 (Frontend) development by establishing the `app-conductor` mobile application. 

**Completed Milestones:**
1. **Workspace setup:** Initialized a new React Native (Expo) TypeScript project.
2. **Map Integration:** Installed `@maplibre/maplibre-react-native` and configured `App.tsx` to display a full-screen vector map utilizing Carto Positron basemap tiles.
3. **BFF Connection:** Built the `api.ts` service to securely connect to the Python backend (`http://localhost:8000`) passing the `X-API-Key`. A WebSocket connection stream is also successfully initialized.
4. **Drawing the Route:** The frontend fetches the M30 (`AMB_415`) route geometry dynamically from the BFF and draws it on the map as a thick blue line.

**Current Blockers & Observations:**
- **Stop Coordinates:** We skipped rendering the 72 "IDA" stops because the `static_data.stops` objects currently lack geographic coordinates (`lat`/`lon`). 
- **OS Limitations:** An attempt to run `npx expo run:ios` failed because iOS apps can only be compiled on macOS. Since you are on Linux, you must test via Android.

---

## What We Have To Do Next

1. **Test on Android:** 
   - Boot up your Android Emulator.
   - Run `npx expo run:android` inside `app-conductor/` to compile the custom MapLibre native code and launch the MVP screen.
2. **Enhance GTFS Stop Data (Backend):** 
   - Update the Python BFF service (`app/services/gtfs_service.py` or similar) to parse and include latitude/longitude coordinates for all static stops.
   - Either create a new `/api/v1/gtfs/stops/{route_id}` endpoint or bundle the stops directly inside the route shapes response.
3. **Render Stop Markers (Frontend):** 
   - Once the BFF provides coordinates, update `App.tsx` to render the 72 "IDA" stops as MapLibre `SymbolLayer` or `CircleLayer` markers along the route.
4. **Real-time Bus Tracking:** 
   - Implement the WebSocket message parsing in `App.tsx` to listen for vehicle location updates.
   - Add a dynamic marker (e.g., a bus icon) that moves along the map when the backend emits real-time coordinate changes.
