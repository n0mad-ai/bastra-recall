/**
 * measure-recall-budget — hält `max_tokens` (#487) auf dem Gold-Set nach.
 *
 * Die Zusage aus #487 lautet: Mit gesetztem Budget überschreitet das Payload
 * das Budget um höchstens die Toleranz EINES Treffers. Dieses Skript misst
 * genau das und nichts anderes — es beurteilt keine Trefferqualität, dafür ist
 * `goldset-run.ts` da.
 *
 * Gemessen wird je (Gold-Query × Budget):
 *
 *   - passt das serialisierte Payload ins Budget?
 *   - hätte EIN Treffer mehr es gerissen? (Sonst wurde zu viel gestrichen.)
 *   - wie viel Kontext spart das Budget gegenüber demselben Aufruf ohne?
 *
 * Read-only. Lexikalischer Arm genügt: Die Frage ist eine Größenfrage, und die
 * Fusion ändert die Reihenfolge, nicht die Budgetarithmetik.
 *
 * Run: BASTRA_VAULT_PATH=/path/to/vault tsx scripts/measure-recall-budget.ts
 *      [--gold ~/.bastra/eval-goldset] [--k 8]
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { measurePayload } from "../src/recall-budget.js";

const DEFAULT_VAULT = resolve(import.meta.dirname, "../../../fixtures/sample-vault");
const VAULT = process.env.BASTRA_VAULT_PATH ?? process.env.NEXUS_VAULT_PATH ?? DEFAULT_VAULT;
const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const GOLD_DIR = argOf("--gold") ?? join(homedir(), ".bastra", "eval-goldset");
const K = Number(argOf("--k") ?? 8);
/** Realistische Fenstergrößen eines Agenten, der noch etwas anderes vorhat. */
const BUDGETS = [150, 300, 600, 1200];

/** Die Gold-Fälle tragen ihre Query je nach Datei als `query` oder `queries`. */
function goldQueries(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const data = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
    const cases = Array.isArray(data) ? data : ((data as { cases?: unknown[] }).cases ?? []);
    for (const c of cases as Array<{ query?: string; queries?: string[] }>) {
      if (typeof c.query === "string") out.push(c.query);
      for (const q of c.queries ?? []) if (typeof q === "string") out.push(q);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const queries = goldQueries(GOLD_DIR);
  if (queries.length === 0) throw new Error(`no gold queries under ${GOLD_DIR}`);
  const vault = new Vault(VAULT);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: VAULT };

  let checked = 0;
  let overBudget = 0;
  let truncated = 0;
  let toleranceViolations = 0;
  let slack = 0;
  let worstSlack = 0;
  let baselineTokens = 0;
  let emittedTokens = 0;
  for (const query of queries) {
    const full = (await recallHandler(deps, { query, k: K })) as unknown as Record<string, unknown>;
    const ranked = full.hits as unknown[];
    const fullTokens = measurePayload(full).tokens;
    for (const budget of BUDGETS) {
      const res = (await recallHandler(deps, { query, k: K, max_tokens: budget })) as unknown as Record<string, unknown>;
      const tokens = measurePayload(res).tokens;
      const emitted = (res.hits as unknown[]).length;
      checked++;
      baselineTokens += fullTokens;
      emittedTokens += tokens;
      if (tokens > budget) overBudget++;
      if (res.truncated_by_budget !== true) continue;
      truncated++;
      // Die Toleranz IST ein Treffer: der nächste hätte das Budget gerissen.
      if (measurePayload({ ...res, hits: ranked.slice(0, emitted + 1) }).tokens <= budget) {
        toleranceViolations++;
      }
      const s = budget - tokens;
      slack += s;
      if (s > worstSlack) worstSlack = s;
    }
  }

  console.log(
    JSON.stringify(
      {
        vault: VAULT,
        gold_queries: queries.length,
        k: K,
        budgets: BUDGETS,
        calls_checked: checked,
        payload_over_budget: overBudget,
        truncated_calls: truncated,
        tolerance_violations: toleranceViolations,
        mean_slack_tokens: truncated > 0 ? +(slack / truncated).toFixed(1) : 0,
        worst_slack_tokens: worstSlack,
        baseline_tokens: baselineTokens,
        emitted_tokens: emittedTokens,
        saved_pct: +((100 * (baselineTokens - emittedTokens)) / baselineTokens).toFixed(1),
      },
      null,
      2,
    ),
  );
  search.stop();
  await vault.stop?.();
}

await main();
