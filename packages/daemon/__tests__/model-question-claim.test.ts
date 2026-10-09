/**
 * "asked" is claimed inside the settings lock and never replaces a decision;
 * two commands finishing together ask once.
 *
 * Second counter-review of the model-recommendation notice (PR #1118, on
 * 1fc5ad07); its reproduction kept as a test. No Ollama, only invented files.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/model-question-claim.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { cmdModels, maybeAskModelCatchUp, modelNoticeAfterCommand } from "../src/cli/models-cmd.js";
import { claimModelQuestion, pendingModelNotice, recordModelAnswer } from "../src/model-recommendation.js";
import { pathLockFilePath } from "../src/path-lock.js";
import { readSettings } from "../src/settings.js";
import { ARGS, ORIGINAL, deps, quiet, withDir } from "./fixtures/model-decision-helpers.js";
// ── P2: "asked" is claimed, never written over a decision ───────────────────

test("P2 claim: `asked` is only noted where there is no note for this recommendation", async () => {
  await withDir(async (_dir, path) => {
    assert.equal(await claimModelQuestion("fixture-rec", path), true);
    assert.equal((await readSettings(path)).modelRecommendation?.answer, "asked");
    assert.equal(await claimModelQuestion("fixture-rec", path), false, "asked once");
    for (const answer of ["dismissed", "later", "switched"] as const) {
      await recordModelAnswer("fixture-rec", answer, path);
      assert.equal(await claimModelQuestion("fixture-rec", path), false);
      assert.equal((await readSettings(path)).modelRecommendation?.answer, answer, `${answer} is not taken back`);
    }
    // A note for an older recommendation does not block the new one.
    assert.equal(await claimModelQuestion("fixture-rec-2", path), true);
  });
});

test("P2 race: a decision that lands while the catch-up is starting is never turned back into `asked`", async () => {
  // The counter-review paused the catch-up after its check and recorded
  // "dismissed" in the gap. Here the pause is tried at every read of the
  // settings file the catch-up makes: wherever the dismiss lands, it stands.
  const realRead = fs.readFile;
  for (let pauseAt = 1; pauseAt <= 14; pauseAt++) {
    await withDir(async (dir, path) => {
      let reads = 0;
      let questions = 0;
      let signal!: () => void;
      let resume!: () => void;
      const stopped = new Promise<void>((r) => (signal = r));
      const gate = new Promise<void>((r) => (resume = r));
      fs.readFile = (async (p: never, ...args: never[]) => {
        const result = await (realRead as (...a: unknown[]) => Promise<unknown>)(p, ...args);
        if (p === path && ++reads === pauseAt) { signal(); await gate; }
        return result;
      }) as typeof fs.readFile;
      syncBuiltinESMExports();
      try {
        const asking = quiet(() =>
          modelNoticeAfterCommand(ARGS, deps(path, { interactive: true, ask: async () => { questions++; return null; }, shownPath: join(dir, "shown.txt") })),
        );
        const reached = await Promise.race([stopped.then(() => true), asking.then(() => false)]);
        // The explicit decision from elsewhere. Not awaited before the resume:
        // if the pause sits inside the settings lock, it has to wait for it.
        const dismissing = reached ? recordModelAnswer("fixture-rec", "dismissed", path) : Promise.resolve();
        await new Promise((r) => setTimeout(r, 15));
        resume();
        await Promise.all([asking, dismissing]);
        if (!reached) return; // the catch-up makes fewer reads than this
        const stored = JSON.parse(await (realRead as (p: string, e: string) => Promise<string>)(path, "utf8"));
        assert.equal(stored.modelRecommendation.answer, "dismissed", `pause at read ${pauseAt}: dismissed → ${stored.modelRecommendation.answer}`);
        assert.ok(questions <= 1);
        fs.readFile = realRead;
        syncBuiltinESMExports();
        assert.equal(await pendingModelNotice(deps(path)), null, `pause at read ${pauseAt}: nothing is pending after a dismiss`);
      } finally {
        fs.readFile = realRead;
        syncBuiltinESMExports();
      }
    });
  }
});

test("P2 race: two commands finishing together put the question once", async () => {
  await withDir(async (_dir, path) => {
    let questions = 0;
    const ask = async () => { questions++; await new Promise((r) => setTimeout(r, 20)); return null; };
    const { result } = await quiet(() => Promise.all([1, 2, 3].map(() => maybeAskModelCatchUp(deps(path, { interactive: true, ask })))));
    assert.deepEqual([...result].sort(), [false, false, true]);
    assert.equal(questions, 1);
  });
});

test("P2: `bastra update` does not ask over a decision either, and still re-asks an open question", async () => {
  await withDir(async (_dir, path) => {
    const asked: number[] = [];
    const ask = async () => { asked.push(1); return null; };
    const update = () => quiet(() => cmdModels({ sub: "ask", settingsPath: path, deps: deps(path, { interactive: true, ask }) }));
    await update();
    await update();
    assert.equal(asked.length, 2, "an unanswered question is open: the updater asks again");
    await recordModelAnswer("fixture-rec", "dismissed", path);
    await update();
    assert.equal(asked.length, 2);
    assert.equal((await readSettings(path)).modelRecommendation?.answer, "dismissed");
  });
});

test("P2 claim: a settings file that is not valid JSON takes no note — and is not written over", async () => {
  await withDir(async (_dir, path) => {
    const CORRUPT = '{"api":{"token":"invented-token"},BROKEN';
    await writeFile(path, CORRUPT);
    await assert.rejects(quiet(() => claimModelQuestion("fixture-rec", path)), /not valid JSON/);
    assert.equal(await readFile(path, "utf8"), CORRUPT);
    assert.equal(await quiet(() => maybeAskModelCatchUp(deps(path, { interactive: true, ask: async () => "s" }))).then((r) => r.result), false);
  });
});

// ── without the lock, no claim and no answer ─────────────────────────────────

/** The lock file a holder left behind when it was killed: nobody releases it. */
async function orphanedLock(path: string, ageMs = 0): Promise<void> {
  const lock = pathLockFilePath(path);
  await writeFile(lock, JSON.stringify({ pid: 999_999, host: "elsewhere", ts: Date.now() - ageMs, token: "orphan" }));
  const then = new Date(Date.now() - ageMs);
  await utimes(lock, then, then);
}

