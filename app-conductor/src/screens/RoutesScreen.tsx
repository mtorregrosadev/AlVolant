import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
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
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { apiService, type RouteInfo } from '../services/api';
import {
  AGENCY_OPTIONS,
  getAgencyFilter,
  getRouteTitle,
  routeMatchesSearch,
  type AgencyFilter,
} from '../services/routePresentation';
import {
  EMPTY_USER_PREFERENCES,
  loadUserPreferences,
  saveUserPreferences,
  withToggledFavorite,
  type UserPreferences,
} from '../services/userPreferences';
import { cardShadow, colors, fonts, radii, safeHexColor, spacing } from '../theme';

type RoutesScreenProps = NativeStackScreenProps<RootStackParamList, 'Routes'>;
type ChipVisual = {
  icon?: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  image?: ImageSourcePropType;
};

const AGENCY_VISUALS: Record<AgencyFilter, ChipVisual> = {
  Tots: { icon: 'transit-connection-variant' },
  TMB: { image: require('../../assets/logo-tmb.png') },
  AMB: { image: require('../../assets/logo-amb.png') },
  FGC: { image: require('../../assets/logo_fgc.png') },
  Rodalies: { image: require('../../assets/logo_rodalies.png') },
  Altres: { icon: 'bus-multiple' },
};

