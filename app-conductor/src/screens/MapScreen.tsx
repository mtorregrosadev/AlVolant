import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import {
  Map,
  Camera,
  GeoJSONSource,
  Layer,
  Marker,
} from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import { apiService } from '../services/api';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
const INITIAL_COORDINATES = [2.215, 41.45]; // Badalona/Barcelona

type MapScreenProps = NativeStackScreenProps<RootStackParamList, 'Map'>;

export default function MapScreen({ route, navigation }: MapScreenProps) {
  const { routeId, directionId } = route.params;

  const [routeFeature, setRouteFeature] = useState<any>(null);
  const [stopsFeature, setStopsFeature] = useState<any>(null);
  const [selectedStop, setSelectedStop] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [locationGranted, setLocationGranted] = useState(false);
  const [trackingMode, setTrackingMode] = useState<string>('course');
  const [userCoords, setUserCoords] = useState<[number, number] | null>(INITIAL_COORDINATES as any);
  const [userHeading, setUserHeading] = useState<number>(0);
  const [mapBearing, setMapBearing] = useState<number>(0);
  
  const mapRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);

  // Request location permissions and start watching GPS coordinates/heading
  useEffect(() => {
    let subscription: any;

    async function setupLocation() {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        const granted = status === 'granted';
        setLocationGranted(granted);

        if (granted) {
          subscription = await Location.watchPositionAsync(
            {
              accuracy: Location.Accuracy.BestForNavigation,
              timeInterval: 1000,
              distanceInterval: 1,
            },
            (loc) => {
              if (loc.coords) {
                setUserCoords([loc.coords.longitude, loc.coords.latitude]);
                if (typeof loc.coords.heading === 'number') {
                  setUserHeading(loc.coords.heading);
                }
              }
            }
          );
        } else {
          console.warn('Location permission not granted');
        }
      } catch (err) {
        console.error('Error starting location tracking:', err);
      }
    }

    setupLocation();

    return () => {
      if (subscription) {
        subscription.remove();
      }
    };
  }, []);

  // Load route data and connect WebSocket
  useEffect(() => {
    let ws: WebSocket;

    async function loadData() {
      try {
        const data = await apiService.fetchRouteShape(routeId);
        if (data && data.geojson) {
          setRouteFeature(data.geojson);
        }

        const stopsData = await apiService.fetchRouteStops(routeId);
        if (stopsData && stopsData.features) {
          setStopsFeature(stopsData);
        }

        ws = apiService.connectWebSocket((msg) => {
          // Live updates for future phases
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
  }, [routeId]);

  const handleMapPress = async (event: any) => {
    if (!mapRef.current) return;

    let x: number | null = null;
    let y: number | null = null;

    // Safely extract coordinates depending on the event structure of the MapLibre version
    if (event?.nativeEvent?.point) {
      if (Array.isArray(event.nativeEvent.point)) {
        x = event.nativeEvent.point[0];
        y = event.nativeEvent.point[1];
      } else if (typeof event.nativeEvent.point === 'object') {
        x = event.nativeEvent.point.x;
        y = event.nativeEvent.point.y;
      }
    } else if (event?.point) {
      if (Array.isArray(event.point)) {
        x = event.point[0];
        y = event.point[1];
      } else if (typeof event.point === 'object') {
        x = event.point.x;
        y = event.point.y;
      }
    } else if (event?.properties) {
      x = event.properties.screenPointX;
      y = event.properties.screenPointY;
    }

    if (x === null || y === null) {
      console.log('Could not extract screen coordinates from tap event:', JSON.stringify(event));
      return;
    }

    try {
      console.log('Querying features at pixel point [', x, ',', y, '] with 40px bounding box hitbox...');
      const features = await mapRef.current.queryRenderedFeatures(
        [
          [x - 20, y - 20],
          [x + 20, y + 20]
        ],
        { layers: ['stopsCircle'] }
      );
      
      console.log('Query results count:', Array.isArray(features) ? features.length : (features?.features?.length || 0));
      console.log('Query features payload:', JSON.stringify(features));

      let selectedFeatureProperties = null;

      if (features && Array.isArray(features) && features.length > 0) {
        selectedFeatureProperties = features[0].properties;
      } else if (features && features.features && features.features.length > 0) {
        selectedFeatureProperties = features.features[0].properties;
      }

      if (selectedFeatureProperties) {
        console.log('Selecting stop properties:', JSON.stringify(selectedFeatureProperties));
        setSelectedStop(selectedFeatureProperties);
      } else {
        setSelectedStop(null);
      }
    } catch (e) {
      console.log('Error querying rendered features:', e);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#DC2626" />
        <Text style={styles.loadingText}>Carregant ruta M30...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Error: {error}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.retryText}>Tornar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const routeSource = routeFeature
    ? {
        type: 'FeatureCollection' as const,
        features: [routeFeature],
      }
    : null;

  const handleRegionChange = (event: any) => {
    if (event?.properties && typeof event.properties.bearing === 'number') {
      setMapBearing(event.properties.bearing);
    }
  };

  return (
    <View style={styles.container}>
      <Map
        ref={mapRef}
        style={styles.map}
        mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
        onPress={handleMapPress}
        onRegionDidChange={handleRegionChange}
        onRegionIsChanging={handleRegionChange}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{
            center: INITIAL_COORDINATES as any,
            zoom: 14,
            pitch: 60,
          }}
          trackUserLocation={trackingMode as any}
          onTrackUserLocationChange={(e) => {
            const mode = e.nativeEvent?.trackUserLocation;
            if (mode === null || mode === undefined) {
              setTrackingMode('none');
            } else {
              setTrackingMode(mode);
            }
          }}
          pitch={60}
          zoom={17}
        />

        {/* Custom user location: Programmatic TMB Bus Marker */}
        {locationGranted && userCoords && (
          <Marker
            id="userBusMarker"
            lngLat={userCoords}
            anchor="center"
          >
            <View style={{ transform: [{ rotate: `${userHeading - mapBearing}deg` }] }}>
              <View style={styles.busContainer}>
                <View style={styles.busBody}>
                  <View style={styles.busRedFront} />
                  <View style={styles.busRedBack} />
                  <View style={styles.busStripeLeft} />
                  <View style={styles.busStripeRight} />
                  <View style={styles.busWindshield} />
                  <View style={styles.busRearWindow} />
                  <View style={styles.busACUnit} />
                </View>
              </View>
            </View>
          </Marker>
        )}

        {/* Route polyline */}
        {routeSource && (
          <GeoJSONSource id="routeSource" data={routeSource as any}>
            <Layer
              id="routeLineGlow"
              type="line"
              layout={{
                'line-join': 'round',
                'line-cap': 'round',
              }}
              paint={{
                'line-color': '#DC2626',
                'line-width': 10,
                'line-opacity': 0.2,
              }}
            />
            <Layer
              id="routeLine"
              type="line"
              layout={{
                'line-join': 'round',
                'line-cap': 'round',
              }}
              paint={{
                'line-color': '#DC2626',
                'line-width': 4,
              }}
            />
          </GeoJSONSource>
        )}

        {/* Stop markers */}
        {stopsFeature && (
          <GeoJSONSource id="stopsSource" data={stopsFeature}>
            <Layer
              id="stopsCircle"
              type="circle"
              paint={{
                'circle-radius': 5,
                'circle-color': '#FFFFFF',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#DC2626',
              }}
            />
          </GeoJSONSource>
        )}
      </Map>

      {/* Top HUD */}
      <View style={styles.hudTop}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.backButtonText}>✕</Text>
        </TouchableOpacity>
        <View style={styles.routeHud}>
          <View style={styles.hudBadge}>
            <Text style={styles.hudBadgeText}>M30</Text>
          </View>
          <Text style={styles.hudDirection}>
            {directionId === 0 ? 'Anada' : 'Tornada'}
          </Text>
        </View>
        <View style={styles.wsIndicator}>
          <View
            style={[
              styles.wsDot,
              { backgroundColor: isConnected ? '#22C55E' : '#EF4444' },
            ]}
          />
        </View>
      </View>

      {/* Recenter Button */}
      {trackingMode !== 'course' && (
        <TouchableOpacity
          style={styles.recenterButton}
          onPress={() => setTrackingMode('course')}
        >
          <Text style={styles.recenterButtonText}>📍 Centrar Bus</Text>
        </TouchableOpacity>
      )}

      {/* Stop bottom sheet */}
      {selectedStop && (
        <View style={styles.bottomSheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <View style={styles.stopIcon}>
              <Text style={styles.stopIconText}>🚏</Text>
            </View>
            <View style={styles.stopInfo}>
              <Text style={styles.stopName}>
                {selectedStop.stop_name || 'Parada desconeguda'}
              </Text>
              <Text style={styles.stopId}>{selectedStop.stop_id}</Text>
            </View>
            <TouchableOpacity
              onPress={() => setSelectedStop(null)}
              style={styles.closeButton}
            >
              <Text style={styles.closeButtonText}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.stopStatusRow}>
            <View style={styles.statusPill}>
              <Text style={styles.statusPillText}>Activa</Text>
            </View>
            <Text style={styles.stopEta}>Propera parada</Text>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A1628',
  },
  map: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0A1628',
  },
  loadingText: {
    color: '#6B7FA3',
    marginTop: 12,
    fontSize: 14,
  },
  error: {
    color: '#EF4444',
    fontSize: 16,
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#1C2E4A',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  retryText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },

  // ── Top HUD ──
  hudTop: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(10, 22, 40, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  backButtonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  routeHud: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(10, 22, 40, 0.85)',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginHorizontal: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  hudBadge: {
    backgroundColor: '#DC2626',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginRight: 10,
  },
  hudBadgeText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  hudDirection: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  wsIndicator: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(10, 22, 40, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  wsDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  recenterButton: {
    position: 'absolute',
    bottom: 150, // Move it up so it never overlaps the bottom sheet
    right: 20,
    backgroundColor: '#DC2626',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
    elevation: 8,
    zIndex: 10, // Make sure it's above other elements
  },
  recenterButtonText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 16,
  },

  // ── Programmatic Bus Marker Styles ──
  busContainer: {
    width: 16,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 6,
  },
  busBody: {
    width: 16,
    height: 44,
    backgroundColor: '#FFFFFF', // White base
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#111F38',
    overflow: 'hidden',
    position: 'relative',
  },
  busRedFront: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 8,
    backgroundColor: '#DC2626', // TMB Red Front
  },
  busRedBack: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 8,
    backgroundColor: '#DC2626', // TMB Red Back
  },
  busStripeLeft: {
    position: 'absolute',
    top: 8,
    bottom: 8,
    left: 0,
    width: 2.5,
    backgroundColor: '#DC2626',
  },
  busStripeRight: {
    position: 'absolute',
    top: 8,
    bottom: 8,
    right: 0,
    width: 2.5,
    backgroundColor: '#DC2626',
  },
  busWindshield: {
    position: 'absolute',
    top: 3,
    left: 2,
    right: 2,
    height: 3,
    backgroundColor: '#1E293B', // Dark windshield glass
    borderRadius: 1,
  },
  busRearWindow: {
    position: 'absolute',
    bottom: 2,
    left: 2,
    right: 2,
    height: 2,
    backgroundColor: '#1E293B',
  },
  busACUnit: {
    position: 'absolute',
    top: 15,
    left: 3,
    right: 3,
    height: 8,
    backgroundColor: '#E2E8F0',
    borderRadius: 2,
    borderWidth: 0.5,
    borderColor: '#94A3B8',
  },

  // ── Bottom Sheet ──
  bottomSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#0F1D33',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 40,
    borderTopWidth: 1,
    borderColor: '#1C2E4A',
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#2A3F5F',
    alignSelf: 'center',
    marginBottom: 16,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  stopIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#1C2E4A',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  stopIconText: {
    fontSize: 22,
  },
  stopInfo: {
    flex: 1,
  },
  stopName: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  stopId: {
    fontSize: 12,
    color: '#4B6282',
    marginTop: 2,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#1C2E4A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonText: {
    color: '#6B7FA3',
    fontSize: 16,
    fontWeight: '700',
  },
  stopStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusPill: {
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    marginRight: 10,
  },
  statusPillText: {
    color: '#22C55E',
    fontSize: 12,
    fontWeight: '700',
  },
  stopEta: {
    color: '#4B6282',
    fontSize: 12,
  },
});
