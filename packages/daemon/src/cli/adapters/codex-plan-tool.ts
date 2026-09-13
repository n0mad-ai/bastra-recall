/**
 * Codex plan-tool opt-in (#506).
 *
 * Codex ships its planning tool disabled by default since `rust-v0.152.0`
 * (`tools.update_plan.enabled`). Without it the model never calls
 * `update_plan`, so the `PreToolUse: ^update_plan$` hook `bastra install codex`
 * registers can never fire — the lane is dead by construction on a default
 * installation.
 *
 * `~/.codex/config.toml` belongs to Codex, so this module never re-serializes
 * it. It reads the file as text, answers three questions (is the key on, off or
 * absent? did *we* write it?) and, when it writes at all, appends or inserts a
 * byte-exact, comment-marked block. Uninstall removes exactly that block again
 * and nothing else; a value the user set themselves is never touched in either
 * direction.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { backupConfig, fileExists } from "../helpers.js";

export const PLAN_TOOL_KEY = "tools.update_plan.enabled";

/** Machine-readable ownership marker; also the user-facing explanation. */
export const PLAN_TOOL_MARKER = "# bastra-recall (#506) · managed:";

const MANAGED_LINES = [
  `${PLAN_TOOL_MARKER} Codex ships its planning tool off by default, and the`,
  "# bastra-recall plan hook (PreToolUse ^update_plan$) only fires when it is on.",
  "# 'bastra uninstall codex' removes these lines again. Delete this comment to",
  "# keep the setting, or set it to false to turn the plan lane off for good.",
  "enabled = true",
  "",
].join("\n");

const MANAGED_BLOCK = `\n[tools.update_plan]\n${MANAGED_LINES}`;

const SUBTABLE_HEADER = /^\s*\[\s*(?:tools|"tools"|'tools')\s*\.\s*(?:update_plan|"update_plan"|'update_plan')\s*\]\s*$/;

export type PlanToolState =
  | "enabled"      // the key is true — the lane can fire
  | "disabled"     // the key is explicitly false — a user decision
  | "absent"       // no key at all — the default, and the dead lane
  | "unsupported"; // a shape we refuse to edit (inline table, odd value)

export interface PlanToolInspection {
  state: PlanToolState;
  /** True when the value carries our marker, i.e. bastra wrote it. */
  managed: boolean;
  /** True when a `[tools.update_plan]` section header already exists. */
  sectionHeader: boolean;
}

