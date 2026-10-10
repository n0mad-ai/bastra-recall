import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPendingRelay, PENDING_ENTRY_CHAR_CAP, settleProvisionalSuggestions, takePendingRelay, writePendingSuggestion } from "../src/pending-suggestions.js";
import { noteSessionForHarvest, runSessionHarvest } from "../src/session-harvest.js";

const secret = ["invented", "storybook"].join("");
const block = "<save-eval>Fixture station password=" + secret + "; keep calibration separate.</save-eval>";
async function fixture(work: (dir: string, path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pending-redaction-")), path = join(dir, "pending.json");
  const env = { BASTRA_PENDING_SUGGESTIONS_PATH: path, BASTRA_HARVEST_QUEUE_PATH: join(dir, "queue.json"),
    BASTRA_DRAFTS_PATH: join(dir, "drafts.json"), BASTRA_HOOK_STATE_DIR: join(dir, "state"), BASTRA_LOG_PATH: join(dir, "logs") };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  try { await work(dir, path); }
  finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
async function privateFile(path: string): Promise<void> {
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
}

test("an unreadable existing relay is preserved and warns without text or paths", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, t => fixture(async (_dir, path) => {
  await writeFile(path, "[]"); await takePendingRelay(); // Reset the diagnostic budget.
  const original = JSON.stringify([{ ts: Date.now(), blocks: "Invented old relay observation" }]);
  await writeFile(path, original); await chmod(path, 0o200);
  let warning = "";
  t.mock.method(process.stderr, "write", (chunk: unknown) => { warning += String(chunk); return true; });
  try { await writePendingSuggestion("Invented new relay observation"); }
  finally { await chmod(path, 0o600); }
  assert.equal(await readFile(path, "utf8"), original);
  assert.match(warning, /write skipped; original preserved/);
  assert.ok(!warning.includes(path)); assert.doesNotMatch(warning, /Invented/);
}));

test("invalid JSON or a non-array relay is preserved, while a missing file is created", t => fixture(async (_dir, path) => {
  await writeFile(path, "[]"); await takePendingRelay();
  let warning = "";
  t.mock.method(process.stderr, "write", (chunk: unknown) => { warning += String(chunk); return true; });
  for (const original of ['{"blocks":"Invented broken relay"', '{"blocks":"Invented wrong shape"}']) {
    await writeFile(path, original);
    await writePendingSuggestion("Invented new relay observation");
    assert.equal(await readFile(path, "utf8"), original);
  }
  assert.match(warning, /write skipped; original preserved/);
  assert.ok(!warning.includes(path)); assert.doesNotMatch(warning, /Invented/);
  await rm(path);
  await writePendingSuggestion("Invented fresh relay observation");
  const rows = JSON.parse(await readFile(path, "utf8"));
  assert.equal(rows.length, 1); assert.equal(rows[0].blocks, "Invented fresh relay observation");
  await privateFile(path);
}));

test("relay writes redact and deduplicate repeated input; references stay readable", () => fixture(async (_dir, path) => {
  await writePendingSuggestion(block); await writePendingSuggestion(block);
  const file = await readFile(path, "utf8"); assert.ok(!file.includes(secret)); assert.match(file, /\[REDACTED\]/);
  assert.equal(JSON.parse(file).length, 1); await privateFile(path);
  const reference = "<save-eval>Fixture station password=$WIFI_SECRET</save-eval>";
  await writePendingSuggestion(reference);
  const relay = await takePendingRelay(); assert.equal(relay.recency.length, 2);
  assert.equal(relay.recency[1].blocks, reference);
  assert.ok(!formatPendingRelay(relay).text.includes(secret));
}));

test("ordinary append scrubs all legacy rows and preserves their metadata", () => fixture(async (_dir, path) => {
  await writeFile(path, JSON.stringify([
    { ts: Date.now(), blocks: block, extra: "kept" },
    { ts: Date.now(), blocks: block, lane: "trends", key: "fixture-trend", sessions: 3, retired: true, clusters: { fixture: 4 } },
  ]), { mode: 0o644 });
  await writePendingSuggestion("ordinary fixture suggestion");
  const file = await readFile(path, "utf8"), rows = JSON.parse(file);
  assert.ok(!file.includes(secret)); assert.equal(rows[0].extra, "kept");
  assert.equal(rows[1].key, "fixture-trend"); assert.equal(rows[1].sessions, 3); assert.equal(rows[1].retired, true);
  assert.deepEqual(rows[1].clusters, { fixture: 4 }); await privateFile(path);
}));

test("legacy recency is safe on first delivery even when consumption removes the file", () => fixture(async (_dir, path) => {
  await writeFile(path, JSON.stringify([{ ts: Date.now(), blocks: block }]), { mode: 0o644 });
  const relay = await takePendingRelay(); assert.equal(relay.recency.length, 1);
  assert.ok(!formatPendingRelay(relay).text.includes(secret)); assert.match(relay.recency[0].blocks, /\[REDACTED\]/);
  await assert.rejects(readFile(path), { code: "ENOENT" });
}));

test("trend read-back scrubs legacy storage with private rights and keeps session progress", () => fixture(async (_dir, path) => {
  await writeFile(path, JSON.stringify([{ ts: Date.now(), blocks: block, lane: "trends", key: "fixture-trend", sessions: 0 }]), { mode: 0o644 });
  const relay = await takePendingRelay({ countable: true, sessionId: "invented-owner" });
  assert.equal(relay.trends[0].sessions, 1); assert.ok(!relay.trends[0].blocks.includes(secret));
  assert.ok(!(await readFile(path, "utf8")).includes(secret)); await privateFile(path);
  assert.equal((await takePendingRelay()).trends[0].sessions, 1);
}));

test("provisional settlement matches original quotes and returns original caller strings", () => fixture(async (_dir, path) => {
  await writePendingSuggestion(block, { provisional: "invented-pass" });
  const other = block.replace("Fixture station", "Other fixture station");
  await writePendingSuggestion(other, { provisional: "invented-pass" });
  const removed = await settleProvisionalSuggestions("invented-pass", new Set([block]));
  assert.deepEqual([...removed], [block]);
  const file = await readFile(path, "utf8"), rows = JSON.parse(file);
  assert.equal(rows.length, 1); assert.match(rows[0].blocks, /Other fixture/); assert.equal(rows[0].provisional, undefined);
  assert.ok(!file.includes(secret)); await privateFile(path);
}));

test("redaction expansion stays bounded and repeated writes keep complete placeholders", () => fixture(async (_dir, path) => {
  const expanding = "password=x ".repeat(Math.floor(PENDING_ENTRY_CHAR_CAP / 11));
  await writePendingSuggestion(expanding);
  const first = JSON.parse(await readFile(path, "utf8"))[0].blocks as string;
  assert.ok(first.length <= PENDING_ENTRY_CHAR_CAP); assert.ok(!first.includes("password=x"));
  assert.ok(first.endsWith("…")); assert.doesNotMatch(first, /\[REDACT[^\]]*…$/);
  await writePendingSuggestion(expanding);
  const rows = JSON.parse(await readFile(path, "utf8"));
  assert.equal(rows.length, 1); assert.equal(rows[0].blocks, first);
}));

test("harvest's already-stored check sees original quotes before relay redaction", () => fixture(async (dir, path) => {
  const transcript = join(dir, "fixture.jsonl"); await writeFile(transcript, "[]");
  const quote = "Fixture station password=" + secret + "; calibration always uses the isolated bench.";
  const fresh = quote.replace(secret, ["invented", "marigold"].join(""));
  const seen: string[] = [];
  const storedIn = () => (input: string) => { seen.push(input); return input === quote ? "fixture-note" : null; };
  const now = Date.now();
  await noteSessionForHarvest({ session_id: "fixture-stored", transcript_path: transcript, ended: true, now });
  const first = await runSessionHarvest({ now, vaultId: "fixture-vault", storedIn, loadTurns: async () => [
    { role: "assistant", content: "Which calibration rule applies?" }, { role: "user", content: quote },
  ] });
  assert.equal(first.stored, 1); assert.equal(first.candidates, 0);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await noteSessionForHarvest({ session_id: "fixture-fresh", transcript_path: transcript, ended: true, now: now + 1 });
  const next = await runSessionHarvest({ now: now + 1, vaultId: "fixture-vault", storedIn, loadTurns: async () => [
    { role: "assistant", content: "Which calibration rule applies?" }, { role: "user", content: fresh },
  ] });
  assert.equal(next.stored, 0); assert.equal(next.candidates, 1);
  assert.ok(seen.includes(quote)); assert.ok(seen.includes(fresh)); assert.ok(seen.every(input => !input.includes("[REDACTED]")));
  const file = await readFile(path, "utf8"); assert.ok(!file.includes(secret)); assert.ok(!file.includes("inventedmarigold"));
  assert.match(file, /calibration/); await privateFile(path);
}));
