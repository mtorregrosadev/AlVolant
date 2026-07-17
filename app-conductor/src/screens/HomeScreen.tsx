import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Keyboard,
  LayoutAnimation,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { useFocusEffect } from '@react-navigation/native';
import * as Location from 'expo-location';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import AgencyLogo from '../components/AgencyLogo';
import LanguageFlag from '../components/LanguageFlag';
import ServiceAssignmentModal from '../components/ServiceAssignmentModal';
import {
  apiService,
  type RouteInfo,
  type RTTripUpdate,
  type UpcomingTrip,
  type VehiclePosition,
} from '../services/api';
import {
  parseReliefStopsGeoJson,
  selectNearbyReliefStop,
  selectReliefCandidate,
  type ReliefCandidate,
} from '../services/reliefDetection';
import { telemetry } from '../services/telemetry';
import {
  formatRecentTime,
  getAgencyFilter,
  getAgencyLabel,
  getDirectionNames,
  getRouteTitle,
  routeMatchesSearch,
} from '../services/routePresentation';
import {
  HOME_AGENCIES,
  type HomeAgency,
  type RecentRoute,
} from '../services/userPreferences';
import { usePreferences } from '../PreferencesContext';
import { useI18n } from '../i18n';
import {
  colors,
  fonts,
  radii,
  routePastelColor,
  safeHexColor,
  spacing,
  typography,
} from '../theme';

type HomeScreenProps = NativeStackScreenProps<RootStackParamList, 'Home'>;
type PreferenceView = 'recent' | 'favorite';
type AssignmentMode = 'detecting' | 'candidate' | 'departures';
type PreferenceRoute = {
  route: RouteInfo;
  recent?: RecentRoute;
};

const FOREGROUND_REFRESH_MS = 15 * 60 * 1000;
const NEARBY_REFRESH_MS = 2 * 60 * 1000;
const RECENT_LOCATION_MAX_AGE_MS = 2 * 60 * 1000;
const BASE_ROUTE_ROW_HEIGHT = 49;
const BASE_PREFERENCE_ROW_HEIGHT = 38;
const PREFERENCE_ROWS_PORTRAIT = 4;
const PREFERENCE_ROWS_LANDSCAPE = 3;
const MAX_RECENT_ROUTES = 4;
const RECENT_PREVIEW_ROWS = 2.5;
const SEARCH_RESULT_LIMIT = 40;
const SEARCH_OPEN_DURATION_MS = 320;
const SEARCH_CLOSE_DURATION_MS = 280;
const SEARCH_INITIAL_EXTRA_RESULTS = 12;
const SEARCH_APPEND_BATCH_SIZE = 8;
const SEARCH_APPEND_THROTTLE_MS = 180;
const SEARCH_APPEND_REVEAL_DURATION_MS = 160;
const RELIEF_LOCATION_MAX_AGE_MS = 45_000;
const RELIEF_LOCATION_MAX_ACCURACY_METERS = 60;

function configureSearchLayout(
  duration: number,
  onEnd?: () => void,
  animateNewContent = false,
) {
  LayoutAnimation.configureNext({
    duration,
    ...(animateNewContent ? {
      create: {
        type: LayoutAnimation.Types.easeInEaseOut,
        property: LayoutAnimation.Properties.opacity,
      },
    } : {}),
    update: { type: LayoutAnimation.Types.easeInEaseOut },
  }, onEnd);
}

function sanitizeVehicleId(value: string) {
  return value.toLocaleUpperCase('ca').replace(/[^A-Z0-9-]/g, '').slice(0, 12);
}

function matchesVehicleNumber(realtimeVehicleId: string, requestedVehicleId: string) {
  const normalizedRealtimeId = sanitizeVehicleId(realtimeVehicleId);
  if (normalizedRealtimeId === requestedVehicleId) return true;

  // Operators sometimes expose a prefixed realtime id while drivers enter
  // the fleet number printed on the bus (for example, "3042"). Accept that
  // unambiguous numeric suffix without weakening named-id matching.
  return /^\d{3,}$/.test(requestedVehicleId)
    && normalizedRealtimeId.endsWith(requestedVehicleId);
}

function routeNearbyDistance(
  route: RouteInfo,
  distances: Record<string, number>,
) {
  const routeIds = [route.route_id, ...(route.route_ids ?? [])];
  let nearest = Number.POSITIVE_INFINITY;

  routeIds.forEach((routeId) => {
    const distance = distances[routeId];
    if (Number.isFinite(distance) && distance < nearest) nearest = distance;
  });

  return nearest;
}

function haveSameDistances(
  current: Record<string, number>,
  next: Record<string, number>,
) {
  const currentIds = Object.keys(current);
  const nextIds = Object.keys(next);
  return currentIds.length === nextIds.length
    && nextIds.every((routeId) => current[routeId] === next[routeId]);
}

export default function HomeScreen(props: HomeScreenProps) {
  const { ready, preferences } = usePreferences();

  return ready && !preferences.hasCompletedOnboarding
    ? <FirstRunScreen />
    : <HomeContent {...props} />;
}

