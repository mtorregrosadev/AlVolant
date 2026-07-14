export type ReliefCoordinate = readonly [longitude: number, latitude: number];

export type ReliefTerminal = 'origin' | 'destination' | 'both' | null;

export type LocalReliefStop = {
  stopId: string;
  stopName: string;
  stopSequence: number;
  coordinate: ReliefCoordinate;
  terminal: ReliefTerminal;
};

export type ReliefLocationFix = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  observedAtEpochMs: number;
};

export type NearbyReliefStop = LocalReliefStop & {
  distanceToUserMeters: number;
  detectionRadiusMeters: number;
};

export type ReliefCandidate = {
  vehicleId: string;
  tripId: string;
  routeId: string;
  directionId: 0 | 1;
  stopId: string;
  stopName: string;
  phase: 'approaching' | 'at_stop' | 'passed';
  etaSeconds: number | null;
  distanceToStopMeters: number | null;
  confidence: 'high' | 'medium' | 'low';
  observedAtEpochSeconds: number;
};

export type NearbyStopSelectionOptions = {
  nowEpochMs: number;
  maximumLocationAgeMs?: number;
  maximumAccuracyMeters?: number;
};

export type ReliefCandidateSelectionOptions = {
  stopId: string;
  directionId: 0 | 1;
  routeIds: readonly string[];
  nowEpochSeconds: number;
  maximumObservationAgeSeconds?: number;
  maximumEtaSeconds?: number;
  maximumDistanceToStopMeters?: number;
  clearEtaAdvantageSeconds?: number;
  clearDistanceAdvantageMeters?: number;
};

export const RELIEF_DETECTION_LIMITS = Object.freeze({
  maximumStops: 500,
  maximumCandidates: 8,
  maximumRouteIds: 32,
  maximumIdLength: 160,
  maximumStopNameLength: 300,
  maximumStopSequence: 10_000,
  maximumReliableAccuracyMeters: 60,
  maximumLocationAgeMs: 45_000,
  futureLocationToleranceMs: 5_000,
  minimumStopRadiusMeters: 45,
  maximumStopRadiusMeters: 90,
  terminalStopRadiusMeters: 70,
  locationAccuracyPaddingMeters: 25,
  minimumStopSeparationMeters: 25,
  minimumTerminalSeparationMeters: 35,
  maximumObservationAgeSeconds: 120,
  futureObservationToleranceSeconds: 30,
  maximumEtaSeconds: 15 * 60,
  maximumDistanceToStopMeters: 4_000,
  clearEtaAdvantageSeconds: 90,
  clearDistanceAdvantageMeters: 500,
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximumLength: number, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximumLength || CONTROL_CHARACTERS.test(value)) {
    return null;
  }

  const normalized = value.trim();
  if (!allowEmpty && !normalized) return null;
  return normalized;
}

function boundedNumber(value: unknown, minimum: number, maximum: number) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
    ? value
    : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number) {
  const number = boundedNumber(value, minimum, maximum);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}

function validCoordinate(value: unknown): ReliefCoordinate | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return null;

  const longitude = boundedNumber(value[0], -180, 180);
  const latitude = boundedNumber(value[1], -90, 90);
  if (longitude === null || latitude === null) return null;

  if (value.length === 3 && boundedNumber(value[2], -20_000, 100_000) === null) {
    return null;
  }

  return [longitude, latitude];
}

function toRadians(value: number) {
  return value * Math.PI / 180;
}

