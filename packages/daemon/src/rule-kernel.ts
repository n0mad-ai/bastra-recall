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
 * truncated rule reads like a complete one. Full texts get room before fallback IDs.
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
/** Legacy body-size hint; group priority now determines delivery order. */
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

/** Full rules get the budget first in group priority; fallbacks carry only IDs. */
export function renderRuleKernel(
  candidates: KernelCandidates,
  opts: { trigger: string; lexicalOnly?: boolean },
): RenderedKernel {
  if (!candidates.entries.length) return { text: "", full: [], degraded: [], omitted: 0 };
  const open = `<rule-kernel trigger="${opts.trigger}">`;
  const intro = `Rules in force (${opts.trigger}): complete texts below in priority order. ` +
    `Degraded IDs require load_memory(id) before acting; additional rules may be omitted by the ${RULE_KERNEL_CHAR_BUDGET}-character bound.`;
  const lines = [open, intro, ...(opts.lexicalOnly ? [RULE_KERNEL_LEXICAL_LINE] : [])];
  const tail = [RULE_KERNEL_ASK_LINE, "</rule-kernel>"];
  const omittedLine = (n: number) => `+${n} more rule(s) not listed: over the ${RULE_KERNEL_CHAR_BUDGET}-character bound.`;
  const reserve = omittedLine(candidates.entries.length + candidates.omitted).length + 1;
  let used = [...lines, ...tail].join("\n").length;
  const groups: KernelGroup[] = ["active-convention", "floor", "reflex", "user-directed"];
  const entries = candidates.entries.map((e, i) => ({ e, i }))
    .sort((a, b) => groups.indexOf(a.e.group) - groups.indexOf(b.e.group) || a.i - b.i).map(({ e }) => e);
  const full: string[] = [], deferred: KernelEntry[] = [], degraded: string[] = [];
  for (const e of entries) {
    const cost = entryHead(e).length + e.body.length + 2;
    if (!e.body || used + cost + reserve > RULE_KERNEL_CHAR_BUDGET) { deferred.push(e); continue; }
    lines.push(entryHead(e), e.body); full.push(e.id); used += cost;
  }
  for (const e of deferred) {
    const line = degradedLine(e);
    if (used + line.length + 1 + reserve > RULE_KERNEL_CHAR_BUDGET) continue;
    lines.push(line); degraded.push(e.id); used += line.length + 1;
  }
  const omitted = candidates.omitted + deferred.length - degraded.length;
  if (omitted) lines.push(omittedLine(omitted));
  lines.push(...tail);
  return { text: lines.join("\n"), full, degraded, omitted };
}
