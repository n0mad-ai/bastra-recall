#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { shellQuote } from './codex/cmux';
import { renderNeural, toggleHit, LIGHT_CANVAS, NEURAL_DEMO, type NeuralData, type NeuralDesign } from './panel/neural';
import { ClaudeLiveSource } from './panel/claude-data';
import { TerminalFrame } from './panel/terminal-frame';
import { CodexLiveSource } from './panel/codex-data';
import { findRollout } from './codex/source';
import { PaneFollower } from './panel/follow';
import { panelAir } from './panel/view';
import { ensureTarget } from './panel/ensure-target';
import { installCodexPanelHook } from './panel/install-codex-hook';

// cmux's tab bar and terminal padding in points, measured on a pane sized by hand to its rows (373.7 pt for
// 20 rows of 17 pt). Deriving it from a fresh split instead counts that pane's leftover partial row.
const PANE_CHROME = 34;
/** Sizes the panel's pane to `lines` rows plus `air` points below them by moving the border to the pane above it. */
async function fitPane(workspace: string, above: string, surface: string, lines: number, air: number): Promise<void> {
  const run = (args: string[]) => new Promise<string>((resolve, reject) => execFile('cmux', args, { timeout: 5000 }, (err, out) => err ? reject(err) : resolve(out)));
  let own: any;
  // Right after a split the geometry is not laid out yet.
  for (let i = 0; i < 10 && !(own?.pixel_frame?.height > 0 && own.rows > 0); i++) {
    if (i) await new Promise(resolve => setTimeout(resolve, 150));
    own = JSON.parse(await run(['--json', '--id-format', 'uuids', 'list-panes', '--workspace', workspace])).panes
      ?.find((p: any) => p.surface_ids?.some((id: string) => id.toLowerCase() === surface.toLowerCase()));
  }
  if (!own) return;
  const amount = Math.round(own.pixel_frame.height - (own.cell_height_points ?? 17) * lines - PANE_CHROME - air);
  if (amount > 0) await run(['resize-pane', '--pane', above, '--workspace', workspace, '-D', '--amount', String(amount)]);
  if (amount < 0) await run(['resize-pane', '--pane', own.id, '--workspace', workspace, '-U', '--amount', String(-amount)]);
}

/** Asks the terminal for its background (OSC 11). cmux paints pane padding in that colour, whatever the panel draws. */
function terminalBackground(): Promise<number[] | undefined> {
  const input = process.stdin;
  if (!input.isTTY) return Promise.resolve(undefined);
  return new Promise(resolve => {
    let reply = '';
    const done = () => {
      clearTimeout(timer); input.off('data', read); input.setRawMode(false); input.pause();
      const match = /\]11;rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})/i.exec(reply);
      resolve(match?.slice(1).map(hex => parseInt(hex.slice(0, 2), 16)));
    };
    const read = (chunk: Buffer) => { reply += chunk.toString('latin1'); if (/\]11;[^\x07\x1b]*(\x07|\x1b\\)/.test(reply)) done(); };
    const timer = setTimeout(done, 400);
    input.setRawMode(true); input.resume(); input.on('data', read);
    process.stdout.write('\x1b]11;?\x1b\\');
  });
}

