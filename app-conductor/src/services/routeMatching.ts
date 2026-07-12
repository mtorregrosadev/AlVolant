/** A WGS84 coordinate in `[longitude, latitude]` order. */
export type RouteMatchCoordinate = [number, number];

/** Whether the vehicle marker follows the route geometry or the raw GPS fix. */
export type RouteMatchMode = 'snapped' | 'offRoute';

export type RouteMatchPendingTransition = {
  to: RouteMatchMode;
  sinceMs: number;
};

/**
 * Persistent state for the route-matching reducer.
 *
 * Keep one state per active journey. Create a fresh state when the route or
 * direction changes so evidence from the previous journey cannot leak into it.
 */
export type RouteMatchingState = {
  mode: RouteMatchMode;
  pendingTransition: RouteMatchPendingTransition | null;
  previousRawCoordinate: RouteMatchCoordinate | null;
  headingDegrees: number | null;
  updatedAtMs: number | null;
};

/** One GPS fix and its nearest projection on the active route. */
export type RouteMatchFix = {
  rawCoordinate: RouteMatchCoordinate;
  snappedCoordinate: RouteMatchCoordinate;
  distanceFromRouteMeters: number;
  accuracyMeters: number | null;
  /** Native GPS/course heading. Values outside 0...360 are treated as absent. */
  headingDegrees?: number | null;
  /** Monotonic or epoch timestamp supplied by the caller. */
  timestampMs: number;
};

export type RouteMatchTransition = {
  from: RouteMatchMode;
  to: RouteMatchMode;
};

export type RouteMatchResult = {
  state: RouteMatchingState;
  mode: RouteMatchMode;
  transition: RouteMatchTransition | null;
  /** Raw GPS off-route; route projection while snapped. */
  visualTarget: RouteMatchCoordinate;
  /** Valid native heading, inferred course, or the last known heading. */
  headingDegrees: number | null;
  movementMeters: number | null;
  accuracyReliable: boolean;
  /** Conservative distance outside the GPS uncertainty circle. */
  offRouteConfidenceMeters: number | null;
  rejoinThresholdMeters: number | null;
};

export const ROUTE_MATCHING_THRESHOLDS = Object.freeze({
  maximumReliableAccuracyMeters: 45,
  leaveConfidenceMeters: 25,
  immediateLeaveConfidenceMeters: 100,
  leaveConfirmationMs: 1_800,
  minimumRejoinDistanceMeters: 18,
  rejoinAccuracyPaddingMeters: 3,
  rejoinConfirmationMs: 2_500,
  minimumHeadingMovementMeters: 3,
});

export function createRouteMatchingState(
  initialMode: RouteMatchMode = 'snapped',
): RouteMatchingState {
  return {
    mode: initialMode,
    pendingTransition: null,
    previousRawCoordinate: null,
    headingDegrees: null,
    updatedAtMs: null,
  };
}

export function isReliableRouteMatchAccuracy(
  accuracyMeters: number | null | undefined,
): accuracyMeters is number {
  return typeof accuracyMeters === 'number'
    && Number.isFinite(accuracyMeters)
    && accuracyMeters >= 0
    && accuracyMeters <= ROUTE_MATCHING_THRESHOLDS.maximumReliableAccuracyMeters;
}

