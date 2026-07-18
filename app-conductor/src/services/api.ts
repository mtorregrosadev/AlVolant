import { NativeModules, Platform } from 'react-native';
import {
  telemetry,
  type TelemetryBatch,
  type TelemetryEndpoint,
} from './telemetry';
import {
  parseReliefCandidates,
  type ReliefCandidate,
} from './reliefDetection';

const BFF_PORT = 8000;
const REQUEST_TIMEOUT_MS = 12_000;
const STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_ATTEMPT_TIMEOUT_MS = 4_500;
const STARTUP_RETRY_DELAY_MS = 750;
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
    throw new ApiError('Falta la configuració segura del BFF.', undefined, 'configuration');
  }

  if (!__DEV__ && !BASE_URL.startsWith('https://')) {
    throw new ApiError('El BFF de producció ha d’utilitzar HTTPS.', undefined, 'configuration');
  }
}

function encodePathSegment(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001F\u007F]/.test(normalized)) {
    throw new ApiError('Identificador de ruta no vàlid.', undefined, 'validation');
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
  constructor(
    message: string,
    readonly status?: number,
    readonly code: ApiErrorCode = status === undefined ? 'unknown' : 'http',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ApiErrorCode =
  | 'configuration'
  | 'validation'
  | 'http'
  | 'invalid_response'
  | 'timeout'
  | 'network'
  | 'unknown';

export type StartupErrorKind =
  | 'offline'
  | 'unavailable'
  | 'invalid_response'
  | 'configuration';

export class StartupError extends Error {
  constructor(readonly kind: StartupErrorKind) {
    super('Application startup failed.');
    this.name = 'StartupError';
  }
}

type JsonRequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  endpoint?: TelemetryEndpoint;
  reportTelemetry?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};

async function requestJson<T>(path: string, options: JsonRequestOptions = {}): Promise<T> {
  assertSecureConfiguration();

  const controller = new AbortController();
  const timeoutMs = Math.max(1, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();
  if (options.signal) {
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (options.signal.aborted) controller.abort();
  }
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
      throw new ApiError('El BFF no ha pogut completar la petició.', response.status, 'http');
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
      throw new ApiError('El BFF ha retornat una resposta no vàlida.', undefined, 'invalid_response');
    }
  } catch (error) {
    if (isAbortError(error)) {
      if (options.signal?.aborted) throw error;
      if (shouldReport && !reportedError) {
        telemetry.capture('api_error', {
          endpoint: options.endpoint,
          method,
          status: 'timeout',
          duration_ms: Date.now() - startedAt,
          error_type: 'TimeoutError',
        });
      }
      throw new ApiError('El BFF ha trigat massa a respondre.', undefined, 'timeout');
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
    throw new ApiError('No s’ha pogut connectar amb el BFF.', undefined, 'network');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string'
    && value.length <= maxLength
    && !/[\u0000-\u001F\u007F]/.test(value);
}

function isIbusVehiclePrediction(value: unknown): value is IbusVehiclePrediction {
  if (!isRecord(value)) return false;
  return isBoundedString(value.vehicle_id, 160)
    && typeof value.arrival_epoch === 'number'
    && Number.isInteger(value.arrival_epoch)
    && typeof value.eta_seconds === 'number'
    && Number.isInteger(value.eta_seconds)
    && value.eta_seconds >= 0
    && value.eta_seconds <= 14_400
    && isBoundedString(value.destination_name, 300);
}

function isIbusAheadPosition(value: unknown): value is IbusAheadPosition {
  if (!isRecord(value)) return false;
  return isBoundedString(value.stop_id, 160)
    && isBoundedString(value.stop_name, 500)
    && typeof value.stop_sequence === 'number'
    && Number.isInteger(value.stop_sequence)
    && value.stop_sequence >= 0
    && value.stop_sequence <= 10_000
    && isIbusVehiclePrediction(value.prediction);
}

function isIbusRoutePosition(value: unknown): value is IbusRoutePosition {
  if (!isRecord(value)) return false;
  return isBoundedString(value.stop_id, 160)
    && isBoundedString(value.stop_name, 500)
    && typeof value.stop_sequence === 'number'
    && Number.isInteger(value.stop_sequence)
    && value.stop_sequence >= 0
    && value.stop_sequence <= 10_000
    && (value.relation === 'ahead' || value.relation === 'behind')
    && isIbusVehiclePrediction(value.prediction);
}

function parseIbusFleetSummary(value: unknown): IbusFleetSummary | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (
    !['tmb_ibus', 'amb_gtfs_rt'].includes(String(value.source))
    || !['available', 'unconfigured', 'rate_limited', 'unavailable'].includes(String(status))
    || !isBoundedString(value.stop_id, 160)
    || !isBoundedString(value.stop_name, 500)
    || !isBoundedString(value.reference_vehicle_id, 160)
    || !(value.reference_arrival_epoch === null || (
      typeof value.reference_arrival_epoch === 'number'
      && Number.isInteger(value.reference_arrival_epoch)
    ))
    || !(value.reference_prediction === null || isIbusVehiclePrediction(value.reference_prediction))
    || typeof value.reference_is_schedule_match !== 'boolean'
    || !(value.ahead_vehicle === null || isIbusVehiclePrediction(value.ahead_vehicle))
    || !(value.behind_vehicle === null || isIbusVehiclePrediction(value.behind_vehicle))
    || !(value.ahead_gap_seconds === undefined || value.ahead_gap_seconds === null || (
      typeof value.ahead_gap_seconds === 'number'
      && Number.isInteger(value.ahead_gap_seconds)
      && value.ahead_gap_seconds >= 0
      && value.ahead_gap_seconds <= 14_400
    ))
    || !(value.behind_gap_seconds === undefined || value.behind_gap_seconds === null || (
      typeof value.behind_gap_seconds === 'number'
      && Number.isInteger(value.behind_gap_seconds)
      && value.behind_gap_seconds >= 0
      && value.behind_gap_seconds <= 14_400
    ))
    || !(value.ahead_position === undefined || value.ahead_position === null || isIbusAheadPosition(value.ahead_position))
    || !(value.route_positions === undefined || (
      Array.isArray(value.route_positions)
      && value.route_positions.length <= 16
      && value.route_positions.every(isIbusRoutePosition)
    ))
  ) return null;

  return {
    source: value.source as IbusFleetSummary['source'],
    status: status as IbusFleetSummary['status'],
    stop_id: value.stop_id,
    stop_name: value.stop_name,
    reference_vehicle_id: value.reference_vehicle_id,
    reference_arrival_epoch: value.reference_arrival_epoch,
    reference_prediction: value.reference_prediction,
    reference_is_schedule_match: value.reference_is_schedule_match,
    ahead_vehicle: value.ahead_vehicle,
    behind_vehicle: value.behind_vehicle,
    ahead_gap_seconds: value.ahead_gap_seconds ?? null,
    behind_gap_seconds: value.behind_gap_seconds ?? null,
    ahead_position: value.ahead_position ?? null,
    route_positions: value.route_positions ?? [],
  };
}

function isDirectionDestination(value: unknown): value is DirectionDestination {
  if (!isRecord(value)) return false;
  return (value.direction_id === 0 || value.direction_id === 1)
    && isBoundedString(value.destination_name)
    && isBoundedString(value.label);
}

function isRouteInfo(value: unknown): value is RouteInfo {
  if (!isRecord(value)) return false;
  if (
    !isBoundedString(value.route_id, 160)
    || value.route_id.trim().length === 0
    || !isBoundedString(value.route_short_name, 160)
    || !isBoundedString(value.route_long_name)
    || !isBoundedString(value.route_color, 16)
    || !isBoundedString(value.route_text_color, 16)
    || !Number.isInteger(value.route_type)
    || !isBoundedString(value.agency_id, 160)
  ) return false;

  if (
    value.route_ids !== undefined
    && (!Array.isArray(value.route_ids)
      || value.route_ids.length > 256
      || !value.route_ids.every((routeId) => isBoundedString(routeId, 160)))
  ) return false;

  if (
    value.direction_destinations !== undefined
    && (!Array.isArray(value.direction_destinations)
      || value.direction_destinations.length > 4
      || !value.direction_destinations.every(isDirectionDestination))
  ) return false;

  return value.display_name === undefined || isBoundedString(value.display_name);
}

function parseRoutesPayload(value: unknown): RouteInfo[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw new ApiError('El catàleg de línies no és vàlid.', undefined, 'invalid_response');
  }

  if (!value.every(isRouteInfo)) {
    throw new ApiError('El catàleg de línies no és vàlid.', undefined, 'invalid_response');
  }

  return value;
}

