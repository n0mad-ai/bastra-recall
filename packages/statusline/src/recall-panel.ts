#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { shellQuote } from './codex/cmux';
import { renderNeural, NEURAL_DEMO, type NeuralData, type NeuralDesign } from './panel/neural';
import { ClaudeLiveSource } from './panel/claude-data';
import { TerminalFrame } from './panel/terminal-frame';
import { CodexLiveSource } from './panel/codex-data';
import { findRollout } from './codex/source';

async function main(): Promise<void> {
  const { values: v } = parseArgs({ options: {
    demo: { type: 'boolean' }, watch: { type: 'boolean' }, snapshot: { type: 'string' },
    cmux: { type: 'boolean' }, surface: { type: 'string' }, workspace: { type: 'string' },
    'no-color': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    design: { type: 'string', default: 'orbital' },
    session: { type: 'string' },
    client: { type: 'string', default: 'claude' }, transcript: { type: 'string' },
  }});
  if (v.help) { console.log(`bastra-recall-panel — Neural Console (experimenteller Design-Prototyp)

  --demo                 Deutlich markierte Design-Demo
  --watch                Animierte Vorschau im eigenen Terminal
  --snapshot FILE        Eigenes NeuralData-JSON anzeigen
  --session ID           Echte Claude-Code-Sitzung anzeigen
  --client claude|codex  Client wählen (Standard: claude)
  --transcript FILE      Explizites Codex-JSONL-Transcript
  --design classic       Erste Neural Console
  --design orbital       Alien-Cockpit (Standard)
  --cmux                 Vorschau unter einer Surface öffnen
  --surface UUID         Explizite Ziel-Surface
  --workspace UUID       Expliziter Ziel-Workspace
  --no-color             Ohne Farben

Dies ist ein Design-Prototyp. --demo zeigt keine Live-Nutzung von Claude Code.
`); return; }
  if (v.client !== 'claude' && v.client !== 'codex') throw new Error('--client muss claude oder codex sein');
  if (v.cmux && !v.demo && !v.snapshot && !v.session) {
    const surface = v.surface || process.env.CMUX_SURFACE_ID;
    const store = JSON.parse(await readFile(path.join(os.homedir(), '.cmuxterm', v.client + '-hook-sessions.json'), 'utf8'));
    const matches = Object.values(store.sessions ?? {}).filter((s: any) => typeof s.surfaceId === 'string' && s.surfaceId.toLowerCase() === surface?.toLowerCase()) as any[];
    if (matches.length !== 1) throw new Error('Keine eindeutige Sitzung für diese Surface');
    v.session = matches[0].sessionId;
    if (v.client === 'codex') v.transcript = matches[0].transcriptPath;
  }
  if ([v.demo, v.snapshot, v.session].filter(Boolean).length !== 1) throw new Error('--demo ODER --snapshot FILE ODER --session ID angeben');
  if (v.design !== 'classic' && v.design !== 'orbital') throw new Error('--design muss classic oder orbital sein');
  if (v.cmux) {
    const surface = v.surface || process.env.CMUX_SURFACE_ID;
    const workspace = v.workspace || process.env.CMUX_WORKSPACE_ID;
    if (!surface || !workspace) throw new Error('--surface und --workspace für cmux angeben');
    const args = [process.execPath, fileURLToPath(import.meta.url), '--watch', '--design', v.design, '--client', v.client];
    if (v.demo) args.push('--demo');
    else if (v.session) args.push('--session', v.session);
    else args.push('--snapshot', path.resolve(v.snapshot!));
    if (v.transcript) args.push('--transcript', path.resolve(v.transcript));
    if (v['no-color']) args.push('--no-color');
    const run = (a: string[]) => execFileSync('cmux', a, { encoding: 'utf8', timeout: 10000 });
    const list = () => JSON.parse(run(['--json', '--id-format', 'uuids', 'list-panes', '--workspace', workspace]));
    const source = list().panes?.find((p: any) => p.surface_ids?.some((id: string) => id.toLowerCase() === surface.toLowerCase()));
    if (!source?.id) throw new Error('Ziel-Surface nicht im Workspace gefunden');
    const panel = JSON.parse(run(['--json', '--id-format', 'uuids', 'new-split', 'down', '--surface', surface, '--workspace', workspace,
      '--command', args.map(shellQuote).join(' '), '--focus', 'false']));
    try {
      run(['tab-action', '--action', 'rename', '--surface', panel.surface_id, '--workspace', workspace, '--title', v.demo ? '◉ Neural Console · Design' : `⟐ Mnemosyne · ${v.client} Live`]);
      const geometry = list().panes?.find((p: any) => p.surface_ids?.some((id: string) => id.toLowerCase() === String(panel.surface_id).toLowerCase()));
      // Fit to rendered rows, not a fixed generous pane height. Frame includes
      // the tab bar; derive its actual overhead from cmux's row measurement.
      const cellHeight = geometry?.cell_height_points ?? 17;
      const lines = renderNeural(NEURAL_DEMO, geometry?.columns ?? 130, 0, false, v.design as NeuralDesign).length;
      const overhead = Math.max(0, (geometry?.pixel_frame?.height ?? 0) - (geometry?.rows ?? lines) * cellHeight);
      const amount = Math.floor((geometry?.pixel_frame?.height ?? 0) - cellHeight * lines - overhead);
      if (amount > 0) run(['resize-pane', '--pane', source.id, '--workspace', workspace, '-D', '--amount', String(amount)]);
    } catch { /* geometry is best-effort */ }
    console.log(v.demo ? 'Neural Console geöffnet — DESIGN-DEMO.' : 'Neural Console geöffnet.'); return;
  }
  if (v.watch && !process.stdout.isTTY) throw new Error('--watch braucht ein eigenes Terminal');
  let frame = 0, stop = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restore = () => {
    if (stop) return;
    stop = true; clearTimeout(timer);
    if (v.watch) process.stdout.write('\x1b[?2026l\x1b[?7h\x1b[?25h\x1b[?1049l');
  };
  process.once('SIGTERM', restore); process.once('SIGINT', restore);
  const color = !v['no-color'] && process.env.NO_COLOR === undefined;
  const live = v.session ? (v.client === 'claude' ? new ClaudeLiveSource(v.session) :
    new CodexLiveSource(v.session, v.transcript ?? await findRollout(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), v.session))) : null;
  const painter = new TerminalFrame();
  if (v.watch) process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l');
  async function tick(): Promise<void> {
    if (stop) return;
    const data: NeuralData = v.demo ? NEURAL_DEMO : live ? await live.poll() : { ...JSON.parse(await readFile(v.snapshot!, 'utf8')), mode: 'snapshot' };
    if (stop) return;
    const columns = Math.max(1, process.stdout.columns ?? 130);
    const lines = renderNeural(data, columns, frame++, color, v.design as NeuralDesign);
    if (v.watch) {
      const output = painter.paint(lines, columns, process.stdout.rows ?? lines.length);
      if (output) process.stdout.write(output);
    } else console.log(lines.join('\n'));
    if (v.watch && !stop) timer = setTimeout(() => { tick().catch(err => { restore(); console.error(err.message); process.exitCode = 1; }); }, 180);
  }
  try { await tick(); } catch (err) { restore(); throw err; }
}
main().catch(err => { console.error(`bastra-recall-panel: ${err.message}`); process.exitCode = 1; });
