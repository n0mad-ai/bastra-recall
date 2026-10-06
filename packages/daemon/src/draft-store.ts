/** Local, bounded draft storage (#1084, phase A); never reads or writes a vault. */
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { redactSecrets } from "@bastra-recall/core/scrub";
import { withPathLock } from "./path-lock.js";

export const DRAFT_MAX_ROWS = 500;
export const DRAFT_MAX_BYTES = 1024 * 1024;
export const DRAFT_OPEN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DRAFT_RETAIN_AGE_MS = 180 * 24 * 60 * 60 * 1000;

const timestamp = z.number().finite().nonnegative();
const draftSchema = z.object({
  id: z.string().regex(/^d-[a-f0-9]{12}$/),
  fp: z.string().regex(/^[a-f0-9]{40}$/),
  kind: z.enum(["restated", "correction", "answer", "after-failure"]),
  quote: z.string(), context: z.string().optional(),
  situation: z.object({
    cwd: z.string().optional(), project: z.string().optional(), branch: z.string().optional(),
    before: z.array(z.string()), after: z.array(z.string()),
    reads: z.array(z.string()), lits: z.array(z.string()),
  }),
  evidence: z.array(z.object({ session_id: z.string(), turn: z.number().int().nonnegative(), ts: timestamp, client: z.string().optional() })).min(1),
  created: timestamp, last_touched: timestamp,
  surfaced: z.array(z.object({ session_id: z.string(), ts: timestamp, novel: z.array(z.string()) })),
  state: z.enum(["open", "promoted", "rejected"]),
  memory_id: z.string().optional(), evidence_key: z.string().optional(), announce: z.boolean().optional(),
});

export type Draft = z.infer<typeof draftSchema>;

export function draftsPath(): string {
  return resolve(process.env.BASTRA_DRAFTS_PATH ?? join(homedir(), ".bastra", "drafts.json"));
}

export function draftFingerprint(quote: string): string {
  const normalized = quote.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
  return createHash("sha1").update(normalized).digest("hex");
}

export function draftId(sessionId: string, turn: number, fp: string): string {
  return "d-" + createHash("sha1").update(`${sessionId}:${turn}:${fp}`).digest("hex").slice(0, 12);
}

function sanitize(input: unknown): Draft | null {
  const d = draftSchema.parse(input);
  const quote = redactSecrets(d.quote, homedir());
  if (quote.redactedChars > d.quote.length * 0.3) return null;
  const clean = (text: string, max = 200) => redactSecrets(text, homedir()).text.slice(0, max);
  const optional = (text: string | undefined) => text === undefined ? undefined : clean(text);
  const strings = (items: string[], count: number, max = 200) => items.slice(-count).map((s) => clean(s, max));
  return {
    ...d, quote: quote.text.slice(0, 600), context: d.context === undefined ? undefined : clean(d.context, 160),
    situation: {
      cwd: optional(d.situation.cwd), project: optional(d.situation.project), branch: optional(d.situation.branch),
      before: strings(d.situation.before, 3), after: strings(d.situation.after.slice(0, 3), 3),
      reads: strings(d.situation.reads, 3), lits: strings(d.situation.lits, 32, 160),
    },
    // Opaque identifiers (often UUIDs) must keep their identity across sessions.
    evidence: d.evidence.map((e) => ({ ...e, session_id: e.session_id.slice(0, 200), client: optional(e.client) })),
    surfaced: d.surfaced.slice(-5).map((s) => ({ ...s, session_id: s.session_id.slice(0, 200), novel: strings(s.novel, 32, 160) })),
    memory_id: d.memory_id?.slice(0, 200), evidence_key: d.evidence_key?.slice(0, 200),
    last_touched: Math.max(d.last_touched, d.created, ...d.evidence.map((e) => e.ts), ...d.surfaced.map((s) => s.ts)),
  };
}

