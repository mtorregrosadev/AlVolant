import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import {
  EMPTY_USER_PREFERENCES,
  loadUserPreferences,
  saveUserPreferences,
  withRecordedRecent,
  withToggledFavorite,
  type AppLanguage,
  type HomeAgency,
  type RouteLineColor,
  type UserPreferences,
  type VehicleColor,
  type VehicleMarker,
} from './services/userPreferences';
import { telemetry } from './services/telemetry';

type PreferencesContextValue = {
  ready: boolean;
  preferences: UserPreferences;
  toggleFavorite: (routeId: string) => void;
  recordRecent: (routeId: string, directionId: 0 | 1) => void;
  setLanguage: (language: AppLanguage) => void;
  setVehicleColor: (vehicleColor: VehicleColor) => void;
  setVehicleMarker: (vehicleMarker: VehicleMarker) => void;
  setHomeAgencies: (homeAgencyIds: HomeAgency[]) => void;
  setBackgroundLocationEnabled: (enabled: boolean) => void;
  setKeepAwakeEnabled: (enabled: boolean) => void;
  setLiveActivitiesEnabled: (enabled: boolean) => void;
  setBuildings3dEnabled: (enabled: boolean) => void;
  setRouteLineDynamic: (enabled: boolean) => void;
  setRouteLineColor: (color: RouteLineColor) => void;
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: PropsWithChildren) {
  const mountedRef = useRef(true);
  const [ready, setReady] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferences>({ ...EMPTY_USER_PREFERENCES });

  useEffect(() => {
    mountedRef.current = true;
    let settled = false;
    const fallbackTimer = setTimeout(() => {
      if (!mountedRef.current || settled) return;
      settled = true;
      // A blocked keychain/storage service must not leave the app on a blank
      // screen forever. The in-memory defaults remain private and usable.
      setReady(true);
    }, 3_000);

    void loadUserPreferences().then((stored) => {
      if (!mountedRef.current || settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      setPreferences(stored);
      setReady(true);
    });

    return () => {
      mountedRef.current = false;
      clearTimeout(fallbackTimer);
    };
  }, []);

  const updatePreferences = useCallback((updater: (current: UserPreferences) => UserPreferences) => {
    setPreferences((current) => {
      const next = updater(current);
      void saveUserPreferences(next);
      return next;
    });
  }, []);

  const toggleFavorite = useCallback((routeId: string) => {
    updatePreferences((current) => withToggledFavorite(current, routeId));
  }, [updatePreferences]);

  const recordRecent = useCallback((routeId: string, directionId: 0 | 1) => {
    updatePreferences((current) => withRecordedRecent(current, routeId, directionId));
  }, [updatePreferences]);

  const setLanguage = useCallback((language: AppLanguage) => {
    telemetry.capture('preference_changed', { setting: 'language', value: language });
    updatePreferences((current) => ({ ...current, language }));
  }, [updatePreferences]);

  const setVehicleColor = useCallback((vehicleColor: VehicleColor) => {
    telemetry.capture('preference_changed', { setting: 'vehicle_color', value: vehicleColor });
    updatePreferences((current) => ({ ...current, vehicleColor }));
  }, [updatePreferences]);

  const setVehicleMarker = useCallback((vehicleMarker: VehicleMarker) => {
    telemetry.capture('preference_changed', { setting: 'vehicle_marker', value: vehicleMarker });
    updatePreferences((current) => ({ ...current, vehicleMarker }));
  }, [updatePreferences]);

  const setHomeAgencies = useCallback((homeAgencyIds: HomeAgency[]) => {
    const normalized = Array.from(new Set(homeAgencyIds));
    if (!normalized.length) return;

    telemetry.capture('preference_changed', {
      setting: 'home_agencies',
      value: normalized.join(','),
    });
    updatePreferences((current) => ({
      ...current,
      homeAgencyIds: normalized,
      hasCompletedOnboarding: true,
    }));
  }, [updatePreferences]);

  const setBackgroundLocationEnabled = useCallback((enabled: boolean) => {
    telemetry.capture('preference_changed', { setting: 'background_location', value: enabled });
    updatePreferences((current) => ({ ...current, backgroundLocationEnabled: enabled }));
  }, [updatePreferences]);

  const setKeepAwakeEnabled = useCallback((enabled: boolean) => {
    telemetry.capture('preference_changed', { setting: 'keep_screen_awake', value: enabled });
    updatePreferences((current) => ({ ...current, keepAwakeEnabled: enabled }));
  }, [updatePreferences]);

  const setLiveActivitiesEnabled = useCallback((enabled: boolean) => {
    telemetry.capture('preference_changed', { setting: 'live_activities', value: enabled });
    updatePreferences((current) => ({ ...current, liveActivitiesEnabled: enabled }));
  }, [updatePreferences]);

  const setBuildings3dEnabled = useCallback((enabled: boolean) => {
    telemetry.capture('preference_changed', { setting: 'buildings_3d', value: enabled });
    updatePreferences((current) => ({ ...current, buildings3dEnabled: enabled }));
  }, [updatePreferences]);

  const setRouteLineDynamic = useCallback((enabled: boolean) => {
    telemetry.capture('preference_changed', { setting: 'route_line_dynamic', value: enabled });
    updatePreferences((current) => ({ ...current, routeLineDynamic: enabled }));
  }, [updatePreferences]);

  const setRouteLineColor = useCallback((routeLineColor: RouteLineColor) => {
    telemetry.capture('preference_changed', { setting: 'route_line_color', value: routeLineColor });
    updatePreferences((current) => ({ ...current, routeLineColor }));
  }, [updatePreferences]);

  const value = useMemo<PreferencesContextValue>(() => ({
    ready,
    preferences,
    toggleFavorite,
    recordRecent,
    setLanguage,
    setVehicleColor,
    setVehicleMarker,
    setHomeAgencies,
    setBackgroundLocationEnabled,
    setKeepAwakeEnabled,
    setLiveActivitiesEnabled,
    setBuildings3dEnabled,
    setRouteLineDynamic,
    setRouteLineColor,
  }), [
    preferences,
    ready,
    recordRecent,
    setBackgroundLocationEnabled,
    setKeepAwakeEnabled,
    setLiveActivitiesEnabled,
    setBuildings3dEnabled,
    setRouteLineDynamic,
    setRouteLineColor,
    setLanguage,
    setVehicleColor,
    setVehicleMarker,
    setHomeAgencies,
    toggleFavorite,
  ]);

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const value = useContext(PreferencesContext);
  if (!value) {
    throw new Error('usePreferences must be used inside PreferencesProvider');
  }

  return value;
}
