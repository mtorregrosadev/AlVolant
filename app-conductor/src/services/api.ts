import { Platform } from 'react-native';

const API_KEY = 'dev-insecure-key-change-in-production';

// Use 10.0.2.2 for Android emulator to access localhost, localhost for iOS simulator
export const BASE_URL = Platform.OS === 'android' ? 'http://10.0.2.2:8000' : 'http://localhost:8000';
export const WS_URL = Platform.OS === 'android' ? 'ws://10.0.2.2:8000' : 'ws://localhost:8000';

export interface GTFSFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: {
      route_id: string;
      shape_id: string;
      route_short_name: string;
      route_long_name: string;
      route_color: string;
    };
    geometry: {
      type: 'LineString';
      coordinates: [number, number][];
    };
  }>;
}

export const apiService = {
  async fetchRouteShape(routeId: string) {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/gtfs/shapes/${routeId}`, {
        headers: {
          'X-API-Key': API_KEY,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Error fetching shape for ${routeId}:`, error);
      throw error;
    }
  },

  async fetchRouteStops(routeId: string) {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/gtfs/stops/${routeId}`, {
        headers: {
          'X-API-Key': API_KEY,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Error fetching stops for ${routeId}:`, error);
      throw error;
    }
  },

  connectWebSocket(onMessage?: (data: any) => void) {
    const ws = new WebSocket(`${WS_URL}/api/v1/ws/live?token=${API_KEY}`);

    ws.onopen = () => {
      console.log('✅ WebSocket connected to BFF live stream');
    };

    ws.onmessage = (event) => {
      // console.log('WebSocket message received');
      if (onMessage) {
        onMessage(JSON.parse(event.data));
      }
    };

    ws.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('WebSocket connection closed');
    };

    return ws;
  }
};