export default function RoutesScreen({ navigation }: RoutesScreenProps) {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  const [preferences, setPreferences] = useState<UserPreferences>({ ...EMPTY_USER_PREFERENCES });
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAgency, setSelectedAgency] = useState<AgencyFilter>('Tots');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    const [storedPreferences, routeResult] = await Promise.all([
      loadUserPreferences(),
      apiService.fetchRoutes().catch(() => null),
    ]);

    setPreferences(storedPreferences);
    if (routeResult) {
      setRoutes(routeResult);
    } else {
      setLoadFailed(true);
    }
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => {
    void loadData();
  }, [loadData]));

  const favoriteIds = useMemo(
    () => new Set(preferences.favoriteRouteIds),
    [preferences.favoriteRouteIds],
  );

  const availableAgencies = useMemo(() => {
    const present = new Set<AgencyFilter>();
    routes.forEach((route) => present.add(getAgencyFilter(route)));
    return AGENCY_OPTIONS.filter((agency) => agency === 'Tots' || present.has(agency));
  }, [routes]);

  const filteredRoutes = useMemo(() => routes
    .filter((route) => routeMatchesSearch(route, searchQuery))
    .filter((route) => selectedAgency === 'Tots' || getAgencyFilter(route) === selectedAgency)
    .sort((a, b) => {
      const favoriteOrder = Number(favoriteIds.has(b.route_id)) - Number(favoriteIds.has(a.route_id));
      if (favoriteOrder) return favoriteOrder;
      return (a.route_short_name || '').localeCompare(b.route_short_name || '', 'ca', { numeric: true });
    }), [favoriteIds, routes, searchQuery, selectedAgency]);

  const toggleFavorite = useCallback((routeId: string) => {
    setPreferences((current) => {
      const next = withToggledFavorite(current, routeId);
      void saveUserPreferences(next);
      return next;
    });
  }, []);

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

  return (
    <SafeAreaView style={styles.container} edges={['top', 'right', 'bottom', 'left']}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View style={styles.routeSketch} pointerEvents="none">
          <View style={[styles.sketchLine, styles.sketchLineOne]} />
          <View style={[styles.sketchLine, styles.sketchLineTwo]} />
          <View style={[styles.sketchStop, styles.sketchStopOne]} />
          <View style={[styles.sketchStop, styles.sketchStopTwo]} />
        </View>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Tornar a l’inici"
        >
          <MaterialCommunityIcons name="arrow-left" size={22} color={colors.transitDark} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.headerKicker}>CATÀLEG DE SERVEI</Text>
          <Text style={styles.headerTitle}>Totes les línies</Text>
        </View>
        <View style={styles.countBadge}>
          <Text style={styles.countBadgeText}>{filteredRoutes.length}</Text>
        </View>
      </View>

      <View style={[styles.catalog, isLandscape && styles.catalogLandscape]}>
        <View style={styles.searchShell}>
          <MaterialCommunityIcons name="magnify" size={21} color={colors.transitDark} />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Línia, destinació o codi"
            placeholderTextColor={colors.subtle}
            maxLength={80}
            returnKeyType="search"
            autoCorrect={false}
            accessibilityLabel="Cercar al catàleg de línies"
          />
          {searchQuery ? (
            <TouchableOpacity
              onPress={() => setSearchQuery('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Esborrar cerca"
            >
              <MaterialCommunityIcons name="close-circle" size={19} color={colors.subtle} />
            </TouchableOpacity>
          ) : null}
        </View>

        <FlatList
          key={isLandscape ? 'landscape-grid' : 'portrait-list'}
          data={filteredRoutes}
          numColumns={isLandscape ? 2 : 1}
          keyExtractor={(item) => item.route_id}
          columnWrapperStyle={isLandscape ? styles.columnWrapper : undefined}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={18}
          windowSize={8}
          ListHeaderComponent={(
            <View>
              <FlatList
                horizontal
                data={availableAgencies}
                keyExtractor={(item) => item}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.agencyRow}
                renderItem={({ item: agency }) => {
                  const active = selectedAgency === agency;
                  return (
                    <TouchableOpacity
                      style={[styles.agencyChip, active && styles.agencyChipActive]}
                      onPress={() => setSelectedAgency(agency)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      {renderAgencyVisual(agency, active)}
                      <Text style={[styles.agencyText, active && styles.agencyTextActive]}>{agency}</Text>
                    </TouchableOpacity>
                  );
                }}
              />
              <View style={styles.listHeading}>
                <Text style={styles.listHeadingTitle}>
                  {searchQuery || selectedAgency !== 'Tots' ? 'Resultats' : 'Línies disponibles'}
                </Text>
                <Text style={styles.listHeadingMeta}>Toca una línia per seleccionar-la</Text>
              </View>
            </View>
          )}
          ListEmptyComponent={loading ? (
            <View style={styles.emptyState}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.emptyText}>Carregant el catàleg…</Text>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <MaterialCommunityIcons
                name={loadFailed ? 'cloud-alert-outline' : 'bus-alert'}
                size={30}
                color={colors.muted}
              />
              <Text style={styles.emptyTitle}>
                {loadFailed ? 'No hem pogut carregar les línies' : 'No hi ha coincidències'}
              </Text>
              {loadFailed ? (
                <TouchableOpacity style={styles.retryButton} onPress={() => void loadData()}>
                  <Text style={styles.retryText}>Tornar-ho a provar</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}
          renderItem={({ item }) => {
            const favorite = favoriteIds.has(item.route_id);
            return (
              <View style={styles.routeRow}>
                <TouchableOpacity
                  style={styles.routeMain}
                  onPress={() => navigation.popTo('Home', { selectedRouteId: item.route_id })}
                  activeOpacity={0.82}
                  accessibilityRole="button"
                  accessibilityLabel={`Seleccionar línia ${item.route_short_name}, ${getRouteTitle(item)}`}
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
                    <Text style={styles.routeMeta}>{getAgencyFilter(item)} · servei disponible</Text>
                  </View>
                  <MaterialCommunityIcons name="chevron-right" size={21} color={colors.borderStrong} />
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
                    size={21}
                    color={favorite ? colors.primary : colors.transitDark}
                  />
                </TouchableOpacity>
              </View>
            );
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    minHeight: 106,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    backgroundColor: colors.transit,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    overflow: 'hidden',
  },
  routeSketch: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, opacity: 0.22 },
  sketchLine: {
    position: 'absolute',
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.white,
  },
  sketchLineOne: { width: 190, right: -28, top: 23, transform: [{ rotate: '-10deg' }] },
  sketchLineTwo: { width: 150, right: 42, bottom: 15, transform: [{ rotate: '18deg' }] },
  sketchStop: {
    position: 'absolute',
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: colors.sun,
    borderWidth: 3,
    borderColor: colors.white,
  },
  sketchStopOne: { right: 79, top: 15 },
  sketchStopTwo: { right: 28, bottom: 10 },
  backButton: {
    width: 42,
    height: 42,
    borderRadius: radii.md,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCopy: { flex: 1, minWidth: 0 },
  headerKicker: {
    color: 'rgba(255,255,255,0.82)',
    fontFamily: fonts.mono,
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  headerTitle: {
    color: colors.white,
    fontFamily: fonts.display,
    fontSize: 25,
    lineHeight: 31,
    fontWeight: '600',
  },
  countBadge: {
    minWidth: 50,
    height: 34,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: { color: colors.white, fontFamily: fonts.mono, fontSize: 12, fontWeight: '700' },
  catalog: { flex: 1, paddingHorizontal: spacing.lg },
  catalogLandscape: { paddingHorizontal: Math.max(spacing.xl, 34) },
  searchShell: {
    height: 52,
    marginTop: -13,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.white,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    ...cardShadow,
  },
  searchInput: {
    flex: 1,
    height: '100%',
    paddingVertical: 0,
    color: colors.ink,
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: '600',
  },
  listContent: { paddingBottom: spacing.xl },
  agencyRow: { gap: spacing.sm, paddingVertical: spacing.lg, paddingRight: spacing.xl },
  agencyChip: {
    height: 38,
    minWidth: 90,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.canvas,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  agencyChipActive: { backgroundColor: colors.transitDark, borderColor: colors.transitDark },
  agencyLogo: { width: 22, height: 18 },
  agencyText: { color: colors.inkSoft, fontFamily: fonts.body, fontSize: 11, fontWeight: '700' },
  agencyTextActive: { color: colors.white },
  listHeading: { marginBottom: spacing.md },
  listHeadingTitle: { color: colors.ink, fontFamily: fonts.display, fontSize: 20, fontWeight: '600' },
  listHeadingMeta: { color: colors.muted, fontFamily: fonts.body, fontSize: 10, marginTop: 1 },
  columnWrapper: { gap: spacing.md },
  routeRow: {
    flex: 1,
    minHeight: 70,
    marginBottom: spacing.sm,
    borderRadius: radii.lg,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
  },
  routeMain: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  routeBadge: {
    minWidth: 48,
    height: 31,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  routeBadgeText: { fontFamily: fonts.body, fontSize: 13, fontWeight: '800' },
  routeCopy: { flex: 1, minWidth: 0 },
  routeName: { color: colors.ink, fontFamily: fonts.body, fontSize: 13, fontWeight: '700' },
  routeMeta: { color: colors.muted, fontFamily: fonts.body, fontSize: 9, marginTop: 2 },
  starButton: {
    width: 38,
    height: 38,
    borderRadius: radii.md,
    backgroundColor: colors.transitWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  starButtonActive: { backgroundColor: colors.primarySoft },
  emptyState: { minHeight: 220, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { color: colors.ink, fontFamily: fonts.body, fontSize: 14, fontWeight: '700', marginTop: spacing.sm },
  emptyText: { color: colors.muted, fontFamily: fonts.body, fontSize: 12, marginTop: spacing.sm },
  retryButton: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    height: 40,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: { color: colors.white, fontFamily: fonts.body, fontSize: 12, fontWeight: '700' },
});