async function main(): Promise<void> {
  const { values: v } = parseArgs({ options: {
    demo: { type: 'boolean' }, watch: { type: 'boolean' }, snapshot: { type: 'string' },
    cmux: { type: 'boolean' }, surface: { type: 'string' }, workspace: { type: 'string' },
    'no-color': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    design: { type: 'string', default: 'orbital' },
    session: { type: 'string' }, follow: { type: 'string' }, fit: { type: 'string' }, compact: { type: 'boolean' }, light: { type: 'boolean' }, ensure: { type: 'boolean' },
    client: { type: 'string', default: 'claude' }, transcript: { type: 'string' },
    'install-codex-hook': { type: 'boolean' },
  }});
  if (v.help) { console.log(`bastra-recall-panel — Live-Panels für Claude und Codex

  --demo                 Deutlich markierte Design-Demo
  --watch                Animierte Vorschau im eigenen Terminal
  --snapshot FILE        Eigenes NeuralData-JSON anzeigen
  --session ID           Echte Claude-Code-Sitzung anzeigen (fest gebunden)
  --follow PANE          cmux-Pane folgen: aktiver Tab und dessen Sitzung (braucht --workspace)
  --client claude|codex  Client wählen (Standard: claude)
  --transcript FILE      Explizites Codex-JSONL-Transcript
  --design classic       Erste Neural Console
  --design orbital       Alien-Cockpit (Standard)
  --design ember         Randloses Glutfeld mit Verläufen
  --compact              Mit der kleinen Ansicht starten (Kopf-Symbol oder Taste m)
  --light                Mit dem hellen Skin starten (Kopf-Symbol oder Taste h)
  --ensure               Für einen SessionStart-Hook: unter dem eigenen cmux-Pane öffnen, falls dort noch
                         kein Panel läuft; ohne Ausgabe, außerhalb von cmux ohne Wirkung
  --install-codex-hook   Codex-SessionStart-Autostart mit Sicherung einrichten; danach /hooks prüfen
  --cmux                 Unter einer Surface öffnen; ohne --session folgt das Panel deren Pane
  --surface UUID         Explizite Ziel-Surface
  --workspace UUID       Expliziter Ziel-Workspace
  --no-color             Ohne Farben

--demo zeigt markierte Beispieldaten, keine Live-Nutzung.
`); return; }
  if (v['install-codex-hook']) {
    if (!['classic', 'orbital', 'ember'].includes(v.design)) throw new Error('Unbekanntes Design');
    const command = [process.execPath, fileURLToPath(import.meta.url), '--ensure', '--client', 'codex', '--design', v.design];
    if (v.compact) command.push('--compact');
    if (v.light) command.push('--light');
    await installCodexPanelHook(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), command);
    console.log('Codex-Autostart eingerichtet. Den neuen Hook in /hooks prüfen und vertrauen.'); return;
  }
  if (v.ensure) {
    let payload: unknown = null;
    if (!process.env.CMUX_SURFACE_ID && !process.stdin.isTTY) {
      let input = '';
      for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) return; }
      try { payload = JSON.parse(input); } catch { /* optional hook payload */ }
    }
    const target = await ensureTarget(process.env, payload, os.homedir(), v.client === 'codex' ? 'codex' : 'claude');
    if (!target) return;
    v.surface = target.surface; v.workspace = target.workspace;
    v.cmux = true;
  }
  if (v.client !== 'claude' && v.client !== 'codex') throw new Error('--client muss claude oder codex sein');
  const following = Boolean(v.follow) || Boolean(v.cmux && !v.demo && !v.snapshot && !v.session);
  if ([v.demo, v.snapshot, v.session, following].filter(Boolean).length !== 1) throw new Error('--demo ODER --snapshot FILE ODER --session ID ODER --follow PANE angeben');
  if ((v.follow || v.fit) && !v.workspace) throw new Error('--follow und --fit brauchen --workspace');
  if (v.design !== 'classic' && v.design !== 'orbital' && v.design !== 'ember') throw new Error('--design muss classic, orbital oder ember sein');
  if (v.cmux) {
    const surface = v.surface || process.env.CMUX_SURFACE_ID;
    const workspace = v.workspace || process.env.CMUX_WORKSPACE_ID;
    if (!surface || !workspace) throw new Error('--surface und --workspace für cmux angeben');
    const args = [process.execPath, fileURLToPath(import.meta.url), '--watch', '--design', v.design, '--client', v.client];
    if (v.demo) args.push('--demo');
    else if (v.session) args.push('--session', v.session);
    else if (v.snapshot) args.push('--snapshot', path.resolve(v.snapshot));
    if (v.transcript) args.push('--transcript', path.resolve(v.transcript));
    if (v['no-color']) args.push('--no-color');
    if (v.compact) args.push('--compact');
    if (v.light) args.push('--light');
    const run = (a: string[]) => execFileSync('cmux', a, { encoding: 'utf8', timeout: 10000 });
    const list = () => JSON.parse(run(['--json', '--id-format', 'uuids', 'list-panes', '--workspace', workspace]));
    const source = list().panes?.find((p: any) => p.surface_ids?.some((id: string) => id.toLowerCase() === surface.toLowerCase()));
    if (!source?.id) throw new Error('Ziel-Surface nicht im Workspace gefunden');
    // One panel per pane: a running panel names the pane it sits under in its own arguments.
    if (v.ensure && execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').some(line =>
      line.includes('recall-panel') && line.includes('--fit ' + source.id))) return;
    args.push('--fit', source.id, '--workspace', workspace);
    if (following) args.push('--follow', source.id);
    const panel = JSON.parse(run(['--json', '--id-format', 'uuids', 'new-split', 'down', '--surface', surface, '--workspace', workspace,
      '--command', args.map(shellQuote).join(' '), '--focus', 'false']));
    try {
      run(['tab-action', '--action', 'rename', '--surface', panel.surface_id, '--workspace', workspace, '--title', v.demo ? '◉ Neural Console · Design' : `${{ classic: '◉ Neural Console', orbital: '⟐ Mnemosyne', ember: '▂▄▆ Ember' }[v.design as NeuralDesign]} · ${following ? '' : v.client + ' '}Live`]);
    } catch { /* the title is cosmetic */ }
    // A hook's output would land in the agent's context.
    if (!v.ensure) console.log(v.demo ? 'Neural Console geöffnet — DESIGN-DEMO.' : 'Neural Console geöffnet.');
    return;
  }
  if (v.watch && !process.stdout.isTTY) throw new Error('--watch braucht ein eigenes Terminal');
  let frame = 0, stop = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restore = () => {
    if (stop) return;
    stop = true; clearTimeout(timer);
    if (v.watch) process.stdout.write('\x1b]111\x1b\\\x1b[?1000l\x1b[?1006l\x1b[?2026l\x1b[?7h\x1b[?25h\x1b[?1049l');
    if (v.watch && process.stdin.isTTY) { process.stdin.setRawMode(false); process.stdin.pause(); }
  };
  process.once('SIGTERM', restore); process.once('SIGINT', restore);
  const color = !v['no-color'] && process.env.NO_COLOR === undefined;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  let live = v.session ? (v.client === 'claude' ? new ClaudeLiveSource(v.session) :
    new CodexLiveSource(v.session, v.transcript ?? await findRollout(codexHome, v.session))) : null;
  const follower = v.follow ? new PaneFollower(v.workspace!, v.follow) : null;
  let bound: string | null = null, idle = '';
  const waiting = (stage: string): NeuralData => ({ mode: 'live', fresh: false, project: '—', model: '—', context: null, usage: null, vault: null,
    searches: null, hits: null, loads: null, saves: null, latency: null, stage });
  const painter = new TerminalFrame();
  if (v.watch) process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l');
  const paper = v.watch && color ? await terminalBackground() : undefined;
  // Every design has two views and two skins. In a terminal of its own the header carries the switches: click, or press m / h.
  let compact = v.watch && process.stdin.isTTY ? Boolean(v.compact) : v.compact, light = Boolean(v.light), fitted = 0;
  // The pane's own background follows the skin (OSC 11 / 111), so unpainted rows match the canvas.
  const tint = () => process.stdout.write(light ? `\x1b]11;rgb:${LIGHT_CANVAS.map(c => c.toString(16).padStart(2, '0')).join('/')}\x1b\\` : '\x1b]111\x1b\\');
  if (v.watch && process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdout.write('\x1b[?1000h\x1b[?1006h');
    if (light) tint();
    process.stdin.on('data', (chunk: Buffer) => {
      const input = chunk.toString('latin1');
      if (input.includes('\x03')) { restore(); process.exit(0); }
      const clicks = [...input.matchAll(/\x1b\[<(\d+);(\d+);(\d+)M/g)].map(([, button, x, y]) =>
        button === '0' ? toggleHit(process.stdout.columns ?? 0, Number(x) - 1, Number(y) - 1) : null);
      if (clicks.includes('view') || input === 'm') compact = !compact;
      if (clicks.includes('skin') || input === 'h') { light = !light; tint(); }
    });
  }
  async function tick(): Promise<void> {
    if (stop) return;
    if (follower) {
      const target = await follower.poll(), key = target ? target.client + ':' + target.sessionId : '';
      if (key !== bound) {
        bound = key; live = null; idle = 'In diesem Tab läuft weder Claude noch Codex';
        try {
          if (target) live = target.client === 'claude' ? new ClaudeLiveSource(target.sessionId) :
            new CodexLiveSource(target.sessionId, target.transcript ?? await findRollout(codexHome, target.sessionId));
        } catch { idle = 'Codex-Transcript nicht gefunden'; }
      }
    }
    const data: NeuralData = v.demo ? NEURAL_DEMO : live ? await live.poll() : follower ? waiting(idle) : { ...JSON.parse(await readFile(v.snapshot!, 'utf8')), mode: 'snapshot' };
    if (stop) return;
    const columns = Math.max(1, process.stdout.columns ?? 130);
    const lines = renderNeural(data, columns, frame++, color, v.design as NeuralDesign, { paper, compact, light });
    if (v.watch) {
      const output = painter.paint(lines, columns, process.stdout.rows ?? lines.length);
      if (output) process.stdout.write(output);
      if (v.fit && process.env.CMUX_SURFACE_ID && lines.length !== fitted) {
        fitted = lines.length;
        // Full views share the measured bottom inset; compact views fit their six rows.
        await fitPane(v.workspace!, v.fit, process.env.CMUX_SURFACE_ID, fitted, panelAir(compact, fitted)).catch(() => { /* sizing is best-effort */ });
      }
    } else console.log(lines.join('\n'));
    if (v.watch && !stop) timer = setTimeout(() => { tick().catch(err => { restore(); console.error(err.message); process.exitCode = 1; }); }, 180);
  }
  try { await tick(); } catch (err) { restore(); throw err; }
}
main().catch(err => {
  if (process.argv.includes('--ensure')) return; // a cosmetic panel must never fail a session start
  console.error(`bastra-recall-panel: ${err.message}`); process.exitCode = 1;
});
