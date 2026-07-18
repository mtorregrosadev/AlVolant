import AsyncStorage from '@react-native-async-storage/async-storage';
import { telemetry } from './telemetry';

// This is an opaque random installation identifier issued by the BFF. The
// server stores only an HMAC digest of it for rate limiting; it is not an
// account identifier and it is never used as proof of a subscription.
const STORAGE_KEY = '@alvolant/satellite-client/v1';
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{24,80}$/;

export async function loadSatelliteClientId(): Promise<string | null> {
  try {
    const value = await AsyncStorage.getItem(STORAGE_KEY);
    return value && CLIENT_ID_RE.test(value) ? value : null;
  } catch (error) {
    telemetry.captureException(error, { phase: 'satellite_client_read' });
    return null;
  }
}

export async function saveSatelliteClientId(clientId: string): Promise<void> {
  if (!CLIENT_ID_RE.test(clientId)) {
    return;
  }

  try {
    await AsyncStorage.setItem(STORAGE_KEY, clientId);
  } catch (error) {
    telemetry.captureException(error, { phase: 'satellite_client_write' });
  }
}
