import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listFloors, addFloor } from "../src/floors.js";
import { listSkills, addSkill } from "../src/skills-registry.js";
import { listClients, verifyAccessToken, hashToken } from "../src/oauth-store.js";
import { queueStatus, readNextChunk, QUEUE_FILE, CURSOR_FILE } from "../src/import-mining.js";
import { consumePendingSuggestions } from "../src/pending-suggestions.js";
import { readAppRecord } from "../src/app-record-store.js";

test("current JSON/JSONL state fixtures migrate without changing floors, skills, grants, pending rows or queue position", async t => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-stage1-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.now(), timestamp = new Date(now).toISOString();
  const floor = { memory_id: "kept-floor", condition: "owner-decision", reason: "keep", floored_at: timestamp, last_affirmed: timestamp };
  const skill = { id: "existing-skill", label: "Existing skill", added_at: timestamp };
  const client = { client_id: "fixture-client", client_name: "Fixture", redirect_uris: ["http://127.0.0.1/callback"], created_at: timestamp };
  const grant = { id: "fixture-grant", client_id: client.client_id, resource: "http://localhost/mcp", scope: "mcp", created_at: timestamp, last_used_at: timestamp, access_hash: hashToken("fixture-access"), access_expires_at: now + 60_000, refresh_hash: hashToken("fixture-refresh"), refresh_expires_at: now + 120_000, prev_refresh_hash: null };
  const sources: Record<string, string> = {
    "floors.json": JSON.stringify([floor]), "skills.json": JSON.stringify([skill]),
    "oauth.json": JSON.stringify({ clients: [client], grants: [grant] }),
    "pending.json": JSON.stringify([{ ts: now, blocks: "A fixture pending suggestion" }]),
    [QUEUE_FILE]: [{ source: "chatgpt", title: "Already mined", date: "2026-11-08", messages: ["Old"] }, { source: "claude", title: "Remaining", date: "2026-11-09", messages: ["Still mine me"] }].map(row => JSON.stringify(row)).join("\n") + "\n",
    [CURSOR_FILE]: "1",
  };
  for (const [name, raw] of Object.entries(sources)) await writeFile(join(dir, name), raw);
  const pendingBefore = process.env.BASTRA_PENDING_SUGGESTIONS_PATH;
  process.env.BASTRA_PENDING_SUGGESTIONS_PATH = join(dir, "pending.json");
  t.after(() => { if (pendingBefore === undefined) delete process.env.BASTRA_PENDING_SUGGESTIONS_PATH; else process.env.BASTRA_PENDING_SUGGESTIONS_PATH = pendingBefore; });
  assert.deepEqual(await listFloors(undefined, join(dir, "floors.json")), [floor]);
  assert.deepEqual(await listSkills(join(dir, "skills.json")), [skill]);
  assert.equal((await listClients(join(dir, "oauth.json")))[0].grants, 1);
  assert.equal(await verifyAccessToken("fixture-access", grant.resource, join(dir, "oauth.json")), true);
  assert.deepEqual(await queueStatus(dir), { total: 2, remaining: 1 });
  assert.equal((await consumePendingSuggestions(now))[0].blocks, "A fixture pending suggestion");
  const chunk = await readNextChunk(dir);
  assert.equal(chunk?.conversations, 1); assert.match(chunk!.body, /Still mine me/); assert.doesNotMatch(chunk!.body, /Already mined/);
  await addFloor({ memory_id: "next-floor", condition: "next", reason: "new" }, join(dir, "floors.json"));
  await addSkill({ id: "next-skill" }, join(dir, "skills.json"));
  assert.equal((await listFloors(undefined, join(dir, "floors.json"))).length, 2);
  assert.equal((await listSkills(join(dir, "skills.json"))).length, 2);
  assert.equal(JSON.parse(readAppRecord("floors", join(dir, "floors.json"))).length, 2);
  for (const [name, raw] of Object.entries(sources)) assert.equal(await readFile(join(dir, `${name}.pre-db`), "utf8"), raw);
});

test("corrupt legacy state stays at its original path and is not accepted as an empty migration", async t => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-stage1-corrupt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "oauth.json");
  await writeFile(path, "{broken");
  await assert.rejects(listClients(path));
  assert.equal(await readFile(path, "utf8"), "{broken");
  await assert.rejects(readFile(`${path}.pre-db`, "utf8"), { code: "ENOENT" });
});
