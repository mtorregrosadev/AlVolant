import { Platform } from 'react-native';
import type { LiveActivity } from 'expo-widgets';
import RouteLiveActivity, {
  type RouteLiveActivityProps,
} from '../../widgets/RouteLiveActivity';
import { telemetry } from './telemetry';

const ETA_REBASE_THRESHOLD_MS = 30_000;
const MAX_UPDATE_INTERVAL_MS = 60_000;
const MAX_FUTURE_ETA_MS = 12 * 60 * 60 * 1_000;
const UNIX_SECONDS_UPPER_BOUND = 10_000_000_000;
const HEX_COLOR = /^#[0-9A-F]{6}$/i;

let activeInstance: LiveActivity<RouteLiveActivityProps> | null = null;
let lastProps: RouteLiveActivityProps | null = null;
let lastUpdateAt = 0;
let operationGeneration = 0;
let etaExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let pendingUpdate: {
  generation: number;
  props: RouteLiveActivityProps;
} | null = null;
let updateDrain: Promise<void> | null = null;

function safeText(value: string, fallback: string, maxLength: number) {
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || fallback).slice(0, maxLength);
}

function safeColor(value: string, fallback: string) {
  return HEX_COLOR.test(value) ? value.toUpperCase() : fallback;
}

function normalizeEpochMs(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;

  // ActivityKit and the widget use milliseconds, while realtime transport
  // feeds commonly use POSIX seconds. Accept either without applying a
  // timezone offset: an epoch timestamp is already an absolute instant.
  return value < UNIX_SECONDS_UPPER_BOUND ? value * 1_000 : value;
}

function normalizeProps(props: RouteLiveActivityProps): RouteLiveActivityProps {
  const now = Date.now();
  const sourceUpdatedAtEpochMs = normalizeEpochMs(props.updatedAtEpochMs);
  const updatedAtEpochMs = sourceUpdatedAtEpochMs > 0
    ? Math.min(now + 60_000, Math.max(now - 60_000, sourceUpdatedAtEpochMs))
    : now;
  const sourceEtaEpochMs = normalizeEpochMs(props.etaEpochMs);
  const etaEpochMs = sourceEtaEpochMs > now
    ? Math.min(now + MAX_FUTURE_ETA_MS, sourceEtaEpochMs)
    : 0;

  return {
    line: safeText(props.line, 'Bus', 16),
    direction: safeText(props.direction, 'En ruta', 96),
    nextStop: safeText(props.nextStop, '--', 120),
    nextStopLabel: safeText(props.nextStopLabel, 'Propera parada', 32),
    etaLabel: safeText(props.etaLabel, 'Arribada', 24),
    etaValue: safeText(props.etaValue, '--', 12),
    updatedAtEpochMs,
    etaEpochMs,
    routeColor: safeColor(props.routeColor, '#176B5A'),
    routeTextColor: safeColor(props.routeTextColor, '#FFFFFF'),
  };
}

function structuralState(props: RouteLiveActivityProps) {
  return [
    props.line,
    props.direction,
    props.nextStop,
    props.nextStopLabel,
    props.etaLabel,
    props.etaValue,
    props.routeColor,
    props.routeTextColor,
  ].join('\u0000');
}

function shouldUpdate(next: RouteLiveActivityProps) {
  if (!lastProps) return true;
  if (structuralState(lastProps) !== structuralState(next)) return true;
  if (Math.abs(lastProps.etaEpochMs - next.etaEpochMs) >= ETA_REBASE_THRESHOLD_MS) return true;
  return Date.now() - lastUpdateAt >= MAX_UPDATE_INTERVAL_MS;
}

function knownInstances() {
  const instances = RouteLiveActivity.getInstances();
  if (activeInstance && !instances.includes(activeInstance)) {
    instances.unshift(activeInstance);
  }
  return instances;
}

