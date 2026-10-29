/**
 * The rule kernel (#1305): the full bodies of the rules in force, delivered
 * after compact, clear or fork (session lane) and again after
 * {@link RULE_KERNEL_TOOL_CALLS} tool calls without a prompt (gate lane).
 *
 * Order is priority: (1) the session's active conventions, (2) floors,
 * (3) reflex memories, (4) user-directed `user-preference` / `meta-working`
 * memories by salience. Bodies come from the daemon's vault index, never from
 * a recall, so the kernel costs no search and no embedding.
 *
 * One explicit local bound, {@link RULE_KERNEL_CHAR_BUDGET} characters for the
 * whole block. A body is delivered whole or not at all: one that does not fit
 * is replaced by `degraded: load_memory(<id>)`. A rule is never cut, because a
 * truncated rule reads like a complete one. The per-body figure only orders
 * who gets the room first; it never cuts.
 *
 * Shadow accounting is the caller's: the session lane charges its whole
 * block, the gate lane charges the re-delivery (session-budget.ts).
 */
import { readFile } from "node:fs/promises";
import type { Memory, Vault } from "@bastra-recall/core";
import { computeStaleness, memoryRevision, stripAutoRelatedSection, type StaleStatus } from "@bastra-recall/core";
import { stripFenceMarkers } from "@bastra-recall/core/scrub";
import { GLOBAL_SCOPES, isScopeCompatible, normalizeScopeKey } from "@bastra-recall/core/scope";
import { listFloors, type FloorEntry } from "./floors.js";
import { isReflexPoolMember } from "./reflex.js";
import type { ActiveConvention } from "./session-state.js";

/** The whole block, tags and all, stays at or below this many characters. */
export const RULE_KERNEL_CHAR_BUDGET = 6000;
/** Bodies up to this size get the room before longer ones (after the active
 *  conventions). An ordering criterion only — never a cut. */
export const RULE_KERNEL_SHORT_BODY_CHARS = 1500;
/** Tool calls without a user prompt after which the gate lane re-delivers. */
export const RULE_KERNEL_TOOL_CALLS = 25;
/** Candidates whose revision is read from disk; the rest are counted as
 *  omitted. At ~100 characters per entry line the bound fits fewer anyway. */
export const RULE_KERNEL_MAX_ENTRIES = 40;

export const RULE_KERNEL_ASK_LINE =
  "If a rule here seems unclear or outdated, ask the user with a choice box before deviating; never silently ignore it.";
export const RULE_KERNEL_LEXICAL_LINE = "lexical-only: kernel built from floors, reflex and user-directed rules only";

export type KernelGroup = "active-convention" | "floor" | "reflex" | "user-directed";

export interface KernelEntry {
  id: string;
  title: string;
  group: KernelGroup;
  /** `memoryRevision` of the file on disk; null when it could not be read. */
  revision: string | null;
  updated: string | null;
  stale_status: StaleStatus | "unknown";
  /** Scrubbed body; "" when the memory has none. */
  body: string;
}

export interface KernelCandidates {
  entries: KernelEntry[];
  /** Candidates past {@link RULE_KERNEL_MAX_ENTRIES}. */
  omitted: number;
}

const USER_DIRECTED_TYPES = new Set(["user-preference", "meta-working"]);

/** What the hook path may serve at all: nothing obsolete, private or superseded. */
function servable(m: Memory): boolean {
  return m.fm.obsolete !== true && m.fm.sensitivity !== "private" && !m.fm.superseded_by;
}

/** A project rule belongs to its project; without a project only global scopes. */
function inScope(m: Memory, project: string | null): boolean {
  const scope = typeof m.fm.scope === "string" ? m.fm.scope : "";
  if (!scope) return true;
  return project ? isScopeCompatible(scope, project) : GLOBAL_SCOPES.has(normalizeScopeKey(scope));
}

const salience = (m: Memory): number => (typeof m.fm.salience === "number" ? m.fm.salience : 0);
const bySalience = (a: Memory, b: Memory): number =>
  salience(b) - salience(a) || String(b.fm.updated ?? "").localeCompare(String(a.fm.updated ?? ""));

/**
 * The kernel's candidates in priority order, deduplicated, bodies and
 * revisions resolved. Reads the vault index and at most
 * {@link RULE_KERNEL_MAX_ENTRIES} files for their revision.
 */
export async function collectRuleKernel(
  vault: Pick<Vault, "get" | "list">,
  opts: {
    project: string | null;
    active: readonly ActiveConvention[];
    floors?: (project: string | null) => Promise<FloorEntry[]>;
  },
): Promise<KernelCandidates> {
  const picked: Array<{ m: Memory; group: KernelGroup }> = [];
  const seen = new Set<string>();
  const take = (m: Memory | undefined, group: KernelGroup): void => {
    if (!m || seen.has(m.fm.id) || !servable(m)) return;
    seen.add(m.fm.id);
    picked.push({ m, group });
  };

  // Newest first: the convention set last is the one the task is under.
  for (const a of [...opts.active].sort((x, y) => y.setAt - x.setAt)) {
    const m = vault.get(a.id);
    if (m && inScope(m, opts.project)) take(m, "active-convention");
  }

  const floors = await (opts.floors ?? defaultFloors)(opts.project).catch(() => [] as FloorEntry[]);
  for (const f of floors) take(vault.get(f.memory_id), "floor");

  const all = vault.list().filter((m) => servable(m) && inScope(m, opts.project));
  for (const m of all.filter(isReflexPoolMember).sort(bySalience)) take(m, "reflex");
  for (const m of all
    .filter((m) => m.fm.write_origin === "user-directed" && USER_DIRECTED_TYPES.has(String(m.fm.type)))
    .sort(bySalience)) {
    take(m, "user-directed");
  }

  const kept = picked.slice(0, RULE_KERNEL_MAX_ENTRIES);
  const entries = await Promise.all(
    kept.map(async ({ m, group }): Promise<KernelEntry> => {
      const revision = m.filePath
        ? await readFile(m.filePath, "utf8").then(memoryRevision, () => null)
        : null;
      return {
        id: m.fm.id,
        title: oneLine(stripFenceMarkers(String(m.fm.title ?? ""))),
        group,
        revision,
        updated: typeof m.fm.updated === "string" ? m.fm.updated : null,
        stale_status: computeStaleness(m.fm),
        body: stripFenceMarkers(stripAutoRelatedSection(m.body ?? "").trim()),
      };
    }),
  );
  return { entries, omitted: picked.length - kept.length };
}

