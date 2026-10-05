import { resetCountdown } from './reset-time';
import { contextRemaining } from './context-remaining';
import { gitLabel, sessionLabel, timingLabel } from './details';

import type { NeuralData } from './types';
import type { PanelView } from './view';
import { createRenderBase, compactRows, loadedRows, headerSwitches } from './render-base';
import type { Tone, Run } from './render-base';
const C = { bg: '10;10;25', white: '236;243;255', soft: '143;158;190', frame: '56;54;94',
  cyan: '94;255;224', purple: '190;145;255', amber: '255;199;117', pink: '255;133;211' };
/** Orbital diagram: moves for demo, real activity or a labelled completion afterglow. */
function reactor(frame: number, moving: boolean, width: number, r: ReturnType<typeof createRenderBase>['r']): Run[][] {
  const w = Math.min(31, width), centre = (w - 1) / 2;
  const canvas: { ch: string; tone: Tone }[][] = Array.from({ length: 5 }, () =>
    Array.from({ length: w }, () => ({ ch: ' ', tone: 'frame' as Tone })));
  const put = (x: number, y: number, ch: string, tone: Tone) => {
    const row = canvas[Math.round(y)], col = Math.round(x);
    if (row && col >= 0 && col < w) row[col] = { ch, tone };
  };
  for (let i = 0; i < 70; i++) {
    const a = i / 70 * Math.PI * 2;
    put(centre + Math.cos(a) * (centre - 3), 2 + Math.sin(a) * 2, '·', 'frame');
    put(centre + Math.cos(a) * (centre - 7), 2 + Math.sin(a) * 1.4, '∘', 'purple');
  }
  const angle = moving ? frame / 5 : 0;
  for (let i = 0; i < 3; i++) {
    const a = angle + i * Math.PI * 2 / 3;
    put(centre + Math.cos(a) * (centre - 3), 2 + Math.sin(a) * 2, i === 0 ? '◆' : '◈', i === 0 ? 'pink' : 'cyan');
  }
  const beam = moving && frame % 12 < 6;
  put(centre, 2, beam ? '◉' : '◎', 'pink');
  put(centre - 2, 2, '⟨', 'cyan'); put(centre + 2, 2, '⟩', 'cyan');
  put(0, 2, '╶', 'purple'); put(w - 1, 2, '╴', 'purple');
  const inset = ' '.repeat(Math.max(0, Math.floor((width - w) / 2)));
  return canvas.map(row => [r(inset), ...row.map(c => r(c.ch, c.tone, c.tone !== 'frame'))]);
}

/** A terminal instrument panel, deliberately separate from the Powerline design. */
export function renderNeural(data: NeuralData, width = 120, frame = 0, color = true, view: PanelView = {}): string[] {
  width = Math.max(1, Math.floor(width));
  const { r, fit, ansi, digits, meter, number, count } = createRenderBase(C, view);
  if (view.compact || width < 56) return compactRows(data, width, frame, color, view, C, '⟐ Mnemosyne');
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
  const heading = '⟐  B A S T R A  / /  M N E M O S Y N E';
  const mode = data.mode === 'demo' ? 'DESIGN / DEMO' : data.mode === 'live' ? (data.fresh ? `${(data.client ?? 'claude').toUpperCase()} / LIVE` : 'LIVE / WARTE AUF DATEN') : 'DATA / SNAPSHOT';
  rows.push(content([...fit([r(heading, 'cyan', true)], Math.max(0, inner - mode.length - (view.compact === undefined ? 1 : 8))), r(mode, 'pink', true), ...headerSwitches(view, r)]));
  rows.push(content([r(data.model + (data.effort ? ' · ' + data.effort : ''), 'white', true), r('  /  '), r(data.project, 'soft'), r('   ∴   DEEP MEMORY INTERFACE', 'purple')]));
  rows.push(content([r('─'.repeat(inner), 'frame')]));
  rows.push(cols([r('⌁  KONTEXT / NEURAL LOAD', 'cyan')], [r('⟐  RECALL / MEMORY CORE', 'pink')], [r('⌁  NUTZUNG / 7 TAGE', 'amber')]));
  const ctx = digits(data.context), usage = digits(data.usage);
  const scanner = data.mode === 'demo' ? Math.floor(frame / 2) % 3 : -1;
  const orbit = reactor(frame, data.mode === 'demo' || Boolean(data.active || data.recent), cell, r);
  for (let line = 0; line < 5; line++) {
    const instrument = (value: string[], tone: Tone, label: string, size: number, percent: number | null) =>
      line === 0 ? [r('╶ ' + '· '.repeat(Math.max(0, Math.floor((size - 4) / 2))) + '╴', 'frame')] :
      line === 4 ? meter(percent, size - 1, tone) :
      [r('  ' + value[line - 1]! + (line === 3 ? ` % ${label}` : ''), tone, true)];
    rows.push(cols(
      instrument(ctx, 'cyan', 'BELEGT', cell, data.context),
      orbit[line]!,
      instrument(usage, 'amber', 'VERBRAUCHT', third, data.usage),
    ));
  }
  rows.push(cols([r(contextRemaining(data.contextFree, data.contextTotal), 'cyan')], [r(`${number(data.vault)} ERINNERUNGEN  ·  `, 'white', true), r(['LEX', 'VECTOR', 'RANK'][scanner] ?? (data.active ? 'AKTIV' : data.recent ? 'NACHKLANG' : 'BEREIT'), 'pink')], [r(resetCountdown(data.usageResetsAt, data.now), 'amber')]));
  rows.push(content([r('─'.repeat(inner), 'frame')]));
  rows.push(content([r(gitLabel(data), data.git?.conflicts ? 'pink' : 'cyan'), r('   /   ', 'frame'), r(sessionLabel(data), 'soft')]));
  rows.push(content([r(`5 Std ${number(data.usage5h)} % · ${resetCountdown(data.usage5hResetsAt, data.now)}`, 'amber'), r(`   /   API ${data.apiDurationMs == null ? '—' : Math.round(data.apiDurationMs / 1000) + ' s'}`, 'soft')]));
  const stats = `${count(data.searches)} SUCHEN  →  ${count(data.hits)} TREFFER  →  ${count(data.loads)} GELADEN`;
  rows.push(content([r('↳  ', 'purple'), r(stats, 'white', true), r(`    ${count(data.saves)} GESPEICHERT`, 'cyan'), r('    ' + timingLabel(data), 'soft')]));
  const wave = data.mode === 'demo' || (data.mode === 'live' && Boolean(data.agentActive || data.active || data.recent)) ? Array.from({ length: 22 }, (_, i) =>
    ['⡀', '⣀', '⣄', '⣤', '⣦', '⣶', '⣾', '⣿'][Math.round((Math.sin(i / 3 + frame / 4) + 1) * 3.5)]).join('') : '─'.repeat(22);
  rows.push(content([r(wave, 'purple'), r(data.mode === 'demo' ? '  DEMO-SIGNAL  /  ' : data.mode === 'live' ? '  LIVE  /  ' : '  SNAPSHOT  /  ', 'soft'), r(data.stage, data.errors ? 'pink' : 'cyan'), r(data.mode === 'demo' ? '   ·   keine Live-Messung' : '', 'soft')]));
  for (const row of loadedRows(data, r)) rows.push(content(row));
  rows.push(border('╰', '╯'));
  return rows.map(row => ansi(fit(row, width), color));
}
