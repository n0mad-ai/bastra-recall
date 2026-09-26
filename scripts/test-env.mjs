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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One temp root per test run, and the developer's own bastra settings kept out.
 *
 * Only the FIRST process that imports this file does the setup — the runner, or
 * a lone `node --import … -e`. It exports BASTRA_TEST_RUN_ROOT, so every test
 * child it spawns (and whatever those spawn) sees the setup as already done:
 * a variable a child has at that point was put there by a test on purpose.
 *
 * The temp root. TMPDIR/TEMP/TMP point into a directory this process removes
 * when it exits, on a signal as well, so every `mkdtemp(tmpdir())` anywhere in
 * the run is cleaned up with it. One run used to leave its directories behind
 * for good — measured: 953 `bastra-test-eval-runs-*` + 951 `bastra-test-logs-*`
 * in a Linux /tmp, 767 `bastra-*` in a Windows %TEMP% (no reboot sweep there),
 * and a further 76 from individual test files after those two were fixed.
 *
 * The settings. CI exports none of them, so the suite is green there and was
 * red on any machine where bastra is in use: BASTRA_VAULT_PATH from a shell
 * profile sent `arm-plumbing`'s spawned CLI into the real vault (`0 !== 100`),
 * and BASTRA_OLLAMA_URL, BASTRA_EMBEDDING_*, BASTRA_HOOK_STATE_DIR, … select a
 * model or point at real state the same way. Every BASTRA_* / NEXUS_* input is
 * dropped. Two OUTPUT locations are the exception, with their old contract
 * (#420): a caller who chose BASTRA_LOG_PATH or BASTRA_EVAL_RUNS_DIR keeps it.
 * `BASTRA_TEST_KEEP_ENV=1` keeps everything, for a deliberate run against a
 * chosen vault.
 */
const CALLER_CHOSEN_OUTPUTS = new Set(["BASTRA_LOG_PATH", "BASTRA_EVAL_RUNS_DIR"]);

if (!process.env.BASTRA_TEST_RUN_ROOT) {
  if (process.env.BASTRA_TEST_KEEP_ENV !== "1") {
    for (const key of Object.keys(process.env)) {
      if (/^(BASTRA|NEXUS)_/.test(key) && !CALLER_CHOSEN_OUTPUTS.has(key)) delete process.env[key];
    }
  }
  const root = mkdtempSync(join(tmpdir(), "bastra-test-run-"));
  process.env.BASTRA_TEST_RUN_ROOT = root;
  process.env.TMPDIR = root;
  process.env.TEMP = root;
  process.env.TMP = root;
  // bastra's archiving rm (#650) is on by default on claude-code. The suite
  // uses `rm -rf` as its stock destructive command, so a test sees the STOP
  // unless it turns the shim on; and the archive never lands in ~/.bastra.
  process.env.BASTRA_RM_SHIM = "0";
  process.env.BASTRA_ARCHIVE_DIR = join(root, "archive");
  const removeRoot = () => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A handle still open on Windows — leftover disk, never a failed run.
    }
  };
  process.on("exit", removeRoot);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      removeRoot();
      process.kill(process.pid, signal);
    });
  }
}

/** Throwaway directories live under the run root, so they go with it. */
function throwawayDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

if (!process.env.BASTRA_LOG_PATH) {
  process.env.BASTRA_LOG_PATH = throwawayDir("bastra-test-logs-");
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
  process.env.BASTRA_EVAL_RUNS_DIR = throwawayDir("bastra-test-eval-runs-");
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
