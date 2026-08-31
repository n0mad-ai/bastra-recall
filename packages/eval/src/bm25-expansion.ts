/**
 * Akzeptanz-Harness für die BM25-Expansionsstrategie (#362).
 *
 * Die Frage ist nicht, ob eine Variante schneller ist — das misst jede Stoppuhr
 * — sondern ob sie den Hooks etwas WEGNIMMT. Deshalb läuft hier der
 * PRODUKTIONSPFAD: echter Vault, echter `SearchIndex`, echter `EmbeddingIndex`
 * über die bereits persistierten Vektoren, `recallHybrid` mit RRF. Kein
 * nachgebauter Index, keine simulierte Dense-Seite.
 *
 * **Ship-Regel (aus #362, unverändert übernommen):** eine Variante darf
 * ausgeliefert werden, wenn über alle Probe-Queries
 *
 *   1. KEINE injizierbare Id verloren geht, und
 *   2. ≥ 90 % der injizierbaren Sets identisch sind.
 *
 * „Injizierbar" heißt: der Hit hätte den Score-Floor der Prompt-Lane passiert
 * und wäre im `<recall-hints>`-Block gelandet. Was unter dem Floor liegt, hat
 * nie jemand gesehen — dort ist eine Änderung folgenlos, und genau deshalb ist
 * das Kriterium die injizierbare MENGE und nicht die Rangfolge.
 *
 * Die Probe-Queries sind echte User-Prompts aus den lokalen Claude-Code-
 * Transkripten, gefiltert auf das Längenband, das laut #362 die Timeouts trägt.
 * Sie verlassen die Maschine nicht: gelesen, gemessen, verworfen — die Ausgabe
 * trägt nur Länge und Ergebnis, nie den Text.
 *
 * ```
 * BASTRA_VAULT_PATH=~/vault npx tsx src/bm25-expansion.ts --n 15
 * ```
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  Vault,
  SearchIndex,
  EmbeddingIndex,
  OllamaEmbeddingProvider,
  BM25_FUZZY_RARE_DF_MAX,
} from "@bastra-recall/core";
import type { RecallHit } from "@bastra-recall/core";

/** Score-Floor der Prompt-Lane in mode "generic" (`prompt-lane.ts`
 *  MUST_LOAD_SCORE). Der strengere der beiden Floors — wer ihn passiert, wird
 *  injiziert. Bewusst hier gespiegelt statt aus dem Daemon importiert: eval
 *  hängt nicht am Daemon-Package. */
const MUST_LOAD_SCORE = 100;

/** Längenband der Timeouts (#362: ab 2000 Zeichen 20 %, ab 4000 Zeichen 81 %).
 *  Nach oben begrenzt, weil `normalizeQuery` bei 8000 Zeichen kappt — ein
 *  eingefügter 250-kB-Log ist als Probe wertlos: Er misst nur den Cap, und
 *  jede Variante sieht danach denselben abgeschnittenen Text. */
const MIN_PROMPT_CHARS = 2000;
const MAX_PROMPT_CHARS = 8000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * Echte User-Prompts aus den lokalen Transkripten.
 *
 * Deterministisch: alle Kandidaten werden gesammelt, dedupliziert und nach
 * (Länge, Text) sortiert — kein Zufall, keine Zeitabhängigkeit, damit die
 * Nachmessung dieselbe Menge sieht wie die Erstmessung.
 */
async function collectPrompts(limit: number): Promise<string[]> {
  const root = path.join(os.homedir(), ".claude", "projects");
  const found = new Set<string>();
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return [];
  }
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = (await fs.readdir(path.join(root, d))).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(root, d, f), "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line.startsWith("{")) continue;
        let rec: { type?: string; message?: { role?: string; content?: unknown } };
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type !== "user" || rec.message?.role !== "user") continue;
        const c = rec.message.content;
        const text =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c
                  .filter((p): p is { type: string; text: string } => (p as { type?: string })?.type === "text")
                  .map((p) => p.text)
                  .join("\n")
              : "";
        // Tool results and hook blocks are not prompts — the lane never sees them.
        if (text.includes("<recall-hints") || text.includes("<system-reminder")) continue;
        if (text.length >= MIN_PROMPT_CHARS && text.length <= MAX_PROMPT_CHARS) found.add(text);
      }
    }
  }
  return [...found].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).slice(-limit);
}

const med = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length === 0 ? 0 : s[s.length >> 1];
};
const p90 = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
};

