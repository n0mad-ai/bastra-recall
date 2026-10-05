import type { NeuralData } from './neural';

export function gitLabel(data: NeuralData): string {
  const g = data.git;
  if (!g?.known) return 'Git —';
  const counts = [g.staged ? `${g.staged} staged` : '', g.changed ? `${g.changed} geändert` : '', g.untracked ? `${g.untracked} neu` : '', g.conflicts ? `${g.conflicts} Konflikte` : ''].filter(Boolean);
  return `⑂ ${g.branch ?? 'detached'}${g.sha ? ' @' + g.sha.slice(0, 7) : ''} · ${counts.join(' · ') || 'sauber'}${g.ahead === null ? '' : ` · ↑${g.ahead} ↓${g.behind}`}`;
}
export function sessionLabel(data: NeuralData): string {
  const items: string[] = [];
  if (typeof data.durationMs === 'number') {
    const mins = Math.floor(data.durationMs / 60000);
    items.push(`Session ${Math.floor(mins / 60)}h ${mins % 60}m`);
  }
  if (typeof data.costUsd === 'number') items.push(data.costUsd > 0 && data.costUsd < 0.01 ? 'Kosten <$0.01' : `Kosten ≈$${data.costUsd.toFixed(2)}`);
  if (typeof data.cacheHitRatio === 'number') items.push(`Cache ${Math.round(data.cacheHitRatio * 100)}%`);
  if (typeof data.linesAdded === 'number' && typeof data.linesRemoved === 'number') items.push(`Zeilen +${data.linesAdded}/−${data.linesRemoved}`);
  if (typeof data.tokens === 'number') items.push(`Tokens ${(data.tokens / 1e6).toFixed(2)}M`);
  return items.join(' · ');
}
export function timingLabel(data: NeuralData): string {
  if (data.timingSource === 'forwarder') return `Recall ${Math.round(data.latency ?? 0)} ms${data.clientLatency == null ? '' : ` · Client ${Math.round(data.clientLatency)} ms`}`;
  return `${data.mode === 'demo' ? 'Toolzeit' : 'Client'} ${data.latency == null ? '—' : Math.round(data.latency)} ms`;
}
