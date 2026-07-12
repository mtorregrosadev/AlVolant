import React, { useEffect, useState, useRef } from 'react';
import {
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { apiService, type RTTripUpdate, type VehiclePosition } from '../services/api';
import { formatDirectionLabel } from '../services/directionLabel';
import { colors, safeHexColor } from '../theme';
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

type MapScreenProps = NativeStackScreenProps<RootStackParamList, 'Map'>;
type MapTheme = 'dark' | 'light' | 'satellite';
type MapThemeOption = {
  label: string;
  icon: IconName;
  style: any;
};

const MS_TO_KMH = 3.6;
const MIN_MOVING_SPEED_KMH = 3;
const FALLBACK_CITY_SPEED_KMH = 18;

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

function interpolateCoordinate(from: Coordinate, to: Coordinate, ratio: number): Coordinate {
  const safeRatio = clamp(ratio, 0, 1);
  return [
    from[0] + (to[0] - from[0]) * safeRatio,
    from[1] + (to[1] - from[1]) * safeRatio,
  ];
}

function projectPointOnRoute(point: Coordinate | null, routeCoordinates: Coordinate[]): RouteProjection | null {
  if (!point || routeCoordinates.length < 2) {
    return null;
  }

  let bestProjection: RouteProjection | null = null;
  let accumulatedDistance = 0;

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

    if (!bestProjection || distanceFromRoute < bestProjection.distanceFromRoute) {
      bestProjection = {
        coordinate,
        distanceAlong: accumulatedDistance + segmentLength * ratio,
        bearing: bearingBetween(start, end),
        distanceFromRoute,
      };
    }

    accumulatedDistance += segmentLength;
  }

  return bestProjection;
}

function coordinateAtDistance(routeCoordinates: Coordinate[], distanceAlong: number): Pick<RouteProjection, 'coordinate' | 'bearing'> | null {
  if (routeCoordinates.length < 2) {
    return null;
  }

  let accumulatedDistance = 0;
  const targetDistance = Math.max(0, distanceAlong);

  for (let index = 0; index < routeCoordinates.length - 1; index += 1) {
    const start = routeCoordinates[index];
    const end = routeCoordinates[index + 1];
    const segmentLength = distanceMeters(start, end) ?? 0;

    if (segmentLength <= 0) {
      continue;
    }

    if (targetDistance <= accumulatedDistance + segmentLength) {
      const ratio = (targetDistance - accumulatedDistance) / segmentLength;
      return {
        coordinate: interpolateCoordinate(start, end, ratio),
        bearing: bearingBetween(start, end),
      };
    }

    accumulatedDistance += segmentLength;
  }

  const lastIndex = routeCoordinates.length - 1;
  return {
    coordinate: routeCoordinates[lastIndex],
    bearing: bearingBetween(routeCoordinates[lastIndex - 1], routeCoordinates[lastIndex]),
  };
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

function formatDistance(meters: number | null) {
  if (meters === null) {
    return 'Dist. pendent';
  }

  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }

  return `${(meters / 1000).toFixed(1)} km`;
}

