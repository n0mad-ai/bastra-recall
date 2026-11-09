import { withPathLock } from "../src/path-lock.js";
import { readSettingsFixture, writeSettingsFixture } from "./fixtures/settings-db.js";
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
import { utimes, writeFile } from "node:fs/promises";
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

test("P2 race: a decision racing the catch-up is never turned back into asked", async () => {
  for(const dismissFirst of [true,false]) await withDir(async(dir,path)=>{
    let enter!:()=>void,release!:()=>void,questions=0;
    const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);
    const held=withPathLock(path,async()=>{enter();await gate;},{crossProcess:true,requireLock:true});
    await entered;
    const ask=()=>quiet(()=>modelNoticeAfterCommand(ARGS,deps(path,{interactive:true,ask:async()=>{questions++;return null;},shownPath:join(dir,"shown.txt")})));
    let asking:Promise<unknown>,dismissing:Promise<unknown>;
    if(dismissFirst){dismissing=recordModelAnswer("fixture-rec","dismissed",path);asking=ask();}
    else {asking=ask();dismissing=recordModelAnswer("fixture-rec","dismissed",path);}
    release();await Promise.all([held,asking,dismissing]);
    const stored=JSON.parse(await readSettingsFixture(path));
    assert.equal(stored.modelRecommendation.answer,"dismissed");assert.ok(questions<=1);
    assert.equal(await pendingModelNotice(deps(path)),null);
  });
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
    await writeSettingsFixture(path, CORRUPT);
    await assert.rejects(quiet(() => claimModelQuestion("fixture-rec", path)), /not valid JSON/);
    assert.equal(await readSettingsFixture(path, "utf8"), CORRUPT);
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
    assert.equal(await readSettingsFixture(path, "utf8"), ORIGINAL);
    await orphanedLock(path); // a fresh one: the first has aged towards takeover while the catch-up waited
    const later = await quiet(() => cmdModels({ sub: "later", positional: ["models", "later", "fixture-rec"], settingsPath: path, deps: deps(path) }));
    assert.equal(later.result, 1, "an answer is refused, not written unserialized");
    assert.match(later.out, /could not get the lock on the settings file/);
    assert.match(later.out, /Nothing was changed/);
    assert.equal(await readSettingsFixture(path, "utf8"), ORIGINAL);
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
