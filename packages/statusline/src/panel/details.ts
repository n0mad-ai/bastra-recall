import type { NeuralData } from './neural';
import { t, type PanelLang } from './i18n.js';

export function gitLabel(data: NeuralData, lang: PanelLang = 'de'): string {
  const g = data.git;
  if (!g?.known) return 'Git —';
  const counts = [g.staged ? `${g.staged} staged` : '', g.changed ? `${g.changed} ${t(lang, 'git.changed')}` : '', g.untracked ? `${g.untracked} ${t(lang, 'git.new')}` : '', g.conflicts ? `${g.conflicts} ${t(lang, 'git.conflicts')}` : ''].filter(Boolean);
  const arrows = [g.ahead !== null && g.ahead > 0 ? `↑${g.ahead}` : '', g.behind !== null && g.behind > 0 ? `↓${g.behind}` : ''].filter(Boolean).join(' ');
  return `⑂ ${g.branch ?? 'detached'}${g.sha ? ' @' + g.sha.slice(0, 7) : ''} · ${counts.join(' · ') || t(lang, 'git.clean')}${arrows ? ' · ' + arrows : ''}`;
}
export function sessionLabel(data: NeuralData, lang: PanelLang = 'de'): string {
  const items: string[] = [];
  if (typeof data.durationMs === 'number') {
    const mins = Math.floor(data.durationMs / 60000);
    items.push(`Session ${Math.floor(mins / 60)}h ${mins % 60}m`);
  }
  items.push(`API ${data.apiDurationMs == null ? '—' : Math.round(data.apiDurationMs / 1000) + ' s'}`);
  if (typeof data.costUsd === 'number') items.push(data.costUsd > 0 && data.costUsd < 0.01 ? `${t(lang, 'session.cost')} <$0.01` : `${t(lang, 'session.cost')} ≈$${data.costUsd.toFixed(2)}`);
  else if (data.client === 'codex' && data.mode === 'live') items.push(`${t(lang, 'session.cost')} —`);
  if (typeof data.cacheHitRatio === 'number') items.push(`Cache ${Math.round(data.cacheHitRatio * 100)}%`);
  if (typeof data.cachedInputRatio === 'number') items.push(`${t(lang, 'session.cachedInput')} ${Math.round(data.cachedInputRatio * 100)}%`);
  if (typeof data.linesAdded === 'number' && typeof data.linesRemoved === 'number') items.push(`${t(lang, 'session.lines')} +${data.linesAdded}/−${data.linesRemoved}`);
  if (typeof data.tokens === 'number') items.push(`Tokens ${(data.tokens / 1e6).toFixed(2)}M`);
  return items.join(' · ');
}
export function timingLabel(data: NeuralData, lang: PanelLang = 'de'): string {
  if (data.timingSource === 'forwarder') return `Recall ${Math.round(data.latency ?? 0)} ms${data.clientLatency == null ? '' : ` · ${t(lang, 'timing.client')} ${Math.round(data.clientLatency)} ms`}`;
  return `${t(lang, data.mode === 'demo' ? 'timing.tool' : 'timing.client')} ${data.latency == null ? '—' : Math.round(data.latency)} ms`;
}