async function main(): Promise<void> {
  const vaultRoot = (process.env.BASTRA_VAULT_PATH ?? arg("--vault", "")).replace(/^~/, os.homedir());
  if (!vaultRoot) {
    console.error("FATAL: set BASTRA_VAULT_PATH (or --vault)");
    process.exit(1);
  }
  const n = Number.parseInt(arg("--n", "15"), 10);
  const sweep = arg("--df-max", String(BM25_FUZZY_RARE_DF_MAX))
    .split(",")
    .map((v) => Number.parseInt(v, 10))
    .filter((v) => Number.isFinite(v) && v > 0);

  const prompts = await collectPrompts(n);
  if (prompts.length === 0) {
    console.error(
      `FATAL: no user prompts in ${MIN_PROMPT_CHARS}–${MAX_PROMPT_CHARS} chars found in ~/.claude/projects`,
    );
    process.exit(1);
  }

  const vault = new Vault(vaultRoot);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();

  const provider = new OllamaEmbeddingProvider({
    baseURL: process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434",
    model: process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma",
    keepAlive: process.env.BASTRA_OLLAMA_KEEP_ALIVE ?? "10m",
  });
  const emb = new EmbeddingIndex(vault, provider, path.join(vaultRoot, ".bastra", "embeddings.json"));
  await emb.start();
  search.useEmbeddings(emb);
  if (emb.size() < vault.size()) {
    console.error(`⚠ only ${emb.size()}/${vault.size()} vectors loaded — the dense arm is incomplete`);
  }

  console.log(`vault ${vault.size()} memories, ${emb.size()} vectors`);
  console.log(`probes ${prompts.length}, chars median ${med(prompts.map((p) => p.length))}`);
  console.log(`sweep df <= ${sweep.join(", ")}\n`);

  const injectable = (hits: RecallHit[]): Set<string> =>
    new Set(hits.filter((h) => h.score >= MUST_LOAD_SCORE).map((h) => h.id));

  // Deep enough that the floor, not k, decides what is injectable.
  const K = 20;

  /**
   * Ein Arm über alle Probes. `bm25_search_ms` kommt aus der Stage-Telemetrie
   * des Produktionspfads, nicht von einer Stoppuhr um den ganzen Call: Der
   * Hybrid-Aufruf enthält Dense-Arm und RRF, und die Variante rührt nur den
   * lexikalischen Teil an — eine Gesamtzeit würde den Effekt in fremder Varianz
   * ertränken.
   */
  async function runArm(dfMax: number | undefined): Promise<{
    total: number[];
    bm25: number[];
    sets: Set<string>[];
  }> {
    const total: number[] = [];
    const bm25: number[] = [];
    const sets: Set<string>[] = [];
    for (const q of prompts) {
      let bmMs = 0;
      const onStage = (e: { name: string; durationMs?: number }): void => {
        if (e.name === "bm25.search" && typeof e.durationMs === "number") bmMs = e.durationMs;
      };
      const t0 = performance.now();
      const hits = await search.recallHybrid(q, {
        k: K,
        onStage: onStage as never,
        ...(dfMax === undefined ? {} : { bm25_fuzzy_rare_df_max: dfMax }),
      });
      total.push(performance.now() - t0);
      bm25.push(bmMs);
      sets.push(injectable(hits));
    }
    return { total, bm25, sets };
  }

  const base = await runArm(undefined);
  console.log("df<=      bm25 p50   bm25 p90   total p50   identical   ids lost   ids gained   SHIP");
  console.log(
    `baseline  ${med(base.bm25).toFixed(0).padStart(8)}   ${p90(base.bm25).toFixed(0).padStart(8)}   ${med(base.total).toFixed(0).padStart(9)}   ${"—".padStart(9)}   ${"—".padStart(8)}   ${"—".padStart(10)}   —`,
  );

  // Kontrolle: derselbe Arm ein zweites Mal. Weicht er von sich selbst ab,
  // misst der Sweep Umgebungsrauschen (Cache, Modell-Ladezustand) und keine
  // Variante — dann ist jede Zeile darunter wertlos.
  const control = await runArm(undefined);
  let selfIdentical = 0;
  for (let i = 0; i < prompts.length; i++) {
    const same =
      [...base.sets[i]].every((id) => control.sets[i].has(id)) &&
      [...control.sets[i]].every((id) => base.sets[i].has(id));
    if (same) selfIdentical++;
  }
  console.log(
    `control   ${med(control.bm25).toFixed(0).padStart(8)}   ${p90(control.bm25).toFixed(0).padStart(8)}   ${med(control.total).toFixed(0).padStart(9)}   ${((selfIdentical / prompts.length) * 100).toFixed(0).padStart(7)} %   ${"—".padStart(8)}   ${"—".padStart(10)}   —`,
  );

  for (const dfMax of sweep) {
    const arm = await runArm(dfMax);
    let identical = 0;
    let lostTotal = 0;
    let gainedTotal = 0;
    const lostIds: string[] = [];
    for (let i = 0; i < prompts.length; i++) {
      const missing = [...base.sets[i]].filter((id) => !arm.sets[i].has(id));
      const extra = [...arm.sets[i]].filter((id) => !base.sets[i].has(id));
      if (missing.length === 0 && extra.length === 0) identical++;
      lostTotal += missing.length;
      gainedTotal += extra.length;
      lostIds.push(...missing);
    }
    const pct = (identical / prompts.length) * 100;
    const ships = lostTotal === 0 && pct >= 90;
    console.log(
      `${String(dfMax).padEnd(9)} ${med(arm.bm25).toFixed(0).padStart(8)}   ${p90(arm.bm25).toFixed(0).padStart(8)}   ${med(arm.total).toFixed(0).padStart(9)}   ${(pct.toFixed(0) + " %").padStart(9)}   ${String(lostTotal).padStart(8)}   ${String(gainedTotal).padStart(10)}   ${ships ? "PASS" : "FAIL"}`,
    );
    for (const id of lostIds) console.log(`            lost: ${id}`);
  }

  search.stop();
  emb.stop();
  await vault.stop();
  process.exit(0);
}

void main();
