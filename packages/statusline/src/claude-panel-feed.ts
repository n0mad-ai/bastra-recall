#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { publishNative } from './panel/claude-data';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { renderer: { type: 'string' } } });
  if (!values.renderer) throw new Error('--renderer fehlt');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk); size += b.length;
    if (size > 1024 * 1024) throw new Error('Statusline-Eingabe zu groß');
    chunks.push(b);
  }
  const input = Buffer.concat(chunks);
  // Cosmetic feed must not break the user's existing statusline.
  try { await publishNative(JSON.parse(input.toString('utf8')), process.env.BASTRA_PANEL_DIR); } catch { /* fail open */ }
  process.stdout.write(execFileSync('/bin/sh', ['-c', values.renderer], { input, timeout: 2500, maxBuffer: 1024 * 1024 }));
}
main().catch(err => { console.error(`Claude panel feed: ${err.message}`); process.exitCode = 1; });
