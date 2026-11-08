import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { githubAdvisoryOnce } from "../src/github-advisory-delivery.js";
import { createLaneDelivery } from "../src/lane-delivery.js";
import { loadSessionState, mutateSessionState } from "../src/session-state.js";

test("#1391: parallel writes reserve one advice packet and an expired unfinished claim can retry", async t => {
  const root = await mkdtemp(join(tmpdir(), "github-advice-parallel-"));
  const prior = process.env.BASTRA_HOOK_STATE_DIR; process.env.BASTRA_HOOK_STATE_DIR = root;
  t.after(async () => { if (prior === undefined) delete process.env.BASTRA_HOOK_STATE_DIR; else process.env.BASTRA_HOOK_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); });
  const values = await Promise.all(Array.from({ length: 8 }, () => githubAdvisoryOnce("parallel", "invented note", Date.now() + 3000)));
  assert.equal(values.filter(Boolean).length, 1);
  assert.deepEqual((await loadSessionState("parallel")).githubAdvisory, { delivered: true });
  await mutateSessionState("expired", state => { state.githubAdvisory = { token: "old", deadline: 0 }; });
  assert.equal(await githubAdvisoryOnce("expired", "invented note", Date.now() + 3000), "invented note");
  await mutateSessionState("malformed", state => { state.githubAdvisory = "invalid" as never; state.claimedMustLoad = ["invented-rule"]; });
  assert.deepEqual((await loadSessionState("malformed")).claimedMustLoad, ["invented-rule"], "a malformed optional advice marker cannot erase rule state");
});

test("#1391: an undelivered HTTP advice packet does not spend the session allowance", async t => {
  const root = await mkdtemp(join(tmpdir(), "github-advice-http-"));
  const prior = process.env.BASTRA_HOOK_STATE_DIR; process.env.BASTRA_HOOK_STATE_DIR = root;
  t.after(async () => { if (prior === undefined) delete process.env.BASTRA_HOOK_STATE_DIR; else process.env.BASTRA_HOOK_STATE_DIR = prior; await rm(root, { recursive: true, force: true }); });
  let ready!: () => void, release!: () => void, closed!: () => void;
  const produced = new Promise<void>(r => ready = r), hold = new Promise<void>(r => release = r), gone = new Promise<void>(r => closed = r);
  let first = true;
  const server = createServer((q, r) => {
    q.resume(); const delivery = createLaneDelivery(r);
    void delivery.run(async () => {
      const text = await githubAdvisoryOnce("http", "invented note", Date.now() + 3000);
      if (first) { first = false; r.once("close", closed); ready(); await hold; }
      delivery.answer(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } }));
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const port = (server.address() as { port: number }).port;
  const cancelled = request({ host: "127.0.0.1", port, method: "POST" }); cancelled.on("error", () => {}); cancelled.end();
  await produced; cancelled.destroy(); await gone; release();
  for (let i = 0; i < 100 && (await loadSessionState("http")).githubAdvisory; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal((await loadSessionState("http")).githubAdvisory, undefined);
  const get = async () => (await (await fetch(`http://127.0.0.1:${port}`, { method: "POST" })).json()) as { hookSpecificOutput: { additionalContext: string } };
  assert.equal((await get()).hookSpecificOutput.additionalContext, "invented note");
  for (let i = 0; i < 100; i++) { const state = (await loadSessionState("http")).githubAdvisory; if (state && "delivered" in state) break; await new Promise(r => setTimeout(r, 5)); }
  assert.deepEqual((await loadSessionState("http")).githubAdvisory, { delivered: true });
  assert.equal((await get()).hookSpecificOutput.additionalContext, "");
});
