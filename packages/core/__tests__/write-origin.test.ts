/**
 * Tests für write_origin-Provenance (#158): Stempel am Save-Pfad —
 * Default agent-session, explizites user-directed, und Overwrite ohne
 * Angabe erhält die bestehende Provenance (kein stilles Degradieren).
 *
 * Runner: `tsx --test __tests__/write-origin.test.ts`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { saveMemory } from "../src/save.js";

const input = (over: Record<string, unknown> = {}) => ({
  title: "Provenance probe",
  type: "preference" as const,
  summary: "User prefers declarative provenance probes.",
  body: "Probe body. **Why:** test. **How to apply:** in tests.",
  topic_path: ["test", "provenance"],
  tags: ["provenance"],
  scope: "origin-test",
  recall_when: ["running the write-origin provenance test"],
  ...over,
});

async function fmOf(filePath: string): Promise<Record<string, unknown>> {
  return matter(await readFile(filePath, "utf8")).data as Record<string, unknown>;
}

test("write_origin: default agent-session, explicit user-directed, overwrite preserves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-write-origin-"));
  try {
    // default: autonomous saves are agent-session
    const auto = await saveMemory(dir, input({ id: "auto-probe" }));
    assert.equal((await fmOf(auto.file_path)).write_origin, "agent-session");

    // explicit: the human dictated it
    const dictated = await saveMemory(dir, input({ id: "dictated-probe", write_origin: "user-directed" }));
    assert.equal((await fmOf(dictated.file_path)).write_origin, "user-directed");

    // overwrite WITHOUT the field: existing provenance survives — a refresh
    // must not silently turn a user-directed memory into a curation candidate
    const refreshed = await saveMemory(
      dir,
      input({ id: "dictated-probe", summary: "User prefers refreshed probes.", overwrite: true })
    );
    assert.equal((await fmOf(refreshed.file_path)).write_origin, "user-directed");

    // overwrite WITH the field: explicit value wins
    const reclassified = await saveMemory(
      dir,
      input({ id: "auto-probe", write_origin: "user-directed", overwrite: true })
    );
    assert.equal((await fmOf(reclassified.file_path)).write_origin, "user-directed");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
