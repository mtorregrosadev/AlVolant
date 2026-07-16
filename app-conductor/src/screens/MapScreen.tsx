import React, { useEffect, useState, useRef } from 'react';
import {
  Animated,
  Easing,
  Modal,
  ScrollView,
  StyleSheet,
  View,
  Text,
  ActivityIndicator,
  TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import {
  Map,
  Camera,
  GeoJSONSource,
  Layer,
  Marker,
} from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  apiService,
  type LiveWebSocketMessage,
  type RTTripUpdate,
  type ServiceAlert,
  type TrafficSummary,
  type VehiclePosition,
} from '../services/api';
import { telemetry } from '../services/telemetry';
import {
  requestBackgroundRoutePermission,
  startBackgroundRouteTracking,
  stopBackgroundRouteTracking,
} from '../services/backgroundRoute';
import {
  endRouteLiveActivity,
  startRouteLiveActivity,
  updateRouteLiveActivity,
  type RouteLiveActivityProps,
} from '../services/routeLiveActivity';
import { formatDirectionLabel } from '../services/directionLabel';
import {
  createRouteMatchingState,
  updateRouteMatch,
  type RouteMatchingState,
} from '../services/routeMatching';
import {
  colors,
  mapRouteLineColors,
  routeLinePresetColors,
  safeHexColor,
  spacing,
  vehicleAccentColor,
} from '../theme';
import { usePreferences } from '../PreferencesContext';
import { translate, useI18n, type TranslationKey } from '../i18n';
import type { AppLanguage } from '../services/userPreferences';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';

type Coordinate = [number, number];
type SelectedStop = {
  route_id?: string;
  direction_id?: number | string;
  trip_id?: string;
  stop_id?: string;
  stop_sequence?: number | string;
  stop_name?: string;
  coordinates?: Coordinate | null;
};

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];
type DriverMetric = {
  icon: IconName;
  label: string;
};
type RouteProjection = {
  coordinate: Coordinate;
  distanceAlong: number;
  bearing: number;
  distanceFromRoute: number;
};
type RouteStopInfo = SelectedStop & {
  coordinates: Coordinate;
  distanceAlong: number | null;
  sequence: number;
};
type GpsFix = {
  coordinate: Coordinate;
  accuracyMeters: number | null;
  speedKmh: number | null;
  headingDegrees: number | null;
  timestampMs: number;
};
type DeviceHeading = {
  degrees: number;
  accuracy: number;
  source: 'true' | 'magnetic';
};
type VisualPose = {
  coordinate: Coordinate;
  bearing: number;
  routeProgress: number | null;
};
type RoutePathSegment = {
  start: Coordinate;
  end: Coordinate;
  startDistance: number;
  length: number;
};
type RoutePath = {
  segments: RoutePathSegment[];
  totalDistance: number;
};
type RouteProjectionOptions = {
  previousDistanceAlong?: number | null;
  headingDegrees?: number | null;
};

type MapScreenProps = NativeStackScreenProps<RootStackParamList, 'Map'>;
type MapTheme = 'dark' | 'light' | 'satellite';
type MapViewMode = 'perspective' | 'topDown';
type MapThemeOption = {
  labelKey: TranslationKey;
  icon: IconName;
  style: any;
};

const MS_TO_KMH = 3.6;
const MIN_MOVING_SPEED_KMH = 3;
const FALLBACK_CITY_SPEED_KMH = 18;
const TRAFFIC_REFRESH_INTERVAL_MS = 120_000;
const LIVE_REFRESH_MIN_INTERVAL_MS = 60_000;
const LIVE_REFRESH_JITTER_MS = 5_000;
const LIVE_RECONNECT_MAX_MS = 30_000;
const LIVE_SUBSCRIPTION_TIMEOUT_MS = 10_000;
const LIVE_DATA_STALE_AFTER_MS = 180_000;
const DEVICE_HEADING_STALE_AFTER_MS = 3_500;
const DEVICE_HEADING_DEADBAND_DEGREES = 0.8;
const DEVICE_HEADING_MIN_UPDATE_INTERVAL_MS = 80;
const SIMULATION_TURN_SMOOTHING_METERS = 24;
const SIMULATION_TRIPLE_TAP_WINDOW_MS = 650;
const SIMULATION_MIN_CRUISE_SPEED_KMH = 24;
const SIMULATION_MAX_CRUISE_SPEED_KMH = 44;
const SIMULATION_ACCELERATION_MPS2 = 1.05;
const SIMULATION_BRAKING_MPS2 = 1.65;

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function moveTowards(value: number, target: number, maximumDelta: number) {
  if (value < target) return Math.min(value + maximumDelta, target);
  return Math.max(value - maximumDelta, target);
}

function distanceMeters(from: Coordinate | null, to: Coordinate | null) {
  if (!from || !to) {
    return null;
  }

  const [fromLon, fromLat] = from;
  const [toLon, toLat] = to;
  const earthRadiusMeters = 6371000;
  const dLat = toRadians(toLat - fromLat);
  const dLon = toRadians(toLon - fromLon);
  const lat1 = toRadians(fromLat);
  const lat2 = toRadians(toLat);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusMeters * c;
}

function bearingBetween(from: Coordinate, to: Coordinate) {
  const [fromLon, fromLat] = from;
  const [toLon, toLat] = to;
  const lat1 = toRadians(fromLat);
  const lat2 = toRadians(toLat);
  const dLon = toRadians(toLon - fromLon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function isValidHeading(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= 360;
}

function normalizeHeading(value: number) {
  return ((value % 360) + 360) % 360;
}

function shortestHeadingDelta(from: number, to: number) {
  return ((normalizeHeading(to) - normalizeHeading(from) + 540) % 360) - 180;
}

function selectDeviceHeading(
  heading: Location.LocationHeadingObject,
): DeviceHeading | null {
  const accuracy = Number.isFinite(heading.accuracy) ? heading.accuracy : 0;

  // expo-location reports accuracy 0 when the compass is not calibrated enough
  // to provide a useful direction. In that case GPS/route bearing is safer.
  if (accuracy < 1) {
    return null;
  }

  if (isValidHeading(heading.trueHeading)) {
    return {
      degrees: normalizeHeading(heading.trueHeading),
      accuracy,
      source: 'true',
    };
  }

  if (isValidHeading(heading.magHeading)) {
    return {
      degrees: normalizeHeading(heading.magHeading),
      accuracy,
      source: 'magnetic',
    };
  }

  return null;
}

function interpolateCoordinate(from: Coordinate, to: Coordinate, ratio: number): Coordinate {
  const safeRatio = clamp(ratio, 0, 1);
  return [
    from[0] + (to[0] - from[0]) * safeRatio,
    from[1] + (to[1] - from[1]) * safeRatio,
  ];
}

function interpolateBearing(from: number, to: number, ratio: number) {
  const delta = ((to - from + 540) % 360) - 180;
  return (from + delta * clamp(ratio, 0, 1) + 360) % 360;
}

function buildRoutePath(routeCoordinates: Coordinate[]): RoutePath {
  const segments: RoutePathSegment[] = [];
  let totalDistance = 0;

  for (let index = 0; index < routeCoordinates.length - 1; index += 1) {
    const start = routeCoordinates[index];
    const end = routeCoordinates[index + 1];
    const length = distanceMeters(start, end) ?? 0;
    if (length <= 0) continue;
    segments.push({
      start,
      end,
      startDistance: totalDistance,
      length,
    });
    totalDistance += length;
  }

  return { segments, totalDistance };
}

function coordinateAtRouteDistance(
  routePath: RoutePath,
  distanceAlong: number,
): Coordinate | null {
  if (!routePath.segments.length) return null;
  const target = clamp(distanceAlong, 0, routePath.totalDistance);
  let low = 0;
  let high = routePath.segments.length - 1;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const segment = routePath.segments[middle];
    if (target <= segment.startDistance + segment.length) high = middle;
    else low = middle + 1;
  }

  const segment = routePath.segments[low];
  const ratio = segment.length > 0
    ? clamp((target - segment.startDistance) / segment.length, 0, 1)
    : 0;
  return interpolateCoordinate(segment.start, segment.end, ratio);
}

function completedRouteFeature(
  routePath: RoutePath,
  distanceAlong: number | null,
) {
  if (
    distanceAlong === null
    || routePath.segments.length === 0
    || distanceAlong < 3
  ) {
    return null;
  }

  const target = clamp(distanceAlong, 0, routePath.totalDistance);
  const coordinates: Coordinate[] = [routePath.segments[0].start];

  for (const segment of routePath.segments) {
    const segmentEnd = segment.startDistance + segment.length;
    if (target >= segmentEnd) {
      coordinates.push(segment.end);
      continue;
    }

    const ratio = segment.length > 0
      ? clamp((target - segment.startDistance) / segment.length, 0, 1)
      : 0;
    coordinates.push(interpolateCoordinate(segment.start, segment.end, ratio));
    break;
  }

  if (coordinates.length < 2) return null;

  return {
    type: 'FeatureCollection' as const,
    features: [{
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates,
      },
    }],
  };
}

function poseAtRouteDistance(routePath: RoutePath, distanceAlong: number): VisualPose | null {
  if (!routePath.segments.length) return null;
  const routeProgress = clamp(distanceAlong, 0, routePath.totalDistance);
  let low = 0;
  let high = routePath.segments.length - 1;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const segment = routePath.segments[middle];
    if (routeProgress <= segment.startDistance + segment.length) high = middle;
    else low = middle + 1;
  }

  const segment = routePath.segments[low];
  const ratio = segment.length > 0
    ? clamp((routeProgress - segment.startDistance) / segment.length, 0, 1)
    : 0;
  const coordinate = interpolateCoordinate(segment.start, segment.end, ratio);
  const smoothingRadius = SIMULATION_TURN_SMOOTHING_METERS / 2;
  const bearingFrom = coordinateAtRouteDistance(
    routePath,
    Math.max(0, routeProgress - smoothingRadius),
  );
  const bearingTo = coordinateAtRouteDistance(
    routePath,
    Math.min(routePath.totalDistance, routeProgress + smoothingRadius),
  );
  const smoothedBearing = bearingFrom
    && bearingTo
    && (distanceMeters(bearingFrom, bearingTo) ?? 0) > 0.1
    ? bearingBetween(bearingFrom, bearingTo)
    : bearingBetween(segment.start, segment.end);

  return {
    coordinate,
    bearing: smoothedBearing,
    routeProgress,
  };
}

function angleDifferenceDegrees(first: number, second: number) {
  return Math.abs(((first - second + 540) % 360) - 180);
}

function projectPointOnRoute(
  point: Coordinate | null,
  routeCoordinates: Coordinate[],
  options: RouteProjectionOptions = {},
): RouteProjection | null {
  if (!point || routeCoordinates.length < 2) {
    return null;
  }

  let bestProjection: RouteProjection | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let accumulatedDistance = 0;
  const previousDistanceAlong = typeof options.previousDistanceAlong === 'number'
    && Number.isFinite(options.previousDistanceAlong)
    ? Math.max(0, options.previousDistanceAlong)
    : null;
  const headingDegrees = typeof options.headingDegrees === 'number'
    && Number.isFinite(options.headingDegrees)
    && options.headingDegrees >= 0
    && options.headingDegrees <= 360
    ? options.headingDegrees % 360
    : null;

  for (let index = 0; index < routeCoordinates.length - 1; index += 1) {
    const start = routeCoordinates[index];
    const end = routeCoordinates[index + 1];
    const segmentLength = distanceMeters(start, end) ?? 0;

    if (segmentLength <= 0) {
      continue;
    }

    const latRef = toRadians((point[1] + start[1] + end[1]) / 3);
    const metersPerLon = 111320 * Math.cos(latRef);
    const metersPerLat = 110540;
    const pointX = (point[0] - start[0]) * metersPerLon;
    const pointY = (point[1] - start[1]) * metersPerLat;
    const segmentX = (end[0] - start[0]) * metersPerLon;
    const segmentY = (end[1] - start[1]) * metersPerLat;
    const segmentLengthSquared = segmentX ** 2 + segmentY ** 2;
    const ratio = segmentLengthSquared === 0
      ? 0
      : clamp((pointX * segmentX + pointY * segmentY) / segmentLengthSquared, 0, 1);
    const coordinate = interpolateCoordinate(start, end, ratio);
    const distanceFromRoute = distanceMeters(point, coordinate) ?? Number.POSITIVE_INFINITY;

    const distanceAlong = accumulatedDistance + segmentLength * ratio;
    // A modest continuity/direction score prevents the matcher from jumping
    // onto a nearby return branch while still allowing normal forward motion.
    const continuityPenalty = previousDistanceAlong === null
      ? 0
      : Math.min(Math.abs(distanceAlong - previousDistanceAlong), 2_000) * 0.08;
    const segmentBearing = bearingBetween(start, end);
    const headingDelta = headingDegrees === null
      ? 0
      : angleDifferenceDegrees(headingDegrees, segmentBearing);
    const headingPenalty = headingDelta > 100 ? 30 : headingDelta > 70 ? 12 : 0;
    const score = distanceFromRoute + continuityPenalty + headingPenalty;

    if (!bestProjection || score < bestScore) {
      bestScore = score;
      bestProjection = {
        coordinate,
        distanceAlong,
        bearing: segmentBearing,
        distanceFromRoute,
      };
    }

    accumulatedDistance += segmentLength;
  }

  return bestProjection;
}

