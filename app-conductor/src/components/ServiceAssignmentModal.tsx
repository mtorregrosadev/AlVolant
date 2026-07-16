import React from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { EdgeInsets } from 'react-native-safe-area-context';
import type { RouteInfo, UpcomingTrip } from '../services/api';
import type { ReliefCandidate } from '../services/reliefDetection';
import { formatDirectionLabel } from '../services/directionLabel';
import { cardShadow, colors, fonts, radii, safeHexColor, spacing, typography } from '../theme';
import { useI18n } from '../i18n';

type ServiceAssignmentModalProps = {
  visible: boolean;
  isLandscape: boolean;
  insets: EdgeInsets;
  selectedRoute: RouteInfo | null;
  upcomingTrips: UpcomingTrip[];
  mode: 'detecting' | 'candidate' | 'departures';
  candidate: ReliefCandidate | null;
  nearbyStopName: string;
  loading: boolean;
  isLoadingPastDepartures: boolean;
  hasLoadedPastDepartures: boolean;
  manualVehicle: string;
  manualVehicleError: 'not_found' | 'wrong_direction' | 'unavailable' | null;
  isCheckingManualVehicle: boolean;
  onManualVehicleChange: (value: string) => void;
  onManualVehicleSync: () => void;
  onLoadPastDepartures: () => void;
  onClose: () => void;
  onConfirm: (vehicleId: string, tripId?: string) => void;
  onChooseDeparture: () => void;
  onSkip: () => void;
};