function parseReadinessPayload(value: unknown) {
  if (!isRecord(value) || !isRecord(value.checks)) {
    throw new ApiError('La resposta d’estat no és vàlida.', undefined, 'invalid_response');
  }

  const redis = value.checks.redis;
  const gtfs = value.checks.gtfs;
  if (
    (value.status !== 'ready' && value.status !== 'not_ready')
    || !isRecord(redis)
    || typeof redis.connected !== 'boolean'
    || !isRecord(gtfs)
    || typeof gtfs.loaded !== 'boolean'
  ) {
    throw new ApiError('La resposta d’estat no és vàlida.', undefined, 'invalid_response');
  }

  return value.status === 'ready' && redis.connected && gtfs.loaded;
}

function startupErrorKind(error: unknown): StartupErrorKind {
  if (error instanceof StartupError) return error.kind;
  if (!(error instanceof ApiError)) return 'offline';
  if (error.code === 'configuration' || error.status === 401 || error.status === 403) {
    return 'configuration';
  }
  if (error.code === 'invalid_response') return 'invalid_response';
  if (error.code === 'network' || error.code === 'timeout') return 'offline';
  return 'unavailable';
}

function createAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function waitForRetry(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
  });
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
  direction_id: 0 | 1 | null;
  latitude: number;
  longitude: number;
  bearing: number | null;
  speed: number | null;
  current_stop_sequence: number | null;
  stop_id: string;
  current_status: 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO' | null;
  timestamp: number;
}

