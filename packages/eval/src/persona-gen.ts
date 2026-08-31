/**
 * Generate the simulated-user queries `persona-lift.ts` consumes (#103).
 *
 * The three-arm survival number in #103 was measured on 2026-07-02 and cannot
 * be reproduced: the run kept its personas file locally, so the queries are
 * gone, and nothing in the repo could make new ones. That is the same defect
 * #338 fixed for the score bands — the instrument existed as a paragraph, so
 * re-asking the question meant re-arguing it. This is the instrument.
 *
 * WHAT THE MODEL IS ALLOWED TO SEE — this is the whole measurement:
 * title and summary only. Never `recall_when`, never the body. A persona that
 * has seen the trigger writes the trigger back, the overlap gate scores it as
 * `near`, and the harness measures its own prompt instead of query drift. The
 * far slice — the one #103 exists to move — would quietly empty out.
 *
 * Ecologically this is the honest framing anyway: weeks later an agent knows
 * roughly what a note was about and phrases the situation in its own words. It
 * does not remember the trigger its author wrote.
 *
 *   BASTRA_VAULT_PATH=~/vault npx tsx src/persona-gen.ts --n 30 --out personas.json
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { Vault } from "@bastra-recall/core";

/** The voices. Kept deliberately far apart: a persona set that all phrases
 *  things the same way produces a narrow overlap band, and then near/far is a
 *  property of the generator rather than of recall. `persona-diversity.test.ts`
 *  pins that the bundled fixture spans the axis; a run reports its own spread
 *  so a collapsed set is visible rather than assumed. */
const VOICES: Record<string, string> = {
  junior:
    "a beginner who does not know the technical terms and describes the symptom in plain words, often as a question",
  senior:
    "an experienced engineer who names the concept directly and writes in a compressed, precise register",
  nonnative:
    "a non-native English speaker writing slightly awkward English with simple grammar",
  terse: "someone who types three or four words, no grammar, like a search box query",
  verbose:
    "someone who writes two full sentences of context before getting to the actual question",
  outsider:
    "someone from a different discipline who describes the situation by analogy, avoiding the domain's vocabulary",
};

interface Row {
  id: string;
  title: string;
  summary: string;
  type: string;
  scope: string;
}

