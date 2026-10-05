import { readFile, writeFile, rename, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { shellQuote } from '../codex/cmux';
const MARKER = '# bastra-panel-ensure';

export function withCodexPanelHook(current: any, args: string[]): any {
  const config = structuredClone(current);
  config.hooks ??= {};
  config.hooks.SessionStart ??= [];
  const command = args.map(shellQuote).join(' ') + ' ' + MARKER;
  const handler = { type: 'command', command, timeout: 10, statusMessage: 'Recall-Panel starten' };
  for (const group of config.hooks.SessionStart) {
    const index = group.hooks?.findIndex((hook: any) => typeof hook.command === 'string' && hook.command.includes(MARKER));
    if (index >= 0) { group.hooks[index] = handler; return config; }
  }
  config.hooks.SessionStart.push({ matcher: 'startup|resume', hooks: [handler] });
  return config;
}
/** Configures the normal non-managed hook; never writes a trust hash or bypasses review. */
export async function installCodexPanelHook(directory: string, args: string[]): Promise<boolean> {
  const file = path.join(directory, 'hooks.json');
  let old: string | null = null;
  try { old = await readFile(file, 'utf8'); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  const current = old === null ? {} : JSON.parse(old);
  const next = JSON.stringify(withCodexPanelHook(current, args), null, 2) + '\n';
  if (old === next) return false;
  await mkdir(directory, { recursive: true });
  if (old !== null) await copyFile(file, file + '.bak-panel-' + new Date().toISOString().replace(/[:.]/g, '-'));
  const tmp = file + '.' + process.pid + '.tmp';
  await writeFile(tmp, next, { mode: 0o600 }); await rename(tmp, file);
  return true;
}
