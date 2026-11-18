/**
 * The rulebook round state as it is stored in the session (`rulebookCheck`):
 * schema, tolerant decoding and the indexed project. Pure decoding below both
 * the round logic (rulebook-check.ts) and the catalog (rulebook-catalog.ts),
 * so neither imports the other for it (#1515 B4). #1532: also the writing
 * side and whose actor entry a hook payload names, shared by the round logic
 * and the correspondence round (rulebook-correspondence.ts).
 */
import { ConventionValidatorSchema } from "@bastra-recall/core";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hookAgent } from "./hook-surface.js";

const RuleRef = z.object({ id: z.string(), revision: z.string().nullable() });
const RoundRule = RuleRef.extend({ validator: ConventionValidatorSchema.optional() });
const Actor = z.object({
  correspondenceEvidence: z.boolean().default(false),
  roundApplied: z.array(RoundRule).default([]),
  roundDismissed: z.array(RuleRef).default([]),
  repairs: z.number().default(0),
  repairProse: z.boolean().default(false),
  required: z.array(RuleRef).default([]),
  loaded: z.array(RuleRef).default([]),
  dismissed: z.array(RuleRef).default([]),
  key: z.string(),
  checked: z.boolean().default(false),
  ids: z.array(z.string()).default([]),
  denies: z.number().default(0),
  stops: z.number().default(0),
  deferredStop: z.boolean().default(false),
});
// #1374: the project the session's rule index was built for; rulebook_check answers from the same catalog.
const State = z.object({
  project: z.string().nullable().optional(),
  copyViolations: z.number().default(0),
  blockedDismissals: z.array(z.string()).default([]),
  context: z.string(),
  round: z.number(),
  actors: z.array(Actor),
  unchecked: z.number(),
  exceptions: z.array(z.string()).default([]),
});
export type CheckState = z.infer<typeof State>;
export function readCheckState(state: { readonly rulebookCheck?: string }): CheckState {
  try {
    return State.parse(JSON.parse(state.rulebookCheck ?? ""));
  } catch {
    return {
      context: randomUUID(),
      round: 0,
      actors: [],
      unchecked: 0,
      copyViolations: 0,
      blockedDismissals: [],
      exceptions: [],
    };
  }
}
/** Indexed null is global scope; undefined retains the legacy caller-project fallback. */
export function sessionRulebookProject(
  state: { readonly rulebookCheck?: string } | undefined
): string | null | undefined {
  return state?.rulebookCheck ? readCheckState(state).project : undefined;
}
export interface RulebookPayload {
  session_id?: string;
  agent_id?: string;
  bastra_client?: string;
  bastra_codex_version?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: unknown;
}
export function writeCheckState(state: { rulebookCheck?: string }, value: CheckState) {
  state.rulebookCheck = JSON.stringify(value);
}
export function roundActor(state: CheckState, key: string) {
  let found = state.actors.find((a) => a.key === key);
  if (!found) {
    found = {
      key,
      correspondenceEvidence: false,
      roundApplied: [],
      roundDismissed: [],
      repairs: 0,
      repairProse: false,
      checked: false,
      ids: [],
      denies: 0,
      stops: 0,
      deferredStop: false,
      required: [],
      loaded: [],
      dismissed: [],
    };
    state.actors.push(found);
  }
  return found;
}
export function roundIdentity(p: RulebookPayload): string {
  if (p.agent_id) return `agent:${p.agent_id}`;
  return hookAgent(p) === "main" ? "main" : "unattributed";
}