export default function ServiceAssignmentModal({
  visible,
  isLandscape,
  insets,
  selectedRoute,
  upcomingTrips,
  mode,
  candidate,
  nearbyStopName,
  loading,
  isLoadingPastDepartures,
  hasLoadedPastDepartures,
  manualVehicle,
  manualVehicleError,
  isCheckingManualVehicle,
  onManualVehicleChange,
  onManualVehicleSync,
  onLoadPastDepartures,
  onClose,
  onConfirm,
  onChooseDeparture,
  onSkip,
}: ServiceAssignmentModalProps) {
  const { language, t } = useI18n();
  const arrivalLabel = candidate
    ? candidate.phase === 'at_stop'
      ? t('relief.atStop')
      : candidate.etaSeconds !== null && candidate.etaSeconds <= 30
        ? t('relief.arrivesNow')
        : candidate.etaSeconds !== null
          ? t('relief.arrivesIn', { count: Math.max(1, Math.ceil(candidate.etaSeconds / 60)) })
          : candidate.distanceToStopMeters !== null
            ? t('relief.distance', { distance: Math.round(candidate.distanceToStopMeters) })
            : t('relief.arrivesNow')
    : '';
  const overlayInsets = {
    paddingTop: Math.max(insets.top + spacing.md, spacing.xl),
    paddingRight: Math.max(insets.right + spacing.xl, spacing.xl),
    paddingBottom: Math.max(insets.bottom + spacing.md, spacing.xl),
    paddingLeft: Math.max(insets.left + spacing.xl, spacing.xl),
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      presentationStyle="overFullScreen"
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
      onRequestClose={onClose}
    >
      <View style={[styles.overlay, overlayInsets]}>
        <View style={[styles.sheet, isLandscape && styles.sheetLandscape]}>
          <View style={styles.sheetHeader}>
            <View style={styles.sheetHeaderAccent} />
            <View style={styles.sheetHeaderCopy}>
              <Text style={styles.title}>
                {t(mode === 'candidate'
                  ? 'relief.title'
                  : mode === 'detecting'
                    ? 'relief.searchingTitle'
                    : 'assignment.title')}
              </Text>
            </View>
            {selectedRoute ? (
              <View style={[
                styles.selectedRouteBadge,
                { backgroundColor: safeHexColor(selectedRoute.route_color, colors.primary) },
              ]}>
                <Text style={[
                  styles.selectedRouteBadgeText,
                  { color: safeHexColor(selectedRoute.route_text_color, colors.white) },
                ]}>{selectedRoute.route_short_name || 'Bus'}</Text>
              </View>
            ) : null}
            <TouchableOpacity
              style={styles.closeButton}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={t('assignment.close')}
            >
              <MaterialCommunityIcons name="close" size={21} color={colors.ink} />
            </TouchableOpacity>
          </View>

          <Text style={styles.subtitle}>
            {t(mode === 'candidate'
              ? 'relief.subtitle'
              : mode === 'detecting'
                ? 'relief.searching'
                : 'assignment.subtitle')}
          </Text>

          {mode === 'detecting' ? (
            <View style={styles.loadingState}>
              <View style={styles.loadingIcon}>
                <ActivityIndicator color={colors.white} />
              </View>
              <Text style={styles.loadingText}>{t('relief.searchingHint')}</Text>
            </View>
          ) : mode === 'candidate' && candidate ? (
            <View style={styles.candidateContent}>
              <View
                style={styles.candidateCard}
                accessible
                accessibilityLabel={t('relief.candidateA11y', {
                  vehicle: t('relief.vehicle', { value: candidate.vehicleId }),
                  arrival: arrivalLabel,
                  stop: nearbyStopName || candidate.stopName,
                })}
              >
                <View style={styles.candidateVehicleIcon}>
                  <MaterialCommunityIcons name="bus" size={27} color={colors.white} />
                </View>
                <View style={styles.candidateCopy}>
                  <Text style={styles.candidateVehicle} numberOfLines={1}>
                    {t('relief.vehicle', { value: candidate.vehicleId })}
                  </Text>
                  <Text style={styles.candidateArrival}>{arrivalLabel}</Text>
                  <Text style={styles.candidateStop} numberOfLines={2}>
                    {t('relief.stop', { value: nearbyStopName || candidate.stopName })}
                  </Text>
                </View>
              </View>

              <TouchableOpacity
                style={styles.confirmCandidateButton}
                onPress={() => onConfirm(candidate.vehicleId, candidate.tripId)}
                activeOpacity={0.86}
                accessibilityRole="button"
              >
                <MaterialCommunityIcons name="check" size={21} color={colors.white} />
                <Text style={styles.confirmCandidateText}>{t('relief.confirm')}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.chooseDepartureButton}
                onPress={onChooseDeparture}
                accessibilityRole="button"
              >
                <Text style={styles.chooseDepartureText}>{t('relief.chooseDeparture')}</Text>
                <MaterialCommunityIcons name="arrow-right" size={18} color={colors.primary} />
              </TouchableOpacity>
            </View>
          ) : (
            <ScrollView
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {loading ? (
                <View style={styles.loadingState}>
                  <View style={styles.loadingIcon}>
                    <ActivityIndicator color={colors.white} />
                  </View>
                  <Text style={styles.loadingText}>{t('assignment.loading')}</Text>
                </View>
              ) : upcomingTrips.length > 0 && upcomingTrips[0].is_maintenance ? (
                <View style={styles.noticeCard}>
                  <MaterialCommunityIcons name="wrench-clock" size={24} color={colors.warning} />
                  <View style={styles.noticeCopy}>
                    <Text style={styles.noticeTitle}>{t('assignment.maintenance')}</Text>
                    <Text style={styles.noticeText}>{t('assignment.maintenanceHint')}</Text>
                  </View>
                </View>
              ) : upcomingTrips.length === 0 ? (
                <View style={styles.emptyState}>
                  <MaterialCommunityIcons name="calendar-blank-outline" size={28} color={colors.transitDark} />
                  <Text style={styles.emptyTitle}>{t('assignment.empty')}</Text>
                  <Text style={styles.emptyText}>{t('assignment.emptyHint')}</Text>
                </View>
              ) : upcomingTrips.map((trip) => {
                const scheduledTime = (trip.departure_time || '').slice(0, 5);
                const title = formatDirectionLabel(
                  trip.trip_headsign || trip.towards_label,
                  language,
                ) || t('assignment.service');
                const delayMinutes = trip.has_rt_first_stop_update
                  ? Math.round((trip.delay_seconds ?? 0) / 60)
                  : 0;
                let estimatedTime = scheduledTime;

                if (trip.has_rt_first_stop_update && delayMinutes !== 0) {
                  const [hour, minute] = (trip.departure_time || '00:00').split(':').map(Number);
                  const totalMinutes = ((hour * 60 + minute + delayMinutes) + 1440) % 1440;
                  estimatedTime = `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
                }

                const status = delayMinutes > 0
                  ? `+${delayMinutes} min`
                  : delayMinutes < 0
                    ? `${delayMinutes} min`
                    : t(trip.trip_status === 'on_time' ? 'assignment.onTime' : 'assignment.scheduled');

                return (
                  <TouchableOpacity
                    key={trip.trip_id}
                    style={styles.tripRow}
                    onPress={() => onConfirm('', trip.trip_id)}
                    activeOpacity={0.82}
                    accessibilityRole="button"
                    accessibilityLabel={t('assignment.tripA11y', { title, time: estimatedTime })}
                  >
                    <View style={styles.timeBlock}>
                      <Text style={styles.timeText}>{estimatedTime || '--:--'}</Text>
                      <Text style={styles.timeCaption}>
                        {t(delayMinutes ? 'assignment.estimated' : 'assignment.departure')}
                      </Text>
                    </View>
                    <View style={styles.tripCopy}>
                      <Text style={styles.tripTitle} numberOfLines={1}>{title}</Text>
                      <Text style={styles.tripOrigin} numberOfLines={1}>
                        {trip.origin_stop_name
                          ? t('assignment.origin', { value: trip.origin_stop_name })
                          : t('assignment.programmed')}
                      </Text>
                    </View>
                    <View style={[
                      styles.statusBadge,
                      delayMinutes > 0 && styles.statusBadgeDelayed,
                    ]}>
                      <Text style={[
                        styles.statusText,
                        delayMinutes > 0 && styles.statusTextDelayed,
                      ]}>{status}</Text>
                    </View>
                    <MaterialCommunityIcons name="chevron-right" size={20} color={colors.borderStrong} />
                  </TouchableOpacity>
                );
              })}

              {!hasLoadedPastDepartures ? (
                <TouchableOpacity
                  style={styles.pastDeparturesButton}
                  onPress={onLoadPastDepartures}
                  disabled={isLoadingPastDepartures}
                  accessibilityRole="button"
                >
                  {isLoadingPastDepartures ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <MaterialCommunityIcons name="history" size={18} color={colors.primary} />
                  )}
                  <Text style={styles.pastDeparturesText}>
                    {t(isLoadingPastDepartures
                      ? 'assignment.loadingPastDepartures'
                      : 'assignment.loadPastDepartures')}
                  </Text>
                </TouchableOpacity>
              ) : null}

              <View style={styles.manualCard}>
                <View style={styles.manualHeading}>
                  <MaterialCommunityIcons name="bus" size={20} color={colors.transitDark} />
                  <Text style={styles.manualLabel}>{t('assignment.manualVehicle')}</Text>
                </View>
                <View style={styles.manualRow}>
                  <TextInput
                    style={styles.manualInput}
                    placeholder={t('assignment.vehicleExample')}
                    placeholderTextColor={colors.subtle}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={12}
                    value={manualVehicle}
                    onChangeText={onManualVehicleChange}
                    accessibilityLabel={t('assignment.vehicleA11y')}
                  />
                  <TouchableOpacity
                    style={[
                      styles.syncButton,
                      (!manualVehicle || isCheckingManualVehicle) && styles.syncButtonDisabled,
                    ]}
                    disabled={!manualVehicle || isCheckingManualVehicle}
                    onPress={onManualVehicleSync}
                    accessibilityRole="button"
                  >
                    {isCheckingManualVehicle ? (
                      <ActivityIndicator size="small" color={colors.white} />
                    ) : (
                      <Text style={styles.syncText}>{t('assignment.sync')}</Text>
                    )}
                  </TouchableOpacity>
                </View>
                {manualVehicleError ? (
                  <Text style={styles.manualError}>
                    {t(`assignment.vehicle${manualVehicleError === 'not_found'
                      ? 'NotLive'
                      : manualVehicleError === 'wrong_direction'
                        ? 'WrongDirection'
                        : 'LookupUnavailable'}`)}
                  </Text>
                ) : null}
              </View>

              <TouchableOpacity style={styles.skipButton} onPress={onSkip} accessibilityRole="button">
                <Text style={styles.skipText}>{t('assignment.skip')}</Text>
                <MaterialCommunityIcons name="arrow-right" size={18} color={colors.primary} />
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(13, 40, 52, 0.55)', justifyContent: 'center' },
  sheet: {
    width: '100%',
    maxHeight: '86%',
    borderRadius: radii.xl,
    backgroundColor: colors.canvas,
    padding: spacing.xl,
    ...cardShadow,
  },
  sheetLandscape: { alignSelf: 'center', maxWidth: 760, maxHeight: '96%' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  sheetHeaderAccent: { width: 7, height: 44, borderRadius: 4, backgroundColor: colors.transit },
  sheetHeaderCopy: { flex: 1, minWidth: 0 },
  title: { ...typography.screenTitle, color: colors.ink },
  selectedRouteBadge: {
    minWidth: 48,
    height: 31,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedRouteBadgeText: { ...typography.badge, fontSize: 13 },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitle: { ...typography.body, color: colors.muted, marginTop: spacing.md },
  loadingState: { minHeight: 190, alignItems: 'center', justifyContent: 'center' },
  loadingIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.transit,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: { ...typography.body, color: colors.muted, marginTop: spacing.md },
  candidateContent: { gap: spacing.md, paddingTop: spacing.lg },
  candidateCard: {
    minHeight: 112,
    padding: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  candidateVehicleIcon: {
    width: 54,
    height: 54,
    borderRadius: radii.lg,
    backgroundColor: colors.transit,
    alignItems: 'center',
    justifyContent: 'center',
  },
  candidateCopy: { flex: 1, minWidth: 0 },
  candidateVehicle: { ...typography.cardTitle, color: colors.ink, fontSize: 16 },
  candidateArrival: { ...typography.control, color: colors.primary, marginTop: 3 },
  candidateStop: { ...typography.body, color: colors.muted, marginTop: 4 },
  confirmCandidateButton: {
    minHeight: 50,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  confirmCandidateText: { ...typography.button, color: colors.white },
  chooseDepartureButton: {
    minHeight: 44,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  chooseDepartureText: { ...typography.control, color: colors.primary },
  listContent: { gap: spacing.sm, paddingTop: spacing.md, paddingBottom: spacing.xs },
  noticeCard: {
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: '#FFF4D7',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  noticeCopy: { flex: 1 },
  noticeTitle: { ...typography.cardTitle, color: '#815414' },
  noticeText: { ...typography.body, color: '#8D6A32', fontSize: 11, marginTop: 2 },
  emptyState: { minHeight: 125, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { ...typography.cardTitle, color: colors.ink, marginTop: spacing.sm },
  emptyText: { ...typography.body, color: colors.muted, fontSize: 11, marginTop: 2 },
  tripRow: {
    minHeight: 72,
    padding: spacing.sm,
    borderRadius: radii.lg,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  timeBlock: {
    width: 60,
    height: 52,
    borderRadius: radii.md,
    backgroundColor: colors.transitWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeText: { ...typography.button, color: colors.transitDark, fontSize: 15 },
  timeCaption: { ...typography.meta, color: colors.transitDark, fontSize: 8, marginTop: 1 },
  tripCopy: { flex: 1, minWidth: 0 },
  tripTitle: { ...typography.cardTitle, color: colors.ink, fontSize: 12 },
  tripOrigin: { ...typography.meta, color: colors.muted, marginTop: 2 },
  statusBadge: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radii.pill, backgroundColor: '#E4F5EA' },
  statusBadgeDelayed: { backgroundColor: colors.primarySoft },
  statusText: { ...typography.meta, color: '#167545', fontWeight: '700' },
  statusTextDelayed: { color: colors.primaryPressed },
  manualCard: { padding: spacing.md, borderRadius: radii.lg, backgroundColor: colors.transitWash, marginTop: spacing.xs },
  manualHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  manualLabel: { ...typography.control, color: colors.ink },
  manualRow: { flexDirection: 'row', gap: spacing.sm },
  manualInput: {
    flex: 1,
    minWidth: 0,
    height: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.white,
    color: colors.ink,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  syncButton: {
    height: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    backgroundColor: colors.transitDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncButtonDisabled: { opacity: 0.42 },
  syncText: { ...typography.control, color: colors.white },
  manualError: { ...typography.meta, color: colors.danger, marginTop: spacing.sm },
  pastDeparturesButton: {
    minHeight: 44,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  pastDeparturesText: { ...typography.control, color: colors.primary },
  skipButton: {
    height: 44,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  skipText: { ...typography.control, color: colors.primary, fontSize: 12 },
});
