import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTypedDrafts } from "../src/draft-capture.js";
import { listDrafts } from "../src/draft-store.js";

test("PSK is removed from persisted quote, question and situation before deriving literals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "psk-capture-"));
  const previous = process.env.BASTRA_DRAFTS_PATH;
  process.env.BASTRA_DRAFTS_PATH = join(dir, "drafts.json");
  const now = Date.now();
  const quote = "Our staging VPN requires PSK='fixture vpn' and a separate deployment configuration.";
  try {
    await captureTypedDrafts([
      { role: "assistant", content: "", commands: ["vpn PSK='fixture vpn' --host staging.example"], cwd: "/fixture/staging" },
      { role: "user", content: quote, cwd: "/fixture/staging", at: now },
      { role: "assistant", content: "", commands: ["$psk='fixture vpn'; vpn connect"] },
    ], { session_id: "psk-fixture" }, now, [{ kind: "answer", turn: 1, quote, context: "Is PSK='fixture vpn' the staging configuration?" }]);
    const rows = await listDrafts(now);
    assert.equal(rows.length, 1);
    assert.match(rows[0].quote, /\[REDACTED\]/);
    assert.match(rows[0].context!, /\[REDACTED\]/);
    assert.match(rows[0].situation.before[0], /\[REDACTED\]/);
    assert.match(rows[0].situation.after[0], /\[REDACTED\]/);
    assert.ok(!JSON.stringify(rows).includes("fixture vpn"));
    assert.ok(!(await readFile(process.env.BASTRA_DRAFTS_PATH, "utf8")).includes("fixture vpn"));
  } finally {
    if (previous === undefined) delete process.env.BASTRA_DRAFTS_PATH; else process.env.BASTRA_DRAFTS_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
