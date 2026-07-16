import AsyncStorage from '@react-native-async-storage/async-storage';
import { telemetry } from './telemetry';

const STORAGE_KEY = '@alvolant/user-preferences/v1';
const STORAGE_VERSION = 1;
const MAX_FAVORITES = 24;
const MAX_RECENTS = 4;
const MAX_ROUTE_ID_LENGTH = 160;
const MAX_STORED_BYTES = 32_000;

export type RecentRoute = {
  routeId: string;
  directionId: 0 | 1;
  usedAt: number;
};

export type AppLanguage = 'ca' | 'es' | 'gl' | 'eu';
export type VehicleColor = 'red' | 'yellow' | 'green' | 'route';
export type VehicleMarker = 'bus' | 'arrow';
export type RouteLineColor = 'red' | 'yellow' | 'green' | 'blue' | 'white';
export type HomeAgency = 'TMB' | 'AMB' | 'FGC' | 'Rodalies' | 'Altres';

export const HOME_AGENCIES: readonly HomeAgency[] = [
  'TMB',
  'AMB',
  'FGC',
  'Rodalies',
  'Altres',
];

export type UserPreferences = {
  favoriteRouteIds: string[];
  recentRoutes: RecentRoute[];
  language: AppLanguage;
  vehicleColor: VehicleColor;
  vehicleMarker: VehicleMarker;
  homeAgencyIds: HomeAgency[];
  hasCompletedOnboarding: boolean;
  backgroundLocationEnabled: boolean;
  keepAwakeEnabled: boolean;
  liveActivitiesEnabled: boolean;
  buildings3dEnabled: boolean;
  routeLineDynamic: boolean;
  routeLineColor: RouteLineColor;
};

type StoredPreferences = UserPreferences & {
  version: number;
};

export const EMPTY_USER_PREFERENCES: UserPreferences = {
  favoriteRouteIds: [],
  recentRoutes: [],
  language: 'ca',
  vehicleColor: 'red',
  vehicleMarker: 'bus',
  homeAgencyIds: [],
  hasCompletedOnboarding: false,
  backgroundLocationEnabled: true,
  keepAwakeEnabled: true,
  liveActivitiesEnabled: true,
  buildings3dEnabled: true,
  routeLineDynamic: true,
  routeLineColor: 'blue',
};

let writeQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRouteId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ROUTE_ID_LENGTH || /[\u0000-\u001F\u007F]/.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeHomeAgency(value: unknown): HomeAgency | null {
  return typeof value === 'string' && HOME_AGENCIES.includes(value as HomeAgency)
    ? value as HomeAgency
    : null;
}

