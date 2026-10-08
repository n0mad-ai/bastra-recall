/** Repeat-based draft promotion (#1084, D). Local vectors only; dry-run by default. */
import { createHash } from "node:crypto";
import { appendFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { cosine, deleteMemoryFile, type SaveMemoryInput, type Vault } from "@bastra-recall/core";
import { redactSecrets } from "@bastra-recall/core/scrub";
import { scanForInjection } from "@bastra-recall/core";
import { localDraftProvider, readDraftVectors, type DraftShadowOptions } from "./draft-shadow.js";
import { transactDrafts, type Draft } from "./draft-store.js";
import { draftUseProof } from "./draft-use.js";
import { tokens } from "./save-similarity.js";
import { weightedContainment, STORED_CONTAINMENT_MIN } from "./harvest-vault-match.js";
import { saveMemoryWithAuditTrail, recordAudit } from "./audit-trail.js";
import { extractCommandHead } from "./bash-fail-lane.js";
import { logDirFor } from "./telemetry.js";
import { envOff } from "./env.js";

/** Unmeasured thresholds from the night-run plan. */
export const DRAFT_REPEAT_COSINE_MIN = 0.70;
export const DRAFT_VAULT_COSINE_MIN = 0.60;
export const DRAFT_RARE_TOKEN_MAX_ROWS = 2;
export const DRAFT_RARE_TOKEN_MIN = 4;
export interface DraftPromotionEvent {
  kind: "draft_would_promote" | "draft_promoted" | "draft_duplicate_blocked" | "draft_promote_blocked";
  draft_ids: string[];
  evidence_count: number;
  reason?: string;
  cosine?: number;
  containment?: number;
}
export interface DraftPromoteOptions extends Omit<DraftShadowOptions, "emit"> { vault: Vault; emit?: (event: DraftPromotionEvent) => void }
export interface DraftPromoteResult { promoted: number; wouldPromote: number; duplicates: number; blocked: number; errors: number }

/** Path identity stays outside the vault; legacy/mixed draft provenance is not guessed. */
export async function draftVaultId(root: string): Promise<string> {
  return createHash("sha256").update(await realpath(root)).digest("hex");
}
function evidenceOf(rows: Draft[]): Draft["evidence"] {
  return [...new Map(rows.flatMap(row => row.evidence).map(e => [`${e.session_id}:${e.turn}`, e])).values()]
    .sort((a, b) => a.session_id.localeCompare(b.session_id) || a.turn - b.turn);
}
export function draftEvidenceKey(rows: Draft[]): string {
  return createHash("sha256").update(evidenceOf(rows).map(e => `${e.session_id}:${e.turn}`).join("\n")).digest("hex").slice(0, 12);
}
function distinctSessions(rows: Draft[]): number { return new Set(evidenceOf(rows).map(e => e.session_id)).size; }
function validVector(vector: Float32Array | undefined, dim: number): vector is Float32Array {
  return !!vector && vector.length === dim && vector.every(Number.isFinite) && vector.some(value => value !== 0);
}
function closeRows(rows: Draft[], state: "promoted" | "rejected", memoryId: string, key: string | undefined, now: number): void {
  for (const row of rows) {
    row.state = state; row.memory_id = memoryId; row.last_touched = now;
    if (key) { row.evidence_key = key; row.announce = state === "promoted"; }
  }
}

/** Verbatim evidence, deterministic cues; never generalizes or calls a text model. */
export function buildDraftNote(rows: Draft[], df: ReadonlyMap<string, number>, trigger: "repeat" | "use" = "repeat"): SaveMemoryInput {
  const key = draftEvidenceKey(rows);
  const first = rows[0];
  const candidateScope = first.situation.project ?? "all-projects";
  const scope = /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(candidateScope) && !candidateScope.includes("..") ? candidateScope : "all-projects";
  const rareWords = [...new Set(tokens(first.quote))].sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || a.localeCompare(b)).slice(0, 5);
  const literalCues: string[] = [];
  for (const row of rows) for (const command of [...row.situation.before, ...row.situation.after]) {
    const head = extractCommandHead(command);
    for (const lit of row.situation.lits.slice(0, 5)) if (head && !head.includes(lit)) literalCues.push(`${head} ${lit}`);
  }
  const recallWhen = [...new Set([...literalCues.slice(0, 8), ...rows.flatMap(row => row.context ? [row.context] : []), rareWords.join(" ")])].filter(Boolean);
  const evidence = evidenceOf(rows);
  const body = [
    trigger === "use" ? "User quote from an earlier session; derived from successful use in another session. Verify before relying on it."
      : "User quotes from separate sessions; derived from repetition. Verify before relying on them.",
    ...rows.map(row => ["", `Quote (${row.kind}):`, row.quote, ...(row.context ? ["Context:", row.context] : []),
      "Situation:", ...[row.situation.project, row.situation.cwd, row.situation.branch].filter(Boolean),
      ...row.situation.before.map(command => `Before: ${command}`), ...row.situation.after.map(command => `After: ${command}`),
      ...row.situation.reads.map(path => `Read: ${path}`)].join("\n")),
    "", "Evidence:", ...evidence.map(e => `- session ${e.session_id}; turn ${e.turn}; ${new Date(e.ts).toISOString()}; client ${e.client ?? "unknown"}`),
    ...(trigger === "use" ? rows.flatMap(row => {
      const proof = draftUseProof(row);
      return proof?.used ? ["", "Use evidence:", `- session ${proof.session_id}; displayed ${new Date(proof.ts).toISOString()}; used ${new Date(proof.used.ts).toISOString()}; tool ${proof.used.tool}; exit 0; tokens ${proof.used.matched.join(", ")}`] : [];
    }) : []),
  ].join("\n");
  return {
    id: `draft-${key}`, title: first.quote.replace(/\s+/g, " ").slice(0, 100), summary: first.quote,
    body, type: "project-fact", scope, topic_path: [scope, "derived"], tags: ["derived"],
    recall_when: recallWhen.length ? recallWhen : [first.quote], sensitivity: "team", write_origin: "capture-review",
    source: `draft:${key}`, confidence: 0.6,
  };
}

