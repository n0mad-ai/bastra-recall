/**
 * #360 — the write-time claim gate.
 *
 * Until now a contradiction only came into existence when the agent declared
 * it (`conflict_with`, #205). Nothing asked. A save whose `recall_when` claimed
 * a situation an existing memory already declares produced a silent sibling:
 * #300's trigger-collision advisory warned at save time but decided nothing,
 * the write went through, and afterwards nobody looked again. Two memories then
 * answer the same cue forever, and recall has no way to tell which one is meant.
 *
 * The gate turns that advisory into a question the save cannot walk past. Two
 * memories declaring one situation are exactly one of three things, and only
 * the agent can tell which:
 *
 *   - a SUCCESSOR       → `replaces`      (one chain, the newer applies)
 *   - a CONTRADICTION   → `conflict_with` (both current, incompatible)
 *   - SIBLINGS          → `sibling_of`    (several entities, both permanent)
 *
 * The daemon deliberately adjudicates NONE of them. It is the layer that can
 * see the collision deterministically and the layer that must not guess: no
 * LLM inside the daemon, no similarity threshold below 1.0 (#325 stays open
 * precisely because the 0.80–0.99 band mixes two classes no number separates).
 * It asks; the agent answers in the same round; the answer lands in the
 * frontmatter and the audit log.
 *
 * Trigger for the gate is full containment (`TRIGGER_CLAIMS_SITUATION_MIN`,
 * #300): every content word of the incoming trigger is already in theirs. That
 * boundary is a property of the measure rather than a number somebody picked,
 * so it cannot rot the way an absolute score floor did.
 *
 * Shape of the refusal follows #205: a structured result, not a throw. A throw
 * would feed the #150 anti-thrash counter, and three legitimate gate hits would
 * lock `save_memory` for the session — the opposite of what the gate is for.
 */
import { stripAutoRelatedSection, CONFLICT_START, type SaveMemoryInput } from "@bastra-recall/core";
import type { SaveQualityResult } from "./save-quality.js";
import { contentDelta, type ContentDelta } from "./save-similarity.js";

/**
 * Types whose `recall_when` the importer writes, not the author.
 *
 * A document sidecar gets `foto bild unsortiert` on every imported photo and a
 * bookmark gets its own host, so they collide with each other by construction
 * and forever. The gate's premise is that an author DECLARED a situation and
 * has to reconcile two declarations; for a generated trigger there is nothing
 * to reconcile, and holding an import to ask about it would stall a bulk
 * document run on the first duplicate phrase.
 *
 * Today the document flow does not reach `saveMemoryHandler` at all — it is
 * written by `documents-write-handler.ts` — so this is belt and braces rather
 * than a live fix. It is here anyway because the day those paths converge, the
 * failure would be a bulk import stopping on every file, and nobody would
 * connect that back to a gate written for authored memories.
 *
 * `claimed-twice.ts` imports this list rather than keeping its own: the report
 * exists to show what the gate would hold, so the two must not drift.
 */
export const GENERATED_TRIGGER_TYPES = new Set(["doc", "bookmark"]);

/** Longest existing body handed back for comparison. Past this the agent gets
 *  a marked excerpt and can `load_memory` for the rest — a gate refusal must
 *  not cost more context than the memory it is protecting. */
const EXISTING_BODY_MAX = 2000;

/**
 * The authored text of a memory, without what the machine appended to it.
 *
 * The auto-related block is a list of wikilinked ids, and a conflict block is a
 * quoted copy of some other save. Both would land in `new_terms` as vocabulary
 * the author never wrote, and both make the quoted "what it currently says"
 * longer without making it more informative.
 */
function authoredBody(body: string): string {
  const withoutRelated = stripAutoRelatedSection(body);
  const conflictAt = withoutRelated.indexOf(CONFLICT_START);
  return (conflictAt === -1 ? withoutRelated : withoutRelated.slice(0, conflictAt)).trim();
}

