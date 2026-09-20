import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — plain .mjs measurement script, no declarations
import { populationFreezeMismatches, selectionSize } from "../code-roi/v2/select.mjs";
// @ts-expect-error — plain .mjs measurement scripts, no declarations
import { preflightBuild } from "../code-roi/v2/build-pin.mjs";
// @ts-expect-error — plain .mjs measurement scripts, no declarations
import { loadRegistrationById } from "../code-roi/v2/registration.mjs";

test("select cannot relabel an old population as a new truth rule", () => {
  const registration = {
    population: {
      freeze: {
        population_sha256: "p2",
        repository_head: "head2",
        truth_rule: "tests/v2",
        exclusions_sha256: "e2",
      },
    },
  };
  const oldPopulation = {
    population_sha256: "p1",
    repository_head: "head1",
    truth_rule: "tests/v1",
    exclusions: { sha256: "e1" },
  };
  assert.deepEqual(
    populationFreezeMismatches(registration, oldPopulation).map((m: { field: string }) => m.field),
    ["population_sha256", "repository_head", "truth_rule", "exclusions_sha256"],
  );
  assert.deepEqual(
    populationFreezeMismatches(registration, {
      population_sha256: "p2",
      repository_head: "head2",
      truth_rule: "tests/v2",
      exclusions: { sha256: "e2" },
    }),
    [],
  );
});

test("a pending population blocks the runner before any build or arm check", async () => {
  // The guard, not the current status: once the population is mined and frozen
  // the live registration leaves this state, and a test pinned to it would go
  // green by being deleted rather than by the gate still working.
  const pending = {
    ...loadRegistrationById("code-awareness-delivered"),
    status: "numbers_registered_population_pending",
  };
  const verdict = await preflightBuild({ registrationId: "code-awareness-delivered", registration: pending });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "population_pending");
});

test("lowering the verdict floor does not shrink an exhausted frozen population", () => {
  assert.deepEqual(selectionSize({ sample: { min_scenarios: 37, run_all_accepted: true } }, 44), {
    target: 44,
    draw: 44,
  });
  assert.deepEqual(selectionSize({ sample: { min_scenarios: 37 } }, 44), {
    target: 37,
    draw: 42,
  });
});

/** Run `select.mjs` against a throwaway archive and report how it ended. */
function runSelect(out: string): { code: number | null; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [new URL("../code-roi/v2/select.mjs", import.meta.url).pathname],
    { env: { ...process.env, CODE_ROI_OUT: out }, encoding: "utf8" },
  );
  return { code: result.status, stderr: `${result.stderr}${result.stdout}` };
}

test("select reads which registration the archive is, instead of assuming the default", () => {
  const out = mkdtempSync(join(tmpdir(), "code-roi-select-id-"));
  // No population.json — which the DELIVERED registration requires and the
  // change-impact one does not. So the error names which registration was
  // resolved, and picking the default would have produced a different one.
  writeFileSync(
    join(out, "scenarios.json"),
    JSON.stringify({ registration: "code-awareness-delivered", registration_version: 3, scenarios: [] }),
  );
  writeFileSync(join(out, "candidates.jsonl"), "");
  const { code, stderr } = runSelect(out);
  assert.notEqual(code, 0);
  assert.match(stderr, /code-awareness-delivered: frozen population\.json is missing/);
});

test("an empty sample is refused rather than written", () => {
  const out = mkdtempSync(join(tmpdir(), "code-roi-select-empty-"));
  // The change-impact registration: no frozen population to satisfy, a repo
  // order that this empty candidate file cannot match. Before the guard this
  // wrote a 0-scenario file and exited 0 — and that file then WAS the
  // archive's identity for every later command.
  writeFileSync(join(out, "candidates.jsonl"), "");
  const { code, stderr } = runSelect(out);
  assert.notEqual(code, 0);
  assert.match(stderr, /Refusing to write an empty scenario file/);
  assert.equal(existsSync(join(out, "scenarios.json")), false);
});

test("the frozen registration names the population that is actually on disk", () => {
  const registration = loadRegistrationById("code-awareness-delivered");
  assert.equal(registration.status, "numbers_registered");
  const frozen = registration.population.freeze;
  // Nothing may still read as a placeholder: a run started against
  // "TO_BE_REMINED_UNDER_TESTS_V2" would compare a hash against a sentence.
  for (const [field, value] of Object.entries(frozen)) {
    if (typeof value !== "string") continue;
    assert.doesNotMatch(value, /^TO_BE_/, `${field} is still a placeholder`);
  }
  assert.match(frozen.population_sha256, /^[0-9a-f]{64}$/);
  assert.match(frozen.repository_head, /^[0-9a-f]{40}$/);
  assert.equal(frozen.truth_rule, registration.unit_and_truth.truth_rule);

  const archive = join(process.env.HOME ?? "", ".bastra", "eval", "code-roi-delivered-recall-v2");
  const path = join(archive, "population.json");
  if (!existsSync(path)) return; // the archive is the run's, not the repository's
  const population = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(populationFreezeMismatches(registration, population), []);
  assert.equal(population.accepted, registration.sample.mined_n);

  // Every candidate carries a real decision. 46 of them were once recorded as
  // `not evaluable: baseline error` because their tree predates this
  // repository's test suite: the empty selection ran the runner against no
  // files, and the candidate was dropped before the TYPE half of the union
  // rule ever looked at it. A population may reject a candidate, but it may
  // not fail to judge one for a reason that is about the harness.
  assert.equal(
    Object.keys(population.rejected).some((r) => r.startsWith("not evaluable")),
    false,
    `unjudged candidates remain: ${JSON.stringify(population.rejected)}`,
  );

  const candidates = readFileSync(join(archive, "candidates.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const testless = candidates.filter(
    (c) => (c.testSelection as { mode?: string } | undefined)?.mode === "no_tests",
  );
  assert.ok(testless.length > 0, "the testless-tree path is exercised by this population");
  for (const c of testless) {
    // Decided on types alone, and saying so: a scenario with no broken test
    // must never be labelled as having test truth.
    assert.notEqual(c.truthSource, "tests");
    assert.deepEqual(c.truthFromTests, []);
    assert.deepEqual(c.brokenTests, []);
  }
});
