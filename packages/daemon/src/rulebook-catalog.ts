/** Complete, scoped rule catalog. No relevance search, embeddings or top-k. */
import { createHash } from "node:crypto";
import {readRulebookSources,rulebookSources,RULEBOOK_SOURCE_TTL_MS,type RulebookSource} from "./rulebook-snapshot.js";
import { z } from "zod";
import { computeStaleness, resolveRulebook, stripAutoRelatedSection,
  type Memory, type Vault, type StaleStatus } from "@bastra-recall/core";
import { stripFenceMarkers } from "@bastra-recall/core/scrub";
import { GLOBAL_SCOPES, isScopeCompatible, normalizeScopeKey } from "@bastra-recall/core/scope";
import { listFloors, type FloorEntry } from "./floors.js";
import { loadSessionState, type ActiveConvention } from "./session-state.js";
import { callerSessionStore } from "./caller-session.js";
import type { ToolDeps } from "./tool-deps.js";

export type KernelGroup = "active-convention" | "floor" | "reflex" | "user-directed" | "explicit";
export interface KernelEntry {
  id: string; title: string; group: KernelGroup; revision: string | null;
  updated: string | null; stale_status: StaleStatus | "unknown"; body: string;
  rulebook?: "always" | "on-demand"; applies_when?: string; applies_when_derived?: true;
  source_unavailable?: boolean; binding_hash?: string; scope?: string; validator?: Memory["fm"]["validator"];
}
export interface KernelCandidates {
  entries: KernelEntry[]; omitted: number; ids_only?: true; fallback?: true;
  catalog_hash?: string; unconfirmed_legacy?: number; unavailable_sources?: number; project?: string | null;
}
export const RULEBOOK_INDEX_CHAR_BUDGET = 8000;
export const cleanRuleText = (s: string): string => stripFenceMarkers(s.replace(/\r\n?/g, "\n")
  .replace(/\t/g, "    ").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ""));
export const oneLine = (s: string): string => cleanRuleText(s).replace(/\s+/g, " ").trim();
const servable = (m: Memory): boolean => !m.fm.obsolete && m.fm.sensitivity !== "private" && !m.fm.superseded_by;
const possibleLegacy = (m: Memory): boolean => m.fm.write_origin !== "user-directed" && !m.fm.rulebook &&
  (m.fm.type === "user-preference" || m.fm.type === "meta-working" || m.fm.recall_mode === "reflex");
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
export function catalogHash(c: KernelCandidates): string {
  // Proposal metadata and incidental file revisions are deliberately excluded.
  return c.catalog_hash ?? hash(c.entries.map(e => e.binding_hash ?? [e.id, e.rulebook, e.title, e.scope, e.applies_when, e.body, e.validator]));
}

