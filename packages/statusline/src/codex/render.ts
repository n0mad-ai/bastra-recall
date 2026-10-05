import path from 'node:path';
import { codePointWidth, visibleLength } from '../utils/terminal';
import type { CodexStatus, RecallFeed } from './state';

const RESET = '\x1b[0m';
const palette = { project: '#9a4d13', git: '#5b6478', model: '#304563', usage: '#a65000', context: '#526382', recall: '#7c3aed', good: '#0f766e', error: '#b42336', muted: '#48516a' };
type Segment = { text: string; color: string; priority: number };

/** No user-controlled terminal escapes, newlines or directional overrides. */
export function safeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').trim();
}
function cut(value: string, columns: number): string {
  if (columns <= 0) return '';
  if (visibleLength(value) <= columns) return value;
  let out = '', used = 0;
  for (const ch of value) {
    const width = codePointWidth(ch.codePointAt(0)!);
    if (used + width > columns - 1) break;
    used += width; out += ch;
  }
  return out + '…';
}
function rgb(hex: string): string { return `${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`; }

function powerline(segments: Segment[], width: number, color: boolean, ascii: boolean): string {
  const items = segments.map(s => ({ ...s, text: safeText(s.text) }));
  const length = () => items.reduce((sum, s) => sum + visibleLength(s.text) + 3, 0);
  while (length() > width && items.length > 1) {
    const lowest = Math.min(...items.map(s => s.priority));
    items.splice(items.findIndex(s => s.priority === lowest), 1);
  }
  if (items.length === 1) items[0]!.text = cut(items[0]!.text, Math.max(0, width - 3));
  if (width < 4) return cut(items[0]?.text ?? '', width);
  let out = '';
  for (let i = 0; i < items.length; i++) {
    const s = items[i]!, next = items[i + 1];
    if (color) out += `\x1b[48;2;${rgb(s.color)}m\x1b[38;2;245;245;250m\x1b[1m ${s.text} `;
    else out += ` ${s.text} `;
    if (color) out += `${RESET}\x1b[38;2;${rgb(s.color)}m${next ? `\x1b[48;2;${rgb(next.color)}m` : ''}`;
    out += ascii ? '>' : '\ue0b0';
    if (color) out += RESET;
  }
  return out;
}
function compact(value: number): string {
  return value < 1000 ? Math.round(value).toString() : value < 1e6 ? `${(value / 1000).toFixed(1)}k` : `${(value / 1e6).toFixed(2)}M`;
}
function progress(percent: number, ascii: boolean): string {
  const bounded = Math.min(100, Math.max(0, percent));
  const n = bounded === 0 ? 0 : Math.max(1, Math.round(bounded / 100 * 8));
  // Block Drawing characters have reliable monospace coverage. Geometric
  // parallelograms (▰/▱) fall back to oversized/slanted glyphs in Ghostty.
  // Box Drawing strokes sit on the cell's vertical centre, unlike lower
  // half blocks. Heavy/light strokes keep fill and track distinguishable.
  return (ascii ? '#' : '━').repeat(n) + (ascii ? '-' : '─').repeat(8 - n);
}
function remainingReset(reset: number | null, now: number): string {
  if (reset === null) return '';
  const minutes = Math.max(0, Math.ceil((reset * 1000 - now) / 60000));
  return minutes >= 1440 ? ` · ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h` : minutes >= 60 ? ` · ${Math.floor(minutes / 60)}h ${minutes % 60}m` : ` · ${minutes}m`;
}

export function renderCodex(s: CodexStatus, options: {
  width?: number; color?: boolean; ascii?: boolean; now?: number;
  feed?: RecallFeed | null; sourceError?: boolean;
} = {}): string[] {
  const width = Math.max(1, options.width ?? 120), color = options.color ?? true;
  const ascii = options.ascii ?? false, now = options.now ?? Date.now();
  const icon = (unicode: string, plain: string) => ascii ? plain : unicode;
  const upper: Segment[] = [
    { text: path.basename(s.cwd) || 'Codex', color: palette.project, priority: 2 },
    ...(s.branch ? [{ text: `${icon('⑂', 'git')} ${s.branch}`, color: palette.git, priority: 1 }] : []),
    { text: `${icon('✦', '*')} ${(s.model ?? 'Codex').replace(/^gpt-/, '')}${s.effort ? ` · ${s.effort}` : ''}`, color: palette.model, priority: 3 },
  ];
  for (const limit of s.limits) {
    const label = limit.minutes === 10080 ? '7d' : limit.minutes === 300 ? '5h' : `${limit.minutes}m`;
    upper.push({ text: `${label} ${progress(limit.used, ascii)}  ${Math.round(limit.used)}% genutzt${remainingReset(limit.resetsAt, now)}`, color: limit.used >= 90 ? palette.error : palette.usage, priority: 4 });
  }
  const percent = s.contextUsed !== null && s.contextWindow !== null && s.contextWindow > 0 ? Math.min(100, s.contextUsed / s.contextWindow * 100) : null;
  upper.push({ text: percent === null ? 'Kontext —' : `Kontext ${progress(percent, ascii)}  ${Math.round(percent)}%`, color: percent !== null && percent >= 85 ? palette.error : palette.context, priority: 6 });
  upper.push({ text: `${icon('❖', '*')} bastra · ${s.vaultSize === null ? '—' : s.vaultSize} Erinnerungen`, color: palette.recall, priority: 5 });

  // A feed is a hint about the in-flight search only. Completion/counters
  // come from authoritative transcript items, avoiding double counting.
  const feed = options.feed;
  const fresh = feed && now - feed.ts >= 0 && now - feed.ts < 15000;
  const running = fresh && s.active && feed.current_stage && feed.current_recall_started_at;
  const spinner = ascii ? ['|', '/', '-', '\\'][Math.floor(now / 180) % 4] : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][Math.floor(now / 100) % 10];
  const status = options.sourceError ? 'Quelle nicht erreichbar' : running ? `${spinner} ${feed.current_message ?? feed.current_stage}` : s.calls ? `${s.errors ? icon('!', '!') : icon('✓', 'ok')} ${s.errors ? 'Fehler' : 'Recall erledigt'}` : 'Recall bereit';
  const lower: Segment[] = [{ text: `${icon('❖', '*')} ${status}`, color: options.sourceError || s.errors ? palette.error : running ? palette.recall : s.calls ? palette.good : palette.recall, priority: 9 }];
  if (s.calls) {
    lower.push({ text: `${s.searches} Suchen · ${s.hits} Treffer`, color: palette.recall, priority: 7 });
    lower.push({ text: `${s.loads} geladen · ${s.saves} gespeichert${s.errors ? ` · ${s.errors} Fehler` : ''}`, color: palette.muted, priority: 8 });
    lower.push({ text: `${Math.round(s.ms)} ms · ${s.calls} Aufrufe`, color: palette.git, priority: 2 });
  }
  if (s.tokens !== null) lower.push({ text: `${compact(s.tokens)} Tokens`, color: palette.context, priority: 1 });
  if (!running && fresh && feed.last_phrase && feed.last_phrase_at && now - feed.last_phrase_at >= 0 && now - feed.last_phrase_at < 10000) lower.push({ text: feed.last_phrase, color: palette.muted, priority: 0 });
  return [powerline(upper, width, color, ascii), powerline(lower, width, color, ascii)];
}
