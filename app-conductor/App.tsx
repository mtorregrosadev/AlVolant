import React from 'react';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import HomeScreen from './src/screens/HomeScreen';
import MapScreen from './src/screens/MapScreen';
import RoutesScreen from './src/screens/RoutesScreen';
import { colors } from './src/theme';

export type RootStackParamList = {
  Home: { selectedRouteId?: string } | undefined;
  Routes: undefined;
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

export default function App() {
  return (
    <SafeAreaProvider>
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
            name="Map"
            component={MapScreen}
            options={{ contentStyle: { backgroundColor: colors.mapBackground } }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
