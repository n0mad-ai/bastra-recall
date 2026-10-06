import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, stat, readdir, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  draftsPath, draftFingerprint, draftId, upsertDraft, listDrafts, expireDrafts, purgeDrafts,
  DRAFT_MAX_ROWS, DRAFT_MAX_BYTES, DRAFT_OPEN_AGE_MS, DRAFT_RETAIN_AGE_MS, type Draft,
} from "../src/draft-store.js";

const run = promisify(execFile);
const now = 1_800_000_000_000;
function draft(i = 0): Draft {
  const quote = `Use VPN to reach build-box.internal number ${i}`;
  const fp = draftFingerprint(quote);
  return {
    id: draftId(`session-${i}`, i, fp), fp, kind: "after-failure", quote,
    situation: { before: ["ssh build-box.internal"], after: [], reads: [], lits: ["ssh", "build-box.internal"] },
    evidence: [{ session_id: `session-${i}`, turn: i, ts: now }],
    created: now, last_touched: now, surfaced: [], state: "open",
  };
}
async function isolated(fn: (path: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-drafts-"));
  const previous = process.env.BASTRA_DRAFTS_PATH;
  const path = join(dir, "drafts.json");
  process.env.BASTRA_DRAFTS_PATH = path;
  try { await fn(path, dir); }
  finally {
    if (previous === undefined) delete process.env.BASTRA_DRAFTS_PATH;
    else process.env.BASTRA_DRAFTS_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("draft identity is deterministic and Unicode normalization is language independent", () => {
  assert.equal(draftFingerprint("CAFÉ—ключ 42!"), draftFingerprint("cafe\u0301 ключ 42"));
  assert.match(draftId("session", 2, draftFingerprint("hello")), /^d-[a-f0-9]{12}$/);
  assert.equal(draftId("session", 2, "fp"), draftId("session", 2, "fp"));
  const prev = process.env.BASTRA_DRAFTS_PATH;
  delete process.env.BASTRA_DRAFTS_PATH;
  assert.equal(draftsPath(), join(homedir(), ".bastra", "drafts.json"));
  if (prev !== undefined) process.env.BASTRA_DRAFTS_PATH = prev;
});

test("40 parallel upserts persist every row in an atomic 0600 JSON array", () => isolated(async (path, dir) => {
  assert.deepEqual(await listDrafts(now), []);
  await Promise.all(Array.from({ length: 40 }, (_, i) => upsertDraft(draft(i), now)));
  const stored = JSON.parse(await readFile(path, "utf8")) as Draft[];
  assert.equal(new Set(stored.map((d) => d.id)).size, 40);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ["drafts.json"]);
  const rows = await listDrafts(now);
  rows[0].quote = "changed caller copy";
  assert.notEqual((await listDrafts(now))[0].quote, rows[0].quote);
  await chmod(path, 0o644);
  await upsertDraft({ ...draft(0), context: "updated" }, now);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await listDrafts(now)).length, 40);
}));

test("30 day expiry uses newest evidence or display; list never refreshes access", () => isolated(async (path) => {
  const a = draft(1);
  a.evidence.push({ session_id: "later", turn: 2, ts: now + 10 });
  const b = draft(2);
  b.surfaced.push({ session_id: "display", ts: now + 20, novel: ["VPN"] });
  await upsertDraft(a, now);
  await upsertDraft(b, now);
  await upsertDraft(draft(3), now);
  const before = await readFile(path, "utf8");
  assert.equal((await listDrafts(now + DRAFT_OPEN_AGE_MS - 1)).length, 3);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(await expireDrafts({ now: now + DRAFT_OPEN_AGE_MS }), 1);
  assert.equal(await expireDrafts({ now: now + DRAFT_OPEN_AGE_MS + 10 }), 1);
  assert.equal(await expireDrafts({ now: now + DRAFT_OPEN_AGE_MS + 20 }), 1);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);
}));