export interface RTStopTimeUpdate {
  stop_id: string;
  stop_sequence: number;
  arrival_delay: number | null;
  departure_delay: number | null;
  arrival_time: number | null;
  departure_time: number | null;
}

export interface RTTripUpdate {
  trip_id: string;
  route_id: string;
  vehicle_id: string;
  direction_id: 0 | 1 | null;
  start_date: string;
  stop_time_updates: RTStopTimeUpdate[];
  timestamp: number;
}

export interface ServiceAlert {
  alert_id: string;
  header_text: string;
  description_text: string;
  cause: string;
  effect: string;
  url: string;
  active_period_start: string | null;
  active_period_end: string | null;
  affected_route_ids: string[];
  affected_stop_ids: string[];
  alert_type: 'DETOUR' | 'STOP_CANCELLATION' | 'SCHEDULE_INFO' | 'SERVICE_CHANGE' | 'GENERAL_INFO';
  severity: 'INFO' | 'WARNING' | 'SEVERE';
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

export interface IbusVehiclePrediction {
  vehicle_id: string;
  arrival_epoch: number;
  eta_seconds: number;
  destination_name: string;
}

export interface IbusAheadPosition {
  stop_id: string;
  stop_name: string;
  stop_sequence: number;
  prediction: IbusVehiclePrediction;
}

export interface IbusRoutePosition {
  stop_id: string;
  stop_name: string;
  stop_sequence: number;
  relation: 'ahead' | 'behind';
  prediction: IbusVehiclePrediction;
}

export interface IbusFleetSummary {
  source: 'tmb_ibus' | 'amb_gtfs_rt';
  status: 'available' | 'unconfigured' | 'rate_limited' | 'unavailable';
  stop_id: string;
  stop_name: string;
  reference_vehicle_id: string;
  reference_arrival_epoch: number | null;
  reference_prediction: IbusVehiclePrediction | null;
  reference_is_schedule_match: boolean;
  ahead_vehicle: IbusVehiclePrediction | null;
  behind_vehicle: IbusVehiclePrediction | null;
  ahead_gap_seconds: number | null;
  behind_gap_seconds: number | null;
  ahead_position: IbusAheadPosition | null;
  route_positions: IbusRoutePosition[];
}

export interface SatelliteAvailability {
  available: boolean;
  clientId: string | null;
}

export type SatelliteTileCoordinates = {
  z: number;
  x: number;
  y: number;
};

export type LiveWebSocketMessage =
  | { type: 'subscribed'; topics: string[] }
  | { type: 'unsubscribed'; topics: string[] }
  | { type: 'pong' }
  | { type: 'error' }
  | {
    topic: 'atm_rt:updates';
    data: { type: 'invalidate'; timestamp: string };
    timestamp: string;
  };

function parseLiveWebSocketMessage(value: unknown): LiveWebSocketMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;

