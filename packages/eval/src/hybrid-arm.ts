/**
 * Hybrid-arm building blocks for persona-lift (#103).
 *
 * The lexical arms mirror core's BM25 by hand (index-config.ts) so they can
 * vary one knob. The hybrid arm instead runs PRODUCTION `recallHybrid` — real
 * `SearchIndex` + `EmbeddingIndex` + RRF — so the dense leg is measured, not
 * simulated. The control/treatment split is enforced on BOTH legs:
 *
 *   control  : recall_when blanked in the in-memory frontmatter (BM25 leg) AND
 *              excluded from the dense embed text — the stripping discipline
 *              doc2query-lift applies, otherwise the trigger leaks through the
 *              vector space and the ablation is circular.
 *   treatment: recall_when present in both legs at production weights.
 *
 * `recall_when_expanded` is blanked on BOTH sides: the hybrid arm isolates the
 * recall_when lever; write-time expansion is the `expanded` arm's job.
 *
 * Dense vectors are injected the way doc2query-lift does it: write each side's
 * persistPath JSON (the exact {dim,provider,vectors} format EmbeddingIndex.load
 * expects) with vectors computed via the SAME OllamaEmbeddingProvider — so the
 * query/passage prefix convention is byte-identical to production and no silent
 * backfill (which would re-embed WITH recall_when) can occur. The production
 * embeddings.json (which baked in recall_when) is NEVER loaded.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  Vault,
  SearchIndex,
  EmbeddingIndex,
  OllamaEmbeddingProvider,
  stripAutoRelatedSection,
} from "@bastra-recall/core";
import type { Memory } from "@bastra-recall/core";

/** Mirror daemon env handling for the Ollama provider (same envs doc2query-lift uses). */
export function providerFromEnv(): OllamaEmbeddingProvider {
  const baseURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma";
  const dimEnv = process.env.BASTRA_EMBEDDING_DIM;
  const parsedDim = dimEnv ? Number.parseInt(dimEnv, 10) : undefined;
  const dim = parsedDim !== undefined && Number.isFinite(parsedDim) ? parsedDim : undefined;
  const keepAlive = process.env.BASTRA_OLLAMA_KEEP_ALIVE ?? "10m";
  return new OllamaEmbeddingProvider({ baseURL, model, dim, keepAlive });
}

// ── Production-faithful embed text (replica of embeddings.ts:buildEmbedText) ──
// `includeRecallWhen` is the ONE knob: false = control side (dense leg must not
// see the trigger either), true = treatment side (production text, verbatim).
// The provider applies the passage prefix, so this only controls the TEXT.
function embedTextFor(m: Memory, includeRecallWhen: boolean): string {
  const fm = m.fm;
  const parts = [
    fm.title,
    fm.tags.join(" "),
    includeRecallWhen ? fm.recall_when.join(" ") : "",
    fm.summary,
    // #631: production strips the Auto-Related section before the 4000 cut.
    stripAutoRelatedSection(m.body).trimEnd().slice(0, 4000),
  ];
  return parts.filter((p) => p && p.length > 0).join("\n");
}

// Write the {dim,provider,vectors} JSON EmbeddingIndex.load expects. base64-LE
// float32, matching embeddings.ts:persist (same helper as doc2query-lift).
async function writeVectorsJson(
  persistPath: string,
  provider: OllamaEmbeddingProvider,
  ids: string[],
  vectors: Float32Array[],
): Promise<void> {
  const out: Record<string, string> = {};
  for (let i = 0; i < ids.length; i++) {
    const v = vectors[i];
    out[ids[i]] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
  }
  const data = { dim: provider.dim, provider: provider.id, vectors: out };
  await fs.mkdir(path.dirname(persistPath), { recursive: true });
  await fs.writeFile(persistPath, JSON.stringify(data));
}

/** Embed every memory's passage text in batches via the SAME provider (prefix-correct). */
async function embedAll(
  provider: OllamaEmbeddingProvider,
  memories: Memory[],
  includeRecallWhen: boolean,
  label: string,
): Promise<{ ids: string[]; vectors: Float32Array[] }> {
  const ids: string[] = [];
  const vectors: Float32Array[] = [];
  const BATCH = 50;
  for (let i = 0; i < memories.length; i += BATCH) {
    const chunk = memories.slice(i, i + BATCH);
    const texts = chunk.map((m) => embedTextFor(m, includeRecallWhen));
    const vecs = await provider.embed(texts);
    for (let j = 0; j < chunk.length; j++) {
      ids.push(chunk[j].fm.id);
      vectors.push(vecs[j]);
    }
    process.stderr.write(`  [${label}] embedded ${Math.min(i + BATCH, memories.length)}/${memories.length}\r`);
  }
  process.stderr.write("\n");
  return { ids, vectors };
}

type Side = "control" | "treatment";

export interface HybridArmSide {
  search: SearchIndex;
  emb: EmbeddingIndex;
  vault: Vault;
}

export interface HybridArmPair {
  control: HybridArmSide;
  treatment: HybridArmSide;
  /** stop indexes/vaults and delete the temp persist dirs. */
  cleanup(): Promise<void>;
}

/**
 * Build the hybrid control/treatment pair over `vaultPath`: two Vaults (so the
 * in-memory frontmatter policies don't collide), production SearchIndex +
 * EmbeddingIndex each, with per-side injected vectors.
 */
export async function buildHybridArmPair(vaultPath: string): Promise<HybridArmPair> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bastra-persona-hybrid-"));
  const provider = providerFromEnv();

  // Embed once per side from a pristine vault (original recall_when intact —
  // embedTextFor decides per side whether the trigger enters the dense text).
  const refVault = new Vault(vaultPath);
  await refVault.init();
  const mems = refVault.list();
  const vaultSize = refVault.size();
  const persist: Record<Side, string> = {
    control: path.join(tmpRoot, "control", "embeddings.json"),
    treatment: path.join(tmpRoot, "treatment", "embeddings.json"),
  };
  process.stderr.write(`[hybrid] embedding ${vaultSize} memories per side via ${provider.id}…\n`);
  const c = await embedAll(provider, mems, false, "control");
  await writeVectorsJson(persist.control, provider, c.ids, c.vectors);
  const t = await embedAll(provider, mems, true, "treatment");
  await writeVectorsJson(persist.treatment, provider, t.ids, t.vectors);
  await refVault.stop();

  async function buildSide(side: Side): Promise<HybridArmSide> {
    const vault = new Vault(vaultPath);
    await vault.init();
    for (const m of vault.list()) {
      if (side === "control") (m.fm as { recall_when: string[] }).recall_when = [];
      (m.fm as { recall_when_expanded?: string[] }).recall_when_expanded = [];
    }
    const search = new SearchIndex(vault);
    search.start(); // BM25 leg picks up the policy'd frontmatter
    const emb = new EmbeddingIndex(vault, provider, persist[side]);
    await emb.start(); // load() picks up our injected vectors; nothing missing → no backfill
    search.useEmbeddings(emb);
    // Sanity: confirm the injected vectors loaded (no silent backfill from buildEmbedText).
    if (emb.size() < vault.size()) {
      process.stderr.write(
        `⚠ hybrid ${side}: only ${emb.size()}/${vault.size()} vectors loaded — injection may have missed memories\n`,
      );
    }
    return { search, emb, vault };
  }
  const control = await buildSide("control");
  const treatment = await buildSide("treatment");

  return {
    control,
    treatment,
    cleanup: async () => {
      for (const side of [control, treatment]) {
        side.search.stop();
        side.emb.stop();
        await side.vault.stop();
      }
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}
