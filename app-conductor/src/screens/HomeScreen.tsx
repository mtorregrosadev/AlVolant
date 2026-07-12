import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
  Image,
  Keyboard,
  LayoutAnimation,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type ImageSourcePropType,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useFocusEffect } from '@react-navigation/native';
import * as Location from 'expo-location';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import ServiceAssignmentModal from '../components/ServiceAssignmentModal';
import { apiService, type RouteInfo, type UpcomingTrip } from '../services/api';
import {
  AGENCY_OPTIONS,
  formatRecentTime,
  getAgencyFilter,
  getAgencyLabel,
  getDirectionNames,
  getRouteTitle,
  routeMatchesSearch,
  type AgencyFilter,
} from '../services/routePresentation';
import {
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
type ChipVisual = {
  icon?: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  image?: ImageSourcePropType;
};
type PreferenceRoute = {
  route: RouteInfo;
  recent?: RecentRoute;
};

const AGENCY_VISUALS: Record<AgencyFilter, ChipVisual> = {
  Tots: { icon: 'transit-connection-variant' },
  TMB: { image: require('../../assets/logo-tmb.png') },
  AMB: { image: require('../../assets/logo-amb.png') },
  FGC: { image: require('../../assets/logo_fgc.png') },
  Rodalies: { image: require('../../assets/logo_rodalies.png') },
  Altres: { icon: 'bus-multiple' },
};

const FOREGROUND_REFRESH_MS = 15 * 60 * 1000;
const NEARBY_REFRESH_MS = 2 * 60 * 1000;
const RECENT_LOCATION_MAX_AGE_MS = 2 * 60 * 1000;
const ROUTE_ROW_HEIGHT = 47;
const PREFERENCE_ROW_HEIGHT = 34;
const PREFERENCE_ROWS_PORTRAIT = 4;
const PREFERENCE_ROWS_LANDSCAPE = 3;
const SEARCH_RESULT_LIMIT = 40;
const INTRO_MINIMUM_MS = 1100;
const SEARCH_OPEN_DURATION_MS = 320;
const SEARCH_CLOSE_DURATION_MS = 280;
const SEARCH_INITIAL_EXTRA_RESULTS = 12;
const SEARCH_APPEND_BATCH_SIZE = 8;
const SEARCH_APPEND_THROTTLE_MS = 180;
const SEARCH_APPEND_REVEAL_DURATION_MS = 160;

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

function IntroBus({ accent = colors.primary }: { accent?: string }) {
  return (
    <View style={styles.introBus}>
      <View style={[styles.introBusEnd, styles.introBusFront, { backgroundColor: accent }]} />
      <View style={[styles.introBusEnd, styles.introBusBack, { backgroundColor: accent }]} />
      <View style={[styles.introBusStripe, styles.introBusStripeLeft, { backgroundColor: accent }]} />
      <View style={[styles.introBusStripe, styles.introBusStripeRight, { backgroundColor: accent }]} />
      <View style={styles.introBusGlass} />
      <View style={styles.introBusRoof} />
    </View>
  );
}

function sanitizeVehicleId(value: string) {
  return value.toLocaleUpperCase('ca').replace(/[^A-Z0-9-]/g, '').slice(0, 12);
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

export default function HomeScreen({ navigation, route }: HomeScreenProps) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = screenWidth > screenHeight;
  const mountedRef = useRef(true);
  const lastRoutesFetchRef = useRef(0);
  const introOpacity = useRef(new Animated.Value(1)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const contentTranslateY = useRef(new Animated.Value(12)).current;
  const introBusForward = useRef(new Animated.Value(0)).current;
  const introBusReverse = useRef(new Animated.Value(0)).current;
  const introPulse = useRef(new Animated.Value(0)).current;
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

  const {
    ready: preferencesReady,
    preferences,
    toggleFavorite,
    recordRecent,
  } = usePreferences();
  const { language, t } = useI18n();

  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<RouteInfo | null>(null);
  const [directionId, setDirectionId] = useState<0 | 1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [nearbyDistances, setNearbyDistances] = useState<Record<string, number>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [isClosingSearch, setIsClosingSearch] = useState(false);
  const [searchVisibleCount, setSearchVisibleCount] = useState(4);
  const [selectedAgency, setSelectedAgency] = useState<AgencyFilter>('Tots');
  const [preferenceView, setPreferenceView] = useState<PreferenceView>('recent');
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [manualVehicle, setManualVehicle] = useState('');
  const [upcomingTrips, setUpcomingTrips] = useState<UpcomingTrip[]>([]);
  const [isLoadingTrips, setIsLoadingTrips] = useState(false);
  const [discoveryViewportHeight, setDiscoveryViewportHeight] = useState(0);
  const [resultsBlockTop, setResultsBlockTop] = useState(0);
  const [routesHeadingBottom, setRoutesHeadingBottom] = useState(0);
  const [introMinimumElapsed, setIntroMinimumElapsed] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
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
    void loadRoutes(true);

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - lastRoutesFetchRef.current > FOREGROUND_REFRESH_MS) {
        void loadRoutes(false);
      }
    });

    return () => {
      mountedRef.current = false;
      subscription.remove();
    };
  }, [loadRoutes]);

  useEffect(() => {
    const minimumTimer = setTimeout(() => setIntroMinimumElapsed(true), INTRO_MINIMUM_MS);
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => undefined);

    return () => {
      clearTimeout(minimumTimer);
    };
  }, []);

  useEffect(() => () => {
    if (searchAppendTimerRef.current) {
      clearTimeout(searchAppendTimerRef.current);
      searchAppendTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!showIntro || reduceMotion) return undefined;

    introBusForward.setValue(0);
    introBusReverse.setValue(0);
    introPulse.setValue(0);
    const animation = Animated.parallel([
      Animated.loop(Animated.timing(introBusForward, {
        toValue: 1,
        duration: 1350,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      })),
      Animated.loop(Animated.timing(introBusReverse, {
        toValue: 1,
        duration: 1600,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      })),
      Animated.loop(Animated.sequence([
        Animated.timing(introPulse, {
          toValue: 1,
          duration: 460,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(introPulse, {
          toValue: 0,
          duration: 460,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ])),
    ]);

    animation.start();
    return () => animation.stop();
  }, [introBusForward, introBusReverse, introPulse, reduceMotion, showIntro]);

  useEffect(() => {
    if (!showIntro || loading || !introMinimumElapsed) return;

    Animated.parallel([
      Animated.timing(introOpacity, {
        toValue: 0,
        duration: reduceMotion ? 120 : 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(contentOpacity, {
        toValue: 1,
        duration: reduceMotion ? 120 : 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(contentTranslateY, {
        toValue: 0,
        duration: reduceMotion ? 120 : 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished && mountedRef.current) setShowIntro(false);
    });
  }, [contentOpacity, contentTranslateY, introMinimumElapsed, introOpacity, loading, reduceMotion, showIntro]);

  useFocusEffect(useCallback(() => {
    if (showIntro || routes.length === 0) return undefined;

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
  }, [fetchNearbyDistances, reduceMotion, routes.length, showIntro]));

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

    const recent = preferences.recentRoutes.find((item) =>
      routes.some((candidate) => candidate.route_id === item.routeId));
    const favoriteId = preferences.favoriteRouteIds.find((id) =>
      routes.some((candidate) => candidate.route_id === id));
    const initialRoute = routes.find((candidate) => candidate.route_id === recent?.routeId)
      ?? routes.find((candidate) => candidate.route_id === favoriteId)
      ?? routes[0];

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

  const availableAgencies = useMemo(() => {
    const present = new Set<AgencyFilter>();
    routes.forEach((item) => present.add(getAgencyFilter(item)));
    return AGENCY_OPTIONS.filter((agency) => agency === 'Tots' || present.has(agency));
  }, [routes]);

  useEffect(() => {
    if (!availableAgencies.includes(selectedAgency)) setSelectedAgency('Tots');
  }, [availableAgencies, selectedAgency]);

  const filteredRoutes = useMemo(() => {
    const matches = routes
      .filter((item) => routeMatchesSearch(item, searchQuery))
      .filter((item) => selectedAgency === 'Tots' || getAgencyFilter(item) === selectedAgency);

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
  }, [nearbyDistances, routes, searchQuery, selectedAgency]);

  useEffect(() => {
    const autoSelectedRouteId = autoSelectedRouteRef.current;
    if (!autoSelectedRouteId || Object.keys(nearbyDistances).length === 0) return;
    if (selectedRoute?.route_id !== autoSelectedRouteId || directionId !== null) {
      autoSelectedRouteRef.current = null;
      return;
    }

    const nearestRoute = routes.reduce<{
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
  }, [directionId, nearbyDistances, routes, selectedRoute]);

  const preferenceRoutes = useMemo<PreferenceRoute[]>(() => {
    const byId = new Map(routes.map((item) => [item.route_id, item]));

    if (preferenceView === 'favorite') {
      return preferences.favoriteRouteIds
        .map((routeId) => byId.get(routeId))
        .filter((item): item is RouteInfo => Boolean(item))
        .map((item) => ({ route: item }));
    }

    return preferences.recentRoutes
      .flatMap((recent): PreferenceRoute[] => {
        const item = byId.get(recent.routeId);
        return item ? [{ route: item, recent }] : [];
      })
      .slice(0, 4);
  }, [preferenceView, preferences, routes]);

  const visiblePreferenceRows = isLandscape
    ? PREFERENCE_ROWS_LANDSCAPE
    : PREFERENCE_ROWS_PORTRAIT;
  const preferenceViewportHeight = Math.min(
    preferenceRoutes.length,
    visiblePreferenceRows,
  ) * PREFERENCE_ROW_HEIGHT;
  const preferenceScrollEnabled = preferenceRoutes.length > visiblePreferenceRows;

  const minimumVisibleRoutes = isLandscape ? 4 : 2;
  const routeListTop = resultsBlockTop + routesHeadingBottom;
  const measuredVisibleRoutes = discoveryViewportHeight > 0 && routeListTop > 0
    ? Math.floor((discoveryViewportHeight - routeListTop - spacing.md) / ROUTE_ROW_HEIGHT)
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
    if (remaining > ROUTE_ROW_HEIGHT * 2) return;

    const now = Date.now();
    if (now - lastSearchAppendAtRef.current < SEARCH_APPEND_THROTTLE_MS) return;
    lastSearchAppendAtRef.current = now;
    setSearchVisibleCount((current) => Math.min(
      targetCount,
      current + SEARCH_APPEND_BATCH_SIZE,
    ));
  }, [filteredRoutes.length, isSearchMode, searchVisibleCount]);

  const handleDiscoveryLayout = useCallback((event: LayoutChangeEvent) => {
    setDiscoveryViewportHeight(event.nativeEvent.layout.height);
  }, []);

  const handleRoutesHeadingLayout = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    setRoutesHeadingBottom(y + height + spacing.xs);
  }, []);

  const navigateToMap = useCallback((vehicleId?: string, tripId?: string) => {
    if (!selectedRoute || directionId === null) return;

    recordRecent(selectedRoute.route_id, directionId);
    navigation.navigate('Map', {
      routeId: selectedRoute.route_id,
      directionId,
      ...(vehicleId ? { assignedVehicle: vehicleId } : {}),
      ...(tripId ? { tripId } : {}),
      directionLabel: directionId === 0 ? directionNames.anada : directionNames.tornada,
    });
  }, [directionId, directionNames, navigation, recordRecent, selectedRoute]);

  const handleStartDriving = useCallback(async () => {
    if (!selectedRoute || directionId === null || isLoadingTrips) return;

    setUpcomingTrips([]);
    setIsLoadingTrips(true);
    setShowAssignModal(true);
    try {
      const trips = await apiService.fetchUpcomingTrips(selectedRoute.route_id, directionId);
      if (mountedRef.current) setUpcomingTrips(trips);
    } catch {
      if (mountedRef.current) setUpcomingTrips([]);
    } finally {
      if (mountedRef.current) setIsLoadingTrips(false);
    }
  }, [directionId, isLoadingTrips, selectedRoute]);

  const handleConfirmAssignment = useCallback((vehicleId: string, tripId?: string) => {
    setShowAssignModal(false);
    setManualVehicle('');
    navigateToMap(sanitizeVehicleId(vehicleId) || undefined, tripId);
  }, [navigateToMap]);

  const renderAgencyVisual = (agency: AgencyFilter, active: boolean) => {
    const visual = AGENCY_VISUALS[agency];
    if (visual.image) {
      return <Image source={visual.image} style={styles.agencyLogo} resizeMode="contain" accessible={false} />;
    }

    return (
      <MaterialCommunityIcons
        name={visual.icon || 'bus'}
        size={17}
        color={active ? colors.white : colors.transitDark}
      />
    );
  };

  const renderRouteRow = (item: RouteInfo) => {
    const selected = selectedRoute?.route_id === item.route_id;
    const favorite = favoriteIds.has(item.route_id);
    const routeColor = safeHexColor(item.route_color, colors.primary);

    return (
      <View
        key={item.route_id}
        style={[
          styles.routeRow,
          selected && styles.routeRowSelected,
          {
            backgroundColor: routePastelColor(item.route_color, selected ? 0.135 : 0.075),
            borderLeftColor: selected ? routeColor : colors.border,
          },
        ]}
      >
        <TouchableOpacity
          style={styles.routeMain}
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
            { backgroundColor: safeHexColor(item.route_color, colors.primary) },
          ]}>
            <Text style={[
              styles.routeBadgeText,
              { color: safeHexColor(item.route_text_color, colors.white) },
            ]}>{item.route_short_name || 'Bus'}</Text>
          </View>
          <View style={styles.routeCopy}>
            <Text style={styles.routeName} numberOfLines={1}>{getRouteTitle(item, language)}</Text>
            <Text style={styles.routeMeta}>{getAgencyLabel(getAgencyFilter(item), language)}</Text>
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
      <Animated.View
        style={[
          styles.animatedContent,
          { opacity: contentOpacity, transform: [{ translateY: contentTranslateY }] },
        ]}
        pointerEvents={showIntro ? 'none' : 'auto'}
      >
      <View style={[styles.content, isLandscape && styles.contentLandscape]}>
        <ScrollView
          style={styles.discoveryPane}
          contentContainerStyle={[
            styles.discoveryContent,
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
                accessibilityRole="button"
                accessibilityLabel={t('home.settings')}
              >
                <MaterialCommunityIcons name="tune-variant" size={15} color={colors.primary} />
              </TouchableOpacity>
              <View style={[styles.connectionBadge, !isConnected && styles.connectionBadgeOffline]}>
                <View style={[styles.connectionDot, { backgroundColor: isConnected ? colors.success : colors.danger }]} />
                <Text style={styles.connectionText}>{t(isConnected ? 'home.live' : 'home.offline')}</Text>
              </View>
            </View>
          ) : null}

          <View style={[styles.journeyBlock, isSearchMode && styles.journeyBlockSearch]}>
            {!isSearchMode ? (
              <>
                <View style={styles.journeyRail} pointerEvents="none" />

                <View style={styles.heroPanel}>
                  <View style={styles.heroCopy}>
                    <Text style={styles.heroTitle}>{t('home.hero')}</Text>
                    <Text style={styles.heroSubtitle}>{t('home.subtitle')}</Text>
                  </View>
                  <View style={styles.heroBusBadge}>
                    <MaterialCommunityIcons name="bus" size={25} color={colors.primary} />
                  </View>
                </View>
              </>
            ) : null}

            <View style={[styles.searchShell, isSearchMode && styles.searchShellFocused]}>
              <MaterialCommunityIcons name="magnify" size={18} color={colors.inkSoft} />
              <TextInput
                style={styles.searchInput}
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
                <View style={styles.sectionHeading}>
                  <Text style={styles.quickTitle}>{t('home.quick')}</Text>
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
                      preferenceView === 'recent' && styles.preferenceModeTextActive,
                    ]}>{t('home.recents', { count: preferences.recentRoutes.length })}</Text>
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
                      snapToInterval={PREFERENCE_ROW_HEIGHT}
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
                          (index - visiblePreferenceRows) * PREFERENCE_ROW_HEIGHT,
                          (index - visiblePreferenceRows + 1) * PREFERENCE_ROW_HEIGHT,
                          index * PREFERENCE_ROW_HEIGHT,
                          (index + 1) * PREFERENCE_ROW_HEIGHT,
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
                            style={[styles.preferenceRow, selected && styles.preferenceRowSelected]}
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
                              { backgroundColor: safeHexColor(item.route_color, colors.primary) },
                            ]}>
                              <Text style={[
                                styles.quickRouteBadgeText,
                                { color: safeHexColor(item.route_text_color, colors.white) },
                              ]}>{item.route_short_name || 'Bus'}</Text>
                            </View>
                            <Text
                              style={[styles.preferenceDestination, selected && styles.preferenceDestinationSelected]}
                              numberOfLines={1}
                            >{destination}</Text>
                            <Text style={styles.preferenceTime} numberOfLines={1}>
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
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.agencyRow}
          >
            {availableAgencies.map((agency) => {
              const active = selectedAgency === agency;
              return (
                <TouchableOpacity
                  key={agency}
                  style={[styles.agencyChip, active && styles.agencyChipActive]}
                  onPress={() => setSelectedAgency(agency)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  {renderAgencyVisual(agency, active)}
                  <Text style={[styles.agencyText, active && styles.agencyTextActive]}>
                    {getAgencyLabel(agency, language)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.routesHeading} onLayout={handleRoutesHeadingLayout}>
            <Text style={styles.sectionTitle}>
              {t(isSearchMode || searchQuery || selectedAgency !== 'Tots' ? 'common.results' : 'home.lines')}
            </Text>
            <TouchableOpacity
              style={styles.catalogButton}
              onPress={() => navigation.navigate('Routes')}
              accessibilityRole="button"
              accessibilityLabel={t('home.openAll')}
            >
              <Text style={styles.catalogButtonText}>{t('home.all')}</Text>
              <MaterialCommunityIcons name="arrow-top-right" size={15} color={colors.primary} />
            </TouchableOpacity>
          </View>

          {loading && routes.length === 0 ? (
            <View style={styles.loadingState}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.loadingText}>{t('home.loadingLines')}</Text>
            </View>
          ) : displayedRoutes.length === 0 ? (
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
          <View style={[styles.servicePanel, isLandscape && styles.servicePanelLandscape]}>
          {isLandscape ? (
            <View style={styles.serviceHeader}>
              {selectedRoute ? (
                <View style={[
                  styles.serviceRouteBadge,
                  { backgroundColor: safeHexColor(selectedRoute.route_color, colors.primary) },
                ]}>
                  <Text style={[
                    styles.serviceRouteBadgeText,
                    { color: safeHexColor(selectedRoute.route_text_color, colors.white) },
                  ]}>{selectedRoute.route_short_name || 'Bus'}</Text>
                </View>
              ) : (
                <View style={styles.serviceHeaderIcon}>
                  <MaterialCommunityIcons name="bus" size={21} color={colors.white} />
                </View>
              )}
              <View style={styles.serviceHeaderCopy}>
                <Text style={styles.serviceTitle} numberOfLines={1}>
                  {selectedRoute ? getRouteTitle(selectedRoute, language) : t('home.selectLine')}
                </Text>
              </View>
            </View>
          ) : null}

          <Text style={styles.directionLabel}>{t('home.direction')}</Text>
          <View style={[styles.directionSelector, isLandscape && styles.directionSelectorLandscape]}>
            {([0, 1] as const).map((value) => {
              const label = value === 0 ? directionNames.anada : directionNames.tornada;
              const selected = directionId === value;
              return (
                <TouchableOpacity
                  key={value}
                  style={[styles.directionOption, selected && styles.directionOptionSelected]}
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
                    <Text style={[styles.directionNumberText, selected && styles.directionNumberTextSelected]}>
                      {value + 1}
                    </Text>
                  </View>
                  <Text style={[styles.directionText, selected && styles.directionTextSelected]} numberOfLines={2}>
                    {label || t('home.chooseLine')}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            style={[
              styles.startButton,
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
              <Text style={styles.startButtonText}>{t('home.start')}</Text>
              <Text style={styles.startButtonMeta} numberOfLines={1}>
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
        loading={isLoadingTrips}
        manualVehicle={manualVehicle}
        onManualVehicleChange={(value) => setManualVehicle(sanitizeVehicleId(value))}
        onClose={() => setShowAssignModal(false)}
        onConfirm={handleConfirmAssignment}
        onSkip={() => {
          setShowAssignModal(false);
          navigateToMap();
        }}
      />
      </Animated.View>

      {showIntro ? (
        <Animated.View
          style={[styles.introOverlay, { opacity: introOpacity }]}
          accessibilityRole="progressbar"
          accessibilityLiveRegion="polite"
          accessibilityLabel={t('app.loading')}
        >
          <View style={styles.introMark}>
            <MaterialCommunityIcons name="transit-connection-horizontal" size={22} color={colors.primary} />
          </View>
          <Text style={styles.introTitle}>{t('app.loading')}</Text>
          <View style={styles.introScene}>
            <View style={[styles.introTrack, styles.introTrackTop]} />
            <View style={[styles.introTrack, styles.introTrackBottom]} />
            <Animated.View style={[
              styles.introStop,
              styles.introStopTop,
              {
                opacity: introPulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
                transform: [{ scale: introPulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.2] }) }],
              },
            ]} />
            <Animated.View style={[
              styles.introStop,
              styles.introStopBottom,
              {
                opacity: introPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] }),
                transform: [{ scale: introPulse.interpolate({ inputRange: [0, 1], outputRange: [1.2, 0.85] }) }],
              },
            ]} />
            <Animated.View style={[
              styles.introMovingBus,
              styles.introMovingBusTop,
              {
                transform: [
                  { translateX: introBusForward.interpolate({ inputRange: [0, 1], outputRange: [-126, 126] }) },
                  { rotate: '90deg' },
                ],
              },
            ]}>
              <IntroBus />
            </Animated.View>
            <Animated.View style={[
              styles.introMovingBus,
              styles.introMovingBusBottom,
              {
                transform: [
                  { translateX: introBusReverse.interpolate({ inputRange: [0, 1], outputRange: [126, -126] }) },
                  { rotate: '-90deg' },
                ],
              },
            ]}>
              <IntroBus accent={colors.warning} />
            </Animated.View>
          </View>
          <Text style={styles.introHint}>{t('app.loadingHint')}</Text>
          <View style={styles.introProgressTrack}>
            <Animated.View style={[
              styles.introProgress,
              {
                transform: [{
                  translateX: introBusForward.interpolate({ inputRange: [0, 1], outputRange: [-80, 80] }),
                }],
              },
            ]} />
          </View>
        </Animated.View>
      ) : null}
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
  },
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
  preferenceRow: {
    position: 'relative',
    height: PREFERENCE_ROW_HEIGHT,
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
  agencyRow: {
    gap: 6,
    paddingRight: spacing.lg,
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
  },
  agencyChip: {
    height: 32,
    minWidth: 62,
    paddingHorizontal: spacing.sm,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  agencyChipActive: { backgroundColor: colors.transitDark, borderColor: colors.transitDark },
  agencyLogo: { width: 20, height: 14 },
  agencyText: { fontFamily: fonts.medium, color: colors.inkSoft, fontSize: 9.5, lineHeight: 12 },
  agencyTextActive: { fontFamily: fonts.label, color: colors.white },
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
  loadingState: { minHeight: 70, alignItems: 'center', justifyContent: 'center' },
  loadingText: { ...typography.body, color: colors.muted, marginTop: spacing.sm },
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
  serviceHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  serviceHeaderIcon: {
    width: 36,
    height: 36,
    borderRadius: 7,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  serviceHeaderCopy: { flex: 1, minWidth: 0 },
  serviceTitle: { fontFamily: fonts.label, color: colors.ink, fontSize: 12, lineHeight: 16 },
  serviceRouteBadge: {
    minWidth: 44,
    height: 34,
    paddingHorizontal: spacing.sm,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  serviceRouteBadgeText: { ...typography.badge, fontSize: 11 },
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
  introOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 20,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
  },
  introMark: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  introTitle: {
    fontFamily: fonts.hero,
    color: colors.ink,
    fontSize: 31,
    lineHeight: 34,
    letterSpacing: -0.7,
    textAlign: 'center',
  },
  introHint: {
    marginTop: spacing.md,
    fontFamily: fonts.medium,
    color: colors.muted,
    fontSize: 10.5,
    lineHeight: 14,
    textAlign: 'center',
  },
  introScene: {
    width: 292,
    height: 104,
    marginTop: spacing.xl,
    position: 'relative',
    overflow: 'hidden',
  },
  introTrack: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: 1.5,
    borderRadius: 1,
    backgroundColor: colors.primary,
    opacity: 0.38,
  },
  introTrackTop: { top: 31 },
  introTrackBottom: { top: 73 },
  introStop: {
    position: 'absolute',
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.background,
  },
  introStopTop: { top: 27, left: 64 },
  introStopBottom: { top: 69, right: 58 },
  introMovingBus: { position: 'absolute', left: '50%', marginLeft: -9 },
  introMovingBusTop: { top: 5 },
  introMovingBusBottom: { top: 47 },
  introBus: {
    width: 18,
    height: 52,
    borderRadius: 5,
    borderWidth: 1.4,
    borderColor: '#111F38',
    backgroundColor: colors.white,
    overflow: 'hidden',
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.28,
    shadowRadius: 4,
    elevation: 5,
  },
  introBusEnd: { position: 'absolute', left: 0, right: 0, height: 10 },
  introBusFront: { top: 0 },
  introBusBack: { bottom: 0 },
  introBusStripe: { position: 'absolute', top: 10, bottom: 10, width: 3 },
  introBusStripeLeft: { left: 0 },
  introBusStripeRight: { right: 0 },
  introBusGlass: {
    position: 'absolute',
    top: 3,
    left: 3,
    right: 3,
    height: 4,
    borderRadius: 1,
    backgroundColor: '#1E293B',
  },
  introBusRoof: {
    position: 'absolute',
    top: 18,
    left: 5,
    right: 5,
    height: 11,
    borderRadius: 2,
    borderWidth: 0.7,
    borderColor: '#94A3B8',
    backgroundColor: '#E2E8F0',
  },
  introProgressTrack: {
    width: 176,
    height: 2,
    marginTop: spacing.lg,
    borderRadius: 1,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  introProgress: {
    alignSelf: 'center',
    width: 56,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.primary,
  },
});
