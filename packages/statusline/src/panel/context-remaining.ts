export function contextRemaining(free: number | null | undefined, total: number | null | undefined): string {
  const format = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.floor(value)) : '—';
  return `${format(free)} FREI / ${format(total)}`;
}