function bounded(rows: Draft[], now: number): Draft[] {
  const kept = rows.filter((d) => now - d.last_touched < (d.state === "open" ? DRAFT_OPEN_AGE_MS : DRAFT_RETAIN_AGE_MS));
  kept.sort((a, b) => a.last_touched - b.last_touched);
  if (kept.length > DRAFT_MAX_ROWS) kept.splice(0, kept.length - DRAFT_MAX_ROWS);
  // Metadata/evidence and non-ASCII text also count toward the actual byte cap.
  let bytes = 2 + kept.reduce((sum, d) => sum + Buffer.byteLength(JSON.stringify(d)) + 1, 0);
  while (bytes > DRAFT_MAX_BYTES && kept.length) bytes -= Buffer.byteLength(JSON.stringify(kept.shift()!)) + 1;
  return kept;
}

// One cached path, invalidated by atomic writes from the CLI or another instance.
let cache: { path: string; stamp: string; rows: Draft[] } | undefined;
async function fileStamp(path: string): Promise<string> {
  try {
    const st = await stat(path);
    if (st.size > DRAFT_MAX_BYTES) throw new Error("draft store exceeds its byte limit");
    return `${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
}

async function load(path: string): Promise<Draft[]> {
  const stamp = await fileStamp(path);
  if (cache?.path === path && cache.stamp === stamp) return structuredClone(cache.rows);
  let rows: Draft[] = [];
  if (stamp !== "missing") {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("draft store must be a JSON array");
    for (const row of parsed) {
      const result = draftSchema.safeParse(row);
      if (!result.success) throw new Error("invalid draft store row");
      const clean = sanitize(result.data);
      if (clean) rows.push(clean);
    }
  }
  cache = { path, stamp, rows };
  return structuredClone(rows);
}

async function write(path: string, rows: Draft[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(rows), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    cache = { path, stamp: await fileStamp(path), rows: structuredClone(rows) };
  } finally {
    await unlink(tmp).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
  }
}

/** Listing is not a display in a recall lane and does not refresh last_touched. */
export async function listDrafts(now = Date.now()): Promise<Draft[]> {
  const path = draftsPath();
  return withPathLock(path, async () => bounded(await load(path), now), { crossProcess: true });
}

/** Replace by id; cross-session matching and situation merging belong to phase B. */
export async function upsertDraft(input: Draft, now = Date.now()): Promise<Draft | null> {
  const draft = sanitize(input);
  if (!draft) return null;
  if (Buffer.byteLength(JSON.stringify(draft)) > DRAFT_MAX_BYTES - 2) throw new Error("draft exceeds store byte limit");
  const path = draftsPath();
  return withPathLock(path, async () => {
    const rows = (await load(path)).filter((row) => row.id !== draft.id);
    rows.push(draft);
    const kept = bounded(rows, now);
    await write(path, kept);
    return structuredClone(kept.find((row) => row.id === draft.id) ?? null);
  }, { crossProcess: true });
}

/** Phase B will call this from the harvest tick. A missing promoted note leaves a tombstone. */
export async function expireDrafts(opts: { now?: number; memoryExists?: (id: string) => Promise<boolean> } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const path = draftsPath();
  return withPathLock(path, async () => {
    const rows = await load(path);
    if (opts.memoryExists) {
      for (const row of rows) {
        if (row.state === "promoted" && row.memory_id && !await opts.memoryExists(row.memory_id)) {
          row.state = "rejected";
          row.announce = false;
          row.last_touched = now;
        }
      }
    }
    const kept = bounded(rows, now);
    if (rows.length || await fileStamp(path) !== "missing") await write(path, kept);
    return rows.length - kept.length;
  }, { crossProcess: true });
}

export async function purgeDrafts(): Promise<void> {
  const path = draftsPath();
  await withPathLock(path, async () => {
    await unlink(path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
    cache = undefined;
  }, { crossProcess: true });
}
