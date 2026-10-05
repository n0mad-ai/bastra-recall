import { open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CodexProjection, type RecallFeed } from './state';

const MAX_CHUNK = 1024 * 1024;

/** Incremental JSONL reader: bounded memory, split UTF-8/rows survive ticks. */
export class RolloutSource {
  projection = new CodexProjection();
  private offset = 0;
  private partial = Buffer.alloc(0);
  private discard = false;
  private inode: number | null = null;
  private invalidIdentity = false;
  error: string | null = null;
  constructor(readonly file: string, readonly sessionId?: string) {}

  async poll(): Promise<void> {
    let fh;
    try {
      fh = await open(this.file, 'r');
      const st = await fh.stat();
      if (!st.isFile()) throw new Error('Transcript ist keine Datei');
      if (this.inode !== st.ino || st.size < this.offset) {
        this.offset = 0; this.partial = Buffer.alloc(0); this.discard = false;
        this.projection = new CodexProjection(); this.inode = st.ino; this.invalidIdentity = false;
      }
      if (this.invalidIdentity) throw new Error('Transcript gehört zu einer anderen Sitzung');
      // Initial replay can be long; process chunkwise and yield between reads.
      while (this.offset < st.size) {
        const buf = Buffer.alloc(Math.min(MAX_CHUNK, st.size - this.offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this.consume(buf.subarray(0, bytesRead));
      }
      const id = this.projection.state.sessionId;
      if (this.sessionId && id && id !== this.sessionId) {
        this.projection = new CodexProjection();
        this.invalidIdentity = true;
        throw new Error('Transcript gehört zu einer anderen Sitzung');
      }
      this.error = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Transcript nicht erreichbar';
    } finally { await fh?.close(); }
  }

  private consume(chunk: Buffer): void {
    const data = Buffer.concat([this.partial, chunk]);
    let from = 0;
    for (;;) {
      const end = data.indexOf(10, from);
      if (end < 0) break;
      if (!this.discard && end - from <= MAX_CHUNK) {
        try { this.projection.accept(JSON.parse(data.subarray(from, end).toString('utf8'))); } catch { /* unknown/invalid row */ }
      }
      this.discard = false; from = end + 1;
    }
    this.partial = data.subarray(from);
    if (this.partial.length > MAX_CHUNK) { this.partial = Buffer.alloc(0); this.discard = true; }
  }
}

export async function readRecallFeed(directory: string, sessionId: string | null): Promise<RecallFeed | null> {
  if (!sessionId) return null;
  try {
    const names = await readdir(directory);
    let best: RecallFeed | null = null;
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const raw = await readFile(path.join(directory, name), 'utf8');
        if (raw.length > 65536) continue;
        const feed = JSON.parse(raw) as RecallFeed;
        if (feed.cc_session_id === sessionId && typeof feed.ts === 'number' && Number.isFinite(feed.ts) && (!best || feed.ts > best.ts)) best = feed;
      } catch { /* concurrent rename, stale file */ }
    }
    return best;
  } catch { return null; }
}

export async function readVaultSize(directory: string): Promise<number | null> {
  try {
    const d = JSON.parse(await readFile(path.join(directory, 'vault.json'), 'utf8'));
    return typeof d.vault_size === 'number' && Number.isFinite(d.vault_size) && d.vault_size >= 0 ? d.vault_size : null;
  } catch { return null; }
}

export interface CmuxSession { sessionId: string; transcriptPath: string; surfaceId: string; workspaceId: string }
export async function cmuxSession(home: string, surface: string): Promise<CmuxSession> {
  const store = JSON.parse(await readFile(path.join(home, '.cmuxterm', 'codex-hook-sessions.json'), 'utf8'));
  const candidates = Object.values(store.sessions ?? {}).filter((r: any) =>
    typeof r?.surfaceId === 'string' && r.surfaceId.toLowerCase() === surface.toLowerCase() &&
    typeof r.sessionId === 'string' && typeof r.transcriptPath === 'string' && typeof r.workspaceId === 'string') as CmuxSession[];
  if (candidates.length !== 1) throw new Error('Keine eindeutige Codex-Sitzung für diese cmux-Surface. --session und --transcript verwenden.');
  return candidates[0]!;
}

/** Date directories only. Never binds to "the most recently modified" session. */
export async function findRollout(codexHome: string, id: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Ungültige Session-ID');
  const root = path.join(codexHome, 'sessions');
  const hits: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) await walk(path.join(dir, entry.name), depth + 1);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`)) hits.push(path.join(dir, entry.name));
    }
  }
  await walk(root, 0);
  if (hits.length !== 1) throw new Error('Kein eindeutiges JSONL-Transcript gefunden. --transcript angeben; paginierte Sitzungen werden noch nicht unterstützt.');
  return hits[0]!;
}
