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
  display: Platform.select({ ios: 'Noteworthy', android: 'sans-serif-medium', default: 'System' }),
  body: Platform.select({ ios: 'Avenir Next', android: 'sans-serif', default: 'System' }),
  mono: Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' }),
} as const;

const HEX_COLOR = /^[0-9A-F]{6}$/i;

export function safeHexColor(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim().replace(/^#/, '') ?? '';
  return HEX_COLOR.test(normalized) ? `#${normalized.toUpperCase()}` : fallback;
}