async function ollama(model: string, prompt: string, baseURL: string): Promise<string> {
  const res = await fetch(`${baseURL}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      // Low but not zero: identical phrasing across six voices would defeat the
      // point, and greedy decoding on a small model tends to converge on one.
      // num_ctx explicit: without it Ollama sizes the context from the model and
      // a stock tag loads at its full training context — 262144 for qwen3:4b,
      // a 36 GB KV cache that the cold load never finishes allocating (#366).
      options: { temperature: 0.4, num_predict: 80, num_ctx: 4096 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { response?: string; done_reason?: string };
  const text = (json.response ?? "").trim();
  // A reasoning model spends the whole budget thinking and returns nothing —
  // `gemma4:12b` does exactly this and looks like 180 silent failures. Naming
  // it costs one branch and saves the next person the same twenty minutes.
  if (text.length === 0 && json.done_reason === "length") {
    throw new Error(
      `${model} produced no text and stopped on length — it is reasoning inside the budget. ` +
        `Use an instruct model (--model gemma3:4b) or raise num_predict.`,
    );
  }
  return text;
}

/** One line, no quotes, no preamble — models like to explain themselves. */
function cleanQuery(raw: string): string {
  const firstLine = raw.split("\n").find((l) => l.trim().length > 0) ?? "";
  return firstLine
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(query|answer|question)\s*:\s*/i, "")
    .trim();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string, d: string): string => {
    const i = argv.indexOf(n);
    return i === -1 ? d : (argv[i + 1] ?? d);
  };
  const n = Number.parseInt(arg("--n", "30"), 10);
  const outPath = arg("--out", "personas.json");
  // Instruct model on purpose: a reasoning model burns the token budget on its
  // own deliberation and returns an empty string for a one-line query.
  const model = arg("--model", process.env.BASTRA_EVAL_MODEL ?? "gemma3:4b");
  const baseURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
  const voices = arg("--voices", Object.keys(VOICES).join(",")).split(",");
  const vaultRoot = (process.env.BASTRA_VAULT_PATH ?? arg("--vault", "")).replace(/^~/, os.homedir());
  if (!vaultRoot) {
    console.error("FATAL: set BASTRA_VAULT_PATH or pass --vault <path>");
    process.exit(2);
  }
  for (const v of voices) {
    if (!VOICES[v]) {
      console.error(`FATAL: unknown voice "${v}". Known: ${Object.keys(VOICES).join(", ")}`);
      process.exit(2);
    }
  }

  const vault = new Vault(vaultRoot);
  await vault.init();

  // Admission mirrors what recall can serve, plus one extra cut: a memory
  // without a trigger has nothing for the overlap gate to score against, so it
  // cannot be near or far and would only dilute the denominator.
  const admitted = vault
    .list()
    .filter((m) => {
      const fm = m.fm as { obsolete?: boolean; sensitivity?: string };
      return !fm.obsolete && fm.sensitivity !== "private";
    })
    .filter((m) => (m.fm.recall_when ?? []).some((t) => t.trim().length > 0))
    .filter((m) => (m.fm.summary ?? "").trim().length > 0);

  // Stratified by type and deterministic: sort inside each type, then take a
  // round-robin. Random sampling would make two runs incomparable for no gain,
  // and taking the first n outright would oversample whatever type sorts first.
  const byType = new Map<string, Row[]>();
  for (const m of admitted) {
    const row: Row = {
      id: m.fm.id,
      title: m.fm.title ?? m.fm.id,
      summary: m.fm.summary ?? "",
      type: m.fm.type,
      scope: m.fm.scope,
    };
    byType.set(row.type, [...(byType.get(row.type) ?? []), row]);
  }
  for (const rows of byType.values()) rows.sort((a, b) => a.id.localeCompare(b.id));
  const types = [...byType.keys()].sort();
  const sample: Row[] = [];
  for (let i = 0; sample.length < n && i < 10_000; i++) {
    const before = sample.length;
    for (const t of types) {
      const rows = byType.get(t)!;
      if (i < rows.length && sample.length < n) sample.push(rows[i]);
    }
    if (sample.length === before) break; // every type exhausted
  }

  console.error(
    `vault ${admitted.length} eligible memories, sampling ${sample.length} across ${types.length} types` +
      `, ${voices.length} voices = ${sample.length * voices.length} queries, model ${model}`,
  );
  await vault.stop();

  const personas: Record<string, Record<string, string>> = {};
  let done = 0;
  let failed = 0;
  const total = sample.length * voices.length;
  for (const voice of voices) {
    personas[voice] = {};
    for (const row of sample) {
      // title + summary ONLY. See the header: showing recall_when here would
      // make the harness measure its own prompt.
      const prompt = [
        `You are ${VOICES[voice]}.`,
        ``,
        `Weeks ago someone wrote a note. All you remember is roughly what it was about:`,
        `Topic: ${row.title}`,
        `Gist: ${row.summary.slice(0, 300)}`,
        ``,
        `Write the single search query you would type when you need that note again.`,
        `Your own words, in your own voice. One line. No quotes, no explanation.`,
      ].join("\n");
      try {
        const q = cleanQuery(await ollama(model, prompt, baseURL));
        if (q.length > 0) personas[voice][row.id] = q;
        else failed += 1;
      } catch (err) {
        failed += 1;
        if (failed <= 3) console.error(`\n  ${voice}/${row.id}: ${String(err).slice(0, 120)}`);
      }
      done += 1;
      if (done % 10 === 0) process.stderr.write(`\rgenerated ${done}/${total}`);
      // Written after every voice, not at the end: 180 generations is minutes of
      // model time, and losing all of it to one bad response is avoidable.
      await fs.writeFile(
        outPath,
        JSON.stringify(
          {
            _comment:
              "Generated by persona-gen.ts from title+summary only — never recall_when. " +
              "Regenerate rather than edit: a hand-tuned query is a query someone chose to be findable.",
            _model: model,
            _sample: { memories: sample.length, voices, types },
            personas,
          },
          null,
          2,
        ),
      );
    }
  }
  process.stderr.write(`\rgenerated ${done}/${total}\n`);
  if (failed > 0) console.error(`${failed} generations failed and were skipped`);
  console.error(`wrote ${outPath}`);
}

void main();
