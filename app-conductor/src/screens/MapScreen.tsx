import React, { useEffect, useState, useRef } from 'react';
import {
  Animated,
  Easing,
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
import * as ScreenOrientation from 'expo-screen-orientation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  apiService,
  type LiveWebSocketMessage,
  type RTTripUpdate,
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
import { colors, safeHexColor, vehicleAccentColor } from '../theme';
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
type PaceInfo = {
  label: string;
  icon: IconName;
  tone: 'good' | 'warning' | 'danger' | 'neutral';
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
type MapOrientation = 'course' | 'northUp';
type MapThemeOption = {
  labelKey: TranslationKey;
  icon: IconName;
  style: any;
};

const MS_TO_KMH = 3.6;
const MIN_MOVING_SPEED_KMH = 3;
const FALLBACK_CITY_SPEED_KMH = 18;
const LIVE_REFRESH_MIN_INTERVAL_MS = 60_000;
const LIVE_REFRESH_JITTER_MS = 5_000;
const LIVE_RECONNECT_MAX_MS = 30_000;
const LIVE_SUBSCRIPTION_TIMEOUT_MS = 10_000;
const LIVE_DATA_STALE_AFTER_MS = 180_000;
const DEVICE_HEADING_STALE_AFTER_MS = 3_500;
const DEVICE_HEADING_DEADBAND_DEGREES = 0.8;
const DEVICE_HEADING_MIN_UPDATE_INTERVAL_MS = 80;

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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

function headingOffsetForScreenOrientation(
  orientation: ScreenOrientation.Orientation,
): number | null {
  switch (orientation) {
    case ScreenOrientation.Orientation.PORTRAIT_UP:
      return 0;
    case ScreenOrientation.Orientation.PORTRAIT_DOWN:
      return 180;
    case ScreenOrientation.Orientation.LANDSCAPE_LEFT:
      return 90;
    case ScreenOrientation.Orientation.LANDSCAPE_RIGHT:
      return -90;
    default:
      return null;
  }
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

function formatFleetGap(minutes: number | null, language: AppLanguage) {
  if (minutes === null) {
    return translate(language, 'map.noData');
  }

  if (minutes <= 1) {
    return '<1 min';
  }

  return `${Math.round(minutes)} min`;
}

function formatDelay(seconds: number | null, language: AppLanguage) {
  if (seconds === null) {
    return null;
  }

  const minutes = Math.round(seconds / 60);
  if (minutes > 0) {
    return `+${minutes} min`;
  }

  if (minutes < 0) {
    return `${minutes} min`;
  }

  return translate(language, 'map.onTime');
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

function delayForStop(routeTripUpdates: RTTripUpdate[], activeTripId: string | undefined, stop: SelectedStop | RouteStopInfo | null) {
  if (!activeTripId || !stop) {
    return null;
  }

  const tripUpdate = routeTripUpdates.find((update) => update.trip_id === activeTripId);
  if (!tripUpdate) {
    return null;
  }

  const stopId = stop.stop_id ? String(stop.stop_id) : '';
  const stopSequence = Number(stop.stop_sequence ?? (stop as RouteStopInfo).sequence);
  const stopUpdate = tripUpdate.stop_time_updates.find((update) => {
    const sameStopId = stopId && update.stop_id === stopId;
    const sameSequence = Number.isFinite(stopSequence) && update.stop_sequence === stopSequence;
    return sameStopId || sameSequence;
  });

  if (!stopUpdate) {
    return null;
  }

  if (typeof stopUpdate.arrival_delay === 'number') {
    return stopUpdate.arrival_delay;
  }

  if (typeof stopUpdate.departure_delay === 'number') {
    return stopUpdate.departure_delay;
  }

  return null;
}

function getPaceInfo(delaySeconds: number | null, language: AppLanguage): PaceInfo | null {
  if (delaySeconds === null) {
    return null;
  }

  if (delaySeconds >= 300) {
    return { label: translate(language, 'map.paceLate'), icon: 'speedometer-medium', tone: 'danger' };
  }

  if (delaySeconds >= 90) {
    return { label: translate(language, 'map.paceSlightlyLate'), icon: 'speedometer-medium', tone: 'warning' };
  }

  if (delaySeconds <= -180) {
    return { label: translate(language, 'map.paceEarly'), icon: 'speedometer-slow', tone: 'warning' };
  }

  return { label: translate(language, 'map.paceGood'), icon: 'check-circle-outline', tone: 'good' };
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
  const isCompactLandscape = isLandscape && viewportHeight < 520;
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
  const [mapOrientation, setMapOrientation] = useState<MapOrientation>('course');
  const [gpsFix, setGpsFix] = useState<GpsFix | null>(null);
  const [deviceHeading, setDeviceHeading] = useState<DeviceHeading | null>(null);
  const [visualPose, setVisualPose] = useState<VisualPose | null>(null);
  const [displayRouteProgress, setDisplayRouteProgress] = useState<number | null>(null);
  const [mapBearing, setMapBearing] = useState<number>(0);
  const [routeInfo, setRouteInfo] = useState<any>(null);
  const [routeTripUpdates, setRouteTripUpdates] = useState<RTTripUpdate[]>([]);
  const [vehiclePositions, setVehiclePositions] = useState<VehiclePosition[]>([]);
  const [trafficState, setTrafficState] = useState<TrafficSummary['status'] | 'loading'>('loading');
  const [mapTheme, setMapTheme] = useState<MapTheme>('dark');
  const [isMapThemePickerOpen, setIsMapThemePickerOpen] = useState(false);
  const [pendingMapTheme, setPendingMapTheme] = useState<MapTheme | null>(null);
  const [mapThemeTransitionColor, setMapThemeTransitionColor] = useState(
    MAP_THEME_TRANSITION_COLORS.dark,
  );
  const [isCameraFollowing, setIsCameraFollowing] = useState(true);
  const [cameraTransitionDuration, setCameraTransitionDuration] = useState(0);
  const animationFrameRef = useRef<number | null>(null);
  const smoothedDeviceHeadingRef = useRef<number | null>(null);
  const screenHeadingOffsetRef = useRef(0);
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
  const liveActivityPropsRef = useRef<RouteLiveActivityProps | null>(null);
  const liveActivityStartedRef = useRef(false);
  const lastSnappedProgressRef = useRef<number | null>(null);
  const routeMatchingStateRef = useRef<RouteMatchingState>(
    createRouteMatchingState('offRoute'),
  );
  const lastTrafficLookupRef = useRef<{ coords: Coordinate | null; timestamp: number }>({
    coords: null,
    timestamp: 0,
  });
  const userCoords = gpsFix?.coordinate ?? null;
  const userSpeedKmh = gpsFix?.speedKmh ?? null;
  const displayCoords = visualPose?.coordinate ?? null;
  const displayRouteBearing = visualPose?.bearing ?? 0;
  const gpsBearing = gpsFix
    && isValidHeading(gpsFix.headingDegrees)
    && (gpsFix.speedKmh ?? 0) >= MIN_MOVING_SPEED_KMH
    ? normalizeHeading(gpsFix.headingDegrees)
    : null;
  const vehicleWorldBearing = deviceHeading?.degrees
    ?? gpsBearing
    ?? displayRouteBearing;
  const effectiveMapBearing = isCameraFollowing && cameraTransitionDuration === 0
    ? mapOrientation === 'course' ? displayRouteBearing : 0
    : mapBearing;
  const vehicleMarkerRotation = vehicleWorldBearing - effectiveMapBearing;

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
  const routeTextColor = safeHexColor(routeInfo?.route_text_color, colors.white);
  const vehicleAccent = vehicleAccentColor(preferences.vehicleColor, routeInfo?.route_color);
  const activeMapTheme = MAP_THEME_OPTIONS[mapTheme];
  const usesLightChrome = mapTheme === 'light';
  const chromeTextColor = usesLightChrome ? '#1F2937' : '#FFFFFF';
  const chromeMutedTextColor = usesLightChrome ? '#6B7280' : '#9FB0C8';
  const mapPitch = mapTheme === 'satellite'
    ? (isLandscape ? 36 : 40)
    : (isLandscape ? 52 : 58);
  const mapZoom = isLandscape ? 16.5 : 17;
  const mapSafeTop = Math.max(insets.top + 8, 12);
  const mapSafeLeft = Math.max(insets.left + 12, 12);
  const mapSafeRight = Math.max(insets.right + 12, 12);
  const driverPanelClearance = isLandscape ? 104 : 118;
  const mapOrnamentBottom = Math.max(
    insets.bottom + driverPanelClearance,
    driverPanelClearance,
  );
  const buildingExtrusionPaint = React.useMemo(() => ({
    'fill-extrusion-color': mapTheme === 'satellite'
      ? '#F8FAFC'
      : usesLightChrome ? '#94A3B8' : '#334155',
    'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
    'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
    'fill-extrusion-opacity': mapTheme === 'satellite' ? 0.18 : usesLightChrome ? 0.78 : 0.68,
    'fill-extrusion-vertical-gradient': mapTheme !== 'satellite',
  }), [mapTheme, usesLightChrome]);
  const routeCoordinates = React.useMemo(() => extractRouteCoordinates(routeFeature), [routeFeature]);
  const routePath = React.useMemo(() => buildRoutePath(routeCoordinates), [routeCoordinates]);
  const routeSource = React.useMemo(() => routeFeature
    ? {
      type: 'FeatureCollection' as const,
      features: [routeFeature],
    }
    : null, [routeFeature]);
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
  const realtimeSpeedKmh = typeof matchedVehicle?.speed === 'number'
    ? matchedVehicle.speed * MS_TO_KMH
    : null;
  const currentSpeedKmh = userSpeedKmh ?? realtimeSpeedKmh;
  const currentSpeedLabel = currentSpeedKmh === null
    ? '--'
    : String(Math.max(0, Math.round(currentSpeedKmh)));
  const effectiveSpeedKmh = currentSpeedKmh !== null && currentSpeedKmh > MIN_MOVING_SPEED_KMH
    ? currentSpeedKmh
    : FALLBACK_CITY_SPEED_KMH;
  const currentRouteProgress = displayRouteProgress;
  const nextStop = React.useMemo(() => {
    if (!stopsOnRoute.length) {
      return null;
    }

    if (currentRouteProgress === null) {
      return stopsOnRoute[0];
    }

    return stopsOnRoute.find((stop) => (
      stop.distanceAlong !== null && stop.distanceAlong > currentRouteProgress + 12
    )) ?? stopsOnRoute[stopsOnRoute.length - 1];
  }, [currentRouteProgress, stopsOnRoute]);
  const nextStopDistanceMeters = nextStop?.distanceAlong !== null && nextStop?.distanceAlong !== undefined && currentRouteProgress !== null
    ? Math.max(0, nextStop.distanceAlong - currentRouteProgress)
    : (nextStop ? distanceMeters(displayCoords, nextStop.coordinates) : null);
  const nextStopEtaMinutes = nextStopDistanceMeters === null
    ? null
    : ((nextStopDistanceMeters / 1000) / effectiveSpeedKmh) * 60;
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

  const nextStopDelaySeconds = delayForStop(routeTripUpdates, tripId, nextStop);
  const paceInfo = getPaceInfo(nextStopDelaySeconds, language);
  const estimatedArrival = formatEstimatedArrival(nextStopEtaMinutes);
  const selectedStopCoords = selectedStop?.coordinates ?? null;
  const selectedStopProjection = projectPointOnRoute(selectedStopCoords, routeCoordinates);
  const selectedStopDistanceMeters = selectedStopProjection && currentRouteProgress !== null
    ? Math.abs(selectedStopProjection.distanceAlong - currentRouteProgress)
    : distanceMeters(displayCoords, selectedStopCoords);
  const selectedStopEtaMinutes = selectedStopDistanceMeters === null
    ? null
    : ((selectedStopDistanceMeters / 1000) / effectiveSpeedKmh) * 60;
  const fleetGaps = React.useMemo(() => {
    if (!routeCoordinates.length || currentRouteProgress === null || !vehiclePositions.length) {
      return { aheadMinutes: null, behindMinutes: null, hasFleetData: false };
    }

    let aheadDistance: number | null = null;
    let behindDistance: number | null = null;

    vehiclePositions.forEach((vehicle) => {
      const isOwnVehicle = Boolean(
        (assignedVehicle && vehicle.vehicle_id === assignedVehicle)
        || (tripId && vehicle.trip_id === tripId)
      );
      const projection = projectPointOnRoute([vehicle.longitude, vehicle.latitude], routeCoordinates);

      if (!projection) {
        return;
      }

      const delta = projection.distanceAlong - currentRouteProgress;
      if (isOwnVehicle || Math.abs(delta) < 25) {
        return;
      }

      if (delta > 0) {
        aheadDistance = aheadDistance === null ? delta : Math.min(aheadDistance, delta);
      } else {
        const absDelta = Math.abs(delta);
        behindDistance = behindDistance === null ? absDelta : Math.min(behindDistance, absDelta);
      }
    });

    return {
      aheadMinutes: aheadDistance === null ? null : ((aheadDistance / 1000) / effectiveSpeedKmh) * 60,
      behindMinutes: behindDistance === null ? null : ((behindDistance / 1000) / effectiveSpeedKmh) * 60,
      hasFleetData: true,
    };
  }, [assignedVehicle, currentRouteProgress, effectiveSpeedKmh, routeCoordinates, tripId, vehiclePositions]);
  const fleetLabel = fleetGaps.aheadMinutes !== null
    ? t('map.ahead', { time: formatFleetGap(fleetGaps.aheadMinutes, language) })
    : fleetGaps.behindMinutes !== null
      ? t('map.behind', { time: formatFleetGap(fleetGaps.behindMinutes, language) })
      : null;
  const trafficKey: TranslationKey = trafficState === 'normal'
    ? 'map.trafficNormal'
    : trafficState === 'dense'
      ? 'map.trafficDense'
      : trafficState === 'slow'
        ? 'map.trafficSlow'
        : trafficState === 'jammed'
          ? 'map.trafficJammed'
          : trafficState === 'closed'
            ? 'map.trafficClosed'
            : trafficState === 'loading'
              ? 'map.trafficLoading'
              : 'map.trafficUnavailable';
  const trafficStatus = t(trafficKey);
  const hasTrafficData = trafficState !== 'loading' && trafficState !== 'unavailable';
  const driverMetrics = [
    { icon: 'speedometer' as IconName, label: `${currentSpeedLabel} km/h` },
    nextStopDistanceMeters !== null
      ? { icon: 'map-marker-distance' as IconName, label: formatDistance(nextStopDistanceMeters, language) }
      : null,
    estimatedArrival
      ? { icon: 'clock-time-four-outline' as IconName, label: t('map.arrival', { time: estimatedArrival }) }
      : null,
    nextStopDelaySeconds !== null
      ? { icon: 'calendar-clock-outline' as IconName, label: formatDelay(nextStopDelaySeconds, language) || t('map.onTime') }
      : null,
    fleetLabel
      ? { icon: 'bus-multiple' as IconName, label: fleetLabel }
      : null,
    hasTrafficData
      ? { icon: 'traffic-light' as IconName, label: trafficStatus }
      : null,
  ].filter((metric): metric is { icon: IconName; label: string } => metric !== null);
  const visibleDriverMetrics = isLandscape
    ? driverMetrics.slice(0, isCompactLandscape ? 3 : 4)
    : driverMetrics.slice(0, paceInfo ? 1 : 2);

  const mapRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);

  useEffect(() => {
    let active = true;

    const applyOrientation = (orientation: ScreenOrientation.Orientation) => {
      const nextOffset = headingOffsetForScreenOrientation(orientation);
      if (nextOffset === null || nextOffset === screenHeadingOffsetRef.current) {
        return;
      }

      screenHeadingOffsetRef.current = nextOffset;
      smoothedDeviceHeadingRef.current = null;
      lastDeviceHeadingUpdateRef.current = 0;
      setDeviceHeading(null);
    };

    void ScreenOrientation.getOrientationAsync()
      .then((orientation) => {
        if (active) applyOrientation(orientation);
      })
      .catch(() => undefined);

    const subscription = ScreenOrientation.addOrientationChangeListener((event) => {
      if (active) applyOrientation(event.orientationInfo.orientation);
    });

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

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
      const reading = {
        ...rawReading,
        degrees: normalizeHeading(rawReading.degrees + screenHeadingOffsetRef.current),
      };

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
    if (!gpsFix) return undefined;

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
  }, [gpsFix, routeCoordinates, routePath]);

  useEffect(() => {
    if (!userCoords) {
      return undefined;
    }

    const now = Date.now();
    const lastLookup = lastTrafficLookupRef.current;
    const movedMeters = distanceMeters(lastLookup.coords, userCoords);
    const shouldSkip = lastLookup.coords
      && movedMeters !== null
      && movedMeters < 180
      && now - lastLookup.timestamp < 60_000;

    if (shouldSkip) {
      return undefined;
    }

    let cancelled = false;
    const controller = new AbortController();
    lastTrafficLookupRef.current = { coords: userCoords, timestamp: now };

    apiService.fetchTrafficSummary(userCoords[1], userCoords[0], controller.signal)
      .then((summary) => {
        if (!cancelled) {
          setTrafficState(summary.status || 'unavailable');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTrafficState('unavailable');
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [userCoords]);

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

    async function refreshLiveData() {
      if (!active) return;
      if (liveRefreshInFlight) {
        return;
      }

      liveRefreshInFlight = true;
      const [tripUpdatesResult, vehiclesResult] = await Promise.allSettled([
        apiService.fetchRouteTripUpdates(routeId),
        apiService.fetchRouteVehicles(routeId),
      ]);
      lastLiveRefreshAt = Date.now();

      if (active) {
        // Preserve the last-good component independently when one endpoint is
        // degraded; an ATM vehicle feed outage must not erase trip updates.
        if (tripUpdatesResult.status === 'fulfilled') {
          lastTripUpdatesSuccessAt = lastLiveRefreshAt;
          setRouteTripUpdates(tripUpdatesResult.value);
        } else if (lastLiveRefreshAt - lastTripUpdatesSuccessAt > LIVE_DATA_STALE_AFTER_MS) {
          setRouteTripUpdates([]);
        }
        if (vehiclesResult.status === 'fulfilled') {
          lastVehiclesSuccessAt = lastLiveRefreshAt;
          setVehiclePositions(vehiclesResult.value);
        } else if (lastLiveRefreshAt - lastVehiclesSuccessAt > LIVE_DATA_STALE_AFTER_MS) {
          setVehiclePositions([]);
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
      try {
        const [data, stopsData] = await Promise.all([
          apiService.fetchRouteShape(routeId, directionId, tripId),
          apiService.fetchRouteStops(routeId, directionId, tripId),
        ]);
        if (!active) return;
        if (data) {
          setRouteInfo(data);
          if (data.geojson) {
            setRouteFeature(data.geojson);
          }
        }

        if (stopsData && stopsData.features) {
          setStopsFeature(stopsData);
        }

        await refreshLiveData();
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

  const handleMapOrientation = () => {
    const nextOrientation: MapOrientation = mapOrientation === 'course' ? 'northUp' : 'course';
    if (orientationTransitionTimerRef.current) {
      clearTimeout(orientationTransitionTimerRef.current);
    }

    setMapOrientation(nextOrientation);

    if (isCameraFollowing) {
      setCameraTransitionDuration(500);
      orientationTransitionTimerRef.current = setTimeout(() => {
        setCameraTransitionDuration(0);
        orientationTransitionTimerRef.current = null;
      }, 520);
      return;
    }

    cameraRef.current?.setStop({
      bearing: nextOrientation === 'course' ? displayRouteBearing : 0,
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
            bearing={isCameraFollowing
              ? mapOrientation === 'course' ? displayRouteBearing : 0
              : undefined}
            duration={isCameraFollowing ? cameraTransitionDuration : undefined}
            easing={isCameraFollowing
              ? cameraTransitionDuration > 0 ? 'ease' : 'linear'
              : undefined}
            pitch={isCameraFollowing ? mapPitch : undefined}
            zoom={isCameraFollowing ? mapZoom : undefined}
          />
        ) : null}

        <Layer
          id="routeBuildings3d"
          type="fill-extrusion"
          source="carto"
          source-layer="building"
          minzoom={15}
          paint={buildingExtrusionPaint as any}
        />

        {/* Custom user location: Programmatic TMB Bus Marker */}
        {locationGranted && displayCoords && (
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
                'line-color': '#DC2626',
                'line-width': 10,
                'line-opacity': 0.2,
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
                'line-color': '#DC2626',
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
                'circle-stroke-color': '#DC2626',
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
        <View style={[styles.routeHud, usesLightChrome && styles.mapChromeLight]}>
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
        </View>
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
            mapOrientation === 'course' && styles.mapRecenterTriggerActive,
          ]}
          onPress={handleMapOrientation}
          accessibilityRole="button"
          accessibilityLabel={mapOrientation === 'course'
            ? t('map.orientationNorthUp')
            : t('map.orientationCourse')}
          accessibilityState={{ selected: mapOrientation === 'northUp' }}
        >
          <MaterialCommunityIcons
            name={mapOrientation === 'course' ? 'compass-outline' : 'navigation-variant'}
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

      <View style={[
        styles.driverPanel,
        usesLightChrome && styles.mapChromeLight,
        isLandscape && styles.driverPanelLandscape,
        {
          left: mapSafeLeft,
          right: mapSafeRight,
          bottom: Math.max(insets.bottom + (isLandscape ? 14 : 18), isLandscape ? 14 : 18),
        },
      ]}>
        <View style={[styles.driverContent, isLandscape && styles.driverContentLandscape]}>
          <View style={[styles.driverPrimaryRow, isLandscape && styles.driverPrimaryRowLandscape]}>
            <View style={styles.driverStopIcon}>
              <MaterialCommunityIcons name="bus-stop" size={18} color="#FFFFFF" />
            </View>
            <View style={styles.driverStopInfo}>
              <Text style={[styles.driverStopName, { color: chromeTextColor }]} numberOfLines={1}>
                {nextStop?.stop_name || t('map.calculatingStop')}
              </Text>
            </View>
            <View style={styles.driverEtaPill}>
              <MaterialCommunityIcons name="timer-outline" size={13} color="#FFFFFF" />
              <Text style={styles.driverEtaText}>{formatEta(nextStopEtaMinutes, language)}</Text>
            </View>
          </View>

          <View style={[styles.driverStatusRow, isLandscape && styles.driverStatusRowLandscape]}>
            {paceInfo ? (
              <View
                style={[
                  styles.driverPacePill,
                  isLandscape && styles.driverPacePillLandscape,
                  paceInfo.tone === 'good' && styles.driverPaceGood,
                  paceInfo.tone === 'warning' && styles.driverPaceWarning,
                  paceInfo.tone === 'danger' && styles.driverPaceDanger,
                ]}
              >
                <MaterialCommunityIcons
                  name={paceInfo.icon}
                  size={14}
                  color="#FFFFFF"
                />
                <Text style={styles.driverPaceText} numberOfLines={1}>{paceInfo.label}</Text>
              </View>
            ) : null}
            {visibleDriverMetrics.map((metric) => (
              <View
                key={`${metric.icon}-${metric.label}`}
                style={[styles.driverMetric, isLandscape && styles.driverMetricLandscape]}
              >
                <MaterialCommunityIcons name={metric.icon} size={14} color={colors.primary} />
                <Text style={[styles.driverMetricText, { color: chromeTextColor }]} numberOfLines={1}>
                  {metric.label}
                </Text>
              </View>
            ))}
          </View>
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
    backgroundColor: 'rgba(10, 22, 40, 0.85)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  driverPanelLandscape: {
    left: 18,
    right: 18,
    borderRadius: 12,
    paddingVertical: 8,
  },
  driverContent: {
    minWidth: 0,
  },
  driverContentLandscape: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  driverPrimaryRow: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  driverPrimaryRowLandscape: {
    flex: 1,
  },
  driverStopIcon: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  driverStopInfo: {
    flex: 1,
    minWidth: 0,
  },
  driverStopName: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '900',
    marginTop: 2,
  },
  driverEtaPill: {
    height: 30,
    minWidth: 76,
    borderRadius: 9,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: colors.primary,
  },
  driverEtaText: {
    color: '#FFFFFF',
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '900',
  },
  driverPacePill: {
    height: 30,
    borderRadius: 9,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#334155',
    flexGrow: 1,
    flexBasis: '46%',
    minWidth: 0,
  },
  driverPacePillLandscape: {
    flexBasis: 144,
  },
  driverPaceGood: {
    backgroundColor: '#16A34A',
  },
  driverPaceWarning: {
    backgroundColor: '#D97706',
  },
  driverPaceDanger: {
    backgroundColor: '#DC2626',
  },
  driverPaceText: {
    flex: 1,
    minWidth: 0,
    color: '#FFFFFF',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '900',
  },
  driverStatusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 9,
    minWidth: 0,
  },
  driverStatusRowLandscape: {
    flex: 1,
    marginTop: 0,
  },
  driverMetric: {
    height: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
    flexGrow: 1,
    flexBasis: '46%',
    minWidth: 0,
  },
  driverMetricLandscape: {
    flexBasis: 98,
  },
  driverMetricText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
  },
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
