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
  getAgencyLabel,
  getRouteTitle,
  routeMatchesSearch,
  type AgencyFilter,
} from '../services/routePresentation';
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

function HeaderBus({ reverse = false }: { reverse?: boolean }) {
  return (
    <View style={[styles.headerBus, reverse ? styles.headerBusReverse : styles.headerBusForward]}>
      <View style={styles.headerBusBody}>
        <View style={styles.headerBusFront} />
        <View style={styles.headerBusBack} />
        <View style={styles.headerBusWindshield} />
        <View style={styles.headerBusRoofUnit} />
      </View>
    </View>
  );
}

export default function RoutesScreen({ navigation }: RoutesScreenProps) {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  const { preferences, toggleFavorite } = usePreferences();
  const { language, locale, t } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAgency, setSelectedAgency] = useState<AgencyFilter>('Tots');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    const routeResult = await apiService.fetchRoutes().catch(() => null);

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
      return (a.route_short_name || '').localeCompare(b.route_short_name || '', locale, { numeric: true });
    }), [favoriteIds, locale, routes, searchQuery, selectedAgency]);

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
      <StatusBar style="dark" />
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={t('routes.back')}
        >
          <MaterialCommunityIcons name="arrow-left" size={21} color={colors.primary} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text
            style={styles.headerTitle}
            numberOfLines={1}
          >{t('routes.title')}</Text>
        </View>
        <View style={styles.routeSketch} pointerEvents="none">
          <View style={styles.trackGroup}>
            <View style={[styles.sketchLine, styles.sketchLineOne]} />
            <View style={[styles.sketchLine, styles.sketchLineTwo]} />
            <View style={[styles.sketchStop, styles.sketchStopOne]} />
            <View style={[styles.sketchStop, styles.sketchStopTwo]} />
            <HeaderBus />
            <HeaderBus reverse />
          </View>
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{filteredRoutes.length}</Text>
          </View>
        </View>
      </View>

      <View style={[styles.catalog, isLandscape && styles.catalogLandscape]}>
        <View style={styles.searchShell}>
          <MaterialCommunityIcons name="magnify" size={21} color={colors.transitDark} />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t('routes.searchPlaceholder')}
            placeholderTextColor={colors.subtle}
            maxLength={80}
            returnKeyType="search"
            autoCorrect={false}
            accessibilityLabel={t('routes.searchA11y')}
          />
          {searchQuery ? (
            <TouchableOpacity
              onPress={() => setSearchQuery('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('routes.clearSearch')}
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
                      <Text style={[styles.agencyText, active && styles.agencyTextActive]}>
                        {getAgencyLabel(agency, language)}
                      </Text>
                    </TouchableOpacity>
                  );
                }}
              />
              <View style={styles.listHeading}>
                <Text style={styles.listHeadingTitle}>
                  {t(searchQuery || selectedAgency !== 'Tots' ? 'common.results' : 'routes.available')}
                </Text>
                <Text style={styles.listHeadingMeta}>{t('routes.selectHint')}</Text>
              </View>
            </View>
          )}
          ListEmptyComponent={loading ? (
            <View style={styles.emptyState}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.emptyText}>{t('routes.loading')}</Text>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <MaterialCommunityIcons
                name={loadFailed ? 'cloud-alert-outline' : 'bus-alert'}
                size={30}
                color={colors.muted}
              />
              <Text style={styles.emptyTitle}>
                {t(loadFailed ? 'routes.loadFailed' : 'home.noMatches')}
              </Text>
              {loadFailed ? (
                <TouchableOpacity style={styles.retryButton} onPress={() => void loadData()}>
                  <Text style={styles.retryText}>{t('routes.retry')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}
          renderItem={({ item }) => {
            const favorite = favoriteIds.has(item.route_id);
            return (
              <View style={styles.routeCard}>
                <View style={[
                  styles.routeRow,
                  { backgroundColor: routePastelColor(item.route_color, 0.075) },
                ]}>
                  <TouchableOpacity
                    style={styles.routeMain}
                    onPress={() => navigation.popTo('Home', { selectedRouteId: item.route_id })}
                    activeOpacity={0.82}
                    accessibilityRole="button"
                    accessibilityLabel={t('routes.selectA11y', {
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
                      <Text style={styles.routeMeta}>
                        {getAgencyLabel(getAgencyFilter(item), language)} · {t('routes.availableService')}
                      </Text>
                    </View>
                    <MaterialCommunityIcons name="chevron-right" size={21} color={colors.borderStrong} />
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
                      size={21}
                      color={favorite ? colors.primary : colors.transitDark}
                    />
                  </TouchableOpacity>
                </View>
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
    minHeight: 76,
    paddingHorizontal: spacing.lg,
    paddingRight: 132,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    overflow: 'hidden',
  },
  routeSketch: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 112,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackGroup: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    transform: [{ rotate: '-4deg' }],
  },
  sketchLine: {
    position: 'absolute',
    height: 1.5,
    borderRadius: 1,
    backgroundColor: colors.primary,
    opacity: 0.42,
  },
  sketchLineOne: { left: 0, right: 0, top: 14 },
  sketchLineTwo: { left: 0, right: 0, top: 40 },
  sketchStop: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.background,
    borderWidth: 1.5,
    borderColor: colors.primary,
    opacity: 0.54,
  },
  sketchStopOne: { left: 16, top: 10 },
  sketchStopTwo: { right: 11, top: 36 },
  headerBus: {
    position: 'absolute',
    width: 11,
    height: 29,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.24,
    shadowRadius: 3,
    elevation: 4,
  },
  headerBusForward: { top: 0, right: 27, transform: [{ rotate: '90deg' }] },
  headerBusReverse: { top: 26, left: 27, transform: [{ rotate: '-90deg' }] },
  headerBusBody: {
    width: 11,
    height: 29,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: colors.ink,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  headerBusFront: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 6,
    backgroundColor: '#D52B36',
  },
  headerBusBack: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    height: 5,
    backgroundColor: '#D52B36',
  },
  headerBusWindshield: {
    position: 'absolute',
    top: 2,
    right: 2,
    left: 2,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#263A42',
  },
  headerBusRoofUnit: {
    position: 'absolute',
    top: 11,
    right: 2,
    left: 2,
    height: 7,
    borderRadius: 1.5,
    borderWidth: 0.5,
    borderColor: '#A7B3AE',
    backgroundColor: '#E6E8E3',
  },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCopy: { flex: 1, minWidth: 0 },
  headerTitle: {
    color: colors.ink,
    fontFamily: fonts.hero,
    fontSize: 29,
    lineHeight: 32,
    letterSpacing: -0.7,
  },
  countBadge: {
    position: 'absolute',
    top: 18,
    left: 35,
    minWidth: 42,
    height: 21,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(241,239,232,0.94)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  countBadgeText: { fontFamily: fonts.label, color: colors.primary, fontSize: 9.5, lineHeight: 12 },
  catalog: { flex: 1, paddingHorizontal: spacing.xl },
  catalogLandscape: { paddingHorizontal: Math.max(spacing.xl, 34) },
  searchShell: {
    height: 44,
    paddingHorizontal: 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderStrong,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  searchInput: {
    flex: 1,
    height: '100%',
    paddingVertical: 0,
    color: colors.ink,
    fontFamily: fonts.body,
    fontSize: 11.5,
    lineHeight: 15,
  },
  listContent: { paddingBottom: spacing.xl },
  agencyRow: { gap: 6, paddingVertical: spacing.sm, paddingRight: spacing.xl },
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
  listHeading: { marginTop: spacing.xs, marginBottom: spacing.sm },
  listHeadingTitle: { fontFamily: fonts.display, color: colors.ink, fontSize: 15, lineHeight: 19 },
  listHeadingMeta: { fontFamily: fonts.body, color: colors.muted, fontSize: 9.5, lineHeight: 13, marginTop: 1 },
  columnWrapper: { gap: spacing.xl },
  routeCard: {
    flex: 1,
    marginBottom: spacing.xs,
    padding: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  routeRow: {
    flex: 1,
    minHeight: 50,
    borderRadius: 8,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  routeMain: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  routeBadge: {
    minWidth: 42,
    height: 27,
    paddingHorizontal: 6,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  routeBadgeText: { ...typography.badge, fontSize: 10, lineHeight: 12 },
  routeCopy: { flex: 1, minWidth: 0 },
  routeName: { fontFamily: fonts.label, color: colors.ink, fontSize: 10.5, lineHeight: 14 },
  routeMeta: { fontFamily: fonts.body, color: colors.muted, fontSize: 8.5, lineHeight: 11, marginTop: 1 },
  starButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  starButtonActive: { backgroundColor: colors.primarySoft },
  emptyState: { minHeight: 220, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { ...typography.button, color: colors.ink, marginTop: spacing.sm },
  emptyText: { ...typography.body, color: colors.muted, marginTop: spacing.sm },
  retryButton: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    height: 40,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: { ...typography.control, color: colors.white, fontSize: 12 },
});
