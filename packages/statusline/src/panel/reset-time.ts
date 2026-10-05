/** Claude supplies Unix seconds. This counts to the reset, not time-to-exhaustion. */
export function resetCountdown(reset: number | null | undefined, now = Date.now()): string {
  if (typeof reset !== 'number' || !Number.isFinite(reset) || reset <= 0) return 'RESET —';
  const remaining = reset * 1000 - now;
  if (remaining <= 0) return 'RESET FÄLLIG';
  const minutes = Math.ceil(remaining / 60000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  return days > 0 ? `RESET IN ${days}d ${hours}h` : hours > 0 ? `RESET IN ${hours}h ${mins}m` : `RESET IN ${mins}m`;
}
