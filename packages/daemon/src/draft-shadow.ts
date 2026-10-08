/** Local-only repeat measurements (#1084, B3); never modifies drafts or vault notes. */
import { createHash, randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { cosine, isLoopbackHost, type EmbeddingProvider, type Vault } from "@bastra-recall/core";
import { draftsPath, draftVectorsPath, listDrafts, type Draft } from "./draft-store.js";
import { bigramSet, dice } from "./stop-lane-repeat.js";
import { withPathLock } from "./path-lock.js";
import { storedQuoteScorer } from "./harvest-vault-match.js";
import { envOff } from "./env.js";
import { logDirFor } from "./telemetry.js";

export const DRAFT_SHADOW_DICE_MIN = 0.6;
/** Unmeasured, logging only: low enough to expose the cosine distribution. */
export const DRAFT_SHADOW_COSINE_MIN = 0.35;
const VECTOR_MAX_BYTES = 16 * 1024 * 1024;
const EMBED_BATCH_SIZE = 16;

export interface DraftVectorEntry {
  fp: string;
  quoteHash: string;
  vector: Float32Array;
  measured: boolean;
  vaultMeasured: boolean;
}
interface VectorCache { provider: string; dim: number; entries: Map<string, DraftVectorEntry>; decisions: Map<string, string> }
export interface VaultVectorSnapshot {
  provider: string;
  dim: number;
  vectors: ReadonlyMap<string, Float32Array>;
}
export type DraftShadowEvent = ({
  kind: "draft_repeat_shadow";
  draft_id: string; other_draft_id: string; dice: number; cosine: number;
} | {
  kind: "draft_vault_shadow";
  draft_id: string; memory_id: string | null; cosine: number; containment: number;
}) & { provider_id?: string; dimensions?: number };
export interface DraftShadowOptions {
  /** The already resolved boot provider; no cloud factory/fallback on this path. */
  provider: EmbeddingProvider | null;
  ollama: { baseURL: string; model: string } | null;
  vault?: Vault;
  vaultVectors?: () => VaultVectorSnapshot | null;
  emit?: (event: DraftShadowEvent) => void;
  now?: number;
}
export interface DraftShadowResult {
  enabled: boolean; embedded: number; pairs: number; vaultMatches: number; errors: number;
}

export { draftVectorsPath } from "./draft-store.js";
function quoteHash(quote: string): string {
  return createHash("sha256").update(quote).digest("hex");
}
function validVector(vector: Float32Array, dim: number): boolean {
  return vector.length === dim && [...vector].every(Number.isFinite) && vector.some(value => value !== 0);
}
export function localDraftProvider(opts: DraftShadowOptions): EmbeddingProvider | null {
  if (!opts.provider || !opts.ollama || opts.provider.id !== `ollama-${opts.ollama.model}`) return null;
  try {
    const url = new URL(opts.ollama.baseURL);
    if (!['http:', 'https:'].includes(url.protocol) || !isLoopbackHost(url.hostname.toLowerCase())) return null;
  } catch { return null; }
  return Number.isInteger(opts.provider.dim) && opts.provider.dim > 0 ? opts.provider : null;
}
async function loadCache(path: string): Promise<VectorCache | null> {
  try {
    const handle = await open(path, "r");
    try {
      // Validate/read/chmod the same inode, even if the pathname is replaced.
      const info = await handle.stat();
      if (!info.isFile() || info.size > VECTOR_MAX_BYTES) return null;
      const text = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(text) > VECTOR_MAX_BYTES) return null;
      const raw = JSON.parse(text);
      if (raw.version !== 1 || typeof raw.provider !== "string" || !Number.isInteger(raw.dim) || raw.dim <= 0 || !Array.isArray(raw.rows)) return null;
      if ((info.mode & 0o777) !== 0o600) await handle.chmod(0o600);
      const entries = new Map<string, DraftVectorEntry>();
      for (const row of raw.rows.slice(-500)) {
        if (!/^d-[a-f0-9]{12}$/.test(row?.id ?? '') || typeof row.fp !== 'string' || typeof row.quoteHash !== 'string' || typeof row.vector !== 'string') continue;
        const bytes = Buffer.from(row.vector, "base64");
        if (bytes.length !== raw.dim * 4) continue;
        const vector = new Float32Array(raw.dim);
        new Uint8Array(vector.buffer).set(bytes);
        if (validVector(vector, raw.dim)) entries.set(row.id, { fp: row.fp, quoteHash: row.quoteHash, vector, measured: row.measured === true, vaultMeasured: row.vaultMeasured === true });
      }
      const decisions = new Map<string, string>();
      for (const pair of Array.isArray(raw.decisions) ? raw.decisions.slice(-1000) : []) {
        if (Array.isArray(pair) && /^[a-f0-9]{64}$/.test(pair[0]) && /^[a-f0-9]{64}$/.test(pair[1])) decisions.set(pair[0], pair[1]);
      }
      return { provider: raw.provider, dim: raw.dim, entries, decisions };
    } finally { await handle.close(); }
  } catch { return null; }
}

