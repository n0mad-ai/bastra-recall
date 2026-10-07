import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { draftFingerprint, draftId, listDrafts, type Draft } from "../src/draft-store.js";
import { noteSessionForHarvest, runSessionHarvest } from "../src/session-harvest.js";
import { parseTranscriptFile } from "../src/stop-transcript.js";

test("B2: a closed-only full store keeps tombstones and reports five evicted new rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-b2-closed-"));
  const paths = { BASTRA_DRAFTS_PATH: join(dir, "drafts.json"), BASTRA_HARVEST_QUEUE_PATH: join(dir, "queue.json"), BASTRA_LOG_PATH: join(dir, "logs"), BASTRA_TELEMETRY: "1" };
  const previous = new Map(Object.keys(paths).map(key => [key, process.env[key]]));
  Object.assign(process.env, paths);
  const now = 1_800_000_000_000;
  try {
    const rows: Draft[] = Array.from({ length: 500 }, (_, i) => {
      const quote = String.fromCodePoint(0x4e00 + i).repeat(30);
      const fp = draftFingerprint(quote);
      return { id: draftId("closed", i, fp), fp, quote, kind: "typed", state: i % 2 ? "rejected" : "promoted", created: now, last_touched: now, evidence: [{ session_id: "closed", turn: i, ts: now }], surfaced: [], situation: { before: [], after: [], reads: [], lits: [] } };
    });
    await writeFile(paths.BASTRA_DRAFTS_PATH, JSON.stringify({ version: 1, rows }));
    const before = await readFile(paths.BASTRA_DRAFTS_PATH, "utf8");
    const transcript = join(dir, "new.jsonl");
    await writeFile(transcript, Array.from({ length: 5 }, (_, i) => JSON.stringify({ type: "user", message: { role: "user", content: String.fromCodePoint(0x6000 + i).repeat(30) } })).join("\n"));
    await noteSessionForHarvest({ session_id: "new", transcript_path: transcript, ended: true, now });
    await runSessionHarvest({ loadTurns: async path => parseTranscriptFile(await readFile(path, "utf8")), now: now + 1 });
    const events = (await Promise.all((await readdir(paths.BASTRA_LOG_PATH)).map(name => readFile(join(paths.BASTRA_LOG_PATH, name), "utf8")))).join("");
    const event = events.trim().split("\n").map(line => JSON.parse(line)).find(row => row.kind === "session_harvest");
    assert.equal(event.draft_count, 0);
    assert.equal(event.draft_evicted_count, 5);
    assert.equal(event.draft_error, false);
    assert.equal((await listDrafts(now + 1)).length, 500);
    assert.equal(await readFile(paths.BASTRA_DRAFTS_PATH, "utf8"), before);
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
});
