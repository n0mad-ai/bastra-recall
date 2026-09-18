/**
 * Evaluate the two arms (#579).
 *
 * Correctness is checked OBJECTIVELY against the scenario ground truth, which
 * was verified from the source rather than from the graph. Rounds and output
 * size are SELF-REPORTED by the agents — that is the weak part of this
 * measurement and it is labelled as such rather than presented as fact.
 *
 * An arm only scores on a scenario it actually got right. An arm that is cheap
 * because it answered wrongly is not cheap.
 */
import { readFile } from "node:fs/promises";
const REPO = "/Users/n0mad/Projekte/bastra-recall";
const S = "/private/tmp/claude-501/-Users-n0mad-Projekte-bastra-recall/67a004fc-6810-4485-84ec-943621854cf9/scratchpad";

const scen = JSON.parse(await readFile(`${REPO}/packages/eval/code-roi/scenarios.json`, "utf8"));
const truth = new Map(scen.map((s) => [s.symbol, s.truth]));

async function load(name) {
  try { return JSON.parse(await readFile(`${S}/${name}.json`, "utf8")); }
  catch { return null; }
}

function score(rows, label) {
  if (rows === null) return { arm: label, status: "kein Protokoll" };
  const judged = rows.map((r) => {
    const t = truth.get(r.symbol);
    // Correct = right file. The line must be within 2 of the declaration,
    // because a reasonable reader may name the signature or the line above it.
    const ok = t !== undefined && r.answer_file === t.file &&
      (typeof r.answer_line !== "number" || Math.abs(r.answer_line - t.line) <= 2);
    return { ...r, correct: ok };
  });
  const right = judged.filter((r) => r.correct);
  const med = (k, a) => { const v = a.map((r) => r[k] ?? 0).sort((x, y) => x - y); return v[Math.floor(v.length / 2)] ?? 0; };
  return {
    arm: label,
    scenarios: rows.length,
    correct: right.length,
    accuracy: rows.length ? +(right.length / rows.length * 100).toFixed(1) : 0,
    rounds_total: right.reduce((a, r) => a + (r.rounds ?? 0), 0),
    rounds_median: med("rounds", right),
    chars_total: right.reduce((a, r) => a + (r.output_chars ?? 0), 0),
    chars_median: med("output_chars", right),
    fell_back: right.filter((r) => r.fell_back_to_grep).length,
    wrong: judged.filter((r) => !r.correct).map((r) => r.symbol),
  };
}

const a = score(await load("arm-control"), "Kontrollarm (nur grep/read)");
const b = score(await load("arm-graph"), "Graph-Arm (find_code)");
console.log(JSON.stringify({ arms: [a, b] }, null, 2));

if (a.correct && b.correct) {
  const rr = +((1 - b.rounds_total / a.rounds_total) * 100).toFixed(1);
  const cr = +((1 - b.chars_total / a.chars_total) * 100).toFixed(1);
  console.log(`\nRunden:  ${a.rounds_total} -> ${b.rounds_total}  (${rr}% weniger)`);
  console.log(`Zeichen: ${a.chars_total} -> ${b.chars_total}  (${cr}% weniger)`);
  console.log(`\nHinWEIS: Runden und Zeichen sind SELBSTBERICHTET. Die Korrektheit ist objektiv geprueft.`);
}
