/**
 * Evidence for hand adjudication, for a sample mined by `mine-repo.mjs`
 * (#582, registration 5).
 *
 * `evidence.mjs` does this for bastra-recall and imports `mine.mjs`, which
 * creates git worktrees in the repository it reads. That is not allowed on a
 * repository this measurement does not own, so this is its counterpart: same
 * job, same output file, the archive-based miner underneath.
 *
 * For every accepted candidate it re-runs the mutation and records the NEW
 * type errors themselves — the messages, not just the files — so a truth entry
 * can be checked against what actually broke rather than taken on faith.
 *
 * Usage: CODE_ROI_REPO=<repo> CODE_ROI_OUT=<dir> node evidence-repo.mjs
 * Resumable: finished candidates are skipped.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyze, OUT, REPO } from "./mine-repo.mjs";

const WORKERS = Number(process.env.CODE_ROI_WORKERS ?? 3);
const EVIDENCE = join(OUT, "evidence.jsonl");

const accepted = readFileSync(join(OUT, "candidates.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((c) => c.accepted);

const done = new Set(
  existsSync(EVIDENCE)
    ? readFileSync(EVIDENCE, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const e = JSON.parse(l);
          return `${e.commit}:${e.file}`;
        })
    : [],
);

const todo = accepted.filter((c) => !done.has(`${c.commit}:${c.file}`));
process.stdout.write(`${todo.length} of ${accepted.length} candidates need evidence (${REPO})\n`);

// Grouped by commit: `analyze` takes one baseline per commit and reuses it,
// so handing it a commit's files together costs one typecheck instead of one
// per file.
const byCommit = new Map();
for (const c of todo) {
  if (!byCommit.has(c.commit)) byCommit.set(c.commit, []);
  byCommit.get(c.commit).push(c.file);
}

const commits = [...byCommit.keys()];
let next = 0;
await Promise.all(
  Array.from({ length: WORKERS }, (_, i) => join(OUT, `ev-${i}`)).map(async (dir) => {
    while (next < commits.length) {
      const commit = commits[next++];
      const files = byCommit.get(commit);
      const results = await analyze(commit, files, dir, { evidence: true }).catch((e) =>
        files.map((file) => ({ commit, file, reason: `evidence failed: ${String(e?.message ?? e).slice(0, 200)}` })),
      );
      for (const r of results) {
        appendFileSync(
          EVIDENCE,
          JSON.stringify({
            repo: r.repo ?? REPO,
            commit: r.commit,
            file: r.file,
            truth: r.truth ?? [],
            reproduced: r.reason === undefined,
            newErrors: r.newErrors ?? [],
            ...(r.reason === undefined ? {} : { reason: r.reason }),
          }) + "\n",
        );
        process.stdout.write(`${r.commit.slice(0, 7)} ${r.file} reproduced=${r.reason === undefined}\n`);
      }
    }
  }),
);
