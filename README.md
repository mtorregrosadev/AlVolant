# Route-TMB BFF

Backend-For-Frontend (BFF) service for the Barcelona Bus Driver Situational Awareness application. This service acts as a centralized gateway to ingest static and real-time transit data from the ATM (T-mobilitat) API, normalize it, and serve it to frontend clients.

## Architecture

```text
                              +--------------------+
                              | ATM T-mobilitat    |
                              | (Production API)   |
                              +---------+----------+
                                        |
      +---------------------------------+---------------------------------+
      |                                 |                                 |
      v                                 v                                 v
+----------------+              +----------------+                +----------------+
|  Static GTFS   |              | GTFS-RT Feeds  |                | GTFS-RT Feeds  |
|  (ZIP Load)    |              | (TripUpdates,  |                | (Alerts)       |
|    Daily       |              |  Vehicles)     |                |                |
+-------+--------+              +-------+--------+                +-------+--------+
        |                               |                                 |
        |     +-------------------------v---------------------------+     |
        |     |                   Workers (30s)                     |     |
        |     |   (Downloads via curl to bypass Imperva WAF)        |     |
        |     +-------------------------+---------------------------+     |
        |                               |                                 |
        v                               v                                 v
+----------------------------------------------------------------------------------+
|                                    Redis Cache                                   |
|   (Shapes, Meta, Trip Updates, Vehicle Positions, Service Alerts, Geometries)    |
+---------------------------------------+------------------------------------------+
                                        |
+---------------------------------------v------------------------------------------+
|                                 FastAPI Gateway                                  |
|                               (Backend-For-Frontend)                             |
+---------+-------------------+--------------------+--------------------+----------+
          |                   |                    |                    |
          v                   v                    v                    v
  [ /api/v1/gtfs/* ] [ /api/v1/atm_rt/* ] [ /api/v1/merged/* ] [ /ws/v1/route/{id} ]
          |                   |                    |                    |
          +-------------------+--------------------+--------------------+
                                        |
                                        v
                              +--------------------+
                              | Tablet Application |
                              +--------------------+
```

## Prerequisites and Configuration

1. **Environment Configuration**
   Copy the example environment file and configure the target API URLs:
   ```bash
   cp .env.example .env
   ```

   Ensure the ATM endpoints are defined as follows:
   ```ini
   ATM_RT_TRIP_UPDATES_URL=https://t-mobilitat.atm.cat/opendata/trip_updates/user/token/open
   ATM_RT_ALERTS_URL=https://t-mobilitat.atm.cat/opendata/alerts/user/token/open
   ATM_RT_VEHICLE_POSITIONS_URL=https://t-mobilitat.atm.cat/opendata/vehicle_positions/user/token/open
   ATM_GTFS_URL=https://t-mobilitat.atm.cat/opendata/static/download/
   ```

2. **System Requirements**
   - Python 3.12+
   - Redis server (or Docker for containerized deployment)
   - `curl` available in the system PATH

## Running the Application

Start the required infrastructure and the FastAPI server:

```bash
# Start the Redis cache
docker compose up -d redis

# Activate the virtual environment
source .venv/bin/activate

# Start the FastAPI server via Uvicorn
uvicorn app.main:app --host 0.0.0.0 --port 8000
```
*Note: Initial startup requires approximately 30-60 seconds to download and parse the static GTFS ZIP payload into Redis.*

## API Endpoints

The API documentation is available via Swagger UI at `http://localhost:8000/docs` when the server is running.

### Static GTFS Data
* `GET /api/v1/gtfs/routes` - List all active ATM routes.
* `GET /api/v1/gtfs/shapes/{route_id}` - Retrieve GeoJSON LineStrings defining the physical path of a route.
* `GET /api/v1/gtfs/stops/{route_id}` - Retrieve GeoJSON Points for all stops serviced by a route.

### Real-Time Data (GTFS-RT)
* `GET /api/v1/atm_rt/vehicles` - List of all active vehicles across the entire network.
* `GET /api/v1/atm_rt/vehicles/{route_id}` - List of active vehicles filtered by specific route.
* `GET /api/v1/atm_rt/trips` - All real-time stop time updates (network-wide).
* `GET /api/v1/atm_rt/trips/{route_id}` - Real-time stop time updates filtered by specific route.
* `GET /api/v1/atm_rt/alerts` - System-wide service alerts and disruption notifications.
* `GET /api/v1/atm_rt/feed` - The complete, raw merged JSON dump of all real-time data.

### WebSockets
* `WS /ws/v1/route/{route_id}` - Real-time, bidirectional connection pushing merged static and live data at 30-second intervals to the connected client.
