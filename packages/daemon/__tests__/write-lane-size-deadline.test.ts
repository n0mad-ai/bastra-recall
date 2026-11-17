/**
 * #1538 — the file-size note in the write lane has its own deadline.
 *
 * The slow note is injected without touching the code: the edited file is a
 * named pipe (FIFO). Opening it for reading blocks until a writer appears, so
 * `readFile` inside the note never finishes on its own — the slowest disk
 * there is. Without the deadline the lane hangs on it; with it the lane
 * answers in time and exactly as if there had been no note. The pipe is
 * released at the end so no worker thread stays blocked.
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWriteLane } from "../src/write-lane.js";
import { fileSizeNote } from "../src/file-size-check.js";

const DEAD_DAEMON = "http://127.0.0.1:9";

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const lane = (filePath: string, cwd: string) =>
  runWriteLane(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      session_id: "size-deadline-1538",
      cwd,
      tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
    },
    DEAD_DAEMON
  );

test("#1538: a size note that never finishes does not hold the lane past its deadline", async (t) => {
  if (process.platform === "win32") return t.skip("named pipes via mkfifo are POSIX-only");
  const dir = await mkdtemp(join(tmpdir(), "bastra-size-deadline-"));
  const fifo = join(dir, "stuck.ts");
  execFileSync("mkfifo", [fifo]);
  try {
    await withEnv({ BASTRA_TELEMETRY: "off", BASTRA_HOOK_STATE_DIR: dir, BASTRA_DRAFT_HINTS: "0" }, async () => {
      const started = Date.now();
      const out = await lane(fifo, dir);
      const elapsed = Date.now() - started;
      // Deadline is a quarter of the 600 ms lane budget; the dead daemon
      // answers at once. Far below the lane budget, far above a hang.
      assert.ok(elapsed < 450, `lane took ${elapsed} ms`);
      // Same document as an edit without a note: nothing to say.
      const plain = join(dir, "plain.ts");
      await writeFile(plain, "export const a = 1;\n");
      assert.equal(out, await lane(plain, dir));
      assert.equal(out, "{}");
    });
  } finally {
    // Release the blocked reader: a writer opens and closes the pipe (EOF).
    await (await open(fifo, "w")).close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1538: before its deadline the note is unchanged; past it the answer is null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-size-deadline-note-"));
  const file = join(dir, "big.ts");
  await writeFile(file, "export const x = 1;\n".repeat(900));
  try {
    const open = await fileSizeNote(file, join(dir, "none.json"), dir);
    assert.match(open ?? "", /900/);
    assert.equal(await fileSizeNote(file, join(dir, "none.json"), dir, Date.now() + 5000), open);
    assert.equal(await fileSizeNote(file, join(dir, "none.json"), dir, Date.now() - 1), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
