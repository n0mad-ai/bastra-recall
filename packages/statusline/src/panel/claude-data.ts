import path from 'node:path';
import os from 'node:os';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { readRecallFeed, readVaultSize } from '../codex/source';
import type { NeuralData } from './neural';
import { PanelGitReader } from './git-status';

export interface ClaudePanelSnapshot {
  sessionId: string; ts: number; project: string; model: string;
  context: number | null; usage: number | null; usageResetsAt: number | null; transcript: string | null;
  contextTotal: number | null; contextFree: number | null;
  cwd: string | null; promptId: string | null; effort: string | null;
  durationMs: number | null; costUsd: number | null; cacheHitRatio: number | null;
  linesAdded: number | null; linesRemoved: number | null;
  usage5h?: number | null; usage5hResetsAt?: number | null; apiDurationMs?: number | null;
}
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const percent = (v: unknown): number | null => { const n = num(v); return n !== null && n <= 100 ? n : null; };
export const PANEL_DIR = path.join(os.homedir(), '.bastra', 'panels', 'claude');
export function snapshotPath(session: string, directory = PANEL_DIR): string {
  if (typeof session !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error('Ungültige Claude-Session-ID');
  return path.join(directory, session + '.json');
}

/** Native fields only. No fixed model context sizes, no guessed quota. */
export function nativeSnapshot(input: any, now = Date.now()): ClaudePanelSnapshot {
  const sessionId = input?.session_id;
  snapshotPath(sessionId);
  const window = input.context_window ?? {};
  const total = num(window.context_window_size);
  let used = num(window.total_input_tokens);
  if (used === null) {
    const parts = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map(k => num(window.current_usage?.[k]));
    if (parts.every(n => n !== null)) used = parts.reduce<number>((sum, n) => sum + n!, 0);
  }
  let context = percent(window.used_percentage);
  // Claude's percentage is input-only; output becomes input on the next request.
  if (context === null && total !== null && total > 0 && used !== null) {
    context = Math.min(100, used / total * 100);
  }
  return {
    sessionId, ts: now,
    project: path.basename(input.workspace?.project_dir ?? input.workspace?.current_dir ?? input.cwd ?? ''),
    model: input.model?.display_name ?? input.model?.id ?? 'Claude',
    context, usage: percent(input.rate_limits?.seven_day?.used_percentage),
    contextTotal: total !== null && total > 0 ? total : null,
    contextFree: total !== null && total > 0 && used !== null ? Math.max(0, total - used) : null,
    usageResetsAt: num(input.rate_limits?.seven_day?.resets_at),
    transcript: typeof input.transcript_path === 'string' ? input.transcript_path : null,
    cwd: input.workspace?.current_dir ?? input.cwd ?? input.workspace?.project_dir ?? null,
    promptId: typeof input.prompt_id === 'string' ? input.prompt_id : null,
    effort: input.effort?.level ?? null,
    durationMs: num(input.cost?.total_duration_ms), costUsd: num(input.cost?.total_cost_usd),
    cacheHitRatio: typeof input.prompt_cache?.hit_ratio === 'number' && input.prompt_cache.hit_ratio >= 0 && input.prompt_cache.hit_ratio <= 1 ? input.prompt_cache.hit_ratio : null,
    linesAdded: num(input.cost?.total_lines_added), linesRemoved: num(input.cost?.total_lines_removed),
    usage5h: percent(input.rate_limits?.five_hour?.used_percentage), usage5hResetsAt: num(input.rate_limits?.five_hour?.resets_at),
    apiDurationMs: num(input.cost?.total_api_duration_ms),
  };
}

export async function publishNative(input: unknown, directory = PANEL_DIR): Promise<void> {
  const snapshot = nativeSnapshot(input);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = snapshotPath(snapshot.sessionId, directory), tmp = file + '.' + process.pid + '.tmp';
  await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(tmp, file);
}

export class ClaudeCalls {
  searches = 0; hits = 0; loads = 0; saves = 0; errors = 0; startedAt = 0; ms = 0;
  promptId: string | null = null;
  calls = 0;
  lastAt = 0; lastTool: string | null = null;
  loaded: string[] = [];
  pendingTools = new Map<string, string>();
  private doneTools = new Set<string>();
  pending = new Map<string, { name: string; at: number }>();
  private seen = new Set<string>();
  constructor(readonly session: string) {}
  accept(row: any): void {
    if (row?.sessionId !== this.session || row.isSidechain || row.isMeta) return;
    const content = row.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const time = Date.parse(row.timestamp);
    const human = row.type === 'user' && !blocks.some((b: any) => b.type === 'tool_result') &&
      (typeof content === 'string' || blocks.some((b: any) => b.type === 'text'));
    // User-typed prompt ids distinguish a turn from harness/user-role inserts.
    if (human && row.promptId && row.promptId !== this.promptId && Number.isFinite(time) && time >= this.startedAt) {
      this.searches = this.hits = this.loads = this.saves = this.errors = 0;
      this.ms = 0; this.calls = 0; this.promptId = row.promptId;
      this.lastAt = 0; this.lastTool = null; this.loaded = [];
      this.pending.clear(); this.pendingTools.clear(); this.doneTools.clear(); this.seen.clear(); this.startedAt = time;
    }
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        if (typeof block.id === 'string' && typeof block.name === 'string' && !this.doneTools.has(block.id)) this.pendingTools.set(block.id, block.name);
        const match = /^mcp__bastra[-_]recall__(\w+)$/.exec(block.name ?? '');
        if (match && typeof block.id === 'string' && !this.seen.has(block.id) && !this.pending.has(block.id)) this.pending.set(block.id, { name: match[1]!, at: time });
      }
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      this.pendingTools.delete(block.tool_use_id);
      this.doneTools.add(block.tool_use_id);
      if (this.doneTools.size > 4096) this.doneTools.delete(this.doneTools.values().next().value!);
      const call = this.pending.get(block.tool_use_id);
      if (!call || this.seen.has(block.tool_use_id)) continue;
      this.pending.delete(block.tool_use_id); this.seen.add(block.tool_use_id);
      this.calls++;
      this.lastTool = call.name;
      if (Number.isFinite(time)) this.lastAt = time;
      if (Number.isFinite(time) && Number.isFinite(call.at) && time >= call.at) this.ms += time - call.at;
      if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
      if (block.is_error) { this.errors++; continue; }
      let result: any = {};
      const text = typeof block.content === 'string' ? block.content :
        (Array.isArray(block.content) ? block.content.find((b: any) => b.type === 'text')?.text : null);
      try { result = JSON.parse(text); } catch { /* loads need no body */ }
      if (result?.error || result?.isError === true) { this.errors++; continue; }
      if (call.name === 'recall' || call.name === 'find_document') { this.searches++; this.hits += Array.isArray(result.hits) ? result.hits.length : 0; }
      if (['load_memory', 'read_document'].includes(call.name)) {
        this.loads++;
        const title = result?.frontmatter?.title ?? result?.title ?? result?.id;
        if (typeof title === 'string' && title) this.loaded = [...this.loaded, title].slice(-8);
      }
      if (['save_memory', 'edit_memory', 'save_document', 'save_product_doc'].includes(call.name)) this.saves++;
    }
  }
}

