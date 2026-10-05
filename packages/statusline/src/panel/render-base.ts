import { codePointWidth, visibleLength } from '../utils/terminal';
import type { NeuralData } from './types';
import type { PanelView } from './view';
import { LIGHT_CANVAS } from './view';
import { resetCountdown } from './reset-time';
import { gitLabel, timingLabel, sessionLabel } from './details';

export type Tone = 'bg' | 'white' | 'soft' | 'frame' | 'cyan' | 'purple' | 'amber' | 'pink';
export type Palette = Record<Tone, string>;
export type Run = { text: string; tone: Tone; bold?: boolean };
const LIGHT: Palette = { bg: LIGHT_CANVAS.join(';'), white: '38;29;48', soft: '99;92;115', frame: '185;177;195',
  cyan: '0;105;97', purple: '98;57;158', amber: '150;83;10', pink: '162;43;100' };
const FONT: Record<string, string[]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'], '1': [' ╻ ', ' ┃ ', ' ╹ '], '2': ['━━┓', '┏━┛', '┗━━'],
  '3': ['━━┓', ' ━┫', '━━┛'], '4': ['╻ ╻', '┗━┫', '  ╹'], '5': ['┏━━', '┗━┓', '━━┛'],
  '6': ['┏━━', '┣━┓', '┗━┛'], '7': ['━━┓', '  ┃', '  ╹'], '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '━━┛'], '—': ['   ', '━━━', '   '],
};
export function createRenderBase(palette: Palette, view: PanelView = {}) {
  const colors = view.light ? LIGHT : { ...palette, ...(view.paper?.length === 3 ? { bg: view.paper.join(';') } : {}) };
  const r = (text: string, tone: Tone = 'soft', bold = false): Run => ({ text: text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ''), tone, bold });
  const number = (n: number | null | undefined) => typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n)) : '—';
  const count = (n: number | null | undefined) => typeof n === 'number' && Number.isFinite(n) ? number(n).padStart(2, '0') : '—';
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
    const out: Run[] = []; let left = width;
    for (const run of runs) {
      if (left <= 0) break;
      const text = truncate(run.text, left); out.push({ ...run, text }); left -= visibleLength(text);
    }
    if (left > 0) out.push(r(' '.repeat(left)));
    return out;
  }
  const ansi = (runs: Run[], color: boolean): string => !color ? runs.map(r => r.text).join('') :
    `\x1b[48;2;${colors.bg}m` + runs.map(run => `\x1b[${run.bold ? 1 : 22}m\x1b[38;2;${colors[run.tone]}m${run.text}`).join('') + '\x1b[0m';
  const digits = (value: number | null): string[] => {
    const chars = value === null ? ['—'] : String(Math.round(Math.min(100, Math.max(0, value)))).split('');
    return [0, 1, 2].map(line => chars.map(ch => FONT[ch]![line]).join(' '));
  };
  const meter = (value: number | null | undefined, width: number, tone: Tone): Run[] => {
    const size = Math.max(0, width), n = typeof value === 'number' ? Math.round(Math.min(100, Math.max(0, value)) / 100 * size) : 0;
    return [r('━'.repeat(n), tone), r('─'.repeat(size - n), 'frame')];
  };
  return { r, fit, ansi, digits, meter, number, count };
}
export function headerSwitches(view: PanelView, r: ReturnType<typeof createRenderBase>['r']): Run[] {
  return view.compact === undefined ? [] : [r(`  ${view.light ? '◑' : '◐'}   ${view.compact ? '▴' : '▾'}`)];
}
export function loadedRows(data: NeuralData, r: ReturnType<typeof createRenderBase>['r']): Run[][] {
  const titles = data.loadedTitles;
  return [[r('Zuletzt geladen', 'purple', true)], ...(!titles ? [[r('—')]] : !titles.length ?
    [[r('Noch nichts seit deiner letzten Nachricht')]] : titles.slice(-6).reverse().map(title => [r('◆ ', 'purple'), r(title, 'white')]))];
}
/** Six rows in each legacy design's own colours, with shared controls and real values. */
export function compactRows(data: NeuralData, width: number, frame: number, color: boolean, view: PanelView, palette: Palette, title: string): string[] {
  const { r, fit, ansi, number, count } = createRenderBase(palette, view);
  const controls = view.compact === undefined || width < 90 ? [] : headerSwitches({ ...view, compact: true }, r);
  const mode = data.mode === 'demo' ? 'Demo' : data.mode === 'snapshot' ? 'Snapshot' : data.fresh ? `${data.client ?? 'claude'} live` : 'wartet auf Daten';
  const header = [...fit([r(title, 'cyan', true), r(` · ${data.model} / ${data.project}`, 'white')], Math.max(0, width - mode.length - (controls.length ? 9 : 1))), r(mode, 'pink'), ...controls];
  const quota = `Kontext ${number(data.context)} % · 5 Std ${number(data.usage5h)} % · 7 Tage ${number(data.usage)} %`;
  const last = data.loadedTitles?.at(-1);
  const activity = data.mode === 'demo' || Boolean(data.active || data.recent);
  const dot = activity ? ['◉', '◎', '●', '◌'][frame % 4]! : '○';
  return [header, [r('─'.repeat(width), 'frame')],
    [r(quota, 'amber'), r(` · ${resetCountdown(data.usageResetsAt, data.now)}`, 'soft')],
    [r('Geladen: ', 'purple'), r(last ?? (data.loadedTitles ? 'noch nichts' : '—'), 'white')],
    [r(dot + ' ', 'purple'), r(data.stage, data.errors ? 'pink' : 'cyan'), r(` · ${count(data.searches)} Suchen · ${count(data.hits)} Treffer · ${count(data.loads)} geladen · ${count(data.saves)} gespeichert · ${timingLabel(data)}`, 'white')],
    [r(gitLabel(data), 'cyan'), r(' · ' + sessionLabel(data), 'soft')],
  ].map(row => ansi(fit(row, width), color));
}