export type RulebookCatalogMode = "content" | "ids";
export interface RulebookCatalogOptions {
  project: string | null; active: readonly ActiveConvention[];
  floors?: (project: string | null) => Promise<FloorEntry[]>; allProjects?: boolean;
  mode?: RulebookCatalogMode; budgetMs?: number;
}
async function projectSources(sources: RulebookSource[], opts: RulebookCatalogOptions): Promise<KernelCandidates> {
  const active = new Set(opts.active.map(a => a.id));
  const floors = await (opts.floors ? opts.floors(opts.project) : listFloors(opts.project ?? undefined)).catch(() => []);
  const pinned = new Set(floors.filter(f => opts.allProjects || opts.project || !f.scope).map(f => f.memory_id));
  const inScope = (m: Memory) => opts.allProjects || !m.fm.scope || (opts.project
    ? isScopeCompatible(m.fm.scope, opts.project) : GLOBAL_SCOPES.has(normalizeScopeKey(m.fm.scope)));
  let unconfirmed = 0, unavailableSources = 0;
  const entries: KernelEntry[] = [];
  for (const source of sources) {
    const m = source.memory;
    if (!servable(m)) continue;
    // Unreadable source bytes cannot authorize a current privacy/content projection.
    if (source.unavailable) { unavailableSources++; continue; }
    if (possibleLegacy(m)) unconfirmed++;
    if (!inScope(m)) continue;
    const declaration = resolveRulebook(m.fm, { activeConvention: active.has(m.fm.id), floor: pinned.has(m.fm.id) });
    if (!declaration) continue;
    if (opts.mode === "ids") {
      entries.push({ id: m.fm.id, rulebook: declaration.rulebook, title: "", body: "", group: "explicit", revision: null, updated: null, stale_status: "unknown" });
      continue;
    }
    const body = cleanRuleText(stripAutoRelatedSection(m.body)).trim();
    entries.push({ id: m.fm.id, title: oneLine(m.fm.title), scope: m.fm.scope, ...(m.fm.validator ? { validator: m.fm.validator } : {}),
      group: active.has(m.fm.id) ? "active-convention" : pinned.has(m.fm.id) ? "floor" :
        m.fm.rulebook ? "explicit" : m.fm.recall_mode === "reflex" ? "reflex" : "user-directed",
      revision: source.revision, updated: m.fm.updated ?? null, stale_status: computeStaleness(m.fm),
      body: declaration.rulebook === "always" ? body : "",
      binding_hash: hash([m.fm.id, m.fm.title, m.fm.scope, declaration, body, m.fm.validator]), ...declaration });
  }
  entries.sort((a, b) => Number(b.rulebook === "always") - Number(a.rulebook === "always") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const c: KernelCandidates = { entries, omitted: 0, unconfirmed_legacy: unconfirmed, unavailable_sources: unavailableSources, project: opts.project,
    ...(opts.mode === "ids" ? { ids_only: true as const } : {}) };
  if (!c.ids_only) c.catalog_hash = catalogHash(c);
  return c;
}
export async function collectRulebookCatalog(vault: Pick<Vault, "get" | "list">, opts: RulebookCatalogOptions): Promise<KernelCandidates> {
  return projectSources(await readRulebookSources(vault), opts);
}

/** Shared bound for every hook-side catalog consumer, including injected providers.
 * Timed-out reads may finish in the background; callers must not chain late writes. */
export const RULEBOOK_CATALOG_BUDGET_MS = 150;
export async function withRulebookDeadline<T>(work: () => Promise<T>, deadline = Date.now() + RULEBOOK_CATALOG_BUDGET_MS): Promise<T> {
  if (Date.now() >= deadline) throw new Error("rulebook_catalog_timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([Promise.resolve().then(work), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("rulebook_catalog_timeout")), Math.max(0, deadline - Date.now()));
    })]);
    if (Date.now() >= deadline) throw new Error("rulebook_catalog_timeout");
    return result;
  } finally { if (timer) clearTimeout(timer); }
}

/** Content retains the existing two-second source validation interval. Only
 * internal IDs/counts may use SWR (at most 30 seconds, including a bounded
 * dirty interval while an event-coalesced rebuild completes). */