/** The session lane's floor rule: without a project only unscoped floors. */
async function defaultFloors(project: string | null): Promise<FloorEntry[]> {
  const all = await listFloors(project ?? undefined);
  return project ? all : all.filter((e) => !e.scope);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function entryHead(e: KernelEntry): string {
  return (
    `- [${e.group}] ${e.id} "${e.title}" revision=${e.revision ?? "unknown"} updated=${e.updated ?? "unknown"}` +
    ` stale_status=${e.stale_status ?? "unknown"}`
  );
}

const degradedLine = (e: KernelEntry): string => `degraded: load_memory(${e.id})`;

export interface RenderedKernel {
  /** "" when there is nothing to deliver. */
  text: string;
  /** Ids delivered with their full body. */
  full: string[];
  /** Ids delivered as `degraded: load_memory(id)`. */
  degraded: string[];
  /** Candidates not listed at all: past the entry cap or the char bound. */
  omitted: number;
}

/**
 * Render the `<rule-kernel>` block within {@link RULE_KERNEL_CHAR_BUDGET}.
 *
 * 1. Every entry gets its head line and, provisionally, its degraded line, in
 *    priority order, while that skeleton fits; the rest is counted as omitted.
 * 2. Bodies replace degraded lines while they fit whole: active conventions
 *    first, then bodies up to {@link RULE_KERNEL_SHORT_BODY_CHARS}, then the
 *    longer ones, each in priority order.
 * 3. The block is printed in priority order; its last line is the ask line.
 */
export function renderRuleKernel(
  candidates: KernelCandidates,
  opts: { trigger: string; lexicalOnly?: boolean },
): RenderedKernel {
  const empty: RenderedKernel = { text: "", full: [], degraded: [], omitted: 0 };
  if (candidates.entries.length === 0) return empty;

  const open = `<rule-kernel trigger="${opts.trigger}">`;
  const intro =
    `Rules in force, restored in full (${opts.trigger}): active conventions first, then floors, reflex rules and ` +
    `user-directed preferences. A "degraded" line means the body did not fit this ` +
    `${RULE_KERNEL_CHAR_BUDGET}-character block — load_memory(id) before acting under that rule.`;
  const close = "</rule-kernel>";
  const fixed = [open, intro, ...(opts.lexicalOnly ? [RULE_KERNEL_LEXICAL_LINE] : []), RULE_KERNEL_ASK_LINE, close];
  // One newline per line; `+ 1` per added line below accounts for its own.
  let used = fixed.join("\n").length;
  const omittedLine = (n: number): string => `+${n} more rule(s) not listed: over the ${RULE_KERNEL_CHAR_BUDGET}-character bound.`;
  // Reserve room for the omitted line at its widest; released when unused.
  const reserve = omittedLine(candidates.entries.length + candidates.omitted).length + 1;

  const listed: KernelEntry[] = [];
  for (const e of candidates.entries) {
    const cost = entryHead(e).length + 1 + degradedLine(e).length + 1;
    if (used + cost + reserve > RULE_KERNEL_CHAR_BUDGET) break;
    used += cost;
    listed.push(e);
  }
  const omitted = candidates.entries.length - listed.length + candidates.omitted;
  if (listed.length === 0) return empty;
  if (omitted > 0) used += omittedLine(omitted).length + 1;

  const rank = (e: KernelEntry): number =>
    e.group === "active-convention" ? 0 : e.body.length <= RULE_KERNEL_SHORT_BODY_CHARS ? 1 : 2;
  const withBody = new Set<string>();
  for (const e of listed.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map((x) => x.e)) {
    if (e.body === "") continue;
    const delta = e.body.length - degradedLine(e).length;
    if (used + delta > RULE_KERNEL_CHAR_BUDGET) continue;
    used += delta;
    withBody.add(e.id);
  }

  const lines = [open, intro, ...(opts.lexicalOnly ? [RULE_KERNEL_LEXICAL_LINE] : [])];
  for (const e of listed) lines.push(entryHead(e), withBody.has(e.id) ? e.body : degradedLine(e));
  if (omitted > 0) lines.push(omittedLine(omitted));
  lines.push(RULE_KERNEL_ASK_LINE, close);
  return {
    text: lines.join("\n"),
    full: listed.filter((e) => withBody.has(e.id)).map((e) => e.id),
    degraded: listed.filter((e) => !withBody.has(e.id)).map((e) => e.id),
    omitted,
  };
}