/** Returns a WGS-84 great-circle distance, or `null` for invalid coordinates. */
export function haversineDistanceMeters(
  from: ReliefCoordinate,
  to: ReliefCoordinate,
): number | null {
  const validFrom = validCoordinate(from);
  const validTo = validCoordinate(to);
  if (!validFrom || !validTo) return null;

  const [fromLongitude, fromLatitude] = validFrom;
  const [toLongitude, toLatitude] = validTo;
  const latitudeDelta = toRadians(toLatitude - fromLatitude);
  const longitudeDelta = toRadians(toLongitude - fromLongitude);
  const fromLatitudeRadians = toRadians(fromLatitude);
  const toLatitudeRadians = toRadians(toLatitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(fromLatitudeRadians)
      * Math.cos(toLatitudeRadians)
      * Math.sin(longitudeDelta / 2) ** 2;

  return 6_371_000 * 2 * Math.atan2(
    Math.sqrt(Math.max(0, haversine)),
    Math.sqrt(Math.max(0, 1 - haversine)),
  );
}

/**
 * Strictly validates the route-stops GeoJSON returned by the BFF.
 * One malformed or duplicated feature invalidates the complete snapshot so a
 * partial route can never be mistaken for an unambiguous relief stop.
 */
export function parseReliefStopsGeoJson(payload: unknown): LocalReliefStop[] | null {
  if (!isRecord(payload) || payload.type !== 'FeatureCollection') return null;
  if (!Array.isArray(payload.features) || payload.features.length > RELIEF_DETECTION_LIMITS.maximumStops) {
    return null;
  }

  const parsed: Omit<LocalReliefStop, 'terminal'>[] = [];
  const identities = new Set<string>();

  for (const feature of payload.features) {
    if (!isRecord(feature) || feature.type !== 'Feature') return null;
    if (!isRecord(feature.geometry) || feature.geometry.type !== 'Point') return null;
    if (!isRecord(feature.properties)) return null;

    const stopId = boundedString(
      feature.properties.stop_id,
      RELIEF_DETECTION_LIMITS.maximumIdLength,
    );
    const stopName = boundedString(
      feature.properties.stop_name,
      RELIEF_DETECTION_LIMITS.maximumStopNameLength,
      true,
    );
    const stopSequence = boundedInteger(
      feature.properties.stop_sequence,
      0,
      RELIEF_DETECTION_LIMITS.maximumStopSequence,
    );
    const coordinate = validCoordinate(feature.geometry.coordinates);
    if (stopId === null || stopName === null || stopSequence === null || !coordinate) return null;

    const identity = `${stopId}\u0000${stopSequence}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    parsed.push({ stopId, stopName, stopSequence, coordinate });
  }

  if (parsed.length === 0) return [];

  parsed.sort((first, second) => first.stopSequence - second.stopSequence);
  const firstSequence = parsed[0].stopSequence;
  const lastSequence = parsed[parsed.length - 1].stopSequence;

  return parsed.map((stop): LocalReliefStop => {
    const isOrigin = stop.stopSequence === firstSequence;
    const isDestination = stop.stopSequence === lastSequence;
    const terminal: ReliefTerminal = isOrigin && isDestination
      ? 'both'
      : isOrigin
        ? 'origin'
        : isDestination
          ? 'destination'
          : null;

    return { ...stop, terminal };
  });
}

function parseNullableCandidateMetric(value: unknown, maximum: number) {
  if (value === null) return null;
  return boundedNumber(value, 0, maximum);
}

/** Strictly validates the bounded candidate array returned by the BFF. */
export function parseReliefCandidates(payload: unknown): ReliefCandidate[] | null {
  if (!Array.isArray(payload) || payload.length > RELIEF_DETECTION_LIMITS.maximumCandidates) {
    return null;
  }

  const parsed: ReliefCandidate[] = [];
  const identities = new Set<string>();

  for (const value of payload) {
    if (!isRecord(value)) return null;

    const vehicleId = boundedString(value.vehicle_id, RELIEF_DETECTION_LIMITS.maximumIdLength);
    const tripId = boundedString(value.trip_id, RELIEF_DETECTION_LIMITS.maximumIdLength);
    const routeId = boundedString(value.route_id, RELIEF_DETECTION_LIMITS.maximumIdLength);
    const stopId = boundedString(value.stop_id, RELIEF_DETECTION_LIMITS.maximumIdLength);
    const stopName = boundedString(
      value.stop_name,
      RELIEF_DETECTION_LIMITS.maximumStopNameLength,
      true,
    );
    const directionId = value.direction_id === 0 || value.direction_id === 1
      ? value.direction_id
      : null;
    const phase = value.phase === 'approaching'
      || value.phase === 'at_stop'
      || value.phase === 'passed'
      ? value.phase
      : null;
    const confidence = value.confidence === 'high'
      || value.confidence === 'medium'
      || value.confidence === 'low'
      ? value.confidence
      : null;
    const etaSeconds = parseNullableCandidateMetric(value.eta_seconds, 3_600);
    const distanceToStopMeters = parseNullableCandidateMetric(value.distance_to_stop_m, 50_000);
    const observedAtEpochSeconds = boundedInteger(value.observed_at, 1, 10_000_000_000);

    if (
      vehicleId === null
      || tripId === null
      || routeId === null
      || directionId === null
      || stopId === null
      || stopName === null
      || phase === null
      || confidence === null
      || (value.eta_seconds !== null && etaSeconds === null)
      || (value.distance_to_stop_m !== null && distanceToStopMeters === null)
      || observedAtEpochSeconds === null
    ) return null;

    const identity = `${vehicleId}\u0000${tripId}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    parsed.push({
      vehicleId,
      tripId,
      routeId,
      directionId,
      stopId,
      stopName,
      phase,
      etaSeconds,
      distanceToStopMeters,
      confidence,
      observedAtEpochSeconds,
    });
  }

  return parsed;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Chooses a nearby stop only when the GPS fix is fresh/reliable and the next
 * closest stop is outside the accuracy-aware ambiguity corridor. Terminals use
 * a smaller radius and a wider separation requirement because nearby bays can
 * represent different services or travel directions.
 */
export function selectNearbyReliefStop(
  stops: readonly LocalReliefStop[],
  location: ReliefLocationFix,
  options: NearbyStopSelectionOptions,
): NearbyReliefStop | null {
  if (!Array.isArray(stops) || stops.length === 0 || stops.length > RELIEF_DETECTION_LIMITS.maximumStops) {
    return null;
  }

  const maximumAccuracyMeters = boundedNumber(
    options.maximumAccuracyMeters ?? RELIEF_DETECTION_LIMITS.maximumReliableAccuracyMeters,
    1,
    RELIEF_DETECTION_LIMITS.maximumReliableAccuracyMeters,
  );
  const maximumLocationAgeMs = boundedInteger(
    options.maximumLocationAgeMs ?? RELIEF_DETECTION_LIMITS.maximumLocationAgeMs,
    1,
    5 * 60_000,
  );
  const nowEpochMs = boundedNumber(options.nowEpochMs, 0, Number.MAX_SAFE_INTEGER);
  const coordinate = validCoordinate([location.longitude, location.latitude]);
  const accuracyMeters = boundedNumber(
    location.accuracyMeters,
    0,
    maximumAccuracyMeters ?? -1,
  );
  const observedAtEpochMs = boundedNumber(location.observedAtEpochMs, 0, Number.MAX_SAFE_INTEGER);

  if (
    maximumAccuracyMeters === null
    || maximumLocationAgeMs === null
    || nowEpochMs === null
    || !coordinate
    || accuracyMeters === null
    || observedAtEpochMs === null
  ) return null;

  const locationAgeMs = nowEpochMs - observedAtEpochMs;
  if (
    locationAgeMs < -RELIEF_DETECTION_LIMITS.futureLocationToleranceMs
    || locationAgeMs > maximumLocationAgeMs
  ) return null;

  const ranked: Array<{ stop: LocalReliefStop; distance: number }> = [];
  for (const stop of stops) {
    const distance = haversineDistanceMeters(coordinate, stop.coordinate);
    if (distance === null) return null;
    ranked.push({ stop, distance });
  }
  ranked.sort((first, second) => first.distance - second.distance);

  const nearest = ranked[0];
  const baseRadius = clamp(
    accuracyMeters + RELIEF_DETECTION_LIMITS.locationAccuracyPaddingMeters,
    RELIEF_DETECTION_LIMITS.minimumStopRadiusMeters,
    RELIEF_DETECTION_LIMITS.maximumStopRadiusMeters,
  );
  const detectionRadiusMeters = nearest.stop.terminal === null
    ? baseRadius
    : Math.min(baseRadius, RELIEF_DETECTION_LIMITS.terminalStopRadiusMeters);
  if (nearest.distance > detectionRadiusMeters) return null;

  const second = ranked[1];
  if (second && second.distance <= detectionRadiusMeters) {
    const requiredSeparation = nearest.stop.terminal === null
      ? Math.max(
        RELIEF_DETECTION_LIMITS.minimumStopSeparationMeters,
        accuracyMeters * 0.75,
      )
      : Math.max(
        RELIEF_DETECTION_LIMITS.minimumTerminalSeparationMeters,
        accuracyMeters,
      );
    if (second.distance - nearest.distance < requiredSeparation) return null;
  }

  return {
    ...nearest.stop,
    distanceToUserMeters: nearest.distance,
    detectionRadiusMeters,
  };
}

function candidateMetric(value: number | null) {
  return value === null ? Number.POSITIVE_INFINITY : value;
}

function compareCandidates(first: ReliefCandidate, second: ReliefCandidate) {
  const phaseDifference = (first.phase === 'at_stop' ? 0 : 1)
    - (second.phase === 'at_stop' ? 0 : 1);
  if (phaseDifference !== 0) return phaseDifference;

  const confidenceDifference = (first.confidence === 'high' ? 0 : 1)
    - (second.confidence === 'high' ? 0 : 1);
  if (confidenceDifference !== 0) return confidenceDifference;

  const etaDifference = candidateMetric(first.etaSeconds) - candidateMetric(second.etaSeconds);
  if (etaDifference !== 0) return etaDifference;

  const distanceDifference = candidateMetric(first.distanceToStopMeters)
    - candidateMetric(second.distanceToStopMeters);
  if (distanceDifference !== 0) return distanceDifference;

  return second.observedAtEpochSeconds - first.observedAtEpochSeconds;
}

function hasClearNumericAdvantage(
  best: number | null,
  second: number | null,
  minimumAdvantage: number,
) {
  if (best === null) return false;
  if (second === null) return true;
  return second - best >= minimumAdvantage;
}

/**
 * Selects a candidate only when it matches the chosen stop/direction/route and
 * is fresh. Two similarly credible buses deliberately resolve to `null` so the
 * application asks the driver to choose instead of auto-assigning one.
 */
export function selectReliefCandidate(
  candidates: readonly ReliefCandidate[],
  options: ReliefCandidateSelectionOptions,
): ReliefCandidate | null {
  if (
    !Array.isArray(candidates)
    || candidates.length === 0
    || candidates.length > RELIEF_DETECTION_LIMITS.maximumCandidates
  ) return null;

  const stopId = boundedString(options.stopId, RELIEF_DETECTION_LIMITS.maximumIdLength);
  if (stopId === null || (options.directionId !== 0 && options.directionId !== 1)) return null;
  if (
    !Array.isArray(options.routeIds)
    || options.routeIds.length === 0
    || options.routeIds.length > RELIEF_DETECTION_LIMITS.maximumRouteIds
  ) return null;

  const routeIds = new Set<string>();
  for (const routeIdValue of options.routeIds) {
    const routeId = boundedString(routeIdValue, RELIEF_DETECTION_LIMITS.maximumIdLength);
    if (routeId === null) return null;
    routeIds.add(routeId);
  }

  const nowEpochSeconds = boundedInteger(options.nowEpochSeconds, 0, 10_000_000_000);
  const maximumObservationAgeSeconds = boundedInteger(
    options.maximumObservationAgeSeconds ?? RELIEF_DETECTION_LIMITS.maximumObservationAgeSeconds,
    1,
    600,
  );
  const maximumEtaSeconds = boundedNumber(
    options.maximumEtaSeconds ?? RELIEF_DETECTION_LIMITS.maximumEtaSeconds,
    0,
    3_600,
  );
  const maximumDistanceToStopMeters = boundedNumber(
    options.maximumDistanceToStopMeters ?? RELIEF_DETECTION_LIMITS.maximumDistanceToStopMeters,
    0,
    50_000,
  );
  const clearEtaAdvantageSeconds = boundedNumber(
    options.clearEtaAdvantageSeconds ?? RELIEF_DETECTION_LIMITS.clearEtaAdvantageSeconds,
    0,
    3_600,
  );
  const clearDistanceAdvantageMeters = boundedNumber(
    options.clearDistanceAdvantageMeters ?? RELIEF_DETECTION_LIMITS.clearDistanceAdvantageMeters,
    0,
    50_000,
  );
  if (
    nowEpochSeconds === null
    || maximumObservationAgeSeconds === null
    || maximumEtaSeconds === null
    || maximumDistanceToStopMeters === null
    || clearEtaAdvantageSeconds === null
    || clearDistanceAdvantageMeters === null
  ) return null;

  const eligible = candidates.filter((candidate) => {
    const ageSeconds = nowEpochSeconds - candidate.observedAtEpochSeconds;
    const hasUsableMetric = candidate.etaSeconds !== null
      || candidate.distanceToStopMeters !== null
      || candidate.phase === 'at_stop';

    return candidate.stopId === stopId
      && candidate.directionId === options.directionId
      && routeIds.has(candidate.routeId)
      && candidate.phase !== 'passed'
      && candidate.confidence !== 'low'
      && ageSeconds >= -RELIEF_DETECTION_LIMITS.futureObservationToleranceSeconds
      && ageSeconds <= maximumObservationAgeSeconds
      && (candidate.etaSeconds === null || candidate.etaSeconds <= maximumEtaSeconds)
      && (
        candidate.distanceToStopMeters === null
        || candidate.distanceToStopMeters <= maximumDistanceToStopMeters
      )
      && hasUsableMetric;
  }).sort(compareCandidates);

  const best = eligible[0];
  if (!best) return null;

  const second = eligible[1];
  if (!second) {
    return best.confidence === 'high' || best.phase === 'at_stop' ? best : null;
  }

  // Multiple vehicles simultaneously reported at the same stop are never an
  // automatic match, even if one report is a little newer.
  if (best.phase === 'at_stop' && second.phase === 'at_stop') return null;

  const strongAtStop = best.phase === 'at_stop' && best.confidence === 'high';
  const clearPhaseAdvantage = best.phase === 'at_stop' && second.phase === 'approaching';
  const clearConfidenceAdvantage = best.confidence === 'high' && second.confidence === 'medium';
  const clearEtaAdvantage = hasClearNumericAdvantage(
    best.etaSeconds,
    second.etaSeconds,
    clearEtaAdvantageSeconds,
  );
  const clearDistanceAdvantage = hasClearNumericAdvantage(
    best.distanceToStopMeters,
    second.distanceToStopMeters,
    clearDistanceAdvantageMeters,
  );

  return strongAtStop
    || clearPhaseAdvantage
    || clearConfidenceAdvantage
    || clearEtaAdvantage
    || clearDistanceAdvantage
    ? best
    : null;
}
