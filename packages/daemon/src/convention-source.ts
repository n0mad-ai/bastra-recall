/** Hook projections use the Vault index; direct MCP reads retain byte-source
 * validation. Both pair revision, validator and rulebook metadata coherently. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  parseMemory,
  pastValidUntil,
  memoryRevision,
  resolveRulebook,
  type Memory,
  type Vault,
  type ConventionValidator,
  type Frontmatter,
  type RulebookDeclaration,
  type RulebookLegacyContext,
} from "@bastra-recall/core";
import { listFloors } from "./floors.js";
import { loadSessionState } from "./session-state.js";

export type RulebookMetadata = Partial<RulebookDeclaration> &
  Pick<Frontmatter, "rulebook_proposed" | "rule_categories">;
export interface ConventionSource {
  matchesIndex?: boolean;
  /** Authored triggers from the same source; used for own-user channel evidence. */
  recall_when?: string[];
  hiddenFromPublic?: boolean;
  expired?: true;
  /** #1696: the note is authoritatively gone from a complete, reachable index (not a read failure). */
  absent?: true;
  vaultIdentity?: string;
  summary?: string;
  write_origin?: "user-directed" | "agent-session" | "capture-review";
  rulebookMetadata?: RulebookMetadata;
  revision: string | null;
  validator?: ConventionValidator;
}

export function activeConventionValidator(source: ConventionSource): ConventionValidator | undefined {
  return source.hiddenFromPublic || source.expired ? undefined : source.validator;
}

function projectRulebookMetadata(fm: Frontmatter, context: RulebookLegacyContext = {}): RulebookMetadata {
  return {
    ...resolveRulebook(fm, context),
    ...(fm.rule_categories ? { rule_categories: fm.rule_categories } : {}),
    ...(fm.applies_when !== undefined ? { applies_when: fm.applies_when } : {}),
    ...(fm.rulebook_proposed ? { rulebook_proposed: fm.rulebook_proposed } : {}),
  };
}

export async function readConventionSource(
  memory: (Pick<Memory, "filePath" | "fm"> & Partial<Pick<Memory, "body" | "mtime">>) | undefined,
  includeRuleMetadata = false,
  context: RulebookLegacyContext = {}
): Promise<ConventionSource> {
  if (!memory?.filePath) return { revision: null };
  try {
    const raw = await readFile(memory.filePath, "utf8");
    const revision = memoryRevision(raw);
    try {
      // Compare against the indexed view using the same fallback date for missing or damaged fields.
      const parsed = parseMemory(raw, memory.filePath, memory.mtime ?? 0);
      if (parsed.fm.id !== memory.fm.id) return { revision, hiddenFromPublic: true };
      return {
        revision,
        ...(pastValidUntil(parsed.fm) ? { expired: true } : {}),
        recall_when: parsed.fm.recall_when,
        rulebookMetadata: projectRulebookMetadata(parsed.fm, context),
        matchesIndex:
          memory.body === parsed.body &&
          JSON.stringify({ ...memory.fm, validator: undefined }) ===
            JSON.stringify({ ...parsed.fm, validator: undefined }),
        hiddenFromPublic: parsed.fm.sensitivity === "private",
        ...(parsed.fm.validator && !parsed.fm.obsolete && !parsed.fm.superseded_by
          ? { validator: parsed.fm.validator }
          : {}),
        ...(includeRuleMetadata ? { summary: parsed.fm.summary, write_origin: parsed.fm.write_origin } : {}),
      };
      // #1334: a source that cannot be judged counts as hidden (as hiddenOnDisk).
    } catch {
      return { revision, hiddenFromPublic: true };
    }
  } catch {
    return { revision: null, hiddenFromPublic: true };
  }
}

/** One active/floor context per response, shared by index and current-source paths. */
async function readRulebookContext(sessionId?: string | null): Promise<(id: string) => RulebookLegacyContext> {
  const [state, floors] = await Promise.all([sessionId ? loadSessionState(sessionId) : undefined, listFloors()]);
  const activeIds = new Set(state?.activeConventions?.map((c) => c.id));
  const floorIds = new Set(floors.map((f) => f.memory_id));
  return (id) => ({ activeConvention: activeIds.has(id), floor: floorIds.has(id) });
}

/** Direct MCP recall/load validate current bytes independently of hook projections. */
export async function readCurrentRulebookSources(
  vault: Pick<Vault, "get">,
  ids: readonly string[],
  sessionId?: string | null
): Promise<Map<string, ConventionSource>> {
  const contextOf = await readRulebookContext(sessionId);
  return new Map(
    await Promise.all(
      [...new Set(ids)].map(async (id) => [id, await readConventionSource(vault.get(id), true, contextOf(id))] as const)
    )
  );
}

/** The already indexed source, including its paired byte revision. No file IO. */
export function indexedConventionSource(
  memory: (Pick<Memory, "fm"> & Partial<Pick<Memory, "revision">>) | undefined,
  includeRuleMetadata = false,
  context: RulebookLegacyContext = {}
): ConventionSource {
  if (!memory) return { revision: null };
  return {
    revision: memory.revision ?? null,
    matchesIndex: true,
    ...(pastValidUntil(memory.fm) ? { expired: true } : {}),
    recall_when: memory.fm.recall_when,
    hiddenFromPublic: memory.fm.sensitivity === "private",
    rulebookMetadata: projectRulebookMetadata(memory.fm, context),
    ...(memory.fm.validator && !memory.fm.obsolete && !memory.fm.superseded_by
      ? { validator: memory.fm.validator }
      : {}),
    ...(includeRuleMetadata ? { summary: memory.fm.summary, write_origin: memory.fm.write_origin } : {}),
  };
}

/** Hook recall metadata uses only the in-memory index, including candidatePool.
 * Missed cloud events follow the same watcher/reconcile boundary as the kernel. */
export async function readRulebookSources(
  vault: Pick<Vault, "get">,
  ids: readonly string[],
  sessionId?: string | null
): Promise<Map<string, ConventionSource>> {
  const contextOf = await readRulebookContext(sessionId);
  return new Map([...new Set(ids)].map((id) => [id, indexedConventionSource(vault.get(id), true, contextOf(id))]));
}

type HookVault = Pick<Vault, "get"> & Partial<Pick<Vault, "indexRootIdentity" | "confirmsAbsent">>;

export function vaultConventionOf(vault: HookVault): (id: string) => Promise<ConventionSource> {
  const root = vault.indexRootIdentity?.();
  const vaultIdentity = root ? createHash("sha256").update(root).digest("hex") : undefined;
  return async (id) => {
    let memory = vault.get(id);
    if (vaultIdentity && !memory) {
      if (await vault.confirmsAbsent?.(id)) return { revision: null, absent: true, vaultIdentity };
      memory = vault.get(id);
    }
    return { ...indexedConventionSource(memory), vaultIdentity };
  };
}
