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
  'Sagalés': require('../../assets/logo-sagales.png'),
  TEISA: require('../../assets/logo-teisa.png'),
  HIFE: require('../../assets/logo-hife.png'),
  'Empresa Plana': require('../../assets/logo-empresa-plana.png'),
  Moventis: require('../../assets/logo-moventis.png'),
};

const WIDE_LOGO_AGENCIES: readonly HomeAgency[] = ['Empresa Plana', 'Moventis'];

export default function AgencyLogo({ agency, color, size = 'regular' }: AgencyLogoProps) {
  const logo = AGENCY_LOGOS[agency];
  if (logo) {
    const isWide = WIDE_LOGO_AGENCIES.includes(agency);
    return (
      <Image
        source={logo}
        style={size === 'large'
          ? (isWide ? styles.largeWideLogo : styles.largeLogo)
          : size === 'compact'
            ? (isWide ? styles.compactWideLogo : styles.compactLogo)
            : (isWide ? styles.wideLogo : styles.logo)}
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
  largeWideLogo: { width: 76, height: 22 },
  logo: { width: 32, height: 22 },
  wideLogo: { width: 54, height: 16 },
  compactLogo: { width: 23, height: 16 },
  compactWideLogo: { width: 36, height: 13 },
});
