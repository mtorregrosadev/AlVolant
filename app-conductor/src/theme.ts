import { Platform } from 'react-native';

export const colors = {
  background: '#F6F3EC',
  canvas: '#FBF9F4',
  surface: '#FFFFFF',
  surfaceMuted: '#F0EDE6',
  ink: '#202431',
  inkSoft: '#4E5668',
  muted: '#747D90',
  subtle: '#9AA2B2',
  border: '#E1E4EA',
  borderStrong: '#CDD2DC',
  primary: '#D93545',
  primaryPressed: '#B92737',
  primarySoft: '#FCE8E8',
  primaryWash: '#FFF5F5',
  transit: '#D93545',
  transitDark: '#202431',
  transitSoft: '#FCE8E8',
  transitWash: '#F0EDE6',
  sun: '#FFFFFF',
  success: '#20B768',
  warning: '#D97706',
  danger: '#DC3545',
  mapBackground: '#0A1628',
  white: '#FFFFFF',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

export const cardShadow = {
  shadowColor: '#202431',
  shadowOffset: { width: 0, height: 7 },
  shadowOpacity: 0.09,
  shadowRadius: 16,
  elevation: 3,
} as const;

export const fonts = {
  hero: Platform.select({ ios: 'Noteworthy', android: 'sans-serif-medium', default: 'System' }),
  display: Platform.select({ ios: 'System', android: 'sans-serif', default: 'System' }),
  body: Platform.select({ ios: 'System', android: 'sans-serif', default: 'System' }),
  label: Platform.select({ ios: 'System', android: 'sans-serif-medium', default: 'System' }),
} as const;

export const typography = {
  eyebrow: {
    fontFamily: fonts.label,
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '700',
    letterSpacing: 1.1,
  },
  screenTitle: {
    fontFamily: fonts.display,
    fontSize: 24,
    lineHeight: 29,
    fontWeight: '700',
    letterSpacing: -0.25,
  },
  sectionTitle: {
    fontFamily: fonts.display,
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  cardTitle: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600',
  },
  body: {
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '400',
  },
  control: {
    fontFamily: fonts.body,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
  },
  meta: {
    fontFamily: fonts.body,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '400',
  },
  badge: {
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '700',
  },
  button: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700',
  },
} as const;

const HEX_COLOR = /^[0-9A-F]{6}$/i;

export function safeHexColor(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim().replace(/^#/, '') ?? '';
  return HEX_COLOR.test(normalized) ? `#${normalized.toUpperCase()}` : fallback;
}
