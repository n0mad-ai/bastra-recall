/** Gate-specific eligibility and action matching; session claims stay in gate-lane. */
import type { Memory } from "@bastra-recall/core";
import { isReflexPoolMember, matchReflexPool, type ReflexMatch } from "./reflex.js";

/** The action context a reflex trigger is matched against stays below 8 KB. */
export const MAX_ACTION_CONTEXT_CHARS = 8 * 1024 - 1;
/** Pool eligibility: only a rule the user dictated and rated as weighty. */
const MIN_SALIENCE = 0.8;

/**
 * Only a rule the user wired as reflex, dictated in person, rated salience >=
 * 0.8 and that nothing superseded may interrupt an action.
 */
export function actionReflexPool(memories: readonly Memory[]): Memory[] {
  return memories.filter(
    (m) =>
      isReflexPoolMember(m) &&
      m.fm.write_origin === "user-directed" &&
      typeof m.fm.salience === "number" &&
      m.fm.salience >= MIN_SALIENCE
  );
}

/**
 * What a reflex trigger is matched against: the tool name (and an MCP tool's
 * own name), the paths, the query and the Bash command. Never file contents —
 * a trigger word inside a written file is not the action.
 */
export function actionContext(toolName: string, input: Record<string, unknown>): string {
  const parts = [toolName];
  const short = toolName.split("__").pop();
  if (short && short !== toolName) parts.push(short);
  for (const key of ["file_path", "notebook_path", "path", "query", "command"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) parts.push(value);
  }
  return parts.join("\n").slice(0, MAX_ACTION_CONTEXT_CHARS);
}

export function matchActionReflex(
  pool: readonly Memory[],
  toolName: string,
  input: Record<string, unknown>
): ReflexMatch[] {
  if (pool.length === 0) return [];
  return matchReflexPool(pool, actionContext(toolName, input), pool.length).matched;
}
