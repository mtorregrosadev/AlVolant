import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type ImageSourcePropType,
  type LayoutChangeEvent,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useFocusEffect } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import ServiceAssignmentModal from '../components/ServiceAssignmentModal';
import { apiService, type RouteInfo, type UpcomingTrip } from '../services/api';
import {
  AGENCY_OPTIONS,
  formatRecentTime,
  getAgencyFilter,
  getDirectionNames,
  getRouteTitle,
  routeMatchesSearch,
  type AgencyFilter,
} from '../services/routePresentation';
import {
  EMPTY_USER_PREFERENCES,
  loadUserPreferences,
  saveUserPreferences,
  withRecordedRecent,
  withToggledFavorite,
  type RecentRoute,
  type UserPreferences,
} from '../services/userPreferences';
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
const ROUTE_ROW_HEIGHT = 47;
const SEARCH_RESULT_LIMIT = 40;

function sanitizeVehicleId(value: string) {
  return value.toLocaleUpperCase('ca').replace(/[^A-Z0-9-]/g, '').slice(0, 12);
}

export default function HomeScreen({ navigation, route }: HomeScreenProps) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = screenWidth > screenHeight;
  const mountedRef = useRef(true);
  const lastRoutesFetchRef = useRef(0);

  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<RouteInfo | null>(null);
  const [directionId, setDirectionId] = useState<0 | 1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [selectedAgency, setSelectedAgency] = useState<AgencyFilter>('Tots');
  const [preferenceView, setPreferenceView] = useState<PreferenceView>('recent');
  const [preferences, setPreferences] = useState<UserPreferences>({ ...EMPTY_USER_PREFERENCES });
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [manualVehicle, setManualVehicle] = useState('');
  const [upcomingTrips, setUpcomingTrips] = useState<UpcomingTrip[]>([]);
  const [isLoadingTrips, setIsLoadingTrips] = useState(false);
  const [discoveryViewportHeight, setDiscoveryViewportHeight] = useState(0);
  const [routeListTop, setRouteListTop] = useState(0);

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

  useFocusEffect(useCallback(() => {
    let active = true;
    void loadUserPreferences().then((stored) => {
      if (!active) return;
      setPreferences(stored);
      setPreferencesReady(true);
    });

    return () => {
      active = false;
    };
  }, []));

  useEffect(() => {
    const requestedRouteId = route.params?.selectedRouteId;
    if (!requestedRouteId || routes.length === 0) return;

    const requestedRoute = routes.find((candidate) => candidate.route_id === requestedRouteId);
    if (requestedRoute) {
      setSelectedRoute(requestedRoute);
      setDirectionId(null);
    }
    navigation.setParams({ selectedRouteId: undefined });
  }, [navigation, route.params?.selectedRouteId, routes]);

  useEffect(() => {
    if (!preferencesReady || selectedRoute || routes.length === 0 || route.params?.selectedRouteId) return;

    const recent = preferences.recentRoutes.find((item) =>
      routes.some((candidate) => candidate.route_id === item.routeId));
    const favoriteId = preferences.favoriteRouteIds.find((id) =>
      routes.some((candidate) => candidate.route_id === id));
    const initialRoute = routes.find((candidate) => candidate.route_id === recent?.routeId)
      ?? routes.find((candidate) => candidate.route_id === favoriteId)
      ?? routes[0];

    setSelectedRoute(initialRoute);
    if (recent?.routeId === initialRoute.route_id) setDirectionId(recent.directionId);
  }, [preferences, preferencesReady, route.params?.selectedRouteId, routes, selectedRoute]);

  const directionNames = useMemo(() => getDirectionNames(selectedRoute), [selectedRoute]);
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

  const filteredRoutes = useMemo(() => routes
    .filter((item) => routeMatchesSearch(item, searchQuery))
    .filter((item) => selectedAgency === 'Tots' || getAgencyFilter(item) === selectedAgency)
    .sort((a, b) => Number(favoriteIds.has(b.route_id)) - Number(favoriteIds.has(a.route_id))),
  [favoriteIds, routes, searchQuery, selectedAgency]);

  const preferenceRoutes = useMemo<PreferenceRoute[]>(() => {
    const byId = new Map(routes.map((item) => [item.route_id, item]));

    if (preferenceView === 'favorite') {
      return preferences.favoriteRouteIds
        .map((routeId) => byId.get(routeId))
        .filter((item): item is RouteInfo => Boolean(item))
        .map((item) => ({ route: item }))
        .slice(0, 4);
    }

    return preferences.recentRoutes
      .flatMap((recent): PreferenceRoute[] => {
        const item = byId.get(recent.routeId);
        return item ? [{ route: item, recent }] : [];
      })
      .slice(0, 4);
  }, [preferenceView, preferences, routes]);

  const minimumVisibleRoutes = isLandscape ? 4 : 2;
  const measuredVisibleRoutes = discoveryViewportHeight > 0 && routeListTop > 0
    ? Math.floor((discoveryViewportHeight - routeListTop - spacing.md) / ROUTE_ROW_HEIGHT)
    : minimumVisibleRoutes;
  const maxVisibleRoutes = Math.max(
    minimumVisibleRoutes,
    Math.min(isLandscape ? 6 : 8, measuredVisibleRoutes),
  );
  const displayedRoutes = filteredRoutes.slice(
    0,
    isSearchMode ? SEARCH_RESULT_LIMIT : maxVisibleRoutes,
  );

  const persistPreferences = useCallback((next: UserPreferences) => {
    void saveUserPreferences(next);
  }, []);

  const toggleFavorite = useCallback((routeId: string) => {
    setPreferences((current) => {
      const next = withToggledFavorite(current, routeId);
      persistPreferences(next);
      return next;
    });
  }, [persistPreferences]);

  const recordRecent = useCallback((routeId: string, selectedDirection: 0 | 1) => {
    setPreferences((current) => {
      const next = withRecordedRecent(current, routeId, selectedDirection);
      persistPreferences(next);
      return next;
    });
  }, [persistPreferences]);

  const selectRoute = useCallback((item: RouteInfo, preferredDirection?: 0 | 1) => {
    setSelectedRoute(item);
    setDirectionId(preferredDirection ?? null);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchQuery('');
    setIsSearchMode(false);
    Keyboard.dismiss();
  }, []);

  const handleDiscoveryLayout = useCallback((event: LayoutChangeEvent) => {
    setDiscoveryViewportHeight(event.nativeEvent.layout.height);
  }, []);

  const handleRoutesHeadingLayout = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    setRouteListTop(y + height + spacing.xs);
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
            backgroundColor: routePastelColor(item.route_color, selected ? 0.18 : 0.1),
            borderLeftColor: selected ? routeColor : 'transparent',
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
          accessibilityLabel={`Línia ${item.route_short_name}, ${getRouteTitle(item)}`}
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
            <Text style={styles.routeName} numberOfLines={1}>{getRouteTitle(item)}</Text>
            <Text style={styles.routeMeta}>{getAgencyFilter(item)}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.starButton, favorite && styles.starButtonActive]}
          onPress={() => toggleFavorite(item.route_id)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityState={{ selected: favorite }}
          accessibilityLabel={`${favorite ? 'Treure' : 'Afegir'} ${item.route_short_name} ${favorite ? 'de' : 'a'} favorites`}
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
          onLayout={handleDiscoveryLayout}
        >
          {!isSearchMode ? (
            <View style={styles.liveBar}>
              <View style={[styles.connectionBadge, !isConnected && styles.connectionBadgeOffline]}>
                <View style={[styles.connectionDot, { backgroundColor: isConnected ? colors.success : colors.danger }]} />
                <Text style={styles.connectionText}>{isConnected ? 'Dades en directe' : 'Sense connexió'}</Text>
              </View>
            </View>
          ) : null}

          <View style={[styles.journeyBlock, isSearchMode && styles.journeyBlockSearch]}>
            {!isSearchMode ? (
              <>
                <View style={styles.journeyRail} pointerEvents="none" />

                <View style={styles.heroPanel}>
                  <View style={styles.heroCopy}>
                    <Text style={styles.heroTitle}>Quina línia{`\n`}toca avui?</Text>
                    <Text style={styles.heroSubtitle}>Tria servei, direcció i sortida.</Text>
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
                onFocus={() => setIsSearchMode(true)}
                placeholder="Cerca línia o destinació"
                placeholderTextColor={colors.subtle}
                maxLength={80}
                returnKeyType="search"
                autoCorrect={false}
                accessibilityLabel="Cercar línies"
              />
              {isSearchMode || searchQuery ? (
                <TouchableOpacity
                  onPress={closeSearch}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Tancar la cerca"
                >
                  <MaterialCommunityIcons name="close-circle" size={18} color={colors.primary} />
                </TouchableOpacity>
              ) : null}
            </View>

            {!isSearchMode ? (
              <>
                <View style={styles.sectionHeading}>
                  <Text style={styles.quickTitle}>Torna-hi ràpid</Text>
                  <View style={styles.headingRule} />
                  <TouchableOpacity
                    style={[styles.preferenceMode, preferenceView === 'recent' && styles.preferenceModeActive]}
                    onPress={() => setPreferenceView('recent')}
                    accessibilityRole="button"
                    accessibilityState={{ selected: preferenceView === 'recent' }}
                  >
                    <Text style={[
                      styles.preferenceModeText,
                      preferenceView === 'recent' && styles.preferenceModeTextActive,
                    ]}>Recents {preferences.recentRoutes.length}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.preferenceMode, preferenceView === 'favorite' && styles.preferenceModeActive]}
                    onPress={() => setPreferenceView('favorite')}
                    accessibilityRole="button"
                    accessibilityState={{ selected: preferenceView === 'favorite' }}
                  >
                    <Text style={[
                      styles.preferenceModeText,
                      preferenceView === 'favorite' && styles.preferenceModeTextActive,
                    ]}>Favorites {preferences.favoriteRouteIds.length}</Text>
                  </TouchableOpacity>
                </View>

                {preferenceRoutes.length > 0 ? (
                  <View style={styles.preferenceList}>
                    {preferenceRoutes.map(({ route: item, recent }) => {
                      const selected = selectedRoute?.route_id === item.route_id;
                      const labels = getDirectionNames(item);
                      const destination = recent
                        ? (recent.directionId === 0 ? labels.anada : labels.tornada)
                        : getRouteTitle(item);

                      return (
                        <TouchableOpacity
                          key={`${preferenceView}-${item.route_id}`}
                          style={[styles.preferenceRow, selected && styles.preferenceRowSelected]}
                          onPress={() => selectRoute(item, recent?.directionId)}
                          activeOpacity={0.72}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          accessibilityLabel={`${preferenceView === 'recent' ? 'Recent' : 'Favorita'}: ${item.route_short_name}`}
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
                            {recent ? formatRecentTime(recent.usedAt) : getAgencyFilter(item)}
                          </Text>
                          <View style={[styles.railStop, selected && styles.railStopSelected]} />
                        </TouchableOpacity>
                      );
                    })}
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
                      {preferenceView === 'recent'
                        ? 'Les rutes iniciades apareixeran aquí.'
                        : 'Marca una línia com a favorita.'}
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            ) : null}
          </View>

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
                  <Text style={[styles.agencyText, active && styles.agencyTextActive]}>{agency}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.routesHeading} onLayout={handleRoutesHeadingLayout}>
            <Text style={styles.sectionTitle}>
              {isSearchMode || searchQuery || selectedAgency !== 'Tots' ? 'Resultats' : 'Línies'}
            </Text>
            <TouchableOpacity
              style={styles.catalogButton}
              onPress={() => navigation.navigate('Routes')}
              accessibilityRole="button"
              accessibilityLabel="Obrir totes les línies"
            >
              <Text style={styles.catalogButtonText}>Totes</Text>
              <MaterialCommunityIcons name="arrow-top-right" size={15} color={colors.primary} />
            </TouchableOpacity>
          </View>

          {loading && routes.length === 0 ? (
            <View style={styles.loadingState}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.loadingText}>Carregant línies…</Text>
            </View>
          ) : displayedRoutes.length === 0 ? (
            <View style={styles.emptyRoutes}>
              <MaterialCommunityIcons name="bus-alert" size={26} color={colors.transitDark} />
              <Text style={styles.emptyRoutesText}>No hi ha coincidències</Text>
            </View>
          ) : (
            <View style={styles.routeList}>{displayedRoutes.map(renderRouteRow)}</View>
          )}
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
                  {selectedRoute ? getRouteTitle(selectedRoute) : 'Selecciona una línia'}
                </Text>
              </View>
            </View>
          ) : null}

          <Text style={styles.directionLabel}>Direcció</Text>
          <View style={[styles.directionSelector, isLandscape && styles.directionSelectorLandscape]}>
            {([0, 1] as const).map((value) => {
              const label = value === 0 ? directionNames.anada : directionNames.tornada;
              const selected = directionId === value;
              return (
                <TouchableOpacity
                  key={value}
                  style={[styles.directionOption, selected && styles.directionOptionSelected]}
                  onPress={() => setDirectionId(value)}
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
                    {label || 'Tria una línia'}
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
            accessibilityLabel="Començar ruta"
          >
            <MaterialCommunityIcons name="bus-marker" size={22} color={colors.white} />
            <View style={styles.startButtonCopy}>
              <Text style={styles.startButtonText}>Començar ruta</Text>
              <Text style={styles.startButtonMeta} numberOfLines={1}>
                {selectedRoute && directionId !== null
                  ? `${selectedRoute.route_short_name} · ${directionId === 0 ? directionNames.anada : directionNames.tornada}`
                  : 'Línia i direcció pendents'}
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
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
    justifyContent: 'flex-end',
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
  preferenceList: { marginRight: 38 },
  preferenceRow: {
    position: 'relative',
    minHeight: 34,
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
    gap: 2,
    paddingRight: spacing.lg,
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
  },
  agencyChip: {
    height: 32,
    minWidth: 62,
    paddingHorizontal: spacing.sm,
    borderRadius: 6,
    backgroundColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  agencyChipActive: { backgroundColor: colors.transitDark },
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
    overflow: 'hidden',
  },
  routeRow: {
    minHeight: 47,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    borderLeftWidth: 2,
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
});