function scheduleEtaExpiry(props: RouteLiveActivityProps, generation: number) {
  if (etaExpiryTimer) {
    clearTimeout(etaExpiryTimer);
    etaExpiryTimer = null;
  }

  const delayMs = props.etaEpochMs - Date.now();
  if (delayMs <= 0 || delayMs > MAX_FUTURE_ETA_MS) return;

  // Once an estimated clock time has passed, replace it with the localized
  // "now" value instead of leaving a stale time in the Dynamic Island.
  etaExpiryTimer = setTimeout(() => {
    etaExpiryTimer = null;
    if (generation !== operationGeneration || !activeInstance) return;

    pendingUpdate = {
      generation,
      props: {
        ...props,
        updatedAtEpochMs: Date.now(),
        etaEpochMs: 0,
      },
    };
    void ensureUpdateDrain();
  }, delayMs + 250);
}

async function performPendingUpdates() {
  while (pendingUpdate) {
    const update = pendingUpdate;
    pendingUpdate = null;

    if (update.generation !== operationGeneration || !shouldUpdate(update.props)) {
      continue;
    }

    try {
      const instance = activeInstance ?? RouteLiveActivity.getInstances()[0] ?? null;
      if (!instance || update.generation !== operationGeneration) continue;

      activeInstance = instance;
      await instance.update(update.props);
      if (update.generation !== operationGeneration) continue;

      lastProps = update.props;
      lastUpdateAt = Date.now();
      scheduleEtaExpiry(update.props, update.generation);
    } catch (error) {
      telemetry.captureException(error, { phase: 'global', source: 'live_activity_update' });
    }
  }
}

function ensureUpdateDrain() {
  if (updateDrain) return updateDrain;

  updateDrain = performPendingUpdates().finally(() => {
    updateDrain = null;
    // An update may have arrived between the loop observing an empty queue and
    // this cleanup. Start another drain so the newest state is never stranded.
    if (pendingUpdate) void ensureUpdateDrain();
  });
  return updateDrain;
}

export async function startRouteLiveActivity(props: RouteLiveActivityProps) {
  if (Platform.OS !== 'ios') return false;

  const generation = ++operationGeneration;
  if (etaExpiryTimer) {
    clearTimeout(etaExpiryTimer);
    etaExpiryTimer = null;
  }
  pendingUpdate = null;
  const safeProps = normalizeProps(props);
  try {
    const existing = knownInstances();
    await Promise.allSettled(existing.map((instance) => instance.end('immediate')));
    if (generation !== operationGeneration) return false;

    activeInstance = RouteLiveActivity.start(safeProps);
    lastProps = safeProps;
    lastUpdateAt = Date.now();
    scheduleEtaExpiry(safeProps, generation);
    return true;
  } catch (error) {
    activeInstance = null;
    lastProps = null;
    telemetry.captureException(error, { phase: 'global', source: 'live_activity_start' });
    return false;
  }
}

export async function updateRouteLiveActivity(props: RouteLiveActivityProps) {
  if (Platform.OS !== 'ios') return;

  const safeProps = normalizeProps(props);
  if (!shouldUpdate(safeProps)) return;

  // Coalesce bursts from GPS updates and serialize ActivityKit mutations. A
  // slow older write can therefore never overwrite a newer stop/ETA state.
  pendingUpdate = {
    generation: operationGeneration,
    props: safeProps,
  };
  await ensureUpdateDrain();
}

export async function endRouteLiveActivity() {
  if (Platform.OS !== 'ios') return;

  ++operationGeneration;
  if (etaExpiryTimer) {
    clearTimeout(etaExpiryTimer);
    etaExpiryTimer = null;
  }
  pendingUpdate = null;
  const instances = knownInstances();
  activeInstance = null;
  lastProps = null;
  lastUpdateAt = 0;

  if (!instances.length) return;

  const results = await Promise.allSettled(
    instances.map((instance) => instance.end('immediate')),
  );
  if (results.some((result) => result.status === 'rejected')) {
    telemetry.capture('unhandled_error', {
      phase: 'global',
      source: 'live_activity_end',
    });
  }
}

export type { RouteLiveActivityProps };
