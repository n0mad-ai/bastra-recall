/** Read revision, validator and rulebook projection from the same current file.
 * The index locates the source; all public projections share this reader. */
import { readFile } from "node:fs/promises";
import { parseMemory, memoryRevision, resolveRulebook, type Memory, type Vault,
  type ConventionValidator, type Frontmatter, type RulebookDeclaration, type RulebookLegacyContext } from "@bastra-recall/core";
import { listFloors } from "./floors.js";
import { loadSessionState } from "./session-state.js";

export type RulebookMetadata = Partial<RulebookDeclaration> & Pick<Frontmatter, "rulebook_proposed">;
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

/** One context snapshot per response, shared by recall, hook, load and edits. */
export async function readRulebookContext(sessionId?: string | null): Promise<(id: string) => RulebookLegacyContext> {
  const [state, floors] = await Promise.all([
    sessionId ? loadSessionState(sessionId) : undefined,
    listFloors(),
  ]);
  const activeIds = new Set(state?.activeConventions?.map(c => c.id));
  const floorIds = new Set(floors.map(f => f.memory_id));
  return id => ({ activeConvention: activeIds.has(id), floor: floorIds.has(id) });
}

export async function readRulebookSources(
  vault: Pick<Vault, "get">, ids: readonly string[], sessionId?: string | null,
): Promise<Map<string, ConventionSource>> {
  const contextOf = await readRulebookContext(sessionId);
  return new Map(await Promise.all([...new Set(ids)].map(async id => [id,
    await readConventionSource(vault.get(id), true, contextOf(id)),
  ] as const)));
}

export function vaultConventionOf(vault: Pick<Vault, "get">): (id: string) => Promise<ConventionSource> {
  return (id) => readConventionSource(vault.get(id));
}
