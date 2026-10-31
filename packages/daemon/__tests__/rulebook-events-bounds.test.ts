import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RulebookCheckArgs } from "../src/rulebook-check.js";
import { recordRulebookEvent } from "../src/rulebook-events.js";

test("a dismissal ID is bounded like the other caller-supplied identifiers", () => {
  const entry = (id: string) => ({ applicable: [], not_applicable: [{ id, reason: "does not apply to this round" }] });
  assert.equal(RulebookCheckArgs.safeParse(entry("x".repeat(200))).success, true);
  assert.equal(RulebookCheckArgs.safeParse(entry("x".repeat(201))).success, false);
});

test("an audit row stays one line and bounds a session ID from a request header", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rulebook-events-"));
  const saved = { log: process.env.BASTRA_LOG_PATH, telemetry: process.env.BASTRA_TELEMETRY };
  process.env.BASTRA_LOG_PATH = dir; delete process.env.BASTRA_TELEMETRY;
  try {
    await recordRulebookEvent(`a\nforged\n${"s".repeat(16000)}`, { outcome: "checked" });
    const [file] = await readdir(dir);
    assert.match(file, /^events-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const lines = (await readFile(join(dir, file), "utf8")).trimEnd().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.session_known, true);
    assert.equal(row.session_id.length, 200);
  } finally {
    if (saved.log === undefined) delete process.env.BASTRA_LOG_PATH; else process.env.BASTRA_LOG_PATH = saved.log;
    if (saved.telemetry === undefined) delete process.env.BASTRA_TELEMETRY; else process.env.BASTRA_TELEMETRY = saved.telemetry;
    await rm(dir, { recursive: true, force: true });
  }
});
