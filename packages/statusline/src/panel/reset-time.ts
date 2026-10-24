import { t, type PanelLang } from './i18n.js';

/** Claude supplies Unix seconds. This counts to the reset, not time-to-exhaustion. */
export function resetCountdown(reset: number | null | undefined, now = Date.now(), lang: PanelLang = 'de'): string {
  if (typeof reset !== 'number' || !Number.isFinite(reset) || reset <= 0) return 'RESET —';
  const remaining = reset * 1000 - now;
  if (remaining <= 0) return t(lang, 'reset.due');
  const minutes = Math.ceil(remaining / 60000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  return days > 0 ? `RESET IN ${days}d ${hours}h` : hours > 0 ? `RESET IN ${hours}h ${mins}m` : `RESET IN ${mins}m`;
}
