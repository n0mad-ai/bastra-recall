/**
 * `scripts/test-env.mjs` caps stdout inside test children (#414).
 *
 * The class behind #383: under `node --test`, a child's stdout is the same pipe
 * that carries the runner's v8-serialized result frames. Node <= 22.23.2 /
 * 24.19.0 read the frame length signed, so a non-ASCII byte landing where a
 * length is expected crashes the parent's decoder (nodejs/node#64061). Six test
 * files guard against it by hand; 26 import from `src/cli/` and 15 CLI modules
 * print `✓ …`. The shim closes it for all of them at once.
 *
 * Two halves, and the second is the one that is easy to get wrong: a blunt
 * `process.stdout.write = () => true` also swallows the RUNNER's frames. The
 * run still goes red on a failure, but the failing test's name and diff are
 * gone and the summary counts files instead of tests — a suite that reports
 * nothing useful is not a fixed suite. So this asserts both that raw output is
 * gone and that the frames still arrive.
 *
 * Runner: node --test tools/__tests__/test-env-stdout.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SHIM = fileURLToPath(new URL("../../scripts/test-env.mjs", import.meta.url));

/** A fixture that prints raw `✓ …` lines the way every `src/cli/` module does. */
const NOISY = `
import test from "node:test";
import assert from "node:assert/strict";
test("prints raw non-ASCII status lines on stdout", () => {
  for (let i = 0; i < 200; i++) process.stdout.write(\`✓ Regel \${i} übernommen — ü ä ö ✓\\n\`);
  console.log("✓ auch über console.log");
  assert.ok(true);
});
test("a second test in the same child", () => assert.ok(true));
`;

const FAILING = `
import test from "node:test";
import assert from "node:assert/strict";
test("this failure must stay legible", () => {
  process.stdout.write("✓ noise before the failure\\n");
  assert.equal(1, 2);
});
`;

/**
 * Run a nested `node --test` over the fixtures, exactly as the root `test`
 * script does. Its output is captured here instead of travelling on our own
 * child's pipe, so this test observes the shim rather than being subject to it.
 */
async function runNested(files, dir) {
  // `NODE_TEST_CONTEXT` is inherited, and a node that sees it refuses to run
  // files ("run() is being called recursively"). The nested runner sets it for
  // its OWN children again — which is exactly the environment under test.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", SHIM, "--test", ...files],
      { cwd: dir, encoding: "utf8", env },
    );
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

async function fixtures(t) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-testenv-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await writeFile(join(dir, "noisy.test.mjs"), NOISY, "utf8");
  await writeFile(join(dir, "failing.test.mjs"), FAILING, "utf8");
  return dir;
}

test("a child's raw non-ASCII stdout never reaches the frame pipe", async (t) => {
  const dir = await fixtures(t);
  const run = await runNested(["noisy.test.mjs"], dir);

  assert.equal(run.code, 0, `the run must pass:\n${run.out}`);
  assert.ok(
    !run.out.includes("Regel 0 übernommen"),
    "the raw status lines must be capped in the child",
  );
  assert.ok(!run.out.includes("auch über console.log"), "console.log too");
  // Without the shim the same fixture puts 201 raw lines on the pipe; with it,
  // what remains is the reporter's own output.
  assert.ok(
    run.out.includes("prints raw non-ASCII status lines on stdout"),
    `the runner's frames must still arrive:\n${run.out}`,
  );
  assert.ok(run.out.includes("a second test in the same child"), "every frame, not just the first");
  assert.match(run.out, /pass 2/, "individual tests are counted, not files");
});

test("capping stdout does not cost the failure its name and diff", async (t) => {
  const dir = await fixtures(t);
  const run = await runNested(["failing.test.mjs"], dir);

  assert.notEqual(run.code, 0, "a failing fixture must fail the nested run");
  assert.ok(!run.out.includes("noise before the failure"), "the noise is still capped");
  // The regression a blunt no-op would introduce: red, but unreadable.
  assert.ok(
    run.out.includes("this failure must stay legible"),
    `the failing test must be named:\n${run.out}`,
  );
  assert.match(run.out, /1 !== 2/, "and its assertion must survive");
});

test("the shim leaves the parent's own reporter output alone", async (t) => {
  const dir = await fixtures(t);
  // The parent writes its human-readable summary as strings. It is only capped
  // in a test child (NODE_TEST_CONTEXT), and this is what proves the guard:
  // without it, the output below would be blank.
  const run = await runNested(["noisy.test.mjs", "failing.test.mjs"], dir);

  // Asserted on what the REPORT says, never on how a reporter formats it: the
  // default differs by Node version (TAP on 22, spec on 24), and `failing
  // tests:` — a spec-only heading — is what turned this test red on CI. Counts
  // and names survive both ("# fail 1" vs "ℹ fail 1"), because they come from
  // the test run and not from the layout.
  assert.ok(run.out.trim().length > 0, "the parent must still report at all");
  assert.match(run.out, /tests 3/, "all three tests counted");
  assert.match(run.out, /fail 1/, "the failure counted");
  assert.ok(
    run.out.includes("this failure must stay legible"),
    `the failure must be named in the parent's report:\n${run.out}`,
  );
});