  if (
    (message.type === 'subscribed' || message.type === 'unsubscribed')
    && Array.isArray(message.topics)
    && message.topics.every((topic) => typeof topic === 'string')
  ) {
    return { type: message.type, topics: message.topics };
  }
  if (message.type === 'pong') return { type: 'pong' };
  if (message.type === 'error' && typeof message.message === 'string') {
    return { type: 'error' };
  }

  const data = message.data;
  if (
    message.topic === 'atm_rt:updates'
    && typeof message.timestamp === 'string'
    && data
    && typeof data === 'object'
    && !Array.isArray(data)
    && (data as Record<string, unknown>).type === 'invalidate'
    && typeof (data as Record<string, unknown>).timestamp === 'string'
  ) {
    return {
      topic: 'atm_rt:updates',
      data: {
        type: 'invalidate',
        timestamp: (data as Record<string, unknown>).timestamp as string,
      },
      timestamp: message.timestamp,
    };
  }

  return null;
}

function isFreshRealtimeTimestamp(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp < 0) return false;
  // GTFS-RT permits an entity without its own timestamp. In that case the BFF
  // has already validated the containing feed and exposes the model default 0.
  if (timestamp === 0) return true;
  const ageSeconds = Date.now() / 1000 - timestamp;
  return ageSeconds >= -30 && ageSeconds <= 180;
}

let routesRequest: Promise<RouteInfo[]> | null = null;
let preloadedRoutes: RouteInfo[] | null = null;

