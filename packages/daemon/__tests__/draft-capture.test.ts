import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { noteSessionForHarvest, runSessionHarvest, harvestCandidates, formatHarvestBlock, type HarvestPassResult } from "../src/session-harvest.js";
import { listDrafts, expireDrafts, upsertDraft, captureDraft } from "../src/draft-store.js";
import { parseTranscriptFile } from "../src/stop-transcript.js";

const now = 1_800_000_000_000;
const day = 24 * 60 * 60 * 1000;
const task = "Please update the deployment script because staging uses its own isolated database.";
async function isolated(fn: (dir: string, harvest: (id: string, rows: object[]) => Promise<HarvestPassResult>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-capture-"));
  const env = { BASTRA_VAULT_PATH: join(dir, "vault"), BASTRA_DRAFTS_PATH: join(dir, "drafts.json"), BASTRA_HARVEST_QUEUE_PATH: join(dir, "queue.json"), BASTRA_PENDING_SUGGESTIONS_PATH: join(dir, "pending.json"), BASTRA_LOG_PATH: join(dir, "logs") };
  const prev = new Map(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  let clock = now;
  const harvest = async (id: string, rows: object[]) => {
    const booked = clock;
    clock += 2;
    const path = join(dir, `${id}.jsonl`);
    await writeFile(path, rows.map(r => JSON.stringify(r)).join("\n"));
    await noteSessionForHarvest({ session_id: id, transcript_path: path, ended: true, now: booked });
    return runSessionHarvest({ loadTurns: async p => parseTranscriptFile(await readFile(p, "utf8")), now: booked + 1 });
  };
  try { await fn(dir, harvest); } finally {
    for (const [k,v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(dir, { recursive: true, force: true });
  }
}
const u = (content: string, isMeta = false) => ({ type: "user", isMeta, message: { role: "user", content } });
const a = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{type: "text", text}] } });

test("B1 captures a typed task outside the shapes, replays once, and appends evidence across sessions", () => isolated(async (dir, harvest) => {
  await harvest("one", [u(task)]);
  let rows = await listDrafts(now + 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "typed");
  assert.equal(rows[0].quote, task);
  // Simulate lost queue progress: the same turn really reaches the store twice.
  const queuePath = join(dir, "queue.json");
  const queue = JSON.parse(await readFile(queuePath, "utf8"));
  queue[0].harvested_upto = 0;
  await writeFile(queuePath, JSON.stringify(queue));
  const replay = await harvest("one", [u(task)]);
  assert.equal(replay.harvested, 1, "the replay must actually process the session");
  assert.equal((await listDrafts(now + 3))[0].evidence.length, 1);
  await harvest("two", [u(task)]);
  rows = await listDrafts(now + 1);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].evidence.map(e => e.session_id), ["one", "two"]);
}));

test("B1 rejects short confirmations, pastes, interrupts, injected and isMeta turns", () => isolated(async (_, harvest) => {
  await harvest("noise", [u("yes please"), u("字".repeat(2000)), u("[Request interrupted by user for tool use]"), u(task, true), u(`<task-notification>${task}</task-notification>`), { type: "user", message: { role: "user", content: [{type: "tool_result", content: task}] } }]);
  assert.deepEqual(await listDrafts(now + 1), []);
}));

test("B1 deduplicates within a session by normalized fingerprint and bigram Dice", () => isolated(async (_, harvest) => {
  await harvest("repeat", [u(task), u(task.toUpperCase()), u("Please update the deployment script since staging uses its own isolated database.")]);
  const rows = await listDrafts(now + 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].evidence.length, 3);
}));

test("B1 expires single evidence at seven days even when merely displayed", () => isolated(async (dir, harvest) => {
  await harvest("early", [u(task)]);
  assert.equal((await listDrafts(now + 1 + 7 * day - 1)).length, 1);
  assert.equal(await expireDrafts({ now: now + 1 + 7 * day }), 1);
  assert.equal(JSON.parse(await readFile(join(dir, "drafts.json"), "utf8")).rows.length, 0);
  await harvest("repeat-a", [u(task)]);
  await harvest("repeat-b", [u(task)]);
  assert.equal(await expireDrafts({ now: now + 1 + 7 * day }), 0);
  const repeated = (await listDrafts(now + 1))[0];
  await upsertDraft({ ...repeated, evidence: repeated.evidence.slice(0, 1), surfaced: [{ session_id: "shown", ts: now + 1, novel: [] }] }, now + 1);
  assert.equal(await expireDrafts({ now: now + 1 + 7 * day }), 1);
}));

