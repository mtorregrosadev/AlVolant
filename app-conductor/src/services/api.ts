import { NativeModules, Platform } from 'react-native';
import {
  telemetry,
  type TelemetryBatch,
  type TelemetryEndpoint,
} from './telemetry';

const BFF_PORT = 8000;
const REQUEST_TIMEOUT_MS = 12_000;
const API_KEY = (process.env.EXPO_PUBLIC_BFF_API_KEY ?? '').trim();

function getMetroHost() {
  const scriptURL = NativeModules.SourceCode?.scriptURL as string | undefined;
  const match = scriptURL?.match(/^https?:\/\/([^/:]+)(?::\d+)?\//);

  return match?.[1];
}

function getBffHost() {
  const metroHost = getMetroHost();

  if (metroHost && metroHost !== 'localhost' && metroHost !== '127.0.0.1') {
    return metroHost;
  }

  return Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
}

function normalizeBaseUrl(value: string | undefined) {
  const configured = value?.trim().replace(/\/+$/, '');
  return configured || `http://${getBffHost()}:${BFF_PORT}`;
}

export const BASE_URL = normalizeBaseUrl(process.env.EXPO_PUBLIC_BFF_URL);
export const WS_URL = BASE_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');

function assertSecureConfiguration() {
  if (!API_KEY || API_KEY.length > 512 || /[\u0000-\u001F\u007F]/.test(API_KEY)) {
    throw new ApiError('Falta la configuració segura del BFF.');
  }

  if (!__DEV__ && !BASE_URL.startsWith('https://')) {
    throw new ApiError('El BFF de producció ha d’utilitzar HTTPS.');
  }
}

function encodePathSegment(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001F\u007F]/.test(normalized)) {
    throw new ApiError('Identificador de ruta no vàlid.');
  }

  return encodeURIComponent(normalized);
}

function createQuery(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  });

  const serialized = query.toString();
  return serialized ? `?${serialized}` : '';
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

type JsonRequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  endpoint?: TelemetryEndpoint;
  reportTelemetry?: boolean;
};

async function requestJson<T>(path: string, options: JsonRequestOptions = {}): Promise<T> {
  assertSecureConfiguration();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const method = options.method ?? 'GET';
  const startedAt = Date.now();
  const shouldReport = options.reportTelemetry !== false && Boolean(options.endpoint);
  let reportedError = false;

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'X-API-Key': API_KEY,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
      signal: controller.signal,
    });

    if (!response.ok) {
      if (shouldReport) {
        telemetry.capture('api_error', {
          endpoint: options.endpoint,
          method,
          status: response.status,
          duration_ms: Date.now() - startedAt,
          error_type: 'HttpError',
        });
        reportedError = true;
      }
      throw new ApiError('El BFF no ha pogut completar la petició.', response.status);
    }

    try {
      const body = await response.json() as T;
      if (shouldReport) {
        telemetry.capture('api_request', {
          endpoint: options.endpoint,
          method,
          status: response.status,
          duration_ms: Date.now() - startedAt,
        });
      }
      return body;
    } catch {
      if (shouldReport) {
        telemetry.capture('api_error', {
          endpoint: options.endpoint,
          method,
          status: 'parse',
          duration_ms: Date.now() - startedAt,
          error_type: 'ParseError',
        });
        reportedError = true;
      }
      throw new ApiError('El BFF ha retornat una resposta no vàlida.');
    }
  } catch (error) {
    if (isAbortError(error)) {
      if (shouldReport && !reportedError) {
        telemetry.capture('api_error', {
          endpoint: options.endpoint,
          method,
          status: 'timeout',
          duration_ms: Date.now() - startedAt,
          error_type: 'TimeoutError',
        });
      }
      throw new ApiError('El BFF ha trigat massa a respondre.');
    }

    if (error instanceof ApiError) {
      throw error;
    }

    if (shouldReport && !reportedError) {
      telemetry.capture('api_error', {
        endpoint: options.endpoint,
        method,
        status: 'network',
        duration_ms: Date.now() - startedAt,
        error_type: error instanceof Error ? error.name : 'NetworkError',
      });
    }
    throw new ApiError('No s’ha pogut connectar amb el BFF.');
  } finally {
    clearTimeout(timeout);
  }
}

