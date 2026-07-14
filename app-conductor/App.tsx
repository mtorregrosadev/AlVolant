import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { Newsreader_500Medium } from '@expo-google-fonts/newsreader';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import {
  createNavigationContainerRef,
  DefaultTheme,
  NavigationContainer,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import HomeScreen from './src/screens/HomeScreen';
import MapScreen from './src/screens/MapScreen';
import RoutesScreen from './src/screens/RoutesScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { PreferencesProvider, usePreferences } from './src/PreferencesContext';
import { useI18n, type TranslationKey } from './src/i18n';
import { colors, fonts, radii, spacing } from './src/theme';
import AppErrorBoundary from './src/components/AppErrorBoundary';
import {
  apiService,
  StartupError,
  type StartupErrorKind,
} from './src/services/api';
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

type StartupState =
  | { status: 'checking' }
  | { status: 'ready' }
  | { status: 'error'; kind: StartupErrorKind };

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

const startupErrorCopy: Record<StartupErrorKind, {
  title: TranslationKey;
  hint: TranslationKey;
}> = {
  offline: {
    title: 'app.startupOffline',
    hint: 'app.startupOfflineHint',
  },
  unavailable: {
    title: 'app.startupUnavailable',
    hint: 'app.startupUnavailableHint',
  },
  invalid_response: {
    title: 'app.startupInvalid',
    hint: 'app.startupInvalidHint',
  },
  configuration: {
    title: 'app.startupConfiguration',
    hint: 'app.startupConfigurationHint',
  },
};

const STARTUP_BUS_WIDTH = 38;
const STARTUP_BUS_DURATION_MS = 3_200;
const STARTUP_BUS_EXIT_GAP = 8;
const STARTUP_MINIMUM_VISIBLE_MS = 1_100;

function StartupBus({ returning = false }: { returning?: boolean }) {
  return (
    <View style={styles.startupBusBody}>
      <View style={styles.startupBusWindows}>
        <View style={styles.startupBusWindow} />
        <View style={styles.startupBusWindow} />
        <View style={styles.startupBusWindow} />
      </View>
      <View
        style={[
          styles.startupBusWindshield,
          returning ? styles.startupBusWindshieldLeft : styles.startupBusWindshieldRight,
        ]}
      />
      <View style={[styles.startupBusWheel, styles.startupBusWheelLeft]} />
      <View style={[styles.startupBusWheel, styles.startupBusWheelRight]} />
    </View>
  );
}

function StartupTransitLoader() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const trackWidth = Math.max(236, width - insets.left - insets.right);
  const busProgress = useRef(new Animated.Value(0)).current;
  // Stay still until the system preference is known, avoiding a flash of
  // motion for users who have Reduce Motion enabled.
  const [reduceMotionEnabled, setReduceMotionEnabled] = useState(true);

  useEffect(() => {
    let active = true;

    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active) setReduceMotionEnabled(enabled);
      })
      .catch(() => undefined);

    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotionEnabled,
    );

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    busProgress.stopAnimation();
    busProgress.setValue(0);
    if (reduceMotionEnabled) return undefined;

    const loop = Animated.loop(
      Animated.timing(busProgress, {
        toValue: 1,
        duration: STARTUP_BUS_DURATION_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
      { resetBeforeIteration: true },
    );
    loop.start();

    return () => {
      loop.stop();
      busProgress.stopAnimation();
    };
  }, [busProgress, reduceMotionEnabled]);

  const leftExit = -STARTUP_BUS_WIDTH - STARTUP_BUS_EXIT_GAP;
  const rightExit = trackWidth + STARTUP_BUS_EXIT_GAP;
  const forwardTranslateX = busProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [leftExit, rightExit],
  });
  const reverseTranslateX = busProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [rightExit, leftExit],
  });

  return (
    <View
      style={[styles.startupTransitViewport, { width: trackWidth }]}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      <View style={[styles.startupTransitLine, styles.startupTransitLineTop]} />
      <View style={[styles.startupTransitLine, styles.startupTransitLineBottom]} />
      <View style={[styles.startupTransitStop, styles.startupTransitStopTopFirst]} />
      <View style={[styles.startupTransitStop, styles.startupTransitStopTopLast]} />
      <View style={[styles.startupTransitStop, styles.startupTransitStopBottomFirst]} />
      <View style={[styles.startupTransitStop, styles.startupTransitStopBottomLast]} />

      {reduceMotionEnabled ? (
        <>
          <View style={[
            styles.startupBus,
            styles.startupBusTop,
            { left: trackWidth * 0.25 - STARTUP_BUS_WIDTH / 2 },
          ]}>
            <StartupBus />
          </View>
          <View style={[
            styles.startupBus,
            styles.startupBusBottom,
            styles.startupBusReturn,
            { left: trackWidth * 0.75 - STARTUP_BUS_WIDTH / 2 },
          ]}>
            <StartupBus returning />
          </View>
        </>
      ) : (
        <>
          <Animated.View style={[
            styles.startupBus,
            styles.startupBusTop,
            { transform: [{ translateX: forwardTranslateX }] },
          ]}>
            <StartupBus />
          </Animated.View>
          <Animated.View style={[
            styles.startupBus,
            styles.startupBusBottom,
            styles.startupBusReturn,
            { transform: [{ translateX: reverseTranslateX }] },
          ]}>
            <StartupBus returning />
          </Animated.View>
        </>
      )}
    </View>
  );
}

