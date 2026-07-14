import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

export const BACKGROUND_ROUTE_TASK = 'alvolant-background-route-location';

type BackgroundLocationPayload = {
  locations?: Location.LocationObject[];
};

export type BackgroundPermissionResult =
  | 'granted'
  | 'foreground-denied'
  | 'unavailable';

// Core Location exposes a single named task. Serialize lifecycle changes so a
// slow native start can never finish after a route has already been closed.
let trackingDesired = false;
let trackingOperation: Promise<void> = Promise.resolve();

function enqueueTrackingOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = trackingOperation.then(operation, operation);
  trackingOperation = result.then(() => undefined, () => undefined);
  return result;
}

// Tasks must be defined at module scope so iOS can load them without mounting React.
// Coordinates deliberately stay inside Core Location: they are not logged, persisted,
// sent to telemetry, or transmitted to the BFF.
if (!TaskManager.isTaskDefined(BACKGROUND_ROUTE_TASK)) {
  TaskManager.defineTask<BackgroundLocationPayload>(BACKGROUND_ROUTE_TASK, async ({ error }) => {
    if (error) {
      console.warn('Background route location update failed');
    }
  });
}

async function isBackgroundRuntimeAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') {
    return false;
  }

  try {
    return await TaskManager.isAvailableAsync()
      && await Location.isBackgroundLocationAvailableAsync();
  } catch {
    return false;
  }
}

export async function requestBackgroundRoutePermission(): Promise<BackgroundPermissionResult> {
  if (!await isBackgroundRuntimeAvailable()) {
    return 'unavailable';
  }

  let foreground = await Location.getForegroundPermissionsAsync();
  if (foreground.status !== Location.PermissionStatus.GRANTED) {
    foreground = await Location.requestForegroundPermissionsAsync();
  }
  if (foreground.status !== Location.PermissionStatus.GRANTED) {
    return 'foreground-denied';
  }

  // Intentionally do not call requestBackgroundPermissionsAsync on iOS. A route
  // is a user-initiated session: Core Location can keep that active session
  // running with When In Use authorization, the location background mode and
  // the visible blue indicator. It must never become permanent monitoring.
  return 'granted';
}

export async function startBackgroundRouteTracking(): Promise<boolean> {
  trackingDesired = true;
  return enqueueTrackingOperation(async () => {
    if (!trackingDesired || !await isBackgroundRuntimeAvailable()) {
      return false;
    }

    const foreground = await Location.getForegroundPermissionsAsync();
    if (
      !trackingDesired
      || foreground.status !== Location.PermissionStatus.GRANTED
    ) {
      return false;
    }

    if (!await Location.hasStartedLocationUpdatesAsync(BACKGROUND_ROUTE_TASK)) {
      await Location.startLocationUpdatesAsync(BACKGROUND_ROUTE_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        activityType: Location.LocationActivityType.OtherNavigation,
        distanceInterval: 5,
        deferredUpdatesDistance: 10,
        deferredUpdatesInterval: 5_000,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
      });
    }

    if (!trackingDesired) {
      if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_ROUTE_TASK)) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_ROUTE_TASK);
      }
      return false;
    }

    return true;
  });
}

export async function stopBackgroundRouteTracking(): Promise<void> {
  trackingDesired = false;
  await enqueueTrackingOperation(async () => {
    try {
      if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_ROUTE_TASK)) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_ROUTE_TASK);
      }
    } catch {
      // Do not expose native details, but keep failures visible while testing.
      console.warn('Background route tracking could not stop cleanly');
    }
  });
}