async function saveCache(path: string, cache: VectorCache): Promise<void> {
  if (cache.entries.size === 0 && cache.decisions.size === 0) {
    await unlink(path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
    return;
  }
  const rows = [...cache.entries].map(([id, row]) => ({ id, fp: row.fp, quoteHash: row.quoteHash, measured: row.measured, vaultMeasured: row.vaultMeasured,
    vector: Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength).toString("base64") }));
  const payload = JSON.stringify({ version: 1, provider: cache.provider, dim: cache.dim, rows, decisions: [...cache.decisions] });
  if (Buffer.byteLength(payload) > VECTOR_MAX_BYTES) throw new Error("draft vector byte bound");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
  }
}

/** Recheck under the draft writer lock: purge during an embedding request must
 * not resurrect a derived vector file after the user has deleted the drafts. */
async function persistCache(path: string, cache: VectorCache, now?: number): Promise<void> {
  await withPathLock(draftsPath(), async () => {
    const current = new Map((await listDrafts(now)).map(row => [row.id, row]));
    if (current.size === 0) cache.decisions.clear();
    for (const [id, entry] of cache.entries) {
      const row = current.get(id);
      if (!row || row.fp !== entry.fp || quoteHash(row.quote) !== entry.quoteHash) cache.entries.delete(id);
    }
    await saveCache(path, cache);
  }, { crossProcess: true });
}

/** Pure comparisons, yielding between rows so background math does not monopolize hooks. */
export async function compareDraftPairs(
  drafts: Draft[], entries: ReadonlyMap<string, DraftVectorEntry>, pending: ReadonlySet<string>,
  emit: (event: DraftShadowEvent) => void,
): Promise<number> {
  const grams = new Map(drafts.map(row => [row.id, bigramSet(row.quote)]));
  const sessions = new Map(drafts.map(row => [row.id, new Set(row.evidence.map(e => e.session_id))]));
  let count = 0;
  for (const row of drafts) {
    if (!pending.has(row.id)) continue;
    const a = entries.get(row.id);
    if (!a) continue;
    for (const other of drafts) {
      if (row.id === other.id || pending.has(other.id) && row.id > other.id) continue;
      if (other.evidence.some(e => sessions.get(row.id)!.has(e.session_id))) continue;
      const b = entries.get(other.id);
      if (!b) continue;
      const left = grams.get(row.id), right = grams.get(other.id);
      const lexical = left && right ? dice(left, right) : 0;
      const semantic = cosine(a.vector, b.vector);
      if (lexical >= DRAFT_SHADOW_DICE_MIN || semantic >= DRAFT_SHADOW_COSINE_MIN) {
        emit({ kind: "draft_repeat_shadow", draft_id: row.id, other_draft_id: other.id, dice: lexical, cosine: semantic });
        count++;
      }
    }
    await setImmediate();
  }
  return count;
}

async function writeEvents(events: DraftShadowEvent[]): Promise<void> {
  if (events.length === 0 || envOff("BASTRA_TELEMETRY", "NEXUS_TELEMETRY")) return;
  const dir = logDirFor();
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString();
  const path = join(dir, `events-${ts.slice(0, 10)}.jsonl`);
  let buffer = '';
  for (const event of events) {
    buffer += JSON.stringify({ ...event, ts }) + '\n';
    if (buffer.length >= 64 * 1024) { await appendFile(path, buffer, "utf8"); buffer = ''; }
  }
  if (buffer) await appendFile(path, buffer, "utf8");
}