export interface GTFSFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: {
      route_id: string;
      shape_id: string;
      route_short_name: string;
      route_long_name: string;
      route_color: string;
    };
    geometry: {
      type: 'LineString';
      coordinates: [number, number][];
    };
  }>;
}

export interface DirectionDestination {
  direction_id: number;
  destination_name: string;
  label: string;
}

export interface RouteInfo {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_color: string;
  route_text_color: string;
  route_type: number;
  agency_id: string;
  route_ids?: string[];
  direction_destinations?: DirectionDestination[];
  display_name?: string;
}

export interface NearbyRouteDistance {
  route_id: string;
  distance_meters: number;
}

export interface UpcomingTrip {
  trip_id: string;
  route_id: string;
  service_id: string;
  trip_headsign: string;
  departure_time: string;
  scheduled_epoch: number;
  expected_departure_epoch: number;
  delay_seconds: number | null;
  has_rt_first_stop_update: boolean;
  origin_stop_name: string;
  destination_name: string;
  towards_label: string;
  trip_status: 'scheduled' | 'on_time' | 'delayed' | 'early';
  is_maintenance?: boolean;
}

export interface VehiclePosition {
  vehicle_id: string;
  route_id: string;
  trip_id: string;
  latitude: number;
  longitude: number;
  bearing: number | null;
  speed: number | null;
  timestamp: number;
}

export interface RTStopTimeUpdate {
  stop_id: string;
  stop_sequence: number;
  arrival_delay: number;
  departure_delay: number;
}

export interface RTTripUpdate {
  trip_id: string;
  route_id: string;
  vehicle_id: string;
  start_date: string;
  stop_time_updates: RTStopTimeUpdate[];
  timestamp: number;
}

export interface TrafficSummary {
  label: string;
  status: 'normal' | 'dense' | 'slow' | 'jammed' | 'closed' | 'unavailable';
  source: string;
  current_speed_kmh: number | null;
  free_flow_speed_kmh: number | null;
  delay_seconds: number | null;
  confidence: number | null;
  road_closure: boolean;
}

let routesRequest: Promise<RouteInfo[]> | null = null;