/** One memory that already declares a situation this save claims. */
export interface ClaimedSituation {
  /** The memory that got there first. */
  id: string;
  /** This save's trigger. */
  trigger: string;
  /** Their trigger — the phrase that makes this a collision. Without it the
   *  question names a conflict the agent cannot see. */
  claim: string;
  /** Its summary — enough to recognise the memory without loading it. */
  summary?: string;
  /** Its body, so the agent can compare texts in THIS round instead of
   *  spending a `load_memory` roundtrip before it can decide anything. */
  existing_body?: string;
  /** True when `existing_body` was cut at `EXISTING_BODY_MAX`. */
  body_truncated?: true;
  /** What this save's body would add to that memory (#360b). */
  delta?: ContentDelta;
}

export interface ClaimGateResult {
  /** The save's own id — nothing was written under it. */
  id: string;
  created: false;
  /** #360: set when the save was held at the claim gate. */
  claim_gate: {
    /** Every distinct memory that already declares one of these situations. */
    claimed: ClaimedSituation[];
  };
  /** The advisory the save would have received. Carried through the refusal
   *  rather than dropped: `duplicate_candidates` is exactly the evidence the
   *  agent needs to answer "successor or sibling?", and swallowing the whole
   *  block would make the gate strictly less informative than the advisory it
   *  replaces on this path. */
  save_quality: SaveQualityResult;
  note: string;
}

/**
 * Which memories does this save's `recall_when` collide with, after the
 * answers the save already carries?
 *
 * `conflict_with` never reaches here — a save declaring a contradiction is
 * diverted before any scoring (`tool-handlers.ts`). `replaces` and `sibling_of`
 * are subtracted per id, not globally: a save that supersedes A and collides
 * with A **and** B has answered for A only, and B is still an open question.
 */
export function unansweredClaims(
  input: SaveMemoryInput,
  quality: SaveQualityResult,
  /** Reads the colliding memory so the refusal can carry its text. Optional so
   *  the pure collision logic stays testable without a vault. */
  read?: (id: string) => { summary?: string; body?: string } | undefined,
  /** Every id on the version chain below `id`, itself included. Optional; the
   *  gate degrades to direct answers without it. */
  chainBelow?: (id: string) => Iterable<string>,
): ClaimedSituation[] {
  const answered = new Set<string>([
    ...(input.conflict_with ? [input.conflict_with] : []),
    ...(input.sibling_of ?? []),
  ]);
  // A `replaces` answers for the WHOLE chain it joins, not just its immediate
  // predecessor — the sweep has read chains that way since the transitivity
  // fix, and a gate that does not would hold every new link in a running chain
  // against each of its ancestors. Measured on a real save: appending to a
  // three-deep chain of status notes was refused because the grandparent
  // carried the same trigger, and the only ways past were a false `sibling_of`
  // or dropping a trigger the newest note legitimately owns.
  //
  // Siblings deliberately get no such closure (see `closeOverVersionChains`).
  if (input.replaces) {
    answered.add(input.replaces);
    for (const id of chainBelow?.(input.replaces) ?? []) answered.add(id);
  }
  const seen = new Set<string>();
  const out: ClaimedSituation[] = [];
  for (const collision of quality.trigger_collisions) {
    // `claimants` is the full set; `examples` is the three-item display slice
    // and would silently narrow what the gate can see.
    for (const id of collision.claimants ?? collision.examples) {
      if (answered.has(id) || seen.has(id)) continue;
      seen.add(id);
      const existing = read?.(id);
      const body = existing?.body ? authoredBody(existing.body) : undefined;
      out.push({
        id,
        trigger: collision.trigger,
        claim: collision.claim ?? collision.trigger,
        ...(existing?.summary ? { summary: existing.summary } : {}),
        ...(body
          ? {
              existing_body: body.slice(0, EXISTING_BODY_MAX),
              ...(body.length > EXISTING_BODY_MAX ? { body_truncated: true as const } : {}),
              // Compared against summary + body: a fact stated in the summary
              // is said, wherever the author put it.
              delta: contentDelta(input.body, `${existing?.summary ?? ""}\n${body}`),
            }
          : {}),
      });
    }
  }
  return out;
}