/** Harvest-tick only. Cache is disposable, local, model-bound and separate from drafts. */
export async function runDraftShadow(opts: DraftShadowOptions): Promise<DraftShadowResult> {
  const result: DraftShadowResult = { enabled: false, embedded: 0, pairs: 0, vaultMatches: 0, errors: 0 };
  const provider = localDraftProvider(opts);
  const path = draftVectorsPath();
  if (!provider) {
    try { await stat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.errors++;
      return result;
    }
  }
  try {
    return await withPathLock(path, async () => {
      const allDrafts = await listDrafts(opts.now);
      const drafts = allDrafts.filter(row => row.state === "open");
      const byId = new Map(allDrafts.map(row => [row.id, row]));
      let cache = await loadCache(path);
      let dirty = false;
      if (cache) for (const [id, entry] of cache.entries) {
        const draft = byId.get(id);
        if (!draft || draft.fp !== entry.fp || quoteHash(draft.quote) !== entry.quoteHash) { cache.entries.delete(id); dirty = true; }
      }
      if (!provider) {
        if (cache && dirty) await persistCache(path, cache, opts.now);
        return result;
      }
      result.enabled = true;
      if (!cache || cache.provider !== provider.id || cache.dim !== provider.dim) {
        cache = { provider: provider.id, dim: provider.dim, entries: new Map(), decisions: cache?.decisions ?? new Map() };
        dirty = true;
      }
      const missing = allDrafts.filter(row => !cache!.entries.has(row.id));
      for (let offset = 0; offset < missing.length; offset += EMBED_BATCH_SIZE) {
        const batch = missing.slice(offset, offset + EMBED_BATCH_SIZE);
        try {
          const vectors = await provider.embed(batch.map(row => row.quote));
          if (vectors.length !== batch.length || vectors.some(vector => !validVector(vector, provider.dim))) throw new Error("invalid draft vector");
          for (let i = 0; i < batch.length; i++) cache.entries.set(batch[i].id, { fp: batch[i].fp, quoteHash: quoteHash(batch[i].quote), vector: vectors[i], measured: false, vaultMeasured: false });
          result.embedded += batch.length;
          dirty = true;
        } catch { result.errors++; break; } // unavailable local model never undoes capture
      }
      const pending = new Set([...cache.entries].filter(([id, row]) => byId.get(id)?.state === "open" && !row.measured).map(([id]) => id));
      const events: DraftShadowEvent[] = [];
      const emit = (event: DraftShadowEvent): void => {
        const record = { ...event, provider_id: cache!.provider, dimensions: cache!.dim };
        if (opts.emit) opts.emit(record);
        else events.push(record);
      };
      result.pairs = await compareDraftPairs(drafts, cache.entries, pending, emit);
      const pendingVault = new Set([...cache.entries].filter(([id, row]) => byId.get(id)?.state === "open" && !row.vaultMeasured).map(([id]) => id));
      const measuredVault: string[] = [];
      const snapshot = opts.vault && pendingVault.size > 0 ? opts.vaultVectors?.() : null;
      if (opts.vault && snapshot?.provider === provider.id && snapshot.dim === provider.dim) {
        // snapshot() is a live map: copy immediately, before any subsequent await.
        const vectors = new Map([...snapshot.vectors].filter(([, vector]) => validVector(vector, provider.dim)).map(([id, vector]) => [id, new Float32Array(vector)]));
        const notes = new Map(opts.vault.list().map(memory => [memory.fm.id, memory]));
        const score = storedQuoteScorer(opts.vault);
        for (const id of pendingVault) {
          const draft = byId.get(id), entry = cache.entries.get(id);
          if (!draft || !entry) continue;
          let nearest: { id: string; cosine: number } | null = null;
          for (const [memoryId, vector] of vectors) {
            if (!notes.has(memoryId) || !opts.vault.get(memoryId)) continue;
            const value = cosine(entry.vector, vector);
            if (!nearest || value > nearest.cosine) nearest = { id: memoryId, cosine: value };
          }
          if (nearest) {
            const privateNote = notes.get(nearest.id)!.fm.sensitivity === "private" || opts.vault.get(nearest.id)?.fm.sensitivity === "private";
            emit({ kind: "draft_vault_shadow", draft_id: id, memory_id: privateNote ? null : nearest.id,
              cosine: nearest.cosine, containment: score(draft.quote, nearest.id) });
            result.vaultMatches++;
            measuredVault.push(id);
          }
          await setImmediate();
        }
      }
      let written = true;
      try { await writeEvents(events); } catch { result.errors++; written = false; }
      if (written) {
        for (const id of pending) { cache.entries.get(id)!.measured = true; dirty = true; }
        for (const id of measuredVault) { cache.entries.get(id)!.vaultMeasured = true; dirty = true; }
      }
      if (dirty) await persistCache(path, cache, opts.now);
      return result;
    }, { crossProcess: true });
  } catch { result.errors++; return result; } // no provider error bodies, quotes or commands in telemetry
}

/** Reuse only valid, model-bound vectors produced by the local shadow pass. */
export async function readDraftVectors(opts: DraftShadowOptions, drafts: Draft[]): Promise<ReadonlyMap<string, Float32Array> | null> {
  const provider = localDraftProvider(opts);
  if (!provider) return null;
  const cache = await loadCache(draftVectorsPath());
  if (!cache || cache.provider !== provider.id || cache.dim !== provider.dim) return null;
  const vectors = new Map<string, Float32Array>();
  for (const draft of drafts) {
    const entry = cache.entries.get(draft.id);
    if (entry && entry.fp === draft.fp && entry.quoteHash === quoteHash(draft.quote)) vectors.set(draft.id, entry.vector);
  }
  return vectors;
}

/** Decision receipts are adjacent to vectors, never in draft state. The key and
 * signature are hashes; no quotes, commands or private memory ids are stored. */
export async function recordDraftDecision(key: string, signature: string): Promise<boolean> {
  const path = draftVectorsPath();
  return withPathLock(path, async () => {
    const cache = await loadCache(path) ?? { provider: "decisions-only", dim: 1, entries: new Map(), decisions: new Map() };
    if (cache.decisions.get(key) === signature) return false;
    cache.decisions.delete(key); cache.decisions.set(key, signature);
    while (cache.decisions.size > 1000) cache.decisions.delete(cache.decisions.keys().next().value!);
    await saveCache(path, cache);
    return true;
  }, { crossProcess: true });
}