test("promoted/rejected retention and missing-note tombstone", () => isolated(async () => {
  await upsertDraft({ ...draft(1), state: "promoted", memory_id: "real-note", announce: true }, now);
  await upsertDraft({ ...draft(2), state: "rejected" }, now);
  assert.equal((await listDrafts(now + DRAFT_OPEN_AGE_MS)).length, 2);
  await expireDrafts({ now: now + 100, memoryExists: async () => false });
  const tombstone = (await listDrafts(now + 100)).find((d) => d.id === draft(1).id)!;
  assert.equal(tombstone.state, "rejected");
  assert.equal(tombstone.fp, draft(1).fp);
  assert.equal(tombstone.announce, false);
  assert.equal(tombstone.last_touched, now + 100);
  assert.equal(await expireDrafts({ now: now + DRAFT_RETAIN_AGE_MS }), 1);
  assert.equal(await expireDrafts({ now: now + DRAFT_RETAIN_AGE_MS + 100 }), 1);
}));

test("bounds every text field, commands, reads and surfaced history", () => isolated(async (path) => {
  const d = draft();
  d.quote = "ü".repeat(900);
  d.context = "x".repeat(300);
  d.situation.before = Array(6).fill("x".repeat(400));
  d.situation.after = Array(6).fill("x".repeat(400));
  d.situation.reads = Array(6).fill("x".repeat(400));
  d.situation.lits = Array(80).fill("x".repeat(400));
  d.surfaced = Array.from({ length: 10 }, (_, i) => ({ session_id: "s", ts: now + i, novel: Array(80).fill("x".repeat(400)) }));
  const saved = (await upsertDraft(d, now))!;
  assert.equal(saved.quote.length, 600);
  assert.equal(saved.context!.length, 160);
  for (const key of ["before", "after", "reads"] as const) {
    assert.equal(saved.situation[key].length, 3);
    assert.equal(saved.situation[key][0].length, 200);
  }
  assert.equal(saved.surfaced.length, 5);
  assert.equal(saved.situation.lits.length, 32);
  assert.ok((await stat(path)).size <= DRAFT_MAX_BYTES);
}));

test("cap evicts oldest last_touched rather than insertion order", () => isolated(async (path) => {
  const rows = Array.from({ length: DRAFT_MAX_ROWS }, (_, i) => ({ ...draft(i), last_touched: now + i }));
  await writeFile(path, JSON.stringify(rows));
  await upsertDraft({ ...draft(600), last_touched: now + 600 }, now);
  const kept = await listDrafts(now);
  assert.equal(kept.length, 500);
  assert.ok(!kept.some((d) => d.id === draft(0).id));
  assert.ok(kept.some((d) => d.id === draft(600).id));
}));

test("byte cap includes Unicode and evidence and evicts older rows", () => isolated(async (path) => {
  const big = draft(1);
  big.evidence = Array.from({ length: 9000 }, (_, i) => ({ session_id: "会話".repeat(20), turn: i, ts: now }));
  await assert.rejects(upsertDraft(big, now), /byte limit/);
  const row = draft(2);
  row.evidence = Array.from({ length: 1600 }, (_, i) => ({ session_id: "会話".repeat(20), turn: i, ts: now }));
  for (let i = 0; i < 4; i++) await upsertDraft({ ...row, id: draft(i).id, last_touched: now + i }, now);
  assert.ok((await stat(path)).size <= DRAFT_MAX_BYTES);
  assert.ok((await listDrafts(now)).length < 4);
}));

test("secrets are scrubbed before clipping in all fields; >30% quote is dropped", () => isolated(async (path) => {
  const secret = "ghp_abcdefghijklmno1234567890";
  const d = draft();
  d.quote = "The VPN address is documented here; use the credential only locally on this device and do not share it: " + secret;
  d.context = secret;
  d.situation.before = ["ssh://user:pass@box.internal"];
  d.situation.after = ["KEY=" + secret];
  d.situation.reads = [join(homedir(), "file")];
  d.situation.lits = [secret];
  d.surfaced = [{ session_id: "other", ts: now, novel: [secret] }];
  assert.ok(await upsertDraft(d, now));
  const raw = await readFile(path, "utf8");
  assert.ok(!raw.includes(secret));
  assert.ok(!raw.includes("user:pass"));
  assert.ok(!raw.includes(homedir()));
  assert.equal(await upsertDraft({ ...draft(2), quote: secret }, now), null);
  assert.equal((await listDrafts(now)).length, 1);
}));

