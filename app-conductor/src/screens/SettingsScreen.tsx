import React from 'react';
import {
  ScrollView,
  StyleSheet,
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
import { usePreferences } from '../PreferencesContext';
import { useI18n, type TranslationKey } from '../i18n';
import type { AppLanguage, VehicleColor } from '../services/userPreferences';
import {
  colors,
  fonts,
  radii,
  spacing,
  typography,
  vehicleAccentColor,
} from '../theme';

type SettingsScreenProps = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const LANGUAGE_OPTIONS: Array<{ value: AppLanguage; key: TranslationKey }> = [
  { value: 'ca', key: 'settings.catalan' },
  { value: 'es', key: 'settings.spanish' },
];

const VEHICLE_OPTIONS: Array<{ value: VehicleColor; key: TranslationKey }> = [
  { value: 'red', key: 'settings.red' },
  { value: 'yellow', key: 'settings.yellow' },
  { value: 'green', key: 'settings.green' },
  { value: 'route', key: 'settings.routeColor' },
];

function BusPreview({ accent }: { accent: string }) {
  return (
    <View style={styles.previewStage} accessible={false}>
      <View style={styles.previewTrack} />
      <View style={styles.previewTrackSecondary} />
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
    </View>
  );
}

export default function SettingsScreen({ navigation }: SettingsScreenProps) {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const { preferences, setLanguage, setVehicleColor } = usePreferences();
  const { t } = useI18n();
  const previewAccent = vehicleAccentColor(preferences.vehicleColor);

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
        contentContainerStyle={[
          styles.content,
          isLandscape && styles.contentLandscape,
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.settingsGrid, isLandscape && styles.settingsGridLandscape]}>
          <View style={styles.card}>
            <View style={styles.cardHeading}>
              <View style={styles.cardIcon}>
                <MaterialCommunityIcons name="translate" size={19} color={colors.primary} />
              </View>
              <View style={styles.cardHeadingCopy}>
                <Text style={styles.cardTitle}>{t('settings.language')}</Text>
                <Text style={styles.cardHint}>{t('settings.languageHint')}</Text>
              </View>
            </View>

            <View style={styles.segmentedControl}>
              {LANGUAGE_OPTIONS.map((option) => {
                const selected = preferences.language === option.value;
                const label = t(option.key);
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[styles.segment, selected && styles.segmentSelected]}
                    onPress={() => setLanguage(option.value)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={selected ? t('settings.selected', { value: label }) : label}
                  >
                    <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{label}</Text>
                    {selected ? (
                      <MaterialCommunityIcons name="check" size={16} color={colors.white} />
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={[styles.card, styles.vehicleCard]}>
            <View style={styles.cardHeading}>
              <View style={styles.cardIcon}>
                <MaterialCommunityIcons name="bus" size={19} color={colors.primary} />
              </View>
              <View style={styles.cardHeadingCopy}>
                <Text style={styles.cardTitle}>{t('settings.vehicle')}</Text>
                <Text style={styles.cardHint}>{t('settings.vehicleHint')}</Text>
              </View>
            </View>

            <BusPreview accent={previewAccent} />

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
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
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
  settingsGridLandscape: { flexDirection: 'row', alignItems: 'flex-start' },
  card: {
    flex: 1,
    minWidth: 0,
    padding: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  vehicleCard: { overflow: 'hidden' },
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
  cardHint: { ...typography.body, color: colors.muted, fontSize: 10.5, lineHeight: 14, marginTop: 2 },
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
  segmentText: { ...typography.control, color: colors.inkSoft, fontSize: 11.5 },
  segmentTextSelected: { color: colors.white },
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
  colorLabel: { fontFamily: fonts.medium, color: colors.inkSoft, fontSize: 8.5, lineHeight: 11 },
  colorLabelSelected: { fontFamily: fonts.label, color: colors.ink },
});
