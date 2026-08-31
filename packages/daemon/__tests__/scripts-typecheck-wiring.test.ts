/**
 * The operational scripts are type-checked (#419).
 *
 * `tsconfig.json` includes `src/**` only, so `npm run check:types` never saw
 * anything under `scripts/` — 19 operational scripts (eval-stress, the migrate-*
 * pair, backfill-related, cue-batch, …) compiled for the first time when someone
 * ran them, typically mid-operation on real data. Two had drifted: `commit-pool`
 * built a `CandidatePoolEntry` without `scoreKind`, `telemetry-smoke` a
 * `LoadMemoryEvent` without the two hook-hint fields.
 *
 * Running `tsc` here would cost the suite seconds, so this pins the WIRING
 * instead: the second config exists, checks the scripts, emits nothing, and the
 * package's `check:types` actually invokes it. Losing any of those silently is
 * the failure this guards — the type errors themselves are caught by
 * `npm run check:types`.
 *
 * Run: npx tsx --test packages/daemon/__tests__/scripts-typecheck-wiring.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkgRoot = join(import.meta.dirname, "..");
const read = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(pkgRoot, name), "utf8").replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>;

test("a second tsconfig type-checks scripts/ without emitting (#419)", () => {
  const cfg = read("tsconfig.scripts.json");
  assert.equal(cfg.extends, "./tsconfig.json", "it inherits the daemon's compiler options, it does not restate them");
  assert.deepEqual(cfg.include, ["scripts/**/*.ts"]);

  const opts = cfg.compilerOptions as Record<string, unknown>;
  assert.equal(opts.noEmit, true, "checking the scripts must not produce a second dist tree");
});

test("the build still compiles src/ only, so nothing about it changed (#419)", () => {
  const base = read("tsconfig.json");
  assert.deepEqual(base.include, ["src/**/*.ts"], "widening this include would put scripts into dist/");
});

test("check:types actually runs the scripts config (#419)", () => {
  const pkg = read("package.json");
  const script = String((pkg.scripts as Record<string, string>)["check:types"]);
  assert.match(script, /tsconfig\.scripts\.json/, "a config nobody invokes checks nothing");
  assert.match(script, /tsc --noEmit/, "and the src check stays");
});
