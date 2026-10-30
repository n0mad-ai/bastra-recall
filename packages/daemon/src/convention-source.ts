/** #1323: read revision and validator from the SAME authoritative file bytes.
 * The index locates the file; a stale cached frontmatter must not pair a new
 * revision with an old (or removed) declaration. Never infer one from prose. */
import { readFile } from "node:fs/promises";
import { parseMemory, memoryRevision, type Memory, type Vault, type ConventionValidator, type Frontmatter } from "@bastra-recall/core";

export interface ConventionSource {
  matchesIndex?:boolean;
  hiddenFromPublic?:boolean;
  summary?:string;
  write_origin?:"user-directed"|"agent-session"|"capture-review";
  rulebookMetadata?: Pick<Frontmatter, "rulebook" | "applies_when" | "rulebook_proposed">;
  revision: string | null;
  validator?: ConventionValidator;
}

export async function readConventionSource(memory: (Pick<Memory, "filePath" | "fm"> & Partial<Pick<Memory,"body">>) | undefined,includeRuleMetadata=false): Promise<ConventionSource> {
  if (!memory?.filePath) return { revision: null };
  try {
    const raw = await readFile(memory.filePath, "utf8");
    const revision = memoryRevision(raw);
    // Invalid optional metadata is absent, just as on lenient vault load.
    try {
      const parsed = parseMemory(raw, memory.filePath, 0);
      const validator = parsed.fm.id === memory.fm.id ? parsed.fm.validator : undefined;
      return { revision, rulebookMetadata: parsed.fm.id === memory.fm.id ? {
        rulebook: parsed.fm.rulebook, applies_when: parsed.fm.applies_when,
        rulebook_proposed: parsed.fm.rulebook_proposed,
      } : undefined, matchesIndex:memory.body===parsed.body&&JSON.stringify({...memory.fm,validator:undefined})===JSON.stringify({...parsed.fm,validator:undefined}), ...(validator ? { validator } : {}),...(includeRuleMetadata?{hiddenFromPublic:parsed.fm.sensitivity==="private"}:{}),...(includeRuleMetadata&&parsed.fm.id===memory.fm.id?{summary:parsed.fm.summary,write_origin:parsed.fm.write_origin}:{}) };
    } catch { return { revision }; }
  } catch { return { revision: null }; }
}

export function vaultConventionOf(vault: Pick<Vault, "get">): (id: string) => Promise<ConventionSource> {
  return (id) => readConventionSource(vault.get(id));
}
