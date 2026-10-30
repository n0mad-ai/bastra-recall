/** Hook projections use the Vault index; direct MCP reads retain byte-source
 * validation. Both pair revision, validator and rulebook metadata coherently. */
import { readFile } from "node:fs/promises";
import { parseMemory, memoryRevision, resolveRulebook, type Memory, type Vault,
  type ConventionValidator, type Frontmatter, type RulebookDeclaration, type RulebookLegacyContext } from "@bastra-recall/core";
import { listFloors } from "./floors.js";
import { loadSessionState } from "./session-state.js";

export type RulebookMetadata = Partial<RulebookDeclaration> & Pick<Frontmatter, "rulebook_proposed" | "rule_categories">;
export interface ConventionSource {
  matchesIndex?: boolean;
  hiddenFromPublic?: boolean;
  summary?: string;
  write_origin?: "user-directed" | "agent-session" | "capture-review";
  rulebookMetadata?: RulebookMetadata;
  revision: string | null;
  validator?: ConventionValidator;
}

export function projectRulebookMetadata(fm: Frontmatter, context: RulebookLegacyContext = {}): RulebookMetadata {
  return { ...resolveRulebook(fm, context),
    ...(fm.rule_categories ? {rule_categories:fm.rule_categories} : {}),
    ...(fm.applies_when !== undefined ? { applies_when: fm.applies_when } : {}),
    ...(fm.rulebook_proposed ? { rulebook_proposed: fm.rulebook_proposed } : {}) };
}

export async function readConventionSource(
  memory: (Pick<Memory, "filePath" | "fm"> & Partial<Pick<Memory, "body">>) | undefined,
  includeRuleMetadata = false,
  context: RulebookLegacyContext = {},
): Promise<ConventionSource> {
  if (!memory?.filePath) return { revision: null };
  try {
    const raw = await readFile(memory.filePath, "utf8");
    const revision = memoryRevision(raw);
    try {
      const parsed = parseMemory(raw, memory.filePath, 0);
      if (parsed.fm.id !== memory.fm.id) return { revision, hiddenFromPublic: true };
      return {
        revision,
        rulebookMetadata: projectRulebookMetadata(parsed.fm, context),
        matchesIndex: memory.body === parsed.body &&
          JSON.stringify({ ...memory.fm, validator: undefined }) === JSON.stringify({ ...parsed.fm, validator: undefined }),
        hiddenFromPublic: parsed.fm.sensitivity === "private",
        ...(parsed.fm.validator ? { validator: parsed.fm.validator } : {}),
        ...(includeRuleMetadata ? { summary: parsed.fm.summary, write_origin: parsed.fm.write_origin } : {}),
      };
    } catch { return { revision }; }
  } catch { return { revision: null }; }
}

/** One active/floor context per response, shared by index and current-source paths. */
export async function readRulebookContext(sessionId?: string | null): Promise<(id: string) => RulebookLegacyContext> {
  const [state, floors] = await Promise.all([
    sessionId ? loadSessionState(sessionId) : undefined,
    listFloors(),
  ]);
  const activeIds = new Set(state?.activeConventions?.map(c => c.id));
  const floorIds = new Set(floors.map(f => f.memory_id));
  return id => ({ activeConvention: activeIds.has(id), floor: floorIds.has(id) });
}

/** Direct MCP recall/load validate current bytes independently of hook projections. */
export async function readCurrentRulebookSources(
  vault: Pick<Vault, "get">, ids: readonly string[], sessionId?: string | null,
): Promise<Map<string, ConventionSource>> {
  const contextOf = await readRulebookContext(sessionId);
  return new Map(await Promise.all([...new Set(ids)].map(async id => [id,
    await readConventionSource(vault.get(id), true, contextOf(id)),
  ] as const)));
}

/** The already indexed source, including its paired byte revision. No file IO. */
export function indexedConventionSource(
  memory: Pick<Memory, "fm"> & Partial<Pick<Memory, "revision">> | undefined,
  includeRuleMetadata = false, context: RulebookLegacyContext = {},
): ConventionSource {
  if (!memory) return { revision: null };
  return {
    revision: memory.revision ?? null, matchesIndex: true,
    hiddenFromPublic: memory.fm.sensitivity === "private",
    rulebookMetadata: projectRulebookMetadata(memory.fm, context),
    ...(memory.fm.validator ? { validator: memory.fm.validator } : {}),
    ...(includeRuleMetadata ? { summary: memory.fm.summary, write_origin: memory.fm.write_origin } : {}),
  };
}

/** Hook recall metadata uses only the in-memory index, including candidatePool.
 * Missed cloud events follow the same watcher/reconcile boundary as the kernel. */
export async function readRulebookSources(
  vault: Pick<Vault, "get">, ids: readonly string[], sessionId?: string | null,
): Promise<Map<string, ConventionSource>> {
  const contextOf = await readRulebookContext(sessionId);
  return new Map([...new Set(ids)].map(id => [id, indexedConventionSource(vault.get(id), true, contextOf(id))]));
}

export function vaultConventionOf(vault: Pick<Vault, "get">): (id: string) => Promise<ConventionSource> {
  return async id => indexedConventionSource(vault.get(id));
}
