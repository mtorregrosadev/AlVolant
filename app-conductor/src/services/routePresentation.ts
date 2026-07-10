import type { RouteInfo } from './api';
import { formatDirectionLabel } from './directionLabel';

export type AgencyFilter = 'Tots' | 'TMB' | 'AMB' | 'FGC' | 'Rodalies' | 'Altres';

export const AGENCY_OPTIONS: readonly AgencyFilter[] = [
  'Tots',
  'TMB',
  'AMB',
  'FGC',
  'Rodalies',
  'Altres',
];

export function getAgencyFilter(route: RouteInfo): AgencyFilter {
  const agencyId = (route.agency_id || '').toUpperCase();
  const routeId = (route.route_id || '').toUpperCase();

  if (agencyId.includes('TMB') || routeId.startsWith('TMB')) return 'TMB';
  if (agencyId.includes('AMB') || routeId.startsWith('AMB')) return 'AMB';
  if (agencyId.includes('FGC') || routeId.startsWith('FGC')) return 'FGC';
  if (agencyId.includes('ROD') || routeId.startsWith('ROD')) return 'Rodalies';
  return 'Altres';
}

export function getRouteTitle(route: RouteInfo) {
  return route.route_long_name || route.display_name || route.route_short_name || 'Línia sense nom';
}

export function getDirectionNames(route: RouteInfo | null) {
  if (!route) return { anada: '', tornada: '' };

  const destinations = route.direction_destinations || [];
  const directionZero = destinations.find((direction) => direction.direction_id === 0);
  const directionOne = destinations.find((direction) => direction.direction_id === 1);
  const fallback = route.route_short_name ? `Cap a ${route.route_short_name}` : 'Direcció pendent';

  return {
    anada: formatDirectionLabel(directionZero?.label) || fallback,
    tornada: formatDirectionLabel(directionOne?.label) || fallback,
  };
}

export function normalizeRouteSearch(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleUpperCase('ca');
}

export function routeMatchesSearch(route: RouteInfo, query: string) {
  const normalizedQuery = normalizeRouteSearch(query);
  if (!normalizedQuery) return true;

  const searchable = normalizeRouteSearch([
    route.route_short_name,
    route.route_long_name,
    route.display_name,
  ].filter(Boolean).join(' '));
  return searchable.includes(normalizedQuery);
}

export function formatRecentTime(timestamp: number) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return 'Ara';
  if (elapsedMinutes < 60) return `Fa ${elapsedMinutes} min`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `Fa ${elapsedHours} h`;
  return `Fa ${Math.floor(elapsedHours / 24)} d`;
}