async function tree(dir: string): Promise<unknown> {
  const entries = await readdir(dir, { withFileTypes: true });
  return Promise.all(entries.sort((a,b) => a.name.localeCompare(b.name)).map(async e => [e.name, e.isDirectory() ? await tree(join(dir,e.name)) : (await readFile(join(dir,e.name))).toString("hex")]));
}
test("B1 leaves the vault byte-identical and the existing shape relay unchanged", () => isolated(async (dir, harvest) => {
  const vault = join(dir, "vault");
  await mkdir(join(vault, "memories"), { recursive: true });
  await writeFile(join(vault, "memories", "fixture.md"), "---\nid: fixture\n---\nSynthetic vault content\n");
  const before = await tree(vault);
  const rows = [a("Which database should staging use?"), u(task)];
  const turns = parseTranscriptFile(rows.map(r => JSON.stringify(r)).join("\n"));
  const expected = formatHarvestBlock({ session_id: "relay" }, harvestCandidates(turns));
  await harvest("relay", rows);
  assert.deepEqual(await tree(vault), before);
  assert.equal(JSON.parse(await readFile(join(dir, "pending.json"), "utf8"))[0].blocks, expected);
  assert.equal((await listDrafts(now + 1))[0].kind, "answer");
}));

test("B2 captures typed turns even after saves, while the vault matcher still excludes stored quotes", () => isolated(async (dir, harvest) => {
  await harvest("saved", [u(task), { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "mcp__bastra_recall__save_memory", input: {} }] } }]);
  assert.equal((await listDrafts(now + 1)).length, 1);
  const path = join(dir, "stored.jsonl");
  await writeFile(path, JSON.stringify(u(task)));
  await noteSessionForHarvest({ session_id: "stored", transcript_path: path, ended: true, now });
  await runSessionHarvest({ loadTurns: async p => parseTranscriptFile(await readFile(p,"utf8")), storedIn: () => () => "fixture", now: now + 1 });
  assert.equal((await listDrafts(now + 1)).length, 1);
}));

test("B1 has no ten-draft cap and keeps distinct texts in different sessions", () => isolated(async (_, harvest) => {
  // Distinct scripts keep structural Dice below the within-session threshold.
  const messages = Array.from({length: 12}, (_,i) => u(String.fromCodePoint(0x4e00 + i).repeat(22)));
  await harvest("many", messages);
  assert.equal((await listDrafts(now + 1)).length, 12);
  await harvest("other", [u("Please update the deployment script since staging uses its own isolated database.")]);
  await harvest("original", [u(task)]);
  assert.equal((await listDrafts(now + 1)).length, 14);
}));


test("B1 retains capture progress across a resumed session and compares with its earlier draft", () => isolated(async (dir, harvest) => {
  await harvest("resume", [u(task)]);
  const path = join(dir, "resume.jsonl");
  const later = "Please update the deployment script since staging uses its own isolated database.";
  await writeFile(path, [u(task), u(later)].map(r => JSON.stringify(r)).join("\n"));
  await noteSessionForHarvest({ session_id: "resume", transcript_path: path, ended: true, now: now + 2 });
  await runSessionHarvest({ loadTurns: async p => parseTranscriptFile(await readFile(p,"utf8")), now: now + 3 });
  const rows = await listDrafts(now + 3);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].evidence.map(e => e.turn), [0, 1]);
}));

