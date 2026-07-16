import type { RouteInfo } from './api';
import { formatDirectionLabel } from './directionLabel';
import { translate } from '../i18n';
import type { AppLanguage, HomeAgency } from './userPreferences';

export type AgencyFilter = 'Tots' | HomeAgency;

export const AGENCY_OPTIONS: readonly AgencyFilter[] = [
  'Tots',
  'TMB',
  'AMB',
  'FGC',
  'Rodalies',
  'Altres',
];

function hasAgencyPrefix(value: string, prefix: string) {
  return value === prefix || value.startsWith(`${prefix}_`);
}

export function getAgencyFilter(route: RouteInfo): HomeAgency {
  const agencyId = (route.agency_id || '').toUpperCase();
  const routeId = (route.route_id || '').toUpperCase();

  if (hasAgencyPrefix(agencyId, 'TMB') || hasAgencyPrefix(routeId, 'TMB')) return 'TMB';
  if (hasAgencyPrefix(agencyId, 'AMB') || hasAgencyPrefix(routeId, 'AMB')) return 'AMB';
  if (hasAgencyPrefix(agencyId, 'FGC') || hasAgencyPrefix(routeId, 'FGC')) return 'FGC';
  if (hasAgencyPrefix(agencyId, 'ROD') || hasAgencyPrefix(routeId, 'ROD')) return 'Rodalies';
  return 'Altres';
}

export function getAgencyLabel(agency: AgencyFilter, language: AppLanguage = 'ca') {
  if (agency === 'Tots') return translate(language, 'common.all');
  if (agency === 'Altres') return translate(language, 'common.other');
  return agency;
}

export function getRouteTitle(route: RouteInfo, language: AppLanguage = 'ca') {
  return route.route_long_name
    || route.display_name
    || route.route_short_name
    || translate(language, 'common.lineWithoutName');
}

export function getDirectionNames(route: RouteInfo | null, language: AppLanguage = 'ca') {
  if (!route) return { anada: '', tornada: '' };

  const destinations = route.direction_destinations || [];
  const directionZero = destinations.find((direction) => direction.direction_id === 0);
  const directionOne = destinations.find((direction) => direction.direction_id === 1);
  const fallback = route.route_short_name
    ? translate(language, 'common.towards', { destination: route.route_short_name })
    : translate(language, 'common.directionPending');

  return {
    anada: formatDirectionLabel(directionZero?.label, language) || fallback,
    tornada: formatDirectionLabel(directionOne?.label, language) || fallback,
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

export function formatRecentTime(timestamp: number, language: AppLanguage = 'ca') {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return translate(language, 'common.now');
  if (elapsedMinutes < 60) {
    return translate(language, 'common.agoMinutes', { count: elapsedMinutes });
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return translate(language, 'common.agoHours', { count: elapsedHours });
  return translate(language, 'common.agoDays', { count: Math.floor(elapsedHours / 24) });
}
