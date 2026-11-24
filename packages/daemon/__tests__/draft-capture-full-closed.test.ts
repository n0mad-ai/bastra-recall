import { readAppRecord } from "../src/app-record-store.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { draftFingerprint, draftId, listDrafts, type Draft } from "../src/draft-store.js";
import { noteSessionForHarvest, runSessionHarvest } from "../src/session-harvest.js";
import { parseTranscriptFile } from "../src/stop-transcript.js";

async function harvestBurst(retained: number, incoming: number, compacting = false): Promise<void> {
  const firstPass = Math.min(incoming, 100);
  const dir = await mkdtemp(join(tmpdir(), "bastra-b2-closed-"));
  const paths = {
    BASTRA_DRAFTS_PATH: join(dir, "drafts.json"),
    BASTRA_HARVEST_QUEUE_PATH: join(dir, "queue.json"),
    BASTRA_LOG_PATH: join(dir, "logs"),
    BASTRA_TELEMETRY: "1",
  };
  const previous = new Map(Object.keys(paths).map((key) => [key, process.env[key]]));
  Object.assign(process.env, paths);
  const now = 1_800_000_000_000;
  try {
    const rows: Draft[] = Array.from({ length: retained }, (_, i) => {
      const quote = String.fromCodePoint(0x4e00 + i).repeat(30);
      const fp = draftFingerprint(quote);
      return {
        id: draftId("closed", i, fp),
        fp,
        quote,
        kind: "typed",
        state: i % 2 ? "rejected" : "promoted",
        created: now,
        last_touched: now,
        evidence: [{ session_id: "closed", turn: i, ts: now }],
        surfaced: [],
        situation: { before: [], after: [], reads: [], lits: [] },
      };
    });
    await writeFile(paths.BASTRA_DRAFTS_PATH, JSON.stringify({ version: 1, rows }));
    const before = await readAppRecord("drafts", paths.BASTRA_DRAFTS_PATH);
    const transcript = join(dir, "new.jsonl");
    await writeFile(
      transcript,
      Array.from({ length: incoming }, (_, i) =>
        JSON.stringify({
          type: "user",
          message: { role: "user", content: String.fromCodePoint(0x6000 + i).repeat(30) },
        })
      ).join("\n")
    );
    await noteSessionForHarvest({
      session_id: "new",
      transcript_path: transcript,
      ended: !compacting,
      compacting,
      now,
    });
    const loadTurns = async (path: string) => parseTranscriptFile(await readFile(path, "utf8"));
    await runSessionHarvest({ loadTurns, now: now + 1 });
    const events = (
      await Promise.all(
        (await readdir(paths.BASTRA_LOG_PATH)).map((name) => readFile(join(paths.BASTRA_LOG_PATH, name), "utf8"))
      )
    ).join("");
    const event = events
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((row) => row.kind === "session_harvest");
    assert.equal(event.draft_count, firstPass);
    assert.equal(event.draft_evicted_count, incoming - firstPass);
    assert.equal(event.draft_evicted_existing_count, retained - (500 - firstPass));
    assert.equal(event.draft_retry_turn, incoming > firstPass ? firstPass : undefined);
    assert.equal(event.draft_error, false);
    const kept = await listDrafts(now + 1);
    assert.equal(kept.length, 500);
    assert.equal(kept.filter((row) => row.state === "open").length, firstPass);
    assert.equal(kept.filter((row) => row.state !== "open").length, 500 - firstPass);
    assert.notEqual(await readAppRecord("drafts", paths.BASTRA_DRAFTS_PATH), before);
    const [booking] = JSON.parse(await readFile(paths.BASTRA_HARVEST_QUEUE_PATH, "utf8"));
    assert.equal(booking.harvested_upto, firstPass);
    const seen = new Set(kept.filter((row) => row.state === "open").map((row) => row.evidence[0].turn));
    const passes = Math.ceil(incoming / firstPass);
    for (let pass = 2; pass <= passes; pass++) {
      assert.equal((await runSessionHarvest({ loadTurns, now: now + pass })).harvested, 1);
      const next = await listDrafts(now + pass);
      for (const row of next) if (row.state === "open") seen.add(row.evidence[0].turn);
      assert.equal(next.filter((row) => row.state !== "open").length, retained);
    }
    assert.equal(seen.size, incoming);
    assert.equal((await runSessionHarvest({ loadTurns, now: now + passes + 1 })).harvested, 0);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("#1592: a closed-only full store takes five new rows into the reserved places", () => harvestBurst(500, 5));
test("#1693: 101 captures with 400 closed rows resume from the first deferred turn", () => harvestBurst(400, 101));
test("#1693: a compacting transcript of 251 captures finishes in three passes", () => harvestBurst(400, 251, true));