/**
 * The refusal handed back to the agent.
 *
 * Written to be actionable in one round: it names the colliding memory, quotes
 * BOTH triggers, hands over the existing text, and says what this save's words
 * would add to it. The three structural answers follow.
 *
 * Order matters. "Does this text add anything" is asked FIRST, because it is
 * the question that most often ends the matter — a save that repeats what is
 * already stored is dropped, and no version edge, conflict or sibling link
 * should be created for it. Leading with the three link fields invites the
 * agent to pick one of them for a memory that should simply not exist.
 *
 * The closing line matters as much as the rest — without it the #150 wrapper's
 * terminal marker is absent and a model reads "not created" as a transient
 * failure to retry verbatim, which would loop forever because the gate is
 * deterministic.
 */
export function claimGateResult(
  finalId: string,
  claimed: ClaimedSituation[],
  quality: SaveQualityResult,
): ClaimGateResult {
  const L: string[] = [];
  L.push("NOTHING WAS SAVED. This memory's recall_when claims a situation another memory already declares:");
  L.push("");
  for (const c of claimed) {
    L.push(`  - '${c.id}' already declares it — your trigger "${c.trigger}" vs. its "${c.claim}"`);
    if (c.delta) {
      L.push(
        c.delta.new_terms.length === 0
          ? `      Your body adds NO new terms — every content word of it is already in that memory.`
          : `      Your body would add: ${c.delta.new_terms.join(", ")}` +
            `  (${Math.round(c.delta.covered * 100)}% of it is already there)`,
      );
    }
    if (c.existing_body) {
      L.push(`      What it currently says${c.body_truncated ? " (excerpt)" : ""}:`);
      for (const line of c.existing_body.split("\n")) L.push(`      | ${line}`);
      if (c.body_truncated) L.push(`      | … load_memory('${c.id}') for the rest`);
    }
    L.push("");
  }

  // The empty list, not a score: see `contentDelta` for why no cut belongs here.
  const nothingNew = claimed.every((c) => c.delta !== undefined && c.delta.new_terms.length === 0);
  L.push("FIRST decide whether this save should exist at all:");
  L.push("");
  if (nothingNew) {
    L.push(
      "  Its words are already in that memory. Unless it states something the vocabulary cannot see — " +
        "a different VALUE for the same fact, a reversal, a correction — DROP this save. Do not link it, " +
        "do not re-send it. Say in one line that the memory already covers it and move on.",
    );
  } else {
    L.push(
      "  - Nothing genuinely new (the added terms are rewording): DROP the save. Do not link it, do not " +
        "re-send it — say the memory already covers it and move on.",
    );
    L.push(
      "  - Something new that BELONGS in that memory: do not create a second one. Re-save THAT memory with " +
        "`overwrite: true`, its id, and a body that carries its existing content plus your addition. " +
        "Keep its title, triggers and frontmatter unless the new fact changes them.",
    );
  }
  L.push("");
  L.push("Only if this really is a separate memory, re-send this save with ONE of:");
  L.push("  - replaces: <id>      — the older one is out of date and this is its new version");
  L.push("  - conflict_with: <id> — both are current and they contradict each other");
  L.push(`  - sibling_of: [${claimed.map((c) => `'${c.id}'`).join(", ")}] — both apply permanently (different entities, same wording)`);
  L.push("  - or narrow this save's recall_when so it no longer claims their situation");
  L.push("");
  L.push("Do not re-send this save unchanged — the gate is deterministic and will hold it again.");

  return {
    id: finalId,
    created: false,
    claim_gate: { claimed },
    save_quality: quality,
    note: L.join("\n"),
  };
}
