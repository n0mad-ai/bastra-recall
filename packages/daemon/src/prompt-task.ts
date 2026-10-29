/**
 * UserPromptSubmit lane — the task contract step (#1306), split out of
 * prompt-lane.ts like the classification and formatting before it (#680).
 *
 * Per prompt: read the task signals from the user's own text
 * (prompt-classify.ts), apply the transition to the session state, put the
 * matching conventions in force when a task starts, and render the
 * `<active-conventions>` block from the state — every turn, regardless of the
 * hint dedup, for every client (Claude Code, Codex, replay). Information
 * only: nothing here denies anything.
 *
 * Revisions are the byte revision of the memory file (`memoryRevision`), read
 * through the caller's `revisionOf`; a changed revision adds a reload line.
 */
import type { Vault, ConventionValidator } from "@bastra-recall/core";
import { vaultConventionOf, type ConventionSource } from "./convention-source.js";
import { GATED_HINT_TYPES } from "./hook-recall-response.js";
import { decideTask, taskSignals, type DetectedMode, type TaskKind } from "./prompt-classify.js";
import { formatActiveConventionsBlock, type ActiveConventionsView } from "./prompt-format.js";
import { currentReceipt, expireReceipts } from "./receipt-store.js";
import {
  mutateSessionState,
  recordActiveConventions,
  taskIdFor,
  type ActiveConvention,
  type ReadonlySessionState,
} from "./session-state.js";

/** A memory this prompt's recall or reflex surfaced, before the session dedup. */
export interface TaskCandidate {
  id: string;
  type: string;
  matched_recall_when?: boolean;
  recall_mode?: string;
  validator?: ConventionValidator;
}

export interface TaskStepInput {
  sessionId: string;
  prompt: string;
  snapshot: ReadonlySessionState;
  mode: DetectedMode | "trivial";
  candidates: readonly TaskCandidate[];
  /** The file revision of a memory id; absent = revisions stay unknown. */
  revisionOf?: (id: string) => Promise<string | null>;
  /** Authoritative paired metadata; production routes always provide this. */
  conventionOf?: (id: string) => Promise<ConventionSource>;
  surface: string;
  now?: number;
}

/** The convention a starting task puts in force: rule-shaped, and its own
 *  trigger matched or the user wired it as reflex (#1303's evidence). */
export function isTaskConvention(c: TaskCandidate): boolean {
  return GATED_HINT_TYPES.has(c.type) && (c.matched_recall_when === true || c.recall_mode === "reflex");
}

/** `revisionOf` over the daemon's vault index — one small file read per id. */
export function vaultRevisionOf(vault: Pick<Vault, "get">): (id: string) => Promise<string | null> {
  const source = vaultConventionOf(vault);
  return async (id) => (await source(id)).revision;
}

/**
 * Run the step; the block to inject, or null. One state write at most, and
 * none when the prompt changes nothing. Never throws.
 */
export async function runTaskStep(input: TaskStepInput): Promise<string | null> {
  try {
    return await step(input);
  } catch {
    return null;
  }
}

