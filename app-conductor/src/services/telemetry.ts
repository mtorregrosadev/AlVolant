import { AppState, Platform, type NativeEventSubscription } from 'react-native';
import type { AppLanguage } from './userPreferences';

export type TelemetryEventName =
  | 'app_started'
  | 'app_backgrounded'
  | 'screen_view'
  | 'route_selected'
  | 'route_started'
  | 'map_loaded'
  | 'map_match_changed'
  | 'api_request'
  | 'api_error'
  | 'render_error'
  | 'unhandled_error'
  | 'memory_warning'
  | 'preference_changed';

export type TelemetryEndpoint =
  | 'live_websocket'
  | 'nearby_routes'
  | 'relief_candidates'
  | 'route_shape'
  | 'route_stops'
  | 'route_alerts'
  | 'route_updates'
  | 'route_vehicles'
  | 'routes'
  | 'traffic_summary'
  | 'upcoming_trips';

type TelemetryScalar = string | number | boolean;
export type TelemetryContext = Record<string, TelemetryScalar | undefined>;

export type ClientTelemetryEvent = {
  name: TelemetryEventName;
  session_id: string;
  sequence: number;
  occurred_at_ms: number;
  context: Record<string, TelemetryScalar>;
};

export type TelemetryBatch = {
  schema_version: 1;
  sent_at_ms: number;
  events: ClientTelemetryEvent[];
};

type TelemetryTransport = (batch: TelemetryBatch) => Promise<void>;

const MAX_QUEUE_EVENTS = 100;
const MAX_QUEUE_BYTES = 64 * 1024;
const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 15_000;
const ERROR_DEDUPLICATION_MS = 60_000;
const SAFE_CONTEXT_KEYS = new Set([
  'app_version',
  'assigned',
  'direction',
  'duration_ms',
  'endpoint',
  'error_type',
  'is_fatal',
  'language',
  'method',
  'mode',
  'phase',
  'platform',
  'screen',
  'setting',
  'source',
  'status',
  'value',
]);

function createSessionId() {
  const timestamp = Date.now().toString(36);
  const random = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `${timestamp}_${random}`.slice(0, 48).padEnd(12, '0');
}