export const RULEBOOK_CACHE_TTL_MS = RULEBOOK_SOURCE_TTL_MS;
export const RULEBOOK_TOOL_BUDGET_MS = 5000;
export const RULEBOOK_STARTUP_BUDGET_MS = 800;
export async function cachedRulebookCatalog(
  vault: Pick<Vault, "get" | "list"> & Partial<Pick<Vault, "on">>, opts: RulebookCatalogOptions,
): Promise<KernelCandidates> {
  const deadline = Date.now() + (opts.budgetMs ?? RULEBOOK_TOOL_BUDGET_MS);
  let abandoned = false;
  try { return await withRulebookDeadline(async () => {
    while (!abandoned) {
      if (Date.now() >= deadline) throw new Error("rulebook_catalog_timeout");
      const view = await rulebookSources(vault, opts.mode === "ids");
      if (abandoned) break;
      const projected = await projectSources(view.sources, opts);
      // Floors are asynchronous too: recheck the event generation before publishing.
      if (view.isCurrent()) return projected;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error("rulebook_catalog_timeout");
  }, deadline); } finally { abandoned = true; }
}
/** Preserve the pre-C session kernel when a full snapshot is unavailable.
 * Read only indexed rule candidates, but validate their current bytes before delivery. */
export async function startupRulebookCatalog(
  vault: Pick<Vault, "get" | "list"> & Partial<Pick<Vault, "on">>, opts: RulebookCatalogOptions,
): Promise<KernelCandidates> {
  // Reserve room for the legacy fallback and response serialization inside the
  // Session-Lane's remaining time, including explicit small hook overrides.
  const total = Math.max(0, Math.min(opts.budgetMs ?? 1200, 1200) - 50);
  const deadline = Date.now() + total;
  const primary = Math.min(RULEBOOK_STARTUP_BUDGET_MS, total * 0.7);
  try { return await cachedRulebookCatalog(vault, { ...opts, mode: "content", budgetMs: primary }); }
  catch {
    try {
      return await withRulebookDeadline(async () => {
        const floors = await (opts.floors ? opts.floors(opts.project) : listFloors(opts.project ?? undefined)).catch(() => []);
        const active = new Set(opts.active.map(a => a.id)), pinned = new Set(floors.map(f => f.memory_id));
        const selected = vault.list().filter(m => resolveRulebook(m.fm, { activeConvention: active.has(m.fm.id), floor: pinned.has(m.fm.id) }));
        const result = await collectRulebookCatalog({ get: id => vault.get(id), list: () => selected }, { ...opts, mode: "content", floors: async () => floors });
        return { ...result, fallback: true as const };
      }, Math.min(deadline, Date.now() + 300));
    } catch { return { entries: [], omitted: 0, unavailable_sources: 1, fallback: true }; }
  }
}

/** Full IDs remain loadable; only presentation title/description are shortened. */
export function ruleIndexLine(e: KernelEntry): string {
  const title = oneLine(e.title).slice(0, 55);
  const room = Math.max(20, 194 - e.id.length - title.length);
  const description = oneLine(e.applies_when ?? "");
  const when = description.length > room ? description.slice(0, room - 1) + "…" : description;
  return `${e.id} — ${title} — ${when}`;
}
export function rulebookCursor(c: KernelCandidates, offset: number): string {
  return Buffer.from(JSON.stringify({ hash: catalogHash(c), offset, project: c.project ?? null }), "utf8").toString("base64url");
}
export function rulebookPage(c: KernelCandidates, cursor?: string, maxChars = RULEBOOK_INDEX_CHAR_BUDGET) {
  if (c.ids_only) throw new Error("IDs-only catalog cannot be delivered as content");
  let offset = 0, restarted = false;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (decoded.hash === catalogHash(c) && Number.isInteger(decoded.offset) && decoded.offset >= 0 && decoded.offset <= c.entries.length) offset = decoded.offset;
      else restarted = true;
    } catch { restarted = true; }
  }
  const start = offset;
  let used = 0;
  while (offset < c.entries.length) {
    const cost = ruleIndexLine(c.entries[offset]).length + 1;
    if (offset > start && used + cost > maxChars) break;
    used += cost; offset++;
  }
  return { catalog_hash: catalogHash(c), total: c.entries.length, offset: start,
    unconfirmed_legacy: c.unconfirmed_legacy ?? 0, unavailable_sources: c.unavailable_sources ?? 0,
    rules: c.entries.slice(start, offset).map(e => ({ id: e.id, title: e.title, scope: e.scope,
      rulebook: e.rulebook ?? "always", applies_when: e.applies_when ?? "",
      ...(e.applies_when_derived ? { applies_when_derived: true as const } : {}), revision: e.revision,
      ...(e.source_unavailable ? { source_unavailable: true } : {}) })),
    ...(offset < c.entries.length ? { next_cursor: rulebookCursor(c, offset) } : {}),
    end: offset === c.entries.length, ...(restarted ? { restarted: true as const } : {}) };
}
export const ListRulesArgs = z.object({ cursor: z.string().max(2048).optional() });
export async function listRulesHandler(deps: ToolDeps, args: unknown, ctx: { sessionId?: string | null; project?: string | null } = {}) {
  const input = ListRulesArgs.parse(args ?? {});
  const sid = ctx.sessionId ?? callerSessionStore.getStore();
  const state = sid ? await loadSessionState(sid) : undefined;
  let project = ctx.project ?? null;
  if (input.cursor) {
    try {
      // Scope is caller-selectable, including through the cursor. It is a
      // retrieval filter, not authorization; private entries remain excluded.
      const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (decoded.project === null || typeof decoded.project === "string") project = decoded.project;
    } catch { /* malformed cursor restarts from the caller scope */ }
  }
  return rulebookPage(await cachedRulebookCatalog(deps.vault, { project,
    active: state?.activeConventions ?? [], mode: "content", budgetMs: RULEBOOK_TOOL_BUDGET_MS }), input.cursor);
}
