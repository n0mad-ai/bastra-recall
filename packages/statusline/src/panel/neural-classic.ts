import { codePointWidth, visibleLength } from '../utils/terminal';
import { resetCountdown } from './reset-time';
import { contextRemaining } from './context-remaining';
import type { PanelGit } from './git-status';
import { gitLabel, sessionLabel, timingLabel } from './details';

export interface NeuralData {
  mode: 'demo' | 'snapshot' | 'live';
  client?: 'claude' | 'codex';
  git?: PanelGit | null;
  effort?: string | null;
  durationMs?: number | null;
  costUsd?: number | null;
  cacheHitRatio?: number | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  tokens?: number | null;
  clientLatency?: number | null;
  timingSource?: 'forwarder' | 'client';
  active?: boolean;
  recent?: boolean;
  agentActive?: boolean;
  errors?: number;
  fresh?: boolean;
  project: string;
  model: string;
  context: number | null;
  contextTotal?: number | null;
  contextFree?: number | null;
  usage: number | null;
  usageResetsAt?: number | null;
  usage5h?: number | null;
  usage5hResetsAt?: number | null;
  apiDurationMs?: number | null;
  /** Titles of the memories loaded in this turn, oldest first. */
  loadedTitles?: string[];
  now?: number;
  vault: number | null;
  searches: number | null;
  hits: number | null;
  loads: number | null;
  saves: number | null;
  latency: number | null;
  stage: string;
}

export const NEURAL_DEMO: NeuralData = {
  mode: 'demo', project: 'bastra-recall', model: 'OPUS 5.5', context: 24,
  usage: 70, vault: 1368, searches: 2, hits: 6, loads: 3, saves: 1,
  latency: 120, stage: 'Semantik abgleichen',
};

const C = { bg: '9;15;28', white: '230;240;248', soft: '140;163;186', frame: '50;69;94',
  cyan: '76;229;209', purple: '186;151;255', amber: '255;192;109', pink: '255;121;169' };
type Tone = keyof typeof C;
type Run = { text: string; tone: Tone; bold?: boolean };
const r = (text: string, tone: Tone = 'soft', bold = false): Run => ({ text: clean(text), tone, bold });
const clean = (v: string) => v.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');

function truncate(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  let result = '', used = 0;
  for (const ch of text) {
    const w = codePointWidth(ch.codePointAt(0)!);
    if (used + w > Math.max(0, width - 1)) break;
    used += w; result += ch;
  }
  return width > 0 ? result + '…' : '';
}
function fit(runs: Run[], width: number): Run[] {
  const out: Run[] = [];
  let left = width;
  for (const run of runs) {
    if (left <= 0) break;
    const text = truncate(run.text, left);
    out.push({ ...run, text }); left -= visibleLength(text);
  }
  if (left > 0) out.push(r(' '.repeat(left)));
  return out;
}
function ansi(runs: Run[], color: boolean): string {
  if (!color) return runs.map(r => r.text).join('');
  return `\x1b[48;2;${C.bg}m` + runs.map(run => `\x1b[${run.bold ? 1 : 22}m\x1b[38;2;${C[run.tone]}m${run.text}`).join('') + '\x1b[0m';
}
const DIGITS: Record<string, string[]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'], '1': [' ╻ ', ' ┃ ', ' ╹ '],
  '2': ['━━┓', '┏━┛', '┗━━'], '3': ['━━┓', ' ━┫', '━━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'], '5': ['┏━━', '┗━┓', '━━┛'],
  '6': ['┏━━', '┣━┓', '┗━┛'], '7': ['━━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'], '9': ['┏━┓', '┗━┫', '━━┛'],
  '—': ['   ', '━━━', '   '],
};
function digits(value: number | null): string[] {
  const chars = value === null ? ['—'] : String(Math.round(Math.min(100, Math.max(0, value)))).split('');
  return [0, 1, 2].map(line => chars.map(ch => DIGITS[ch]![line]).join(' '));
}
function meter(value: number | null, width: number, tone: Tone): Run[] {
  if (value === null) return [r('─'.repeat(width), 'frame')];
  const n = Math.round(Math.min(100, Math.max(0, value)) / 100 * width);
  return [r('━'.repeat(n), tone), r('─'.repeat(width - n), 'frame')];
}
const number = (n: number | null) => n === null ? '—' : String(Math.round(n));
const count = (n: number | null) => n === null ? '—' : number(n).padStart(2, '0');

