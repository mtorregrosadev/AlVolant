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
import { formatDirectionLabel } from '../services/directionLabel';
import { cardShadow, colors, fonts, radii, safeHexColor, spacing, typography } from '../theme';

type ServiceAssignmentModalProps = {
  visible: boolean;
  isLandscape: boolean;
  insets: EdgeInsets;
  selectedRoute: RouteInfo | null;
  upcomingTrips: UpcomingTrip[];
  loading: boolean;
  manualVehicle: string;
  onManualVehicleChange: (value: string) => void;
  onClose: () => void;
  onConfirm: (vehicleId: string, tripId?: string) => void;
  onSkip: () => void;
};

export default function ServiceAssignmentModal({
  visible,
  isLandscape,
  insets,
  selectedRoute,
  upcomingTrips,
  loading,
  manualVehicle,
  onManualVehicleChange,
  onClose,
  onConfirm,
  onSkip,
}: ServiceAssignmentModalProps) {
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
              <Text style={styles.title}>Tria la sortida</Text>
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
              accessibilityLabel="Tancar assignació"
            >
              <MaterialCommunityIcons name="close" size={21} color={colors.ink} />
            </TouchableOpacity>
          </View>

          <Text style={styles.subtitle}>
            Sincronitza una sortida del SAE o introdueix el vehicle manualment.
          </Text>

          {loading ? (
            <View style={styles.loadingState}>
              <View style={styles.loadingIcon}>
                <ActivityIndicator color={colors.white} />
              </View>
              <Text style={styles.loadingText}>Consultant les properes sortides…</Text>
            </View>
          ) : (
            <ScrollView
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {upcomingTrips.length > 0 && upcomingTrips[0].is_maintenance ? (
                <View style={styles.noticeCard}>
                  <MaterialCommunityIcons name="wrench-clock" size={24} color={colors.warning} />
                  <View style={styles.noticeCopy}>
                    <Text style={styles.noticeTitle}>Horaris en manteniment</Text>
                    <Text style={styles.noticeText}>Pots introduir el vehicle o conduir lliurement.</Text>
                  </View>
                </View>
              ) : upcomingTrips.length === 0 ? (
                <View style={styles.emptyState}>
                  <MaterialCommunityIcons name="calendar-blank-outline" size={28} color={colors.transitDark} />
                  <Text style={styles.emptyTitle}>No hi ha més sortides per avui</Text>
                  <Text style={styles.emptyText}>La ruta continua disponible en mode lliure.</Text>
                </View>
              ) : upcomingTrips.map((trip) => {
                const scheduledTime = (trip.departure_time || '').slice(0, 5);
                const title = formatDirectionLabel(trip.trip_headsign || trip.towards_label) || 'Servei';
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
                  : delayMinutes < 0 ? `${delayMinutes} min` : trip.trip_status === 'on_time' ? 'A l’hora' : 'Programada';

                return (
                  <TouchableOpacity
                    key={trip.trip_id}
                    style={styles.tripRow}
                    onPress={() => onConfirm('', trip.trip_id)}
                    activeOpacity={0.82}
                    accessibilityRole="button"
                    accessibilityLabel={`${title}, sortida ${estimatedTime}`}
                  >
                    <View style={styles.timeBlock}>
                      <Text style={styles.timeText}>{estimatedTime || '--:--'}</Text>
                      <Text style={styles.timeCaption}>{delayMinutes ? 'estimada' : 'sortida'}</Text>
                    </View>
                    <View style={styles.tripCopy}>
                      <Text style={styles.tripTitle} numberOfLines={1}>{title}</Text>
                      <Text style={styles.tripOrigin} numberOfLines={1}>
                        {trip.origin_stop_name ? `Origen · ${trip.origin_stop_name}` : 'Servei programat'}
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

              <View style={styles.manualCard}>
                <View style={styles.manualHeading}>
                  <MaterialCommunityIcons name="bus" size={20} color={colors.transitDark} />
                  <Text style={styles.manualLabel}>Vehicle manual</Text>
                </View>
                <View style={styles.manualRow}>
                  <TextInput
                    style={styles.manualInput}
                    placeholder="Ex. 3042"
                    placeholderTextColor={colors.subtle}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={12}
                    value={manualVehicle}
                    onChangeText={onManualVehicleChange}
                    accessibilityLabel="Identificador del vehicle"
                  />
                  <TouchableOpacity
                    style={[styles.syncButton, !manualVehicle && styles.syncButtonDisabled]}
                    disabled={!manualVehicle}
                    onPress={() => onConfirm(manualVehicle)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.syncText}>Sincronitzar</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <TouchableOpacity style={styles.skipButton} onPress={onSkip} accessibilityRole="button">
                <Text style={styles.skipText}>Conduir sense assignació</Text>
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
