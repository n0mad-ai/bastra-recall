/** Local-only promotion. Lifecycle changes require sharp mode; dry runs can attach review metadata. */
import { createHash } from "node:crypto";
import { appendFile, mkdir, realpath, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { cosine, deleteMemoryFile, type SaveMemoryInput, type Vault } from "@bastra-recall/core";
import { redactSecrets } from "@bastra-recall/core/scrub";
import { scanForInjection } from "@bastra-recall/core";
import { localDraftProvider, readDraftVectorState, type DraftShadowOptions } from "./draft-shadow.js";
import { listDrafts, transactDrafts, withDraftPublication, type Draft } from "./draft-store.js";
import { draftUseProof, DRAFT_USE_MIN_WORD_TOKENS, DRAFT_USE_LITERAL_MIN_CHARS } from "./draft-use.js";
import { tokens } from "./save-similarity.js";
import { weightedContainment, STORED_CONTAINMENT_MIN } from "./harvest-vault-match.js";
import { saveMemoryWithAuditTrail, recordAudit } from "./audit-trail.js";
import { logDirFor } from "./telemetry.js";
import { envOff } from "./env.js";
import { ACTED_ON_WINDOW_MS } from "./telemetry-join-state.js";
import { readDraftDecisions, recordDraftDecisions } from "./draft-decisions.js";
import { writeDraftEvent } from "./draft-events.js";
import type { TrainingItem, TrainingVerdict } from "./training-capture.js"; // #1128-capture
import { evalRunMark } from "./training-signal.js"; // #1128-capture
import { recordDraftReviewCandidates } from "./draft-review.js";
import { noteJudgeText, parseVerdict, relationPrompt, statementPrompt, DRAFT_JUDGE_RETRY_MS, RELATIONS, STATEMENT_KINDS, type DraftJudge, type Relation, type StatementKind } from "./draft-judge.js";

/** Unmeasured on real data, unchanged after review. */
export const DRAFT_REPEAT_COSINE_MIN = 0.70;
export const DRAFT_VAULT_COSINE_MIN = 0.60;
export const DRAFT_RARE_TOKEN_MAX_ROWS = 2;
export const DRAFT_RARE_TOKEN_MIN = 4;
export const DRAFT_CUE_MIN_CHARS = 4;
export const DRAFT_PROMOTION_RULE_VERSION = 4;
const YIELD_EVERY = 32;
export interface DraftPromotionEvent {
  kind: "draft_would_promote" | "draft_would_block" | "draft_promoted" | "draft_duplicate_blocked" | "draft_promote_blocked";
  draft_ids: string[]; evidence_count: number; reason?: string; cosine?: number; containment?: number;
  /** Meaning check: classes and ids only, never text. "none" = no verdict. */
  judge_statement?: StatementKind | "none"; judge_repeat?: Relation | "none"; judge_note?: Relation | "none";
  judge_model?: string; judge_ms?: number; note_id?: string;
}
export interface DraftPromoteOptions extends Omit<DraftShadowOptions, "emit"> {
  vault: Vault; emit?: (event: DraftPromotionEvent) => void;
  /** Background tick may fall back after the actual local embedding pass failed. */
  allowSharp?: boolean;
  /** Loopback chat model for the meaning check. Absent = no verdict, nothing is promoted or closed. */
  judge?: DraftJudge | null;
  /** #1128-capture: each verdict this pass reached, with the texts it read. Observed only; nothing here reads it back. */
  onVerdict?: (verdict: TrainingVerdict) => void;
}
export interface DraftPromoteResult { promoted: number; wouldPromote: number; duplicates: number; blocked: number; errors: number; probeOnly?: boolean;
  /** Candidates the meaning check could not judge in this pass. */
  unjudged: number }
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export async function draftVaultId(root: string): Promise<string> { return hash(await realpath(root)); }
function evidenceOf(rows: Draft[]): Draft["evidence"] {
  return [...new Map(rows.flatMap(row => row.evidence).map(e => [`${e.session_id}:${e.turn}`, e])).values()]
    .sort((a, b) => a.session_id.localeCompare(b.session_id) || a.turn - b.turn);
}
export function draftEvidenceKey(rows: Draft[]): string { return hash(evidenceOf(rows).map(e => `${e.session_id}:${e.turn}`).join("\n")).slice(0, 12); }
function validVector(v: Float32Array | undefined, dim: number): v is Float32Array {
  return !!v && v.length === dim && v.every(Number.isFinite) && v.some(x => x !== 0);
}
function noteText(note: ReturnType<Vault["list"]>[number]): string {
  return [note.fm.title, note.fm.summary, ...(note.fm.recall_when ?? []), note.body.slice(0, 4000)].join("\n");
}
/** Language-neutral technical literals; sentence punctuation is not an identifier. */
export function draftLiterals(quote: string): Set<string> {
  return new Set((quote.toLowerCase().match(/[\p{L}\p{N}/@:_][\p{L}\p{N}._@\/:-]*/gu) ?? [])
    .map(t => t.replace(/[.:]+$/u, "")).filter(t => /[\p{N}/@:_]/u.test(t) || /[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(t)));
}
function conflictingLiterals(a: string, b: string): boolean {
  const left = draftLiterals(a), right = draftLiterals(b);
  return left.size !== right.size || [...left].some(t => !right.has(t));
}
function closeRows(rows: Draft[], state: "promoted" | "rejected", id: string, key: string | undefined, now: number, sha?: string): void {
  for (const row of rows) {
    row.state = state; row.memory_id = id; row.last_touched = now;
    if (key) { row.evidence_key = key; row.announce = state === "promoted"; }
    if (sha) row.promoted_hash = sha;
  }
}
function commandHead(command: string): string {
  const words = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const program = words.find(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  return program ? basename(program.replace(/^['"]|['"]$/g, "")) : "";
}

export function buildDraftNote(rows: Draft[], df: ReadonlyMap<string, number>, trigger: "repeat" | "use" = "repeat"): SaveMemoryInput {
  const key = draftEvidenceKey(rows), first = rows[0];
  const scopeName = first.situation.project ?? "all-projects";
  const scope = /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(scopeName) && !scopeName.includes("..") ? scopeName : "all-projects";
  const rareWords = [...new Set(tokens(first.quote.replace(/\S*\[REDACTED(?:[^\]]*)\]\S*/gi, " ")))]
    .filter(word => [...word].length >= DRAFT_CUE_MIN_CHARS && !/^\p{N}+$/u.test(word) && (df.get(word) ?? 0) <= DRAFT_RARE_TOKEN_MAX_ROWS).sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || [...b].length - [...a].length || a.localeCompare(b)).slice(0, 5);
  const literalCues: string[] = [];
  for (const row of rows) for (const command of [...row.situation.before, ...row.situation.after]) {
    const head = commandHead(command);
    const literals = row.situation.lits.map(lit => lit.replace(/^.*@/, ""))
      .filter(lit => lit !== head && command.toLowerCase().includes(lit.toLowerCase()) && [...new Set(tokens(lit))].some(word => (df.get(word) ?? 0) <= DRAFT_RARE_TOKEN_MAX_ROWS))
      .sort((a, b) => Math.min(...tokens(a).map(t => df.get(t) ?? 0)) - Math.min(...tokens(b).map(t => df.get(t) ?? 0)) || b.length - a.length);
    if (head && literals[0]) literalCues.push(`${head} ${literals[0]}`);
  }
  const cues = [...new Set([...literalCues.slice(0, 8), ...rows.flatMap(row => row.context ? [row.context] : []), rareWords.join(" ")])].filter(Boolean);
  const body = [trigger === "use" ? "User quote from an earlier session; derived from successful use in another session. Verify before relying on it." : "User quotes from separate sessions; derived from repetition. Verify before relying on them.",
    ...rows.map(row => ["", `Quote (${row.kind}):`, row.quote, ...(row.context ? ["Context:", row.context] : []), "Situation:",
      ...[row.situation.project, row.situation.cwd, row.situation.branch].filter(Boolean),
      ...row.situation.before.map(c => `Before: ${c}`), ...row.situation.after.map(c => `After: ${c}`), ...row.situation.reads.map(p => `Read: ${p}`)].join("\n")),
    "", "Evidence:", ...evidenceOf(rows).map(e => `- session ${e.session_id}; turn ${e.turn}; ${new Date(e.ts).toISOString()}; client ${e.client ?? "unknown"}`),
    ...(trigger === "use" ? rows.flatMap(row => { const proof = draftUseProof(row); return proof?.used ? ["", "Use evidence:", `- session ${proof.session_id}; displayed ${new Date(proof.ts).toISOString()}; used ${new Date(proof.used.ts).toISOString()}; tool ${proof.used.tool}; exit 0; tokens ${proof.used.matched.join(", ")}`] : []; }) : []),
  ].join("\n");
  return { id: `draft-${key}`, title: first.quote.replace(/\s+/g, " ").slice(0, 100), summary: first.quote, body,
    type: "project-fact", scope, topic_path: [scope, "derived"], tags: ["derived"], recall_when: cues,
    sensitivity: "team", write_origin: "capture-review", source: `draft:${key}`, confidence: 0.6 };
}

async function writeEvent(event: DraftPromotionEvent): Promise<void> {
  if (envOff("BASTRA_TELEMETRY", "NEXUS_TELEMETRY")) return;
  const dir = logDirFor(); await mkdir(dir, { recursive: true }); const ts = new Date().toISOString();
  await appendFile(join(dir, `events-${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ...event, ts, ...evalRunMark() }) + "\n", "utf8");
}
const PASS_KEY = hash("draft-promotion-pass:repeat-use:v4");
function passSignature(opts: DraftPromoteOptions, rows: Draft[], notes: ReturnType<Vault["list"]>, vectors: ReadonlyMap<string,Float32Array> | null, snapshot: ReturnType<NonNullable<DraftPromoteOptions["vaultVectors"]>> | undefined, sharp: boolean, vaultId: string): string {
  const state = createHash("sha256").update(JSON.stringify({ reviewMetadata: 2, rules: [DRAFT_PROMOTION_RULE_VERSION,DRAFT_REPEAT_COSINE_MIN,DRAFT_VAULT_COSINE_MIN,DRAFT_RARE_TOKEN_MAX_ROWS,DRAFT_RARE_TOKEN_MIN,DRAFT_CUE_MIN_CHARS,STORED_CONTAINMENT_MIN,DRAFT_USE_MIN_WORD_TOKENS,DRAFT_USE_LITERAL_MIN_CHARS,ACTED_ON_WINDOW_MS], vaultId, sharp, allowSharp: opts.allowSharp, provider: opts.provider?.id, dim: opts.provider?.dim, ollama: opts.ollama ? [opts.ollama.baseURL, opts.ollama.model] : null, judge: opts.judge?.model ?? null,
    rows: rows.map(({ last_touched: _touched, created: _created, review_candidate: _candidate, review_shown_vaults: _shown, agent_review: _review, ...row }) => row), notes: notes.map(note => [note.fm.id, note.fm.title, note.fm.summary, note.fm.recall_when, note.fm.source, note.fm.write_origin, note.body.slice(0,4000)]),
    snapshotProvider: snapshot?.provider, snapshotDim: snapshot?.dim }));
  for (const [id,vector] of vectors ?? []) state.update(id).update(Buffer.from(vector.buffer,vector.byteOffset,vector.byteLength));
  for (const [id,vector] of snapshot?.vectors ?? []) state.update(id).update(Buffer.from(vector.buffer,vector.byteOffset,vector.byteLength));
  return state.digest("hex");
}

/** Match the original persisted evidence receipt, so a later appended session
 * does not change a landed note's identity after a state-write interruption. */
function recoveryReceipts(vault: Vault): Map<string, { id: string; key: string }> {
  const found = new Map<string, { id: string; key: string }>();
  for (const note of vault.list()) {
    if (note.fm.write_origin !== "capture-review" || !note.fm.id.startsWith("draft-") || !note.fm.source?.startsWith("draft:")) continue;
    const tail = note.body.slice(note.body.lastIndexOf("\nEvidence:\n"));
    const evidence = [...tail.matchAll(/^- session ([^;\r\n]+); turn (\d+);/gm)].map(m => `${m[1]}:${Number(m[2])}`);
    const key = hash([...new Set(evidence)].sort((a, b) => {
      const [as, at] = a.split(/:(?=[^:]+$)/), [bs, bt] = b.split(/:(?=[^:]+$)/);
      return as.localeCompare(bs) || Number(at) - Number(bt);
    }).join("\n")).slice(0, 12);
    if (!evidence.length || note.fm.source !== `draft:${key}` || note.fm.id !== `draft-${key}`) continue;
    for (const e of evidence) found.set(e, { id: note.fm.id, key });
  }
  return found;
}

export async function draftPromotionReady(opts: DraftPromoteOptions): Promise<boolean> {
  if (process.env.BASTRA_DRAFT_PROMOTE !== "1" || opts.allowSharp === false) return false;
  const provider = localDraftProvider({ provider: opts.provider, ollama: opts.ollama });
  const snapshot = opts.vaultVectors?.();
  if (!provider || snapshot?.provider !== provider.id || snapshot.dim !== provider.dim) return false;
  let n = 0;
  for (const note of opts.vault.list()) {
    if (!validVector(snapshot.vectors.get(note.fm.id), provider.dim)) return false;
    if (++n % YIELD_EVERY === 0) await setImmediate();
  }
  return true;
}

/** Pair math/vocabulary/duplicates are outside the lock and yield to hooks.
 * Under the short commit lock, identity, provenance and state are rechecked. */
export async function runDraftPromote(opts: DraftPromoteOptions): Promise<DraftPromoteResult> {
  const result: DraftPromoteResult = { promoted: 0, wouldPromote: 0, duplicates: 0, blocked: 0, errors: 0, unjudged: 0 };
  const now = opts.now ?? Date.now();
  let decisions = new Map<string,string>();
  let reviewVaultId: string | undefined;
  let reviewPassCompleted = false;
  const reviewCandidates = new Map<string, DraftPromotionEvent>();
  const changes = new Map<string,string>(), events = new Map<string,DraftPromotionEvent>();
  try {
    await opts.vault.reconcile();
    const vaultId = await draftVaultId(opts.vault.root), all = await listDrafts(now);
    reviewVaultId = vaultId;
    const localOpts = { provider: opts.provider, ollama: opts.ollama }, provider = localDraftProvider(localOpts);
    const vectorState = await readDraftVectorState(localOpts, all);
    const vectors = vectorState.vectors;
    decisions = await readDraftDecisions(vectorState.decisions);
    const sharp = await draftPromotionReady(opts); result.probeOnly = !sharp;
    const snapshot = opts.vaultVectors?.();
    const notes = opts.vault.list();
    const signature = passSignature(opts, all, notes, vectors, snapshot, sharp, vaultId);
    // A pass that left candidates unjudged is repeated once per retry window.
    const retrySignature = hash(`${signature}:unjudged:${Math.floor(now / DRAFT_JUDGE_RETRY_MS)}`);
    if ([signature, retrySignature].includes(decisions.get(PASS_KEY)!)) return result;
    const emitOnce = async (rows: Draft[], { judge_ms, ...stable }: DraftPromotionEvent): Promise<void> => {
      const event = judge_ms === undefined ? stable : { ...stable, judge_ms };
      if (event.kind === "draft_would_promote" || event.kind === "draft_would_block") for (const row of rows) reviewCandidates.set(row.id, event);
      const key = hash([...event.draft_ids].sort().join("\n"));
      const value = hash(JSON.stringify({ event: stable, evidence: draftEvidenceKey(rows), provider: opts.provider?.id, dim: opts.provider?.dim, state: rows.map(row => [row.state,row.vault_id]) }));
      if (decisions.get(key) === value) return;
      changes.set(key,value); events.set(key,event);
    };
    const judge = opts.judge ?? null;
    // A verdict is kept as a hash beside the pass receipts: the same texts and
    // model are never asked twice, and a failed call waits for the next window.
    // An unreachable model ends the asking for this pass: one timeout, not one per candidate.
    let offline = false;
    const ask = async <T extends string>(prompt: string, allowed: readonly T[], spent: { ms?: number }): Promise<T | "none"> => {
      const key = hash(`draft-judge:${judge?.model}:${prompt}`), stored = changes.get(key) ?? decisions.get(key);
      const known = allowed.find(value => stored === hash(`${key}:${value}`));
      if (known) return known;
      const retry = hash(`${key}:none:${Math.floor(now / DRAFT_JUDGE_RETRY_MS)}`);
      if (!judge || offline || stored === retry) return "none";
      const started = Date.now(); let verdict: T | null = null;
      try { verdict = parseVerdict(await judge.chat(prompt), allowed); } catch { offline = true; }
      spent.ms = (spent.ms ?? 0) + Date.now() - started;
      changes.set(key, verdict ? hash(`${key}:${verdict}`) : retry);
      return verdict ?? "none";
    };
    // #1128-capture: report a verdict to the opt-in label store; "none" is no verdict.
    const learned = (item: TrainingItem, verdict: string): void => { if (judge && verdict !== "none") opts.onVerdict?.({ item, verdict, model: judge.model }); };
    const statementItem = (draft: Draft): TrainingItem => ({ type: "statement", quote: draft.quote, draft_kind: draft.kind, ...(draft.context ? { context: draft.context } : {}) });
    const compatible = provider && snapshot?.provider === provider.id && snapshot.dim === provider.dim;
    const noteVectors = compatible ? new Map([...snapshot.vectors].map(([id, v]) => [id, new Float32Array(v)])) : null;
    const noteWords = new Map<string, Set<string>>(), df = new Map<string, number>();
    let comparisons = 0, comparisonComplete = !!compatible;
    for (const note of notes) {
      if (!provider || !validVector(noteVectors?.get(note.fm.id), provider.dim)) comparisonComplete = false;
      const words = new Set(tokens(noteText(note))); noteWords.set(note.fm.id, words);
      for (const word of words) df.set(word, (df.get(word) ?? 0) + 1);
      if (++comparisons % YIELD_EVERY === 0) await setImmediate();
    }
    for (const row of all) for (const word of new Set(tokens(row.quote))) df.set(word, (df.get(word) ?? 0) + 1);
    const idf = (word: string) => Math.log(1 + (notes.length + all.length + 1) / ((df.get(word) ?? 0) + 1));
    const rareEnough = (row: Draft) => [...new Set(tokens(row.quote))].filter(word => (df.get(word) ?? 0) <= DRAFT_RARE_TOKEN_MAX_ROWS).length >= DRAFT_RARE_TOKEN_MIN;
    const receipts = recoveryReceipts(opts.vault), handled = new Set<string>();
    for (const row of all) {
      if (row.state !== "open") continue;
      const recovery = row.evidence.map(e => receipts.get(`${e.session_id}:${e.turn}`)).find(Boolean);
      if (recovery) {
        const base = { draft_ids: [row.id], evidence_count: row.evidence.length, reason: "committed-note-recovery" };
        if (!sharp || row.vault_id !== vaultId) { result.wouldPromote++; await emitOnce([row], { kind: "draft_would_promote", ...base }); continue; }
        await transactDrafts(async current => {
          const latest = current.find(d => d.id === row.id && d.state === "open" && d.vault_id === vaultId);
          if (latest) closeRows([latest], "promoted", recovery.id, recovery.key, now);
        }, now);
        closeRows([row], "promoted", recovery.id, recovery.key, now);
        await emitOnce([row], { kind: "draft_promoted", ...base });
        continue;
      }
      const use = draftUseProof(row);
      let selected: Draft[] = use ? [row] : new Set(row.evidence.map(e => e.session_id)).size >= 2 ? [row] : [];
      if (!selected.length) for (const other of all) {
        if (++comparisons % YIELD_EVERY === 0) await setImmediate();
        if (other.id === row.id || other.state !== "open" || other.evidence.some(e => row.evidence.some(a => a.session_id === e.session_id)) || conflictingLiterals(row.quote, other.quote)) continue;
        const a = vectors?.get(row.id), b = vectors?.get(other.id);
        if (row.fp === other.fp || provider && validVector(a, provider.dim) && validVector(b, provider.dim) && cosine(a, b) >= DRAFT_REPEAT_COSINE_MIN) { selected = [row, other]; break; }
        if (++comparisons % YIELD_EVERY === 0) await setImmediate();
      }
      if (!selected.length) continue;
      const candidate = [...selected.map(d => d.id)].sort().join("\n"); if (handled.has(candidate)) continue; handled.add(candidate);
      const base = { draft_ids: selected.map(d => d.id), evidence_count: evidenceOf(selected).length };
      const gateReason = selected.some(d => d.vault_id !== vaultId) ? "vault-provenance-unconfirmed" : !provider ? "no-local-provider"
        : !compatible ? "vault-vector-model-mismatch" : !comparisonComplete ? "vault-vectors-incomplete" : selected.some(d => !validVector(vectors?.get(d.id), provider.dim)) ? "draft-vectors-missing"
        : opts.allowSharp === false ? "meaning-comparison-unavailable" : !sharp ? "dry-run" : null;
      // The strongest hit, not the first: the meaning check reads exactly one.
      let duplicate: { id: string; text: string; note?: boolean; cosine?: number; containment?: number } | undefined, best = 0;
      // Pure quote vectors survive closed draft state for the complete tombstone lifetime.
      if (provider) for (const closed of all) {
        if (closed.state === "open" || !closed.memory_id) continue;
        const b = vectors?.get(closed.id);
        for (const source of selected) {
          const a = vectors?.get(source.id);
          if (validVector(a, provider.dim) && validVector(b, provider.dim)) {
            const value = cosine(a, b); if (value >= DRAFT_VAULT_COSINE_MIN && value > best) { best = value; duplicate = { id: closed.memory_id, text: closed.quote, cosine: value }; }
          }
        }
        if (++comparisons % YIELD_EVERY === 0) await setImmediate();
      }
      if (!duplicate) for (const note of notes) {
        const containment = weightedContainment(new Set(tokens(row.quote)), noteWords.get(note.fm.id)!, idf);
        let semantic: number | undefined;
        if (provider && validVector(noteVectors?.get(note.fm.id), provider.dim)) for (const source of selected) {
          const v = vectors?.get(source.id); if (validVector(v, provider.dim)) semantic = Math.max(semantic ?? -1, cosine(v, noteVectors!.get(note.fm.id)!));
        }
        const score = Math.max(containment >= STORED_CONTAINMENT_MIN ? 1 + containment : 0, semantic !== undefined && semantic >= DRAFT_VAULT_COSINE_MIN ? semantic : 0);
        if (score > best) { best = score; duplicate = { id: note.fm.id, text: noteJudgeText(note), note: true, containment, cosine: semantic }; }
        if (++comparisons % YIELD_EVERY === 0) await setImmediate();
      }
      // The model is asked only when the pass could write or is the plain dry
      // run, after the cheap gates, outside every lock; at most four calls.
      const judging = !gateReason || gateReason === "dry-run", spent: { ms?: number } = {};
      const judged: Pick<DraftPromotionEvent, "judge_statement" | "judge_repeat" | "judge_note"> = {};
      const verdicts = () => judging ? { ...judged, ...(judge ? { judge_model: judge.model } : {}), ...(spent.ms === undefined ? {} : { judge_ms: spent.ms }) } : {};
      const statement = async () => {
        if (judged.judge_statement === undefined) { judged.judge_statement = await ask(statementPrompt(row.quote), STATEMENT_KINDS, spent); learned(statementItem(row), judged.judge_statement); } // #1128-capture
        return judged.judge_statement;
      };
      const hold = async (reason: string, noteId?: string): Promise<void> => {
        result.blocked++; if (reason === "meaning-check-unavailable") result.unjudged++;
        await emitOnce(selected, { kind: "draft_would_block", ...base, reason, ...verdicts(), ...(noteId ? { note_id: noteId } : {}) });
      };
      if (duplicate && judging) {
        judged.judge_note = await ask(relationPrompt(row.quote, duplicate.text, "note"), RELATIONS, spent);
        // #1128-capture: a private note's text never reaches the label store.
        if (!duplicate.note || (opts.vault.get(duplicate.id)?.fm.sensitivity ?? "private") !== "private") learned({ type: "relation", a: row.quote, b: duplicate.text, b_is: "note", source: "promotion",
          ...(duplicate.note ? { note_id: duplicate.id } : {}), ...(duplicate.cosine === undefined ? {} : { cosine: duplicate.cosine }), ...(duplicate.containment === undefined ? {} : { containment: duplicate.containment }) }, judged.judge_note);
        if (judged.judge_note === "none") { await hold("meaning-check-unavailable"); continue; }
        if (judged.judge_note === "contradiction") {
          // Left open for a later suggestion; a private note's id stays out of telemetry.
          const kind = await statement(), note = opts.vault.get(duplicate.id);
          await hold(kind === "none" ? "meaning-check-unavailable" : kind !== "durable" ? "not-durable-statement" : "contradicts-existing-note",
            kind === "durable" && note && note.fm.sensitivity !== "private" ? note.fm.id : undefined);
          continue;
        }
        if (judged.judge_note === "different") duplicate = undefined;
        // The verdict is about the text that was read. A note rewritten while
        // the model answered gets no closing from it; the next pass asks again.
        else if (duplicate.note) {
          const current = opts.vault.get(duplicate.id);
          if (!current || noteJudgeText(current) !== duplicate.text) { await hold("meaning-check-unavailable"); continue; }
        }
      }
      if (duplicate) {
        if (!gateReason) {
          await transactDrafts(async current => {
            const latest = selected.map(d => current.find(c => c.id === d.id && c.fp === d.fp && c.state === "open" && c.vault_id === vaultId));
            if (latest.every(Boolean)) closeRows(latest as Draft[], "rejected", duplicate!.id, undefined, now);
          }, now);
          closeRows(selected, "rejected", duplicate.id, undefined, now);
        }
        result.duplicates++;
        await emitOnce(selected, { kind: gateReason ? "draft_would_block" : "draft_duplicate_blocked", ...base, reason: "existing-note-or-quote-tombstone", ...verdicts(),
          ...(duplicate.cosine === undefined ? {} : { cosine: duplicate.cosine }), ...(duplicate.containment === undefined ? {} : { containment: duplicate.containment }) });
        continue;
      }
      if (!selected.every(rareEnough)) { result.blocked++; await emitOnce(selected, { kind: "draft_would_block", ...base, reason: "routine-vocabulary" }); continue; }
      const input = buildDraftNote(selected, df, use ? "use" : "repeat");
      if (!input.recall_when.length) { result.blocked++; await emitOnce(selected, { kind: "draft_would_block", ...base, reason: "no-useful-cues" }); continue; }
      for (const field of ["title", "summary", "body"] as const) input[field] = redactSecrets(input[field], homedir()).text;
      input.recall_when = input.recall_when.map(c => redactSecrets(c, homedir()).text);
      if (scanForInjection([input.title, input.summary, input.body, ...input.recall_when].join("\n")).length) { result.blocked++; await emitOnce(selected, { kind: "draft_would_block", ...base, reason: "injection-scan" }); continue; }
      if (judging) {
        const kind = await statement();
        if (kind !== "durable") { await hold(kind === "none" ? "meaning-check-unavailable" : "not-durable-statement"); continue; }
        // One row seen in two sessions, or two rows with one fingerprint, is verbatim.
        if (new Set(selected.map(d => d.fp)).size > 1) {
          // Both quotes end up in the note, so the second one is classified too.
          const partner = await ask(statementPrompt(selected[1].quote), STATEMENT_KINDS, spent);
          learned(statementItem(selected[1]), partner); // #1128-capture
          if (partner !== "durable") { await hold(partner === "none" ? "meaning-check-unavailable" : "not-durable-statement"); continue; }
          judged.judge_repeat = await ask(relationPrompt(selected[0].quote, selected[1].quote), RELATIONS, spent);
          learned({ type: "relation", a: selected[0].quote, b: selected[1].quote, b_is: "statement", source: "promotion" }, judged.judge_repeat); // #1128-capture
          if (judged.judge_repeat !== "same") { await hold(judged.judge_repeat === "none" ? "meaning-check-unavailable" : "repeat-not-same-statement"); continue; }
        }
      }
      if (gateReason) { result.wouldPromote++; await emitOnce(selected, { kind: "draft_would_promote", ...base, reason: gateReason, ...verdicts() }); continue; }
      const committed = await withDraftPublication(async () => {
        const prepared = await transactDrafts(async current => {
        const latest = selected.map(d => current.find(c => c.id === d.id && c.state === "open" && c.fp === d.fp && c.vault_id === vaultId));
        if (!latest.every(Boolean) || draftEvidenceKey(latest as Draft[]) !== draftEvidenceKey(selected)) return null;
        // Other promotion passes are serialized here. Check their newly indexed
        // derived quote before writing; no long pair/vault math under this lock.
        const existing = opts.vault.list().find(note => note.fm.write_origin === "capture-review" && note.fm.summary === input.summary);
        if (existing) { closeRows(latest as Draft[], "rejected", existing.fm.id, undefined, now); return null; }
        for (const latestRow of latest as Draft[]) { latestRow.evidence_key = draftEvidenceKey(selected); latestRow.memory_id = input.id; }
        return true;
        }, now);
        if (!prepared) return null;
        const saved = await saveMemoryWithAuditTrail({ vaultRoot: opts.vault.root, input, actor: "system", actorDetail: use ? "draft:use-promotion" : "draft:repeat-promotion", sessionId: selected[0].evidence[0].session_id });
        const sha = hash(await readFile(saved.file_path)); await opts.vault.reindexFile(saved.file_path);
        await transactDrafts(async current => {
          const latest = selected.map(d => current.find(c => c.id === d.id && c.fp === d.fp && c.state === "open" && c.vault_id === vaultId));
          if (latest.every(Boolean)) closeRows(latest as Draft[], "promoted", saved.id, draftEvidenceKey(selected), now, sha);
        }, now);
        return { id: saved.id, sha };
      });
      if (committed) { closeRows(selected, "promoted", committed.id, draftEvidenceKey(selected), now, committed.sha); result.promoted++; await emitOnce(selected, { kind: "draft_promoted", ...base, ...verdicts() }); }
      await setImmediate();
    }
    reviewPassCompleted = true;
    changes.set(PASS_KEY, result.unjudged ? retrySignature : signature);
  } catch { result.errors++; result.probeOnly = true; }
  finally {
    if (reviewPassCompleted && reviewVaultId) await recordDraftReviewCandidates(reviewCandidates, reviewVaultId, now).catch(() => undefined);
    try {
      const accepted = await recordDraftDecisions(changes,decisions);
      for (const [key,event] of events) if (accepted.has(key)) { if (opts.emit) opts.emit(event); else await writeEvent(event); }
    } catch { result.errors++; result.probeOnly = true; }
  }
  return result;
}

/** A manual delete is authorized separately from automatic promotion. */
export async function undoDraftPromotion(vault: Vault, id: string, now = Date.now(), force = false): Promise<string> {
  const vaultId = await draftVaultId(vault.root); await vault.reconcile();
  const memoryId=await withDraftPublication(() => transactDrafts(async rows => {
    const row = rows.find(d => d.id === id || d.memory_id === id && d.state === "promoted");
    if (!row || row.state !== "promoted" || !row.memory_id || !row.evidence_key) throw new Error("draft is not a promoted note");
    if (row.vault_id !== vaultId) throw new Error("draft belongs to a different or unconfirmed vault");
    const note = vault.get(row.memory_id);
    if (note) {
      if (note.fm.source !== `draft:${row.evidence_key}` || note.fm.write_origin !== "capture-review") throw new Error("note no longer matches draft provenance");
      if (!force && !row.promoted_hash) throw new Error("promotion receipt missing; review the note and use --force to undo");
      try { await deleteMemoryFile(note.filePath, note.fm.id, { vaultRoot: vault.root, ...(force ? {} : { expectedSha256: row.promoted_hash }) }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "MEMORY_CONTENT_CHANGED") throw new Error("note changed since promotion");
        throw error;
      }
      vault.forgetFile(note.filePath);
      await recordAudit({ vaultRoot: vault.root, memoryId: note.fm.id, operation: "delete", actor: "user", actorDetail: "cli:drafts-undo", diffBefore: note.fm as unknown as Record<string, unknown>, diffAfter: null, filePath: note.filePath });
    }
    closeRows(rows.filter(d => d.state === "promoted" && d.memory_id === row.memory_id), "rejected", row.memory_id, row.evidence_key, now);
    return row.memory_id;
  }, now));
  void writeDraftEvent({kind:"draft_undone",count:1});
  return memoryId;
}
