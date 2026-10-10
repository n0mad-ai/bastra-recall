import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingRelayEnabled, writePendingSuggestion, takePendingRelay, consumePendingSuggestions, settleProvisionalSuggestions } from "../src/pending-suggestions.js";
import { purgeDrafts, draftVectorsPath } from "../src/draft-store.js";
import { runSessionLane } from "../src/session-lane.js";

async function fixture(work: (path: string, drafts: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "relay-control-"));
  const env = { BASTRA_PENDING_SUGGESTIONS_PATH: join(dir, "relay.json"), BASTRA_DRAFTS_PATH: join(dir, "drafts.json"), BASTRA_PENDING_RELAY: "1", BASTRA_TELEMETRY: "off" };
  const previous = new Map(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  try { await work(env.BASTRA_PENDING_SUGGESTIONS_PATH, env.BASTRA_DRAFTS_PATH); }
  finally { for (const [k,v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await rm(dir, { recursive: true, force: true }); }
}

test("relay off aliases prevent recency/trend/provisional writes, reads, settlement and SessionStart delivery", () => fixture(async path => {
  const original = JSON.stringify([{ ts: Date.now(), blocks: "Invented retained observation", provisional: "pass" }]);
  await writeFile(path, original);
  const before = await stat(path);
  for (const off of ["0", "false", " OFF ", "No"]) {
    process.env.BASTRA_PENDING_RELAY = off; assert.equal(pendingRelayEnabled(), false);
    for (const opts of [{}, { lane: "trends" as const }, { provisional: "pass" }]) await writePendingSuggestion("Invented new observation", opts);
    assert.deepEqual(await takePendingRelay({ sessionId: "s", countable: true }), { recency: [], trends: [] });
    assert.deepEqual(await consumePendingSuggestions(), []);
    assert.equal((await settleProvisionalSuggestions("pass", new Set(["Invented retained observation"]))).size, 0);
    const output = await runSessionLane({ hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: "off-relay-test" }, "http://127.0.0.1:1");
    assert.ok(!output.includes("Invented retained observation"));
    assert.equal(await readFile(path, "utf8"), original); assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  }
  process.env.BASTRA_PENDING_RELAY = "1"; assert.equal(pendingRelayEnabled(), true);
  assert.equal((await takePendingRelay()).recency.length, 1);
}));

test("disabled relay does not create a missing store", () => fixture(async path => {
  process.env.BASTRA_PENDING_RELAY = "0";
  await writePendingSuggestion("Invented observation"); await takePendingRelay();
  await assert.rejects(stat(path), { code: "ENOENT" });
}));

test("purge clears drafts, sidecars and relay even when relay is disabled; relay remains private", () => fixture(async (path, drafts) => {
  await writeFile(path, JSON.stringify([{ ts: Date.now(), blocks: "Invented observation" }]));
  for (const p of [drafts, draftVectorsPath(), drafts + ".decisions.json"]) await writeFile(p, "[]");
  process.env.BASTRA_PENDING_RELAY = "0"; await purgeDrafts();
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  for (const p of [drafts, draftVectorsPath(), drafts + ".decisions.json"]) await assert.rejects(stat(p), { code: "ENOENT" });
}));

test("purge preserves invalid relay and draft bytes", () => fixture(async (path, drafts) => {
  for (const invalid of ["{broken", '{"future":"shape"}']) {
    await writeFile(path, invalid); await writeFile(drafts, "draft fixture");
    await assert.rejects(purgeDrafts(), /original preserved/);
    assert.equal(await readFile(path, "utf8"), invalid); assert.equal(await readFile(drafts, "utf8"), "draft fixture");
  }
}));

test("purge preserves an unreadable relay", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => fixture(async (path, drafts) => {
  const bytes = '[{"ts":1,"blocks":"Invented observation"}]';
  await writeFile(path, bytes); await writeFile(drafts, "draft fixture"); await chmod(path, 0o200);
  try { await assert.rejects(purgeDrafts(), /original preserved/); }
  finally { await chmod(path, 0o600); }
  assert.equal(await readFile(path, "utf8"), bytes); assert.equal(await readFile(drafts, "utf8"), "draft fixture");
}));
