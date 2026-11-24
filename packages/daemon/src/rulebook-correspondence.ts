/**
 * The correspondence side of the rulebook round: which rules count as
 * correspondence rules, which validators are in force for an actor this
 * round, and the bounded Stop repair claim. Split out of rulebook-check.ts
 * (#1532), which re-exports the public functions.
 */
import { ConventionValidatorSchema } from "@bastra-recall/core";
import type { ReadonlySessionState, SessionState } from "./session-state.js";
import { activeConventionValidator, type ConventionSource } from "./convention-source.js";
import {
  readCheckState,
  roundActor as actor,
  roundIdentity as identity,
  writeCheckState as put,
  type CheckState,
  type RulebookPayload,
} from "./rulebook-round-state.js";

/** Validators imply correspondence structurally, including legacy rules. */
export function isCorrespondenceRule(e: {
  expired_on?: string;
  validator?: unknown;
  rule_categories?: readonly string[];
}): boolean {
  return !e.expired_on && (!!e.validator || !!e.rule_categories?.includes("correspondence"));
}
export function hasReportedTask(state: Pick<ReadonlySessionState, "activeTask">): boolean {
  return !!state.activeTask && state.activeTask.kind !== "none";
}
type RoundRules = CheckState["actors"][number]["roundApplied"];
/** A reported task keeps the main thread's loaded and active validators in force, unless dismissed this round. */
function addTaskValidators(
  state: Pick<ReadonlySessionState, "loadedConventions" | "activeConventions">,
  a: CheckState["actors"][number] | undefined,
  rules: RoundRules
): void {
  for (const loaded of [...(state.loadedConventions ?? []), ...(state.activeConventions ?? [])]) {
    const validator = ConventionValidatorSchema.safeParse(loaded.validator);
    if (
      validator.success &&
      !a?.roundDismissed.some((r) => r.id === loaded.id) &&
      !rules.some((r) => r.id === loaded.id)
    )
      rules.push({ id: loaded.id, revision: loaded.revision, validator: validator.data });
  }
}
export function roundCorrespondence(
  state: Pick<ReadonlySessionState, "rulebookCheck" | "loadedConventions" | "activeConventions" | "activeTask">,
  p: RulebookPayload = { bastra_client: "claude-code" }
) {
  const value = readCheckState(state),
    a = value.actors.find((a) => a.key === identity(p));
  const rules = [...(a?.roundApplied ?? [])];
  if (identity(p) === "main" && hasReportedTask(state)) addTaskValidators(state, a, rules);
  return {
    key: `${value.context}:${value.round}:${identity(p)}`,
    round: value.round,
    rules,
    dismissed: (a?.roundDismissed ?? []).map((r) => r.id),
    repairs: a?.repairs ?? 0,
    repairProse: a?.repairProse ?? false,
  };
}
/** Called only under the existing bounded Stop state claim. */
export function claimRoundRepair(
  state: SessionState,
  p: RulebookPayload,
  key: string,
  observeOnly = false,
  minimum = 0,
  proseIsCopy = true
): number | null {
  const current = roundCorrespondence(state, p);
  if (current.key !== key || current.repairs > 2) return null;
  const value = readCheckState(state),
    a = actor(value, identity(p)),
    count = Math.max(a.repairs, minimum);
  if (count > 2) return null;
  if (a.repairs === 0) a.repairProse = proseIsCopy;
  a.repairs = observeOnly ? 3 : count + 1;
  if (observeOnly || count === 2) {
    value.copyViolations++;
    value.unchecked++;
  }
  put(state, value);
  return count;
}
export function refreshRoundValidators(
  state: SessionState,
  before: { readonly rulebookCheck?: string },
  sources: ReadonlyMap<string, ConventionSource>
): void {
  const value = readCheckState(state),
    old = readCheckState(before);
  if (value.context !== old.context || value.round !== old.round) return;
  for (const a of value.actors)
    for (const rule of a.roundApplied) {
      if (
        !old.actors
          .find((prior) => prior.key === a.key)
          ?.roundApplied.some((r) => r.id === rule.id && r.revision === rule.revision)
      )
        continue;
      const source = sources.get(rule.id);
      if (!source) continue;
      rule.revision = source.revision;
      const validator = activeConventionValidator(source);
      if (validator) rule.validator = validator;
      else delete rule.validator;
    }
  put(state, value);
}