function StartupGate({
  state,
  onRetry,
}: {
  state: Exclude<StartupState, { status: 'ready' }>;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const isChecking = state.status === 'checking';
  const errorCopy = state.status === 'error' ? startupErrorCopy[state.kind] : null;

  return (
    <SafeAreaView style={styles.startupSafeArea}>
      <StatusBar style="dark" />
      <View
        style={styles.startupContent}
        accessibilityRole={isChecking ? 'progressbar' : 'alert'}
        accessibilityLiveRegion="polite"
        accessibilityLabel={isChecking ? t('app.loading') : t(errorCopy!.title)}
      >
        {!isChecking ? (
          <View style={[styles.startupMark, styles.startupMarkError]}>
            <MaterialCommunityIcons
              name="cloud-alert-outline"
              size={28}
              color={colors.danger}
            />
          </View>
        ) : null}

        <Text style={styles.startupTitle}>
          {isChecking ? t('app.loading') : t(errorCopy!.title)}
        </Text>
        <Text style={styles.startupHint}>
          {isChecking ? t('app.loadingHint') : t(errorCopy!.hint)}
        </Text>

        {isChecking ? (
          <View style={styles.startupProgress}>
            <StartupTransitLoader />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('app.retry')}
            onPress={onRetry}
            style={({ pressed }) => [
              styles.startupRetry,
              pressed && styles.startupRetryPressed,
            ]}
          >
            <MaterialCommunityIcons name="refresh" size={19} color={colors.white} />
            <Text style={styles.startupRetryText}>{t('app.retry')}</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

function AppContent() {
  const { preferences, ready } = usePreferences();
  const telemetryStartedRef = useRef(false);
  const currentScreenRef = useRef<string | undefined>(undefined);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [startupState, setStartupState] = useState<StartupState>({ status: 'checking' });
  const [localReadyTimedOut, setLocalReadyTimedOut] = useState(false);
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Newsreader_500Medium,
  });

  const localStateReady = localReadyTimedOut || ((fontsLoaded || Boolean(fontError)) && ready);
  const appReady = localStateReady && startupState.status === 'ready';

  useEffect(() => {
    if ((fontsLoaded || Boolean(fontError)) && ready) return undefined;
    const timer = setTimeout(() => setLocalReadyTimedOut(true), 4_000);
    return () => clearTimeout(timer);
  }, [fontError, fontsLoaded, ready]);

  useEffect(() => {
    if (!localStateReady) return undefined;

    const controller = new AbortController();
    let active = true;
    let minimumTimer: ReturnType<typeof setTimeout> | null = null;
    setStartupState({ status: 'checking' });

    const minimumVisible = new Promise<void>((resolve) => {
      minimumTimer = setTimeout(resolve, STARTUP_MINIMUM_VISIBLE_MS);
    });

    void Promise.all([
      apiService.waitUntilReady(controller.signal),
      minimumVisible,
    ])
      .then(() => {
        if (active) setStartupState({ status: 'ready' });
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setStartupState({
          status: 'error',
          kind: error instanceof StartupError ? error.kind : 'offline',
        });
      });

    return () => {
      active = false;
      if (minimumTimer) clearTimeout(minimumTimer);
      controller.abort();
    };
  }, [localStateReady, startupAttempt]);

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

  if (!localStateReady) {
    return (
      <StartupGate
        state={{ status: 'checking' }}
        onRetry={() => setStartupAttempt((attempt) => attempt + 1)}
      />
    );
  }

  if (startupState.status !== 'ready') {
    return (
      <StartupGate
        state={startupState}
        onRetry={() => {
          setStartupState({ status: 'checking' });
          setStartupAttempt((attempt) => attempt + 1);
        }}
      />
    );
  }

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

const styles = StyleSheet.create({
  startupSafeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  startupContent: {
    flex: 1,
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xl,
  },
  startupMark: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primaryWash,
    marginBottom: spacing.xl,
  },
  startupMarkError: {
    borderColor: colors.danger,
    backgroundColor: '#F8E9E6',
  },
  startupTitle: {
    width: '100%',
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 24,
    lineHeight: 30,
    textAlign: 'center',
    letterSpacing: -0.25,
    flexShrink: 1,
  },
  startupHint: {
    maxWidth: 330,
    marginTop: spacing.sm,
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  startupProgress: {
    minHeight: 56,
    width: '100%',
    marginTop: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startupTransitViewport: {
    height: 68,
    overflow: 'hidden',
  },
  startupTransitLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderStrong,
  },
  startupTransitLineTop: { top: 20 },
  startupTransitLineBottom: { top: 50 },
  startupTransitStop: {
    position: 'absolute',
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.background,
  },
  startupTransitStopTopFirst: { top: 16, left: 26 },
  startupTransitStopTopLast: { top: 16, right: 26 },
  startupTransitStopBottomFirst: { top: 46, left: 72 },
  startupTransitStopBottomLast: { top: 46, right: 72 },
  startupBus: {
    position: 'absolute',
    left: 0,
    width: STARTUP_BUS_WIDTH,
    height: 25,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: colors.primaryPressed,
  },
  startupBusBody: {
    width: '100%',
    height: '100%',
  },
  startupBusWindows: {
    position: 'absolute',
    top: 4,
    left: 7,
    right: 7,
    height: 8,
    flexDirection: 'row',
    gap: 2,
  },
  startupBusWindow: {
    flex: 1,
    borderRadius: 1.5,
    backgroundColor: '#EAF6F2',
  },
  startupBusWindshield: {
    position: 'absolute',
    top: 4,
    width: 3,
    height: 9,
    borderRadius: 1,
    backgroundColor: colors.white,
  },
  startupBusWindshieldLeft: { left: 2 },
  startupBusWindshieldRight: { right: 2 },
  startupBusWheel: {
    position: 'absolute',
    bottom: -3,
    width: 7,
    height: 7,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.background,
    backgroundColor: colors.ink,
  },
  startupBusWheelLeft: { left: 6 },
  startupBusWheelRight: { right: 6 },
  startupBusTop: { top: 8 },
  startupBusBottom: { top: 38 },
  startupBusReturn: {
    backgroundColor: colors.warning,
    borderColor: '#8C4F08',
  },
  startupRetry: {
    minHeight: 48,
    marginTop: spacing.xl,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
  },
  startupRetryPressed: {
    backgroundColor: colors.primaryPressed,
    transform: [{ scale: 0.98 }],
  },
  startupRetryText: {
    color: colors.white,
    fontFamily: fonts.label,
    fontSize: 14,
    lineHeight: 18,
  },
});