async function step(input: TaskStepInput): Promise<string | null> {
  const { sessionId, snapshot } = input;
  if (!sessionId) return null;
  const now = input.now ?? Date.now();
  const generation = snapshot.activeTask?.generation ?? 0;
  const current: TaskKind = snapshot.activeTask?.kind ?? "none";
  const questionOpen = snapshot.taskQuestion !== undefined && snapshot.taskQuestion.generation === generation;
  const activeIds = new Set((snapshot.activeConventions ?? []).map((e) => e.id));
  const decision = decideTask(taskSignals(input.prompt), {
    current,
    questionOpen,
    mode: input.mode,
    hitActive: input.candidates.some((c) => activeIds.has(c.id)),
    // No recall hit is not evidence of a new subject: terse edit requests
    // commonly mention neither the original message nor its convention.
    hitOther: input.candidates.some((c) => !activeIds.has(c.id)),
  });
  // A task that starts — or the explicit answer to the choice line — puts the
  // conventions in force; "none" never does.
  const entering = decision.next !== null && decision.next !== "none";
  const surfaced = [...new Set(input.candidates.filter(isTaskConvention).map((c) => c.id))];
  // An answer to the choice line binds the conventions the question was asked about.
  const asked = questionOpen ? (snapshot.taskQuestion?.conventions ?? []) : [];
  const askedRevision = new Map(asked.map((e) => [e.id, e.revision]));
  const activate = entering ? [...new Set([...surfaced, ...asked.map((e) => e.id)])] : [];
  const askAbout = decision.unclear ? surfaced : [];

  // Nothing in force, nothing asked, nothing starting: the common prompt costs
  // the snapshot the lane already read.
  if (activeIds.size === 0 && current === "none" && !snapshot.taskQuestion && activate.length === 0 && !decision.unclear) {
    return null;
  }

  // Revisions are read outside the lock: the lock wraps the mutation only (#539).
  const revisions = new Map<string, string | null>();
  const sources = new Map<string, ConventionSource>();
  if (input.conventionOf || input.revisionOf) {
    const ids = [...new Set([...activeIds, ...activate, ...askAbout])];
    const read = await Promise.all(ids.map(async (id) => {
      const source = input.conventionOf
        ? await input.conventionOf(id).catch(() => ({ revision: null }))
        : { revision: await input.revisionOf!(id).catch(() => null),
            validator: input.candidates.find((c) => c.id === id)?.validator };
      return [id, source] as const;
    }));
    for (const [id, source] of read) { revisions.set(id, source.revision); sources.set(id, source); }
  }

  const kindChanges = decision.next !== null && decision.next !== current;
  const revisionDrift = (snapshot.activeConventions ?? []).some((e) => {
    const rev = revisions.get(e.id);
    return revisions.has(e.id) && (rev !== e.revision ||
      (input.conventionOf !== undefined && JSON.stringify(sources.get(e.id)?.validator) !== JSON.stringify(e.validator)));
  });
  const needsWrite =
    kindChanges || activate.length > 0 || decision.unclear || snapshot.taskQuestion !== undefined || revisionDrift;

  if (!needsWrite) {
    return formatActiveConventionsBlock(
      { task: current, generation, conventions: snapshot.activeConventions ?? [], changed: [], unclear: false, receipt: currentReceipt(snapshot) },
      input.surface,
    );
  }

  let view: ActiveConventionsView | null = null;
  const persisted = await mutateSessionState(sessionId, (s) => {
    const gen = s.activeTask?.generation ?? 0;
    delete s.taskQuestion;
    // A revision that moved since the convention was set: say so once, then
    // carry the new one. Unknown before is not a change.
    const changed: string[] = [];
    for (const e of s.activeConventions ?? []) {
      const rev = revisions.get(e.id);
      if (!revisions.has(e.id)) continue;
      if (rev !== e.revision && e.revision !== null) changed.push(e.id);
      e.revision = rev ?? null;
      if (input.conventionOf) {
        const validator = sources.get(e.id)?.validator;
        if (validator) e.validator = validator;
        else delete e.validator;
      } else if (rev !== snapshot.activeConventions?.find((c) => c.id === e.id)?.revision) {
        delete e.validator;
      }
    }
    if (decision.next !== null && decision.next !== (s.activeTask?.kind ?? "none")) {
      s.activeTask = { id: taskIdFor(decision.next, now), kind: decision.next, since: now, generation: gen };
      // #1310: a new task (or none) ends the receipts of the old one.
      expireReceipts(s);
      if (decision.next === "none") {
        const rest = (s.activeConventions ?? []).filter((e) => e.scope !== "task");
        if (rest.length > 0) s.activeConventions = rest;
        else delete s.activeConventions;
      }
    }
    // The question was asked at one revision; an answer under another reloads.
    for (const id of activate) {
      const then = askedRevision.get(id);
      const nowRev = revisions.get(id);
      if (typeof then === "string" && typeof nowRev === "string" && then !== nowRev && !changed.includes(id)) changed.push(id);
    }
    if (activate.length > 0) {
      recordActiveConventions(s, activate.map((id) => ({
        id, revision: revisions.get(id) ?? null, scope: "task" as const,
        validator: input.conventionOf ? sources.get(id)?.validator
          : (sources.get(id)?.validator ?? input.candidates.find((c) => c.id === id)?.validator),
      })), now);
    }
    if (decision.unclear) {
      s.taskQuestion = {
        at: now,
        generation: gen,
        ...(askAbout.length > 0 ? { conventions: askAbout.map((id) => ({ id, revision: revisions.get(id) ?? null })) } : {}),
      };
    }
    view = {
      task: s.activeTask?.kind ?? "none",
      generation: gen,
      conventions: (s.activeConventions ?? []).map((e): ActiveConvention => ({ ...e })),
      changed,
      unclear: decision.unclear,
      receipt: currentReceipt(s),
    };
  });
  // The assignment happens inside the callback, which control flow does not follow.
  const written = view as ActiveConventionsView | null;
  if (!persisted || written === null) {
    // State not on disk: still tell this turn what the snapshot knew, and ask
    // when unclear — but never claim a transition that did not persist.
    return formatActiveConventionsBlock(
      { task: current, generation, conventions: snapshot.activeConventions ?? [], changed: [], unclear: decision.unclear, receipt: currentReceipt(snapshot) },
      input.surface,
    );
  }
  return formatActiveConventionsBlock(written, input.surface);
}