function normalizePreferences(value: unknown): UserPreferences {
  if (!isRecord(value) || value.version !== STORAGE_VERSION) {
    return { ...EMPTY_USER_PREFERENCES };
  }

  const favoriteRouteIds = Array.isArray(value.favoriteRouteIds)
    ? Array.from(new Set(value.favoriteRouteIds.map(normalizeRouteId).filter((id): id is string => Boolean(id))))
      .slice(0, MAX_FAVORITES)
    : [];

  const now = Date.now();
  const recentRoutes: RecentRoute[] = [];
  const recentIds = new Set<string>();

  if (Array.isArray(value.recentRoutes)) {
    for (const candidate of value.recentRoutes) {
      if (!isRecord(candidate)) {
        continue;
      }

      const routeId = normalizeRouteId(candidate.routeId);
      const directionId = candidate.directionId;
      const usedAt = candidate.usedAt;
      if (
        !routeId
        || (directionId !== 0 && directionId !== 1)
        || typeof usedAt !== 'number'
        || !Number.isFinite(usedAt)
        || usedAt <= 0
        || usedAt > now + 86_400_000
        || recentIds.has(routeId)
      ) {
        continue;
      }

      recentIds.add(routeId);
      recentRoutes.push({ routeId, directionId, usedAt });
    }
  }

  recentRoutes.sort((a, b) => b.usedAt - a.usedAt);

  const language: AppLanguage = (
    value.language === 'es' || value.language === 'gl' || value.language === 'eu'
  ) ? value.language : 'ca';
  const vehicleColor: VehicleColor = (
    value.vehicleColor === 'yellow'
    || value.vehicleColor === 'green'
    || value.vehicleColor === 'route'
  ) ? value.vehicleColor : 'red';
  const vehicleMarker: VehicleMarker = value.vehicleMarker === 'arrow' ? 'arrow' : 'bus';
  const routeLineColor: RouteLineColor = (
    value.routeLineColor === 'red'
    || value.routeLineColor === 'yellow'
    || value.routeLineColor === 'green'
    || value.routeLineColor === 'white'
  ) ? value.routeLineColor : 'blue';
  const storedHomeAgencies = Array.isArray(value.homeAgencyIds)
    ? value.homeAgencyIds
    : [value.homeAgency]; // Migrate the single-company preference introduced in v1.
  const homeAgencyIds = Array.from(new Set(
    storedHomeAgencies
      .map(normalizeHomeAgency)
      .filter((agency): agency is HomeAgency => Boolean(agency)),
  ));

  return {
    favoriteRouteIds,
    recentRoutes: recentRoutes.slice(0, MAX_RECENTS),
    language,
    vehicleColor,
    vehicleMarker,
    homeAgencyIds,
    hasCompletedOnboarding: value.hasCompletedOnboarding === true,
    backgroundLocationEnabled: value.backgroundLocationEnabled !== false,
    keepAwakeEnabled: value.keepAwakeEnabled !== false,
    liveActivitiesEnabled: value.liveActivitiesEnabled !== false,
    buildings3dEnabled: value.buildings3dEnabled !== false,
    routeLineDynamic: value.routeLineDynamic !== false,
    routeLineColor,
  };
}

export async function loadUserPreferences(): Promise<UserPreferences> {
  try {
    const serialized = await AsyncStorage.getItem(STORAGE_KEY);
    if (!serialized || serialized.length > MAX_STORED_BYTES) {
      return { ...EMPTY_USER_PREFERENCES };
    }

    return normalizePreferences(JSON.parse(serialized));
  } catch (error) {
    telemetry.captureException(error, { phase: 'preferences_read' });
    return { ...EMPTY_USER_PREFERENCES };
  }
}

export function saveUserPreferences(preferences: UserPreferences): Promise<void> {
  const normalized = normalizePreferences({
    ...preferences,
    version: STORAGE_VERSION,
  });
  const payload: StoredPreferences = {
    version: STORAGE_VERSION,
    ...normalized,
  };

  writeQueue = writeQueue
    .catch(() => undefined)
    .then(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload)))
    .catch((error) => {
      telemetry.captureException(error, { phase: 'preferences_write' });
    });

  return writeQueue;
}

export function withToggledFavorite(
  preferences: UserPreferences,
  routeId: string,
): UserPreferences {
  const normalizedRouteId = normalizeRouteId(routeId);
  if (!normalizedRouteId) {
    return preferences;
  }

  const isFavorite = preferences.favoriteRouteIds.includes(normalizedRouteId);
  const favoriteRouteIds = isFavorite
    ? preferences.favoriteRouteIds.filter((id) => id !== normalizedRouteId)
    : [normalizedRouteId, ...preferences.favoriteRouteIds].slice(0, MAX_FAVORITES);

  return { ...preferences, favoriteRouteIds };
}

export function withRecordedRecent(
  preferences: UserPreferences,
  routeId: string,
  directionId: 0 | 1,
): UserPreferences {
  const normalizedRouteId = normalizeRouteId(routeId);
  if (!normalizedRouteId) {
    return preferences;
  }

  return {
    ...preferences,
    recentRoutes: [
      { routeId: normalizedRouteId, directionId, usedAt: Date.now() },
      ...preferences.recentRoutes.filter((recent) => recent.routeId !== normalizedRouteId),
    ].slice(0, MAX_RECENTS),
  };
}
