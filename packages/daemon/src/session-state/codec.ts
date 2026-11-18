/**
 * #1322: the one codec between the persisted session-state JSON and
 * `SessionState`. Every lane's save goes through `encodeSessionState` after
 * `decodeSessionState`, so a section the decoder drops is lost for every lane —
 * which is why each section is carried through here, field by field.
 *
 * The decoder assigns the sections in a fixed order, and the encoder writes
 * them in that order: the persisted key order is part of the format.
 */
import { decodeActiveTask } from "../task-state.js";
import { parseRepairWindows } from "../stop-repair-window.js";
import { claimDraftHints } from "./draft-claims.js";
import type {
  ActiveConvention,
  ArtifactReceipt,
  ConventionValidator,
  PendingMustLoad,
  SessionState,
  ShownEntry,
  SourceBackoff,
  TouchedFile,
} from "./types.js";

type Parsed = Partial<SessionState>;

export function decodeSessionState(sessionId: string, raw: string): SessionState {
  try {
    const parsed = JSON.parse(raw) as Parsed;
    if (!parsed || typeof parsed !== "object" || !parsed.shown) {
      return { shown: {} };
    }
    const state: SessionState = { shown: parsed.shown as Record<string, ShownEntry> };
    decodeDeliverySections(sessionId, parsed, state);
    decodeTouchedSections(parsed, state);
    decodeConventionSections(parsed, state);
    decodeTaskSections(parsed, state);
    return state;
  } catch {
    return { shown: {} };
  }
}

function decodeGithubAdvisory(advisory: Parsed["githubAdvisory"]): SessionState["githubAdvisory"] {
  if (advisory && typeof advisory === "object" && "delivered" in advisory && advisory.delivered === true)
    return { delivered: true };
  if (
    advisory &&
    typeof advisory === "object" &&
    "token" in advisory &&
    typeof advisory.token === "string" &&
    typeof advisory.deadline === "number"
  ) {
    return { token: advisory.token, deadline: advisory.deadline };
  }
  return undefined;
}

/** GitHub advisory, rulebook round, vault-write receipts, draft hints, backoff. */
function decodeDeliverySections(sessionId: string, parsed: Parsed, state: SessionState): void {
  const advisory = decodeGithubAdvisory(parsed.githubAdvisory);
  if (advisory) state.githubAdvisory = advisory;
  if (typeof parsed.rulebookCheck === "string") state.rulebookCheck = parsed.rulebookCheck;
  if (typeof parsed.executedVaultWrites === "string") state.executedVaultWrites = parsed.executedVaultWrites;
  if (Array.isArray(parsed.draftShown)) {
    state.draftShown = parsed.draftShown.filter((id): id is string => typeof id === "string");
    claimDraftHints(sessionId, [], state.draftShown, 0);
  }
  // #161: carry the backoff section through — dropping it here would reset
  // every streak on the next dedup save.
  if (parsed.sources && typeof parsed.sources === "object") {
    state.sources = parsed.sources as Record<string, SourceBackoff>;
  }
}

/** #572: the task-boundary accumulator and its parked block. */
function decodeTouchedSections(parsed: Parsed, state: SessionState): void {
  // #572: same reason — the accumulator must survive every other lane's save.
  if (parsed.touched && typeof parsed.touched === "object") {
    const touched = new Map<string, Map<string, TouchedFile>>();
    for (const [repoRoot, files] of Object.entries(parsed.touched as unknown as Record<string, unknown>)) {
      if (!files || typeof files !== "object") continue;
      touched.set(repoRoot, new Map(Object.entries(files as Record<string, TouchedFile>)));
    }
    state.touched = touched;
  }
  if (parsed.touchedOverflow === true) state.touchedOverflow = true;
  if (parsed.boundary && typeof parsed.boundary.note === "string" && typeof parsed.boundary.dedupeKey === "string") {
    state.boundary = {
      note: parsed.boundary.note,
      dedupeKey: parsed.boundary.dedupeKey,
      builtFrom: typeof parsed.boundary.builtFrom === "number" ? parsed.boundary.builtFrom : 0,
      // A state written before the telemetry row existed carries no count;
      // zero is honest about that and never inflates the measurement.
      files: typeof parsed.boundary.files === "number" ? parsed.boundary.files : 0,
    };
  }
  if (typeof parsed.touchedChars === "number") state.touchedChars = parsed.touchedChars;
}

const isString = (id: unknown): id is string => typeof id === "string";

/** #1623: per-subagent kernel counts, keyed by the agent_id hash only. */
function decodeAgentToolCalls(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const counts: Record<string, number> = {};
  for (const [agent, calls] of Object.entries(raw))
    if (/^[0-9a-f]{64}$/.test(agent) && typeof calls === "number" && Number.isFinite(calls)) counts[agent] = calls;
  return counts;
}