export const apiService = {
  getPreloadedRoutes(): RouteInfo[] | null {
    return preloadedRoutes ? [...preloadedRoutes] : null;
  },

  async waitUntilReady(signal?: AbortSignal) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let lastErrorKind: StartupErrorKind = 'unavailable';

    while (!signal?.aborted && Date.now() < deadline) {
      try {
        const readinessTimeout = Math.min(
          STARTUP_ATTEMPT_TIMEOUT_MS,
          Math.max(1, deadline - Date.now()),
        );
        const readiness = await requestJson<unknown>('/health/ready', {
          reportTelemetry: false,
          signal,
          timeoutMs: readinessTimeout,
        });
        if (!parseReadinessPayload(readiness)) {
          throw new StartupError('unavailable');
        }

        const catalogTimeout = Math.min(
          STARTUP_ATTEMPT_TIMEOUT_MS,
          Math.max(1, deadline - Date.now()),
        );
        const catalog = await requestJson<unknown>('/api/v1/gtfs/routes', {
          reportTelemetry: false,
          signal,
          timeoutMs: catalogTimeout,
        });
        preloadedRoutes = parseRoutesPayload(catalog);
        return;
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        lastErrorKind = startupErrorKind(error);
        if (lastErrorKind === 'configuration') break;

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await waitForRetry(Math.min(STARTUP_RETRY_DELAY_MS, remainingMs), signal);
      }
    }

    if (signal?.aborted) throw createAbortError();
    throw new StartupError(lastErrorKind);
  },

  fetchRouteShape(routeId: string, directionId?: number, tripId?: string) {
    const route = encodePathSegment(routeId);
    const query = createQuery({ direction_id: directionId, trip_id: tripId });
    return requestJson<any>(`/api/v1/gtfs/shapes/${route}${query}`, { endpoint: 'route_shape' });
  },

  fetchRouteStops(
    routeId: string,
    directionId?: number,
    tripId?: string,
    signal?: AbortSignal,
  ) {
    const route = encodePathSegment(routeId);
    const query = createQuery({ direction_id: directionId, trip_id: tripId });
    return requestJson<any>(`/api/v1/gtfs/stops/${route}${query}`, {
      endpoint: 'route_stops',
      signal,
    });
  },

  fetchRoutes(): Promise<RouteInfo[]> {
    if (preloadedRoutes) {
      const routes = preloadedRoutes;
      preloadedRoutes = null;
      return Promise.resolve(routes);
    }

    if (!routesRequest) {
      routesRequest = requestJson<unknown>('/api/v1/gtfs/routes', { endpoint: 'routes' })
        .then(parseRoutesPayload)
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

  fetchUpcomingTrips(
    routeId: string,
    directionId: number,
    signal?: AbortSignal,
    pastMinutes?: number,
  ): Promise<UpcomingTrip[]> {
    if (directionId !== 0 && directionId !== 1) {
      return Promise.reject(new ApiError('Direcció de ruta no vàlida.'));
    }

    const route = encodePathSegment(routeId);
    const normalizedPastMinutes = typeof pastMinutes === 'number'
      && Number.isFinite(pastMinutes)
      && pastMinutes > 5
      ? Math.min(180, Math.round(pastMinutes))
      : undefined;
    return requestJson<UpcomingTrip[]>(
      `/api/v1/gtfs/routes/${route}/upcoming-trips${createQuery({
        direction_id: directionId,
        ...(normalizedPastMinutes ? { past_minutes: normalizedPastMinutes, limit: 12 } : {}),
      })}`,
      { endpoint: 'upcoming_trips', signal },
    ).then((trips) => Array.isArray(trips) ? trips : []);
  },

  fetchReliefCandidates(
    routeId: string,
    directionId: 0 | 1,
    stopId: string,
    signal?: AbortSignal,
  ): Promise<ReliefCandidate[]> {
    const route = encodePathSegment(routeId);
    const stop = stopId.trim();
    if (!stop || stop.length > 160 || /[\u0000-\u001F\u007F]/.test(stop)) {
      return Promise.reject(new ApiError('Identificador de parada no vàlid.', undefined, 'validation'));
    }
    const query = createQuery({ direction_id: directionId, stop_id: stop, limit: 4 });

    return requestJson<unknown>(`/api/v1/atm_rt/vehicles/${route}/near-stop${query}`, {
      endpoint: 'relief_candidates',
      signal,
    }).then((payload) => {
      if (!Array.isArray(payload)) {
        throw new ApiError('Els vehicles de relleu no són vàlids.', undefined, 'invalid_response');
      }

      const receivedAt = Math.floor(Date.now() / 1000);
      const contextualized = payload.map((value) => isRecord(value) ? {
        ...value,
        route_id: routeId,
        direction_id: directionId,
        stop_id: stopId,
        observed_at: receivedAt,
      } : value);
      const candidates = parseReliefCandidates(contextualized);
      if (!candidates) {
        throw new ApiError('Els vehicles de relleu no són vàlids.', undefined, 'invalid_response');
      }
      return candidates;
    });
  },

  fetchRouteVehicles(routeId: string): Promise<VehiclePosition[]> {
    const route = encodePathSegment(routeId);
    return requestJson<VehiclePosition[]>(`/api/v1/atm_rt/vehicles/${route}`, { endpoint: 'route_vehicles' })
      .then((vehicles) => Array.isArray(vehicles)
        ? vehicles.filter((vehicle) => isFreshRealtimeTimestamp(vehicle.timestamp)).slice(0, 2_000)
        : []);
  },

  fetchRouteTripUpdates(routeId: string): Promise<RTTripUpdate[]> {
    const route = encodePathSegment(routeId);
    return requestJson<RTTripUpdate[]>(`/api/v1/atm_rt/trips/${route}`, { endpoint: 'route_updates' })
      .then((updates) => Array.isArray(updates) ? updates : []);
  },

  fetchRouteServiceAlerts(
    routeId: string,
    directionId?: number,
    signal?: AbortSignal,
  ): Promise<ServiceAlert[]> {
    if (directionId !== undefined && directionId !== 0 && directionId !== 1) {
      return Promise.reject(new ApiError('Direcció de ruta no vàlida.', undefined, 'validation'));
    }

    const route = encodePathSegment(routeId);
    const query = createQuery({ direction_id: directionId });
    return requestJson<ServiceAlert[]>(`/api/v1/atm_rt/alerts/${route}${query}`, {
      endpoint: 'route_alerts',
      signal,
    }).then((alerts) => Array.isArray(alerts)
      ? alerts.filter((alert) => (
        isBoundedString(alert?.alert_id, 160)
        && isBoundedString(alert?.header_text, 1_000)
        && isBoundedString(alert?.description_text, 10_000)
        && isBoundedString(alert?.effect, 64)
        && isBoundedString(alert?.alert_type, 64)
        && isBoundedString(alert?.severity, 64)
      )).slice(0, 20)
      : []);
  },

  fetchTrafficSummary(
    latitude: number,
    longitude: number,
    signal?: AbortSignal,
  ): Promise<TrafficSummary> {
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

    return requestJson<TrafficSummary>('/api/v1/traffic/summary', {
      method: 'POST',
      endpoint: 'traffic_summary',
      body: { latitude, longitude },
      signal,
    });
  },

  fetchIbusFleet(
    routeId: string,
    directionId: 0 | 1,
    stopId: string,
    tripId?: string,
    scheduledDepartureEpoch?: number,
    signal?: AbortSignal,
  ): Promise<IbusFleetSummary | null> {
    const normalizedRouteId = routeId.trim();
    const normalizedTripId = tripId?.trim() ?? '';
    const normalizedStopId = stopId.trim();
    if (
      !normalizedRouteId
      || normalizedRouteId.length > 128
      || !normalizedStopId
      || normalizedStopId.length > 160
      || (normalizedTripId.length > 160)
      || /[\u0000-\u001F\u007F]/.test(normalizedRouteId)
      || /[\u0000-\u001F\u007F]/.test(normalizedTripId)
      || /[\u0000-\u001F\u007F]/.test(normalizedStopId)
      || (scheduledDepartureEpoch !== undefined && (
        !Number.isInteger(scheduledDepartureEpoch)
        || scheduledDepartureEpoch < 1_577_836_800
        || scheduledDepartureEpoch > 4_102_444_800
      ))
    ) {
      return Promise.reject(new ApiError('Consulta iBus no vàlida.', undefined, 'validation'));
    }

    return requestJson<unknown>('/api/v1/ibus/fleet', {
      method: 'POST',
      endpoint: 'ibus_fleet',
      body: {
        route_id: normalizedRouteId,
        direction_id: directionId,
        stop_id: normalizedStopId,
        ...(normalizedTripId ? { trip_id: normalizedTripId } : {}),
        ...(scheduledDepartureEpoch !== undefined
          ? { scheduled_departure_epoch: scheduledDepartureEpoch }
          : {}),
      },
      signal,
    }).then(parseIbusFleetSummary);
  },

  fetchSatelliteAvailability(options: {
    clientId?: string | null;
    tile?: SatelliteTileCoordinates | null;
    signal?: AbortSignal;
  } = {}): Promise<SatelliteAvailability> {
    const clientId = options.clientId?.trim();
    const tile = options.tile;
    const query = createQuery({
      client_id: clientId || undefined,
      z: tile?.z,
      x: tile?.x,
      y: tile?.y,
    });
    return requestJson<unknown>(`/maps/satellite/status${query}`, {
      reportTelemetry: false,
      signal: options.signal,
    }).then((payload) => ({
      available: isRecord(payload) && payload.available === true,
      clientId: isRecord(payload) && isBoundedString(payload.client_id, 100)
        ? payload.client_id
        : null,
    }));
  },

  connectWebSocket(onMessage?: (data: LiveWebSocketMessage) => void) {
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
        const message = parseLiveWebSocketMessage(JSON.parse(event.data));
        if (message) onMessage(message);
      } catch {
        telemetry.capture('api_error', {
          endpoint: 'live_websocket',
          method: 'WS',
          status: 'parse',
          error_type: 'ParseError',
        });
      }
    };

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ action: 'subscribe', topics: ['atm_rt:updates'] }));
      telemetry.capture('api_request', {
        endpoint: 'live_websocket',
        method: 'WS',
        status: 'open',
      });
    });
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
