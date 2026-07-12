import React from 'react';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { Newsreader_500Medium } from '@expo-google-fonts/newsreader';
import { useFonts } from 'expo-font';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import HomeScreen from './src/screens/HomeScreen';
import MapScreen from './src/screens/MapScreen';
import RoutesScreen from './src/screens/RoutesScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { PreferencesProvider, usePreferences } from './src/PreferencesContext';
import { colors } from './src/theme';

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
  const { ready } = usePreferences();
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Newsreader_500Medium,
  });

  if ((!fontsLoaded && !fontError) || !ready) return null;

  return (
    <NavigationContainer theme={navigationTheme}>
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
    <SafeAreaProvider>
      <PreferencesProvider>
        <AppContent />
      </PreferencesProvider>
    </SafeAreaProvider>
  );
}