async function writeEvent(event: DraftPromotionEvent): Promise<void> {
  if (envOff("BASTRA_TELEMETRY", "NEXUS_TELEMETRY")) return;
  const dir = logDirFor(); await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString();
  await appendFile(join(dir, `events-${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ...event, ts }) + "\n", "utf8");
}

/** Harvest-tick only. Draft lock covers the note commit and state transition. */
export async function runDraftPromote(opts: DraftPromoteOptions): Promise<DraftPromoteResult> {
  const result: DraftPromoteResult = { promoted: 0, wouldPromote: 0, duplicates: 0, blocked: 0, errors: 0 };
  const now = opts.now ?? Date.now();
  const events: DraftPromotionEvent[] = [];
  try {
    await opts.vault.reconcile();
    const vaultId = await draftVaultId(opts.vault.root);
    const localOpts = { provider: opts.provider, ollama: opts.ollama };
    const provider = localDraftProvider(localOpts);
    await transactDrafts(async allRows => {
      const rows = allRows.filter(row => row.state === "open");
      const vectors = await readDraftVectors(localOpts, rows);
      const df = new Map<string, number>();
      for (const row of rows) for (const word of new Set(tokens(row.quote))) df.set(word, (df.get(word) ?? 0) + 1);
      const rareEnough = (row: Draft) => [...new Set(tokens(row.quote))].filter(word => (df.get(word) ?? 0) <= DRAFT_RARE_TOKEN_MAX_ROWS).length >= DRAFT_RARE_TOKEN_MIN;
      const snapshot = opts.vaultVectors?.();
      const notes = opts.vault.list();
      const noteWords = new Map(notes.map(note => [note.fm.id, new Set(tokens([note.fm.title, note.fm.summary, ...(note.fm.recall_when ?? []), note.body].join("\n")))]));
      const noteDf = new Map<string, number>();
      for (const words of noteWords.values()) for (const word of words) noteDf.set(word, (noteDf.get(word) ?? 0) + 1);
      const idf = (word: string) => Math.log(1 + (notes.length + 1) / ((noteDf.get(word) ?? 0) + 1));
      const compatible = provider && snapshot?.provider === provider.id && snapshot.dim === provider.dim;
      const noteVectors = compatible ? new Map([...snapshot.vectors].map(([id, vector]) => [id, new Float32Array(vector)])) : null;
      let complete = compatible && notes.every(note => validVector(noteVectors?.get(note.fm.id), provider.dim));
      for (const row of rows) {
        if (row.state !== "open") continue;
        const use = draftUseProof(row);
        const pair = distinctSessions([row]) >= 2 ? [row] : rows.filter(other => {
          if (other.id === row.id || other.state !== "open" || other.evidence.some(e => row.evidence.some(a => a.session_id === e.session_id))) return false;
          if (row.fp === other.fp) return true;
          const a = vectors?.get(row.id), b = vectors?.get(other.id);
          return !!provider && validVector(a, provider.dim) && validVector(b, provider.dim) && cosine(a, b) >= DRAFT_REPEAT_COSINE_MIN;
        }).slice(0, 1).map(other => other);
        const evidenceRows = use ? [row] : pair.length === 1 && pair[0] === row ? [row] : pair.length ? [row, pair[0]] : [];
        if (!evidenceRows.length || !use && !evidenceRows.every(rareEnough)) continue;
        const input = buildDraftNote(evidenceRows, df, use ? "use" : "repeat");
        // Redact the complete outgoing note, not only its first quote.
        for (const field of ["title", "summary", "body"] as const) input[field] = redactSecrets(input[field], homedir()).text;
        input.recall_when = input.recall_when.map(cue => redactSecrets(cue, homedir()).text);
        const eventBase = { draft_ids: evidenceRows.map(d => d.id), evidence_count: evidenceOf(evidenceRows).length };
        if (scanForInjection([input.title, input.summary, input.body, ...input.recall_when].join("\n")).length) {
          result.blocked++; events.push({ kind: "draft_promote_blocked", ...eventBase, reason: "injection-scan" }); continue;
        }
        // A landed note followed by a failed store write is a recoverable commit.
        const existing = opts.vault.get(input.id!);
        if (existing && existing.fm.source === input.source && existing.fm.write_origin === "capture-review") {
          closeRows(evidenceRows, "promoted", existing.fm.id, draftEvidenceKey(evidenceRows), now); continue;
        }
        const words = new Set(tokens(input.summary));
        let duplicate: { id: string; containment: number; cosine?: number } | undefined;
        for (const note of notes) {
          const containment = weightedContainment(words, noteWords.get(note.fm.id)!, idf);
          let semantic: number | undefined;
          if (complete && provider) {
            for (const evidenceRow of evidenceRows) {
              const vector = vectors?.get(evidenceRow.id);
              if (validVector(vector, provider.dim)) semantic = Math.max(semantic ?? -1, cosine(vector, noteVectors!.get(note.fm.id)!));
            }
          }
          if (containment >= STORED_CONTAINMENT_MIN || semantic !== undefined && semantic >= DRAFT_VAULT_COSINE_MIN) {
            duplicate = { id: note.fm.id, containment, cosine: semantic }; break;
          }
        }
        if (duplicate) {
          closeRows(evidenceRows, "rejected", duplicate.id, undefined, now);
          result.duplicates++; events.push({ kind: "draft_duplicate_blocked", ...eventBase, containment: duplicate.containment, ...(duplicate.cosine === undefined ? {} : { cosine: duplicate.cosine }) });
          continue;
        }
        // Assumptions, not confirmed by the owner: opt-in sharp mode and fail
        // closed if provenance or a complete same-model local comparison is absent.
        const reason = evidenceRows.some(d => d.vault_id !== vaultId) ? "vault-provenance-unconfirmed"
          : !provider ? "no-local-provider" : !compatible ? "vault-vector-model-mismatch"
          : !complete ? "vault-vectors-incomplete"
          : evidenceRows.some(d => !validVector(vectors?.get(d.id), provider.dim)) ? "draft-vectors-missing"
          : process.env.BASTRA_DRAFT_PROMOTE !== "1" ? "dry-run" : null;
        if (reason) { result.wouldPromote++; events.push({ kind: "draft_would_promote", ...eventBase, reason }); continue; }
        const saved = await saveMemoryWithAuditTrail({ vaultRoot: opts.vault.root, input, actor: "system", actorDetail: use ? "draft:use-promotion" : "draft:repeat-promotion", sessionId: evidenceRows[0].evidence[0].session_id });
        await opts.vault.reindexFile(saved.file_path);
        closeRows(evidenceRows, "promoted", saved.id, draftEvidenceKey(evidenceRows), now);
        // Subsequent candidates in this tick see the newly written note. Missing
        // vectors leave them in dry-run rather than permit an unchecked second save.
        const note = opts.vault.get(saved.id);
        if (note) { notes.push(note); noteWords.set(saved.id, new Set(tokens(input.title + "\n" + input.summary + "\n" + input.body))); }
        complete = false;
        result.promoted++; events.push({ kind: "draft_promoted", ...eventBase });
        await setImmediate();
      }
    }, now);
  } catch { result.errors++; }
  for (const event of events) {
    try { if (opts.emit) opts.emit(event); else await writeEvent(event); } catch { result.errors++; }
  }
  return result;
}

/** Undo only notes created by this promotion, never a duplicate's existing note. */
export async function undoDraftPromotion(vault: Vault, id: string, now = Date.now()): Promise<string> {
  const vaultId = await draftVaultId(vault.root);
  await vault.reconcile();
  return transactDrafts(async rows => {
    const row = rows.find(row => row.id === id || row.memory_id === id && row.state === "promoted");
    if (!row || row.state !== "promoted" || !row.memory_id || !row.evidence_key) throw new Error("draft is not a promoted note");
    if (row.vault_id !== vaultId) throw new Error("draft belongs to a different or unconfirmed vault");
    const note = vault.get(row.memory_id);
    if (note) {
      if (note.fm.source !== `draft:${row.evidence_key}` || note.fm.write_origin !== "capture-review") throw new Error("note no longer matches draft provenance");
      await deleteMemoryFile(note.filePath, note.fm.id, { vaultRoot: vault.root });
      vault.forgetFile(note.filePath);
      await recordAudit({ vaultRoot: vault.root, memoryId: note.fm.id, operation: "delete", actor: "user", actorDetail: "cli:drafts-undo", diffBefore: note.fm as unknown as Record<string, unknown>, diffAfter: null, filePath: note.filePath });
    }
    const affected = rows.filter(other => other.state === "promoted" && other.memory_id === row.memory_id);
    closeRows(affected, "rejected", row.memory_id, row.evidence_key, now);
    return row.memory_id;
  }, now);
}
