import React, { useEffect, useRef } from 'react';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { Newsreader_500Medium } from '@expo-google-fonts/newsreader';
import { useFonts } from 'expo-font';
import {
  createNavigationContainerRef,
  DefaultTheme,
  NavigationContainer,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import HomeScreen from './src/screens/HomeScreen';
import MapScreen from './src/screens/MapScreen';
import RoutesScreen from './src/screens/RoutesScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { PreferencesProvider, usePreferences } from './src/PreferencesContext';
import { colors } from './src/theme';
import AppErrorBoundary from './src/components/AppErrorBoundary';
import { apiService } from './src/services/api';
import { telemetry } from './src/services/telemetry';

export type RootStackParamList = {
  Home: { selectedRouteId?: string } | undefined;
  Routes: undefined;
  Settings: undefined;
  Map: {
    routeId: string;
    directionId: 0 | 1;
    assignedVehicle?: string;
    tripId?: string;
    directionLabel?: string;
  };
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const navigationRef = createNavigationContainerRef<RootStackParamList>();
const appBootStartedAt = Date.now();

telemetry.setTransport(apiService.submitTelemetryBatch);
const navigationTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.primary,
    background: colors.background,
    card: colors.surface,
    text: colors.ink,
    border: colors.border,
    notification: colors.primary,
  },
};

function AppContent() {
  const { preferences, ready } = usePreferences();
  const telemetryStartedRef = useRef(false);
  const currentScreenRef = useRef<string | undefined>(undefined);
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Newsreader_500Medium,
  });

  const appReady = (fontsLoaded || Boolean(fontError)) && ready;

  useEffect(() => {
    telemetry.setLanguage(preferences.language);
    if (!appReady || telemetryStartedRef.current) return;
    telemetryStartedRef.current = true;
    telemetry.start({
      appVersion: '1.0.0',
      durationMs: Date.now() - appBootStartedAt,
      language: preferences.language,
    });
  }, [appReady, preferences.language]);

  if (!appReady) return null;

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navigationTheme}
      onReady={() => {
        const screen = navigationRef.getCurrentRoute()?.name;
        currentScreenRef.current = screen;
        if (screen) telemetry.capture('screen_view', { screen });
      }}
      onStateChange={() => {
        const screen = navigationRef.getCurrentRoute()?.name;
        if (screen && screen !== currentScreenRef.current) {
          currentScreenRef.current = screen;
          telemetry.capture('screen_view', { screen });
        }
      }}
    >
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{ contentStyle: { backgroundColor: colors.background } }}
        />
        <Stack.Screen
          name="Routes"
          component={RoutesScreen}
          options={{ contentStyle: { backgroundColor: colors.background } }}
        />
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ contentStyle: { backgroundColor: colors.background } }}
        />
        <Stack.Screen
          name="Map"
          component={MapScreen}
          options={{ contentStyle: { backgroundColor: colors.mapBackground } }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      <SafeAreaProvider>
        <PreferencesProvider>
          <AppContent />
        </PreferencesProvider>
      </SafeAreaProvider>
    </AppErrorBoundary>
  );
}
