import { test } from "node:test";
import assert from "node:assert/strict";

// @ts-expect-error — plain .mjs measurement script, no declarations
import { populationFreezeMismatches } from "../code-roi/v2/select.mjs";
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
  const registration = loadRegistrationById("code-awareness-delivered");
  const verdict = await preflightBuild({ registrationId: "code-awareness-delivered", registration });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "population_pending");
});