test("B1 capture writes redacted bounded text and telemetry contains only counts and identifiers", () => isolated(async (dir, harvest) => {
  const quote = "Please inspect the endpoint https://fixture:password@example.invalid/health because staging uses its own database. ".repeat(6);
  await harvest("privacy", [u(quote)]);
  const rows = await listDrafts(now + 1);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].quote.length <= 600);
  assert.doesNotMatch(await readFile(join(dir,"drafts.json"), "utf8"), /fixture:password/);
  const files = await readdir(join(dir,"logs"));
  const logs = (await Promise.all(files.map(f => readFile(join(dir,"logs",f), "utf8")))).join("");
  assert.doesNotMatch(logs, /Please inspect|fixture:password|own database/);
  const event = logs.trim().split("\n").map(l => JSON.parse(l)).find(e => e.kind === "session_harvest");
  assert.equal(event.draft_count, 1);
  assert.equal(event.draft_evidence_count, 0);
  assert.equal(event.draft_ids_omitted, 0);
  assert.deepEqual(event.draft_ids, [rows[0].id]);
  assert.equal(event.draft_error, false);
  await harvest("privacy-repeat", [u(quote)]);
  const repeatedLog = (await Promise.all(files.map(f => readFile(join(dir, "logs", f), "utf8")))).join("");
  const repeated = repeatedLog.trim().split("\n").map(l => JSON.parse(l)).find(e => e.session_id === "privacy-repeat");
  assert.equal(repeated.draft_count, 0);
  assert.equal(repeated.draft_evidence_count, 1);
  assert.deepEqual(repeated.draft_ids, [rows[0].id]);
}));

test("B1 draft-store errors preserve the shape relay and record a text-free failure", () => isolated(async (dir, harvest) => {
  await writeFile(join(dir,"drafts.json"), "{malformed");
  await harvest("broken", [a("Which database should staging use?"), u(task)]);
  assert.match(JSON.parse(await readFile(join(dir,"pending.json"),"utf8"))[0].blocks, /staging uses/);
  assert.equal(await readFile(join(dir,"drafts.json"),"utf8"), "{malformed");
  const files = await readdir(join(dir,"logs"));
  const logs = (await Promise.all(files.map(f => readFile(join(dir,"logs",f),"utf8")))).join("");
  assert.equal(JSON.parse(logs.trim()).draft_error, true);
}));

test("B1 concurrent cross-session capture appends evidence atomically and does not reopen tombstones", () => isolated(async (_, harvest) => {
  await harvest("seed", [u(task)]);
  const seed = (await listDrafts(now + 1))[0];
  await Promise.all(Array.from({length: 20}, (_,i) => captureDraft({ ...seed, id: `d-${i.toString(16).padStart(12,"0")}`, evidence: [{session_id: `parallel-${i}`, turn: 0, ts: now + 1}] }, now + 1)));
  assert.equal((await listDrafts(now + 1)).length, 1);
  assert.equal((await listDrafts(now + 1))[0].evidence.length, 21);
  await upsertDraft({ ...seed, state: "rejected" }, now + 1);
  await harvest("tombstone", [u(task)]);
  assert.equal((await listDrafts(now + 1)).length, 1);
  assert.equal((await listDrafts(now + 1))[0].state, "rejected");
}));


test("B1 structural letter threshold is inclusive and the existing kill switch stops capture", () => isolated(async (dir, harvest) => {
  await harvest("threshold", [u("字".repeat(19)), u("字".repeat(20))]);
  assert.deepEqual((await listDrafts(now + 1))[0].evidence.map(e => e.turn), [1]);
  const path = join(dir,"off.jsonl");
  await writeFile(path, JSON.stringify(u(task)));
  await noteSessionForHarvest({ session_id: "off", transcript_path: path, ended: true, now });
  const previous = process.env.BASTRA_SESSION_HARVEST;
  process.env.BASTRA_SESSION_HARVEST = "0";
  try {
    const before = await readFile(join(dir,"drafts.json"),"utf8");
    await runSessionHarvest({ loadTurns: async p => parseTranscriptFile(await readFile(p,"utf8")), now: now + 1 });
    assert.equal(await readFile(join(dir,"drafts.json"),"utf8"), before);
  } finally {
    if (previous === undefined) delete process.env.BASTRA_SESSION_HARVEST;
    else process.env.BASTRA_SESSION_HARVEST = previous;
  }
}));