function extractRouteCoordinates(routeFeature: any): Coordinate[] {
  const coordinates = routeFeature?.geometry?.coordinates;
  if (!Array.isArray(coordinates)) {
    return [];
  }

  return coordinates
    .map((coordinate) => normalizeCoordinates(coordinate))
    .filter((coordinate): coordinate is Coordinate => Boolean(coordinate));
}

function extractStopsOnRoute(stopsFeature: any, routeCoordinates: Coordinate[]): RouteStopInfo[] {
  const features = stopsFeature?.features;
  if (!Array.isArray(features)) {
    return [];
  }

  return features
    .map((feature: any) => {
      const coordinates = normalizeCoordinates(feature?.geometry?.coordinates);
      if (!coordinates) {
        return null;
      }

      const properties = feature?.properties || {};
      const sequence = Number(properties.stop_sequence);
      const projection = projectPointOnRoute(coordinates, routeCoordinates);

      return {
        ...properties,
        coordinates,
        sequence: Number.isFinite(sequence) ? sequence : Number.MAX_SAFE_INTEGER,
        distanceAlong: projection?.distanceAlong ?? null,
      };
    })
    .filter((stop): stop is RouteStopInfo => Boolean(stop))
    .sort((a, b) => {
      if (a.distanceAlong !== null && b.distanceAlong !== null) {
        return a.distanceAlong - b.distanceAlong;
      }

      return a.sequence - b.sequence;
    });
}

function formatDistance(meters: number | null, language: AppLanguage) {
  if (meters === null) {
    return translate(language, 'map.distancePending');
  }

  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }

  return `${(meters / 1000).toFixed(1)} km`;
}

function formatEta(minutes: number | null, language: AppLanguage) {
  if (minutes === null) {
    return translate(language, 'map.pending');
  }

  if (minutes <= 1) {
    return '<1 min';
  }

  return `${Math.round(minutes)} min`;
}

function formatEstimatedArrival(minutes: number | null) {
  if (minutes === null) {
    return null;
  }

  const estimatedArrival = new Date(Date.now() + Math.max(0, minutes) * 60_000);
  const hours = String(estimatedArrival.getHours()).padStart(2, '0');
  const mins = String(estimatedArrival.getMinutes()).padStart(2, '0');

  return `${hours}:${mins}`;
}

function formatDelayDuration(seconds: number) {
  return `${Math.max(1, Math.round(Math.abs(seconds) / 60))} min`;
}

function fulfilledRealtimeValues<T>(results: PromiseSettledResult<T[]>[]) {
  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}

function deduplicateRealtimeItems<T>(items: T[], keyForItem: (item: T) => string) {
  const latest = new globalThis.Map<string, T>();
  items.forEach((item) => {
    const key = keyForItem(item);
    if (key) latest.set(key, item);
  });
  return [...latest.values()];
}

function normalizeCoordinates(value: unknown): Coordinate | null {
  if (
    Array.isArray(value)
    && value.length >= 2
    && typeof value[0] === 'number'
    && typeof value[1] === 'number'
  ) {
    return [value[0], value[1]];
  }

  return null;
}

function stopUpdateForVehicle(update: RTTripUpdate, vehicle: VehiclePosition) {
  const stopId = vehicle.stop_id ? String(vehicle.stop_id) : '';
  const stopSequence = Number(vehicle.current_stop_sequence);
  return update.stop_time_updates.find((candidate) => {
    const sameStopId = stopId && candidate.stop_id === stopId;
    const sameSequence = Number.isFinite(stopSequence) && candidate.stop_sequence === stopSequence;
    return sameStopId || sameSequence;
  }) ?? null;
}

function reportedVehicleDelay(update: RTTripUpdate | undefined, vehicle: VehiclePosition) {
  if (!update) return null;
  const stopUpdate = stopUpdateForVehicle(update, vehicle);
  const delay = stopUpdate?.arrival_delay ?? stopUpdate?.departure_delay ?? null;

  // ATM's current normalizer represents a missing delay as zero. A non-zero
  // value is therefore the only deviation we can state without guessing.
  return typeof delay === 'number' && Number.isFinite(delay) && delay !== 0
    ? delay
    : null;
}

