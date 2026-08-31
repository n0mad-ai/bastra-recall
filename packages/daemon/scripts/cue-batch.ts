/**
 * Der Batch-Lauf für `descriptive_entity`-Cues (§31 Entscheidung 1).
 *
 * Die Erzeugungslogik steht in `core/cue-generate.ts` und kennt weder Ollama
 * noch Dateien; hier wird sie verkabelt: lokales Chat-Modell, semantischer
 * Selbsttest, Sidecar-Datei. Das ist derselbe Schnitt wie beim
 * TriggerExpander, den der Daemon genauso von außen versorgt.
 *
 * Der Selbsttest MUSS semantisch sein. Ein `descriptive_entity`-Cue ist ein
 * Oberbegriff, der im Text des Memorys absichtlich NICHT vorkommt — ein
 * lexikalischer Selbsttest würde also fast jeden Cue verwerfen und der Lauf
 * käme mit einer leeren Datei und einer guten Ausrede zurück. Ohne Vektorarm
 * bricht das Skript deshalb ab, statt eine Messung zu produzieren, die nichts
 * misst.
 *
 * Der Lauf fasst den Vault nicht an: Er liest Memories, arbeitet auf einer
 * KOPIE des Embedding-Stores und schreibt genau eine Datei — das Sidecar.
 *
 * Run:
 *   BASTRA_VAULT_PATH=… tsx scripts/cue-batch.ts
 *
 * Env — die freien Parameter (§18.3) stehen alle hier, keiner im Code:
 *   BASTRA_CUES_OUT              Zieldatei (default <vault>/.bastra/cues.jsonl)
 *   BASTRA_CUE_MAX               Cues pro Memory (default 3)
 *   BASTRA_CUE_MIN_CONFIDENCE    Schwelle auf den reziproken Rang (default 0)
 *   BASTRA_CUE_MODEL             Chat-Modell (default: das Generierungsmodell)
 *   BASTRA_CUE_SELFTEST_K        Pooltiefe des Selbsttests (default 10)
 *   BASTRA_CUE_LIMIT             nur die ersten N Memories (Probelauf)
 *   BASTRA_CUE_OVERWRITE=1       vorhandene Zieldatei ersetzen
 *   BASTRA_CUE_DRY_RUN=1         nichts schreiben, nur berichten
 */
import { appendFile, access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  Vault,
  SearchIndex,
  EmbeddingIndex,
  OllamaEmbeddingProvider,
  generateCueBatch,
  cueToJsonl,
  cueSidecarPath,
  CUE_GENERATOR_VERSION,
  CUE_PROMPT_VERSION,
  type CueSelfTest,
} from "@bastra-recall/core";
import { ollamaChat } from "../src/learned-recall/reranker.js";
import { resolveGenerationModel } from "../src/settings.js";

const TAG = "[bastra-recall.cues]";

