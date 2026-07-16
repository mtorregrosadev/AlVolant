import React, { useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import AgencyLogo from '../components/AgencyLogo';
import LanguageFlag from '../components/LanguageFlag';
import { usePreferences } from '../PreferencesContext';
import { useI18n, type TranslationKey } from '../i18n';
import {
  HOME_AGENCIES,
  type AppLanguage,
  type HomeAgency,
  type RouteLineColor,
  type VehicleColor,
  type VehicleMarker,
} from '../services/userPreferences';
import { getAgencyLabel } from '../services/routePresentation';
import {
  requestBackgroundRoutePermission,
  stopBackgroundRouteTracking,
} from '../services/backgroundRoute';
import {
  colors,
  fonts,
  radii,
  spacing,
  typography,
  routeLinePresetColors,
  vehicleAccentColor,
} from '../theme';

type SettingsScreenProps = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const LANGUAGE_OPTIONS: Array<{ value: AppLanguage; key: TranslationKey }> = [
  { value: 'ca', key: 'settings.catalan' },
  { value: 'es', key: 'settings.spanish' },
  { value: 'gl', key: 'settings.galician' },
  { value: 'eu', key: 'settings.basque' },
];

const VEHICLE_OPTIONS: Array<{ value: VehicleColor; key: TranslationKey }> = [
  { value: 'red', key: 'settings.red' },
  { value: 'yellow', key: 'settings.yellow' },
  { value: 'green', key: 'settings.green' },
  { value: 'route', key: 'settings.routeColor' },
];

const ROUTE_LINE_OPTIONS: Array<{ value: RouteLineColor; key: TranslationKey }> = [
  { value: 'red', key: 'settings.red' },
  { value: 'yellow', key: 'settings.yellow' },
  { value: 'green', key: 'settings.green' },
  { value: 'blue', key: 'settings.blue' },
  { value: 'white', key: 'settings.white' },
];

const MARKER_OPTIONS: Array<{
  value: VehicleMarker;
  key: TranslationKey;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
}> = [
  { value: 'bus', key: 'settings.vehicleMarker', icon: 'bus' },
  { value: 'arrow', key: 'settings.arrowMarker', icon: 'navigation' },
];

function MapMarkerPreview({ accent, marker }: { accent: string; marker: VehicleMarker }) {
  return (
    <View style={styles.previewStage} accessible={false}>
      <View style={styles.previewTrack} />
      <View style={styles.previewTrackSecondary} />
      {marker === 'bus' ? (
        <>
          <View style={styles.previewBusShadow} />
          <View style={styles.previewBus}>
            <View style={[styles.previewAccentFront, { backgroundColor: accent }]} />
            <View style={[styles.previewAccentBack, { backgroundColor: accent }]} />
            <View style={[styles.previewAccentLeft, { backgroundColor: accent }]} />
            <View style={[styles.previewAccentRight, { backgroundColor: accent }]} />
            <View style={styles.previewWindshield} />
            <View style={styles.previewRearWindow} />
            <View style={styles.previewRoofUnit} />
          </View>
        </>
      ) : (
        <View style={styles.previewArrow}>
          <MaterialCommunityIcons name="navigation" size={56} color={accent} />
        </View>
      )}
    </View>
  );
}

export default function SettingsScreen({ navigation }: SettingsScreenProps) {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const {
    preferences,
    setBackgroundLocationEnabled,
    setKeepAwakeEnabled,
    setLiveActivitiesEnabled,
    setBuildings3dEnabled,
    setRouteLineDynamic,
    setRouteLineColor,
    setLanguage,
    setHomeAgencies,
    setVehicleColor,
    setVehicleMarker,
  } = usePreferences();
  const { t } = useI18n();
  const [requestingBackgroundPermission, setRequestingBackgroundPermission] = useState(false);
  const previewAccent = vehicleAccentColor(preferences.vehicleColor);

  const toggleHomeAgency = (agency: HomeAgency) => {
    const selected = preferences.homeAgencyIds.includes(agency);
    if (selected && preferences.homeAgencyIds.length === 1) return;

    setHomeAgencies(selected
      ? preferences.homeAgencyIds.filter((item) => item !== agency)
      : [...preferences.homeAgencyIds, agency]);
  };

  const handleBackgroundLocationChange = async (enabled: boolean) => {
    if (!enabled) {
      setBackgroundLocationEnabled(false);
      void stopBackgroundRouteTracking();
      return;
    }

    setRequestingBackgroundPermission(true);
    try {
      const result = await requestBackgroundRoutePermission();
      if (result === 'granted') {
        setBackgroundLocationEnabled(true);
        return;
      }

      if (result === 'unavailable') {
        Alert.alert(
          t('settings.backgroundUnavailableTitle'),
          t('settings.backgroundUnavailableHint'),
          [{ text: t('settings.notNow') }],
        );
        return;
      }

      Alert.alert(
        t('settings.permissionDeniedTitle'),
        t('settings.permissionDeniedHint'),
        [
          { text: t('settings.notNow'), style: 'cancel' },
          {
            text: t('settings.openSystemSettings'),
            onPress: () => { void Linking.openSettings(); },
          },
        ],
      );
    } finally {
      setRequestingBackgroundPermission(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'right', 'bottom', 'left']}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={t('settings.back')}
        >
          <MaterialCommunityIcons name="arrow-left" size={21} color={colors.primary} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>{t('settings.title')}</Text>
          <Text style={styles.subtitle}>{t('settings.subtitle')}</Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          isLandscape && styles.contentLandscape,
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.settingsGrid, isLandscape && styles.settingsGridLandscape]}>
          <View style={[styles.card, isLandscape && styles.cardLandscape]}>
            <View style={styles.cardHeading}>
              <View style={styles.cardIcon}>
                <MaterialCommunityIcons name="translate" size={19} color={colors.primary} />
              </View>
              <View style={styles.cardHeadingCopy}>
                <Text style={styles.cardTitle}>{t('settings.language')}</Text>
                <Text style={styles.cardHint}>{t('settings.languageHint')}</Text>
              </View>
            </View>

            <View style={styles.languageGrid}>
              {LANGUAGE_OPTIONS.map((option) => {
                const selected = preferences.language === option.value;
                const label = t(option.key);
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[styles.languageOption, selected && styles.languageOptionSelected]}
                    onPress={() => setLanguage(option.value)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={selected ? t('settings.selected', { value: label }) : label}
                  >
                    <LanguageFlag language={option.value} size="compact" />
                    <Text style={[styles.languageOptionText, selected && styles.languageOptionTextSelected]}>{label}</Text>
                    {selected ? (
                      <MaterialCommunityIcons
                        name="check-circle"
                        size={15}
                        color={colors.white}
                        style={styles.languageOptionCheck}
                      />
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={[styles.card, isLandscape && styles.cardLandscape]}>
            <View style={styles.cardHeading}>
              <View style={styles.cardIcon}>
                <MaterialCommunityIcons name="home-variant-outline" size={19} color={colors.primary} />
              </View>
              <View style={styles.cardHeadingCopy}>
                <Text style={styles.cardTitle}>{t('settings.home')}</Text>
                <Text style={styles.cardHint}>{t('settings.homeHint')}</Text>
              </View>
            </View>

            <Text style={styles.homeAgencyLabel}>{t('settings.homeAgency')}</Text>
            <View style={styles.homeAgencyGrid}>
              {HOME_AGENCIES.map((agency: HomeAgency) => {
                const selected = preferences.homeAgencyIds.includes(agency);
                const label = getAgencyLabel(agency, preferences.language);
                return (
                  <TouchableOpacity
                    key={agency}
                    style={[styles.homeAgencyOption, selected && styles.homeAgencyOptionSelected]}
                    onPress={() => toggleHomeAgency(agency)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={selected ? t('settings.selected', { value: label }) : label}
                  >
                    <AgencyLogo agency={agency} color={selected ? colors.white : colors.primary} size="large" />
                    <Text style={[styles.homeAgencyText, selected && styles.homeAgencyTextSelected]}>
                      {label}
                    </Text>
                    {selected ? (
                      <MaterialCommunityIcons
                        name="check-circle"
                        size={16}
                        color={colors.white}
                        style={styles.homeAgencyCheck}
                      />
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={[styles.card, styles.vehicleCard, isLandscape && styles.cardLandscape]}>
            <View style={styles.cardHeading}>
              <View style={styles.cardIcon}>
                <MaterialCommunityIcons name="bus" size={19} color={colors.primary} />
              </View>
              <View style={styles.cardHeadingCopy}>
                <Text style={styles.cardTitle}>{t('settings.vehicle')}</Text>
                <Text style={styles.cardHint}>{t('settings.vehicleHint')}</Text>
              </View>
            </View>

            <MapMarkerPreview accent={previewAccent} marker={preferences.vehicleMarker} />

            <View style={styles.markerControl}>
              <Text style={styles.homeAgencyLabel}>{t('settings.mapMarker')}</Text>
              <Text style={styles.markerHint}>{t('settings.mapMarkerHint')}</Text>
              <View style={styles.segmentedControl}>
                {MARKER_OPTIONS.map((option) => {
                  const selected = preferences.vehicleMarker === option.value;
                  const label = t(option.key);
                  return (
                    <TouchableOpacity
                      key={option.value}
                      style={[styles.segment, selected && styles.segmentSelected]}
                      onPress={() => setVehicleMarker(option.value)}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={selected ? t('settings.selected', { value: label }) : label}
                    >
                      <MaterialCommunityIcons
                        name={option.icon}
                        size={17}
                        color={selected ? colors.white : colors.primary}
                      />
                      <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <View style={styles.colorGrid}>
              {VEHICLE_OPTIONS.map((option) => {
                const selected = preferences.vehicleColor === option.value;
                const label = t(option.key);
                const accent = vehicleAccentColor(option.value);
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[styles.colorOption, selected && styles.colorOptionSelected]}
                    onPress={() => setVehicleColor(option.value)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={selected ? t('settings.selected', { value: label }) : label}
                  >
                    <View style={[styles.colorSwatch, { backgroundColor: accent }]}>
                      {selected ? <MaterialCommunityIcons name="check" size={15} color={colors.white} /> : null}
                    </View>
                    <Text style={[styles.colorLabel, selected && styles.colorLabelSelected]}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={[styles.preferenceRow, styles.buildingPreference]}>
              <View style={styles.preferenceCopy}>
                <Text style={styles.preferenceTitle}>{t('settings.buildingRelief')}</Text>
                <Text style={styles.preferenceHint}>{t('settings.buildingReliefHint')}</Text>
              </View>
              <Switch
                value={preferences.buildings3dEnabled}
                onValueChange={setBuildings3dEnabled}
                trackColor={{ false: '#AABEB4', true: colors.primary }}
                thumbColor={colors.white}
                ios_backgroundColor="#AABEB4"
                accessibilityLabel={t('settings.buildingRelief')}
              />
            </View>

            <View style={[styles.preferenceRow, styles.routeLinePreference]}>
              <View style={styles.preferenceCopy}>
                <Text style={styles.preferenceTitle}>{t('settings.dynamicRouteColor')}</Text>
                <Text style={styles.preferenceHint}>{t('settings.dynamicRouteColorHint')}</Text>
              </View>
              <Switch
                value={preferences.routeLineDynamic}
                onValueChange={setRouteLineDynamic}
                trackColor={{ false: '#AABEB4', true: colors.primary }}
                thumbColor={colors.white}
                ios_backgroundColor="#AABEB4"
                accessibilityLabel={t('settings.dynamicRouteColor')}
              />
            </View>

            {!preferences.routeLineDynamic ? (
              <View style={styles.routeLineColorPicker}>
                <Text style={styles.fixedRouteColorLabel}>{t('settings.fixedRouteColor')}</Text>
                <View style={styles.colorGrid}>
                  {ROUTE_LINE_OPTIONS.map((option) => {
                    const selected = preferences.routeLineColor === option.value;
                    const label = t(option.key);
                    const color = routeLinePresetColors[option.value];
                    return (
                      <TouchableOpacity
                        key={option.value}
                        style={[styles.colorOption, selected && styles.colorOptionSelected]}
                        onPress={() => setRouteLineColor(option.value)}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        accessibilityLabel={selected ? t('settings.selected', { value: label }) : label}
                      >
                        <View style={[
                          styles.colorSwatch,
                          { backgroundColor: color },
                          option.value === 'white' && styles.whiteColorSwatch,
                        ]}>
                          {selected ? <MaterialCommunityIcons name="check" size={15} color={option.value === 'yellow' || option.value === 'white' ? colors.ink : colors.white} /> : null}
                        </View>
                        <Text style={[styles.colorLabel, selected && styles.colorLabelSelected]}>{label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </View>

          <View style={[
            styles.card,
            isLandscape && styles.cardLandscape,
            isLandscape && styles.routePreferencesCardLandscape,
          ]}>
            <View style={styles.cardHeading}>
              <View style={styles.cardIcon}>
                <MaterialCommunityIcons name="navigation-variant" size={19} color={colors.primary} />
              </View>
              <View style={styles.cardHeadingCopy}>
                <Text style={styles.cardTitle}>{t('settings.routeBehavior')}</Text>
                <Text style={styles.cardHint}>{t('settings.routeBehaviorHint')}</Text>
              </View>
            </View>

            <View style={styles.preferenceRows}>
              <View style={styles.preferenceRow}>
                <View style={styles.preferenceCopy}>
                  <Text style={styles.preferenceTitle}>{t('settings.backgroundLocation')}</Text>
                  <Text style={styles.preferenceHint}>{t('settings.backgroundLocationHint')}</Text>
                </View>
                <Switch
                  value={preferences.backgroundLocationEnabled}
                  disabled={requestingBackgroundPermission}
                  onValueChange={(enabled) => { void handleBackgroundLocationChange(enabled); }}
                  trackColor={{ false: '#AABEB4', true: colors.primary }}
                  thumbColor={colors.white}
                  ios_backgroundColor="#AABEB4"
                  accessibilityLabel={t('settings.backgroundLocation')}
                />
              </View>

              <View style={[styles.preferenceRow, styles.preferenceRowBorder]}>
                <View style={styles.preferenceCopy}>
                  <Text style={styles.preferenceTitle}>{t('settings.keepScreenAwake')}</Text>
                  <Text style={styles.preferenceHint}>{t('settings.keepScreenAwakeHint')}</Text>
                </View>
                <Switch
                  value={preferences.keepAwakeEnabled}
                  onValueChange={setKeepAwakeEnabled}
                  trackColor={{ false: '#AABEB4', true: colors.primary }}
                  thumbColor={colors.white}
                  ios_backgroundColor="#AABEB4"
                  accessibilityLabel={t('settings.keepScreenAwake')}
                />
              </View>

              {Platform.OS === 'ios' ? (
                <View style={[styles.preferenceRow, styles.preferenceRowBorder]}>
                  <View style={styles.preferenceCopy}>
                    <Text style={styles.preferenceTitle}>{t('settings.liveActivities')}</Text>
                    <Text style={styles.preferenceHint}>{t('settings.liveActivitiesHint')}</Text>
                  </View>
                  <Switch
                    value={preferences.liveActivitiesEnabled}
                    onValueChange={setLiveActivitiesEnabled}
                    trackColor={{ false: '#AABEB4', true: colors.primary }}
                    thumbColor={colors.white}
                    ios_backgroundColor="#AABEB4"
                    accessibilityLabel={t('settings.liveActivities')}
                  />
                </View>
              ) : null}
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  header: {
    minHeight: 86,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCopy: { flex: 1, minWidth: 0 },
  title: {
    color: colors.ink,
    fontFamily: fonts.hero,
    fontSize: 30,
    lineHeight: 32,
    letterSpacing: -0.65,
  },
  subtitle: { ...typography.body, color: colors.muted, marginTop: 1 },
  content: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    padding: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  contentLandscape: { paddingTop: spacing.md },
  settingsGrid: { gap: spacing.md },
  settingsGridLandscape: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
  card: {
    minWidth: 0,
    padding: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cardLandscape: { flex: 1 },
  vehicleCard: { overflow: 'hidden' },
  routePreferencesCardLandscape: { flexBasis: '100%' },
  cardHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  cardIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardHeadingCopy: { flex: 1, minWidth: 0 },
  cardTitle: { ...typography.sectionTitle, color: colors.ink, fontSize: 17, lineHeight: 21 },
  cardHint: { ...typography.body, color: colors.muted, fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  segmentedControl: {
    marginTop: spacing.lg,
    padding: 3,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceMuted,
    flexDirection: 'row',
    gap: 3,
  },
  segment: {
    flex: 1,
    minHeight: 44,
    borderRadius: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  segmentSelected: { backgroundColor: colors.primary },
  segmentText: { ...typography.control, color: colors.inkSoft, fontSize: 13 },
  segmentTextSelected: { color: colors.white },
  languageGrid: { marginTop: spacing.lg, flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  languageOption: {
    width: '48.5%',
    minHeight: 48,
    paddingHorizontal: spacing.sm,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    position: 'relative',
  },
  languageOptionSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  languageOptionText: { ...typography.control, color: colors.inkSoft, fontSize: 12 },
  languageOptionTextSelected: { color: colors.white },
  languageOptionCheck: { position: 'absolute', top: 5, right: 5 },
  previewStage: {
    height: 146,
    marginTop: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.primaryWash,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewTrack: {
    position: 'absolute',
    width: '130%',
    height: 1.5,
    backgroundColor: colors.primary,
    opacity: 0.28,
    transform: [{ rotate: '-7deg' }],
  },
  previewTrackSecondary: {
    position: 'absolute',
    width: '130%',
    height: 1.5,
    marginTop: 60,
    backgroundColor: colors.primary,
    opacity: 0.18,
    transform: [{ rotate: '-7deg' }],
  },
  previewBusShadow: {
    position: 'absolute',
    width: 31,
    height: 88,
    borderRadius: 9,
    backgroundColor: 'rgba(32,37,32,0.18)',
    transform: [{ translateX: 7 }, { translateY: 8 }, { rotate: '13deg' }],
  },
  previewBus: {
    width: 31,
    height: 88,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#111F38',
    backgroundColor: colors.white,
    overflow: 'hidden',
    transform: [{ rotate: '13deg' }],
  },
  previewArrow: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#202520',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.14,
    shadowRadius: 8,
    elevation: 3,
  },
  previewAccentFront: { position: 'absolute', top: 0, left: 0, right: 0, height: 17 },
  previewAccentBack: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 16 },
  previewAccentLeft: { position: 'absolute', top: 17, bottom: 16, left: 0, width: 5 },
  previewAccentRight: { position: 'absolute', top: 17, bottom: 16, right: 0, width: 5 },
  previewWindshield: {
    position: 'absolute', top: 6, left: 5, right: 5, height: 6, borderRadius: 2, backgroundColor: '#1E293B',
  },
  previewRearWindow: {
    position: 'absolute', bottom: 5, left: 5, right: 5, height: 5, borderRadius: 2, backgroundColor: '#1E293B',
  },
  previewRoofUnit: {
    position: 'absolute', top: 31, left: 8, right: 8, height: 18, borderRadius: 4,
    borderWidth: 1, borderColor: '#94A3B8', backgroundColor: '#E2E8F0',
  },
  colorGrid: { marginTop: spacing.md, flexDirection: 'row', gap: spacing.xs },
  buildingPreference: { marginTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  routeLinePreference: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  routeLineColorPicker: { paddingBottom: spacing.xs },
  fixedRouteColorLabel: { ...typography.control, color: colors.ink, fontSize: 13 },
  markerControl: { marginTop: spacing.md },
  markerHint: { ...typography.body, color: colors.muted, fontSize: 12, lineHeight: 16, marginTop: 2 },
  homeAgencyLabel: { ...typography.control, color: colors.ink, fontSize: 13, lineHeight: 17, marginTop: spacing.lg },
  homeAgencyGrid: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  homeAgencyOption: {
    width: '31%',
    flexShrink: 0,
    aspectRatio: 1,
    minHeight: 88,
    padding: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  homeAgencyOptionSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  homeAgencyText: { ...typography.control, color: colors.inkSoft, fontSize: 12, lineHeight: 15, textAlign: 'center' },
  homeAgencyTextSelected: { color: colors.white },
  homeAgencyCheck: { position: 'absolute', top: 7, right: 7 },
  colorOption: {
    flex: 1,
    minWidth: 0,
    minHeight: 58,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  colorOptionSelected: { borderColor: colors.primary, backgroundColor: colors.primaryWash },
  colorSwatch: {
    width: 23,
    height: 23,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  whiteColorSwatch: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong },
  colorLabel: { fontFamily: fonts.medium, color: colors.inkSoft, fontSize: 11, lineHeight: 14 },
  colorLabelSelected: { fontFamily: fonts.label, color: colors.ink },
  preferenceRows: { marginTop: spacing.md },
  preferenceRow: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  preferenceRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  preferenceCopy: { flex: 1, minWidth: 0 },
  preferenceTitle: { ...typography.control, color: colors.ink, fontSize: 14, lineHeight: 18 },
  preferenceHint: { ...typography.body, color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
});
