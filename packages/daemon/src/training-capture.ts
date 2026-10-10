/**
 * #1128-capture — TEMPORARY local label store for the draft check.
 *
 * Step 0 of #1128 (evaluating local fine-tuning on the maintainer's own
 * instance) needs the texts the draft check judges, next to its verdicts.
 * Telemetry is text-free on purpose and stays that way, so the text goes here
 * and nowhere else: one append-only JSONL file beside the event log, 0600,
 * never in the vault, never sent anywhere.
 *
 * OFF unless `BASTRA_TRAINING_CAPTURE` is on. With the switch off no function
 * here reads or writes anything and no model is asked.
 *
 * Removal: this file, `training-signal.ts`, and the call sites tagged
 * `#1128-capture` are the whole feature. Delete them once #1128 is decided.
 *
 * Records, one JSON object per line, joined by `key`:
 *   statement  a quote a user typed (a draft)
 *   relation   two texts that were compared, A against B in exactly the order
 *              the model is asked: quote/quote or quote/note
 *   verdict    what a model said about one item: verdict, model, prompt_version
 *   human      RESERVED for a later human label ({ key, label }); nothing writes it yet
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { scanForInjection } from "@bastra-recall/core";
import { redactSecrets } from "@bastra-recall/core/scrub";
import { isOnValue } from "./env.js";
import { logDirFor } from "./telemetry.js";
import { withPathLock } from "./path-lock.js";
import { storedDrafts } from "./draft-store.js";
import { openOwnFile, warnRefusedFile, RefusedFile } from "./training-signal.js";
import { parseVerdict, relationPrompt, statementPrompt, RELATIONS, STATEMENT_KINDS, type DraftJudge } from "./draft-judge.js";

export const TRAINING_CAPTURE_FILE = "training-capture.jsonl";
/** Model calls per harvest tick; the rest waits for the next tick. */
export const TRAINING_JUDGE_MAX_PER_TICK = 20;

export type TrainingItem =
  | { type: "statement"; quote: string; draft_kind?: string; context?: string }
  | {
    type: "relation"; a: string; b: string; b_is: "statement" | "note";
    source: "draft_repeat_shadow" | "draft_vault_shadow" | "promotion";
    note_id?: string; cosine?: number; dice?: number; containment?: number;
  };
export interface TrainingVerdict { item: TrainingItem; verdict: string; model: string }
type StoredItem = TrainingItem & { v: 1; key: string; ts: string };
interface Store { items: Map<string, StoredItem>; judged: Set<string> }

export function trainingCaptureEnabled(): boolean {
  return isOnValue(process.env.BASTRA_TRAINING_CAPTURE);
}

/** Beside the event log, under a name the log retention never matches. */
export function trainingCapturePath(): string {
  return join(logDirFor(), TRAINING_CAPTURE_FILE);
}

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Changes whenever the wording of the prompt changes; the judged texts are not part of it. */
export function trainingPromptVersion(item: Pick<TrainingItem, "type"> & { b_is?: "statement" | "note" }): string {
  return hash(item.type === "statement" ? statementPrompt("") : relationPrompt("", "", item.b_is)).slice(0, 12);
}

/** The same guards a promoted note passes, on every text of the item: secrets
 *  redacted, and an item with injection text anywhere in it refused whole. */
function prepare(item: TrainingItem, now: number): StoredItem | null {
  const clean = (text: string): string => redactSecrets(text, homedir()).text;
  const ts = new Date(now).toISOString();
  if (item.type === "statement") {
    const quote = clean(item.quote), context = item.context ? clean(item.context) : "";
    if (!quote.trim() || scanForInjection(`${quote}\n${context}`).length) return null;
    return { v: 1, key: hash(`statement\n${quote}`).slice(0, 24), ts, type: "statement", quote,
      ...(item.draft_kind ? { draft_kind: item.draft_kind } : {}), ...(context ? { context } : {}) };
  }
  const a = clean(item.a), b = clean(item.b);
  if (!a.trim() || !b.trim() || scanForInjection(`${a}\n${b}`).length) return null;
  // A and B keep their order: the question is asked as A against B, and a
  // verdict belongs to that direction. The reverse order is its own item.
  return { ...item, v: 1, key: hash(JSON.stringify(["relation", item.b_is, a, b])).slice(0, 24), ts, a, b };
}