const VAULT = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH;
if (!VAULT) {
  console.error(`${TAG} BASTRA_VAULT_PATH ist nicht gesetzt — abort.`);
  process.exit(2);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Den Vektorarm anhängen, ohne den produktiven Store anzufassen.
 *
 * Dieselbe Vorsichtsmaßnahme wie im Goldset-Lauf: Eine Messung darf nicht
 * verändern, was sie misst. Gibt es keinen Store, wird er in der Kopie
 * aufgebaut — das kostet einmal Embedding-Zeit und lässt die Produktion in
 * Ruhe.
 */
async function attachVectors(
  vault: Vault,
  search: SearchIndex,
): Promise<{ cleanup: () => Promise<void> }> {
  const provider = new OllamaEmbeddingProvider({
    baseURL: process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434",
    model: process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma",
    keepAlive: "10m",
  });
  const tmpRoot = await mkdtemp(join(tmpdir(), "bastra-cue-batch-"));
  const persistPath = join(tmpRoot, "embeddings.json");
  const cleanup = (): Promise<void> => rm(tmpRoot, { recursive: true, force: true });

  const production = join(vault.root, ".bastra", "embeddings.json");
  if (await exists(production)) await copyFile(production, persistPath);

  const idx = new EmbeddingIndex(vault, provider, persistPath);
  await idx.start();
  search.useEmbeddings(idx);
  if (!search.hasEmbeddings()) {
    await cleanup();
    throw new Error(
      "der Vektorarm ist nicht aktiv — ein rein lexikalischer Selbsttest würde jeden Oberbegriff verwerfen",
    );
  }
  return { cleanup };
}

async function main(): Promise<void> {
  const out = process.env.BASTRA_CUES_OUT ?? cueSidecarPath(VAULT!);
  const dryRun = envBool("BASTRA_CUE_DRY_RUN", false);
  const maxCues = envInt("BASTRA_CUE_MAX", 3);
  const minConfidence = envFloat("BASTRA_CUE_MIN_CONFIDENCE", 0);
  const selfTestK = envInt("BASTRA_CUE_SELFTEST_K", 10);
  const limit = envInt("BASTRA_CUE_LIMIT", 0);
  const model = process.env.BASTRA_CUE_MODEL ?? (await resolveGenerationModel());

  if (!dryRun && (await exists(out)) && !envBool("BASTRA_CUE_OVERWRITE", false)) {
    console.error(
      `${TAG} ${out} existiert bereits. Die beiden Bedingungen aus Anlage A liegen ` +
        `nebeneinander — setze BASTRA_CUES_OUT oder BASTRA_CUE_OVERWRITE=1.`,
    );
    process.exit(2);
  }

  console.error(`${TAG} vault: ${VAULT}${dryRun ? "  (dry-run)" : ""}`);
  console.error(
    `${TAG} ${CUE_GENERATOR_VERSION} · prompt ${CUE_PROMPT_VERSION} · model ${model} · ` +
      `max=${maxCues} min_confidence=${minConfidence} selftest_k=${selfTestK}`,
  );

  const vault = new Vault(VAULT!);
  const { loaded } = await vault.init();
  console.error(`${TAG} ${loaded} memories geladen`);
  const search = new SearchIndex(vault);
  search.start();
  const { cleanup } = await attachVectors(vault, search);

  // Der Selbsttest: Holt der Cue sein eigenes Memory zurück, und auf welchem
  // Rang? Der Rang trägt die Konfidenz — siehe `confidenceFromRank`.
  const selfTest: CueSelfTest = async (cue, memoryId) => {
    const hits = await search.recallHybrid(cue, { k: selfTestK });
    const at = hits.findIndex((h) => h.id === memoryId);
    return { rank: at === -1 ? null : at + 1 };
  };

  if (!dryRun) await mkdir(dirname(out), { recursive: true });
  let written = 0;

  try {
    const report = await generateCueBatch(limit > 0 ? limitedVault(vault, limit) : vault, {
      chat: ollamaChat({ model, timeoutMs: 60_000, numCtx: 8192 }),
      selfTest,
      model,
      maxCues,
      minConfidence,
      onCue: async (cue) => {
        if (dryRun) return;
        await appendFile(out, cueToJsonl(cue), { mode: 0o600 });
        written++;
      },
    });
    console.error(`${TAG} ${JSON.stringify(report)}`);
    console.error(`${TAG} ${dryRun ? "dry-run, nichts geschrieben" : `${written} Cues → ${out}`}`);
  } finally {
    await cleanup();
  }
}

/** Ein Vault-Ausschnitt für den Probelauf. Nur `list()` wird vom Sweep
 *  gebraucht; alles andere bleibt der echte Vault. */
function limitedVault(vault: Vault, limit: number): Vault {
  return new Proxy(vault, {
    get(target, prop, receiver) {
      if (prop === "list") return () => target.list().slice(0, limit);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err);
  process.exit(1);
});
