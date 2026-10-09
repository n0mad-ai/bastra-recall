/**
 * Measures the draft meaning check (packages/daemon/src/draft-judge.ts) against
 * a real local Ollama chat model. Not part of `npm test`: it needs the model.
 *
 *   node --import tsx tools/draft-judge-eval/run.mts --model gemma3:4b [--sets design-own,design-codex] [--out result.json]
 *
 * It asks the production prompts through the production client and parser, so
 * a prompt change shows up here without touching this file. `cases.json` holds
 * invented statements only; its `holdout` set was written before the first run
 * and must not be used to change a prompt.
 *
 * The model is unloaded first, so the first call is a genuine cold start and is
 * reported alone. Run it with no other model work on the machine.
 */
import { readFile, writeFile } from "node:fs/promises";
import { ollamaChat } from "../../packages/daemon/src/learned-recall/reranker.js";
import { STATEMENT_KINDS, RELATIONS, statementPrompt, relationPrompt, noteJudgeText, parseVerdict } from "../../packages/daemon/src/draft-judge.js";

interface Topic { set: string; id: string; fact: string; paraphrases: string[]; opposite: string; task: string; related?: string; note_title: string; note_summary?: string }
interface Cases {
  topics: Topic[];
  statements: { set: string; id: string; text: string; expect: string }[];
  pairs: { set: string; id: string; a: string; b: string; expect: string }[];
}
interface Probe { question: "a" | "b" | "c"; set: string; id: string; expect: string; prompt: string; allowed: readonly string[] }
interface Answer extends Probe { verdict: string | null; raw: string; ms: number }

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
const model = arg("model") ?? "gemma3:4b";
const baseURL = "http://127.0.0.1:11434";
const sets = (arg("sets") ?? "design-own,design-codex,holdout").split(",");
const all: Cases = JSON.parse(await readFile(new URL("cases.json", import.meta.url), "utf8"));
const cases: Cases = { topics: all.topics.filter(t => sets.includes(t.set)), statements: all.statements.filter(s => sets.includes(s.set)), pairs: all.pairs.filter(p => sets.includes(p.set)) };

const note = (t: Topic, text: string) => noteJudgeText({ fm: { title: t.note_title, summary: t.note_summary ?? text }, body: text });
const probes: Probe[] = [];
const a = (set: string, id: string, text: string, expect: string) => probes.push({ question: "a", set, id, expect, prompt: statementPrompt(text), allowed: STATEMENT_KINDS });
const rel = (question: "b" | "c", set: string, id: string, left: string, right: string, expect: string) => probes.push({ question, set, id, expect, prompt: relationPrompt(left, right, question === "c" ? "note" : "statement"), allowed: RELATIONS });
for (const t of cases.topics) {
  a(t.set, `${t.id}/fact`, t.fact, "durable"); a(t.set, `${t.id}/opposite`, t.opposite, "durable"); a(t.set, `${t.id}/task`, t.task, "request");
  t.paraphrases.forEach((p, i) => { a(t.set, `${t.id}/paraphrase-${i}`, p, "durable"); rel("b", t.set, `${t.id}/fact~paraphrase-${i}`, t.fact, p, "same"); });
  rel("b", t.set, `${t.id}/fact~opposite`, t.fact, t.opposite, "contradiction");
  rel("b", t.set, `${t.id}/fact~task`, t.fact, t.task, "different");
  // The next topic of the same set is an unrelated statement.
  const peers = cases.topics.filter(x => x.set === t.set), other = peers[(peers.indexOf(t) + 1) % peers.length];
  rel("b", t.set, `${t.id}/fact~unrelated`, t.fact, other.fact, "different");
  rel("c", t.set, `${t.id}/opposite~note(fact)`, t.opposite, note(t, t.fact), "contradiction");
  rel("c", t.set, `${t.id}/fact~note(paraphrase)`, t.fact, note(t, t.paraphrases[0]), "same");
  rel("c", t.set, `${t.id}/fact~note(unrelated)`, t.fact, note(other, other.fact), "different");
  if (t.related) {
    rel("b", t.set, `${t.id}/fact~related`, t.fact, t.related, "different");
    rel("c", t.set, `${t.id}/fact~note(related)`, t.fact, note(t, t.related), "different");
  }
}
for (const s of cases.statements) a(s.set, `extra/${s.id}`, s.text, s.expect);
for (const p of cases.pairs) rel("b", p.set, `extra/${p.id}`, p.a, p.b, p.expect);

