/** Complete, scoped rule catalog. No relevance search, embeddings or top-k. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { computeStaleness, memoryRevision, parseMemory, resolveRulebook, stripAutoRelatedSection,
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
  entries: KernelEntry[]; omitted: number;
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

export async function collectRulebookCatalog(vault: Pick<Vault, "get" | "list">, opts: {
  project: string | null; active: readonly ActiveConvention[];
  floors?: (project: string | null) => Promise<FloorEntry[]>; allProjects?: boolean;
}): Promise<KernelCandidates> {
  const active = new Set(opts.active.map(a => a.id));
  const floors = await (opts.floors ? opts.floors(opts.project) : listFloors(opts.project ?? undefined)).catch(() => []);
  const pinned = new Set(floors.filter(f => opts.allProjects || opts.project || !f.scope).map(f => f.memory_id));
  const inScope = (m: Memory) => opts.allProjects || !m.fm.scope || (opts.project
    ? isScopeCompatible(m.fm.scope, opts.project) : GLOBAL_SCOPES.has(normalizeScopeKey(m.fm.scope)));
  let unconfirmed = 0, unavailableSources = 0;
  const entries: KernelEntry[] = [];
  const inspect = async (indexed: Memory) => {
    if (!servable(indexed)) return;
    const context = { activeConvention: active.has(indexed.fm.id), floor: pinned.has(indexed.fm.id) };
    let m = indexed, revision: string | null = null, unavailable = false;
    if (m.filePath) {
      try {
        const raw = await readFile(m.filePath, "utf8");
        m = parseMemory(raw, m.filePath, m.mtime ?? 0); revision = memoryRevision(raw);
        if (m.fm.id !== indexed.fm.id) { unavailableSources++; return; }
      } catch { unavailable = true; unavailableSources++; }
    }
    if (!servable(m)) return;
    // Global review backlog: count it even if the rule belongs to another project.
    if (possibleLegacy(m)) unconfirmed++;
    if (!inScope(m)) return;
    const declaration = resolveRulebook(m.fm, context);
    if (!declaration) return;
    const body = unavailable ? "" : cleanRuleText(stripAutoRelatedSection(m.body)).trim();
    const binding_hash = hash([m.fm.id, m.fm.title, m.fm.scope, declaration, body, m.fm.validator]);
    entries.push({ id: m.fm.id, title: oneLine(m.fm.title), scope: m.fm.scope, ...(m.fm.validator ? { validator: m.fm.validator } : {}),
      group: active.has(m.fm.id) ? "active-convention" : pinned.has(m.fm.id) ? "floor" :
        m.fm.rulebook ? "explicit" : m.fm.recall_mode === "reflex" ? "reflex" : "user-directed",
      revision, updated: m.fm.updated ?? null, stale_status: computeStaleness(m.fm),
      body: declaration.rulebook === "always" ? body : "", binding_hash,
      ...declaration, ...(unavailable ? { source_unavailable: true } : {}) });
  };
  // Bound file descriptors while still checking every indexed source. Cached
  // non-rule metadata cannot hide a newly user-directed rule from the catalog.
  const indexed = vault.list();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, indexed.length) }, async () => {
    for (;;) { const i = next++; if (i >= indexed.length) return; await inspect(indexed[i]); }
  }));
  entries.sort((a, b) => Number(b.rulebook === "always") - Number(a.rulebook === "always") ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const c: KernelCandidates = { entries, omitted: 0, unconfirmed_legacy: unconfirmed, unavailable_sources: unavailableSources, project: opts.project };
  c.catalog_hash = catalogHash(c);
  return c;
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
      const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (decoded.project === null || typeof decoded.project === "string") project = decoded.project;
    } catch { /* malformed cursor restarts from the caller scope */ }
  }
  return rulebookPage(await collectRulebookCatalog(deps.vault, { project,
    active: state?.activeConventions ?? [] }), input.cursor);
}
