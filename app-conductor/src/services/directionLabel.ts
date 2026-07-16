import type { AppLanguage } from './userPreferences';

export function formatDirectionLabel(
  label: string | null | undefined,
  language: AppLanguage = 'ca',
): string {
  const cleanLabel = (label || '').trim();

  if (!cleanLabel) {
    return '';
  }

  const destination = cleanLabel
    .replace(/^Towards\s+/i, '')
    .replace(/^Cap a\s+/i, '')
    .replace(/^Hacia\s+/i, '')
    .replace(/^Cara a\s+/i, '')
    .replace(/^Norabidean\s+/i, '');

  const prefix = {
    ca: 'Cap a',
    es: 'Hacia',
    gl: 'Cara a',
    eu: 'Norabidean',
  }[language];

  return `${prefix} ${destination}`;
}
