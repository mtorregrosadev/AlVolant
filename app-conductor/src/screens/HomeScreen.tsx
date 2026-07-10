import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type ImageSourcePropType,
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
import { cardShadow, colors, fonts, radii, safeHexColor, spacing, typography } from '../theme';

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

function sanitizeVehicleId(value: string) {
  return value.toLocaleUpperCase('ca').replace(/[^A-Z0-9-]/g, '').slice(0, 12);
}

export default function HomeScreen({ navigation, route }: HomeScreenProps) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = screenWidth > screenHeight;
  const isCompact = screenHeight < 750;
  const mountedRef = useRef(true);
  const lastRoutesFetchRef = useRef(0);

  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<RouteInfo | null>(null);
  const [directionId, setDirectionId] = useState<0 | 1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAgency, setSelectedAgency] = useState<AgencyFilter>('Tots');
  const [preferenceView, setPreferenceView] = useState<PreferenceView>('recent');
  const [preferences, setPreferences] = useState<UserPreferences>({ ...EMPTY_USER_PREFERENCES });
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [manualVehicle, setManualVehicle] = useState('');
  const [upcomingTrips, setUpcomingTrips] = useState<UpcomingTrip[]>([]);
  const [isLoadingTrips, setIsLoadingTrips] = useState(false);

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
        .slice(0, 8);
    }

    return preferences.recentRoutes
      .flatMap((recent): PreferenceRoute[] => {
        const item = byId.get(recent.routeId);
        return item ? [{ route: item, recent }] : [];
      })
      .slice(0, 8);
  }, [preferenceView, preferences, routes]);

  const maxVisibleRoutes = isLandscape ? 4 : isCompact ? 2 : 3;
  const displayedRoutes = filteredRoutes.slice(0, maxVisibleRoutes);

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

    return (
      <View key={item.route_id} style={[styles.routeRow, selected && styles.routeRowSelected]}>
        <TouchableOpacity
          style={styles.routeMain}
          onPress={() => selectRoute(item)}
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
          {selected ? <MaterialCommunityIcons name="check-circle" size={20} color={colors.transit} /> : null}
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
          contentContainerStyle={[styles.discoveryContent, isLandscape && styles.discoveryContentLandscape]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.liveBar}>
            <View style={styles.liveLabel}>
              <MaterialCommunityIcons name="access-point" size={17} color={colors.transitDark} />
              <Text style={styles.liveLabelText}>XARXA DE SERVEI</Text>
            </View>
            <View style={[styles.connectionBadge, !isConnected && styles.connectionBadgeOffline]}>
              <View style={[styles.connectionDot, { backgroundColor: isConnected ? colors.success : colors.danger }]} />
              <Text style={styles.connectionText}>{isConnected ? 'Dades en directe' : 'Sense connexió'}</Text>
            </View>
          </View>

          <View style={styles.heroPanel}>
            <View style={styles.heroRouteGraphic} pointerEvents="none">
              <View style={[styles.heroLine, styles.heroLineOne]} />
              <View style={[styles.heroLine, styles.heroLineTwo]} />
              <View style={[styles.heroStop, styles.heroStopOne]} />
              <View style={[styles.heroStop, styles.heroStopTwo]} />
            </View>
            <View style={styles.heroCopy}>
              <Text style={styles.heroEyebrow}>TORN DE CONDUCCIÓ</Text>
              <Text style={styles.heroTitle}>Quina línia toca avui?</Text>
              <Text style={styles.heroSubtitle}>Tria servei, direcció i sortida.</Text>
            </View>
            <View style={styles.heroBusBadge}>
              <MaterialCommunityIcons name="bus-side" size={39} color={colors.transitDark} />
            </View>
          </View>

          <View style={styles.searchShell}>
            <MaterialCommunityIcons name="magnify" size={21} color={colors.transitDark} />
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Cerca línia o destinació"
              placeholderTextColor={colors.subtle}
              maxLength={80}
              returnKeyType="search"
              autoCorrect={false}
              accessibilityLabel="Cercar línies"
            />
            {searchQuery ? (
              <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={8}>
                <MaterialCommunityIcons name="close-circle" size={19} color={colors.subtle} />
              </TouchableOpacity>
            ) : null}
          </View>

          <View style={styles.sectionHeading}>
            <View>
              <Text style={styles.sectionKicker}>LES TEVES LÍNIES</Text>
              <Text style={styles.sectionTitle}>Torna-hi ràpid</Text>
            </View>
          </View>

          <View style={styles.preferenceTabs}>
            <TouchableOpacity
              style={[styles.preferenceTab, preferenceView === 'recent' && styles.preferenceTabActive]}
              onPress={() => setPreferenceView('recent')}
              accessibilityRole="button"
              accessibilityState={{ selected: preferenceView === 'recent' }}
            >
              <MaterialCommunityIcons
                name="history"
                size={18}
                color={preferenceView === 'recent' ? colors.white : colors.transitDark}
              />
              <Text style={[styles.preferenceTabText, preferenceView === 'recent' && styles.preferenceTabTextActive]}>
                Recents
              </Text>
              <Text style={[styles.preferenceCount, preferenceView === 'recent' && styles.preferenceCountActive]}>
                {preferences.recentRoutes.length}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.preferenceTab, preferenceView === 'favorite' && styles.preferenceTabActive]}
              onPress={() => setPreferenceView('favorite')}
              accessibilityRole="button"
              accessibilityState={{ selected: preferenceView === 'favorite' }}
            >
              <MaterialCommunityIcons
                name="star"
                size={18}
                color={preferenceView === 'favorite' ? colors.white : colors.transitDark}
              />
              <Text style={[styles.preferenceTabText, preferenceView === 'favorite' && styles.preferenceTabTextActive]}>
                Favorites
              </Text>
              <Text style={[styles.preferenceCount, preferenceView === 'favorite' && styles.preferenceCountActive]}>
                {preferences.favoriteRouteIds.length}
              </Text>
            </TouchableOpacity>
          </View>

          {preferenceRoutes.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.preferenceRow}
            >
              {preferenceRoutes.map(({ route: item, recent }, index) => {
                const selected = selectedRoute?.route_id === item.route_id;
                const labels = getDirectionNames(item);
                const destination = recent
                  ? (recent.directionId === 0 ? labels.anada : labels.tornada)
                  : getRouteTitle(item);

                return (
                  <TouchableOpacity
                    key={`${preferenceView}-${item.route_id}`}
                    style={[
                      styles.preferenceCard,
                      index % 2 === 1 && styles.preferenceCardMint,
                      selected && styles.preferenceCardSelected,
                    ]}
                    onPress={() => selectRoute(item, recent?.directionId)}
                    activeOpacity={0.84}
                    accessibilityRole="button"
                    accessibilityLabel={`${preferenceView === 'recent' ? 'Recent' : 'Favorita'}: ${item.route_short_name}`}
                  >
                    <View style={styles.preferenceCardTop}>
                      <View style={[
                        styles.routeBadge,
                        { backgroundColor: safeHexColor(item.route_color, colors.primary) },
                      ]}>
                        <Text style={[
                          styles.routeBadgeText,
                          { color: safeHexColor(item.route_text_color, colors.white) },
                        ]}>{item.route_short_name || 'Bus'}</Text>
                      </View>
                      <MaterialCommunityIcons
                        name={preferenceView === 'recent' ? 'clock-outline' : 'star'}
                        size={18}
                        color={colors.transitDark}
                      />
                    </View>
                    <Text style={styles.preferenceCardTitle} numberOfLines={2}>{destination}</Text>
                    <Text style={styles.preferenceCardMeta}>
                      {recent ? formatRecentTime(recent.usedAt) : getAgencyFilter(item)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          ) : (
            <View style={styles.preferenceEmpty}>
              <View style={styles.preferenceEmptyIcon}>
                <MaterialCommunityIcons
                  name={preferenceView === 'recent' ? 'history' : 'star-outline'}
                  size={21}
                  color={colors.transitDark}
                />
              </View>
              <Text style={styles.preferenceEmptyText}>
                {preferenceView === 'recent'
                  ? 'Les rutes iniciades apareixeran aquí.'
                  : 'Marca l’estrella d’una línia per guardar-la.'}
              </Text>
            </View>
          )}

          <Text style={styles.operatorLabel}>OPERADOR</Text>
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

          <View style={styles.routesHeading}>
            <View>
              <Text style={styles.sectionKicker}>CATÀLEG</Text>
              <Text style={styles.sectionTitle}>
                {searchQuery || selectedAgency !== 'Tots' ? 'Resultats' : 'Línies disponibles'}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.catalogButton}
              onPress={() => navigation.navigate('Routes')}
              accessibilityRole="button"
              accessibilityLabel="Obrir totes les línies"
            >
              <Text style={styles.catalogButtonText}>Totes</Text>
              <MaterialCommunityIcons name="arrow-top-right" size={17} color={colors.white} />
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

        <View style={[styles.servicePanel, isLandscape && styles.servicePanelLandscape]}>
          <View style={styles.serviceHeader}>
            <View style={styles.serviceHeaderIcon}>
              <MaterialCommunityIcons name="steering" size={21} color={colors.white} />
            </View>
            <View style={styles.serviceHeaderCopy}>
              <Text style={styles.serviceKicker}>SERVEI A PUNT</Text>
              <Text style={styles.serviceTitle} numberOfLines={1}>
                {selectedRoute ? getRouteTitle(selectedRoute) : 'Selecciona una línia'}
              </Text>
            </View>
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
            ) : null}
          </View>

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
  contentLandscape: { flexDirection: 'row', gap: spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  discoveryPane: { flex: 1, minWidth: 0 },
  discoveryContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xl },
  discoveryContentLandscape: { paddingHorizontal: 0, paddingBottom: spacing.sm },
  liveBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  liveLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  liveLabelText: {
    ...typography.eyebrow,
    color: colors.transitDark,
  },
  connectionBadge: {
    height: 27,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: '#DDF7E8',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  connectionBadgeOffline: { backgroundColor: colors.primarySoft },
  connectionDot: { width: 7, height: 7, borderRadius: 4 },
  connectionText: { ...typography.meta, color: colors.inkSoft, fontWeight: '600' },
  heroPanel: {
    minHeight: 126,
    borderRadius: radii.xl,
    backgroundColor: colors.transit,
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  heroRouteGraphic: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, opacity: 0.24 },
  heroLine: { position: 'absolute', height: 4, borderRadius: 2, backgroundColor: colors.white },
  heroLineOne: { width: 175, right: -18, top: 26, transform: [{ rotate: '-13deg' }] },
  heroLineTwo: { width: 150, right: 22, bottom: 22, transform: [{ rotate: '19deg' }] },
  heroStop: { position: 'absolute', width: 14, height: 14, borderRadius: 7, backgroundColor: colors.sun, borderWidth: 3, borderColor: colors.white },
  heroStopOne: { right: 88, top: 16 },
  heroStopTwo: { right: 26, bottom: 15 },
  heroCopy: { flex: 1, minWidth: 0, zIndex: 1 },
  heroEyebrow: { ...typography.eyebrow, color: 'rgba(255,255,255,0.8)', fontSize: 8 },
  heroTitle: { color: colors.white, fontFamily: fonts.hero, fontSize: 27, lineHeight: 34, fontWeight: '600', marginTop: 2 },
  heroSubtitle: { ...typography.body, color: 'rgba(255,255,255,0.82)', marginTop: 2 },
  heroBusBadge: {
    width: 70,
    height: 70,
    borderRadius: 22,
    backgroundColor: colors.sun,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '3deg' }],
    zIndex: 1,
  },
  searchShell: {
    height: 51,
    marginHorizontal: spacing.md,
    marginTop: -18,
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    backgroundColor: colors.white,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    ...cardShadow,
  },
  searchInput: { ...typography.control, flex: 1, height: '100%', paddingVertical: 0, color: colors.ink, fontSize: 14, lineHeight: 18 },
  sectionHeading: { marginBottom: spacing.sm },
  sectionKicker: { ...typography.eyebrow, color: colors.primary },
  sectionTitle: { ...typography.sectionTitle, color: colors.ink, marginTop: 1 },
  preferenceTabs: {
    height: 43,
    padding: 4,
    borderRadius: radii.md,
    backgroundColor: colors.transitWash,
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  preferenceTab: {
    flex: 1,
    borderRadius: radii.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  preferenceTabActive: { backgroundColor: colors.transitDark },
  preferenceTabText: { ...typography.control, color: colors.transitDark },
  preferenceTabTextActive: { color: colors.white },
  preferenceCount: { ...typography.meta, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.white, color: colors.transitDark, textAlign: 'center', lineHeight: 20, fontWeight: '700' },
  preferenceCountActive: { backgroundColor: colors.primary, color: colors.white },
  preferenceRow: { gap: spacing.sm, paddingRight: spacing.lg, paddingBottom: spacing.xs, marginBottom: spacing.lg },
  preferenceCard: {
    width: 168,
    minHeight: 94,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.primarySoft,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  preferenceCardMint: { backgroundColor: colors.transitSoft },
  preferenceCardSelected: { borderColor: colors.transitDark },
  preferenceCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  preferenceCardTitle: { ...typography.cardTitle, color: colors.ink },
  preferenceCardMeta: { ...typography.meta, color: colors.muted, marginTop: 3 },
  preferenceEmpty: {
    minHeight: 72,
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  preferenceEmptyIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.transitWash, alignItems: 'center', justifyContent: 'center' },
  preferenceEmptyText: { ...typography.body, flex: 1, color: colors.inkSoft },
  operatorLabel: { ...typography.eyebrow, color: colors.primary, marginBottom: spacing.sm },
  agencyRow: { gap: spacing.sm, paddingRight: spacing.lg, paddingBottom: spacing.xs, marginBottom: spacing.lg },
  agencyChip: {
    height: 38,
    minWidth: 90,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  agencyChipActive: { backgroundColor: colors.transitDark, borderColor: colors.transitDark },
  agencyLogo: { width: 23, height: 18 },
  agencyText: { ...typography.control, color: colors.inkSoft },
  agencyTextActive: { color: colors.white },
  routesHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  catalogButton: { height: 35, paddingHorizontal: spacing.md, borderRadius: radii.md, backgroundColor: colors.primary, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  catalogButtonText: { ...typography.control, color: colors.white, fontSize: 10 },
  routeList: { gap: spacing.sm },
  routeRow: { minHeight: 63, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center' },
  routeRowSelected: { borderColor: colors.transit, backgroundColor: colors.transitWash },
  routeMain: { flex: 1, minWidth: 0, minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  routeBadge: { minWidth: 47, height: 29, paddingHorizontal: spacing.sm, borderRadius: radii.sm, alignItems: 'center', justifyContent: 'center' },
  routeBadgeText: { ...typography.badge },
  routeCopy: { flex: 1, minWidth: 0 },
  routeName: { ...typography.cardTitle, color: colors.ink },
  routeMeta: { ...typography.meta, color: colors.muted, marginTop: 2 },
  starButton: { width: 37, height: 37, borderRadius: radii.md, backgroundColor: colors.transitWash, alignItems: 'center', justifyContent: 'center' },
  starButtonActive: { backgroundColor: colors.primarySoft },
  loadingState: { minHeight: 100, alignItems: 'center', justifyContent: 'center' },
  loadingText: { ...typography.body, color: colors.muted, marginTop: spacing.sm },
  emptyRoutes: { minHeight: 90, alignItems: 'center', justifyContent: 'center', borderRadius: radii.lg, backgroundColor: colors.white },
  emptyRoutesText: { ...typography.body, color: colors.muted, marginTop: spacing.xs },
  servicePanel: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    backgroundColor: colors.white,
    ...cardShadow,
  },
  servicePanelLandscape: { width: '39%', maxWidth: 400, minWidth: 290, borderRadius: radii.xl, justifyContent: 'center', alignSelf: 'stretch' },
  serviceHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  serviceHeaderIcon: { width: 38, height: 38, borderRadius: radii.md, backgroundColor: colors.transit, alignItems: 'center', justifyContent: 'center' },
  serviceHeaderCopy: { flex: 1, minWidth: 0 },
  serviceKicker: { ...typography.eyebrow, color: colors.primary },
  serviceTitle: { ...typography.cardTitle, color: colors.ink, marginTop: 1 },
  serviceRouteBadge: { minWidth: 50, height: 31, paddingHorizontal: spacing.sm, borderRadius: radii.sm, alignItems: 'center', justifyContent: 'center' },
  serviceRouteBadgeText: { ...typography.badge, fontSize: 13 },
  directionLabel: { ...typography.meta, color: colors.muted, fontWeight: '600', marginBottom: 5 },
  directionSelector: { padding: 4, borderRadius: radii.md, backgroundColor: colors.transitWash, flexDirection: 'row', gap: 4, marginBottom: spacing.sm },
  directionSelectorLandscape: { flexDirection: 'column' },
  directionOption: { flex: 1, minHeight: 51, paddingHorizontal: spacing.sm, borderRadius: radii.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  directionOptionSelected: { backgroundColor: colors.white, ...cardShadow },
  directionNumber: { width: 27, height: 27, borderRadius: 14, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  directionNumberSelected: { backgroundColor: colors.primary },
  directionNumberText: { ...typography.control, color: colors.transitDark, fontSize: 10 },
  directionNumberTextSelected: { color: colors.white },
  directionText: { ...typography.control, flex: 1, color: colors.inkSoft },
  directionTextSelected: { color: colors.ink },
  startButton: { minHeight: 55, paddingHorizontal: spacing.lg, borderRadius: radii.md, backgroundColor: colors.primary, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  startButtonDisabled: { backgroundColor: '#A7B9BF' },
  startButtonCopy: { flex: 1, minWidth: 0 },
  startButtonText: { ...typography.button, color: colors.white },
  startButtonMeta: { ...typography.meta, color: 'rgba(255,255,255,0.82)', marginTop: 1 },
});
