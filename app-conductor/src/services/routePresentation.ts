import type { RouteInfo } from './api';
import { formatDirectionLabel } from './directionLabel';
import { translate } from '../i18n';
import type { AppLanguage, HomeAgency } from './userPreferences';

export type AgencyFilter = 'Tots' | HomeAgency;

export const AGENCY_OPTIONS: readonly AgencyFilter[] = [
  'Tots',
  'TMB',
  'AMB',
  'Sagalés',
  'TEISA',
  'HIFE',
  'Empresa Plana',
  'Moventis',
  'Altres',
];

/**
 * Brand mapping for agencies that the ATM feed exposes under several contract
 * identifiers. Values are deliberately exclusive: one source route belongs to
 * one visible brand, so filters and home preferences never show a line twice.
 *
 * The IDs come from the GTFS `agency.txt` file. Unknown/new agencies fall back
 * to `Altres`, which keeps the catalogue correct when ATM refreshes the feed.
 */
const GTFS_BRAND_BY_ID: Readonly<Record<string, HomeAgency>> = {
  // Sagalés, including its area-specific feed identifiers and the joint Casas service.
  BGE_4: 'Sagalés',
  BGS_8: 'Sagalés',
  CIN_5: 'Sagalés',
  COS_9: 'Sagalés',
  FYT_12: 'Sagalés',
  GEN_42557: 'Sagalés',
  GEN_42605: 'Sagalés',
  OSO_10: 'Sagalés',
  SAG_13: 'Sagalés',

  // TEISA. The TEISA/SARFA joint service is assigned to Moventis below.
  GEN_42641: 'TEISA',
  TEI_98: 'TEISA',

  // HIFE, including the Alsina Graells / LHIFE joint service.
  AMP_1: 'HIFE',
  CAL_1: 'HIFE',
  CUB_1: 'HIFE',
  GEN_42570: 'HIFE',
  GEN_42725: 'HIFE',
  TRD_1: 'HIFE',
  TTS_1: 'HIFE',

  // Empresa Plana, including its shared Cintoi service.
  CUN_1: 'Empresa Plana',
  GEN_42634: 'Empresa Plana',
  GEN_42676: 'Empresa Plana',

  // Moventis brands. Shared services with SARFA are kept under Moventis.
  GEN_42628: 'Moventis',
  // Empresa Casas operates the C10 shown in Moventis' official timetable.
  GEN_42671: 'Moventis',
  GEN_42735: 'Moventis',
  GEN_42742: 'Moventis',
  LLE_5: 'Moventis',
  PUJ_11: 'Moventis',
  SAA_2: 'Moventis',
  SAB_1: 'Moventis',
  TCC_4: 'Moventis',
};

function hasAgencyPrefix(value: string, prefix: string) {
  return value === prefix || value.startsWith(`${prefix}_`);
}

export function getAgencyFilter(route: RouteInfo): HomeAgency {
  const agencyId = (route.agency_id || '').toUpperCase();
  const routeId = (route.route_id || '').toUpperCase();

  if (hasAgencyPrefix(agencyId, 'TMB') || hasAgencyPrefix(routeId, 'TMB')) return 'TMB';
  if (hasAgencyPrefix(agencyId, 'AMB') || hasAgencyPrefix(routeId, 'AMB')) return 'AMB';
  const brand = GTFS_BRAND_BY_ID[agencyId] || GTFS_BRAND_BY_ID[routeId];
  if (brand) return brand;
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
