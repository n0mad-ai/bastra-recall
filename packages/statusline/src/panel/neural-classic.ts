import { resetCountdown } from './reset-time';
import { contextRemaining } from './context-remaining';
import { gitLabel, sessionLabel, timingLabel } from './details';

import type { NeuralData } from './types';
import type { PanelView } from './view';
import { createRenderBase, compactRows, loadedRows, headerSwitches } from './render-base';
import type { Run } from './render-base';
const C = { bg: '9;15;28', white: '230;240;248', soft: '140;163;186', frame: '50;69;94',
  cyan: '76;229;209', purple: '186;151;255', amber: '255;192;109', pink: '255;121;169' };
/** A terminal instrument panel, deliberately separate from the Powerline design. */
export function renderNeural(data: NeuralData, width = 120, frame = 0, color = true, view: PanelView = {}): string[] {
  width = Math.max(1, Math.floor(width));
  const { r, fit, ansi, digits, meter, number, count } = createRenderBase(C, view);
  if (view.compact || width < 56) return compactRows(data, width, frame, color, view, C, '◉ Neural Console');
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
  rows.push(content([...fit([r(heading, 'cyan', true)], Math.max(0, inner - mode.length - (view.compact === undefined ? 1 : 8))), r(mode, 'pink', true), ...headerSwitches(view, r)]));
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
  rows.push(content([r(`5 Std ${number(data.usage5h)} % · ${resetCountdown(data.usage5hResetsAt, data.now)}`, 'amber'), r(`   /   API ${data.apiDurationMs == null ? '—' : Math.round(data.apiDurationMs / 1000) + ' s'}`, 'soft')]));
  const stats = `${count(data.searches)} SUCHEN  →  ${count(data.hits)} TREFFER  →  ${count(data.loads)} GELADEN`;
  rows.push(content([r('↳  ', 'purple'), r(stats, 'white', true), r(`    ${count(data.saves)} GESPEICHERT`, 'cyan'), r('    ' + timingLabel(data), 'soft')]));
  const demoWave = ['⡀', '⣀', '⣄', '⣤', '⣦', '⣶', '⣦', '⣤', '⣄', '⣀'];
  const wave = data.mode === 'demo' || (data.mode === 'live' && Boolean(data.agentActive || data.active || data.recent)) ? Array.from({ length: 20 }, (_, i) => demoWave[(i + frame) % demoWave.length]).join('') : '─'.repeat(20);
  rows.push(content([r(wave, 'purple'), r(data.mode === 'demo' ? '  DEMO-WELLE  /  ' : data.mode === 'live' ? '  LIVE  /  ' : '  SNAPSHOT  /  ', 'soft'), r(data.stage, data.errors ? 'pink' : 'cyan'), r(data.mode === 'demo' ? '   ·   keine Live-Messung' : '', 'soft')]));
  for (const row of loadedRows(data, r)) rows.push(content(row));
  rows.push(border('╰', '╯'));
  return rows.map(row => ansi(fit(row, width), color));
}
