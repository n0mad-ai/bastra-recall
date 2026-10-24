export function contextRemaining(free: number | null | undefined, total: number | null | undefined, locale = 'de-DE'): string {
  const format = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.floor(value)) : '—';
  return `${format(free)} FREI / ${format(total)}`;
}
