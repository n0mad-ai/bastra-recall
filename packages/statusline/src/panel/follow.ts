import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface FollowTarget { client: 'claude' | 'codex'; sessionId: string; transcript: string | null }
type Stores = Partial<Record<FollowTarget['client'], any>>;

/** The session cmux last recorded for this surface, across both clients. Newest record wins. */
export function sessionForSurface(stores: Stores, surface: string): FollowTarget | null {
  const key = surface.toLowerCase();
  let best: (FollowTarget & { at: number }) | null = null;
  for (const client of ['claude', 'codex'] as const) {
    const store = stores[client];
    const records = (Object.values(store?.sessions ?? {}) as any[]).filter(r => typeof r?.sessionId === 'string' &&
      typeof r.surfaceId === 'string' && r.surfaceId.toLowerCase() === key).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    // cmux marks the session that currently owns a surface; older records for it are history.
    const active = (Object.entries(store?.activeSessionsBySurface ?? {}) as [string, any][]).find(([id]) => id.toLowerCase() === key)?.[1];
    const record = records.find(r => r.sessionId === active?.sessionId) ?? (active ? null : records[0]);
    const sessionId = record?.sessionId ?? active?.sessionId, at = Math.max(record?.updatedAt ?? 0, active?.updatedAt ?? 0);
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId) || (best && best.at >= at)) continue;
    best = { client, sessionId, transcript: typeof record?.transcriptPath === 'string' ? record.transcriptPath : null, at };
  }
  return best && { client: best.client, sessionId: best.sessionId, transcript: best.transcript };
}

/** Follows one cmux pane: whichever tab is selected there, and whichever session runs in it. */
export class PaneFollower {
  private surface: string | null = null;
  private checkedAt = 0;
  constructor(readonly workspace: string, readonly pane: string, readonly home = os.homedir()) {}
  private selected(): Promise<string | null> {
    return new Promise(resolve => execFile('cmux', ['--json', '--id-format', 'uuids', 'list-panes', '--workspace', this.workspace], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(this.surface); // cmux busy: keep the last known tab
      try {
        const pane = JSON.parse(stdout).panes?.find((p: any) => String(p.id).toLowerCase() === this.pane.toLowerCase());
        resolve(typeof pane?.selected_surface_id === 'string' ? pane.selected_surface_id : null);
      } catch { resolve(this.surface); }
    }));
  }
  async poll(now = Date.now()): Promise<FollowTarget | null> {
    if (now - this.checkedAt >= 1000) { this.checkedAt = now; this.surface = await this.selected(); }
    if (!this.surface) return null;
    const stores: Stores = {};
    for (const client of ['claude', 'codex'] as const) {
      try { stores[client] = JSON.parse(await readFile(path.join(this.home, '.cmuxterm', client + '-hook-sessions.json'), 'utf8')); } catch { /* client not in use */ }
    }
    return sessionForSurface(stores, this.surface);
  }
}
