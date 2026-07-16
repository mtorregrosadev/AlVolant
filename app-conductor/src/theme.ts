import type { RouteLineColor, VehicleColor } from './services/userPreferences';

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

export const routeLinePresetColors: Record<RouteLineColor, string> = {
  red: '#EF4444',
  yellow: '#FACC15',
  green: '#22C55E',
  blue: '#38BDF8',
  white: '#F8FAFC',
};

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

export function darkenHexColor(
  value: string | null | undefined,
  fallback: string,
  amount = 0.38,
) {
  const factor = 1 - Math.max(0, Math.min(0.85, amount));
  const channels = hexChannels(safeHexColor(value, fallback));
  return `#${channels
    .map((channel) => Math.round(channel * factor).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

function hexChannels(value: string) {
  return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
}

function relativeLuminance(value: string) {
  return hexChannels(value)
    .map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function mixHexColors(from: string, to: string, amount: number) {
  const ratio = Math.max(0, Math.min(1, amount));
  const fromChannels = hexChannels(from);
  const toChannels = hexChannels(to);
  return `#${fromChannels.map((channel, index) => (
    Math.round(channel + (toChannels[index] - channel) * ratio)
      .toString(16)
      .padStart(2, '0')
  )).join('').toUpperCase()}`;
}

function readableOnDarkMap(color: string, minimumContrast: number) {
  if (contrastRatio(color, colors.mapBackground) >= minimumContrast) return color;

  for (let ratio = 0.05; ratio <= 1; ratio += 0.05) {
    const candidate = mixHexColors(color, colors.white, ratio);
    if (contrastRatio(candidate, colors.mapBackground) >= minimumContrast) {
      return candidate;
    }
  }

  return colors.white;
}

/**
 * Makes every agency colour legible on the dark map. In particular, a black
 * route keeps a neutral, high-contrast active line rather than disappearing
 * into the basemap; the travelled segment remains deliberately subdued.
 */
export function mapRouteLineColors(value: string | null | undefined) {
  const routeColor = safeHexColor(value, colors.primary);
  const sourceContrast = contrastRatio(routeColor, colors.mapBackground);

  // A black (or nearly black) operator colour is indistinguishable from the
  // dark basemap even after a modest lightening. Give it a consistent pale
  // core and blue halo instead: it reads as a route, not as another street.
  if (sourceContrast < 2.35) {
    return {
      active: '#EAF4FF',
      activeGlow: '#60A5FA',
      completed: '#64748B',
      completedGlow: '#3B82A0',
    };
  }

  const active = readableOnDarkMap(routeColor, 3.2);
  const completed = readableOnDarkMap(darkenHexColor(active, active, 0.48), 1.9);

  return {
    active,
    activeGlow: active,
    completed,
    completedGlow: completed,
  };
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
