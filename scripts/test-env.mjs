/**
 * Test-run isolation for anything that writes user data.
 *
 * `new Telemetry()` resolves its log dir at construction: BASTRA_LOG_PATH, else
 * ~/.bastra/logs. 22 test files construct one without redirecting it, so a plain
 * `npm test` appended 114 real telemetry events to the developer's own log —
 * 63 save_memory, 25 recall, 2 recall_episode carrying the fixture id "m1".
 *
 * That is not cosmetic. The event log is an INPUT: `bastra logs --stats` reports
 * from it, and `bastra bridges mint` mines it for (query → acted-on memory) reaches
 * and writes the resulting bridges into the Commons clone. Fixture rows in that log
 * become fixture bridges staged for contribution, and every measurement taken over
 * the log is contaminated by however many times the suite happened to run.
 *
 * Fixing this per-file would need 22 edits and would silently regress the next time
 * someone adds a 23rd. Redirecting once, here, closes the class: a test process
 * that did not deliberately choose a log dir gets a throwaway one. Files that set
 * BASTRA_LOG_PATH themselves are untouched — this only fills in the default.
 *
 * Wired via `--import` in the root `test` script, so it applies to every per-file
 * test process the runner spawns.
 *
 * The second thing it closes is #414: inside a test child, stdout is not a
 * console. It is the pipe that carries the runner's v8-serialized result frames,
 * and Node <= 22.23.2 / 24.19.0 read a frame length signed — so one non-ASCII
 * byte landing where a length is expected crashes the parent's decoder
 * (nodejs/node#64061, measured in #383: 9 of 20 full-suite runs). 26 daemon test
 * files import from `src/cli/`, 15 CLI modules print `✓ …` status lines, and six
 * test files guard against it by hand. Guarding the 27th is a convention nobody
 * can enforce; the pipe itself can be.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.BASTRA_LOG_PATH) {
  process.env.BASTRA_LOG_PATH = mkdtempSync(join(tmpdir(), "bastra-test-logs-"));
}

/**
 * The same class, a second directory (#420).
 *
 * Both artifact writers — `packages/eval/src/goldset-run.ts` and
 * `packages/daemon/scripts/stress-artifact.ts` — resolve their output as
 * `BASTRA_EVAL_RUNS_DIR ?? ~/.bastra/eval-runs`, so a suite pass that exercises
 * the stress harness deposits real run directories next to the real ones.
 * Measured on one `npm test`: two fresh directories, both with
 * `vault_path: packages/eval/fixtures/eval-vault` — fixture runs, indistinguishable
 * at a glance from the M0 baseline they sit beside. The directory had grown past
 * 490 entries that way.
 *
 * That matters because the registered baselines live there and are cited by path
 * in `m1-tolerances.json` and `cue-experiment.json`: a cleanup that swept too
 * broadly would delete evidence a release condition depends on. Same fix as
 * above, and for the same reason — per-test-file redirection is a convention
 * nobody can enforce, one default here closes the class.
 */
if (!process.env.BASTRA_EVAL_RUNS_DIR) {
  process.env.BASTRA_EVAL_RUNS_DIR = mkdtempSync(join(tmpdir(), "bastra-test-eval-runs-"));
}

/**
 * Keep application output off the frame pipe — but ONLY application output.
 *
 * A blunt `process.stdout.write = () => true` also swallows the runner's own
 * frames: measured, the run still goes red on a failure, but the failing test's
 * name and diff are gone and the summary counts FILES instead of tests. The two
 * are cleanly separable at this seam. `v8.serialize()` cannot return a string,
 * so every frame arrives as a Buffer; text output — `console.log`, every
 * `process.stdout.write(\`✓ …\`)` in `src/cli/` — arrives as a string. Dropping
 * strings therefore removes exactly the hazard and nothing else.
 *
 * Only in a test child. In the parent, the human-readable reporter writes
 * strings, and capping them there would blank the test output entirely.
 */
if (process.env.NODE_TEST_CONTEXT) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, encoding, callback) {
    if (typeof chunk !== "string") return write(chunk, encoding, callback);
    // A dropped write still has to look like a completed one: the callback is
    // the second argument when the encoding is omitted, and a stream whose
    // callback never fires can hang a caller that awaits its drain.
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") done(null);
    return true;
  };
}