function unquote(segment: string): string {
  const trimmed = segment.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function dottedPath(raw: string): string {
  return raw.split(".").map(unquote).join(".");
}

/** Read-only view of the plan-tool setting in a Codex config.toml text. */
export function inspectPlanTool(source: string): PlanToolInspection {
  const managed = source.includes(PLAN_TOOL_MARKER);
  let table = "";
  let sectionHeader = false;
  let state: PlanToolState = "absent";
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[[")) {
      const header = trimmed.slice(2, trimmed.lastIndexOf("]]"));
      table = dottedPath(header);
      // An array-of-tables named tools/… is a shape we will not edit.
      if (table === "tools" || table === "tools.update_plan") return { state: "unsupported", managed, sectionHeader };
      continue;
    }
    if (trimmed.startsWith("[")) {
      table = dottedPath(trimmed.slice(1, trimmed.lastIndexOf("]")));
      if (SUBTABLE_HEADER.test(line)) sectionHeader = true;
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = dottedPath(trimmed.slice(0, eq));
    const value = trimmed.slice(eq + 1).trim();
    const path = table ? `${table}.${key}` : key;
    if (path === PLAN_TOOL_KEY) {
      const bare = value.replace(/\s*#.*$/, "").trim();
      if (bare === "true") state = "enabled";
      else if (bare === "false") state = "disabled";
      else return { state: "unsupported", managed, sectionHeader };
    } else if (path === "tools.update_plan" || path === "tools") {
      // `update_plan = { enabled = … }` or `tools = { … }`: an inline table we
      // will not rewrite by hand.
      if (value.startsWith("{")) return { state: "unsupported", managed, sectionHeader };
    }
  }
  return { state, managed, sectionHeader };
}

export type PlanToolStatus =
  | "enabled"        // written just now
  | "already-enabled"
  | "would-enable"
  | "user-disabled"  // explicit false — left alone
  | "removed"
  | "not-present"
  | "would-remove"
  | "kept"           // present, but not ours (or edited by hand)
  | "unsupported";

export interface PlanToolPlan {
  status: PlanToolStatus;
  detail: string;
  /** Set only when the file content must change. */
  next?: string;
}

/** Pure planner: what enabling the plan tool would do to this config text. */
export function planPlanToolEnable(source: string): PlanToolPlan {
  const { state, sectionHeader } = inspectPlanTool(source);
  if (state === "enabled") {
    return { status: "already-enabled", detail: `${PLAN_TOOL_KEY} is already true` };
  }
  if (state === "disabled") {
    return {
      status: "user-disabled",
      detail: `${PLAN_TOOL_KEY} is false in your Codex config — left untouched; the plan hook lane stays silent until you set it to true`,
    };
  }
  if (state === "unsupported") {
    return {
      status: "unsupported",
      detail: `cannot read ${PLAN_TOOL_KEY} in this config shape — set it to true by hand so the plan hook lane can fire`,
    };
  }
  if (sectionHeader) {
    const lines = source.split("\n");
    const at = lines.findIndex((line) => SUBTABLE_HEADER.test(line));
    lines.splice(at + 1, 0, MANAGED_LINES.replace(/\n$/, ""));
    return {
      status: "enabled",
      detail: `set ${PLAN_TOOL_KEY} = true (Codex ships its planning tool off; the plan hook lane needs it)`,
      next: lines.join("\n"),
    };
  }
  const base = source === "" || source.endsWith("\n") ? source : `${source}\n`;
  return {
    status: "enabled",
    detail: `set ${PLAN_TOOL_KEY} = true (Codex ships its planning tool off; the plan hook lane needs it)`,
    next: `${base}${MANAGED_BLOCK}`,
  };
}

/** Pure planner: what uninstalling would do to this config text. */
export function planPlanToolRemoval(source: string): PlanToolPlan {
  if (source.includes(MANAGED_BLOCK)) {
    return {
      status: "removed",
      detail: `removed the bastra-managed ${PLAN_TOOL_KEY} block`,
      next: source.replace(MANAGED_BLOCK, ""),
    };
  }
  if (source.includes(MANAGED_LINES)) {
    return {
      status: "removed",
      detail: `removed the bastra-managed ${PLAN_TOOL_KEY} setting`,
      next: source.replace(MANAGED_LINES, ""),
    };
  }
  if (source.includes(PLAN_TOOL_MARKER)) {
    return {
      status: "kept",
      detail: `${PLAN_TOOL_KEY} carries the bastra marker but was edited by hand — left in place`,
    };
  }
  const { state } = inspectPlanTool(source);
  if (state === "absent") return { status: "not-present", detail: `${PLAN_TOOL_KEY} not set by bastra` };
  return { status: "kept", detail: `${PLAN_TOOL_KEY} is your own setting — left in place` };
}

async function readConfigText(configPath: string): Promise<string | { error: string }> {
  if (!(await fileExists(configPath))) return "";
  try {
    return await readFile(configPath, "utf8");
  } catch (e) {
    return { error: `cannot read ${configPath}: ${(e as Error).message}` };
  }
}

async function atomicWriteText(configPath: string, text: string): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, configPath);
}

/**
 * Apply the plan-tool opt-in to a real config file. Idempotent: a second run
 * finds the key already true and writes nothing.
 */
export async function ensureCodexPlanTool(
  action: "install" | "uninstall",
  opts: { dryRun: boolean; configPath: string },
): Promise<{ status: PlanToolStatus | "error"; detail: string; backupPath?: string }> {
  const source = await readConfigText(opts.configPath);
  if (typeof source !== "string") return { status: "error", detail: source.error };
  const plan = action === "install" ? planPlanToolEnable(source) : planPlanToolRemoval(source);
  if (!plan.next) return { status: plan.status, detail: plan.detail };
  if (opts.dryRun) {
    return action === "install"
      ? { status: "would-enable", detail: `would ${plan.detail}` }
      : { status: "would-remove", detail: `would ${plan.detail}` };
  }
  const backupPath = await backupConfig(opts.configPath);
  await atomicWriteText(opts.configPath, plan.next);
  return { status: plan.status, detail: plan.detail, backupPath: backupPath ?? undefined };
}
