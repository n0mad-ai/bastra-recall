/**
 * #1114: a rejection in the draft store must survive a writer that froze while
 * holding the lock (sleep, debugger, SIGSTOP) with an older snapshot.
 *
 * Reproduction from the issue: writer A holds the draft lock with the draft
 * still open and is paused. Writer B rejects the draft. Before the fix B took
 * the lock over by age (or wrote without it after five seconds), reported the
 * rejection — and A, resumed, wrote its older snapshot over it: the rejected
 * draft was open again. Now B waits for a live owner and then refuses; only a
 * lock whose owner has ended is taken over.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/draft-store-frozen-writer.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftFingerprint, draftId, listDrafts, upsertDraft, type Draft } from "../src/draft-store.js";
import { rejectDrafts } from "../src/draft-review.js";
import { pathLockFilePath, PathLockUnavailableError } from "../src/path-lock.js";

const now = Date.now();
function draft(): Draft {
  const quote = "Always run the migration dry-run before deploying the billing service.";
  const fp = draftFingerprint(quote);
  return {
    id: draftId("frozen", 1, fp),
    fp,
    kind: "typed",
    quote,
    situation: { before: [], after: [], reads: [], lits: [] },
    evidence: [{ session_id: "frozen", turn: 1, ts: now }],
    created: now,
    last_touched: now,
    surfaced: [],
    state: "open",
  };
}

/** Writer A in its own process: takes the draft lock, reads the snapshot with
 * the draft open, says "held" and then waits for stdin before writing. */
async function holdingWriter(path: string): Promise<ChildProcess> {
  const module = new URL("../src/draft-store.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { transactDrafts } from ${JSON.stringify(module)};
       await transactDrafts(async (rows) => {
         process.stdout.write("held\\n");
         await new Promise((resolve) => process.stdin.once("data", resolve));
         for (const row of rows) row.last_touched += 1;
       });
       process.exit(0);`,
    ],
    { env: { ...process.env, BASTRA_DRAFTS_PATH: path }, stdio: ["pipe", "pipe", "inherit"] }
  );
  let out = "";
  for await (const chunk of child.stdout!) {
    out += String(chunk);
    if (out.includes("held")) break;
  }
  return child;
}

async function isolated(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-1114-"));
  const previous = process.env.BASTRA_DRAFTS_PATH;
  const path = join(dir, "drafts.json");
  process.env.BASTRA_DRAFTS_PATH = path;
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await fn(path);
  } finally {
    process.stderr.write = write;
    if (previous === undefined) delete process.env.BASTRA_DRAFTS_PATH;
    else process.env.BASTRA_DRAFTS_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("#1114: a frozen live writer is never written over, and a rejection survives its resume", () =>
  isolated(async (path) => {
    await upsertDraft(draft(), now);
    const child = await holdingWriter(path);
    try {
      child.kill("SIGSTOP"); // the frozen writer: alive, holding the lock and an older snapshot
      // Past the age after which the lock used to be taken over (10 s).
      const old = new Date(Date.now() - 60_000);
      await utimes(pathLockFilePath(path), old, old);

      let acknowledged = false;
      try {
        acknowledged = (await rejectDrafts([draft().id]))[0].outcome === "rejected";
      } catch (error) {
        assert.ok(error instanceof PathLockUnavailableError, String(error));
      }
      assert.equal(acknowledged, false, "the rejection ran over a live lock owner");

      child.kill("SIGCONT");
      child.stdin!.write("go\n");
      const [code] = await once(child, "exit");
      assert.equal(code, 0);
    } finally {
      child.kill("SIGKILL");
    }
    // Once the writer has finished, the rejection goes through and stays.
    assert.equal((await rejectDrafts([draft().id]))[0].outcome, "rejected");
    assert.equal((await listDrafts()).find((row) => row.id === draft().id)?.state, "rejected");
  }));

test("#1114: a lock whose owner has ended is taken over at once", () =>
  isolated(async (path) => {
    await upsertDraft(draft(), now);
    const child = await holdingWriter(path);
    child.kill("SIGKILL"); // dies holding the lock; the lock file stays behind
    await once(child, "exit");
    const started = Date.now();
    assert.equal((await rejectDrafts([draft().id]))[0].outcome, "rejected");
    // Before the fix a young orphaned lock was waited out for five seconds.
    assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
    assert.equal((await listDrafts()).find((row) => row.id === draft().id)?.state, "rejected");
  }));