function formatEta(minutes: number | null) {
  if (minutes === null) {
    return 'pendent';
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

function formatFleetGap(minutes: number | null) {
  if (minutes === null) {
    return 'sense dades';
  }

  if (minutes <= 1) {
    return '<1 min';
  }

  return `${Math.round(minutes)} min`;
}

function formatDelay(seconds: number | null) {
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

  return 'A l\'hora';
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

function getPaceInfo(delaySeconds: number | null): PaceInfo | null {
  if (delaySeconds === null) {
    return null;
  }

  if (delaySeconds >= 300) {
    return { label: 'Vas tard. Recupera si és segur', icon: 'speedometer-medium', tone: 'danger' };
  }

  if (delaySeconds >= 90) {
    return { label: 'Apreta una mica si és segur', icon: 'speedometer-medium', tone: 'warning' };
  }

  if (delaySeconds <= -180) {
    return { label: 'Vas avançat. Regula el ritme', icon: 'speedometer-slow', tone: 'warning' };
  }

  return { label: 'Vas bé de temps', icon: 'check-circle-outline', tone: 'good' };
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
    label: 'Fosc',
    icon: 'weather-night',
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  },
  light: {
    label: 'Clar',
    icon: 'white-balance-sunny',
    style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  },
  satellite: {
    label: 'Sat',
    icon: 'satellite-variant',
    style: SATELLITE_MAP_STYLE,
  },
};

export default function MapScreen({ route, navigation }: MapScreenProps) {
  const { routeId, directionId, assignedVehicle, tripId, directionLabel } = route.params;
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = viewportWidth > viewportHeight;
  const isCompactLandscape = isLandscape && viewportHeight < 520;

  const [routeFeature, setRouteFeature] = useState<any>(null);
  const [stopsFeature, setStopsFeature] = useState<any>(null);
  const [selectedStop, setSelectedStop] = useState<SelectedStop | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [locationGranted, setLocationGranted] = useState(false);
  const [trackingMode, setTrackingMode] = useState<string>('course');
  const [userCoords, setUserCoords] = useState<Coordinate | null>(null);
  const [userHeading, setUserHeading] = useState<number>(0);
  const [userSpeedKmh, setUserSpeedKmh] = useState<number | null>(null);
  const [userAccuracy, setUserAccuracy] = useState<number | null>(null);
  const [displayCoords, setDisplayCoords] = useState<Coordinate | null>(null);
  const [displayRouteProgress, setDisplayRouteProgress] = useState<number | null>(null);
  const [displayRouteBearing, setDisplayRouteBearing] = useState<number>(0);
  const [mapBearing, setMapBearing] = useState<number>(0);
  const [routeInfo, setRouteInfo] = useState<any>(null);
  const [routeTripUpdates, setRouteTripUpdates] = useState<RTTripUpdate[]>([]);
  const [vehiclePositions, setVehiclePositions] = useState<VehiclePosition[]>([]);
  const [trafficLabel, setTrafficLabel] = useState('Trànsit: carregant');
  const [mapTheme, setMapTheme] = useState<MapTheme>('dark');
  const [isMapThemePickerOpen, setIsMapThemePickerOpen] = useState(false);
  const animationFrameRef = useRef<number | null>(null);
  const displayRouteProgressRef = useRef<number | null>(null);
  const lastTrafficLookupRef = useRef<{ coords: Coordinate | null; timestamp: number }>({
    coords: null,
    timestamp: 0,
  });

  const directionName = React.useMemo(() => {
    if (directionLabel) {
      return formatDirectionLabel(directionLabel);
    }

    if (routeInfo?.towards_label) {
      return formatDirectionLabel(routeInfo.towards_label);
    }

    if (routeInfo?.destination_name) {
      return `Cap a ${routeInfo.destination_name}`;
    }

    return '';
  }, [directionLabel, routeInfo]);

  const routeShortName = routeInfo?.route_short_name || 'Bus';
  const routeColor = safeHexColor(routeInfo?.route_color, colors.primary);
  const routeTextColor = safeHexColor(routeInfo?.route_text_color, colors.white);
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
  const buildingExtrusionPaint = {
    'fill-extrusion-color': mapTheme === 'satellite'
      ? '#F8FAFC'
      : usesLightChrome ? '#94A3B8' : '#334155',
    'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
    'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
    'fill-extrusion-opacity': mapTheme === 'satellite' ? 0.18 : usesLightChrome ? 0.78 : 0.68,
    'fill-extrusion-vertical-gradient': mapTheme !== 'satellite',
  };
  const routeCoordinates = React.useMemo(() => extractRouteCoordinates(routeFeature), [routeFeature]);
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
  const currentRouteProgress = displayRouteProgress
    ?? projectPointOnRoute(displayCoords, routeCoordinates)?.distanceAlong
    ?? projectPointOnRoute(userCoords, routeCoordinates)?.distanceAlong
    ?? null;
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
  const nextStopDelaySeconds = delayForStop(routeTripUpdates, tripId, nextStop);
  const paceInfo = getPaceInfo(nextStopDelaySeconds);
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
    ? `Davant ${formatFleetGap(fleetGaps.aheadMinutes)}`
    : fleetGaps.behindMinutes !== null
      ? `Darrere ${formatFleetGap(fleetGaps.behindMinutes)}`
      : null;
  const trafficStatus = trafficLabel.replace(/^Trànsit:\s*/i, '').trim();
  const hasTrafficData = !/^(carregant|clau pendent|no disponible|dades parcials)$/i.test(trafficStatus);
  const driverMetrics = [
    nextStopDistanceMeters !== null
      ? { icon: 'map-marker-distance' as IconName, label: formatDistance(nextStopDistanceMeters) }
      : null,
    estimatedArrival
      ? { icon: 'clock-time-four-outline' as IconName, label: `Arr. ${estimatedArrival}` }
      : null,
    currentSpeedKmh !== null
      ? { icon: 'speedometer' as IconName, label: `${currentSpeedLabel} km/h` }
      : null,
    nextStopDelaySeconds !== null
      ? { icon: 'calendar-clock-outline' as IconName, label: formatDelay(nextStopDelaySeconds) || 'A l\'hora' }
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

  // Request location permissions and start watching GPS coordinates/heading
  useEffect(() => {
    let subscription: any;

    async function setupLocation() {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        const granted = status === 'granted';
        setLocationGranted(granted);

        if (granted) {
          subscription = await Location.watchPositionAsync(
            {
              accuracy: Location.Accuracy.BestForNavigation,
              timeInterval: 1000,
              distanceInterval: 1,
            },
            (loc) => {
              if (loc.coords) {
                setUserCoords([loc.coords.longitude, loc.coords.latitude]);
                setUserAccuracy(
                  typeof loc.coords.accuracy === 'number' && loc.coords.accuracy >= 0
                    ? loc.coords.accuracy
                    : null
                );
                setUserSpeedKmh(
                  typeof loc.coords.speed === 'number' && loc.coords.speed >= 0
                    ? loc.coords.speed * MS_TO_KMH
                    : null
                );
                if (typeof loc.coords.heading === 'number') {
                  setUserHeading(loc.coords.heading);
                }
              }
            }
          );
        } else {
          console.warn('Location permission not granted');
        }
      } catch (err) {
        console.error('Error starting location tracking:', err);
      }
    }

    setupLocation();

    return () => {
      if (subscription) {
        subscription.remove();
      }
    };
  }, []);

  useEffect(() => {
    if (!userCoords) {
      return undefined;
    }

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const projection = projectPointOnRoute(userCoords, routeCoordinates);
    if (!projection) {
      setDisplayCoords(userCoords);
      setDisplayRouteBearing(userHeading);
      setDisplayRouteProgress(null);
      displayRouteProgressRef.current = null;
      return undefined;
    }

    const fromProgress = displayRouteProgressRef.current ?? projection.distanceAlong;
    const toProgress = projection.distanceAlong;
    const progressDelta = Math.abs(toProgress - fromProgress);
    const duration = clamp(progressDelta * 8, 650, 1400);
    const startTime = Date.now();

    const step = () => {
      const elapsed = Date.now() - startTime;
      const ratio = clamp(elapsed / duration, 0, 1);
      const easedRatio = ratio < 1 ? ratio * ratio * (3 - 2 * ratio) : 1;
      const nextProgress = fromProgress + (toProgress - fromProgress) * easedRatio;
      const nextPosition = coordinateAtDistance(routeCoordinates, nextProgress);

      if (nextPosition) {
        displayRouteProgressRef.current = nextProgress;
        setDisplayRouteProgress(nextProgress);
        setDisplayCoords(nextPosition.coordinate);
        setDisplayRouteBearing(nextPosition.bearing);
      }

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
  }, [routeCoordinates, userCoords, userHeading]);

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
    lastTrafficLookupRef.current = { coords: userCoords, timestamp: now };

    apiService.fetchTrafficSummary(userCoords[1], userCoords[0])
      .then((summary) => {
        if (!cancelled) {
          setTrafficLabel(summary.label || 'Trànsit: dades parcials');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTrafficLabel('Trànsit: no disponible');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userCoords]);

  // Load route data and connect WebSocket
  useEffect(() => {
    let ws: WebSocket;

    async function loadData() {
      try {
        const data = await apiService.fetchRouteShape(routeId, directionId, tripId);
        if (data) {
          setRouteInfo(data);
          if (data.geojson) {
            setRouteFeature(data.geojson);
          }
        }

        const stopsData = await apiService.fetchRouteStops(routeId, directionId, tripId);
        if (stopsData && stopsData.features) {
          setStopsFeature(stopsData);
        }

        const [tripUpdatesResult, vehiclesResult] = await Promise.allSettled([
          apiService.fetchRouteTripUpdates(routeId),
          apiService.fetchRouteVehicles(routeId),
        ]);

        if (tripUpdatesResult.status === 'fulfilled') {
          setRouteTripUpdates(tripUpdatesResult.value);
        } else {
          setRouteTripUpdates([]);
        }

        if (vehiclesResult.status === 'fulfilled') {
          setVehiclePositions(vehiclesResult.value);
        } else {
          setVehiclePositions([]);
        }

        ws = apiService.connectWebSocket((msg) => {
          // Live updates for future phases
        });

        ws.addEventListener('open', () => setIsConnected(true));
        ws.addEventListener('close', () => setIsConnected(false));
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }

    loadData();

    return () => {
      if (ws) {
        ws.close();
      }
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
      console.log('Could not extract screen coordinates from tap event:', JSON.stringify(event));
      return;
    }

    try {
    console.log('Querying features at pixel point [', x, ',', y, '] with 28px bounding box hitbox...');
      const features = await mapRef.current.queryRenderedFeatures(
        [
          [x - 14, y - 14],
          [x + 14, y + 14]
        ],
        { layers: ['stopsCircle'] }
      );

      console.log('Query results count:', Array.isArray(features) ? features.length : (features?.features?.length || 0));
      console.log('Query features payload:', JSON.stringify(features));

      let selectedFeature: any = null;

      if (features && Array.isArray(features) && features.length > 0) {
        selectedFeature = features[0];
      } else if (features && features.features && features.features.length > 0) {
        selectedFeature = features.features[0];
      }

      if (selectedFeature?.properties) {
        const selectedFeatureProperties = selectedFeature.properties;
        console.log('Selecting stop properties:', JSON.stringify(selectedFeatureProperties));
        setSelectedStop({
          ...selectedFeatureProperties,
          coordinates: normalizeCoordinates(selectedFeature.geometry?.coordinates),
        });
      } else {
        setSelectedStop(null);
      }
    } catch (e) {
      console.log('Error querying rendered features:', e);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#DC2626" />
        <Text style={styles.loadingText}>Carregant ruta...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Error: {error}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.retryText}>Tornar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const routeSource = routeFeature
    ? {
      type: 'FeatureCollection' as const,
      features: [routeFeature],
    }
    : null;

  const handleRegionChange = (event: any) => {
    if (event?.properties && typeof event.properties.bearing === 'number') {
      setMapBearing(event.properties.bearing);
    }
  };

  const handleRecenter = () => {
    setTrackingMode('course');

    if (displayCoords) {
      cameraRef.current?.easeTo({
        center: displayCoords,
        zoom: mapZoom,
        bearing: displayRouteBearing,
        pitch: mapPitch,
        duration: 700,
        easing: 'ease',
      });
    }
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
        onPress={handleMapPress}
        onRegionDidChange={handleRegionChange}
        onRegionIsChanging={handleRegionChange}
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
            center={trackingMode === 'course' && displayRouteProgress !== null ? displayCoords ?? undefined : undefined}
            bearing={trackingMode === 'course' ? displayRouteBearing : undefined}
            duration={trackingMode === 'course' ? 700 : undefined}
            easing="linear"
            pitch={mapPitch}
            zoom={mapZoom}
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
            <View style={{ transform: [{ rotate: `${displayRouteBearing - mapBearing}deg` }] }}>
              <View style={styles.busContainer}>
                <View style={styles.busBody}>
                  <View style={styles.busRedFront} />
                  <View style={styles.busRedBack} />
                  <View style={styles.busStripeLeft} />
                  <View style={styles.busStripeRight} />
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
                {selectedStop.stop_name || 'Parada desconeguda'}
              </Text>
              <View style={styles.stopCalloutEta}>
                <MaterialCommunityIcons name="timer-outline" size={13} color="#FFFFFF" />
                <Text style={styles.stopCalloutEtaText}>{formatEta(selectedStopEtaMinutes)}</Text>
              </View>
              <TouchableOpacity
                style={[styles.stopCalloutClose, usesLightChrome && styles.stopCalloutCloseLight]}
                onPress={() => setSelectedStop(null)}
                accessibilityRole="button"
                accessibilityLabel="Tancar informació de la parada"
              >
                <MaterialCommunityIcons name="close" size={15} color={chromeTextColor} />
              </TouchableOpacity>
            </View>
          </Marker>
        ) : null}
      </Map>

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
          accessibilityLabel="Tornar a les línies"
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
              {directionName || 'Ruta activa'}
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
              const isActive = theme === mapTheme;

              return (
                <TouchableOpacity
                  key={theme}
                  style={[
                    styles.mapThemeOption,
                    isActive && styles.mapThemeOptionActive,
                  ]}
                  onPress={() => {
                    setMapTheme(theme);
                    setIsMapThemePickerOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Mapa ${option.label}`}
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
            accessibilityLabel="Canviar el tipus de mapa"
          >
            <MaterialCommunityIcons name="layers-outline" size={21} color={chromeTextColor} />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[
            styles.mapRecenterTrigger,
            trackingMode === 'course' && styles.mapRecenterTriggerActive,
          ]}
          onPress={handleRecenter}
          accessibilityRole="button"
          accessibilityLabel="Centrar el bus al mapa"
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
                {nextStop?.stop_name || 'Calculant parada'}
              </Text>
            </View>
            <View style={styles.driverEtaPill}>
              <MaterialCommunityIcons name="timer-outline" size={13} color="#FFFFFF" />
              <Text style={styles.driverEtaText}>{formatEta(nextStopEtaMinutes)}</Text>
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
