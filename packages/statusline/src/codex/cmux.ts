import { execFileSync } from 'node:child_process';
import type { CmuxSession } from './source';

export function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
type Run = (args: string[]) => string;
const runCmux: Run = args => execFileSync('cmux', args, { encoding: 'utf8', timeout: 10000 });

/** A separate terminal owns the drawing; no escape bytes enter Codex's TTY. */
export function openCmuxPanel(target: CmuxSession, command: string[], run: Run = runCmux): string {
  const list = () => JSON.parse(run(['--json', '--id-format', 'uuids', 'list-panes', '--workspace', target.workspaceId]));
  const before = list();
  const source = before.panes?.find((p: any) => p.surface_ids?.some((id: string) => id.toLowerCase() === target.surfaceId.toLowerCase()));
  if (!source?.id) throw new Error('Codex-Surface ist nicht mehr im erwarteten Workspace');
  const created = JSON.parse(run(['--json', '--id-format', 'uuids', 'new-split', 'down', '--surface', target.surfaceId,
    '--workspace', target.workspaceId, '--command', command.map(shellQuote).join(' '), '--focus', 'false']));
  const surface = created.surface_id;
  // Layout/title are cosmetic. A failure here must not kill the running panel.
  try {
    if (typeof surface === 'string') run(['tab-action', '--action', 'rename', '--surface', surface, '--workspace', target.workspaceId, '--title', '❖ Recall · Codex']);
    const after = list();
    const panel = after.panes?.find((p: any) => p.surface_ids?.some((id: string) => id.toLowerCase() === String(surface).toLowerCase()));
    if (panel) {
      const desired = (panel.cell_height_points ?? 17) * 3 + 36;
      const amount = Math.floor((panel.pixel_frame?.height ?? 0) - desired);
      if (amount > 0) run(['resize-pane', '--pane', source.id, '--workspace', target.workspaceId, '-D', '--amount', String(amount)]);
    }
  } catch { /* user's cmux may support split but not geometry/title APIs */ }
  return typeof surface === 'string' ? `Recall-Panel geöffnet: ${surface}` : 'Recall-Panel geöffnet';
}
