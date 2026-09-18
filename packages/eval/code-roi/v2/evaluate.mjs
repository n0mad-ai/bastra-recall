/**
 * Score the arm transcripts against the ground truth, registration v2 (#588).
 *
 * Reads only the archive (`scenarios.json` + `runs/<id>/<arm>.jsonl`), so any
 * run can be re-scored without being re-run. Applies the thresholds exactly as
 * registered; it has no knob to move them.
 *
 * Scoring rules the registration leaves open, fixed here before any run:
 *   - `named` is the JSON array on the LAST `FILES:` line of the final answer;
 *     no such line, an error or a timeout → named = [] and `no_answer: true`.
 *   - Paths are normalized: leading `./` and the tree's absolute prefix
 *     dropped, backslashes turned into slashes, the changed file itself removed.
 *   - Precision of an empty answer is 1 (it named nothing wrong); its recall is 0,
 *     which is where an empty answer pays.
 *
 * Usage: node evaluate.mjs            → prints the report, writes report.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { rng } from "./select.mjs";

// CODE_ROI_OUT: a pilot directory, so a plumbing check never touches the real archive.
const OUT = process.env.CODE_ROI_OUT ?? join(homedir(), ".bastra", "eval", "code-roi-v2");
const REG = JSON.parse(
  readFileSync(new URL("../../registrations/code-awareness-roi.json", import.meta.url), "utf8"),
);
const T = REG.thresholds;
const SOLVED = 0.8;
const RESAMPLES = 10_000;

export function parseTranscript(text, treePrefix) {
  let contextChars = 0;
  let findCodeCalls = 0;
  let findCodeEmpty = 0;
  let final = null;
  const pendingFindCode = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant") {
      for (const c of ev.message?.content ?? []) {
        if (c.type === "tool_use" && c.name === "mcp__code__find_code") {
          findCodeCalls++;
          pendingFindCode.add(c.id);
        }
      }
    } else if (ev.type === "user") {
      for (const c of ev.message?.content ?? []) {
        if (c.type !== "tool_result") continue;
        const body = typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join("");
        contextChars += body.length;
        if (pendingFindCode.has(c.tool_use_id) && /"status": "(no_answer|unavailable)"/.test(body)) findCodeEmpty++;
      }
    } else if (ev.type === "result") {
      final = ev;
    }
  }
  const answer = typeof final?.result === "string" ? final.result : "";
  const lines = answer.split("\n").filter((l) => /^\s*FILES:/.test(l));
  let named = [];
  let noAnswer = final === null || final.is_error === true || lines.length === 0;
  if (!noAnswer) {
    try {
      const arr = JSON.parse(lines[lines.length - 1].replace(/^\s*FILES:\s*/, ""));
      named = Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
    } catch {
      noAnswer = true;
    }
  }
  named = [...new Set(named.map((p) => normalize(p, treePrefix)))];
  return { named, noAnswer, contextChars, turns: final?.num_turns ?? null, findCodeCalls, findCodeEmpty };
}

