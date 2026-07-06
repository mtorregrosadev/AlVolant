import React, { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View, Text, ActivityIndicator } from 'react-native';
import { Map, Camera, GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { apiService } from './src/services/api';

const M30_ROUTE_ID = 'AMB_415';
const INITIAL_COORDINATES = [2.215, 41.45]; // Badalona/Barcelona

export default function App() {
  const [routeFeature, setRouteFeature] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket;

    async function loadData() {
      try {
        // Fetch static route shape
        const data = await apiService.fetchRouteShape(M30_ROUTE_ID);
        if (data && data.geojson) {
          setRouteFeature(data.geojson);
        }
        
        // Connect WebSocket for live updates (MVP test)
        ws = apiService.connectWebSocket((msg) => {
          // Simply log for MVP
          // console.log('Live update:', msg);
        });

        ws.addEventListener('open', () => setIsConnected(true));
        ws.addEventListener('close', () => setIsConnected(false));
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }

    loadData();

    return () => {
      if (ws) {
        ws.close();
      }
    };
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0000ff" />
        <Text>Loading route data...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Error: {error}</Text>
      </View>
    );
  }

  const routeSource = routeFeature ? {
    type: 'FeatureCollection',
    features: [routeFeature]
  } : null;

  return (
    <View style={styles.container}>
      <Map
        style={styles.map}
        mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
      >
        <Camera
          initialViewState={{
            center: INITIAL_COORDINATES as any,
            zoom: 12
          }}
        />

        {routeSource && (
          <GeoJSONSource id="routeSource" data={routeSource as any}>
            <Layer
              id="routeLine"
              type="line"
              layout={{
                'line-join': 'round',
                'line-cap': 'round',
              }}
              paint={{
                'line-color': '#007AFF', // Blue LineString
                'line-width': 5,
              }}
            />
          </GeoJSONSource>
        )}
      </Map>

      <View style={styles.statusBox}>
        <Text style={styles.statusText}>
          Route: M30 | WS: {isConnected ? '🟢 Connected' : '🔴 Disconnected'}
        </Text>
      </View>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  map: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    color: 'red',
    fontSize: 16,
  },
  statusBox: {
    position: 'absolute',
    top: 50,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    padding: 10,
    borderRadius: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  statusText: {
    fontSize: 14,
    fontWeight: 'bold',
    textAlign: 'center',
  }
});
