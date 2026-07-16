import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { AppLanguage } from '../services/userPreferences';

type LanguageFlagProps = {
  language: AppLanguage;
  size?: 'large' | 'compact';
};

export default function LanguageFlag({ language, size = 'large' }: LanguageFlagProps) {
  const dimensions = size === 'compact' ? styles.compact : styles.large;

  if (language === 'ca') {
    return (
      <View style={[styles.flag, dimensions, styles.catalonia]} accessible={false}>
        {[12, 34, 56, 78].map((top) => <View key={top} style={[styles.senyeraStripe, { top: `${top}%` }]} />)}
      </View>
    );
  }

  if (language === 'es') {
    return (
      <View style={[styles.flag, dimensions, styles.spain]} accessible={false}>
        <View style={styles.spainTop} />
        <View style={styles.spainBottom} />
      </View>
    );
  }

  if (language === 'gl') {
    return (
      <View style={[styles.flag, dimensions, styles.galicia]} accessible={false}>
        <View style={styles.galiciaStripe} />
      </View>
    );
  }

  return (
    <View style={[styles.flag, dimensions, styles.basque]} accessible={false}>
      <View style={[styles.basqueDiagonal, styles.basqueDiagonalForward]} />
      <View style={[styles.basqueDiagonal, styles.basqueDiagonalBackward]} />
      <View style={styles.basqueHorizontal} />
      <View style={styles.basqueVertical} />
    </View>
  );
}

const styles = StyleSheet.create({
  flag: {
    overflow: 'hidden',
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(15, 33, 28, 0.16)',
  },
  large: { width: 48, height: 32 },
  compact: { width: 24, height: 16, borderRadius: 3 },
  catalonia: { backgroundColor: '#F6C844' },
  senyeraStripe: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: '11%',
    backgroundColor: '#D62D2D',
  },
  spain: { backgroundColor: '#F7C948' },
  spainTop: { position: 'absolute', top: 0, left: 0, right: 0, height: '25%', backgroundColor: '#AA151B' },
  spainBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '25%', backgroundColor: '#AA151B' },
  galicia: { backgroundColor: '#F8FAFC' },
  galiciaStripe: {
    position: 'absolute',
    width: '150%',
    height: '21%',
    left: '-25%',
    top: '39%',
    backgroundColor: '#62A7DE',
    transform: [{ rotate: '-32deg' }],
  },
  basque: { backgroundColor: '#D21F3C' },
  basqueDiagonal: {
    position: 'absolute',
    width: '155%',
    height: '14%',
    left: '-28%',
    top: '43%',
    backgroundColor: '#168048',
  },
  basqueDiagonalForward: { transform: [{ rotate: '34deg' }] },
  basqueDiagonalBackward: { transform: [{ rotate: '-34deg' }] },
  basqueHorizontal: { position: 'absolute', left: 0, right: 0, top: '42%', height: '16%', backgroundColor: '#FFFFFF' },
  basqueVertical: { position: 'absolute', top: 0, bottom: 0, left: '42%', width: '16%', backgroundColor: '#FFFFFF' },
});
