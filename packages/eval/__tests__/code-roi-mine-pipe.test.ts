/**
 * The mining run survives a broken pipe (#606).
 *
 * The first tests/v2 pass died after two and a half hours at 732 of roughly a
 * thousand candidates: `tar` closed the stdin `git archive` was still writing
 * to, the resulting `EPIPE` was an `error` event on a stream nobody listened
 * to, and node ended the process. A crash that looks like a finished run is
 * the worst shape this failure can take — the accepted count had plateaued, so
 * the population looked exhausted when it was merely abandoned.
 *
 * Both tests here are about that one line of difference. The first reproduces
 * the crash on the UNGUARDED pattern, in a child process, so the test proves
 * the failure mode is real rather than asserting a fix against nothing. The
 * second runs the same pipe through `pipeSpawn` and requires a rejection —
 * which the worker loop's per-candidate `catch` turns into "not evaluable".
 *
 * Run: npx tsx --test packages/eval/__tests__/code-roi-mine-pipe.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `repo-tree.mjs` is the half of the miner that has no module-level state:
// importing it costs nothing and needs no archive.
// @ts-expect-error — plain .mjs measurement script, no declarations
const { pipeSpawn } = await import("../code-roi/v2/repo-tree.mjs");

/**
 * A producer that keeps writing into a consumer that has already gone. `yes`
 * never stops on its own and `false` exits at once, so the write lands on a
 * closed pipe every time rather than racing it.
 */
const PRODUCER = ["yes", ["x"]] as const;
const CONSUMER = ["false", [] as string[]] as const;

describe("a broken pipe is a failed candidate, not a failed run", () => {
  test("the unguarded pattern really does kill the process", () => {
    // The exact shape `extract()` had: handlers on the two ChildProcess
    // objects, none on the streams the pipe runs over.
    const script = `
      const { spawn } = require("node:child_process");
      const p = spawn("yes", ["x"]);
      const c = spawn("false");
      p.stdout.pipe(c.stdin);
      p.on("error", () => process.exit(9));
      c.on("error", () => process.exit(9));
      c.on("close", () => {});
      setTimeout(() => process.exit(0), 4000);
    `;
    const child = spawn(process.execPath, ["-e", script]);
    return new Promise<void>((resolve) => {
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        assert.notEqual(code, 0, "the unguarded pipe must not survive — otherwise this test guards nothing");
        assert.match(stderr, /EPIPE|ERR_STREAM_DESTROYED|Unhandled 'error' event/);
        resolve();
      });
    });
  });

  test("pipeSpawn turns the same failure into a rejection", async () => {
    await assert.rejects(
      () => pipeSpawn(spawn(...PRODUCER), spawn(...CONSUMER), "probe"),
      /^Error: probe: /,
      "the label names which step failed, so the candidate's reason says what went wrong",
    );
  });

  test("and still resolves when the pipe completes", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "code-roi-pipe-ok-")), "copy");
    await pipeSpawn(spawn("echo", ["hello"]), spawn("sh", ["-c", `cat > ${out}`]), "ok");
    // The consumer read the whole pipe and exited 0. That it resolved at all
    // is the assertion; the file only proves the bytes really went through.
    assert.equal(readFileSync(out, "utf8"), "hello\n");
  });

  test("the producer does not outlive a consumer that died", async () => {
    const producer = spawn(...PRODUCER);
    await assert.rejects(() => pipeSpawn(producer, spawn(...CONSUMER), "probe"));
    // Without the kill this `yes` runs until the mining run ends — and in a
    // test it holds the event loop open, so the suite never finishes.
    assert.equal(producer.killed, true);
  });

  test("a non-zero consumer carries its stderr into the reason", async () => {
    await assert.rejects(
      () => pipeSpawn(spawn("echo", ["x"]), spawn("tar", ["-x", "-C", "/nonexistent-code-roi-dir"]), "extract abc"),
      /^Error: extract abc: /,
    );
  });
});

describe("the mining run's own guard is the one that is wired up", () => {
  test("extractTree() goes through pipeSpawn rather than piping by hand", () => {
    // The working copy, not HEAD: the point is that nobody reintroduces the
    // hand-rolled pipe, and a guard that only reads the committed file would
    // pass on exactly the change it exists to catch.
    const current = readFileSync(new URL("../code-roi/v2/repo-tree.mjs", import.meta.url).pathname, "utf8");
    const extractBody = current.slice(current.indexOf("export async function extractTree("));
    const body = extractBody.slice(0, extractBody.indexOf("\n}\n") + 3);
    assert.match(body, /pipeSpawn\(/);
    assert.doesNotMatch(body, /\.stdout\.pipe\(/, "the pipe belongs in pipeSpawn, where its errors are handled");
  });
});