/** Save-eval deliveries, session-start constants and the gate lane's conventions. */
function decodeConventionSections(parsed: Parsed, state: SessionState): void {
  if (Array.isArray(parsed.saveEvalDelivered)) {
    state.saveEvalDelivered = parsed.saveEvalDelivered.filter(isString);
  }
  // #509: same reason — a resume must still see what the context carries.
  if (parsed.constants && typeof parsed.constants === "object") {
    const constants: Record<string, string> = {};
    for (const [part, hash] of Object.entries(parsed.constants)) {
      if (typeof hash === "string") constants[part] = hash;
    }
    state.constants = constants;
  }
  // #1303: the gate lane's claims — same reason, every lane's save carries them.
  if (Array.isArray(parsed.pendingMustLoad)) {
    state.pendingMustLoad = parsed.pendingMustLoad.filter(
      (e): e is PendingMustLoad =>
        !!e && typeof e.id === "string" && typeof e.block === "string" && typeof e.at === "number"
    );
  }
  if (Array.isArray(parsed.deniedReflex)) {
    state.deniedReflex = parsed.deniedReflex.filter(isString);
  }
  if (typeof parsed.toolCalls === "number") state.toolCalls = parsed.toolCalls;
  const agentToolCalls = decodeAgentToolCalls(parsed.agentToolCalls);
  if (agentToolCalls) state.agentToolCalls = agentToolCalls;
  if (Array.isArray(parsed.claimedMustLoad)) {
    state.claimedMustLoad = parsed.claimedMustLoad.filter(isString);
  }
  if (Array.isArray(parsed.loadedConventions))
    state.loadedConventions = parsed.loadedConventions
      .filter(
        (e): e is { id: string; revision: string | null; loadedAt: number; validator?: ConventionValidator } =>
          !!e &&
          typeof e.id === "string" &&
          (typeof e.revision === "string" || e.revision === null) &&
          typeof e.loadedAt === "number"
      )
      .slice(-200);
  if (typeof parsed.userValidatorChannel === "string" && parsed.userValidatorChannel)
    state.userValidatorChannel = parsed.userValidatorChannel;
  if (Array.isArray(parsed.activeConventions)) {
    state.activeConventions = parsed.activeConventions.filter(
      (e): e is ActiveConvention =>
        !!e &&
        typeof e.id === "string" &&
        (typeof e.revision === "string" || e.revision === null) &&
        typeof e.setAt === "number"
    );
  }
}

/** #1306/#1310/#1311: the correspondence task, its receipts and repair bookkeeping. */
function decodeTaskSections(parsed: Parsed, state: SessionState): void {
  // #1306: the task state — same reason, every lane's save carries it.
  const task = decodeActiveTask(parsed.activeTask);
  if (task) state.activeTask = task;
  // #1310: receipts — same reason, every lane's save carries them.
  if (Array.isArray(parsed.receipts)) {
    state.receipts = parsed.receipts.filter(
      (r): r is ArtifactReceipt =>
        !!r &&
        typeof r.taskId === "string" &&
        typeof r.generation === "number" &&
        typeof r.hash === "string" &&
        typeof r.receipt === "string" &&
        typeof r.channel === "string" &&
        typeof r.limit === "number" &&
        typeof r.unit === "string" &&
        typeof r.at === "number"
    );
  }
  // #1311: the repair counter — same reason, or every other lane's save would reset the cap.
  const repair = parsed.repairAttempts;
  if (
    repair &&
    typeof repair.taskId === "string" &&
    typeof repair.generation === "number" &&
    typeof repair.count === "number"
  ) {
    state.repairAttempts = { taskId: repair.taskId, generation: repair.generation, count: repair.count };
  }
  if (parsed.repairWindows !== undefined) state.repairWindows = parseRepairWindows(parsed.repairWindows);
  const question = parsed.correspondenceContext;
  if (question && typeof question.at === "number" && typeof question.generation === "number") {
    const conventions = Array.isArray(question.conventions)
      ? question.conventions.filter(
          (e): e is { id: string; revision: string | null } =>
            !!e && typeof e.id === "string" && (typeof e.revision === "string" || e.revision === null)
        )
      : [];
    state.correspondenceContext = {
      at: question.at,
      generation: question.generation,
      ...(conventions.length > 0 ? { conventions } : {}),
    };
  }
}

/**
 * #572: `touched` is a `Map` in memory (no property write to pollute, see
 * `recordTouched`) and an object on disk, because `JSON.stringify` writes a
 * `Map` as `{}`.
 */
export function encodeSessionState(state: SessionState): string {
  const onDisk = { ...state } as unknown as Record<string, unknown>;
  if (state.touched !== undefined) {
    onDisk.touched = Object.fromEntries([...state.touched].map(([key, value]) => [key, Object.fromEntries(value)]));
  }
  return JSON.stringify(onDisk);
}