test("P2 lock: while the settings lock cannot be had, the question is not put and no answer is written", async () => {
  // The counter-review killed a lock holder and started three catch-ups: after
  // the 5 s wait each went on WITHOUT the lock, and each asked. path-lock's
  // fail-open stays as it is for other writers (#1114); the question claim and
  // the model answers must not use it.
  await withDir(async (_dir, path) => {
    await orphanedLock(path);
    let questions = 0;
    const ask = async () => { questions++; return null; };
    // One after the other, so neither result depends on which came first.
    const catchUp = await quiet(() => maybeAskModelCatchUp(deps(path, { interactive: true, ask })));
    assert.equal(catchUp.result, false, "no claim without the lock");
    assert.equal(questions, 0, "…so no question; it comes back with the next command");
    assert.equal(await readFile(path, "utf8"), ORIGINAL);
    await orphanedLock(path); // a fresh one: the first has aged towards takeover while the catch-up waited
    const later = await quiet(() => cmdModels({ sub: "later", positional: ["models", "later", "fixture-rec"], settingsPath: path, deps: deps(path) }));
    assert.equal(later.result, 1, "an answer is refused, not written unserialized");
    assert.match(later.out, /could not get the lock on the settings file/);
    assert.match(later.out, /Nothing was changed/);
    assert.equal(await readFile(path, "utf8"), ORIGINAL);
  });
});

test("P2 lock: a lock old enough to be orphaned is taken over — then one question, as usual", async () => {
  await withDir(async (_dir, path) => {
    await orphanedLock(path, 60_000);
    let questions = 0;
    const ask = async () => { questions++; return null; };
    const { result } = await quiet(() => Promise.all([1, 2, 3].map(() => maybeAskModelCatchUp(deps(path, { interactive: true, ask })))));
    assert.deepEqual([...result].sort(), [false, false, true]);
    assert.equal(questions, 1);
    assert.equal((await readSettings(path)).modelRecommendation?.answer, "asked");
  });
});
