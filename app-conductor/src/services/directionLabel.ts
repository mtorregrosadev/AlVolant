export function formatDirectionLabel(label: string | null | undefined): string {
  const cleanLabel = (label || '').trim();

  if (!cleanLabel) {
    return '';
  }

  return cleanLabel.replace(/^Towards\s+/i, 'Cap a ');
}