/**
 * Whether cmux's record says the agent is in the middle of a turn. `agentLifecycle: 'running'` only means the
 * process is alive: it stays set after the turn's Stop hook, so the last hook event decides.
 */
export function cmuxWorking(record: any): boolean {
  if (record?.activePromptDepth > 0 || ['running', 'working', 'thinking'].includes(record?.runtimeStatus)) return true;
  return record?.agentLifecycle === 'running' && typeof record.hookEventName === 'string' &&
    !['Stop', 'SessionStart', 'SessionEnd', 'Notification'].includes(record.hookEventName);
}

/** Incremental transcript reader; native metadata chooses the session/path. */
export class ClaudeLiveSource {
  private calls: ClaudeCalls;
  private git = new PanelGitReader();
  private file: string | null = null;
  private inode = 0; private offset = 0; private tail = Buffer.alloc(0); private discard = false;
  constructor(readonly session: string, readonly directory = PANEL_DIR, readonly feedDirectory = path.join(os.homedir(), '.bastra', 'statusline')) {
    snapshotPath(session, directory); this.calls = new ClaudeCalls(session);
  }
  private async transcript(file: string): Promise<void> {
    const fh = await open(file, 'r');
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new Error('Kein Transcript');
      if (file !== this.file || st.ino !== this.inode || st.size < this.offset) {
        this.file = file; this.inode = st.ino; this.offset = 0; this.tail = Buffer.alloc(0); this.discard = false; this.calls = new ClaudeCalls(this.session);
      }
      while (this.offset < st.size) {
        const buffer = Buffer.alloc(Math.min(1024 * 1024, st.size - this.offset));
        const { bytesRead } = await fh.read(buffer, 0, buffer.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const data = Buffer.concat([this.tail, buffer.subarray(0, bytesRead)]);
        let from = 0, end;
        while ((end = data.indexOf(10, from)) >= 0) {
          if (!this.discard && end - from <= 1024 * 1024) {
            try { this.calls.accept(JSON.parse(data.subarray(from, end).toString('utf8'))); } catch { /* malformed row */ }
          }
          this.discard = false; from = end + 1;
        }
        this.tail = data.subarray(from);
        if (this.tail.length > 1024 * 1024) { this.tail = Buffer.alloc(0); this.discard = true; }
      }
    } finally { await fh.close(); }
  }
  async poll(now = Date.now()): Promise<NeuralData> {
    const data: NeuralData = { mode: 'live', client: 'claude', project: 'Claude Code', model: 'Claude', context: null, usage: null, vault: null,
      searches: null, hits: null, loads: null, saves: null, latency: null, usageResetsAt: null, contextTotal: null, contextFree: null, now, stage: 'Warte auf native Sitzungsdaten', active: false, recent: false, agentActive: false, errors: 0, fresh: false };
    const [feed, vault] = await Promise.all([readRecallFeed(this.feedDirectory, this.session), readVaultSize(this.feedDirectory)]);
    data.vault = vault;
    let agentWorking = false;
    try {
      const store = JSON.parse(await readFile(path.join(os.homedir(), '.cmuxterm', 'claude-hook-sessions.json'), 'utf8'));
      const record = store.sessions?.[this.session];
      // Match identity; never treat an unrelated workspace's activity as ours.
      if (record?.sessionId === this.session) agentWorking = cmuxWorking(record);
    } catch { /* cmux is optional; transcript remains the fallback */ }
    try {
      const native = JSON.parse(await readFile(snapshotPath(this.session, this.directory), 'utf8')) as ClaudePanelSnapshot;
      if (native.sessionId !== this.session) return data;
      data.model = native.model; data.project = native.project;
      const age = now - native.ts;
      if (age < 0 || age > 10000) { data.stage = 'Native Daten veraltet'; return data; }
      data.context = percent(native.context); data.usage = percent(native.usage); data.fresh = true;
      data.usageResetsAt = num(native.usageResetsAt);
      data.contextTotal = num(native.contextTotal); data.contextFree = num(native.contextFree);
      data.effort = native.effort;
      data.durationMs = num(native.durationMs); data.costUsd = num(native.costUsd); data.cacheHitRatio = num(native.cacheHitRatio);
      data.linesAdded = num(native.linesAdded); data.linesRemoved = num(native.linesRemoved);
      data.usage5h = percent(native.usage5h); data.usage5hResetsAt = num(native.usage5hResetsAt);
      data.apiDurationMs = num(native.apiDurationMs);
      data.git = await this.git.read(native.cwd, now);
      let transcriptOk = false;
      if (native.transcript) {
        try { await this.transcript(native.transcript); transcriptOk = true; } catch { data.stage = 'Transcript nicht erreichbar'; }
      }
      if (transcriptOk) {
        data.searches = this.calls.searches; data.hits = this.calls.hits; data.loads = this.calls.loads; data.saves = this.calls.saves; data.errors = this.calls.errors; data.latency = this.calls.ms;
        data.loadedTitles = this.calls.loaded;
        data.clientLatency = this.calls.ms; data.timingSource = 'client';
        const pending = [...this.calls.pending.values()].at(-1);
        data.active = Boolean(pending);
        data.agentActive = agentWorking || this.calls.pendingTools.size > 0;
        const age = now - this.calls.lastAt;
        data.recent = this.calls.lastAt > 0 && age >= 0 && age < 5000;
        const names: Record<string, string> = { recall: 'Erinnerungen suchen', load_memory: 'Erinnerung laden', read_document: 'Dokument laden', save_memory: 'Erinnerung speichern', edit_memory: 'Erinnerung bearbeiten' };
        const otherTool = [...this.calls.pendingTools.values()].at(-1);
        data.stage = pending ? ({ recall: 'Erinnerungen suchen', load_memory: 'Erinnerung laden', save_memory: 'Erinnerung speichern' }[pending.name] ?? pending.name) :
          data.recent ? `Zuletzt: ${names[this.calls.lastTool!] ?? this.calls.lastTool}${this.calls.errors ? ' · Fehler' : ''}` :
          otherTool ? `Claude aktiv · ${otherTool}` : agentWorking ? 'Claude arbeitet · Recall bereit' : this.calls.errors ? `${this.calls.errors} fehlgeschlagene Aufrufe` : 'Recall bereit';
      }
      if (feed && feed.ts >= this.calls.startedAt && now - feed.ts >= 0 && now - feed.ts < 15000) {
        if (feed.current_stage) { data.stage = feed.current_message ?? feed.current_stage; data.active = true; }
        else if (feed.last_phrase_at && now - feed.last_phrase_at >= 0 && now - feed.last_phrase_at < 5000 && (feed.recall_count ?? 0) > 0) {
          data.recent = true;
          if (!this.calls.lastTool) data.stage = 'Zuletzt: Recall-Aktivität';
        }
      }
      // The old footer reads this exact forwarder duration. Match both turn
      // and completed-call count; a stale or in-flight feed is not comparable.
      if (feed && typeof feed.turn_id === 'number' && this.calls.startedAt > 0 &&
          Math.abs(feed.turn_id - this.calls.startedAt) < 10000 && feed.ts >= this.calls.startedAt &&
          (native.promptId == null || native.promptId === this.calls.promptId) &&
          this.calls.calls > 0 && this.calls.errors === 0 && feed.recall_count === this.calls.calls && !feed.current_stage && num(feed.total_ms) !== null) {
        data.latency = feed.total_ms!; data.timingSource = 'forwarder';
      }
    } catch { /* no native snapshot yet: unknown, not a guessed zero */ }
    return data;
  }
}
