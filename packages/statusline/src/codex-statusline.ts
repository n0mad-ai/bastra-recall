#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderCodex } from './codex/render';
import { emptyStatus, type CodexStatus } from './codex/state';
import { cmuxSession, findRollout, readRecallFeed, readVaultSize, RolloutSource } from './codex/source';
import { openCmuxPanel } from './codex/cmux';

const HELP = `bastra-codex-statusline — Powerline für Codex + Recall

  --cmux                   Panel unter der Codex-Surface öffnen
  --surface UUID           cmux-Surface (sonst CMUX_SURFACE_ID)
  --session ID             Eindeutige Codex-Sitzung
  --transcript PATH        Explizites JSONL-Transcript
  --watch                  Live im eigenen Terminal/Panel anzeigen
  --json                   Snapshot als JSON
  --ascii                  Ohne Powerline-/Unicode-Glyphen
  --no-color               Ohne ANSI-Farben
  --demo                   Gestaltete Beispieldaten, kein Live-Zustand
  --help                   Diese Hilfe

Beispiele:
  bastra-codex-statusline --cmux
  bastra-codex-statusline --session <id> --watch

Die Anzeige liest nur Metadaten; sie sendet keine Nachrichten an Codex.
`;

function demo(): CodexStatus {
  return { ...emptyStatus(), cwd: '/project/bastra-recall', branch: 'main', model: 'gpt-6.1-sol', effort: 'high',
    sessionId: 'demo', active: false, contextUsed: 113732, contextWindow: 828400, tokens: 1476235,
    limits: [{ minutes: 300, used: 24, resetsAt: null }, { minutes: 10080, used: 14, resetsAt: null }],
    vaultSize: 1367, calls: 6, searches: 2, loads: 3, saves: 1, hits: 6, ms: 240 };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    cmux: { type: 'boolean' }, surface: { type: 'string' }, session: { type: 'string' }, transcript: { type: 'string' },
    watch: { type: 'boolean' }, json: { type: 'boolean' }, ascii: { type: 'boolean' },
    'no-color': { type: 'boolean' }, demo: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  }});
  if (values.help) { console.log(HELP); return; }
  if (values.cmux && (values.watch || values.json || values.demo)) throw new Error('--cmux nicht mit --watch, --json oder --demo kombinieren');
  if (values.watch && !process.stdout.isTTY) throw new Error('--watch braucht ein eigenes Terminal; ohne --watch wird ein Snapshot ausgegeben');
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  let session = values.session, file = values.transcript;
  const surface = values.surface || process.env.CMUX_SURFACE_ID;
  let target: Awaited<ReturnType<typeof cmuxSession>> | undefined;
  if ((!session && !file && !values.demo) || values.cmux) {
    if (!surface) throw new Error('Codex-Sitzung mit --session/--transcript oder cmux-Surface mit --surface angeben');
    target = await cmuxSession(os.homedir(), surface);
    if (session && session !== target.sessionId) throw new Error('Session-ID passt nicht zur cmux-Surface');
    session = target.sessionId;
    file = file ?? target.transcriptPath;
  }
  if (!file && session) file = await findRollout(codexHome, session);
  if (values.cmux) {
    const args = [process.execPath, fileURLToPath(import.meta.url), '--session', session!, '--transcript', path.resolve(file!), '--watch'];
    if (values.ascii) args.push('--ascii');
    if (values['no-color']) args.push('--no-color');
    console.log(openCmuxPanel(target!, args));
    return;
  }
  const source = file ? new RolloutSource(path.resolve(file), session) : null;
  const directory = path.join(os.homedir(), '.bastra', 'statusline');
  const color = !values['no-color'] && process.env.NO_COLOR === undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function restore(): void {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (values.watch) process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
  process.once('SIGINT', restore); process.once('SIGTERM', restore);
  if (values.watch) process.stdout.write('\x1b[?1049h\x1b[?25l');
  try {
    let last = '';
    async function tick(): Promise<void> {
      if (stopped) return;
      await source?.poll();
      if (stopped) return;
      const state = source?.projection.state ?? demo();
      const [feed, vault] = values.demo ? [null, null] : await Promise.all([
        readRecallFeed(directory, state.sessionId), readVaultSize(directory),
      ]);
      if (vault !== null) state.vaultSize = vault;
      if (!values.watch && source?.error) throw new Error(source.error);
      if (values.json) console.log(JSON.stringify({ ...state, sourceError: source?.error ?? null }, null, 2));
      else {
        const width = Math.max(1, (process.stdout.columns ?? 140) - 1);
        const lines = renderCodex(state, { width, color, ascii: values.ascii, feed, sourceError: Boolean(source?.error) });
        const output = lines.join('\n');
        if (values.watch) {
          if (output !== last) {
            process.stdout.write('\x1b[H\x1b[2J' + lines.join('\r\n'));
            last = output;
          }
        } else console.log(output);
      }
      if (values.watch && !stopped) timer = setTimeout(() => { tick().catch(err => { restore(); console.error(err.message); process.exitCode = 1; }); }, 200);
    }
    await tick();
  } catch (err) { restore(); throw err; }
}

main().catch(err => { console.error(`bastra-codex-statusline: ${err.message}`); process.exitCode = 1; });
