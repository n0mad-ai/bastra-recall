/**
 * #1322: the session-state shapes — what a lane mutates (`SessionState`) and
 * what it may only read (`ReadonlySessionState`). Types only; the codec in
 * `codec.ts` is what turns them into the persisted JSON and back.
 */
import type { ActiveTask } from "../task-state.js";
import type { RepairWindows } from "../stop-repair-window.js";

export interface ShownEntry {
  count: number;
  at: number; // ms since epoch when last shown
}

/** #161: per hook-source empty-streak backoff state — see the backoff
 *  section in `backoff.ts`. */
export interface SourceBackoff {
  /** consecutive unconsumed emits (incremented at emit, reset on consumption) */
  streak: number;
  /** ms epoch of the last actual emit for this source */
  at: number;
  /** candidate ids of that emit — consumption anchors on these */
  ids: string[];
  /** would-be injections suppressed since the last emit */
  skipped: number;
}

/** #572: one dependent as the graph had it when the edit was made. */
export interface TouchedHit {
  file: string;
  location: string;
  via: string;
  relation: string;
}

/**
 * #572: one file this session set out to write, as the Write/Edit lane saw it.
 *
 * `hits` is the union, over every edit of the file, of the dependents the
 * graph held AT EDIT TIME — one per dependent file. `unplaced` is set once any
 * edit of it could not be looked at, and never cleared: one blind edit is not
 * outvoted by later sighted ones. `at` is the first booking, which is what the
 * Stop lane checks the file's mtime against — the lane fires BEFORE the tool
 * runs, so a booking is an attempt until the disk confirms it.
 */
export interface TouchedFile {
  at: number;
  /** The latest booking — a read only counts as "after the change" past this. */
  last: number;
  hits: TouchedHit[];
  unplaced: boolean;
  truncated: boolean;
}

/**
 * #572: the task-boundary block one Stop computed, waiting for the next prompt
 * of this session. `files` is what the block is about to cost the agent in
 * attention — the count #579 measures the delivery by, carried here because the
 * lane that hands the block over no longer has the note's own arithmetic.
 */
export interface ParkedBoundary {
  note: string;
  dedupeKey: string;
  builtFrom: number;
  files: number;
}

/** #572: what a lane took out of the slot, from inside its own mutation. */
export interface TakenBoundary {
  /** The block, or null when this session had already been told the same. */
  note: string | null;
  files: number;
}

export interface SessionState {
  shown: Record<string, ShownEntry>;
  /** #1391: ordinary GitHub note advice is once per session, not per context/actor. */
  githubAdvisory?: { delivered: true } | { token: string; deadline: number };
  /** Round rulebook self-report; parsed by rulebook-check.ts, independent of delivery cadence. */
  rulebookCheck?: string;
  /** #1376: bounded successful handler execution receipts, never source-text claims. */
  executedVaultWrites?: string;
  draftShown?: string[];
  /** #161: keyed by hook source ("write-edit", "bash-tripwire", …) */
  sources?: Record<string, SourceBackoff>;
  /**
   * #572: what the session wrote, repository root -> repo-relative file. The
   * accumulator the Stop lane reads for the task-boundary impact — the union
   * the per-edit block can never produce, because it dedupes by design.
   */
  touched?: Map<string, Map<string, TouchedFile>>;
  /**
   * #572: the task-boundary block the Stop lane computed, waiting for this
   * session's next prompt. One slot, overwritten by each Stop: a later
   * boundary covers everything an earlier one did, because `touched` only
   * grows.
   */
  boundary?: ParkedBoundary;
  /** #572: characters the accumulator holds, against `MAX_TOUCHED_CHARS`. */
  touchedChars?: number;
  /**
   * #572: the accumulator hit a bound (files or characters) and stopped recording. From
   * then on the table is a prefix of the task, and the Stop lane stays silent
   * rather than answer from a prefix.
   */
  touchedOverflow?: boolean;
  /**
   * #662: save-eval heuristics the Stop lane already handed to this session's
   * running turn. Each is delivered once per session: the detection windows
   * re-fire on every Stop, and every delivery extends the turn.
   */
  saveEvalDelivered?: string[];
  /**
   * #509: the session-start constants (taxonomy, doku, language) this session's
   * CURRENT context already carries, part -> content hash. The #462 cadence
   * "on change only" reads it; `clearShown` empties it with the counters,
   * because compact and clear drop that text from the context as well.
   */
  constants?: Record<string, string>;
  /**
   * #1303: must-load ids the prompt or session lane put in front of the agent,
   * waiting for the gate lane. The first gated tool call claims every entry
   * (one deny per hint block); `load_memory(id)` removes the id from every
   * session (#1301). `block` names the hint block the id was shown in.
   */
  pendingMustLoad?: PendingMustLoad[];
  /** #1303: reflex memories the gate already denied once in this session. */
  deniedReflex?: string[];
  /** #1303: tool calls the gate lane has seen in this session. #1305: since
   *  the last user prompt — the prompt lane resets it, and the gate lane
   *  resets it when it re-delivers the rule kernel. */
  toolCalls?: number;
  /** #1305: must-load ids the gate denied a call for, waiting for the load
   *  that answers them. A load moves the id into `activeConventions`. */
  claimedMustLoad?: string[];
  /**
   * #1305: the conventions the session is working under, kept across
   * compact/clear so the rule kernel can put them first. For now filled from
   * loads that answer a gate must-load and from the gate's reflex deliveries.
   * #1306: and from the prompt lane when a correspondence task starts.
   */
  activeConventions?: ActiveConvention[];
  /** Full-body loads attributed to this exact caller session; claims/hints never fill this. */
  loadedConventions?: Array<{ id: string; revision: string | null; loadedAt: number; validator?: ConventionValidator }>;
  /** Only the user-turn candidate path may select this correspondence channel. */
  userValidatorChannel?: string;
  /** #1306: the correspondence task the session is in (prompt-classify.ts). */
  activeTask?: ActiveTask;
  /** #1306: pending correspondence context; only the next prompt of
   *  the same generation may use it. Every prompt clears it. */
  correspondenceContext?: CorrespondenceContext;
  /** #1310: successful `validate_artifact` receipts of the running task
   *  (receipt-store.ts). Only hashes and parameters, never artifact text. */
  receipts?: ArtifactReceipt[];
  /** #1311: Stop-lane repair requests for the running task (stop-repair.ts).
   *  Counted per task and generation, not per artifact hash, so an edit does
   *  not reset the cap; it expires with the task like `receipts`. */
  repairAttempts?: RepairAttempts;
  /** Last transcript position observed when requesting repair, per actor/scope.
   * Only digests are retained; old offending text must not defeat a correction. */
  repairWindows?: RepairWindows;
}