function normalize(p, treePrefix) {
  let n = p.trim().replace(/\\/g, "/");
  if (treePrefix && n.startsWith(`${treePrefix}/`)) n = n.slice(treePrefix.length + 1);
  return n.replace(/^\.\//, "");
}

export function score(named, truth, file) {
  const n = named.filter((f) => f !== file);
  const t = new Set(truth);
  const hit = n.filter((f) => t.has(f)).length;
  return { recall: truth.length === 0 ? 1 : hit / truth.length, precision: n.length === 0 ? 1 : hit / n.length };
}

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const median = (xs) => {
  if (xs.length === 0) return NaN;
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** Paired bootstrap over DIRECTORIES (clusters), as registered. */
export function clusterBootstrap(rows, key, seed = REG.statistics.seed) {
  const clusters = new Map();
  for (const r of rows) {
    const c = dirname(r.file);
    if (!clusters.has(c)) clusters.set(c, []);
    clusters.get(c).push(r[key]);
  }
  const groups = [...clusters.values()];
  const next = rng(seed);
  const means = [];
  for (let i = 0; i < RESAMPLES; i++) {
    const sample = [];
    for (let j = 0; j < groups.length; j++) sample.push(...groups[Math.floor(next() * groups.length)]);
    means.push(mean(sample));
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(0.025 * RESAMPLES)], hi: means[Math.floor(0.975 * RESAMPLES) - 1], clusters: groups.length };
}

function main() {
  const { scenarios } = JSON.parse(readFileSync(join(OUT, "scenarios.json"), "utf8"));
  const rows = [];
  const missing = [];
  for (const s of scenarios) {
    if (s.excluded) continue;
    const dir = join(OUT, "runs", s.id);
    const arms = {};
    for (const arm of ["control", "treatment"]) {
      const f = join(dir, `${arm}.jsonl`);
      if (!existsSync(f)) {
        missing.push(`${s.id}/${arm}`);
        continue;
      }
      const t = parseTranscript(readFileSync(f, "utf8"), join(dir, "tree"));
      arms[arm] = { ...t, ...score(t.named, s.truth, s.file) };
    }
    if (!arms.control || !arms.treatment) continue;
    rows.push({
      id: s.id,
      file: s.file,
      truth: s.truth.length,
      control: arms.control,
      treatment: arms.treatment,
      dRecall: arms.treatment.recall - arms.control.recall,
      dPrecision: arms.treatment.precision - arms.control.precision,
    });
  }

  const n = rows.length;
  const dRecall = mean(rows.map((r) => r.dRecall));
  const dPrecision = mean(rows.map((r) => r.dPrecision));
  const ciRecall = n > 0 ? clusterBootstrap(rows, "dRecall") : null;
  const bothSolved = rows.filter((r) => r.control.recall >= SOLVED && r.treatment.recall >= SOLVED);
  const ctxControl = median(bothSolved.map((r) => r.control.contextChars));
  const ctxTreatment = median(bothSolved.map((r) => r.treatment.contextChars));
  const ctxRatio = ctxTreatment / ctxControl;

  const checks = {
    recall_gain: { value: dRecall, required: `>= ${T.recall_gain_min}`, pass: dRecall >= T.recall_gain_min },
    recall_ci_lower: { value: ciRecall?.lo, required: "> 0", pass: (ciRecall?.lo ?? -1) > 0 },
    precision_loss: { value: dPrecision, required: `>= -${T.precision_loss_max}`, pass: dPrecision >= -T.precision_loss_max },
    context: {
      value: ctxRatio,
      required: `<= ${1 + T.context_increase_max_ratio} (median, ${bothSolved.length} scenarios solved in both arms)`,
      pass: bothSolved.length > 0 && ctxRatio <= 1 + T.context_increase_max_ratio,
    },
  };
  const underpowered = n < REG.sample.min_scenarios;
  const status = missing.length > 0 && n === 0 ? "not_evaluable" : underpowered ? "underpowered" : Object.values(checks).every((c) => c.pass) ? "pass" : "fail";

  const report = {
    registration_version: REG.registration_version,
    status,
    n,
    clusters: ciRecall?.clusters ?? 0,
    missing,
    means: {
      recall: { control: mean(rows.map((r) => r.control.recall)), treatment: mean(rows.map((r) => r.treatment.recall)) },
      precision: { control: mean(rows.map((r) => r.control.precision)), treatment: mean(rows.map((r) => r.treatment.precision)) },
      contextTokens: {
        control: median(rows.map((r) => r.control.contextChars)) / 4,
        treatment: median(rows.map((r) => r.treatment.contextChars)) / 4,
      },
      turns: { control: median(rows.map((r) => r.control.turns ?? 0)), treatment: median(rows.map((r) => r.treatment.turns ?? 0)) },
    },
    ciRecall,
    checks,
    findCode: {
      calls: rows.reduce((a, r) => a + r.treatment.findCodeCalls, 0),
      empty: rows.reduce((a, r) => a + r.treatment.findCodeEmpty, 0),
      scenariosUsingIt: rows.filter((r) => r.treatment.findCodeCalls > 0).length,
    },
    noAnswers: { control: rows.filter((r) => r.control.noAnswer).length, treatment: rows.filter((r) => r.treatment.noAnswer).length },
    notGatedHere: "latency and the hook-block share come from lane telemetry (`bastra logs --stats`), not from these runs",
    rows,
  };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ ...report, rows: undefined }, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