const judgedKey = (key: string, model: string, promptVersion: string): string => `${key}\n${model}\n${promptVersion}`;

/**
 * Open the store the one safe way (`openOwnFile`): a link at the path would
 * otherwise send the appended text into whatever it points at — the draft
 * store, for one — and a pipe there would hold the pass up. Null = no store yet.
 */
async function openStore(path: string, write: boolean): Promise<FileHandle | null> {
  try {
    return await openOwnFile(path, write ? constants.O_RDWR | constants.O_APPEND | constants.O_CREAT : constants.O_RDONLY);
  } catch (error) {
    if (!write && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readStore(path: string): Promise<Store> {
  const items = new Map<string, StoredItem>(), judged = new Set<string>();
  const handle = await openStore(path, false);
  if (!handle) return { items, judged };
  let raw: string;
  try { raw = await handle.readFile("utf8"); } finally { await handle.close(); }
  let n = 0;
  for (const line of raw.split("\n")) {
    if (++n % 256 === 0) await setImmediate();
    if (!line) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; } // a torn last line
    if (typeof row?.key !== "string") continue;
    if (row.type === "verdict" && typeof row.model === "string" && typeof row.prompt_version === "string") judged.add(judgedKey(row.key, row.model, row.prompt_version));
    else if (row.type === "statement" && typeof row.quote === "string" || row.type === "relation" && typeof row.a === "string" && typeof row.b === "string") items.set(row.key, row as unknown as StoredItem);
  }
  return { items, judged };
}

/** One write call per batch, at the end of the file. */
async function append(path: string, records: object[]): Promise<void> {
  if (!records.length) return;
  await mkdir(dirname(path), { recursive: true });
  const handle = (await openStore(path, true))!;
  try {
    const info = await handle.stat();
    if ((info.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    // An interrupted earlier append may have left a line without its end.
    let lead = "";
    if (info.size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, info.size - 1);
      if (last[0] !== 10) lead = "\n";
    }
    await handle.appendFile(lead + records.map(record => JSON.stringify(record) + "\n").join(""), "utf8");
  } finally { await handle.close(); }
}

/** A refused store costs this one write, with one text-free line; the daemon goes on. */
async function unlessRefused<T>(fallback: T, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (!(error instanceof RefusedFile)) throw error;
    warnRefusedFile(TRAINING_CAPTURE_FILE);
    return fallback;
  }
}

/** Read and append as one step: the same process and other processes wait their turn. */
function transact<T>(fallback: T, work: (store: Store, path: string) => Promise<T>): Promise<T> {
  const path = trainingCapturePath();
  return unlessRefused(fallback, () => withPathLock(path, async () => work(await readStore(path), path), { crossProcess: true }));
}

function verdictRecord(item: StoredItem, verdict: string, model: string, source: "shadow" | "promotion", now: number): object {
  return { v: 1, type: "verdict", key: item.key, ts: new Date(now).toISOString(), verdict, model, prompt_version: trainingPromptVersion(item), source };
}

/** Keep the texts: every item not stored yet is appended once. Returns how many were new. */
export async function captureTrainingItems(items: TrainingItem[], now = Date.now()): Promise<number> {
  if (!trainingCaptureEnabled() || !items.length) return 0;
  return transact(0, async (store, path) => {
    const fresh = new Map<string, StoredItem>();
    for (const item of items) {
      const stored = prepare(item, now);
      if (stored && !store.items.has(stored.key)) fresh.set(stored.key, stored);
    }
    await append(path, [...fresh.values()]);
    return fresh.size;
  });
}

/** Verdicts a promotion pass reached anyway, with the texts it read. */
export async function recordTrainingVerdicts(verdicts: TrainingVerdict[], now = Date.now()): Promise<number> {
  if (!trainingCaptureEnabled() || !verdicts.length) return 0;
  return transact(0, async (store, path) => {
    const records: object[] = [];
    let added = 0;
    for (const { item, verdict, model } of verdicts) {
      const stored = prepare(item, now);
      if (!stored) continue;
      if (!store.items.has(stored.key)) { store.items.set(stored.key, stored); records.push(stored); }
      const seen = judgedKey(stored.key, model, trainingPromptVersion(stored));
      if (store.judged.has(seen)) continue;
      store.judged.add(seen); records.push(verdictRecord(stored, verdict, model, "promotion", now)); added++;
    }
    await append(path, records);
    return added;
  });
}

/** Passes running in this process, by store path: a second one would ask the same questions. */
const judging = new Set<string>();

/**
 * The shadow check: every stored item this model has not judged under the
 * current prompt gets one question. The answer is written here and read by
 * nothing — promotion keeps its own verdicts and never sees these.
 * No judge (no local model, or battery saver on and on battery) asks nothing.
 * An unreachable model ends the pass; a reply that is no verdict is stored as
 * "none" and not asked again. One pass at a time per process; a verdict that
 * another process wrote meanwhile is not written a second time.
 */
export async function judgeTrainingBacklog(judge: DraftJudge | null, opts: { now?: number; max?: number } = {}): Promise<{ judged: number; pending: number }> {
  const idle = { judged: 0, pending: 0 };
  if (!trainingCaptureEnabled() || !judge) return idle;
  const path = trainingCapturePath(), now = opts.now ?? Date.now(), max = opts.max ?? TRAINING_JUDGE_MAX_PER_TICK;
  if (judging.has(path)) return idle;
  judging.add(path);
  try {
    return await unlessRefused(idle, async () => {
      const unjudged = (store: Store, item: StoredItem): boolean => !store.judged.has(judgedKey(item.key, judge.model, trainingPromptVersion(item)));
      const before = await readStore(path);
      const open = [...before.items.values()].filter(item => unjudged(before, item));
      const answers: { item: StoredItem; verdict: string }[] = [];
      for (const item of open.slice(0, max)) {
        let reply: string;
        try { reply = await judge.chat(item.type === "statement" ? statementPrompt(item.quote) : relationPrompt(item.a, item.b, item.b_is)); } catch { break; }
        const verdict = item.type === "statement" ? parseVerdict(reply, STATEMENT_KINDS) : parseVerdict(reply, RELATIONS);
        answers.push({ item, verdict: verdict ?? "none" });
      }
      if (!answers.length) return { judged: 0, pending: open.length };
      const written = await withPathLock(path, async () => {
        const current = await readStore(path);
        const records = answers.filter(({ item }) => unjudged(current, item)).map(({ item, verdict }) => verdictRecord(item, verdict, judge.model, "shadow", now));
        await append(path, records);
        return records.length;
      }, { crossProcess: true });
      return { judged: written, pending: open.length - answers.length };
    });
  } finally { judging.delete(path); }
}

export interface TrainingTick {
  pair: (item: TrainingItem) => void;
  verdict: (verdict: TrainingVerdict) => void;
  finish: (judge: DraftJudge | null) => Promise<void>;
}

/**
 * The harvest tick's whole contact with this store; null while the switch is
 * off. Called before drafts expire, and reads every draft still in the draft
 * file — also one that is already due — so every draft's text is kept first.
 * What the tick's shadow and promotion passes report is written by `finish`,
 * which then runs the shadow check. Never throws: the tick does not depend on it.
 */
export async function runTrainingCaptureTick(now: number): Promise<TrainingTick | null> {
  if (!trainingCaptureEnabled()) return null;
  const pairs: TrainingItem[] = [], verdicts: TrainingVerdict[] = [];
  const quiet = async (work: () => Promise<unknown>): Promise<void> => {
    try { await work(); } catch (error) { console.error(`[bastra-recall] training capture error (non-fatal): ${(error as NodeJS.ErrnoException)?.code ?? "unknown"}`); }
  };
  await quiet(async () => captureTrainingItems((await storedDrafts(now)).map(draft => ({
    type: "statement" as const, quote: draft.quote, draft_kind: draft.kind, ...(draft.context ? { context: draft.context } : {}),
  })), now));
  return {
    pair: item => { pairs.push(item); },
    verdict: verdict => { verdicts.push(verdict); },
    finish: judge => quiet(async () => {
      await captureTrainingItems(pairs, now);
      await recordTrainingVerdicts(verdicts, now);
      await judgeTrainingBacklog(judge, { now });
    }),
  };
}
