/**
 * Evidence for hand adjudication (#588, registration v2): for every accepted
 * candidate, the NEW type errors the mutation caused — the messages, not just
 * the files — so each truth entry can be checked against what actually broke.
 *
 * Runs in its own worktrees (ev-0..n) so it never disturbs a running miner.
 * Writes evidence.jsonl next to the candidates; resumable.
 *
 * Usage: node packages/eval/code-roi/v2/evidence.mjs
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyze, ensureWorktree, OUT } from "./mine.mjs";

const WORKERS = 3;
const EVIDENCE = join(OUT, "evidence.jsonl");

const accepted = readFileSync(join(OUT, "candidates.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((c) => c.accepted);
const done = new Set(
  existsSync(EVIDENCE)
    ? readFileSync(EVIDENCE, "utf8").split("\n").filter(Boolean).map((l) => { const e = JSON.parse(l); return `${e.commit}:${e.file}`; })
    : [],
);
const todo = accepted.filter((c) => !done.has(`${c.commit}:${c.file}`));
const worktrees = Array.from({ length: WORKERS }, (_, i) => join(OUT, `ev-${i}`));
for (const wt of worktrees) await ensureWorktree(wt);

let next = 0;
await Promise.all(
  worktrees.map(async (wt) => {
    while (next < todo.length) {
      const c = todo[next++];
      const [r] = await analyze(c.commit, [c.file], wt, { evidence: true });
      const same = JSON.stringify(r.truth) === JSON.stringify(c.truth);
      appendFileSync(EVIDENCE, JSON.stringify({ commit: c.commit, file: c.file, truth: r.truth, reproduced: same, newErrors: r.newErrors }) + "\n");
      process.stdout.write(`${c.commit.slice(0, 7)} ${c.file} reproduced=${same}\n`);
    }
  }),
);
