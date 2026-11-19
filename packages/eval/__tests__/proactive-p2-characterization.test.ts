/**
 * #1649: the deterministic P2 characterization mode is repeatable and its baseline is
 * frozen, so the planned restructuring of the P2 driver (#1531) can be checked against
 * it. Each run is a separate process (the mode replaces process-wide clock, timer,
 * fetch and child-process functions), started twice with independent temp roots.
 *
 * A changed baseline means the driver now issues other requests, at other virtual
 * times, or computes other values. Regenerate the fixture ONLY for an intended
 * behaviour change, never to make a refactor pass:
 *   node --import tsx packages/eval/src/proactive-p2-characterization.ts --summary \
 *     > packages/eval/fixtures/proactive-p2-characterization.json
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  CHARACTERIZED_CASES,
  characterizationSummary,
  splitP2Observation,
  type CharacterizationDocument,
} from "../src/proactive-p2-characterization.js";

const EVAL_DIR = fileURLToPath(new URL("..", import.meta.url));
const FROZEN = JSON.parse(
  readFileSync(new URL("../fixtures/proactive-p2-characterization.json", import.meta.url), "utf8")
);

function characterizeOnce(): string {
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/proactive-p2-characterization.ts"], {
    cwd: EVAL_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("two fixed-mode P2 runs are byte-identical and equal the frozen baseline", () => {
  const first = characterizeOnce();
  const second = characterizeOnce();
  assert.equal(first, second);

  const document: CharacterizationDocument = JSON.parse(first);
  assert.deepEqual(characterizationSummary(document), FROZEN);
  for (const host of new Set([tmpdir(), realpathSync(tmpdir())])) assert.ok(!first.includes(host), host);

  // Every characterized case ran to completion three times, and the repetitions differ only in their number.
  assert.deepEqual(
    document.rows.map((r) => `${r.case_id}:${r.repetition}:${r.outcome}`),
    CHARACTERIZED_CASES.flatMap((id) => [1, 2, 3].map((n) => `${id}:${n}:observed`))
  );
  for (const id of CHARACTERIZED_CASES) {
    const [one, ...rest] = document.rows
      .filter((r) => r.case_id === id)
      .map(({ repetition, ...r }) => ({
        ...r,
        stdout: r.stdout.map((line) => line.replace(`"repetition":${repetition},`, '"repetition":"n",')),
      }));
    for (const other of rest) assert.deepEqual(other, one, id);
  }
});

test("transport provenance is split from the comparable observation without touching the raw row", () => {
  const row = (root: string, port: number) => ({
    case_id: "p2-durable-restart",
    repetition: 1,
    values: { private_modes: true },
    evidence: [
      { root, port, feature_commit: "c".repeat(40), synthetic_credentials: true },
      { transport: "http", path: "/api/v1/tasks", result: { file: `${root}/data/tasks.json` } },
      { process_logs: { "daemon-0": `listening on ${port}` }, all_children_stopped: true },
    ],
  });
  const a = row("/tmp/run-a", 41001);
  const raw = structuredClone(a);
  const splitA = splitP2Observation(a, { root: "/tmp/run-a" });
  const splitB = splitP2Observation(row("/tmp/run-b", 52002), { root: "/tmp/run-b" });

  assert.deepEqual(a, raw);
  assert.deepEqual(splitA.comparable, splitB.comparable);
  assert.deepEqual(splitA.provenance, {
    root: ["/tmp/run-a"],
    port: [41001],
    process_logs: [{ "daemon-0": "listening on 41001" }],
  });
  assert.deepEqual(splitA.comparable.evidence, [
    { feature_commit: "c".repeat(40), synthetic_credentials: true },
    { transport: "http", path: "/api/v1/tasks", result: { file: "<root>/data/tasks.json" } },
    { all_children_stopped: true },
  ]);
});