function FirstRunScreen() {
  const { preferences, setHomeAgencies, setLanguage } = usePreferences();
  const { language, t } = useI18n();
  const [step, setStep] = useState<'language' | 'agencies'>('language');
  const [selectedAgencies, setSelectedAgencies] = useState<HomeAgency[]>(
    preferences.homeAgencyIds,
  );

  const toggleAgency = (agency: HomeAgency) => {
    setSelectedAgencies((current) => current.includes(agency)
      ? current.filter((item) => item !== agency)
      : [...current, agency]);
  };

  return (
    <SafeAreaView style={styles.onboardingScreen} edges={['top', 'right', 'bottom', 'left']}>
      <StatusBar style="dark" />
      {step === 'language' ? (
        <View style={styles.onboardingContent}>
          <View style={styles.onboardingBody}>
            <View style={styles.welcomeIcon}>
            <MaterialCommunityIcons name="translate" size={26} color={colors.primary} />
            </View>
            <Text style={styles.welcomeTitle}>{t('onboarding.languageTitle')}</Text>
            <Text style={styles.welcomeSubtitle}>{t('onboarding.languageSubtitle')}</Text>

            <View style={[styles.welcomeAgencyGrid, styles.welcomeLanguageGrid]}>
            {([
              { value: 'ca', label: 'Català' },
              { value: 'es', label: 'Castellano' },
              { value: 'gl', label: 'Galego' },
              { value: 'eu', label: 'Euskara' },
            ] as const).map((option) => {
              const selected = language === option.value;
              return (
                <TouchableOpacity
                  key={option.value}
                  style={[
                    styles.welcomeAgencyOption,
                    styles.welcomeLanguageOption,
                    selected && styles.welcomeAgencyOptionSelected,
                  ]}
                  onPress={() => setLanguage(option.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={option.label}
                >
                  <LanguageFlag language={option.value} />
                  <Text style={[styles.welcomeAgencyText, selected && styles.welcomeAgencyTextSelected]}>
                    {option.label}
                  </Text>
                  {selected ? (
                    <MaterialCommunityIcons
                      name="check-circle"
                      size={19}
                      color={colors.white}
                      style={styles.welcomeAgencyCheck}
                    />
                  ) : null}
                </TouchableOpacity>
              );
            })}
            </View>

            <TouchableOpacity
              style={styles.welcomeContinueButton}
              onPress={() => setStep('agencies')}
              accessibilityRole="button"
              accessibilityLabel={t('onboarding.continue')}
            >
              <Text style={styles.welcomeContinueText}>{t('onboarding.continue')}</Text>
              <MaterialCommunityIcons name="arrow-right" size={20} color={colors.white} />
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.onboardingContent}>
          <View style={styles.onboardingBody}>
            <View style={styles.welcomeIcon}>
              <MaterialCommunityIcons name="hand-wave-outline" size={26} color={colors.primary} />
            </View>
            <Text style={styles.welcomeTitle}>{t('onboarding.title')}</Text>
            <Text style={styles.welcomeSubtitle}>{t('onboarding.subtitle')}</Text>

            <View style={styles.welcomeAgencyGrid}>
            {HOME_AGENCIES.map((agency) => {
              const selected = selectedAgencies.includes(agency);
              return (
                <TouchableOpacity
                  key={agency}
                  style={[styles.welcomeAgencyOption, selected && styles.welcomeAgencyOptionSelected]}
                  onPress={() => toggleAgency(agency)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={getAgencyLabel(agency, language)}
                >
                  <AgencyLogo agency={agency} color={selected ? colors.white : colors.primary} size="large" />
                  <Text style={[styles.welcomeAgencyText, selected && styles.welcomeAgencyTextSelected]}>
                    {getAgencyLabel(agency, language)}
                  </Text>
                  {selected ? (
                    <MaterialCommunityIcons
                      name="check-circle"
                      size={19}
                      color={colors.white}
                      style={styles.welcomeAgencyCheck}
                    />
                  ) : null}
                </TouchableOpacity>
              );
            })}
            </View>

            <TouchableOpacity
              style={[
                styles.welcomeContinueButton,
                selectedAgencies.length === 0 && styles.welcomeContinueButtonDisabled,
              ]}
              disabled={selectedAgencies.length === 0}
              onPress={() => setHomeAgencies(selectedAgencies)}
              accessibilityRole="button"
              accessibilityState={{ disabled: selectedAgencies.length === 0 }}
              accessibilityLabel={selectedAgencies.length === 0
                ? t('onboarding.selectionRequired')
                : t('onboarding.continue')}
            >
              <Text style={styles.welcomeContinueText}>{t('onboarding.continue')}</Text>
              <MaterialCommunityIcons name="arrow-right" size={20} color={colors.white} />
            </TouchableOpacity>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

function HomeContent({ navigation, route }: HomeScreenProps) {
  const {
    width: screenWidth,
    height: screenHeight,
    fontScale,
  } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = screenWidth > screenHeight;
  const usableScreenHeight = Math.max(0, screenHeight - insets.top - insets.bottom);
  const contentGutter = isLandscape
    ? 0
    : (screenWidth < 360 ? spacing.lg : screenWidth >= 430 ? spacing.xxl : spacing.xl);
  const isCompactPortrait = !isLandscape && usableScreenHeight < 690;
  const isBalancedPortrait = !isLandscape
    && usableScreenHeight >= 690
    && usableScreenHeight < 810;
  const typeScale = Math.min(
    1.1,
    Math.max(0.92, Math.min(screenWidth, screenHeight) / 390),
  );
  const rowScale = typeScale * Math.max(1, fontScale);
  const preferenceRowHeight = Math.ceil(BASE_PREFERENCE_ROW_HEIGHT * rowScale);
  const routeRowHeight = Math.ceil(BASE_ROUTE_ROW_HEIGHT * rowScale);
  const responsiveType = useMemo(() => {
    const fontSize = (value: number) => Math.round(value * typeScale * 2) / 2;
    const lineHeight = (value: number) => Math.ceil(value * typeScale);

    return StyleSheet.create({
      connectionText: { fontSize: fontSize(11.5), lineHeight: lineHeight(15) },
      heroSubtitle: { fontSize: fontSize(14), lineHeight: lineHeight(19) },
      searchInput: { fontSize: fontSize(15), lineHeight: lineHeight(20) },
      quickTitle: { fontSize: fontSize(13.5), lineHeight: lineHeight(18), flexShrink: 1 },
      preferenceModeText: {
        fontSize: fontSize(13),
        lineHeight: lineHeight(17),
        flexShrink: 1,
      },
      quickRouteBadgeText: { fontSize: fontSize(11.5), lineHeight: lineHeight(15) },
      preferenceDestination: { fontSize: fontSize(13.5), lineHeight: lineHeight(18) },
      preferenceTime: {
        width: Math.ceil(72 * typeScale),
        fontSize: fontSize(12),
        lineHeight: lineHeight(16),
      },
      sectionTitle: { fontSize: fontSize(19), lineHeight: lineHeight(23) },
      catalogButtonText: { fontSize: fontSize(12.5), lineHeight: lineHeight(17) },
      routeBadgeText: { fontSize: fontSize(12.5), lineHeight: lineHeight(16) },
      routeName: { fontSize: fontSize(13.5), lineHeight: lineHeight(18) },
      routeMeta: { fontSize: fontSize(11.5), lineHeight: lineHeight(15) },
      selectedRouteLabel: { fontSize: fontSize(11.5), lineHeight: lineHeight(15) },
      selectedRouteName: { fontSize: fontSize(13), lineHeight: lineHeight(17) },
      selectedRouteMeta: { fontSize: fontSize(10.5), lineHeight: lineHeight(14) },
      directionLabel: { fontSize: fontSize(12), lineHeight: lineHeight(16) },
      directionNumberText: { fontSize: fontSize(11.5), lineHeight: lineHeight(15) },
      directionText: { fontSize: fontSize(13), lineHeight: lineHeight(17) },
      startButtonText: { fontSize: fontSize(16.5), lineHeight: lineHeight(21) },
      startButtonMeta: { fontSize: fontSize(11.5), lineHeight: lineHeight(15) },
      preferenceRow: { height: preferenceRowHeight },
      routeRow: { minHeight: routeRowHeight },
      routeMain: { minHeight: Math.max(40, routeRowHeight - 4) },
      quickRouteBadge: {
        minWidth: Math.ceil(36 * typeScale),
        height: Math.ceil(23 * rowScale),
      },
      routeBadge: {
        minWidth: Math.ceil(44 * typeScale),
        height: Math.ceil(29 * rowScale),
      },
    });
  }, [preferenceRowHeight, routeRowHeight, rowScale, typeScale]);
  const responsiveLayout = useMemo(() => StyleSheet.create({
    discoveryContent: {
      paddingHorizontal: contentGutter,
      paddingTop: isCompactPortrait ? 0 : spacing.xs,
      paddingBottom: isCompactPortrait ? spacing.sm : spacing.md,
    },
    heroPanel: {
      minHeight: isLandscape || isCompactPortrait
        ? 92
        : (isBalancedPortrait ? 103 : 112),
    },
    heroTitle: {
      fontSize: isCompactPortrait ? 32 : 35,
      lineHeight: isCompactPortrait ? 30 : 33,
    },
    heroBusBadge: isCompactPortrait ? {
      top: 7,
      width: 47,
      height: 47,
      borderRadius: 24,
    } : {},
    journeyRail: {
      top: isCompactPortrait ? 55 : 61,
    },
    searchShell: {
      height: isCompactPortrait ? 38 : 41,
    },
    sectionHeading: {
      minHeight: isCompactPortrait ? 31 : 34,
    },
    servicePanel: {
      paddingHorizontal: isLandscape ? spacing.xl : contentGutter,
      paddingTop: isCompactPortrait ? 6 : spacing.sm,
      paddingBottom: isCompactPortrait ? 6 : spacing.sm,
    },
    selectedRouteCard: {
      minHeight: isCompactPortrait ? 38 : 42,
      marginBottom: isCompactPortrait ? 6 : spacing.sm,
    },
    directionSelector: {
      minHeight: isCompactPortrait ? 44 : 48,
      marginBottom: isCompactPortrait ? 6 : spacing.sm,
    },
    directionOption: {
      minHeight: isCompactPortrait ? 38 : 42,
    },
    startButton: {
      minHeight: isCompactPortrait ? 49 : 53,
    },
  }), [contentGutter, isBalancedPortrait, isCompactPortrait, isLandscape]);
  const mountedRef = useRef(true);
  const lastRoutesFetchRef = useRef(0);
  const searchInitialCountRef = useRef(4);
  const searchTransitionTokenRef = useRef(0);
  const lastSearchAppendAtRef = useRef(0);
  const searchAppendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nearbyLastSuccessAtRef = useRef(0);
  const nearbyPermissionPromptedRef = useRef(false);
  const nearbyRequestRef = useRef<Promise<Record<string, number> | null> | null>(null);
  const nearbyDistancesRef = useRef<Record<string, number>>({});
  const autoSelectedRouteRef = useRef<string | null>(null);
  const preferenceScrollRef = useRef<ScrollView | null>(null);
  const preferenceScrollY = useRef(new Animated.Value(0)).current;
  const assignmentRequestRef = useRef(0);
  const reliefAbortRef = useRef<AbortController | null>(null);
  const initialRoutesRef = useRef<RouteInfo[] | null | undefined>(undefined);
  if (initialRoutesRef.current === undefined) {
    initialRoutesRef.current = apiService.getPreloadedRoutes();
  }

  const {
    ready: preferencesReady,
    preferences,
    toggleFavorite,
    recordRecent,
  } = usePreferences();
  const { language, t } = useI18n();

  const [routes, setRoutes] = useState<RouteInfo[]>(() => initialRoutesRef.current ?? []);
  const [selectedRoute, setSelectedRoute] = useState<RouteInfo | null>(null);
  const [directionId, setDirectionId] = useState<0 | 1 | null>(null);
  const [loading, setLoading] = useState(initialRoutesRef.current === null);
  const [isConnected, setIsConnected] = useState(Boolean(initialRoutesRef.current?.length));
  const [nearbyDistances, setNearbyDistances] = useState<Record<string, number>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [isClosingSearch, setIsClosingSearch] = useState(false);
  const [searchVisibleCount, setSearchVisibleCount] = useState(4);
  const [preferenceView, setPreferenceView] = useState<PreferenceView>('recent');
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [manualVehicle, setManualVehicle] = useState('');
  const [manualVehicleError, setManualVehicleError] = useState<
    'not_found' | 'wrong_direction' | 'unavailable' | null
  >(null);
  const [isCheckingManualVehicle, setIsCheckingManualVehicle] = useState(false);
  const [upcomingTrips, setUpcomingTrips] = useState<UpcomingTrip[]>([]);
  const [isLoadingTrips, setIsLoadingTrips] = useState(false);
  const [isLoadingPastDepartures, setIsLoadingPastDepartures] = useState(false);
  const [hasLoadedPastDepartures, setHasLoadedPastDepartures] = useState(false);
  const [assignmentMode, setAssignmentMode] = useState<AssignmentMode>('departures');
  const [reliefCandidate, setReliefCandidate] = useState<ReliefCandidate | null>(null);
  const [nearbyReliefStopName, setNearbyReliefStopName] = useState('');
  const [discoveryViewportHeight, setDiscoveryViewportHeight] = useState(0);
  const [resultsBlockTop, setResultsBlockTop] = useState(0);
  const [routesHeadingBottom, setRoutesHeadingBottom] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);

  const loadRoutes = useCallback(async (showLoading = false) => {
    if (showLoading && mountedRef.current) setLoading(true);

    try {
      const data = await apiService.fetchRoutes();
      if (!mountedRef.current) return;
      setRoutes(data);
      setIsConnected(data.length > 0);
      lastRoutesFetchRef.current = Date.now();
      setSelectedRoute((current) => current
        ? data.find((candidate) => candidate.route_id === current.route_id) ?? null
        : null);
    } catch {
      if (mountedRef.current) setIsConnected(false);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const fetchNearbyDistances = useCallback(() => {
    if (Date.now() - nearbyLastSuccessAtRef.current < NEARBY_REFRESH_MS) {
      return Promise.resolve(null);
    }
    if (nearbyRequestRef.current) return nearbyRequestRef.current;

    let request: Promise<Record<string, number> | null>;
    request = (async () => {
      let permission = await Location.getForegroundPermissionsAsync();
      if (
        permission.status !== 'granted'
        && permission.canAskAgain
        && !nearbyPermissionPromptedRef.current
      ) {
        nearbyPermissionPromptedRef.current = true;
        permission = await Location.requestForegroundPermissionsAsync();
      }
      if (permission.status !== 'granted') return null;

      const lastKnown = await Location.getLastKnownPositionAsync({
        maxAge: RECENT_LOCATION_MAX_AGE_MS,
        requiredAccuracy: 1000,
      });
      let position = lastKnown;

      if (!position || Date.now() - position.timestamp > RECENT_LOCATION_MAX_AGE_MS) {
        try {
          position = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
        } catch (error) {
          if (!lastKnown) throw error;
          position = lastKnown;
        }
      }

      const distances = await apiService.fetchNearbyRoutes(
        position.coords.latitude,
        position.coords.longitude,
        40,
      );
      nearbyLastSuccessAtRef.current = Date.now();
      return Object.fromEntries(
        distances.map((item) => [item.route_id, item.distance_meters]),
      );
    })()
      .catch(() => null)
      .finally(() => {
        if (nearbyRequestRef.current === request) nearbyRequestRef.current = null;
      });

    nearbyRequestRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadRoutes(initialRoutesRef.current === null);

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - lastRoutesFetchRef.current > FOREGROUND_REFRESH_MS) {
        void loadRoutes(false);
      }
    });

    return () => {
      mountedRef.current = false;
      assignmentRequestRef.current += 1;
      reliefAbortRef.current?.abort();
      subscription.remove();
    };
  }, [loadRoutes]);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active) setReduceMotion(enabled);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion,
    );

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => () => {
    if (searchAppendTimerRef.current) {
      clearTimeout(searchAppendTimerRef.current);
      searchAppendTimerRef.current = null;
    }
  }, []);

  useFocusEffect(useCallback(() => {
    if (routes.length === 0) return undefined;

    let active = true;
    const refreshNearbyRoutes = () => {
      void fetchNearbyDistances().then((nextDistances) => {
        if (
          !nextDistances
          || !mountedRef.current
          || haveSameDistances(nearbyDistancesRef.current, nextDistances)
        ) return;

        if (active && !reduceMotion) {
          LayoutAnimation.configureNext({
            duration: 240,
            update: { type: LayoutAnimation.Types.easeInEaseOut },
          });
        }
        nearbyDistancesRef.current = nextDistances;
        setNearbyDistances(nextDistances);
      });
    };

    refreshNearbyRoutes();
    const foregroundSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshNearbyRoutes();
    });

    return () => {
      active = false;
      foregroundSubscription.remove();
    };
  }, [fetchNearbyDistances, reduceMotion, routes.length]));

  useEffect(() => {
    const requestedRouteId = route.params?.selectedRouteId;
    if (!requestedRouteId || routes.length === 0) return;

    const requestedRoute = routes.find((candidate) => candidate.route_id === requestedRouteId);
    if (requestedRoute) {
      autoSelectedRouteRef.current = null;
      setSelectedRoute(requestedRoute);
      setDirectionId(null);
    }
    navigation.setParams({ selectedRouteId: undefined });
  }, [navigation, route.params?.selectedRouteId, routes]);

  useEffect(() => {
    if (
      !preferencesReady
      || selectedRoute
      || routes.length === 0
      || route.params?.selectedRouteId
    ) return;

    const homeRoutes = routes.filter(
      (candidate) => preferences.homeAgencyIds.includes(getAgencyFilter(candidate)),
    );
    if (!homeRoutes.length) return;

    const recent = preferences.recentRoutes.find((item) =>
      homeRoutes.some((candidate) => candidate.route_id === item.routeId));
    const favoriteId = preferences.favoriteRouteIds.find((id) =>
      homeRoutes.some((candidate) => candidate.route_id === id));
    const initialRoute = homeRoutes.find((candidate) => candidate.route_id === recent?.routeId)
      ?? homeRoutes.find((candidate) => candidate.route_id === favoriteId)
      ?? homeRoutes[0];

    autoSelectedRouteRef.current = recent || favoriteId ? null : initialRoute.route_id;
    setSelectedRoute(initialRoute);
    if (recent?.routeId === initialRoute.route_id) setDirectionId(recent.directionId);
  }, [preferences, preferencesReady, route.params?.selectedRouteId, routes, selectedRoute]);

  const directionNames = useMemo(
    () => getDirectionNames(selectedRoute, language),
    [language, selectedRoute],
  );
  const favoriteIds = useMemo(
    () => new Set(preferences.favoriteRouteIds),
    [preferences.favoriteRouteIds],
  );

  const filteredRoutes = useMemo(() => {
    const matches = routes
      .filter((item) => routeMatchesSearch(item, searchQuery))
      .filter((item) => preferences.homeAgencyIds.includes(getAgencyFilter(item)));

    if (searchQuery.trim()) return matches;

    return matches
      .map((item, index) => ({ item, index, distance: routeNearbyDistance(item, nearbyDistances) }))
      .sort((a, b) => {
        const aNearby = Number.isFinite(a.distance);
        const bNearby = Number.isFinite(b.distance);
        if (aNearby && bNearby && a.distance !== b.distance) return a.distance - b.distance;
        if (aNearby !== bNearby) return aNearby ? -1 : 1;
        return a.index - b.index;
      })
      .map(({ item }) => item);
  }, [nearbyDistances, preferences.homeAgencyIds, routes, searchQuery]);

  useEffect(() => {
    const autoSelectedRouteId = autoSelectedRouteRef.current;
    if (!autoSelectedRouteId || Object.keys(nearbyDistances).length === 0) return;
    if (selectedRoute?.route_id !== autoSelectedRouteId || directionId !== null) {
      autoSelectedRouteRef.current = null;
      return;
    }

    const nearestRoute = routes
      .filter((candidate) => preferences.homeAgencyIds.includes(getAgencyFilter(candidate)))
      .reduce<{
      candidate: RouteInfo | null;
      distance: number;
    }>((nearest, candidate) => {
      const distance = routeNearbyDistance(candidate, nearbyDistances);
      return distance < nearest.distance ? { candidate, distance } : nearest;
    }, { candidate: null, distance: Number.POSITIVE_INFINITY }).candidate;

    autoSelectedRouteRef.current = null;
    if (nearestRoute && nearestRoute.route_id !== selectedRoute.route_id) {
      setSelectedRoute(nearestRoute);
    }
  }, [directionId, nearbyDistances, preferences.homeAgencyIds, routes, selectedRoute]);

  const preferenceRoutes = useMemo<PreferenceRoute[]>(() => {
    const byId = new Map(routes.map((item) => [item.route_id, item]));

    if (preferenceView === 'favorite') {
      return preferences.favoriteRouteIds
        .map((routeId) => byId.get(routeId))
        .filter((item): item is RouteInfo => Boolean(item))
        .filter((item) => preferences.homeAgencyIds.includes(getAgencyFilter(item)))
        .map((item) => ({ route: item }));
    }

    return preferences.recentRoutes
      .flatMap((recent): PreferenceRoute[] => {
        const item = byId.get(recent.routeId);
        return item && preferences.homeAgencyIds.includes(getAgencyFilter(item))
          ? [{ route: item, recent }]
          : [];
      })
      .slice(0, MAX_RECENT_ROUTES);
  }, [preferenceView, preferences, routes]);

  const defaultVisiblePreferenceRows = isLandscape
    ? PREFERENCE_ROWS_LANDSCAPE
    : (isCompactPortrait
      ? 2
      : isBalancedPortrait
        ? 3
        : PREFERENCE_ROWS_PORTRAIT);
  const responsiveVisiblePreferenceRows = fontScale > 1.35
    ? Math.min(2, defaultVisiblePreferenceRows)
    : defaultVisiblePreferenceRows;
  const visiblePreferenceRows = preferenceView === 'recent'
    ? (fontScale > 1.35 ? 2 : RECENT_PREVIEW_ROWS)
    : responsiveVisiblePreferenceRows;
  const preferenceViewportHeight = Math.min(
    preferenceRoutes.length,
    visiblePreferenceRows,
  ) * preferenceRowHeight;
  const preferenceScrollEnabled = preferenceRoutes.length > visiblePreferenceRows;

  const minimumVisibleRoutes = isLandscape ? 3 : (isCompactPortrait ? 2 : 3);
  const routeListTop = resultsBlockTop + routesHeadingBottom;
  const measuredVisibleRoutes = discoveryViewportHeight > 0 && routeListTop > 0
    ? Math.floor((discoveryViewportHeight - routeListTop - spacing.md) / routeRowHeight)
    : minimumVisibleRoutes;
  const maxVisibleRoutes = Math.max(
    minimumVisibleRoutes,
    Math.min(isLandscape ? 6 : 8, measuredVisibleRoutes),
  );
  const displayedRoutes = filteredRoutes.slice(
    0,
    isSearchMode
      ? searchVisibleCount
      : (isClosingSearch ? searchInitialCountRef.current : maxVisibleRoutes),
  );

  const selectRoute = useCallback((item: RouteInfo, preferredDirection?: 0 | 1) => {
    autoSelectedRouteRef.current = null;
    setSelectedRoute(item);
    setDirectionId(preferredDirection ?? null);
  }, []);

  const selectPreferenceView = useCallback((next: PreferenceView) => {
    if (next === preferenceView) return;
    preferenceScrollY.setValue(0);
    preferenceScrollRef.current?.scrollTo({ y: 0, animated: false });
    if (!reduceMotion) {
      LayoutAnimation.configureNext({
        duration: 180,
        create: {
          type: LayoutAnimation.Types.easeInEaseOut,
          property: LayoutAnimation.Properties.opacity,
        },
        update: { type: LayoutAnimation.Types.easeInEaseOut },
      });
    }
    setPreferenceView(next);
  }, [preferenceScrollY, preferenceView, reduceMotion]);

  const openSearch = useCallback(() => {
    if (isSearchMode) return;

    const initialCount = Math.min(SEARCH_RESULT_LIMIT, maxVisibleRoutes);
    const transitionToken = searchTransitionTokenRef.current + 1;
    searchTransitionTokenRef.current = transitionToken;
    searchInitialCountRef.current = initialCount;
    lastSearchAppendAtRef.current = 0;
    if (searchAppendTimerRef.current) clearTimeout(searchAppendTimerRef.current);
    setIsClosingSearch(false);
    setSearchVisibleCount(initialCount);

    if (reduceMotion) {
      setSearchVisibleCount(Math.min(
        SEARCH_RESULT_LIMIT,
        initialCount + SEARCH_INITIAL_EXTRA_RESULTS,
      ));
      setIsSearchMode(true);
      return;
    }

    configureSearchLayout(SEARCH_OPEN_DURATION_MS);
    searchAppendTimerRef.current = setTimeout(() => {
      searchAppendTimerRef.current = null;
      if (
        !mountedRef.current
        || searchTransitionTokenRef.current !== transitionToken
      ) return;

      LayoutAnimation.configureNext({
        duration: SEARCH_APPEND_REVEAL_DURATION_MS,
        create: {
          type: LayoutAnimation.Types.easeInEaseOut,
          property: LayoutAnimation.Properties.opacity,
        },
      });
      setSearchVisibleCount((current) => Math.min(
        SEARCH_RESULT_LIMIT,
        Math.max(current, searchInitialCountRef.current + SEARCH_INITIAL_EXTRA_RESULTS),
      ));
    }, SEARCH_OPEN_DURATION_MS);
    setIsSearchMode(true);
  }, [isSearchMode, maxVisibleRoutes, reduceMotion]);

  const closeSearch = useCallback(() => {
    Keyboard.dismiss();
    const transitionToken = searchTransitionTokenRef.current + 1;
    searchTransitionTokenRef.current = transitionToken;
    lastSearchAppendAtRef.current = 0;
    if (searchAppendTimerRef.current) {
      clearTimeout(searchAppendTimerRef.current);
      searchAppendTimerRef.current = null;
    }
    setIsClosingSearch(true);
    setSearchVisibleCount(searchInitialCountRef.current);

    if (reduceMotion) {
      setSearchQuery('');
      setIsSearchMode(false);
      requestAnimationFrame(() => {
        if (searchTransitionTokenRef.current === transitionToken) {
          setIsClosingSearch(false);
        }
      });
      return;
    }

    configureSearchLayout(SEARCH_CLOSE_DURATION_MS, () => {
      if (
        mountedRef.current
        && searchTransitionTokenRef.current === transitionToken
      ) setIsClosingSearch(false);
    }, true);
    setSearchQuery('');
    setIsSearchMode(false);
  }, [reduceMotion]);

  const handleDiscoveryScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!isSearchMode) return;

    const targetCount = Math.min(SEARCH_RESULT_LIMIT, filteredRoutes.length);
    if (searchVisibleCount >= targetCount) return;

    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const remaining = contentSize.height - layoutMeasurement.height - contentOffset.y;
    if (remaining > routeRowHeight * 2) return;

    const now = Date.now();
    if (now - lastSearchAppendAtRef.current < SEARCH_APPEND_THROTTLE_MS) return;
    lastSearchAppendAtRef.current = now;
    setSearchVisibleCount((current) => Math.min(
      targetCount,
      current + SEARCH_APPEND_BATCH_SIZE,
    ));
  }, [filteredRoutes.length, isSearchMode, routeRowHeight, searchVisibleCount]);

  const handleDiscoveryLayout = useCallback((event: LayoutChangeEvent) => {
    setDiscoveryViewportHeight(event.nativeEvent.layout.height);
  }, []);

  const handleRoutesHeadingLayout = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    setRoutesHeadingBottom(y + height + spacing.xs);
  }, []);

  const navigateToMap = useCallback((
    vehicleId?: string,
    tripId?: string,
    scheduledDepartureEpoch?: number,
  ) => {
    if (!selectedRoute || directionId === null) return;

    telemetry.capture('route_started', {
      assigned: Boolean(vehicleId || tripId),
      direction: directionId,
      source: 'home',
    });
    recordRecent(selectedRoute.route_id, directionId);
    navigation.navigate('Map', {
      routeId: selectedRoute.route_id,
      directionId,
      ...(vehicleId ? { assignedVehicle: vehicleId } : {}),
      ...(tripId ? { tripId } : {}),
      ...(Number.isInteger(scheduledDepartureEpoch) ? { scheduledDepartureEpoch } : {}),
      directionLabel: directionId === 0 ? directionNames.anada : directionNames.tornada,
    });
  }, [directionId, directionNames, navigation, recordRecent, selectedRoute]);

  const handleStartDriving = useCallback(() => {
    if (!selectedRoute || directionId === null || isLoadingTrips) return;

    const routeSnapshot = selectedRoute;
    const directionSnapshot = directionId;
    const requestId = assignmentRequestRef.current + 1;
    assignmentRequestRef.current = requestId;
    reliefAbortRef.current?.abort();
    const controller = new AbortController();
    reliefAbortRef.current = controller;

    telemetry.capture('route_selected', { direction: directionId, source: 'home' });
    setUpcomingTrips([]);
    setIsLoadingTrips(true);
    setIsLoadingPastDepartures(false);
    setHasLoadedPastDepartures(false);
    setAssignmentMode('detecting');
    setReliefCandidate(null);
    setNearbyReliefStopName('');
    setShowAssignModal(true);

    void apiService.fetchUpcomingTrips(routeSnapshot.route_id, directionSnapshot)
      .then((trips) => {
        if (mountedRef.current && assignmentRequestRef.current === requestId) {
          setUpcomingTrips(trips);
        }
      })
      .catch(() => {
        if (mountedRef.current && assignmentRequestRef.current === requestId) {
          setUpcomingTrips([]);
        }
      })
      .finally(() => {
        if (mountedRef.current && assignmentRequestRef.current === requestId) {
          setIsLoadingTrips(false);
        }
      });

    const fallBackToDepartures = () => {
      if (mountedRef.current && assignmentRequestRef.current === requestId) {
        setReliefCandidate(null);
        setAssignmentMode('departures');
      }
    };

    void (async () => {
      try {
        let permission = await Location.getForegroundPermissionsAsync();
        if (permission.status !== 'granted' && permission.canAskAgain) {
          permission = await Location.requestForegroundPermissionsAsync();
        }
        if (permission.status !== 'granted' || assignmentRequestRef.current !== requestId) {
          fallBackToDepartures();
          return;
        }

        let position = await Location.getLastKnownPositionAsync({
          maxAge: RELIEF_LOCATION_MAX_AGE_MS,
          requiredAccuracy: RELIEF_LOCATION_MAX_ACCURACY_METERS,
        });
        const lastKnownAccuracy = position?.coords.accuracy ?? Number.POSITIVE_INFINITY;
        if (
          !position
          || Date.now() - position.timestamp > RELIEF_LOCATION_MAX_AGE_MS
          || lastKnownAccuracy > RELIEF_LOCATION_MAX_ACCURACY_METERS
        ) {
          position = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.High,
          });
        }
        if (assignmentRequestRef.current !== requestId || controller.signal.aborted) return;

        const stopsPayload = await apiService.fetchRouteStops(
          routeSnapshot.route_id,
          directionSnapshot,
          undefined,
          controller.signal,
        );
        const stops = parseReliefStopsGeoJson(stopsPayload);
        const accuracyMeters = position.coords.accuracy;
        if (!stops || accuracyMeters === null) {
          fallBackToDepartures();
          return;
        }

        const nearbyStop = selectNearbyReliefStop(stops, {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters,
          observedAtEpochMs: position.timestamp,
        }, {
          nowEpochMs: Date.now(),
          maximumLocationAgeMs: RELIEF_LOCATION_MAX_AGE_MS,
          maximumAccuracyMeters: RELIEF_LOCATION_MAX_ACCURACY_METERS,
        });
        if (!nearbyStop || nearbyStop.terminal === 'origin' || nearbyStop.terminal === 'both') {
          fallBackToDepartures();
          return;
        }

        setNearbyReliefStopName(nearbyStop.stopName);
        const candidates = await apiService.fetchReliefCandidates(
          routeSnapshot.route_id,
          directionSnapshot,
          nearbyStop.stopId,
          controller.signal,
        );
        if (assignmentRequestRef.current !== requestId || controller.signal.aborted) return;

        const routeIds = Array.from(new Set([
          routeSnapshot.route_id,
          ...(routeSnapshot.route_ids ?? []),
        ]));
        const candidate = selectReliefCandidate(candidates, {
          stopId: nearbyStop.stopId,
          directionId: directionSnapshot,
          routeIds,
          nowEpochSeconds: Math.floor(Date.now() / 1000),
        });
        if (!candidate) {
          fallBackToDepartures();
          return;
        }

        setReliefCandidate(candidate);
        setAssignmentMode('candidate');
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          fallBackToDepartures();
        }
      }
    })();
  }, [directionId, isLoadingTrips, selectedRoute]);

  const closeAssignmentModal = useCallback(() => {
    assignmentRequestRef.current += 1;
    reliefAbortRef.current?.abort();
    reliefAbortRef.current = null;
    setShowAssignModal(false);
    setIsLoadingTrips(false);
    setManualVehicle('');
    setManualVehicleError(null);
    setIsCheckingManualVehicle(false);
    setIsLoadingPastDepartures(false);
    setHasLoadedPastDepartures(false);
  }, []);

  const handleConfirmAssignment = useCallback((
    vehicleId: string,
    tripId?: string,
    scheduledDepartureEpoch?: number,
  ) => {
    closeAssignmentModal();
    navigateToMap(sanitizeVehicleId(vehicleId) || undefined, tripId, scheduledDepartureEpoch);
  }, [closeAssignmentModal, navigateToMap]);

  const handleManualVehicleSync = useCallback(() => {
    if (!selectedRoute || directionId === null) return;

    const requestedVehicleId = sanitizeVehicleId(manualVehicle);
    if (!requestedVehicleId) return;

    const routeSnapshot = selectedRoute;
    const directionSnapshot = directionId;
    const routeIds = Array.from(new Set([
      routeSnapshot.route_id,
      ...(routeSnapshot.route_ids ?? []),
    ]));

    setIsCheckingManualVehicle(true);
    setManualVehicleError(null);

    void Promise.all([
      Promise.all(routeIds.map((routeId) => apiService.fetchRouteVehicles(routeId))),
      Promise.all(routeIds.map((routeId) => apiService.fetchRouteTripUpdates(routeId))),
    ]).then(([vehicleGroups, tripGroups]) => {
      if (!mountedRef.current) return;

      const vehicles = vehicleGroups.flat() as VehiclePosition[];
      const updates = tripGroups.flat() as RTTripUpdate[];
      const matchingVehicles = vehicles.filter((vehicle) => (
        matchesVehicleNumber(vehicle.vehicle_id, requestedVehicleId)
      ));
      const directionFor = (vehicle: VehiclePosition) => {
        if (vehicle.direction_id !== null) return vehicle.direction_id;
        const update = updates.find((candidate) => (
          candidate.trip_id === vehicle.trip_id
          || (vehicle.vehicle_id && candidate.vehicle_id === vehicle.vehicle_id)
        ));
        return update?.direction_id ?? null;
      };
      const matchedVehicle = matchingVehicles.find((vehicle) => (
        directionFor(vehicle) === directionSnapshot
      ));

      if (!matchedVehicle) {
        setManualVehicleError(matchingVehicles.length ? 'wrong_direction' : 'not_found');
        return;
      }

      const matchingUpdate = updates.find((candidate) => (
        candidate.trip_id === matchedVehicle.trip_id
        || (candidate.vehicle_id && candidate.vehicle_id === matchedVehicle.vehicle_id)
      ));
      handleConfirmAssignment(matchedVehicle.vehicle_id, matchedVehicle.trip_id || matchingUpdate?.trip_id);
    }).catch(() => {
      if (mountedRef.current) setManualVehicleError('unavailable');
    }).finally(() => {
      if (mountedRef.current) setIsCheckingManualVehicle(false);
    });
  }, [directionId, handleConfirmAssignment, manualVehicle, selectedRoute]);

  const handleLoadPastDepartures = useCallback(() => {
    if (!selectedRoute || directionId === null || isLoadingPastDepartures) return;

    const routeSnapshot = selectedRoute;
    const directionSnapshot = directionId;
    setIsLoadingPastDepartures(true);
    void apiService.fetchUpcomingTrips(
      routeSnapshot.route_id,
      directionSnapshot,
      undefined,
      120,
    ).then((pastTrips) => {
      if (!mountedRef.current) return;
      const pastCutoffEpoch = Math.floor(Date.now() / 1000) - 5 * 60;
      if (pastTrips.some((trip) => trip.scheduled_epoch < pastCutoffEpoch)) {
        setHasLoadedPastDepartures(true);
      }
      setUpcomingTrips((currentTrips) => {
        const ids = new Set(currentTrips.map((trip) => trip.trip_id));
        const uniquePastTrips = pastTrips.filter((trip) => (
          trip.scheduled_epoch < pastCutoffEpoch && !ids.has(trip.trip_id)
        ));
        return [...uniquePastTrips, ...currentTrips];
      });
    }).catch(() => {
      // Keep the button available when the optional history request fails.
    }).finally(() => {
      if (mountedRef.current) setIsLoadingPastDepartures(false);
    });
  }, [directionId, isLoadingPastDepartures, selectedRoute]);

  const renderRouteRow = (item: RouteInfo) => {
    const selected = selectedRoute?.route_id === item.route_id;
    const favorite = favoriteIds.has(item.route_id);
    const routeColor = safeHexColor(item.route_color, colors.primary);

    return (
      <View
        key={item.route_id}
        style={[
          styles.routeRow,
          responsiveType.routeRow,
          selected && styles.routeRowSelected,
          {
            backgroundColor: routePastelColor(item.route_color, selected ? 0.135 : 0.075),
            borderLeftColor: selected ? routeColor : colors.border,
          },
        ]}
      >
        <TouchableOpacity
          style={[styles.routeMain, responsiveType.routeMain]}
          onPress={() => {
            selectRoute(item);
            if (isSearchMode) closeSearch();
          }}
          activeOpacity={0.82}
          accessibilityRole="button"
          accessibilityState={{ selected }}
          accessibilityLabel={t('home.lineA11y', {
            line: item.route_short_name,
            name: getRouteTitle(item, language),
          })}
        >
          <View style={[
            styles.routeBadge,
            responsiveType.routeBadge,
            { backgroundColor: safeHexColor(item.route_color, colors.primary) },
          ]}>
            <Text style={[
              styles.routeBadgeText,
              responsiveType.routeBadgeText,
              { color: safeHexColor(item.route_text_color, colors.white) },
            ]}>{item.route_short_name || 'Bus'}</Text>
          </View>
          <View style={styles.routeCopy}>
            <Text style={[styles.routeName, responsiveType.routeName]} numberOfLines={1}>
              {getRouteTitle(item, language)}
            </Text>
            <Text style={[styles.routeMeta, responsiveType.routeMeta]}>
              {getAgencyLabel(getAgencyFilter(item), language)}
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.starButton, favorite && styles.starButtonActive]}
          onPress={() => toggleFavorite(item.route_id)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityState={{ selected: favorite }}
          accessibilityLabel={t(favorite ? 'home.removeFavorite' : 'home.addFavorite', {
            line: item.route_short_name,
          })}
        >
          <MaterialCommunityIcons
            name={favorite ? 'star' : 'star-outline'}
            size={20}
            color={favorite ? colors.primary : colors.transitDark}
          />
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'right', 'bottom', 'left']}>
      <StatusBar style="dark" />
      <View style={styles.animatedContent}>
      <View style={[styles.content, isLandscape && styles.contentLandscape]}>
        <ScrollView
          style={styles.discoveryPane}
          contentContainerStyle={[
            styles.discoveryContent,
            responsiveLayout.discoveryContent,
            isLandscape && styles.discoveryContentLandscape,
            isSearchMode && styles.discoveryContentSearch,
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onScroll={handleDiscoveryScroll}
          scrollEventThrottle={64}
          onLayout={handleDiscoveryLayout}
        >
          {!isSearchMode ? (
            <View style={styles.liveBar}>
              <TouchableOpacity
                style={styles.settingsButton}
                onPress={() => navigation.navigate('Settings')}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('home.settings')}
              >
                <MaterialCommunityIcons name="tune-variant" size={15} color={colors.primary} />
              </TouchableOpacity>
              <View style={[styles.connectionBadge, !isConnected && styles.connectionBadgeOffline]}>
                <View style={[styles.connectionDot, { backgroundColor: isConnected ? colors.success : colors.danger }]} />
                <Text style={[styles.connectionText, responsiveType.connectionText]}>
                  {t(isConnected ? 'home.live' : 'home.offline')}
                </Text>
              </View>
            </View>
          ) : null}

          <View style={[styles.journeyBlock, isSearchMode && styles.journeyBlockSearch]}>
            {!isSearchMode ? (
              <>
                <View
                  style={[styles.journeyRail, responsiveLayout.journeyRail]}
                  pointerEvents="none"
                />

                <View style={[styles.heroPanel, responsiveLayout.heroPanel]}>
                  <View style={styles.heroCopy}>
                    <Text style={[styles.heroTitle, responsiveLayout.heroTitle]}>
                      {t('home.hero')}
                    </Text>
                    <Text style={[styles.heroSubtitle, responsiveType.heroSubtitle]}>{t('home.subtitle')}</Text>
                  </View>
                  <View style={[styles.heroBusBadge, responsiveLayout.heroBusBadge]}>
                    <MaterialCommunityIcons name="bus" size={25} color={colors.primary} />
                  </View>
                </View>
              </>
            ) : null}

            <View style={[
              styles.searchShell,
              responsiveLayout.searchShell,
              isSearchMode && styles.searchShellFocused,
            ]}>
              <MaterialCommunityIcons name="magnify" size={18} color={colors.inkSoft} />
              <TextInput
                style={[styles.searchInput, responsiveType.searchInput]}
                value={searchQuery}
                onChangeText={setSearchQuery}
                onFocus={openSearch}
                placeholder={t('home.searchPlaceholder')}
                placeholderTextColor={colors.subtle}
                maxLength={80}
                returnKeyType="search"
                autoCorrect={false}
                accessibilityLabel={t('home.searchA11y')}
              />
              {isSearchMode || searchQuery ? (
                <TouchableOpacity
                  onPress={closeSearch}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('home.closeSearch')}
                >
                  <MaterialCommunityIcons name="close-circle" size={18} color={colors.primary} />
                </TouchableOpacity>
              ) : null}
            </View>

            {!isSearchMode ? (
              <>
                <View style={[styles.sectionHeading, responsiveLayout.sectionHeading]}>
                  <Text style={[styles.quickTitle, responsiveType.quickTitle]}>{t('home.quick')}</Text>
                  <View style={styles.headingRule} />
                  <TouchableOpacity
                    style={[styles.preferenceMode, preferenceView === 'recent' && styles.preferenceModeActive]}
                    onPress={() => selectPreferenceView('recent')}
                    hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: preferenceView === 'recent' }}
                  >
                    <Text style={[
                      styles.preferenceModeText,
                      responsiveType.preferenceModeText,
                      preferenceView === 'recent' && styles.preferenceModeTextActive,
                    ]}>{t('home.recents', {
                      count: Math.min(MAX_RECENT_ROUTES, preferences.recentRoutes.length),
                    })}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.preferenceMode, preferenceView === 'favorite' && styles.preferenceModeActive]}
                    onPress={() => selectPreferenceView('favorite')}
                    hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: preferenceView === 'favorite' }}
                  >
                    <Text style={[
                      styles.preferenceModeText,
                      responsiveType.preferenceModeText,
                      preferenceView === 'favorite' && styles.preferenceModeTextActive,
                    ]}>{t('home.favorites', { count: preferences.favoriteRouteIds.length })}</Text>
                  </TouchableOpacity>
                </View>

                {preferenceRoutes.length > 0 ? (
                  <View style={[styles.preferenceViewport, { height: preferenceViewportHeight }]}>
                    <Animated.ScrollView
                      ref={preferenceScrollRef}
                      style={styles.preferenceScroller}
                      contentContainerStyle={styles.preferenceList}
                      showsVerticalScrollIndicator={false}
                      scrollEnabled={preferenceScrollEnabled}
                      nestedScrollEnabled
                      directionalLockEnabled
                      snapToInterval={preferenceRowHeight}
                      snapToAlignment="start"
                      decelerationRate="fast"
                      disableIntervalMomentum
                      bounces={false}
                      scrollEventThrottle={16}
                      accessibilityRole="list"
                      accessibilityLabel={t(
                        preferenceView === 'recent' ? 'home.recents' : 'home.favorites',
                        { count: preferenceRoutes.length },
                      )}
                      accessibilityHint={preferenceScrollEnabled
                        ? t('home.preferenceScrollHint')
                        : undefined}
                      onScroll={Animated.event(
                        [{ nativeEvent: { contentOffset: { y: preferenceScrollY } } }],
                        { useNativeDriver: true },
                      )}
                    >
                      {preferenceRoutes.map(({ route: item, recent }, index) => {
                        const selected = selectedRoute?.route_id === item.route_id;
                        const labels = getDirectionNames(item, language);
                        const destination = recent
                          ? (recent.directionId === 0 ? labels.anada : labels.tornada)
                          : getRouteTitle(item, language);
                        const railInputRange = [
                          (index - visiblePreferenceRows) * preferenceRowHeight,
                          (index - visiblePreferenceRows + 1) * preferenceRowHeight,
                          index * preferenceRowHeight,
                          (index + 1) * preferenceRowHeight,
                        ];
                        const animatedRailStyle = reduceMotion ? undefined : {
                          opacity: preferenceScrollY.interpolate({
                            inputRange: railInputRange,
                            outputRange: [0.25, 1, 1, 0.25],
                            extrapolate: 'clamp',
                          }),
                          transform: [{
                            scale: preferenceScrollY.interpolate({
                              inputRange: railInputRange,
                              outputRange: [0.65, 1, 1, 0.65],
                              extrapolate: 'clamp',
                            }),
                          }],
                        };

                        return (
                          <TouchableOpacity
                            key={`${preferenceView}-${item.route_id}`}
                            style={[
                              styles.preferenceRow,
                              responsiveType.preferenceRow,
                              selected && styles.preferenceRowSelected,
                            ]}
                            onPress={() => selectRoute(item, recent?.directionId)}
                            activeOpacity={0.72}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                            accessibilityLabel={t(
                              preferenceView === 'recent' ? 'home.recentA11y' : 'home.favoriteA11y',
                              {
                                line: item.route_short_name,
                                destination,
                                position: index + 1,
                                count: preferenceRoutes.length,
                              },
                            )}
                          >
                            <View style={[
                              styles.quickRouteBadge,
                              responsiveType.quickRouteBadge,
                              { backgroundColor: safeHexColor(item.route_color, colors.primary) },
                            ]}>
                              <Text style={[
                                styles.quickRouteBadgeText,
                                responsiveType.quickRouteBadgeText,
                                { color: safeHexColor(item.route_text_color, colors.white) },
                              ]}>{item.route_short_name || 'Bus'}</Text>
                            </View>
                            <Text
                              style={[
                                styles.preferenceDestination,
                                responsiveType.preferenceDestination,
                                selected && styles.preferenceDestinationSelected,
                              ]}
                              numberOfLines={1}
                            >{destination}</Text>
                            <Text style={[styles.preferenceTime, responsiveType.preferenceTime]} numberOfLines={1}>
                              {recent
                                ? formatRecentTime(recent.usedAt, language)
                                : getAgencyLabel(getAgencyFilter(item), language)}
                            </Text>
                            <Animated.View
                              style={[
                                styles.railStop,
                                selected && styles.railStopSelected,
                                animatedRailStyle,
                              ]}
                            />
                          </TouchableOpacity>
                        );
                      })}
                    </Animated.ScrollView>
                    {preferenceScrollEnabled ? (
                      <LinearGradient
                        pointerEvents="none"
                        colors={['rgba(241, 239, 232, 0)', colors.background]}
                        locations={[0, 1]}
                        style={styles.preferenceFade}
                      />
                    ) : null}
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.preferenceEmpty}
                    onPress={() => preferenceView === 'favorite' && navigation.navigate('Routes')}
                    disabled={preferenceView === 'recent'}
                    accessibilityRole="button"
                  >
                    <MaterialCommunityIcons
                      name={preferenceView === 'recent' ? 'history' : 'star-outline'}
                      size={17}
                      color={colors.primary}
                    />
                    <Text style={styles.preferenceEmptyText} numberOfLines={1}>
                      {t(preferenceView === 'recent' ? 'home.emptyRecents' : 'home.emptyFavorites')}
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            ) : null}
          </View>

          <View
            onLayout={(event) => setResultsBlockTop(event.nativeEvent.layout.y)}
          >
          <View style={styles.routesHeading} onLayout={handleRoutesHeadingLayout}>
            <Text style={[styles.sectionTitle, responsiveType.sectionTitle]}>
              {t(isSearchMode || searchQuery
                ? 'common.results'
                : preferences.homeAgencyIds.length === 1
                  ? 'home.companyLines'
                  : 'home.selectedCompaniesLines', preferences.homeAgencyIds.length === 1
                  ? { company: getAgencyLabel(preferences.homeAgencyIds[0], language) }
                  : undefined)}
            </Text>
            <TouchableOpacity
              style={styles.catalogButton}
              onPress={() => navigation.navigate('Routes')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('home.openAll')}
            >
              <Text style={[styles.catalogButtonText, responsiveType.catalogButtonText]}>{t('home.all')}</Text>
              <MaterialCommunityIcons name="arrow-top-right" size={15} color={colors.primary} />
            </TouchableOpacity>
          </View>

          {loading && routes.length === 0 ? null : displayedRoutes.length === 0 ? (
            <View style={styles.emptyRoutes}>
              <MaterialCommunityIcons name="bus-alert" size={26} color={colors.transitDark} />
              <Text style={styles.emptyRoutesText}>{t('home.noMatches')}</Text>
            </View>
          ) : (
            <View style={styles.routeList}>{displayedRoutes.map(renderRouteRow)}</View>
          )}
          </View>
        </ScrollView>

        {!isSearchMode ? (
          <View style={[
            styles.servicePanel,
            responsiveLayout.servicePanel,
            isLandscape && styles.servicePanelLandscape,
          ]}>
          {selectedRoute ? (
            <View>
              <Text style={[styles.selectedRouteLabel, responsiveType.selectedRouteLabel]}>
                {t('home.selectedRoute')}
              </Text>
              <View
                style={[
                  styles.selectedRouteCard,
                  responsiveLayout.selectedRouteCard,
                  {
                    backgroundColor: routePastelColor(selectedRoute.route_color, 0.11),
                    borderLeftColor: safeHexColor(selectedRoute.route_color, colors.primary),
                  },
                ]}
                accessible
                accessibilityLabel={t('home.selectedRouteA11y', {
                  line: selectedRoute.route_short_name || 'Bus',
                  name: getRouteTitle(selectedRoute, language),
                })}
              >
                <View style={[
                  styles.selectedRouteBadge,
                  { backgroundColor: safeHexColor(selectedRoute.route_color, colors.primary) },
                ]}>
                  <Text style={[
                    styles.selectedRouteBadgeText,
                    { color: safeHexColor(selectedRoute.route_text_color, colors.white) },
                  ]}>{selectedRoute.route_short_name || 'Bus'}</Text>
                </View>
                <View style={styles.selectedRouteCopy}>
                  <Text
                    style={[styles.selectedRouteName, responsiveType.selectedRouteName]}
                    numberOfLines={1}
                  >
                    {getRouteTitle(selectedRoute, language)}
                  </Text>
                  <Text style={[styles.selectedRouteMeta, responsiveType.selectedRouteMeta]}>
                    {getAgencyLabel(getAgencyFilter(selectedRoute), language)}
                  </Text>
                </View>
                <View style={styles.selectedRouteCheck}>
                  <MaterialCommunityIcons name="check" size={15} color={colors.white} />
                </View>
              </View>
            </View>
          ) : null}

          <Text style={[styles.directionLabel, responsiveType.directionLabel]}>{t('home.direction')}</Text>
          <View style={[
            styles.directionSelector,
            responsiveLayout.directionSelector,
            isLandscape && styles.directionSelectorLandscape,
          ]}>
            {([0, 1] as const).map((value) => {
              const label = value === 0 ? directionNames.anada : directionNames.tornada;
              const selected = directionId === value;
              return (
                <TouchableOpacity
                  key={value}
                  style={[
                    styles.directionOption,
                    responsiveLayout.directionOption,
                    selected && styles.directionOptionSelected,
                  ]}
                  onPress={() => {
                    autoSelectedRouteRef.current = null;
                    setDirectionId(value);
                  }}
                  disabled={!selectedRoute}
                  activeOpacity={0.82}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled: !selectedRoute }}
                >
                  <View style={[styles.directionNumber, selected && styles.directionNumberSelected]}>
                    <Text style={[
                      styles.directionNumberText,
                      responsiveType.directionNumberText,
                      selected && styles.directionNumberTextSelected,
                    ]}>
                      {value + 1}
                    </Text>
                  </View>
                  <Text style={[
                    styles.directionText,
                    responsiveType.directionText,
                    selected && styles.directionTextSelected,
                  ]} numberOfLines={2}>
                    {label || t('home.chooseLine')}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            style={[
              styles.startButton,
              responsiveLayout.startButton,
              (!selectedRoute || directionId === null) && styles.startButtonDisabled,
            ]}
            disabled={!selectedRoute || directionId === null || isLoadingTrips}
            onPress={handleStartDriving}
            activeOpacity={0.88}
            accessibilityRole="button"
            accessibilityLabel={t('home.start')}
          >
            <MaterialCommunityIcons name="bus-marker" size={22} color={colors.white} />
            <View style={styles.startButtonCopy}>
              <Text style={[styles.startButtonText, responsiveType.startButtonText]}>{t('home.start')}</Text>
              <Text style={[styles.startButtonMeta, responsiveType.startButtonMeta]} numberOfLines={1}>
                {selectedRoute && directionId !== null
                  ? `${selectedRoute.route_short_name} · ${directionId === 0 ? directionNames.anada : directionNames.tornada}`
                  : t('home.pendingSelection')}
              </Text>
            </View>
            <MaterialCommunityIcons name="arrow-right" size={21} color={colors.white} />
          </TouchableOpacity>
          </View>
        ) : null}
      </View>

      <ServiceAssignmentModal
        visible={showAssignModal}
        isLandscape={isLandscape}
        insets={insets}
        selectedRoute={selectedRoute}
        upcomingTrips={upcomingTrips}
        mode={assignmentMode}
        candidate={reliefCandidate}
        nearbyStopName={nearbyReliefStopName}
        loading={isLoadingTrips}
        isLoadingPastDepartures={isLoadingPastDepartures}
        hasLoadedPastDepartures={hasLoadedPastDepartures}
        manualVehicle={manualVehicle}
        manualVehicleError={manualVehicleError}
        isCheckingManualVehicle={isCheckingManualVehicle}
        onManualVehicleChange={(value) => {
          setManualVehicle(sanitizeVehicleId(value));
          setManualVehicleError(null);
        }}
        onManualVehicleSync={handleManualVehicleSync}
        onLoadPastDepartures={handleLoadPastDepartures}
        onClose={closeAssignmentModal}
        onConfirm={handleConfirmAssignment}
        onChooseDeparture={() => {
          reliefAbortRef.current?.abort();
          reliefAbortRef.current = null;
          setReliefCandidate(null);
          setAssignmentMode('departures');
        }}
        onSkip={() => {
          closeAssignmentModal();
          navigateToMap();
        }}
      />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  animatedContent: { flex: 1 },
  content: { flex: 1 },
  contentLandscape: {
    flexDirection: 'row',
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  discoveryPane: { flex: 1, minWidth: 0 },
  discoveryContent: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
  },
  discoveryContentLandscape: { paddingHorizontal: 0, paddingBottom: spacing.sm },
  discoveryContentSearch: { paddingTop: spacing.sm, paddingBottom: spacing.xl },
  liveBar: {
    minHeight: 25,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  settingsButton: {
    width: 25,
    height: 25,
    borderRadius: 13,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateY: -4 }],
  },
  onboardingScreen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  onboardingContent: {
    flex: 1,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    padding: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  onboardingBody: {
    width: '100%',
    alignItems: 'center',
  },
  welcomeIcon: {
    width: 48,
    height: 48,
    marginBottom: spacing.md,
    borderRadius: 24,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  welcomeTitle: {
    fontFamily: fonts.display,
    color: colors.ink,
    fontSize: 24,
    lineHeight: 29,
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  welcomeSubtitle: {
    ...typography.body,
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  welcomeAgencyGrid: {
    marginTop: spacing.xl,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignSelf: 'stretch',
    gap: spacing.sm,
  },
  welcomeLanguageGrid: { width: '100%', maxWidth: 360, alignSelf: 'center' },
  welcomeAgencyOption: {
    width: '31%',
    flexShrink: 0,
    aspectRatio: 1,
    minHeight: 100,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.primaryWash,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  welcomeAgencyOptionSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  welcomeLanguageOption: { width: '48%' },
  welcomeAgencyText: { ...typography.control, color: colors.ink, fontSize: 13, lineHeight: 17, textAlign: 'center' },
  welcomeAgencyTextSelected: { color: colors.white },
  welcomeAgencyCheck: { position: 'absolute', top: 8, right: 8 },
  welcomeContinueButton: {
    minHeight: 52,
    width: '100%',
    maxWidth: 360,
    alignSelf: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  welcomeContinueButtonDisabled: { backgroundColor: colors.borderStrong },
  welcomeContinueText: { ...typography.button, color: colors.white, fontSize: 15 },
  connectionBadge: {
    height: 23,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.primarySoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  connectionBadgeOffline: { backgroundColor: colors.surfaceMuted },
  connectionDot: { width: 6, height: 6, borderRadius: 3 },
  connectionText: {
    fontFamily: fonts.medium,
    color: colors.inkSoft,
    fontSize: 8.5,
    lineHeight: 11,
  },
  journeyBlock: { position: 'relative', marginBottom: spacing.sm },
  journeyBlockSearch: { marginBottom: spacing.xs },
  journeyRail: {
    position: 'absolute',
    right: 22,
    top: 61,
    bottom: 7,
    width: 1.25,
    backgroundColor: colors.primary,
  },
  heroPanel: {
    minHeight: 112,
    paddingTop: spacing.xs,
    paddingRight: 64,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  heroCopy: { flex: 1, minWidth: 0 },
  heroTitle: {
    color: colors.ink,
    fontFamily: fonts.hero,
    fontSize: 35,
    lineHeight: 33,
    letterSpacing: -1.05,
  },
  heroSubtitle: {
    fontFamily: fonts.body,
    color: colors.muted,
    fontSize: 10.5,
    lineHeight: 15,
    marginTop: 5,
  },
  heroBusBadge: {
    position: 'absolute',
    top: 10,
    right: -3,
    width: 51,
    height: 51,
    borderRadius: 26,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchShell: {
    height: 41,
    marginRight: 38,
    paddingHorizontal: 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderStrong,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  searchShellFocused: {
    height: 46,
    marginRight: 0,
    marginBottom: spacing.sm,
    borderBottomColor: colors.primary,
    borderBottomWidth: 1.5,
  },
  searchInput: {
    flex: 1,
    height: '100%',
    paddingVertical: 0,
    color: colors.ink,
    fontFamily: fonts.body,
    fontSize: 11,
    lineHeight: 15,
  },
  sectionHeading: {
    minHeight: 34,
    marginRight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  quickTitle: {
    fontFamily: fonts.label,
    color: colors.ink,
    fontSize: 10.5,
    lineHeight: 14,
  },
  headingRule: { flex: 1, minWidth: 10, height: 1, backgroundColor: colors.borderStrong },
  preferenceMode: {
    height: 28,
    paddingHorizontal: 4,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  preferenceModeActive: { borderBottomColor: colors.primary },
  preferenceModeText: {
    fontFamily: fonts.label,
    color: colors.inkSoft,
    fontSize: 9.5,
    lineHeight: 14,
  },
  preferenceModeTextActive: { fontFamily: fonts.strong, color: colors.primary },
  preferenceViewport: { overflow: 'hidden' },
  preferenceScroller: { flex: 1 },
  preferenceList: { paddingRight: 38 },
  preferenceFade: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    height: 14,
  },
  preferenceRow: {
    position: 'relative',
    paddingHorizontal: 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  preferenceRowSelected: { backgroundColor: colors.primaryWash },
  quickRouteBadge: {
    minWidth: 33,
    height: 21,
    paddingHorizontal: 5,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickRouteBadgeText: {
    fontFamily: fonts.strong,
    fontSize: 9,
    lineHeight: 11,
  },
  preferenceDestination: {
    flex: 1,
    color: colors.inkSoft,
    fontFamily: fonts.medium,
    fontSize: 9.5,
    lineHeight: 13,
  },
  preferenceDestinationSelected: { fontFamily: fonts.label, color: colors.ink },
  preferenceTime: {
    width: 56,
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 8.5,
    lineHeight: 11,
    textAlign: 'right',
  },
  railStop: {
    position: 'absolute',
    right: -20,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.background,
  },
  railStopSelected: { backgroundColor: colors.primary },
  preferenceEmpty: {
    minHeight: 40,
    marginRight: 38,
    paddingHorizontal: 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  preferenceEmptyText: {
    flex: 1,
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 9.5,
    lineHeight: 13,
  },
  routesHeading: {
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  sectionTitle: {
    fontFamily: fonts.display,
    color: colors.ink,
    fontSize: 14,
    lineHeight: 18,
  },
  catalogButton: {
    height: 28,
    paddingHorizontal: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  catalogButtonText: { fontFamily: fonts.label, color: colors.primary, fontSize: 9.5, lineHeight: 12 },
  routeList: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    padding: 3,
    gap: 3,
    overflow: 'hidden',
  },
  routeRow: {
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
  },
  routeRowSelected: { borderLeftWidth: 2 },
  routeMain: {
    flex: 1,
    minWidth: 0,
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  routeBadge: {
    minWidth: 40,
    height: 25,
    paddingHorizontal: 6,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  routeBadgeText: { ...typography.badge, fontSize: 10, lineHeight: 12 },
  routeCopy: { flex: 1, minWidth: 0 },
  routeName: { fontFamily: fonts.label, color: colors.ink, fontSize: 10, lineHeight: 13 },
  routeMeta: { fontFamily: fonts.body, color: colors.muted, fontSize: 8.5, lineHeight: 11, marginTop: 1 },
  starButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  starButtonActive: { backgroundColor: colors.primarySoft },
  emptyRoutes: { minHeight: 70, alignItems: 'center', justifyContent: 'center' },
  emptyRoutesText: { ...typography.body, color: colors.muted, marginTop: spacing.xs },
  servicePanel: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  servicePanelLandscape: {
    width: '39%',
    maxWidth: 400,
    minWidth: 290,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  selectedRouteLabel: {
    fontFamily: fonts.medium,
    color: colors.muted,
    fontSize: 9,
    lineHeight: 12,
    marginBottom: 4,
  },
  selectedRouteCard: {
    minHeight: 42,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderRadius: radii.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  selectedRouteBadge: {
    minWidth: 42,
    height: 28,
    paddingHorizontal: 7,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedRouteBadgeText: { ...typography.badge, fontSize: 10.5 },
  selectedRouteCopy: { flex: 1, minWidth: 0 },
  selectedRouteName: {
    fontFamily: fonts.label,
    color: colors.ink,
    fontSize: 10.5,
    lineHeight: 14,
  },
  selectedRouteMeta: {
    fontFamily: fonts.body,
    color: colors.muted,
    fontSize: 8.5,
    lineHeight: 11,
    marginTop: 1,
  },
  selectedRouteCheck: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  directionLabel: {
    fontFamily: fonts.medium,
    color: colors.muted,
    fontSize: 9,
    lineHeight: 12,
    marginBottom: 4,
  },
  directionSelector: {
    minHeight: 48,
    padding: 3,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceMuted,
    flexDirection: 'row',
    gap: 3,
    marginBottom: spacing.sm,
  },
  directionSelectorLandscape: { flexDirection: 'column' },
  directionOption: {
    flex: 1,
    minHeight: 42,
    paddingHorizontal: spacing.sm,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  directionOptionSelected: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  directionNumber: {
    width: 25,
    height: 25,
    borderRadius: 13,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  directionNumberSelected: { backgroundColor: colors.primary },
  directionNumberText: { fontFamily: fonts.label, color: colors.transitDark, fontSize: 9, lineHeight: 11 },
  directionNumberTextSelected: { color: colors.white },
  directionText: { fontFamily: fonts.medium, flex: 1, color: colors.inkSoft, fontSize: 9.5, lineHeight: 13 },
  directionTextSelected: { fontFamily: fonts.label, color: colors.ink },
  startButton: {
    minHeight: 53,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  startButtonDisabled: { backgroundColor: '#8C9B93' },
  startButtonCopy: { flex: 1, minWidth: 0 },
  startButtonText: { ...typography.button, color: colors.white },
  startButtonMeta: {
    fontFamily: fonts.body,
    color: 'rgba(255,255,255,0.82)',
    fontSize: 9,
    lineHeight: 12,
    marginTop: 1,
  },
});