/** #1311: how often the Stop lane asked task `taskId` in `generation` for a receipt. */
export interface RepairAttempts {
  taskId: string;
  generation: number;
  count: number;
}

/** #1310: one successful validation, bound to the task and generation it ran in. */
export interface ArtifactReceipt {
  taskId: string;
  generation: number;
  /** `artifact_sha256` of the canonical text. */
  hash: string;
  /** The copy-blocks receipt (`sha256:<hex>`). */
  receipt: string;
  channel: string;
  limit: number;
  unit: string;
  at: number;
}

/** #1306: pending correspondence references, bound to their context generation. */
export interface CorrespondenceContext {
  at: number;
  generation: number;
  /** The conventions the pasted prompt surfaced. A later own instruction
   * can activate them; a moved revision gets a reload line. */
  conventions?: Array<{ id: string; revision: string | null }>;
}

/** #1306: the check a convention's deliverable is held to (validate_artifact, #1309). */
export interface ConventionValidator {
  tool: string;
  channel: string;
  limit: number;
  unit: string;
}

/** #1305: one convention in force for the session. */
export interface ActiveConvention {
  id: string;
  /** `memoryRevision` when it was set; null when the file was not readable. */
  revision: string | null;
  setAt: number;
  /** #1306: "task" when a correspondence task put it in force — it ends with
   *  the task. Absent: in force for the session (#1305 gate and load paths). */
  scope?: "task";
  /** #1306: optional validator parameters, shown in the active-conventions block. */
  validator?: ConventionValidator;
}

/** #1303: one must-load id waiting for the gate lane. */
export interface PendingMustLoad {
  id: string;
  block: string;
  at: number;
}

/**
 * #539 follow-up: what a lane gets back from {@link loadSessionState}.
 *
 * The snapshot a lane reads early is for DECISIONS only. Since #539 the
 * write-back re-reads the file inside the lock and applies just the callback's
 * delta, so anything mutated on the snapshot is dropped without a word — which
 * is exactly how the backoff's `skipped` counter stopped being saved.
 *
 * The read type therefore has to be one the mutators REFUSE. Plain `readonly`
 * properties would not do it: TypeScript ignores readonly modifiers when it
 * checks assignability, so a `Readonly<SessionState>` still slides into a
 * `SessionState` parameter. `readonly string[]` is the one readonly the
 * compiler does enforce — so `ids` carries the guard, and it makes the whole
 * state un-assignable to `SessionState`. `bumpShown(snapshot, …)` and
 * `recordSourceSuppressed(snapshot, …)` are now compile errors; the same call
 * with the callback's `state` is unchanged.
 */
export type ReadonlySourceBackoff = Readonly<Omit<SourceBackoff, "ids">> & {
  readonly ids: readonly string[];
};
export interface ReadonlySessionState {
  readonly shown: Readonly<Record<string, Readonly<ShownEntry>>>;
  readonly githubAdvisory?: Readonly<NonNullable<SessionState["githubAdvisory"]>>;
  readonly rulebookCheck?: string;
  readonly executedVaultWrites?: string;
  readonly draftShown?: readonly string[];
  readonly sources?: Readonly<Record<string, ReadonlySourceBackoff>>;
  readonly boundary?: Readonly<ParkedBoundary>;
  readonly touchedChars?: number;
  readonly touched?: ReadonlyMap<
    string,
    ReadonlyMap<string, Readonly<Omit<TouchedFile, "hits">> & { readonly hits: readonly TouchedHit[] }>
  >;
  readonly touchedOverflow?: boolean;
  readonly saveEvalDelivered?: readonly string[];
  readonly constants?: Readonly<Record<string, string>>;
  readonly pendingMustLoad?: readonly Readonly<PendingMustLoad>[];
  readonly deniedReflex?: readonly string[];
  readonly toolCalls?: number;
  readonly claimedMustLoad?: readonly string[];
  readonly activeConventions?: readonly Readonly<ActiveConvention>[];
  readonly loadedConventions?: readonly Readonly<{
    id: string;
    revision: string | null;
    loadedAt: number;
    validator?: ConventionValidator;
  }>[];
  readonly userValidatorChannel?: string;
  readonly activeTask?: Readonly<ActiveTask>;
  readonly correspondenceContext?: Readonly<CorrespondenceContext>;
  readonly receipts?: readonly Readonly<ArtifactReceipt>[];
  readonly repairAttempts?: Readonly<RepairAttempts>;
  readonly repairWindows?: Readonly<RepairWindows>;
}
