import AsyncStorage from '@react-native-async-storage/async-storage';

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

export type UserPreferences = {
  favoriteRouteIds: string[];
  recentRoutes: RecentRoute[];
};

type StoredPreferences = UserPreferences & {
  version: number;
};

export const EMPTY_USER_PREFERENCES: UserPreferences = {
  favoriteRouteIds: [],
  recentRoutes: [],
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

  return {
    favoriteRouteIds,
    recentRoutes: recentRoutes.slice(0, MAX_RECENTS),
  };
}

export async function loadUserPreferences(): Promise<UserPreferences> {
  try {
    const serialized = await AsyncStorage.getItem(STORAGE_KEY);
    if (!serialized || serialized.length > MAX_STORED_BYTES) {
      return { ...EMPTY_USER_PREFERENCES };
    }

    return normalizePreferences(JSON.parse(serialized));
  } catch {
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
    .then(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload)));

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
