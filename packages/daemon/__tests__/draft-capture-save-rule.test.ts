import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureTypedDrafts } from "../src/draft-capture.js";
import { listDrafts } from "../src/draft-store.js";
import { harvestCandidates, type HarvestTurn } from "../src/session-harvest.js";

test("B2: a later save does not suppress typed capture; relay and vault matching keep their rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-b2-saved-"));
  const previous = process.env.BASTRA_DRAFTS_PATH;
  process.env.BASTRA_DRAFTS_PATH = join(dir, "drafts.json");
  const now = 1_800_000_000_000;
  const turns: HarvestTurn[] = Array.from({ length: 4 }, (_, i) => ({ role: "user", content: String.fromCodePoint(0x4e00 + i).repeat(30) }));
  turns.push({ role: "assistant", content: "", tools: ["mcp__bastra_recall__save_memory"] });
  turns.push({ role: "user", content: String.fromCodePoint(0x4e10).repeat(30) });
  try {
    const result = await captureTypedDrafts(turns, { session_id: "later-save" }, now, []);
    assert.equal(result.count, 5);
    assert.equal((await listDrafts(now)).length, 5);
    const relayTurns = [
      { role: "assistant", content: "Which database should staging use?" },
      { role: "user", content: "Staging uses its own isolated database for every deployment." },
      { role: "assistant", content: "", tools: ["mcp__bastra_recall__save_memory"] },
    ];
    assert.deepEqual(harvestCandidates(relayTurns), []);
    const stored = await captureTypedDrafts([relayTurns[1]], { session_id: "already-in-vault" }, now, [], () => "fixture");
    assert.equal(stored.count, 0);
    assert.equal(stored.stored, 1);
  } finally {
    if (previous === undefined) delete process.env.BASTRA_DRAFTS_PATH;
    else process.env.BASTRA_DRAFTS_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
