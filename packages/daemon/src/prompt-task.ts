/** Render explicitly reported task conventions and refresh indexed metadata.
 * No lexical inference, task transitions or user clarification. */
import type { Vault, ConventionValidator } from "@bastra-recall/core";
import { vaultConventionOf, type ConventionSource } from "./convention-source.js";
import { type DetectedMode, type TaskKind } from "./prompt-classify.js";
import { formatActiveConventionsBlock, type ActiveConventionsView } from "./prompt-format.js";
import { currentReceipt } from "./receipt-store.js";
import {
  mutateSessionState,
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

/** `revisionOf` over the daemon's vault index — no per-rule file read. */
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
  const generation = snapshot.activeTask?.generation ?? 0;
  const current: TaskKind = snapshot.activeTask?.kind ?? "none";
  // Prompt text and recall hits are hints, never applicability decisions.
  // rulebook_check supplies the model's explicit task/rule report.
  const activeIds = new Set((snapshot.activeConventions ?? []).map(e => e.id));
  if (!activeIds.size && current === "none") return null;
  // Revisions are read outside the lock: the lock wraps the mutation only (#539).
  const revisions = new Map<string, string | null>();
  const sources = new Map<string, ConventionSource>();
  if (input.conventionOf || input.revisionOf) {
    const ids = [...activeIds];
    const read = await Promise.all(ids.map(async (id) => {
      const source = input.conventionOf
        ? await input.conventionOf(id).catch(() => ({ revision: null }))
        : { revision: await input.revisionOf!(id).catch(() => null),
            validator: input.candidates.find((c) => c.id === id)?.validator };
      return [id, source] as const;
    }));
    for (const [id, source] of read) { revisions.set(id, source.revision); sources.set(id, source); }
  }

  const revisionDrift = (snapshot.activeConventions ?? []).some((e) => {
    const rev = revisions.get(e.id);
    return revisions.has(e.id) && (rev !== e.revision ||
      (input.conventionOf !== undefined && JSON.stringify(sources.get(e.id)?.validator) !== JSON.stringify(e.validator)));
  });
  const needsWrite =
    revisionDrift;

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
    if (changed.length || revisionDrift) { delete s.receipts; delete s.repairAttempts; }
    view = {
      task: s.activeTask?.kind ?? "none",
      generation: gen,
      conventions: (s.activeConventions ?? []).map((e): ActiveConvention => ({ ...e })),
      changed,
      unclear: false,
      receipt: currentReceipt(s),
    };
  });
  // The assignment happens inside the callback, which control flow does not follow.
  const written = view as ActiveConventionsView | null;
  if (!persisted || written === null) {
    // State unavailable: render the known snapshot without claiming a refresh.
    return formatActiveConventionsBlock(
      { task: current, generation, conventions: snapshot.activeConventions ?? [], changed: [], unclear: false, receipt: currentReceipt(snapshot) },
      input.surface,
    );
  }
  return formatActiveConventionsBlock(written, input.surface);
}
