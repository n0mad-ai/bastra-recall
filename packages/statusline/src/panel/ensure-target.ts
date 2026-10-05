import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface EnsureTarget { surface: string; workspace: string }
/** A shared Codex daemon may omit CMUX_SURFACE_ID; resolve only the hook's exact session. */
export async function ensureTarget(env: NodeJS.ProcessEnv, payload: unknown, home: string, client: 'claude' | 'codex'): Promise<EnsureTarget | null> {
  if (env.CMUX_SURFACE_ID && env.CMUX_WORKSPACE_ID) return { surface: env.CMUX_SURFACE_ID, workspace: env.CMUX_WORKSPACE_ID };
  const session = (payload as any)?.session_id;
  if (typeof session !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(session)) return null;
  try {
    const store = JSON.parse(await readFile(path.join(home, '.cmuxterm', client + '-hook-sessions.json'), 'utf8'));
    const record = store.sessions?.[session];
    if (record?.sessionId === session && typeof record.surfaceId === 'string' && typeof record.workspaceId === 'string') {
      return { surface: record.surfaceId, workspace: record.workspaceId };
    }
  } catch { /* outside cmux / registration not available */ }
  return null;
}