const SATELLITE_MAP_STYLE = {
  version: 8,
  sources: {
    esriWorldImagery: {
      type: 'raster',
      tiles: [
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Tiles © Esri',
    },
    carto: {
      type: 'vector',
      url: 'https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/tiles.json',
    },
  },
  layers: [
    {
      id: 'esriWorldImagery',
      type: 'raster',
      source: 'esriWorldImagery',
      minzoom: 0,
      maxzoom: 24,
      paint: {
        'raster-fade-duration': 0,
        'raster-resampling': 'linear',
      },
    },
  ],
};

const MAP_THEME_OPTIONS: Record<MapTheme, MapThemeOption> = {
  dark: {
    labelKey: 'map.dark',
    icon: 'weather-night',
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  },
  light: {
    labelKey: 'map.light',
    icon: 'white-balance-sunny',
    style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  },
  satellite: {
    labelKey: 'map.satellite',
    icon: 'satellite-variant',
    style: SATELLITE_MAP_STYLE,
  },
};

// A lightweight colour veil hides MapLibre's unavoidable style rebuild. The
// old implementation captured the whole map as a base64 image on every tap,
// transferred it through the native bridge and decoded it again; that work was
// the source of the visible hitch. These colours are deliberately close to the
// corresponding basemap so the transition does not flash grey while tiles load.
const MAP_THEME_TRANSITION_COLORS: Record<MapTheme, string> = {
  dark: '#0B1118',
  light: '#F4F1E9',
  satellite: '#17252A',
};
const MAP_THEME_TRANSITION_MAX_MS = 1_200;

export default function MapScreen({ route, navigation }: MapScreenProps) {
  const { routeId, directionId, assignedVehicle, tripId, directionLabel } = route.params;
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = viewportWidth > viewportHeight;
  const { preferences, setBackgroundLocationEnabled } = usePreferences();
  const { language, t } = useI18n();

  useEffect(() => {
    if (!preferences.keepAwakeEnabled) {
      return undefined;
    }

    const keepAwakeTag = 'alvolant-active-route';
    let cancelled = false;
    void activateKeepAwakeAsync(keepAwakeTag)
      .then(() => {
        if (cancelled) {
          return deactivateKeepAwake(keepAwakeTag);
        }
        return undefined;
      })
      .catch((error) => {
        telemetry.captureException(error, { phase: 'keep_awake_activate' });
      });
    return () => {
      cancelled = true;
      void deactivateKeepAwake(keepAwakeTag).catch((error) => {
        telemetry.captureException(error, { phase: 'keep_awake_deactivate' });
      });
    };
  }, [preferences.keepAwakeEnabled]);

  const [routeFeature, setRouteFeature] = useState<any>(null);
  const [stopsFeature, setStopsFeature] = useState<any>(null);
  const [selectedStop, setSelectedStop] = useState<SelectedStop | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [locationGranted, setLocationGranted] = useState(false);
  const [mapViewMode, setMapViewMode] = useState<MapViewMode>('perspective');
  const [gpsFix, setGpsFix] = useState<GpsFix | null>(null);
  const [deviceHeading, setDeviceHeading] = useState<DeviceHeading | null>(null);
  const [visualPose, setVisualPose] = useState<VisualPose | null>(null);
  const [displayRouteProgress, setDisplayRouteProgress] = useState<number | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationSpeedKmh, setSimulationSpeedKmh] = useState(0);
  const [mapBearing, setMapBearing] = useState<number>(0);
  const [routeInfo, setRouteInfo] = useState<any>(null);
  const [routeTripUpdates, setRouteTripUpdates] = useState<RTTripUpdate[]>([]);
  const [vehiclePositions, setVehiclePositions] = useState<VehiclePosition[]>([]);
  const [serviceAlerts, setServiceAlerts] = useState<ServiceAlert[]>([]);
  const [trafficSummary, setTrafficSummary] = useState<TrafficSummary | null>(null);
  const [isServiceAlertModalVisible, setIsServiceAlertModalVisible] = useState(false);
  const [isServiceAlertTabDismissed, setIsServiceAlertTabDismissed] = useState(false);
  const [mapTheme, setMapTheme] = useState<MapTheme>('dark');
  const [isMapThemePickerOpen, setIsMapThemePickerOpen] = useState(false);
  const [pendingMapTheme, setPendingMapTheme] = useState<MapTheme | null>(null);
  const [mapThemeTransitionColor, setMapThemeTransitionColor] = useState(
    MAP_THEME_TRANSITION_COLORS.dark,
  );
  const [isCameraFollowing, setIsCameraFollowing] = useState(true);
  const [cameraTransitionDuration, setCameraTransitionDuration] = useState(0);
  const mapRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const animationFrameRef = useRef<number | null>(null);
  const simulationFrameRef = useRef<number | null>(null);
  const simulationTitleTapRef = useRef({ count: 0, lastTapAt: 0 });
  const smoothedDeviceHeadingRef = useRef<number | null>(null);
  const lastDeviceHeadingUpdateRef = useRef(0);
  const deviceHeadingExpiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orientationTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapThemeTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appliedMapThemeRef = useRef<MapTheme>('dark');
  const mapThemeTransitionTargetRef = useRef<MapTheme | null>(null);
  const mapThemeTransitionGenerationRef = useRef(0);
  const mapThemeStyleReadyGenerationRef = useRef<number | null>(null);
  const mapThemeFadeGenerationRef = useRef<number | null>(null);
  const mapThemeTransitionOpacity = useRef(new Animated.Value(0)).current;
  const visualPoseRef = useRef<VisualPose | null>(null);
  const displayCoordsRef = useRef<Coordinate | null>(null);
  const liveActivityPropsRef = useRef<RouteLiveActivityProps | null>(null);
  const liveActivityStartedRef = useRef(false);
  const presentedServiceAlertKeyRef = useRef('');
  const lastSnappedProgressRef = useRef<number | null>(null);
  const routeMatchingStateRef = useRef<RouteMatchingState>(
    createRouteMatchingState('offRoute'),
  );
  const userCoords = gpsFix?.coordinate ?? null;
  const userSpeedKmh = gpsFix?.speedKmh ?? null;
  const displayCoords = visualPose?.coordinate ?? null;
  // GPS is available before the visual route marker during initial map
  // settling, so use it as a safe fallback for the first traffic lookup.
  const trafficCoordinate = displayCoords ?? userCoords;
  displayCoordsRef.current = trafficCoordinate;
  // Simulations make one immediate lookup so the integration can be checked;
  // active real navigation refreshes the result on the bounded interval below.
  const shouldFetchTraffic = !loading
    && !error
    && trafficCoordinate !== null;
  const displayRouteBearing = visualPose?.bearing ?? 0;
  const gpsBearing = gpsFix
    && isValidHeading(gpsFix.headingDegrees)
    && (gpsFix.speedKmh ?? 0) >= MIN_MOVING_SPEED_KMH
    ? normalizeHeading(gpsFix.headingDegrees)
    : null;
  // A snapped route bearing is independent of the way the device is held.
  // This keeps the vehicle centred and pointing ahead in landscape exactly as
  // it does in portrait when the camera follows the route.
  const vehicleWorldBearing = displayRouteProgress !== null
    ? displayRouteBearing
    : gpsBearing ?? deviceHeading?.degrees ?? displayRouteBearing;
  const effectiveMapBearing = isCameraFollowing && cameraTransitionDuration === 0
    ? displayRouteBearing
    : mapBearing;
  const vehicleMarkerRotation = vehicleWorldBearing - effectiveMapBearing;

  useEffect(() => {
    if (!shouldFetchTraffic) {
      setTrafficSummary(null);
      return undefined;
    }

    let disposed = false;
    let controller: AbortController | null = null;

    const refreshTraffic = () => {
      const coords = displayCoordsRef.current;
      if (!coords) return;

      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      void apiService.fetchTrafficSummary(coords[1], coords[0], requestController.signal)
        .then((summary) => {
          if (!disposed) setTrafficSummary(summary);
        })
        .catch(() => {
          if (!disposed && !requestController.signal.aborted) {
            setTrafficSummary(null);
          }
        });
    };

    refreshTraffic();
    const refreshTimer = isSimulating
      ? null
      : setInterval(refreshTraffic, TRAFFIC_REFRESH_INTERVAL_MS);
    return () => {
      disposed = true;
      if (refreshTimer) clearInterval(refreshTimer);
      controller?.abort();
    };
  }, [directionId, isSimulating, routeId, shouldFetchTraffic, tripId]);

  const directionName = React.useMemo(() => {
    if (directionLabel) {
      return formatDirectionLabel(directionLabel, language);
    }

    if (routeInfo?.towards_label) {
      return formatDirectionLabel(routeInfo.towards_label, language);
    }

    if (routeInfo?.destination_name) {
      return t('common.towards', { destination: routeInfo.destination_name });
    }

    return '';
  }, [directionLabel, language, routeInfo, t]);

  const routeShortName = routeInfo?.route_short_name || t('common.bus');
  const routeColor = safeHexColor(routeInfo?.route_color, colors.primary);
  const routeLineColors = React.useMemo(
    () => mapRouteLineColors(
      preferences.routeLineDynamic
        ? routeInfo?.route_color
        : routeLinePresetColors[preferences.routeLineColor],
    ),
    [preferences.routeLineColor, preferences.routeLineDynamic, routeInfo?.route_color],
  );
  const routeTextColor = safeHexColor(routeInfo?.route_text_color, colors.white);
  const vehicleAccent = vehicleAccentColor(preferences.vehicleColor, routeInfo?.route_color);
  const activeServiceAlert = serviceAlerts[0] ?? null;
  const serviceAlertKey = React.useMemo(
    () => serviceAlerts.map((alert) => alert.alert_id).join('|'),
    [serviceAlerts],
  );
  // Keep this symbol deliberately generic: provider-specific alert effects do
  // not map consistently to Material icons, whereas an alert triangle stays
  // clear at the small size of the persistent tab.
  const serviceAlertIcon: IconName = 'alert-outline';
  const activeMapTheme = MAP_THEME_OPTIONS[mapTheme];
  const usesLightChrome = mapTheme === 'light';
  const chromeTextColor = usesLightChrome ? '#1F2937' : '#FFFFFF';
  const chromeMutedTextColor = usesLightChrome ? '#6B7280' : '#9FB0C8';
  const perspectiveMapPitch = mapTheme === 'satellite'
    ? (isLandscape ? 36 : 40)
    : (isLandscape ? 52 : 58);
  const mapPitch = mapViewMode === 'topDown' ? 0 : perspectiveMapPitch;
  const mapZoom = isLandscape ? 16.5 : 17;
  const mapSafeTop = Math.max(insets.top + 8, 12);
  const mapSafeLeft = Math.max(insets.left + 12, 12);
  const mapSafeRight = Math.max(insets.right + 12, 12);
  const portraitDriverPanelHeight = Math.max(164, Math.round(viewportHeight * 0.25));
  const standardBuildingOpacity = mapTheme === 'satellite'
    ? 0.18
    : usesLightChrome ? 0.78 : 0.68;
  const buildingExtrusionPaint = React.useMemo(() => ({
    'fill-extrusion-color': mapTheme === 'satellite'
      ? '#F8FAFC'
      : usesLightChrome ? '#94A3B8' : '#334155',
    'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
    'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
    'fill-extrusion-opacity': standardBuildingOpacity,
    'fill-extrusion-vertical-gradient': mapTheme !== 'satellite',
  }), [mapTheme, standardBuildingOpacity, usesLightChrome]);
  const routeCoordinates = React.useMemo(() => extractRouteCoordinates(routeFeature), [routeFeature]);
  const routePath = React.useMemo(() => buildRoutePath(routeCoordinates), [routeCoordinates]);
  const routeSource = React.useMemo(() => routeFeature
    ? {
      type: 'FeatureCollection' as const,
      features: [routeFeature],
    }
    : null, [routeFeature]);
  const completedRouteSource = React.useMemo(
    () => completedRouteFeature(routePath, displayRouteProgress),
    [displayRouteProgress, routePath],
  );
  const initialCameraCenter = displayCoords ?? routeCoordinates[0] ?? null;
  const stopsOnRoute = React.useMemo(
    () => extractStopsOnRoute(stopsFeature, routeCoordinates),
    [stopsFeature, routeCoordinates]
  );
  const matchedVehicle = React.useMemo(() => {
    if (!vehiclePositions.length) {
      return null;
    }

    if (assignedVehicle) {
      const assigned = vehiclePositions.find((vehicle) => vehicle.vehicle_id === assignedVehicle);
      if (assigned) {
        return assigned;
      }
    }

    if (tripId) {
      const byTrip = vehiclePositions.find((vehicle) => vehicle.trip_id === tripId);
      if (byTrip) {
        return byTrip;
      }
    }

    return null;
  }, [assignedVehicle, tripId, vehiclePositions]);
  const trackedVehicleProgress = React.useMemo(() => {
    if (!matchedVehicle || !routeCoordinates.length) {
      return null;
    }

    return projectPointOnRoute(
      [matchedVehicle.longitude, matchedVehicle.latitude],
      routeCoordinates,
    )?.distanceAlong ?? null;
  }, [matchedVehicle, routeCoordinates]);
  const realtimeSpeedKmh = typeof matchedVehicle?.speed === 'number'
    ? matchedVehicle.speed * MS_TO_KMH
    : null;
  const currentSpeedKmh = isSimulating
    ? simulationSpeedKmh
    : userSpeedKmh ?? realtimeSpeedKmh;
  const currentSpeedLabel = currentSpeedKmh === null
    ? '--'
    : String(Math.max(0, Math.round(currentSpeedKmh)));
  const trafficSpeedKmh = trafficSummary?.status !== 'unavailable'
    && !trafficSummary?.road_closure
    && typeof trafficSummary?.current_speed_kmh === 'number'
    && trafficSummary.current_speed_kmh > MIN_MOVING_SPEED_KMH
    ? trafficSummary.current_speed_kmh
    : null;
  const trafficEtaPillColor = trafficSummary?.status === 'dense'
    ? '#C97A12'
    : trafficSummary?.status === 'slow' || trafficSummary?.status === 'jammed'
      ? '#C13A3A'
        : trafficSummary?.status === 'closed'
          ? '#8B1E1E'
          : colors.primary;
  const trafficStatusKey: TranslationKey | null = trafficSummary?.status === 'normal'
    ? 'map.trafficNormal'
    : trafficSummary?.status === 'dense'
      ? 'map.trafficDense'
      : trafficSummary?.status === 'slow'
        ? 'map.trafficSlow'
        : trafficSummary?.status === 'jammed'
          ? 'map.trafficJammed'
          : trafficSummary?.status === 'closed'
            ? 'map.trafficClosed'
            : null;
  const trafficStatusLabel = trafficStatusKey ? t(trafficStatusKey) : null;
  const effectiveSpeedKmh = trafficSpeedKmh
    ?? (currentSpeedKmh !== null && currentSpeedKmh > MIN_MOVING_SPEED_KMH
      ? currentSpeedKmh
      : FALLBACK_CITY_SPEED_KMH);
  const currentRouteProgress = displayRouteProgress;
  const upcomingStops = React.useMemo(() => {
    if (!stopsOnRoute.length) {
      return [];
    }

    if (currentRouteProgress === null) {
      return stopsOnRoute;
    }

    const remainingStops = stopsOnRoute.filter((stop) => (
      stop.distanceAlong !== null && stop.distanceAlong > currentRouteProgress + 12
    ));
    return remainingStops.length ? remainingStops : [stopsOnRoute[stopsOnRoute.length - 1]];
  }, [currentRouteProgress, stopsOnRoute]);
  const nextStop = upcomingStops[0] ?? null;
  const followingStop = upcomingStops[1] ?? null;
  const nextStopDistanceMeters = nextStop?.distanceAlong !== null && nextStop?.distanceAlong !== undefined && currentRouteProgress !== null
    ? Math.max(0, nextStop.distanceAlong - currentRouteProgress)
    : (nextStop ? distanceMeters(displayCoords, nextStop.coordinates) : null);
  const nextStopEtaMinutes = nextStopDistanceMeters === null
    ? null
    : ((nextStopDistanceMeters / 1000) / effectiveSpeedKmh) * 60;
  const routeProgressPercent = routePath.totalDistance > 0 && currentRouteProgress !== null
    ? clamp((currentRouteProgress / routePath.totalDistance) * 100, 0, 100)
    : 0;
  const journeyStops = React.useMemo(() => stopsOnRoute.flatMap((stop) => {
    if (stop.distanceAlong === null || routePath.totalDistance <= 0) return [];
    return [{
      key: `${stop.stop_id ?? stop.sequence}-${stop.sequence}`,
      progress: clamp((stop.distanceAlong / routePath.totalDistance) * 100, 0, 100),
      isPassed: currentRouteProgress !== null && stop.distanceAlong <= currentRouteProgress + 12,
      isNext: stop === nextStop,
      isFollowing: stop === followingStop,
    }];
  }), [currentRouteProgress, followingStop, nextStop, routePath.totalDistance, stopsOnRoute]);
  const liveActivityProps = React.useMemo<RouteLiveActivityProps>(() => {
    const updatedAtEpochMs = Date.now();
    const hasValidEta = nextStopEtaMinutes !== null
      && Number.isFinite(nextStopEtaMinutes)
      && nextStopEtaMinutes >= 0;
    const isArrivingNow = hasValidEta && nextStopEtaMinutes <= 1;

    return {
      line: String(routeShortName),
      direction: directionName || t('common.directionPending'),
      nextStop: nextStop?.stop_name || t('map.calculatingStop'),
      nextStopLabel: t('map.nextStop'),
      etaLabel: t('map.eta'),
      etaValue: hasValidEta ? t('common.now') : '--',
      updatedAtEpochMs,
      etaEpochMs: hasValidEta && !isArrivingNow
        ? updatedAtEpochMs + Math.round(nextStopEtaMinutes * 60_000)
        : 0,
      routeColor,
      routeTextColor,
    };
  }, [
    directionName,
    nextStop?.stop_name,
    nextStopEtaMinutes,
    routeColor,
    routeShortName,
    routeTextColor,
    t,
  ]);
  liveActivityPropsRef.current = liveActivityProps;
  const liveActivityReady = preferences.liveActivitiesEnabled
    && !loading
    && !error
    && Boolean(routeInfo);

  useEffect(() => {
    if (!serviceAlertKey) {
      presentedServiceAlertKeyRef.current = '';
      setIsServiceAlertModalVisible(false);
      setIsServiceAlertTabDismissed(false);
      return;
    }

    if (presentedServiceAlertKeyRef.current !== serviceAlertKey) {
      presentedServiceAlertKeyRef.current = serviceAlertKey;
      setIsServiceAlertTabDismissed(false);
      setIsServiceAlertModalVisible(true);
    }
  }, [serviceAlertKey]);

  useEffect(() => {
    const initialProps = liveActivityPropsRef.current;
    if (!liveActivityReady || !initialProps) {
      liveActivityStartedRef.current = false;
      return undefined;
    }

    let disposed = false;
    void startRouteLiveActivity(initialProps).then((started) => {
      if (disposed) {
        if (started) void endRouteLiveActivity();
        return;
      }
      liveActivityStartedRef.current = started;
    });

    return () => {
      disposed = true;
      liveActivityStartedRef.current = false;
      void endRouteLiveActivity();
    };
  }, [directionId, liveActivityReady, routeId]);

  useEffect(() => {
    if (!liveActivityReady || !liveActivityStartedRef.current) return;
    void updateRouteLiveActivity(liveActivityProps);
  }, [liveActivityProps, liveActivityReady]);

  const estimatedArrival = formatEstimatedArrival(nextStopEtaMinutes);
  const selectedStopCoords = selectedStop?.coordinates ?? null;
  const selectedStopProjection = projectPointOnRoute(selectedStopCoords, routeCoordinates);
  const selectedStopDistanceMeters = selectedStopProjection && currentRouteProgress !== null
    ? Math.abs(selectedStopProjection.distanceAlong - currentRouteProgress)
    : distanceMeters(displayCoords, selectedStopCoords);
  const selectedStopEtaMinutes = selectedStopDistanceMeters === null
    ? null
    : ((selectedStopDistanceMeters / 1000) / effectiveSpeedKmh) * 60;
  // A manually entered vehicle *or a scheduled trip once ATM assigns it a
  // vehicle* must be the fleet reference. Without the trip-id branch,
  // selecting a departure would silently keep using the phone GPS instead of
  // the vehicle that is actually serving that departure.
  const tracksRealtimeVehicle = Boolean(matchedVehicle && (assignedVehicle || tripId));
  const fleetReferenceProgress = tracksRealtimeVehicle
    ? trackedVehicleProgress
    : currentRouteProgress;
  const fleetMetrics = React.useMemo(() => {
    if (!routeCoordinates.length || fleetReferenceProgress === null || !vehiclePositions.length) {
      return [];
    }

    type FleetVehicle = { vehicle: VehiclePosition; update?: RTTripUpdate; deltaMeters: number };
    let previous: FleetVehicle | null = null;
    let next: FleetVehicle | null = null;

    vehiclePositions.forEach((vehicle) => {
      const isOwnVehicle = Boolean(
        (assignedVehicle && vehicle.vehicle_id === assignedVehicle)
        || (tripId && vehicle.trip_id === tripId)
      );
      const update = routeTripUpdates.find((candidate) => (
        candidate.trip_id === vehicle.trip_id
        || (vehicle.vehicle_id && candidate.vehicle_id === vehicle.vehicle_id)
      ));
      const vehicleDirection = vehicle.direction_id ?? update?.direction_id ?? null;
      if (
        isOwnVehicle
        || vehicleDirection !== directionId
        || !Number.isFinite(vehicle.latitude)
        || !Number.isFinite(vehicle.longitude)
      ) return;

      const projection = projectPointOnRoute([vehicle.longitude, vehicle.latitude], routeCoordinates);
      if (!projection) return;

      const deltaMeters = projection.distanceAlong - fleetReferenceProgress;
      if (Math.abs(deltaMeters) < 25) return;
      const candidate = { vehicle, update, deltaMeters };

      if (deltaMeters > 0 && (!previous || deltaMeters < previous.deltaMeters)) {
        previous = candidate;
      }
      if (deltaMeters < 0 && (!next || Math.abs(deltaMeters) < Math.abs(next.deltaMeters))) {
        next = candidate;
      }
    });

    const buildMetric = (candidate: FleetVehicle, kind: 'previous' | 'next') => {
      const { vehicle, update, deltaMeters } = candidate;
      const stop = stopsOnRoute.find((item) => (
        Boolean(vehicle.stop_id) && item.stop_id === vehicle.stop_id
      ) || (
          vehicle.current_stop_sequence !== null
          && (item.stop_sequence === vehicle.current_stop_sequence || item.sequence === vehicle.current_stop_sequence)
        ));
      const hasStopLocation = Boolean(stop?.stop_name && vehicle.current_status);
      const location = hasStopLocation
        ? vehicle.current_status === 'STOPPED_AT'
          ? t('map.fleetAtStop', { stop: stop!.stop_name! })
          : t('map.fleetTowards', { stop: stop!.stop_name! })
        : t(deltaMeters > 0 ? 'map.fleetAhead' : 'map.fleetBehind', {
          distance: formatDistance(Math.abs(deltaMeters), language),
        });
      const delaySeconds = reportedVehicleDelay(update, vehicle);
      const delay = delaySeconds === null
        ? null
        : delaySeconds > 0
          ? t('map.delayLate', { time: formatDelayDuration(delaySeconds) })
          : t('map.delayEarly', { time: formatDelayDuration(delaySeconds) });

      return {
        icon: (kind === 'previous' ? 'arrow-up' : 'arrow-down') as IconName,
        title: t(kind === 'previous' ? 'map.fleetAheadVehicle' : 'map.fleetBehindVehicle', {
          vehicle: vehicle.vehicle_id,
        }),
        location,
        delay,
      };
    };

    return [
      ...(previous ? [buildMetric(previous, 'previous')] : []),
      ...(next ? [buildMetric(next, 'next')] : []),
    ];
  }, [
    assignedVehicle,
    directionId,
    fleetReferenceProgress,
    language,
    routeCoordinates,
    routeTripUpdates,
    stopsOnRoute,
    t,
    tripId,
    vehiclePositions,
  ]);
  const driverMetrics: DriverMetric[] = [
    { icon: 'speedometer' as IconName, label: `${currentSpeedLabel} km/h` },
    nextStopDistanceMeters !== null
      ? { icon: 'map-marker-distance' as IconName, label: formatDistance(nextStopDistanceMeters, language) }
      : null,
    estimatedArrival
      ? {
        icon: 'clock-time-four-outline' as IconName,
        label: t('map.arrival', { time: estimatedArrival }),
      }
      : null,
  ].filter((metric): metric is DriverMetric => metric !== null);
  const visibleDriverMetrics = driverMetrics;
  const landscapeDriverPanelHeight = fleetMetrics.length > 0 ? 146 : 104;
  const driverPanelClearance = isLandscape
    ? landscapeDriverPanelHeight + 18
    : portraitDriverPanelHeight + 20;
  const mapOrnamentBottom = Math.max(
    insets.bottom + driverPanelClearance,
    driverPanelClearance,
  );

  useEffect(() => {
    let active = true;

    const configureBackgroundTracking = async () => {
      if (!preferences.backgroundLocationEnabled) {
        await stopBackgroundRouteTracking();
        return;
      }

      // The foreground GPS watcher owns the only permission prompt. Once the
      // route is active, iOS may continue that user-initiated session in the
      // background with its visible location indicator; “Always” is not used.
      if (!locationGranted) return;

      const permission = await requestBackgroundRoutePermission();
      if (!active) return;
      if (permission !== 'granted') {
        setBackgroundLocationEnabled(false);
        await stopBackgroundRouteTracking();
        return;
      }

      const started = await startBackgroundRouteTracking();
      if (active && !started) {
        console.warn('Background route tracking is unavailable');
      }
    };

    void configureBackgroundTracking().catch(() => {
      if (active) {
        console.warn('Background route tracking could not start');
      }
    });

    return () => {
      active = false;
      void stopBackgroundRouteTracking();
    };
  }, [locationGranted, preferences.backgroundLocationEnabled, setBackgroundLocationEnabled]);

  useEffect(() => () => {
    if (orientationTransitionTimerRef.current) {
      clearTimeout(orientationTransitionTimerRef.current);
    }
    if (mapThemeTransitionTimerRef.current) {
      clearTimeout(mapThemeTransitionTimerRef.current);
      mapThemeTransitionTimerRef.current = null;
    }
    mapThemeTransitionGenerationRef.current += 1;
    mapThemeTransitionOpacity.stopAnimation();
  }, [mapThemeTransitionOpacity]);

  // Request location permissions and start watching GPS coordinates/heading
  useEffect(() => {
    let positionSubscription: Location.LocationSubscription | null = null;
    let headingSubscription: Location.LocationSubscription | null = null;
    let active = true;

    const refreshHeadingExpiry = () => {
      if (deviceHeadingExpiryTimerRef.current) {
        clearTimeout(deviceHeadingExpiryTimerRef.current);
      }
      deviceHeadingExpiryTimerRef.current = setTimeout(() => {
        if (!active) return;
        smoothedDeviceHeadingRef.current = null;
        lastDeviceHeadingUpdateRef.current = 0;
        setDeviceHeading(null);
        deviceHeadingExpiryTimerRef.current = null;
      }, DEVICE_HEADING_STALE_AFTER_MS);
    };

    const handleDeviceHeading = (heading: Location.LocationHeadingObject) => {
      if (!active) return;
      const rawReading = selectDeviceHeading(heading);
      if (!rawReading) return;
      const reading = rawReading;

      refreshHeadingExpiry();
      const current = smoothedDeviceHeadingRef.current;
      if (current === null) {
        smoothedDeviceHeadingRef.current = reading.degrees;
        lastDeviceHeadingUpdateRef.current = Date.now();
        setDeviceHeading(reading);
        return;
      }

      const delta = shortestHeadingDelta(current, reading.degrees);
      if (Math.abs(delta) < DEVICE_HEADING_DEADBAND_DEGREES) {
        return;
      }
      const now = Date.now();
      if (
        now - lastDeviceHeadingUpdateRef.current < DEVICE_HEADING_MIN_UPDATE_INTERVAL_MS
        && Math.abs(delta) < 20
      ) {
        return;
      }

      // Higher quality readings can react faster. Large deliberate turns also
      // receive a little more weight, while small compass noise is damped.
      const accuracyWeight = reading.accuracy >= 3
        ? 0.42
        : reading.accuracy >= 2 ? 0.32 : 0.22;
      const smoothingWeight = Math.abs(delta) >= 35
        ? Math.max(accuracyWeight, 0.52)
        : accuracyWeight;
      const nextDegrees = normalizeHeading(current + delta * smoothingWeight);
      smoothedDeviceHeadingRef.current = nextDegrees;
      lastDeviceHeadingUpdateRef.current = now;
      setDeviceHeading({ ...reading, degrees: nextDegrees });
    };

    async function setupLocation() {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (!active) return;
        const granted = status === 'granted';
        setLocationGranted(granted);

        if (granted) {
          const nextPositionSubscription = await Location.watchPositionAsync(
            {
              accuracy: Location.Accuracy.BestForNavigation,
              timeInterval: 1000,
              distanceInterval: 1,
            },
            (loc) => {
              if (!active || !loc.coords) return;
              setGpsFix({
                coordinate: [loc.coords.longitude, loc.coords.latitude],
                accuracyMeters: typeof loc.coords.accuracy === 'number'
                  && loc.coords.accuracy >= 0
                  ? loc.coords.accuracy
                  : null,
                speedKmh: typeof loc.coords.speed === 'number' && loc.coords.speed >= 0
                  ? loc.coords.speed * MS_TO_KMH
                  : null,
                headingDegrees: isValidHeading(loc.coords.heading)
                  ? normalizeHeading(loc.coords.heading)
                  : null,
                timestampMs: typeof loc.timestamp === 'number' && Number.isFinite(loc.timestamp)
                  ? loc.timestamp
                  : Date.now(),
              });
            }
          );
          if (!active) {
            nextPositionSubscription.remove();
            return;
          }
          positionSubscription = nextPositionSubscription;

          try {
            const nextHeadingSubscription = await Location.watchHeadingAsync(
              handleDeviceHeading,
              (message) => console.warn('Device heading unavailable:', message),
            );
            if (!active) {
              nextHeadingSubscription.remove();
              return;
            }
            headingSubscription = nextHeadingSubscription;
          } catch (headingError) {
            // Position tracking remains active: the marker falls back to its
            // GPS course and finally to the matched route bearing.
            console.warn('Error starting device heading:', headingError);
          }
        } else {
          console.warn('Location permission not granted');
        }
      } catch (err) {
        console.error('Error starting location tracking:', err);
      }
    }

    setupLocation();

    return () => {
      active = false;
      if (deviceHeadingExpiryTimerRef.current) {
        clearTimeout(deviceHeadingExpiryTimerRef.current);
        deviceHeadingExpiryTimerRef.current = null;
      }
      smoothedDeviceHeadingRef.current = null;
      lastDeviceHeadingUpdateRef.current = 0;
      if (positionSubscription) {
        positionSubscription.remove();
      }
      if (headingSubscription) {
        headingSubscription.remove();
      }
    };
  }, []);

  useEffect(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    routeMatchingStateRef.current = createRouteMatchingState('offRoute');
    visualPoseRef.current = null;
    lastSnappedProgressRef.current = null;
    setVisualPose(null);
    setDisplayRouteProgress(null);
  }, [routeId, directionId, tripId]);

  useEffect(() => {
    if (!gpsFix || isSimulating) return undefined;

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const projection = projectPointOnRoute(gpsFix.coordinate, routeCoordinates, {
      previousDistanceAlong: lastSnappedProgressRef.current,
      headingDegrees: gpsFix.headingDegrees,
    });
    let targetPose: VisualPose;

    if (!projection) {
      setDisplayRouteProgress(null);
      const nativeHeading = typeof gpsFix.headingDegrees === 'number'
        && gpsFix.headingDegrees >= 0
        && gpsFix.headingDegrees <= 360
        ? gpsFix.headingDegrees % 360
        : visualPoseRef.current?.bearing ?? 0;
      targetPose = {
        coordinate: gpsFix.coordinate,
        bearing: nativeHeading,
        routeProgress: null,
      };
    } else {
      const result = updateRouteMatch(routeMatchingStateRef.current, {
        rawCoordinate: gpsFix.coordinate,
        snappedCoordinate: projection.coordinate,
        distanceFromRouteMeters: projection.distanceFromRoute,
        accuracyMeters: gpsFix.accuracyMeters,
        headingDegrees: gpsFix.headingDegrees,
        timestampMs: gpsFix.timestampMs,
      });
      routeMatchingStateRef.current = result.state;
      if (result.transition) {
        telemetry.capture('map_match_changed', {
          mode: result.mode === 'offRoute' ? 'off_route' : 'snapped',
        });
      }

      if (result.mode === 'snapped') {
        lastSnappedProgressRef.current = projection.distanceAlong;
        setDisplayRouteProgress(projection.distanceAlong);
      }
      targetPose = {
        coordinate: result.visualTarget,
        bearing: result.mode === 'snapped'
          ? projection.bearing
          : result.headingDegrees ?? visualPoseRef.current?.bearing ?? projection.bearing,
        routeProgress: result.mode === 'snapped' ? projection.distanceAlong : null,
      };
    }

    const fromPose = visualPoseRef.current ?? targetPose;
    const movement = distanceMeters(fromPose.coordinate, targetPose.coordinate) ?? 0;
    const bearingDelta = Math.abs(
      ((targetPose.bearing - fromPose.bearing + 540) % 360) - 180,
    );
    const followsRoute = fromPose.routeProgress !== null && targetPose.routeProgress !== null;
    const routeProgressDelta = followsRoute
      ? Math.abs(targetPose.routeProgress! - fromPose.routeProgress!)
      : 0;
    if (movement < 1 && bearingDelta < 1 && routeProgressDelta < 1) {
      visualPoseRef.current = targetPose;
      setVisualPose(targetPose);
      return undefined;
    }

    const duration = clamp((followsRoute ? routeProgressDelta : movement) * 10, 600, 700);
    const startTime = Date.now();
    const step = () => {
      const ratio = clamp((Date.now() - startTime) / duration, 0, 1);
      const easedRatio = ratio < 1 ? ratio * ratio * (3 - 2 * ratio) : 1;
      const nextRouteProgress = followsRoute
        ? fromPose.routeProgress!
        + (targetPose.routeProgress! - fromPose.routeProgress!) * easedRatio
        : null;
      const routePosition = nextRouteProgress === null
        ? null
        : coordinateAtRouteDistance(routePath, nextRouteProgress);
      let nextPose: VisualPose;
      if (ratio >= 1) {
        nextPose = targetPose;
      } else if (routePosition) {
        nextPose = {
          coordinate: routePosition,
          bearing: interpolateBearing(fromPose.bearing, targetPose.bearing, easedRatio),
          routeProgress: nextRouteProgress,
        };
      } else {
        nextPose = {
          coordinate: interpolateCoordinate(
            fromPose.coordinate,
            targetPose.coordinate,
            easedRatio,
          ),
          bearing: interpolateBearing(fromPose.bearing, targetPose.bearing, easedRatio),
          routeProgress: null,
        };
      }
      visualPoseRef.current = nextPose;
      setVisualPose(nextPose);

      if (ratio < 1) {
        animationFrameRef.current = requestAnimationFrame(step);
      } else {
        animationFrameRef.current = null;
      }
    };
    step();

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [gpsFix, isSimulating, routeCoordinates, routePath]);

  useEffect(() => {
    if (!isSimulating || !routePath.segments.length || routePath.totalDistance <= 0) {
      return undefined;
    }

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const initialPose = poseAtRouteDistance(routePath, 0);
    if (!initialPose) return undefined;

    visualPoseRef.current = initialPose;
    lastSnappedProgressRef.current = 0;
    setVisualPose(initialPose);
    setDisplayRouteProgress(0);
    setSimulationSpeedKmh(0);
    setIsCameraFollowing(true);

    let progressMeters = 0;
    let speedMetersPerSecond = 0;
    let previousTimestamp: number | null = null;
    let cruiseSpeedKmh = randomBetween(
      SIMULATION_MIN_CRUISE_SPEED_KMH,
      SIMULATION_MAX_CRUISE_SPEED_KMH,
    );
    let nextCruiseChangeAt = 0;
    let dwellUntil = 0;
    let nextStopIndex = 0;
    const simulationStops = stopsOnRoute
      .map((stop) => stop.distanceAlong)
      .filter((distance): distance is number => (
        distance !== null
        && distance > 8
        && distance < routePath.totalDistance - 3
      ))
      .filter((distance, index, distances) => index === 0 || distance - distances[index - 1] > 8);

    const step = (timestamp: number) => {
      if (previousTimestamp !== null) {
        const elapsedMs = clamp(timestamp - previousTimestamp, 0, 100);
        const elapsedSeconds = elapsedMs / 1_000;

        if (timestamp < dwellUntil) {
          speedMetersPerSecond = 0;
        } else {
          if (dwellUntil > 0) {
            dwellUntil = 0;
            nextStopIndex += 1;
            cruiseSpeedKmh = randomBetween(
              SIMULATION_MIN_CRUISE_SPEED_KMH,
              SIMULATION_MAX_CRUISE_SPEED_KMH,
            );
            nextCruiseChangeAt = timestamp + randomBetween(4_500, 9_500);
          } else if (timestamp >= nextCruiseChangeAt) {
            cruiseSpeedKmh = randomBetween(
              SIMULATION_MIN_CRUISE_SPEED_KMH,
              SIMULATION_MAX_CRUISE_SPEED_KMH,
            );
            nextCruiseChangeAt = timestamp + randomBetween(4_500, 9_500);
          }

          const activeStopDistance = simulationStops[nextStopIndex] ?? null;
          const distanceToStop = activeStopDistance === null
            ? Number.POSITIVE_INFINITY
            : Math.max(0, activeStopDistance - progressMeters);
          const cruiseMetersPerSecond = cruiseSpeedKmh / MS_TO_KMH;
          const stoppingTargetMetersPerSecond = Number.isFinite(distanceToStop)
            ? Math.sqrt(
              2 * SIMULATION_BRAKING_MPS2 * distanceToStop,
            )
            : cruiseMetersPerSecond;
          const targetSpeed = Math.min(cruiseMetersPerSecond, stoppingTargetMetersPerSecond);
          const acceleration = targetSpeed < speedMetersPerSecond
            ? SIMULATION_BRAKING_MPS2
            : SIMULATION_ACCELERATION_MPS2;
          speedMetersPerSecond = moveTowards(
            speedMetersPerSecond,
            targetSpeed,
            acceleration * elapsedSeconds,
          );

          const movementMeters = speedMetersPerSecond * elapsedSeconds;
          if (
            activeStopDistance !== null
            && progressMeters + movementMeters >= activeStopDistance - 0.05
          ) {
            progressMeters = activeStopDistance;
            speedMetersPerSecond = 0;
            dwellUntil = timestamp + randomBetween(3_500, 7_500);
          } else {
            progressMeters = Math.min(
              routePath.totalDistance,
              progressMeters + movementMeters,
            );
            if (progressMeters >= routePath.totalDistance) {
              speedMetersPerSecond = 0;
            }
          }
        }
      }
      previousTimestamp = timestamp;
      setSimulationSpeedKmh(speedMetersPerSecond * MS_TO_KMH);

      const nextPose = poseAtRouteDistance(routePath, progressMeters);
      if (nextPose) {
        visualPoseRef.current = nextPose;
        lastSnappedProgressRef.current = progressMeters;
        setVisualPose(nextPose);
        setDisplayRouteProgress(progressMeters);
      }

      if (progressMeters < routePath.totalDistance) {
        simulationFrameRef.current = requestAnimationFrame(step);
      } else {
        simulationFrameRef.current = null;
      }
    };

    simulationFrameRef.current = requestAnimationFrame(step);

    return () => {
      if (simulationFrameRef.current !== null) {
        cancelAnimationFrame(simulationFrameRef.current);
        simulationFrameRef.current = null;
      }
    };
  }, [isSimulating, routePath, stopsOnRoute]);

  // Load route data and connect WebSocket
  useEffect(() => {
    let active = true;
    let liveSocket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let liveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let subscriptionTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let liveRefreshInFlight = false;
    let lastLiveRefreshAt = 0;
    let lastTripUpdatesSuccessAt = 0;
    let lastVehiclesSuccessAt = 0;

    async function refreshLiveData(candidateRouteIds = [routeId]) {
      if (!active) return;
      if (liveRefreshInFlight) {
        return;
      }

      liveRefreshInFlight = true;
      const realtimeRouteIds = [...new Set(candidateRouteIds.filter(Boolean))];
      const [tripUpdateResults, vehicleResults, alertResults] = await Promise.all([
        Promise.allSettled(realtimeRouteIds.map((candidateRouteId) => (
          apiService.fetchRouteTripUpdates(candidateRouteId)
        ))),
        Promise.allSettled(realtimeRouteIds.map((candidateRouteId) => (
          apiService.fetchRouteVehicles(candidateRouteId)
        ))),
        Promise.allSettled(realtimeRouteIds.map((candidateRouteId) => (
          apiService.fetchRouteServiceAlerts(candidateRouteId, directionId)
        ))),
      ]);
      lastLiveRefreshAt = Date.now();

      if (active) {
        // Preserve the last-good component independently when one endpoint is
        // degraded; an ATM vehicle feed outage must not erase trip updates.
        if (tripUpdateResults.some((result) => result.status === 'fulfilled')) {
          lastTripUpdatesSuccessAt = lastLiveRefreshAt;
          setRouteTripUpdates(deduplicateRealtimeItems(
            fulfilledRealtimeValues(tripUpdateResults),
            (update) => update.trip_id,
          ));
        } else if (lastLiveRefreshAt - lastTripUpdatesSuccessAt > LIVE_DATA_STALE_AFTER_MS) {
          setRouteTripUpdates([]);
        }
        if (vehicleResults.some((result) => result.status === 'fulfilled')) {
          lastVehiclesSuccessAt = lastLiveRefreshAt;
          setVehiclePositions(deduplicateRealtimeItems(
            fulfilledRealtimeValues(vehicleResults),
            (vehicle) => vehicle.vehicle_id,
          ));
        } else if (lastLiveRefreshAt - lastVehiclesSuccessAt > LIVE_DATA_STALE_AFTER_MS) {
          setVehiclePositions([]);
        }
        if (alertResults.some((result) => result.status === 'fulfilled')) {
          setServiceAlerts(deduplicateRealtimeItems(
            fulfilledRealtimeValues(alertResults),
            (alert) => alert.alert_id,
          ));
        }
      }

      liveRefreshInFlight = false;
      if (active) {
        scheduleLiveRefresh();
      }
    }

    function scheduleLiveRefresh() {
      if (!active || liveRefreshTimer) return;
      const elapsed = Date.now() - lastLiveRefreshAt;
      const throttleDelay = Math.max(0, LIVE_REFRESH_MIN_INTERVAL_MS - elapsed);
      const jitter = Math.round(Math.random() * LIVE_REFRESH_JITTER_MS);
      liveRefreshTimer = setTimeout(() => {
        liveRefreshTimer = null;
        void refreshLiveData();
      }, throttleDelay + jitter);
    }

    function handleLiveMessage(message: LiveWebSocketMessage) {
      if ('type' in message && message.type === 'subscribed') {
        if (message.topics.includes('atm_rt:updates')) {
          if (subscriptionTimer) {
            clearTimeout(subscriptionTimer);
            subscriptionTimer = null;
          }
          reconnectAttempt = 0;
          setIsConnected(true);
        }
        return;
      }
      if ('type' in message && message.type === 'error') {
        setIsConnected(false);
        liveSocket?.close();
        return;
      }
      if (
        'topic' in message
        && message.topic === 'atm_rt:updates'
        && message.data.type === 'invalidate'
      ) {
        scheduleLiveRefresh();
      }
    }

    function scheduleReconnect() {
      if (!active || reconnectTimer) return;
      const baseDelay = Math.min(
        LIVE_RECONNECT_MAX_MS,
        1_000 * (2 ** Math.min(reconnectAttempt, 5)),
      );
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectLiveSocket();
      }, baseDelay + Math.round(Math.random() * 500));
    }

    function connectLiveSocket() {
      if (!active) return;
      const socket = apiService.connectWebSocket(handleLiveMessage);
      liveSocket = socket;
      if (subscriptionTimer) clearTimeout(subscriptionTimer);
      subscriptionTimer = setTimeout(() => {
        subscriptionTimer = null;
        if (active && liveSocket === socket) socket.close();
      }, LIVE_SUBSCRIPTION_TIMEOUT_MS);
      socket.addEventListener('close', () => {
        if (liveSocket === socket) liveSocket = null;
        if (subscriptionTimer) {
          clearTimeout(subscriptionTimer);
          subscriptionTimer = null;
        }
        if (!active) return;
        setIsConnected(false);
        scheduleReconnect();
      });
      socket.addEventListener('error', () => {
        if (!active) return;
        setIsConnected(false);
        try {
          socket.close();
        } catch {
          // The close event or connect timeout will drive bounded reconnect.
        }
      });
    }

    async function loadData() {
      const loadStartedAt = Date.now();
      let loadSucceeded = false;
      setLoading(true);
      setError(null);
      setIsConnected(false);
      setRouteFeature(null);
      setStopsFeature(null);
      setSelectedStop(null);
      setRouteInfo(null);
      setRouteTripUpdates([]);
      setVehiclePositions([]);
      setServiceAlerts([]);
      setIsServiceAlertModalVisible(false);
      presentedServiceAlertKeyRef.current = '';
      try {
        const [data, stopsData] = await Promise.all([
          apiService.fetchRouteShape(routeId, directionId, tripId),
          apiService.fetchRouteStops(routeId, directionId, tripId),
        ]);
        if (!active) return;
        let liveRouteIds = [routeId];
        if (data) {
          setRouteInfo(data);
          liveRouteIds = [...new Set([routeId, ...(data.route_ids ?? [])])];
          if (data.geojson) {
            setRouteFeature(data.geojson);
          }
        }

        if (stopsData && stopsData.features) {
          setStopsFeature(stopsData);
        }

        // Alert failures are isolated inside the live refresh; a temporary
        // incident-feed issue must not block the selected route.
        await refreshLiveData(liveRouteIds);
        if (!active) return;
        connectLiveSocket();
        loadSucceeded = true;
      } catch (e: unknown) {
        if (active) {
          telemetry.captureException(e, { phase: 'map_data' });
          setError('map_data');
        }
      } finally {
        if (active) {
          telemetry.capture('map_loaded', {
            direction: directionId,
            duration_ms: Date.now() - loadStartedAt,
            status: loadSucceeded ? 'success' : 'error',
          });
          setLoading(false);
        }
      }
    }

    void loadData();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
      if (subscriptionTimer) clearTimeout(subscriptionTimer);
      liveSocket?.close();
    };
  }, [routeId, directionId, tripId]);

  const handleMapPress = async (event: any) => {
    if (!mapRef.current) return;

    setSelectedStop(null);

    let x: number | null = null;
    let y: number | null = null;

    // Safely extract coordinates depending on the event structure of the MapLibre version
    if (event?.nativeEvent?.point) {
      if (Array.isArray(event.nativeEvent.point)) {
        x = event.nativeEvent.point[0];
        y = event.nativeEvent.point[1];
      } else if (typeof event.nativeEvent.point === 'object') {
        x = event.nativeEvent.point.x;
        y = event.nativeEvent.point.y;
      }
    } else if (event?.point) {
      if (Array.isArray(event.point)) {
        x = event.point[0];
        y = event.point[1];
      } else if (typeof event.point === 'object') {
        x = event.point.x;
        y = event.point.y;
      }
    } else if (event?.properties) {
      x = event.properties.screenPointX;
      y = event.properties.screenPointY;
    }

    if (x === null || y === null) {
      return;
    }

    try {
      const features = await mapRef.current.queryRenderedFeatures(
        [
          [x - 14, y - 14],
          [x + 14, y + 14]
        ],
        { layers: ['stopsCircle'] }
      );

      let selectedFeature: any = null;

      if (features && Array.isArray(features) && features.length > 0) {
        selectedFeature = features[0];
      } else if (features && features.features && features.features.length > 0) {
        selectedFeature = features.features[0];
      }

      if (selectedFeature?.properties) {
        const selectedFeatureProperties = selectedFeature.properties;
        setSelectedStop({
          ...selectedFeatureProperties,
          coordinates: normalizeCoordinates(selectedFeature.geometry?.coordinates),
        });
      } else {
        setSelectedStop(null);
      }
    } catch (e) {
      telemetry.captureException(e, { phase: 'map_feature_query' });
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>{t('map.loading')}</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{t('map.error')}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.retryText}>{t('map.retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const handleRegionChange = (event: any) => {
    const eventBearing = event?.nativeEvent?.bearing ?? event?.properties?.bearing;

    if (typeof eventBearing === 'number') {
      const nextBearing = (eventBearing + 360) % 360;
      setMapBearing((current) => (
        Math.abs(((nextBearing - current + 540) % 360) - 180) >= 0.5
          ? nextBearing
          : current
      ));
    }
  };

  const releaseCameraFollow = () => {
    if (orientationTransitionTimerRef.current) {
      clearTimeout(orientationTransitionTimerRef.current);
      orientationTransitionTimerRef.current = null;
    }
    setCameraTransitionDuration(0);
    setIsCameraFollowing(false);
  };

  const handleRegionWillChange = (event: any) => {
    const isUserInteraction = event?.nativeEvent?.userInteraction
      ?? event?.userInteraction
      ?? false;

    if (isUserInteraction) {
      releaseCameraFollow();
    }
  };

  const finishMapThemeTransition = (generation: number) => {
    if (
      generation !== mapThemeTransitionGenerationRef.current
      || mapThemeFadeGenerationRef.current === generation
    ) {
      return;
    }

    mapThemeFadeGenerationRef.current = generation;
    if (mapThemeTransitionTimerRef.current) {
      clearTimeout(mapThemeTransitionTimerRef.current);
      mapThemeTransitionTimerRef.current = null;
    }

    Animated.timing(mapThemeTransitionOpacity, {
      toValue: 0,
      duration: 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished || generation !== mapThemeTransitionGenerationRef.current) {
        return;
      }

      setPendingMapTheme(null);
      mapThemeTransitionTargetRef.current = null;
      mapThemeStyleReadyGenerationRef.current = null;
      mapThemeFadeGenerationRef.current = null;
    });
  };

  const handleMapThemeChange = (theme: MapTheme) => {
    setIsMapThemePickerOpen(false);

    const currentTarget = mapThemeTransitionTargetRef.current;
    if (theme === currentTarget || (!currentTarget && theme === appliedMapThemeRef.current)) {
      return;
    }

    if (mapThemeTransitionTimerRef.current) {
      clearTimeout(mapThemeTransitionTimerRef.current);
      mapThemeTransitionTimerRef.current = null;
    }
    mapThemeTransitionOpacity.stopAnimation();

    const generation = mapThemeTransitionGenerationRef.current + 1;
    mapThemeTransitionGenerationRef.current = generation;
    mapThemeStyleReadyGenerationRef.current = null;
    mapThemeFadeGenerationRef.current = null;

    // A second tap can return to the style that is still on screen before the
    // first switch is applied. Cancel that pending switch instead of reloading
    // the exact same style.
    if (theme === appliedMapThemeRef.current) {
      mapThemeTransitionTargetRef.current = null;
      setPendingMapTheme(null);
      Animated.timing(mapThemeTransitionOpacity, {
        toValue: 0,
        duration: 160,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }

    mapThemeTransitionTargetRef.current = theme;
    setPendingMapTheme(theme);
    setMapThemeTransitionColor(MAP_THEME_TRANSITION_COLORS[theme]);

    // Fade the cheap native veil in first, then rebuild the style underneath.
    // The generation check makes rapid theme changes safely interruptible.
    Animated.timing(mapThemeTransitionOpacity, {
      toValue: 0.94,
      duration: 110,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished || generation !== mapThemeTransitionGenerationRef.current) {
        return;
      }

      appliedMapThemeRef.current = theme;
      setMapTheme(theme);
      mapThemeTransitionTimerRef.current = setTimeout(
        () => finishMapThemeTransition(generation),
        MAP_THEME_TRANSITION_MAX_MS,
      );
    });
  };

  const handleMapStyleLoaded = () => {
    const generation = mapThemeTransitionGenerationRef.current;
    const target = mapThemeTransitionTargetRef.current;
    if (
      target
      && mapTheme === target
      && appliedMapThemeRef.current === target
    ) {
      mapThemeStyleReadyGenerationRef.current = generation;
    }
  };

  const handleMapRenderedFully = () => {
    const generation = mapThemeTransitionGenerationRef.current;
    if (
      mapThemeTransitionTargetRef.current === mapTheme
      && mapThemeStyleReadyGenerationRef.current === generation
    ) {
      finishMapThemeTransition(generation);
    }
  };

  const handleMapViewMode = () => {
    const nextMode: MapViewMode = mapViewMode === 'perspective' ? 'topDown' : 'perspective';
    if (orientationTransitionTimerRef.current) {
      clearTimeout(orientationTransitionTimerRef.current);
    }

    setMapViewMode(nextMode);

    if (isCameraFollowing) {
      setCameraTransitionDuration(500);
      orientationTransitionTimerRef.current = setTimeout(() => {
        setCameraTransitionDuration(0);
        orientationTransitionTimerRef.current = null;
      }, 520);
      return;
    }

    cameraRef.current?.setStop({
      pitch: nextMode === 'topDown' ? 0 : perspectiveMapPitch,
      duration: 500,
      easing: 'ease',
    });
  };

  const handleRecenter = () => {
    if (!displayCoords) {
      return;
    }

    if (orientationTransitionTimerRef.current) {
      clearTimeout(orientationTransitionTimerRef.current);
    }

    setCameraTransitionDuration(450);
    setIsCameraFollowing(true);
    orientationTransitionTimerRef.current = setTimeout(() => {
      setCameraTransitionDuration(0);
      orientationTransitionTimerRef.current = null;
    }, 470);
  };

  const handleBack = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }

    navigation.replace('Home');
  };

  const handleRouteTitlePress = () => {
    if (isSimulating || !routePath.segments.length) return;

    const now = Date.now();
    const previous = simulationTitleTapRef.current;
    const count = now - previous.lastTapAt <= SIMULATION_TRIPLE_TAP_WINDOW_MS
      ? previous.count + 1
      : 1;

    if (count >= 3) {
      simulationTitleTapRef.current = { count: 0, lastTapAt: 0 };
      setIsSimulating(true);
      return;
    }

    simulationTitleTapRef.current = { count, lastTapAt: now };
  };

  return (
    <View style={styles.container}>
      <StatusBar style={usesLightChrome ? 'dark' : 'light'} />
      <Map
        ref={mapRef}
        style={styles.map}
        mapStyle={activeMapTheme.style}
        onTouchStart={releaseCameraFollow}
        onPress={handleMapPress}
        onRegionWillChange={handleRegionWillChange}
        onRegionIsChanging={handleRegionChange}
        onRegionDidChange={handleRegionChange}
        onDidFinishLoadingStyle={handleMapStyleLoaded}
        onDidFinishRenderingMapFully={handleMapRenderedFully}
        attributionPosition={{ bottom: mapOrnamentBottom, left: mapSafeLeft }}
        logoPosition={{ bottom: mapOrnamentBottom, left: mapSafeLeft }}
      >
        {initialCameraCenter ? (
          <Camera
            ref={cameraRef}
            maxZoom={22}
            initialViewState={{
              center: initialCameraCenter,
              zoom: 14,
              pitch: mapPitch,
            }}
            center={isCameraFollowing ? displayCoords ?? undefined : undefined}
            bearing={isCameraFollowing ? displayRouteBearing : undefined}
            duration={isCameraFollowing ? cameraTransitionDuration : undefined}
            easing={isCameraFollowing
              ? cameraTransitionDuration > 0 ? 'ease' : 'linear'
              : undefined}
            pitch={isCameraFollowing ? mapPitch : undefined}
            zoom={isCameraFollowing ? mapZoom : undefined}
          />
        ) : null}

        {preferences.buildings3dEnabled ? (
          <Layer
            id="routeBuildings3d"
            type="fill-extrusion"
            source="carto"
            source-layer="building"
            minzoom={15}
            paint={buildingExtrusionPaint as any}
          />
        ) : null}

        {/* The marker uses a route bearing whenever the vehicle is snapped, so
            it remains screen-centred in either device orientation. */}
        {(locationGranted || isSimulating) && displayCoords && (
          <Marker
            id="userBusMarker"
            lngLat={displayCoords}
            anchor="center"
          >
            <View style={{
              transform: [{
                rotate: `${vehicleMarkerRotation}deg`,
              }],
            }}>
              {preferences.vehicleMarker === 'arrow' ? (
                <View style={styles.vehicleArrow}>
                  <MaterialCommunityIcons name="navigation" size={22} color={vehicleAccent} />
                </View>
              ) : (
                <View style={styles.busContainer}>
                  <View style={styles.busBody}>
                    <View style={[styles.busRedFront, { backgroundColor: vehicleAccent }]} />
                    <View style={[styles.busRedBack, { backgroundColor: vehicleAccent }]} />
                    <View style={[styles.busStripeLeft, { backgroundColor: vehicleAccent }]} />
                    <View style={[styles.busStripeRight, { backgroundColor: vehicleAccent }]} />
                    <View style={styles.busWindshield} />
                    <View style={styles.busRearWindow} />
                    <View style={styles.busACUnit} />
                  </View>
                </View>
              )}
            </View>
          </Marker>
        )}

        {/* Route polyline */}
        {routeSource && (
          <GeoJSONSource id="routeSource" data={routeSource as any}>
            <Layer
              id="routeLineGlow"
              type="line"
              layout={{
                'line-join': 'round',
                'line-cap': 'round',
              }}
              paint={{
                'line-color': routeLineColors.activeGlow,
                'line-width': 10,
                'line-opacity': 0.62,
              }}
            />
            <Layer
              id="routeLine"
              type="line"
              layout={{
                'line-join': 'round',
                'line-cap': 'round',
              }}
              paint={{
                'line-color': routeLineColors.active,
                'line-width': 4.5,
              }}
            />
          </GeoJSONSource>
        )}

        {completedRouteSource && (
          <GeoJSONSource id="completedRouteSource" data={completedRouteSource as any}>
            <Layer
              id="completedRouteLineGlow"
              type="line"
              layout={{
                'line-join': 'round',
                'line-cap': 'round',
              }}
              paint={{
                'line-color': routeLineColors.completedGlow,
                'line-width': 10,
                'line-opacity': 0.34,
              }}
            />
            <Layer
              id="completedRouteLine"
              type="line"
              layout={{
                'line-join': 'round',
                'line-cap': 'round',
              }}
              paint={{
                'line-color': routeLineColors.completed,
                'line-width': 4,
              }}
            />
          </GeoJSONSource>
        )}

        {/* Stop markers */}
        {stopsFeature && (
          <GeoJSONSource id="stopsSource" data={stopsFeature}>
            <Layer
              id="stopsCircle"
              type="circle"
              paint={{
                'circle-radius': 5,
                'circle-color': '#FFFFFF',
                'circle-stroke-width': 2,
                'circle-stroke-color': routeColor,
              }}
            />
          </GeoJSONSource>
        )}

        {selectedStop?.coordinates ? (
          <Marker
            id="selectedStopCallout"
            lngLat={selectedStop.coordinates}
            anchor="bottom"
            onPress={() => setSelectedStop(null)}
          >
            <View
              style={[
                styles.stopCallout,
                usesLightChrome && styles.stopCalloutLight,
                {
                  width: Math.min(
                    isLandscape ? 300 : 260,
                    viewportWidth - mapSafeLeft - mapSafeRight - 24,
                  ),
                },
              ]}
            >
              <View style={[styles.stopCalloutBadge, { backgroundColor: routeColor }]}>
                <Text style={[styles.stopCalloutBadgeText, { color: routeTextColor }]}>
                  {routeShortName}
                </Text>
              </View>
              <Text style={[styles.stopCalloutName, { color: chromeTextColor }]} numberOfLines={1}>
                {selectedStop.stop_name || t('map.unknownStop')}
              </Text>
              <View style={styles.stopCalloutEta}>
                <MaterialCommunityIcons name="timer-outline" size={13} color="#FFFFFF" />
                <Text style={styles.stopCalloutEtaText}>{formatEta(selectedStopEtaMinutes, language)}</Text>
              </View>
              <TouchableOpacity
                style={[styles.stopCalloutClose, usesLightChrome && styles.stopCalloutCloseLight]}
                onPress={() => setSelectedStop(null)}
                accessibilityRole="button"
                accessibilityLabel={t('map.closeStop')}
              >
                <MaterialCommunityIcons name="close" size={15} color={chromeTextColor} />
              </TouchableOpacity>
            </View>
          </Marker>
        ) : null}
      </Map>

      <Animated.View
        style={[
          styles.mapThemeTransitionVeil,
          {
            backgroundColor: mapThemeTransitionColor,
            opacity: mapThemeTransitionOpacity,
          },
        ]}
        pointerEvents="none"
      />

      {/* Route controls stay compact so the map remains the primary surface. */}
      <View style={[
        styles.hudTop,
        {
          top: mapSafeTop,
          left: mapSafeLeft,
          right: mapSafeRight + 54,
        },
      ]}>
        <TouchableOpacity
          style={[styles.backButton, usesLightChrome && styles.mapChromeLight]}
          onPress={handleBack}
          accessibilityRole="button"
          accessibilityLabel={t('map.back')}
        >
          <MaterialCommunityIcons name="chevron-left" size={24} color={chromeTextColor} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.routeHud, usesLightChrome && styles.mapChromeLight]}
          onPress={handleRouteTitlePress}
          activeOpacity={1}
          accessibilityRole="button"
          accessibilityLabel={`${routeShortName}. ${directionName || t('map.activeRoute')}`}
          accessibilityHint={t('map.simulateTripleTapHint')}
        >
          <View style={styles.hudTitleRow}>
            <View style={[
              styles.hudBadge,
              { backgroundColor: routeColor }
            ]}>
              <Text style={[styles.hudBadgeText, { color: routeTextColor }]}>
                {routeShortName}
              </Text>
            </View>
            <Text style={[styles.hudDirection, { color: chromeTextColor }]} numberOfLines={1}>
              {directionName || t('map.activeRoute')}
            </Text>
          </View>
        </TouchableOpacity>
        <View style={[styles.wsIndicator, usesLightChrome && styles.mapChromeLight]}>
          <View
            style={[
              styles.wsDot,
              { backgroundColor: isConnected ? '#22C55E' : '#EF4444' },
            ]}
          />
        </View>
      </View>

      <View style={[
        styles.mapThemeDock,
        { top: mapSafeTop, right: mapSafeRight },
      ]}>
        {isMapThemePickerOpen ? (
          <View style={[styles.mapThemeMenu, usesLightChrome && styles.mapChromeLight]}>
            {(Object.keys(MAP_THEME_OPTIONS) as MapTheme[]).map((theme) => {
              const option = MAP_THEME_OPTIONS[theme];
              const isActive = theme === (pendingMapTheme ?? mapTheme);

              return (
                <TouchableOpacity
                  key={theme}
                  style={[
                    styles.mapThemeOption,
                    isActive && styles.mapThemeOptionActive,
                  ]}
                  onPress={() => handleMapThemeChange(theme)}
                  accessibilityRole="button"
                  accessibilityLabel={t('map.themeA11y', { theme: t(option.labelKey) })}
                >
                  <MaterialCommunityIcons
                    name={option.icon}
                    size={18}
                    color={isActive ? '#FFFFFF' : chromeTextColor}
                  />
                </TouchableOpacity>
              );
            })}
          </View>
        ) : null}
        {!isMapThemePickerOpen ? (
          <TouchableOpacity
            style={[styles.mapThemeTrigger, usesLightChrome && styles.mapChromeLight]}
            onPress={() => setIsMapThemePickerOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t('map.changeTheme')}
          >
            <MaterialCommunityIcons name="layers-outline" size={21} color={chromeTextColor} />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[
            styles.mapRecenterTrigger,
            mapViewMode === 'perspective' && styles.mapRecenterTriggerActive,
          ]}
          onPress={handleMapViewMode}
          accessibilityRole="button"
          accessibilityLabel={mapViewMode === 'perspective' ? t('map.viewFlat') : t('map.view3d')}
          accessibilityState={{ selected: mapViewMode === 'perspective' }}
        >
          <MaterialCommunityIcons
            name={mapViewMode === 'perspective' ? 'cube-outline' : 'map-outline'}
            size={22}
            color="#FFFFFF"
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.mapRecenterTrigger,
            isCameraFollowing && styles.mapRecenterTriggerActive,
            (!displayCoords || cameraTransitionDuration > 0) && styles.mapControlDisabled,
          ]}
          onPress={handleRecenter}
          disabled={!displayCoords || cameraTransitionDuration > 0}
          accessibilityRole="button"
          accessibilityLabel={t('map.recenter')}
          accessibilityState={{
            disabled: !displayCoords || cameraTransitionDuration > 0,
            selected: isCameraFollowing,
          }}
        >
          <MaterialCommunityIcons name="crosshairs-gps" size={21} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      {activeServiceAlert && !isServiceAlertTabDismissed ? (
        <View
          style={[
            styles.serviceAlertTab,
            activeServiceAlert.severity === 'SEVERE' && styles.serviceAlertTabSevere,
            activeServiceAlert.severity === 'WARNING' && styles.serviceAlertTabWarning,
            {
              top: mapSafeTop + 58,
              left: mapSafeLeft,
            },
          ]}
        >
          <TouchableOpacity
            style={styles.serviceAlertTabOpen}
            onPress={() => setIsServiceAlertModalVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={t('map.serviceAlertTab')}
          >
            <MaterialCommunityIcons name={serviceAlertIcon} size={22} color="#FFFFFF" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.serviceAlertTabClose}
            onPress={() => {
              setIsServiceAlertModalVisible(false);
              setIsServiceAlertTabDismissed(true);
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('map.closeServiceAlert')}
          >
            <MaterialCommunityIcons name="close" size={16} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      ) : null}

      <Modal
        visible={isServiceAlertModalVisible && serviceAlerts.length > 0}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setIsServiceAlertModalVisible(false)}
      >
        <View style={styles.serviceAlertModalBackdrop}>
          <View style={[styles.serviceAlertModalCard, { maxHeight: Math.round(viewportHeight * 0.74) }]}>
            <View style={styles.serviceAlertModalHeader}>
              <View style={styles.serviceAlertModalHeaderIcon}>
                <MaterialCommunityIcons name={serviceAlertIcon} size={21} color={colors.primary} />
              </View>
              <Text style={styles.serviceAlertModalTitle}>{t('map.serviceAlert')}</Text>
              <TouchableOpacity
                style={styles.serviceAlertModalClose}
                onPress={() => setIsServiceAlertModalVisible(false)}
                accessibilityRole="button"
                accessibilityLabel={t('map.closeServiceAlertPopup')}
              >
                <MaterialCommunityIcons name="close" size={21} color={colors.ink} />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.serviceAlertModalScroll}
              contentContainerStyle={styles.serviceAlertModalScrollContent}
              showsVerticalScrollIndicator
            >
              {serviceAlerts.map((alert, index) => {
                const title = alert.header_text.trim() || t('map.serviceAlert');
                const description = alert.description_text.trim();
                const severityStyle = alert.severity === 'SEVERE'
                  ? styles.serviceAlertDetailSevere
                  : alert.severity === 'WARNING'
                    ? styles.serviceAlertDetailWarning
                    : styles.serviceAlertDetailInfo;
                return (
                  <View
                    key={alert.alert_id}
                    style={[
                      styles.serviceAlertDetail,
                      severityStyle,
                      index > 0 && styles.serviceAlertDetailWithGap,
                    ]}
                  >
                    <Text style={styles.serviceAlertDetailTitle}>{title}</Text>
                    {description ? (
                      <Text style={styles.serviceAlertDetailDescription}>{description}</Text>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
            <TouchableOpacity
              style={styles.serviceAlertModalButton}
              onPress={() => setIsServiceAlertModalVisible(false)}
              accessibilityRole="button"
              accessibilityLabel={t('map.closeServiceAlertPopup')}
            >
              <Text style={styles.serviceAlertModalButtonText}>{t('map.closeServiceAlertPopup')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <View style={[
        styles.driverPanel,
        usesLightChrome && styles.mapChromeLight,
        !isLandscape && styles.driverPanelPortrait,
        isLandscape && styles.driverPanelLandscape,
        {
          left: mapSafeLeft,
          right: mapSafeRight,
          bottom: Math.max(insets.bottom + (isLandscape ? 14 : 18), isLandscape ? 14 : 18),
          height: isLandscape ? landscapeDriverPanelHeight : portraitDriverPanelHeight,
        },
      ]}>
        <View style={[
          styles.driverContent,
          !isLandscape && styles.driverContentPortrait,
          isLandscape && styles.driverContentLandscape,
        ]}>
          <View style={[styles.driverPrimaryRow, isLandscape && styles.driverPrimaryRowLandscape]}>
            <View style={styles.driverStopIcon}>
              <MaterialCommunityIcons name="bus-stop" size={18} color="#FFFFFF" />
            </View>
            <View style={styles.driverStopInfo}>
              {isLandscape ? (
                <Text style={[styles.driverStopLabel, { color: chromeMutedTextColor }]}>
                  {t('map.nextStop')}
                </Text>
              ) : null}
              <Text style={[styles.driverStopName, { color: chromeTextColor }]} numberOfLines={1}>
                {nextStop?.stop_name || t('map.calculatingStop')}
              </Text>
            </View>
            {isLandscape && followingStop ? (
              <View style={styles.driverFollowingStop}>
                <Text style={[styles.driverStopLabel, { color: chromeMutedTextColor }]}>
                  {t('map.followingStop')}
                </Text>
                <Text style={[styles.driverFollowingStopName, { color: chromeTextColor }]} numberOfLines={1}>
                  {followingStop.stop_name || t('map.unknownStop')}
                </Text>
              </View>
            ) : null}
            <View style={[
              styles.driverEtaPill,
              trafficStatusLabel && styles.driverEtaPillWithTraffic,
              { backgroundColor: trafficEtaPillColor },
            ]}>
              {trafficStatusLabel ? (
                <Text style={styles.driverTrafficStatusText} numberOfLines={1}>
                  {trafficStatusLabel}
                </Text>
              ) : null}
              <View style={styles.driverEtaTimeRow}>
                <MaterialCommunityIcons name="timer-outline" size={13} color="#FFFFFF" />
                <Text style={styles.driverEtaText}>{formatEta(nextStopEtaMinutes, language)}</Text>
              </View>
            </View>
          </View>

          {!isLandscape && (directionName || nextStop) ? (
            <View style={[styles.driverJourneySummary, isLandscape && styles.driverJourneySummaryLandscape]}>
              {directionName ? (
                <View style={styles.driverJourneyCaption}>
                  <MaterialCommunityIcons name="map-marker-path" size={13} color={colors.primary} />
                  <Text style={[styles.driverJourneyText, { color: chromeMutedTextColor }]} numberOfLines={1}>
                    {directionName}
                  </Text>
                </View>
              ) : null}
              <View style={styles.driverJourneyRail}>
                <View style={styles.driverJourneyTrack} />
                <View style={[styles.driverJourneyProgress, { width: `${Math.max(2, routeProgressPercent)}%` }]} />
                <View style={styles.driverJourneyStart} />
                {journeyStops.map((stop) => (
                  <View
                    key={stop.key}
                    style={[
                      styles.driverJourneyStop,
                      stop.isPassed && styles.driverJourneyStopPassed,
                      stop.isNext && styles.driverJourneyStopNext,
                      stop.isFollowing && styles.driverJourneyStopFollowing,
                      { left: `${stop.progress}%` },
                    ]}
                  />
                ))}
                <View style={[styles.driverJourneyVehicle, { left: `${Math.min(96, Math.max(2, routeProgressPercent))}%` }]} />
                <View style={styles.driverJourneyEnd} />
              </View>
              {nextStop ? (
                <View style={styles.driverUpcomingStops}>
                  <View style={styles.driverUpcomingStop}>
                    <Text style={[styles.driverUpcomingLabel, { color: chromeMutedTextColor }]}>
                      {t('map.nextStop')}
                    </Text>
                    <Text style={[styles.driverUpcomingName, { color: chromeTextColor }]} numberOfLines={1}>
                      {nextStop.stop_name || t('map.unknownStop')}
                    </Text>
                  </View>
                  {followingStop ? (
                    <View style={styles.driverUpcomingStop}>
                      <Text style={[styles.driverUpcomingLabel, { color: chromeMutedTextColor }]}>
                        {t('map.followingStop')}
                      </Text>
                      <Text style={[styles.driverUpcomingName, { color: chromeTextColor }]} numberOfLines={1}>
                        {followingStop.stop_name || t('map.unknownStop')}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}

          <View style={[
            styles.driverStatusRow,
            !isLandscape && styles.driverStatusRowPortrait,
            isLandscape && styles.driverStatusRowLandscape,
          ]}>
            {visibleDriverMetrics.map((metric, index) => (
              <View
                key={`${metric.icon}-${metric.label}`}
                style={[
                  styles.driverMetric,
                  index > 0 && styles.driverMetricWithDivider,
                  isLandscape && styles.driverMetricLandscape,
                ]}
              >
                <MaterialCommunityIcons name={metric.icon} size={14} color={colors.primary} />
                <Text style={[styles.driverMetricText, { color: chromeTextColor }]} numberOfLines={1}>
                  {metric.label}
                </Text>
              </View>
            ))}
          </View>
          {fleetMetrics.length > 0 ? (
            <View style={[
              styles.driverFleetRow,
              isLandscape && styles.driverFleetRowLandscape,
            ]}>
              {fleetMetrics.map((metric) => (
                <View key={`${metric.icon}-${metric.title}`} style={styles.driverFleetMetric}>
                  <View style={styles.driverFleetIcon}>
                    <MaterialCommunityIcons name={metric.icon} size={14} color={colors.primary} />
                  </View>
                  <View style={styles.driverFleetCopy}>
                    <Text style={[styles.driverFleetTitle, { color: chromeTextColor }]} numberOfLines={1}>
                      {metric.title}
                    </Text>
                    <Text style={[styles.driverFleetLocation, { color: chromeMutedTextColor }]} numberOfLines={1}>
                      {metric.location}
                    </Text>
                  </View>
                  {metric.delay ? (
                    <Text style={styles.driverFleetDelay} numberOfLines={1}>{metric.delay}</Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.mapBackground,
  },
  map: {
    flex: 1,
  },
  mapThemeTransitionVeil: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mapBackground,
  },
  loadingText: {
    color: '#6B7FA3',
    marginTop: 12,
    fontSize: 14,
  },
  error: {
    color: '#EF4444',
    fontSize: 16,
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#1C2E4A',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  retryText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },

  // ── Top HUD ──
  hudTop: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  backButton: {
    width: 42,
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(10, 22, 40, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  mapChromeLight: {
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderColor: 'rgba(31, 41, 55, 0.12)',
  },
  routeHud: {
    flex: 1,
    alignItems: 'stretch',
    justifyContent: 'center',
    height: 48,
    backgroundColor: 'rgba(10, 22, 40, 0.85)',
    borderRadius: 12,
    paddingVertical: 7,
    paddingHorizontal: 10,
    marginHorizontal: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  hudTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
  },
  hudBadge: {
    backgroundColor: '#DC2626',
    borderRadius: 6,
    minWidth: 44,
    height: 26,
    paddingHorizontal: 10,
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hudBadgeText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  hudDirection: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    flex: 1,
    minWidth: 0,
  },
  wsIndicator: {
    width: 42,
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(10, 22, 40, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  wsDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  serviceAlertTab: {
    position: 'absolute',
    height: 44,
    width: 88,
    borderTopLeftRadius: 14,
    borderBottomLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(30, 96, 87, 0.96)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    shadowColor: '#020617',
    shadowOpacity: 0.32,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 10,
  },
  serviceAlertTabOpen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  serviceAlertTabWarning: {
    backgroundColor: 'rgba(154, 91, 18, 0.97)',
  },
  serviceAlertTabSevere: {
    backgroundColor: 'rgba(172, 45, 45, 0.97)',
  },
  serviceAlertTabClose: {
    width: 36,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(255,255,255,0.22)',
  },
  serviceAlertModalBackdrop: {
    flex: 1,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(2, 10, 23, 0.64)',
  },
  serviceAlertModalCard: {
    width: '100%',
    maxWidth: 460,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: '#FAFBF8',
    shadowColor: '#020617',
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 18,
  },
  serviceAlertModalHeader: {
    minHeight: 66,
    paddingHorizontal: 18,
    paddingVertical: 12,
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#DCE5DF',
  },
  serviceAlertModalHeaderIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  serviceAlertModalTitle: {
    flex: 1,
    minWidth: 0,
    color: colors.ink,
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '900',
  },
  serviceAlertModalClose: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EEF2EF',
  },
  serviceAlertModalScroll: { flexGrow: 0 },
  serviceAlertModalScrollContent: { paddingHorizontal: 18, paddingVertical: 6 },
  serviceAlertDetail: {
    padding: 15,
    borderRadius: 14,
  },
  serviceAlertDetailWithGap: {
    marginTop: 9,
  },
  serviceAlertDetailSevere: {
    backgroundColor: '#FCE8E8',
  },
  serviceAlertDetailWarning: {
    backgroundColor: '#FFF0D6',
  },
  serviceAlertDetailInfo: {
    backgroundColor: '#E5F4EF',
  },
  serviceAlertDetailTitle: {
    color: colors.ink,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '900',
  },
  serviceAlertDetailDescription: {
    color: colors.inkSoft,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '500',
    marginTop: 8,
  },
  serviceAlertModalButton: {
    height: 48,
    marginHorizontal: 18,
    marginBottom: 18,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  serviceAlertModalButtonText: {
    color: colors.white,
    fontSize: 15,
    lineHeight: 18,
    fontWeight: '900',
  },
  mapThemeDock: {
    position: 'absolute',
    alignItems: 'flex-end',
    gap: 8,
  },
  mapThemeMenu: {
    width: 46,
    padding: 4,
    gap: 4,
    backgroundColor: 'rgba(10, 22, 40, 0.85)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  mapThemeOption: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapThemeOptionActive: {
    backgroundColor: colors.primary,
  },
  mapThemeTrigger: {
    width: 46,
    height: 46,
    borderRadius: 12,
    backgroundColor: 'rgba(10, 22, 40, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  mapRecenterTrigger: {
    width: 46,
    height: 46,
    borderRadius: 12,
    backgroundColor: 'rgba(10, 22, 40, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  mapRecenterTriggerActive: {
    backgroundColor: colors.primary,
  },
  mapControlDisabled: {
    opacity: 0.45,
  },
  driverPanel: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: 'rgba(8, 21, 39, 0.93)',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
    shadowColor: '#020617',
    shadowOpacity: 0.36,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  driverPanelLandscape: {
    left: 18,
    right: 18,
    borderRadius: 16,
    paddingVertical: 8,
  },
  driverPanelPortrait: {
    paddingVertical: spacing.md,
  },
  driverContent: {
    minWidth: 0,
  },
  driverContentPortrait: {
    flex: 1,
    justifyContent: 'space-between',
  },
  driverContentLandscape: {
    flex: 1,
    justifyContent: 'space-between',
  },
  driverPrimaryRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  driverPrimaryRowLandscape: {
    flex: 0,
    minWidth: 0,
  },
  driverJourneySummary: {
    height: 66,
    justifyContent: 'space-between',
  },
  driverJourneySummaryLandscape: {
    height: 26,
  },
  driverJourneyCaption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
  },
  driverJourneyText: {
    flex: 1,
    minWidth: 0,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
  },
  driverJourneyRail: {
    height: 10,
    justifyContent: 'center',
    position: 'relative',
  },
  driverJourneyTrack: {
    height: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  driverJourneyProgress: {
    position: 'absolute',
    left: 0,
    height: 3,
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  driverJourneyStop: {
    position: 'absolute',
    width: 4,
    height: 4,
    marginLeft: -2,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  driverJourneyStopPassed: {
    backgroundColor: colors.primary,
  },
  driverJourneyStopNext: {
    width: 8,
    height: 8,
    marginLeft: -4,
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: '#FFFFFF',
  },
  driverJourneyStopFollowing: {
    width: 6,
    height: 6,
    marginLeft: -3,
    backgroundColor: '#A7F3D0',
  },
  driverJourneyStart: {
    position: 'absolute',
    left: 0,
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  driverJourneyVehicle: {
    position: 'absolute',
    width: 9,
    height: 9,
    marginLeft: -4,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    backgroundColor: colors.primary,
  },
  driverJourneyEnd: {
    position: 'absolute',
    right: 0,
    width: 8,
    height: 8,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: 'rgba(8, 21, 39, 0.93)',
  },
  driverUpcomingStops: {
    flexDirection: 'row',
    gap: 10,
    minWidth: 0,
  },
  driverUpcomingStop: {
    flex: 1,
    minWidth: 0,
  },
  driverUpcomingLabel: {
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '800',
  },
  driverUpcomingName: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '900',
    marginTop: 1,
  },
  driverStopIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  driverStopInfo: {
    flex: 1,
    minWidth: 0,
  },
  driverStopLabel: {
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '800',
  },
  driverStopName: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '900',
  },
  driverFollowingStop: {
    maxWidth: 172,
    minWidth: 92,
    paddingLeft: 10,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(255,255,255,0.14)',
  },
  driverFollowingStopName: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '900',
    marginTop: 1,
  },
  driverEtaPill: {
    height: 34,
    minWidth: 82,
    borderRadius: 11,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: colors.primary,
  },
  driverEtaPillWithTraffic: {
    height: 42,
    minWidth: 108,
    paddingHorizontal: 9,
    flexDirection: 'column',
    gap: 0,
  },
  driverEtaTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  driverTrafficStatusText: {
    maxWidth: 112,
    color: '#FFFFFF',
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '900',
  },
  driverEtaText: {
    color: '#FFFFFF',
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '900',
  },
  driverStatusRow: {
    height: 38,
    flexDirection: 'row',
    flexWrap: 'nowrap',
    minWidth: 0,
    overflow: 'hidden',
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  driverStatusRowLandscape: {
    flex: 0,
    width: '100%',
    flexWrap: 'nowrap',
    alignItems: 'center',
  },
  driverStatusRowPortrait: {
    flex: 0,
  },
  driverMetric: {
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    flex: 1,
    flexBasis: 0,
    minWidth: 0,
  },
  driverMetricLandscape: {
    flex: 1,
    flexBasis: 0,
    minWidth: 0,
    paddingHorizontal: 7,
  },
  driverMetricWithDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(255,255,255,0.12)',
  },
  driverMetricText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
  },
  driverFleetRow: {
    flexDirection: 'row',
    gap: 7,
    width: '100%',
  },
  driverFleetRowLandscape: { marginTop: 0 },
  driverFleetMetric: {
    flex: 1,
    minWidth: 0,
    height: 42,
    paddingHorizontal: 8,
    borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  driverFleetIcon: {
    width: 24,
    height: 24,
    borderRadius: 8,
    backgroundColor: 'rgba(27, 159, 140, 0.17)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  driverFleetCopy: { flex: 1, minWidth: 0 },
  driverFleetTitle: { fontSize: 10, lineHeight: 12, fontWeight: '900' },
  driverFleetLocation: { fontSize: 10, lineHeight: 13, fontWeight: '700', marginTop: 1 },
  driverFleetDelay: { color: '#FCD34D', fontSize: 10, lineHeight: 12, fontWeight: '900' },
  // ── Programmatic Bus Marker Styles ──
  busContainer: {
    width: 16,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 6,
  },
  busBody: {
    width: 16,
    height: 44,
    backgroundColor: '#FFFFFF', // White base
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#111F38',
    overflow: 'hidden',
    position: 'relative',
  },
  busRedFront: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 8,
    backgroundColor: '#DC2626', // TMB Red Front
  },
  busRedBack: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 8,
    backgroundColor: '#DC2626', // TMB Red Back
  },
  busStripeLeft: {
    position: 'absolute',
    top: 8,
    bottom: 8,
    left: 0,
    width: 2.5,
    backgroundColor: '#DC2626',
  },
  busStripeRight: {
    position: 'absolute',
    top: 8,
    bottom: 8,
    right: 0,
    width: 2.5,
    backgroundColor: '#DC2626',
  },
  busWindshield: {
    position: 'absolute',
    top: 3,
    left: 2,
    right: 2,
    height: 3,
    backgroundColor: '#1E293B', // Dark windshield glass
    borderRadius: 1,
  },
  busRearWindow: {
    position: 'absolute',
    bottom: 2,
    left: 2,
    right: 2,
    height: 2,
    backgroundColor: '#1E293B',
  },
  busACUnit: {
    position: 'absolute',
    top: 15,
    left: 3,
    right: 3,
    height: 8,
    backgroundColor: '#E2E8F0',
    borderRadius: 2,
    borderWidth: 0.5,
    borderColor: '#94A3B8',
  },
  vehicleArrow: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.97)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 6,
  },

  stopCallout: {
    minHeight: 40,
    backgroundColor: 'rgba(10, 22, 40, 0.94)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 7,
    marginBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.24,
    shadowRadius: 6,
    elevation: 7,
  },
  stopCalloutLight: {
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderColor: 'rgba(31, 41, 55, 0.12)',
  },
  stopCalloutBadge: {
    minWidth: 38,
    height: 24,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopCalloutBadgeText: {
    fontSize: 11,
    fontWeight: '900',
  },
  stopCalloutName: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
  },
  stopCalloutEta: {
    minWidth: 62,
    height: 24,
    borderRadius: 6,
    paddingHorizontal: 7,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  stopCalloutEtaText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '900',
  },
  stopCalloutClose: {
    width: 24,
    height: 24,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  stopCalloutCloseLight: {
    backgroundColor: '#F3F4F6',
  },
});
