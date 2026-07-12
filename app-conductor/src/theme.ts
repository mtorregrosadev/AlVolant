import type { VehicleColor } from './services/userPreferences';

export const colors = {
  background: '#F1EFE8',
  canvas: '#F6F4EE',
  surface: '#FBFAF6',
  surfaceMuted: '#E7E6DE',
  ink: '#202520',
  inkSoft: '#434B45',
  muted: '#70756D',
  subtle: '#8A9087',
  border: '#D7D4C9',
  borderStrong: '#BDC2B8',
  primary: '#176B5A',
  primaryPressed: '#0F5144',
  primarySoft: '#E0EAE4',
  primaryWash: '#F2F6F3',
  transit: '#176B5A',
  transitDark: '#202520',
  transitSoft: '#E0EAE4',
  transitWash: '#EAE8E1',
  sun: '#FBFAF6',
  success: '#178A5B',
  warning: '#B86B10',
  danger: '#C74646',
  mapBackground: '#0A1628',
  white: '#FFFFFF',
} as const;

export const vehicleColors = {
  red: '#DC2626',
  yellow: '#F6A800',
  green: '#176B5A',
  route: '#1551B5',
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
  hero: 'Newsreader_500Medium',
  display: 'Inter_700Bold',
  body: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  label: 'Inter_600SemiBold',
  strong: 'Inter_700Bold',
} as const;

export const typography = {
  eyebrow: {
    fontFamily: fonts.label,
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '400',
    letterSpacing: 1.1,
  },
  screenTitle: {
    fontFamily: fonts.display,
    fontSize: 24,
    lineHeight: 29,
    fontWeight: '400',
    letterSpacing: -0.25,
  },
  sectionTitle: {
    fontFamily: fonts.display,
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '400',
    letterSpacing: -0.2,
  },
  cardTitle: {
    fontFamily: fonts.label,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '400',
  },
  body: {
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '400',
  },
  control: {
    fontFamily: fonts.label,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '400',
  },
  meta: {
    fontFamily: fonts.body,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '400',
  },
  badge: {
    fontFamily: fonts.strong,
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '400',
  },
  button: {
    fontFamily: fonts.strong,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '400',
  },
} as const;

const HEX_COLOR = /^[0-9A-F]{6}$/i;

export function safeHexColor(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim().replace(/^#/, '') ?? '';
  return HEX_COLOR.test(normalized) ? `#${normalized.toUpperCase()}` : fallback;
}

function hexChannels(value: string) {
  return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
}

export function routePastelColor(
  value: string | null | undefined,
  strength = 0.075,
) {
  const routeChannels = hexChannels(safeHexColor(value, colors.primary));
  const surfaceChannels = hexChannels(colors.surface);
  const mix = Math.max(0, Math.min(0.2, strength));

  const channels = routeChannels.map((channel, index) =>
    Math.round(surfaceChannels[index] + (channel - surfaceChannels[index]) * mix));

  return `#${channels
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

export function vehicleAccentColor(
  vehicleColor: VehicleColor,
  routeColor?: string | null,
) {
  return vehicleColor === 'route'
    ? safeHexColor(routeColor, vehicleColors.route)
    : vehicleColors[vehicleColor];
}