/** Returns a heading in `[0, 360)`, or `null` for a native invalid value. */
export function validateRouteMatchHeading(
  headingDegrees: number | null | undefined,
): number | null {
  if (
    typeof headingDegrees !== 'number'
    || !Number.isFinite(headingDegrees)
    || headingDegrees < 0
    || headingDegrees > 360
  ) {
    return null;
  }

  return headingDegrees === 360 ? 0 : headingDegrees;
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function distanceMeters(from: RouteMatchCoordinate, to: RouteMatchCoordinate) {
  const [fromLongitude, fromLatitude] = from;
  const [toLongitude, toLatitude] = to;
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = toRadians(toLatitude - fromLatitude);
  const longitudeDelta = toRadians(toLongitude - fromLongitude);
  const fromLatitudeRadians = toRadians(fromLatitude);
  const toLatitudeRadians = toRadians(toLatitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(fromLatitudeRadians)
      * Math.cos(toLatitudeRadians)
      * Math.sin(longitudeDelta / 2) ** 2;

  return earthRadiusMeters * 2 * Math.atan2(
    Math.sqrt(haversine),
    Math.sqrt(Math.max(0, 1 - haversine)),
  );
}

function bearingBetween(from: RouteMatchCoordinate, to: RouteMatchCoordinate) {
  const [fromLongitude, fromLatitude] = from;
  const [toLongitude, toLatitude] = to;
  const fromLatitudeRadians = toRadians(fromLatitude);
  const toLatitudeRadians = toRadians(toLatitude);
  const longitudeDelta = toRadians(toLongitude - fromLongitude);
  const y = Math.sin(longitudeDelta) * Math.cos(toLatitudeRadians);
  const x = Math.cos(fromLatitudeRadians) * Math.sin(toLatitudeRadians)
    - Math.sin(fromLatitudeRadians)
      * Math.cos(toLatitudeRadians)
      * Math.cos(longitudeDelta);

  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function validNonNegativeDistance(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function monotonicTimestamp(previousTimestampMs: number | null, timestampMs: number) {
  const finiteTimestamp = Number.isFinite(timestampMs) ? Math.max(0, timestampMs) : 0;
  return previousTimestampMs === null
    ? finiteTimestamp
    : Math.max(previousTimestampMs, finiteTimestamp);
}

function confirmedTransition(
  currentMode: RouteMatchMode,
  pendingTransition: RouteMatchPendingTransition | null,
  targetMode: RouteMatchMode,
  timestampMs: number,
  confirmationMs: number,
) {
  if (pendingTransition?.to !== targetMode) {
    return {
      mode: currentMode,
      pendingTransition: { to: targetMode, sinceMs: timestampMs },
    };
  }

  if (timestampMs - pendingTransition.sinceMs < confirmationMs) {
    return { mode: currentMode, pendingTransition };
  }

  return { mode: targetMode, pendingTransition: null };
}

/**
 * Reduces a GPS fix into a stable snapped/off-route decision.
 *
 * An inaccurate fix clears pending evidence but never changes the current
 * mode. This prevents time spent without reliable GPS from completing a
 * transition. Leaving the route uses the distance outside the reported GPS
 * uncertainty (`distance - accuracy`), while rejoining uses a small
 * accuracy-aware corridor.
 */
export function updateRouteMatch(
  previousState: RouteMatchingState,
  fix: RouteMatchFix,
): RouteMatchResult {
  const timestampMs = monotonicTimestamp(previousState.updatedAtMs, fix.timestampMs);
  const distanceFromRouteMeters = validNonNegativeDistance(fix.distanceFromRouteMeters);
  const accuracyMeters = isReliableRouteMatchAccuracy(fix.accuracyMeters)
    ? fix.accuracyMeters
    : null;
  const accuracyReliable = accuracyMeters !== null;
  const offRouteConfidenceMeters = accuracyReliable && distanceFromRouteMeters !== null
    ? distanceFromRouteMeters - accuracyMeters
    : null;
  const rejoinThresholdMeters = accuracyReliable
    ? Math.max(
      ROUTE_MATCHING_THRESHOLDS.minimumRejoinDistanceMeters,
      accuracyMeters + ROUTE_MATCHING_THRESHOLDS.rejoinAccuracyPaddingMeters,
    )
    : null;

  let mode = previousState.mode;
  let pendingTransition = previousState.pendingTransition;

  if (!accuracyReliable || distanceFromRouteMeters === null) {
    pendingTransition = null;
  } else if (mode === 'snapped') {
    if (
      offRouteConfidenceMeters !== null
      && offRouteConfidenceMeters >= ROUTE_MATCHING_THRESHOLDS.immediateLeaveConfidenceMeters
    ) {
      mode = 'offRoute';
      pendingTransition = null;
    } else if (
      offRouteConfidenceMeters !== null
      && offRouteConfidenceMeters >= ROUTE_MATCHING_THRESHOLDS.leaveConfidenceMeters
    ) {
      ({ mode, pendingTransition } = confirmedTransition(
        mode,
        pendingTransition,
        'offRoute',
        timestampMs,
        ROUTE_MATCHING_THRESHOLDS.leaveConfirmationMs,
      ));
    } else {
      pendingTransition = null;
    }
  } else if (
    rejoinThresholdMeters !== null
    && distanceFromRouteMeters <= rejoinThresholdMeters
  ) {
    ({ mode, pendingTransition } = confirmedTransition(
      mode,
      pendingTransition,
      'snapped',
      timestampMs,
      ROUTE_MATCHING_THRESHOLDS.rejoinConfirmationMs,
    ));
  } else {
    pendingTransition = null;
  }

  const movementMeters = previousState.previousRawCoordinate
    ? distanceMeters(previousState.previousRawCoordinate, fix.rawCoordinate)
    : null;
  const nativeHeading = validateRouteMatchHeading(fix.headingDegrees);
  const inferredHeading = previousState.previousRawCoordinate
    && movementMeters !== null
    && movementMeters > ROUTE_MATCHING_THRESHOLDS.minimumHeadingMovementMeters
    ? bearingBetween(previousState.previousRawCoordinate, fix.rawCoordinate)
    : null;
  const headingDegrees = nativeHeading ?? inferredHeading ?? previousState.headingDegrees;
  const transition = mode === previousState.mode
    ? null
    : { from: previousState.mode, to: mode };
  const visualTarget = mode === 'offRoute'
    ? fix.rawCoordinate
    : fix.snappedCoordinate;
  const state: RouteMatchingState = {
    mode,
    pendingTransition,
    previousRawCoordinate: [...fix.rawCoordinate],
    headingDegrees,
    updatedAtMs: timestampMs,
  };

  return {
    state,
    mode,
    transition,
    visualTarget: [...visualTarget],
    headingDegrees,
    movementMeters,
    accuracyReliable,
    offRouteConfidenceMeters,
    rejoinThresholdMeters,
  };
}
