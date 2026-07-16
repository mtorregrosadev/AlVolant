import React from 'react';
import { Image, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { HomeAgency } from '../services/userPreferences';

type AgencyLogoProps = {
  agency: HomeAgency;
  color: string;
  size?: 'large' | 'regular' | 'compact';
};

const AGENCY_LOGOS: Partial<Record<HomeAgency, number>> = {
  TMB: require('../../assets/logo-tmb.png'),
  AMB: require('../../assets/logo-amb.png'),
  FGC: require('../../assets/logo_fgc.png'),
  Rodalies: require('../../assets/logo_rodalies.png'),
};

export default function AgencyLogo({ agency, color, size = 'regular' }: AgencyLogoProps) {
  const logo = AGENCY_LOGOS[agency];
  if (logo) {
    return (
      <Image
        source={logo}
        style={size === 'large' ? styles.largeLogo : size === 'compact' ? styles.compactLogo : styles.logo}
        resizeMode="contain"
        accessible={false}
      />
    );
  }

  return (
    <MaterialCommunityIcons
      name="bus-multiple"
      size={size === 'large' ? 32 : size === 'compact' ? 18 : 23}
      color={color}
    />
  );
}

const styles = StyleSheet.create({
  largeLogo: { width: 44, height: 36 },
  logo: { width: 32, height: 22 },
  compactLogo: { width: 23, height: 16 },
});