test("cache notices another process writing or purging, and concurrent processes lose no upserts", () => isolated(async (path) => {
  await upsertDraft(draft(0), now);
  await listDrafts(now);
  const module = new URL("../src/draft-store.ts", import.meta.url).href;
  const child = (body: string) => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import {upsertDraft,purgeDrafts} from ${JSON.stringify(module)}; ${body}`], { env: { ...process.env, BASTRA_DRAFTS_PATH: path } });
  await Promise.all(Array.from({ length: 5 }, (_, i) => child(`await upsertDraft(${JSON.stringify(draft(i + 1))}, ${now});`)));
  assert.equal((await listDrafts(now)).length, 6);
  await child("await purgeDrafts();");
  assert.deepEqual(await listDrafts(now), []);
}));

test("corrupt and oversized stores surface an error without overwriting the file", () => isolated(async (path) => {
  for (const text of ["not json", "{}", "[{}]", " ".repeat(DRAFT_MAX_BYTES + 1)]) {
    await writeFile(path, text);
    await assert.rejects(upsertDraft(draft(), now));
    assert.equal(await readFile(path, "utf8"), text);
  }
  await purgeDrafts();
  await purgeDrafts();
  assert.deepEqual(await listDrafts(now), []);
}));

test("compiled CLI lists JSON, honors help and purges; invalid subcommand fails", () => isolated(async (path) => {
  const fresh = Date.now();
  await upsertDraft({ ...draft(), created: fresh, last_touched: fresh, evidence: [{ session_id: "s", turn: 1, ts: fresh }] });
  const cli = resolve("packages/daemon/dist/cli.js");
  const invoke = (...args: string[]) => run(process.execPath, [cli, "drafts", ...args], { env: { ...process.env, BASTRA_DRAFTS_PATH: path, BASTRA_UPDATE_CHECK: "0" } });
  assert.equal(JSON.parse((await invoke("list", "--json")).stdout).length, 1);
  assert.match((await invoke("purge", "--help")).stdout, /local session drafts/);
  assert.equal((await listDrafts()).length, 1);
  await assert.rejects(invoke("other"), (err: unknown) => (err as { code: number }).code === 2);
  assert.deepEqual(JSON.parse((await invoke("purge", "--json")).stdout), { purged: true });
  assert.deepEqual(await listDrafts(), []);
}));


test("redaction occurs before quote and command limits, and exactly 30% is accepted", () => isolated(async (path) => {
  const token = "ghp_abcdefghijklmno1234567890";
  const d = draft();
  d.quote = "x".repeat(589) + " " + token;
  d.situation.before = ["x".repeat(189) + " " + token];
  const saved = (await upsertDraft(d, now))!;
  assert.equal(saved.quote.length, 600);
  assert.ok(saved.quote.endsWith("[REDACTED]"));
  assert.equal(saved.situation.before[0].length, 200);
  assert.ok(saved.situation.before[0].endsWith("[REDACTED]"));
  assert.ok(!(await readFile(path, "utf8")).includes(token));
  const secret = "0123456789abcdef".repeat(2) + "abcd";
  const quote = "x ".repeat(42) + secret;
  assert.equal(secret.length / quote.length, 0.3);
  assert.ok(await upsertDraft({ ...draft(2), quote }, now));
  assert.equal(await upsertDraft({ ...draft(3), quote: quote.slice(2) }, now), null);
}));


test("opaque session and memory identifiers survive token-shaped UUIDs", () => isolated(async () => {
  const session = "12345678-abcd-1234-abcd-123456789abc";
  const memory = "note-12345678-abcd-1234-abcd-123456789abc";
  const d = draft();
  d.evidence[0].session_id = session;
  d.surfaced = [{ session_id: session, ts: now, novel: [] }];
  d.memory_id = memory;
  const saved = (await upsertDraft(d, now))!;
  assert.equal(saved.evidence[0].session_id, session);
  assert.equal(saved.surfaced[0].session_id, session);
  assert.equal(saved.memory_id, memory);
}));