/** A terminal instrument panel, deliberately separate from the Powerline design. */
export function renderNeural(data: NeuralData, width = 120, frame = 0, color = true): string[] {
  width = Math.max(1, Math.floor(width));
  if (width < 56) {
    return [
      [r('◉ BAS TRA / RECALL LAB', 'cyan', true)],
      [r(data.mode === 'demo' ? 'DESIGN-DEMO · Beispieldaten' : data.mode === 'live' ? `${(data.client ?? 'claude').toUpperCase()} / LIVE` : 'SNAPSHOT · bereitgestellte Daten', 'pink')],
      [r(`${data.model} · ${data.project}`, 'white')],
      [r(`Kontext ${number(data.context)}% · Nutzung ${number(data.usage)}%`, 'cyan')],
      [r(`${number(data.searches)} Suchen → ${number(data.hits)} Treffer`, 'purple')],
      [r(`${number(data.loads)} geladen · ${number(data.saves)} gespeichert`, 'white')],
    ].map(row => ansi(fit(row, width), color));
  }
  const inner = width - 4;
  const cell = Math.floor((inner - 6) / 3);
  const third = inner - cell * 2 - 6;
  const rows: Run[][] = [];
  const border = (a: string, b: string) => [r(a + '─'.repeat(width - 2) + b, 'frame')];
  const content = (runs: Run[]) => [r('│ ', 'frame'), ...fit(runs, inner), r(' │', 'frame')];
  const cols = (a: Run[], b: Run[], c: Run[]) => content([
    ...fit(a, cell), r(' │ ', 'frame'), ...fit(b, cell), r(' │ ', 'frame'), ...fit(c, third),
  ]);
  rows.push(border('╭', '╮'));
  const heading = '◉  B A S T R A  /  R E C A L L   L A B';
  const mode = data.mode === 'demo' ? 'DESIGN / DEMO' : data.mode === 'live' ? (data.fresh ? `${(data.client ?? 'claude').toUpperCase()} / LIVE` : 'LIVE / WARTE AUF DATEN') : 'DATA / SNAPSHOT';
  rows.push(content([r(heading, 'cyan', true), r(' '.repeat(Math.max(1, inner - visibleLength(heading) - mode.length))), r(mode, 'pink', true)]));
  rows.push(content([r(data.model + (data.effort ? ' · ' + data.effort : ''), 'white', true), r('  /  '), r(data.project, 'soft'), r('   ·   NEURAL CONSOLE', 'purple')]));
  rows.push(content([r('─'.repeat(inner), 'frame')]));
  rows.push(cols([r('01 / KONTEXT', 'cyan')], [r('02 / NUTZUNG · 7 TAGE', 'amber')], [r('03 / RECALL SIGNAL', 'purple')]));
  const ctx = digits(data.context), usage = digits(data.usage);
  const scanner = data.mode === 'demo' ? Math.floor(frame / 2) % 3 : -1;
  const stageNames = ['LEXIKALISCH', 'SEMANTISCH', 'RANKING'];
  for (let line = 0; line < 3; line++) {
    const label = stageNames[line]!;
    rows.push(cols(
      [r(ctx[line]! + (line === 2 ? ' % BELEGT' : ''), 'cyan', true), ...(line === 0 ? [r('  ' + contextRemaining(data.contextFree, data.contextTotal), 'soft')] : [])],
      [r(usage[line]! + (line === 2 ? ' % VERBRAUCHT' : ''), 'amber', true), ...(line === 0 ? [r('  ' + resetCountdown(data.usageResetsAt, data.now), 'soft')] : [])],
      [r(scanner === line && data.mode === 'demo' ? '◉ ' : '○ ', scanner === line ? 'purple' : 'frame'), r(label, scanner === line ? 'white' : 'soft'), r(scanner === line && data.mode === 'demo' ? '  ←' : '', 'purple')],
    ));
  }
  rows.push(cols(meter(data.context, cell - 1, 'cyan'), meter(data.usage, cell - 1, 'amber'), [r(`${number(data.vault)} ERINNERUNGEN`, 'white', true)]));
  rows.push(content([r('─'.repeat(inner), 'frame')]));
  rows.push(content([r(gitLabel(data), data.git?.conflicts ? 'pink' : 'cyan'), r('   /   ', 'frame'), r(sessionLabel(data), 'soft')]));
  const stats = `${count(data.searches)} SUCHEN  →  ${count(data.hits)} TREFFER  →  ${count(data.loads)} GELADEN`;
  rows.push(content([r('↳  ', 'purple'), r(stats, 'white', true), r(`    ${count(data.saves)} GESPEICHERT`, 'cyan'), r('    ' + timingLabel(data), 'soft')]));
  const demoWave = ['▁', '▂', '▃', '▄', '▅', '▆', '▅', '▄', '▃', '▂'];
  const wave = data.mode === 'demo' || (data.mode === 'live' && Boolean(data.agentActive || data.active || data.recent)) ? Array.from({ length: 20 }, (_, i) => demoWave[(i + frame) % demoWave.length]).join('') : '─'.repeat(20);
  rows.push(content([r(wave, 'purple'), r(data.mode === 'demo' ? '  DEMO-WELLE  /  ' : data.mode === 'live' ? '  LIVE  /  ' : '  SNAPSHOT  /  ', 'soft'), r(data.stage, data.errors ? 'pink' : 'cyan'), r(data.mode === 'demo' ? '   ·   keine Live-Messung' : '', 'soft')]));
  rows.push(border('╰', '╯'));
  return rows.map(row => ansi(fit(row, width), color));
}