export const apiService = {
  fetchRouteShape(routeId: string, directionId?: number, tripId?: string) {
    const route = encodePathSegment(routeId);
    const query = createQuery({ direction_id: directionId, trip_id: tripId });
    return requestJson<any>(`/api/v1/gtfs/shapes/${route}${query}`, { endpoint: 'route_shape' });
  },

  fetchRouteStops(routeId: string, directionId?: number, tripId?: string) {
    const route = encodePathSegment(routeId);
    const query = createQuery({ direction_id: directionId, trip_id: tripId });
    return requestJson<any>(`/api/v1/gtfs/stops/${route}${query}`, { endpoint: 'route_stops' });
  },

  fetchRoutes(): Promise<RouteInfo[]> {
    if (!routesRequest) {
      routesRequest = requestJson<RouteInfo[]>('/api/v1/gtfs/routes', { endpoint: 'routes' })
        .then((routes) => Array.isArray(routes) ? routes : [])
        .finally(() => {
          routesRequest = null;
        });
    }

    return routesRequest;
  },

  fetchNearbyRoutes(
    latitude: number,
    longitude: number,
    limit = 40,
  ): Promise<NearbyRouteDistance[]> {
    if (
      !Number.isFinite(latitude)
      || !Number.isFinite(longitude)
      || latitude < -90
      || latitude > 90
      || longitude < -180
      || longitude > 180
    ) {
      return Promise.reject(new ApiError('Ubicació no vàlida.'));
    }

    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(40, Math.trunc(limit)))
      : 40;
    return requestJson<NearbyRouteDistance[]>('/api/v1/gtfs/routes/nearby', {
      method: 'POST',
      endpoint: 'nearby_routes',
      body: {
        latitude: Math.round(latitude * 1000) / 1000,
        longitude: Math.round(longitude * 1000) / 1000,
        limit: normalizedLimit,
      },
    }).then((items) => Array.isArray(items)
      ? items.filter((item) => (
        typeof item?.route_id === 'string'
        && Number.isFinite(item?.distance_meters)
        && item.distance_meters >= 0
      )).slice(0, normalizedLimit)
      : []);
  },

  fetchUpcomingTrips(routeId: string, directionId: number): Promise<UpcomingTrip[]> {
    if (directionId !== 0 && directionId !== 1) {
      return Promise.reject(new ApiError('Direcció de ruta no vàlida.'));
    }

    const route = encodePathSegment(routeId);
    return requestJson<UpcomingTrip[]>(
      `/api/v1/gtfs/routes/${route}/upcoming-trips${createQuery({ direction_id: directionId })}`,
      { endpoint: 'upcoming_trips' },
    ).then((trips) => Array.isArray(trips) ? trips : []);
  },

  fetchRouteVehicles(routeId: string): Promise<VehiclePosition[]> {
    const route = encodePathSegment(routeId);
    return requestJson<VehiclePosition[]>(`/api/v1/atm_rt/vehicles/${route}`, { endpoint: 'route_vehicles' })
      .then((vehicles) => Array.isArray(vehicles) ? vehicles : []);
  },

  fetchRouteTripUpdates(routeId: string): Promise<RTTripUpdate[]> {
    const route = encodePathSegment(routeId);
    return requestJson<RTTripUpdate[]>(`/api/v1/atm_rt/trips/${route}`, { endpoint: 'route_updates' })
      .then((updates) => Array.isArray(updates) ? updates : []);
  },

  fetchTrafficSummary(latitude: number, longitude: number): Promise<TrafficSummary> {
    if (
      !Number.isFinite(latitude)
      || !Number.isFinite(longitude)
      || latitude < -90
      || latitude > 90
      || longitude < -180
      || longitude > 180
    ) {
      return Promise.reject(new ApiError('Coordenades no vàlides.'));
    }

    return requestJson<TrafficSummary>(
      `/api/v1/traffic/summary${createQuery({ latitude, longitude })}`,
      { endpoint: 'traffic_summary' },
    );
  },

  connectWebSocket(onMessage?: (data: unknown) => void) {
    assertSecureConfiguration();
    const NativeWebSocket = WebSocket as unknown as new (
      url: string,
      protocols?: string | string[] | null,
      options?: { headers: Record<string, string> },
    ) => WebSocket;
    const ws = new NativeWebSocket(`${WS_URL}/api/v1/ws/live`, null, {
      headers: { 'X-API-Key': API_KEY },
    });

    ws.onmessage = (event) => {
      if (!onMessage || typeof event.data !== 'string') {
        return;
      }

      try {
        onMessage(JSON.parse(event.data));
      } catch {
        telemetry.capture('api_error', {
          endpoint: 'live_websocket',
          method: 'WS',
          status: 'parse',
          error_type: 'ParseError',
        });
      }
    };

    ws.addEventListener('open', () => telemetry.capture('api_request', {
      endpoint: 'live_websocket',
      method: 'WS',
      status: 'open',
    }));
    ws.addEventListener('close', () => telemetry.capture('api_request', {
      endpoint: 'live_websocket',
      method: 'WS',
      status: 'close',
    }));
    ws.addEventListener('error', () => telemetry.capture('api_error', {
      endpoint: 'live_websocket',
      method: 'WS',
      status: 'error',
      error_type: 'WebSocketError',
    }));

    return ws;
  },

  async submitTelemetryBatch(batch: TelemetryBatch) {
    await requestJson<{ accepted: number; dropped: number }>('/api/v1/telemetry/events', {
      method: 'POST',
      body: batch,
      reportTelemetry: false,
    });
  },
};