function sanitizeText(value: string) {
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/(\b(?:x[_-]?)?(?:api[_-]?key|authorization|password|secret|token)\b["']?\s*[:=]\s*)["']?(?:(?:bearer|basic)\s+)?[^"'\s,;}\]]+["']?/gi, '$1[redacted]')
    .replace(/\/(?:Users|home)\/[^/\s]+\//g, '/Users/[redacted]/')
    .replace(/-?\d{1,3}\.\d{4,}\s*[,;]\s*-?\d{1,3}\.\d{4,}/g, '[redacted-coordinates]')
    .replace(/\b(lat(?:itude)?|lon(?:gitude)?)\b["']?\s*[:=]\s*["']?-?\d{1,3}(?:\.\d+)?["']?/gi, '$1=[redacted]')
    .replace(/(https?:\/\/[^\s?#]+)(?:[?#][^\s]*)?/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function sanitizeContext(context: TelemetryContext) {
  const sanitized: Record<string, TelemetryScalar> = {};

  Object.entries(context).slice(0, 16).forEach(([key, value]) => {
    if (!SAFE_CONTEXT_KEYS.has(key) || value === undefined) return;

    if (typeof value === 'string') {
      const clean = sanitizeText(value);
      if (clean) sanitized[key] = clean;
      return;
    }

    if (typeof value === 'boolean') {
      sanitized[key] = value;
      return;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = Math.max(-1_000_000_000, Math.min(1_000_000_000, Math.round(value)));
    }
  });

  return sanitized;
}

class TelemetryClient {
  private readonly sessionId = createSessionId();
  private sequence = 0;
  private queue: ClientTelemetryEvent[] = [];
  private queueBytes = 0;
  private transport: TelemetryTransport | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptions: NativeEventSubscription[] = [];
  private started = false;
  private flushing = false;
  private retryAttempt = 0;
  private retryAt = 0;
  private language: AppLanguage = 'ca';
  private readonly recentErrors = new Map<string, number>();

  setTransport(transport: TelemetryTransport) {
    this.transport = transport;
  }

  start(options: { language: AppLanguage; durationMs: number; appVersion: string }) {
    this.language = options.language;
    if (this.started) return;

    this.started = true;
    this.capture('app_started', {
      app_version: options.appVersion,
      duration_ms: options.durationMs,
      language: options.language,
      platform: Platform.OS === 'android' ? 'android' : 'ios',
    });

    this.subscriptions.push(AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        this.capture('app_backgrounded', { language: this.language });
        void this.flush(true);
      }
    }));
    this.subscriptions.push(AppState.addEventListener('memoryWarning', () => {
      this.capture('memory_warning', { phase: 'global' });
      void this.flush(true);
    }));
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  setLanguage(language: AppLanguage) {
    this.language = language;
  }

  capture(name: TelemetryEventName, context: TelemetryContext = {}) {
    const event: ClientTelemetryEvent = {
      name,
      session_id: this.sessionId,
      sequence: this.sequence,
      occurred_at_ms: Date.now(),
      context: sanitizeContext(context),
    };
    this.sequence += 1;

    const bytes = JSON.stringify(event).length;
    while (
      this.queue.length > 0
      && (this.queue.length >= MAX_QUEUE_EVENTS || this.queueBytes + bytes > MAX_QUEUE_BYTES)
    ) {
      const removed = this.queue.shift();
      if (removed) this.queueBytes -= JSON.stringify(removed).length;
    }

    if (bytes <= MAX_QUEUE_BYTES) {
      this.queue.push(event);
      this.queueBytes += bytes;
    }

    if (this.queue.length >= BATCH_SIZE) void this.flush();
  }

  captureException(
    error: unknown,
    context: TelemetryContext & { phase: string },
    eventName: 'render_error' | 'unhandled_error' = 'unhandled_error',
  ) {
    const errorType = error instanceof Error ? error.name || 'Error' : typeof error;
    const signature = `${eventName}:${context.phase}:${errorType}`;
    const now = Date.now();
    const previous = this.recentErrors.get(signature) ?? 0;
    if (now - previous < ERROR_DEDUPLICATION_MS) return;

    this.recentErrors.set(signature, now);
    this.capture(eventName, {
      ...context,
      error_type: errorType.slice(0, 80),
    });
  }

  async flush(force = false) {
    if (
      !this.transport
      || this.flushing
      || this.queue.length === 0
      || (!force && Date.now() < this.retryAt)
    ) return;

    const events = this.queue.splice(0, BATCH_SIZE);
    const removedBytes = events.reduce((total, event) => total + JSON.stringify(event).length, 0);
    this.queueBytes = Math.max(0, this.queueBytes - removedBytes);
    this.flushing = true;

    try {
      await this.transport({ schema_version: 1, sent_at_ms: Date.now(), events });
      this.retryAttempt = 0;
      this.retryAt = 0;
      if (this.queue.length >= BATCH_SIZE) void this.flush();
    } catch {
      this.queue = [...events, ...this.queue].slice(0, MAX_QUEUE_EVENTS);
      this.queueBytes = this.queue.reduce(
        (total, event) => total + JSON.stringify(event).length,
        0,
      );
      this.retryAttempt = Math.min(this.retryAttempt + 1, 6);
      const baseDelay = Math.min(60_000, 1_000 * (2 ** this.retryAttempt));
      this.retryAt = Date.now() + baseDelay + Math.round(Math.random() * 500);
    } finally {
      this.flushing = false;
    }
  }
}

type ErrorUtilsShape = {
  getGlobalHandler?: () => (error: Error, isFatal?: boolean) => void;
  setGlobalHandler?: (handler: (error: Error, isFatal?: boolean) => void) => void;
};

let globalHandlerInstalled = false;

export const telemetry = new TelemetryClient();

export function installGlobalTelemetryErrorHandler() {
  if (globalHandlerInstalled) return;
  const errorUtils = (globalThis as typeof globalThis & { ErrorUtils?: ErrorUtilsShape }).ErrorUtils;
  if (!errorUtils?.setGlobalHandler) return;

  const previousHandler = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error, isFatal) => {
    telemetry.captureException(error, { phase: 'global', is_fatal: Boolean(isFatal) });
    void telemetry.flush(true);
    previousHandler?.(error, isFatal);
  });
  globalHandlerInstalled = true;
}
