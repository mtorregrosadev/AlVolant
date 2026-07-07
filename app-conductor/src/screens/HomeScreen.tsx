import React, { useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
} from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';

type HomeScreenProps = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Home'>;
};

export default function HomeScreen({ navigation }: HomeScreenProps) {
  const [directionId, setDirectionId] = useState<0 | 1>(0);

  const handleStartDriving = () => {
    navigation.navigate('Map', {
      routeId: 'AMB_415',
      directionId,
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.appTitle}>🚌 AlVolant</Text>
          <Text style={styles.subtitle}>Sistema de Conducció Intel·ligent</Text>
        </View>

        {/* Route Card */}
        <View style={styles.routeCard}>
          <View style={styles.routeBadge}>
            <Text style={styles.routeBadgeText}>M30</Text>
          </View>
          <View style={styles.routeInfo}>
            <Text style={styles.routeName}>MetroBus M30</Text>
            <Text style={styles.routeDesc}>Badalona — Av. Diagonal</Text>
          </View>
        </View>

        {/* Direction Toggle */}
        <View style={styles.directionSection}>
          <Text style={styles.sectionLabel}>DIRECCIÓ</Text>
          <View style={styles.directionToggle}>
            <TouchableOpacity
              style={[
                styles.directionButton,
                directionId === 0 && styles.directionButtonActive,
              ]}
              onPress={() => setDirectionId(0)}
            >
              <Text style={styles.directionArrow}>→</Text>
              <Text
                style={[
                  styles.directionText,
                  directionId === 0 && styles.directionTextActive,
                ]}
              >
                Anada
              </Text>
              <Text
                style={[
                  styles.directionSubtext,
                  directionId === 0 && styles.directionSubtextActive,
                ]}
              >
                Cap a Barcelona
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.directionButton,
                directionId === 1 && styles.directionButtonActive,
              ]}
              onPress={() => setDirectionId(1)}
            >
              <Text style={styles.directionArrow}>←</Text>
              <Text
                style={[
                  styles.directionText,
                  directionId === 1 && styles.directionTextActive,
                ]}
              >
                Tornada
              </Text>
              <Text
                style={[
                  styles.directionSubtext,
                  directionId === 1 && styles.directionSubtextActive,
                ]}
              >
                Cap a Badalona
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Start Button */}
        <TouchableOpacity style={styles.startButton} onPress={handleStartDriving}>
          <Text style={styles.startButtonText}>Començar Ruta</Text>
          <Text style={styles.startButtonSubtext}>
            M30 · {directionId === 0 ? 'Anada' : 'Tornada'}
          </Text>
        </TouchableOpacity>

        {/* Footer Status */}
        <View style={styles.footer}>
          <View style={styles.statusDot} />
          <Text style={styles.footerText}>BFF connectat · v0.3.0</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A1628',
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 20,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 40,
  },
  appTitle: {
    fontSize: 36,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 1,
  },
  subtitle: {
    fontSize: 14,
    color: '#6B7FA3',
    marginTop: 6,
    letterSpacing: 0.5,
  },
  routeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111F38',
    borderRadius: 16,
    padding: 20,
    marginBottom: 28,
    borderWidth: 1,
    borderColor: '#1C2E4A',
  },
  routeBadge: {
    backgroundColor: '#DC2626',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 16,
  },
  routeBadgeText: {
    fontSize: 22,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 1,
  },
  routeInfo: {
    flex: 1,
  },
  routeName: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  routeDesc: {
    fontSize: 13,
    color: '#6B7FA3',
    marginTop: 3,
  },
  directionSection: {
    marginBottom: 36,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4B6282',
    letterSpacing: 2,
    marginBottom: 12,
  },
  directionToggle: {
    flexDirection: 'row',
    gap: 12,
  },
  directionButton: {
    flex: 1,
    backgroundColor: '#111F38',
    borderRadius: 14,
    padding: 16,
    borderWidth: 2,
    borderColor: '#1C2E4A',
    alignItems: 'center',
  },
  directionButtonActive: {
    borderColor: '#DC2626',
    backgroundColor: '#1A0F0F',
  },
  directionArrow: {
    fontSize: 24,
    color: '#DC2626',
    marginBottom: 6,
  },
  directionText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#4B6282',
  },
  directionTextActive: {
    color: '#FFFFFF',
  },
  directionSubtext: {
    fontSize: 11,
    color: '#3A4F6E',
    marginTop: 3,
  },
  directionSubtextActive: {
    color: '#8B9FBF',
  },
  startButton: {
    backgroundColor: '#DC2626',
    borderRadius: 16,
    paddingVertical: 20,
    alignItems: 'center',
    marginBottom: 24,
    shadowColor: '#DC2626',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  startButtonText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  startButtonSubtext: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.7)',
    marginTop: 4,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#22C55E',
    marginRight: 8,
  },
  footerText: {
    fontSize: 12,
    color: '#4B6282',
  },
});