// Unload, so the first call pays the model load.
await fetch(`${baseURL}/api/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, keep_alive: 0 }) }).then(r => r.text());
const chat = ollamaChat({ baseURL, model, timeoutMs: 120_000 });
const answers: Answer[] = [];
for (const probe of probes) {
  const started = performance.now();
  let raw = "";
  try { raw = await chat(probe.prompt); } catch (error) { raw = `ERROR ${(error as Error).message}`; }
  answers.push({ ...probe, raw, verdict: parseVerdict(raw, probe.allowed), ms: Math.round(performance.now() - started) });
  if (answers.length % 50 === 0) console.error(`${answers.length}/${probes.length}`);
}

/** `not-x` accepts every readable verdict except x; no verdict is never correct. */
const correct = (r: Answer) => r.verdict !== null && (r.expect.startsWith("not-") ? r.verdict !== r.expect.slice(4) : r.verdict === r.expect);
const pct = (n: number, d: number) => d ? `${n}/${d} (${(100 * n / d).toFixed(0)} %)` : "-";
const quantile = (values: number[], q: number) => { const s = [...values].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const accuracy: Record<string, string>[] = [], confusion: Record<string, unknown>[] = [];
for (const question of ["a", "b", "c"] as const) for (const set of sets) {
  const rows = answers.filter(r => r.question === question && r.set === set);
  const row: Record<string, string> = { question, set, all: pct(rows.filter(correct).length, rows.length), unreadable: pct(rows.filter(r => r.verdict === null).length, rows.length) };
  for (const expect of [...new Set(rows.map(r => r.expect))]) {
    const of = rows.filter(r => r.expect === expect);
    row[expect] = pct(of.filter(correct).length, of.length);
    const counts: Record<string, unknown> = { question, set, expect };
    for (const verdict of [...(question === "a" ? STATEMENT_KINDS : RELATIONS), "none"]) counts[verdict] = of.filter(r => (r.verdict ?? "none") === verdict).length;
    confusion.push(counts);
  }
  accuracy.push(row);
}

// The four promotion outcomes, derived with the rule of draft-promote.ts.
const verdictOf = (id: string) => answers.find(r => r.id === id)!.verdict;
const outcomes: Record<string, string>[] = [];
for (const set of sets) {
  const topics = cases.topics.filter(t => t.set === set);
  const count = (hit: (t: Topic) => boolean) => `${topics.filter(hit).length}/${topics.length}`;
  outcomes.push({
    set,
    "paraphrase promoted (want all)": count(t => verdictOf(`${t.id}/fact`) === "durable" && verdictOf(`${t.id}/fact~paraphrase-0`) === "same"),
    "one-time task promoted (want 0)": count(t => verdictOf(`${t.id}/task`) === "durable"),
    "contradiction as repeat (want 0)": count(t => verdictOf(`${t.id}/fact`) === "durable" && verdictOf(`${t.id}/fact~opposite`) === "same"),
    "counter-fact closed as duplicate (want 0)": count(t => verdictOf(`${t.id}/opposite~note(fact)`) === "same"),
    "counter-fact flagged as contradiction": count(t => verdictOf(`${t.id}/opposite~note(fact)`) === "contradiction"),
    "same fact closed as duplicate (want all)": count(t => verdictOf(`${t.id}/fact~note(paraphrase)`) === "same"),
  });
}
const warm = answers.slice(1).map(r => r.ms);
const latency = { model, calls: answers.length, cold_first_call_ms: answers[0].ms, warm_median_ms: quantile(warm, 0.5), warm_p95_ms: quantile(warm, 0.95), warm_max_ms: quantile(warm, 1) };
console.log(`model ${model}`); console.table(accuracy); console.table(confusion); console.table(outcomes); console.table([latency]);
const misses = answers.filter(r => !correct(r)).map(({ question, set, id, expect, verdict, raw }) => ({ question, set, id, expect, verdict, raw: raw.slice(0, 80) }));
const out = arg("out");
if (out) await writeFile(out, JSON.stringify({ model, accuracy, confusion, outcomes, latency, misses, answers: answers.map(({ prompt: _prompt, allowed: _allowed, ...rest }) => rest) }, null, 1));
