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
  type UserPreferences,
  type VehicleColor,
} from './services/userPreferences';

type PreferencesContextValue = {
  ready: boolean;
  preferences: UserPreferences;
  toggleFavorite: (routeId: string) => void;
  recordRecent: (routeId: string, directionId: 0 | 1) => void;
  setLanguage: (language: AppLanguage) => void;
  setVehicleColor: (vehicleColor: VehicleColor) => void;
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: PropsWithChildren) {
  const mountedRef = useRef(true);
  const [ready, setReady] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferences>({ ...EMPTY_USER_PREFERENCES });

  useEffect(() => {
    mountedRef.current = true;
    void loadUserPreferences().then((stored) => {
      if (!mountedRef.current) return;
      setPreferences(stored);
      setReady(true);
    });

    return () => {
      mountedRef.current = false;
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
    updatePreferences((current) => ({ ...current, language }));
  }, [updatePreferences]);

  const setVehicleColor = useCallback((vehicleColor: VehicleColor) => {
    updatePreferences((current) => ({ ...current, vehicleColor }));
  }, [updatePreferences]);

  const value = useMemo<PreferencesContextValue>(() => ({
    ready,
    preferences,
    toggleFavorite,
    recordRecent,
    setLanguage,
    setVehicleColor,
  }), [preferences, ready, recordRecent, setLanguage, setVehicleColor, toggleFavorite]);

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const value = useContext(PreferencesContext);
  if (!value) {
    throw new Error('usePreferences must be used inside PreferencesProvider');
  }

  return value;
}
