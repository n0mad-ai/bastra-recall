import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, stat, readdir, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DRAFT_STORE_VERSION, draftStoreDiagnostics, draftsPath, draftFingerprint, draftId, upsertDraft, listDrafts, expireDrafts, purgeDrafts,
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
  const fp = draftFingerprint("Hello!");
  assert.equal(fp, createHash("sha256").update("hello").digest("hex").slice(0, 40));
  assert.match(fp, /^[a-f0-9]{40}$/);
  assert.equal(draftId("session", 2, fp), "d-" + createHash("sha256").update(`session:2:${fp}`).digest("hex").slice(0, 12));
  assert.match(draftId("session", 2, fp), /^d-[a-f0-9]{12}$/);
  assert.equal(draftId("session", 2, "fp"), draftId("session", 2, "fp"));
  const prev = process.env.BASTRA_DRAFTS_PATH;
  delete process.env.BASTRA_DRAFTS_PATH;
  assert.equal(draftsPath(), join(homedir(), ".bastra", "drafts.json"));
  if (prev !== undefined) process.env.BASTRA_DRAFTS_PATH = prev;
});

test("40 parallel upserts persist every row in an atomic 0600 JSON array", () => isolated(async (path, dir) => {
  assert.deepEqual(await listDrafts(now), []);
  await Promise.all(Array.from({ length: 40 }, (_, i) => upsertDraft(draft(i), now)));
  const file = JSON.parse(await readFile(path, "utf8")) as { version: number; rows: Draft[] };
  assert.equal(file.version, DRAFT_STORE_VERSION);
  const stored = file.rows;
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
  await upsertDraft(a, now + 20);
  await upsertDraft(b, now + 20);
  await upsertDraft(draft(3), now + 20);
  const before = await readFile(path, "utf8");
  assert.equal((await listDrafts(now + DRAFT_OPEN_AGE_MS - 1)).length, 3);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(await expireDrafts({ now: now + DRAFT_OPEN_AGE_MS }), 1);
  assert.equal(await expireDrafts({ now: now + DRAFT_OPEN_AGE_MS + 10 }), 1);
  assert.equal(await expireDrafts({ now: now + DRAFT_OPEN_AGE_MS + 20 }), 1);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).rows, []);
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
  d.context = "x ".repeat(150);
  d.situation.before = Array(6).fill("x ".repeat(200));
  d.situation.after = Array(6).fill("x ".repeat(200));
  d.situation.reads = Array(6).fill("x ".repeat(200));
  d.situation.lits = Array(80).fill("x ".repeat(200));
  d.surfaced = Array.from({ length: 10 }, (_, i) => ({ session_id: "s", ts: now + i, novel: Array(80).fill("x ".repeat(200)) }));
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

test("retained fields are scrubbed; >30% of the retained quote is dropped", () => isolated(async (path) => {
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
  for (const text of ["not json", "{}", " ".repeat(DRAFT_MAX_BYTES + 1)]) {
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


test("bounds precede redaction, incomplete tokens are omitted, and exactly 30% is accepted", () => isolated(async (path) => {
  const token = "ghp_abcdefghijklmno1234567890";
  const d = draft();
  d.quote = "x".repeat(589) + " " + token;
  d.situation.before = ["x".repeat(189) + " " + token];
  const saved = (await upsertDraft(d, now))!;
  assert.equal(saved.quote, "x".repeat(589));
  assert.equal(saved.situation.before[0], "x".repeat(189));
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


test("path explanations and situation survive storage", () => isolated(async () => {
  const d = draft();
  d.quote = "Der Key liegt unter /etc/bastra/keys/deploy_ed25519 auf dem Buildserver.";
  d.situation.cwd = join(homedir(), "Projekte/bastra-recall/packages/daemon");
  d.situation.before = ["ssh deploy@build-box-03.eu-central-1.internal.example.com"];
  d.situation.after = ["mysql --password=hunter2 -h db.internal"];
  d.situation.reads = ["/etc/bastra/keys/deploy_ed25519"];
  d.situation.lits = ["db-primary-01.prod.eu-central-1.rds.amazonaws.com"];
  const saved = await upsertDraft(d, now);
  assert.ok(saved);
  assert.equal(saved.quote, d.quote);
  assert.equal(saved.situation.cwd, join("~", "Projekte/bastra-recall/packages/daemon"));
  assert.deepEqual(saved.situation.before, d.situation.before);
  assert.deepEqual(saved.situation.reads, d.situation.reads);
  assert.deepEqual(saved.situation.lits, d.situation.lits);
  assert.ok(!saved.situation.after[0].includes("hunter2"));
}));

test("malformed neighbours do not disable valid drafts", () => isolated(async (path) => {
  await writeFile(path, JSON.stringify([draft(1), { broken: true }, draft(2)]));
  assert.equal((await listDrafts(now)).length, 2);
  assert.equal(draftStoreDiagnostics().skippedRows, 1);
  await upsertDraft(draft(3), now);
  assert.equal((await listDrafts(now)).length, 3);
}));

test("listing never waits for a foreign writer lock", () => isolated(async (path) => {
  await upsertDraft(draft(), now);
  await writeFile(path + ".lock", JSON.stringify({ pid: 1, host: "foreign", ts: Date.now(), token: "foreign" }));
  const started = performance.now();
  assert.equal((await listDrafts(now)).length, 1);
  assert.ok(performance.now() - started < 500, "a draft read cannot spend five seconds in the writer lock");
}));

test("future timestamps cannot extend retention indefinitely", () => isolated(async () => {
  const d = draft();
  d.last_touched = now + 400 * 86400000;
  d.evidence[0].ts = now + 400 * 86400000;
  d.surfaced = [{ session_id: "future", ts: now + 400 * 86400000, novel: [] }];
  const saved = (await upsertDraft(d, now))!;
  assert.ok(saved.last_touched <= now);
  assert.ok(saved.evidence[0].ts <= now);
  assert.ok(saved.surfaced[0].ts <= now);
  assert.equal((await listDrafts(now + DRAFT_OPEN_AGE_MS)).length, 0);
}));


test("legacy arrays migrate and unknown fields survive a rewrite", () => isolated(async (path) => {
  const row = { ...draft(), extension: { keep: true }, situation: { ...draft().situation, host: "host.internal" } };
  const { surfaced: _surface, ...older } = row;
  await writeFile(path, JSON.stringify([older]));
  assert.equal((await listDrafts(now))[0].surfaced.length, 0);
  assert.equal(draftStoreDiagnostics().version, 0);
  await upsertDraft(draft(2), now);
  const migrated = JSON.parse(await readFile(path, "utf8"));
  assert.equal(migrated.version, DRAFT_STORE_VERSION);
  assert.deepEqual(migrated.rows[0].extension, { keep: true });
  assert.equal(migrated.rows[0].situation.host, "host.internal");
  migrated.extension = { root: true };
  await writeFile(path, JSON.stringify(migrated));
  await upsertDraft(draft(3), now);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).extension, { root: true });
}));

test("future versions and truncated files are never overwritten", () => isolated(async (path) => {
  for (const text of [JSON.stringify({ version: DRAFT_STORE_VERSION + 1, rows: [{ ...draft(), next: true }], extension: true }), JSON.stringify({ version: DRAFT_STORE_VERSION + 2, items: ["future layout"] }), '[{"id":"truncated']) {
    await writeFile(path, text);
    assert.deepEqual(await listDrafts(now), []);
    assert.ok(draftStoreDiagnostics().corrupt || draftStoreDiagnostics().unsupportedVersion);
    await assert.rejects(upsertDraft(draft(2), now), /original file preserved/);
    await assert.rejects(expireDrafts({ now }), /original file preserved/);
    assert.equal(await readFile(path, "utf8"), text);
  }
}));

test("imported future clocks use a stable file timestamp, not each read time", () => isolated(async (path) => {
  const current = Date.now();
  const future = current + 400 * 86400000;
  await writeFile(path, JSON.stringify([{ ...draft(), created: future, last_touched: future, evidence: [{ session_id: "future", turn: 1, ts: future }] }]));
  const touched = (await listDrafts(current))[0].last_touched;
  assert.ok(touched <= current);
  assert.equal((await listDrafts(current))[0].last_touched, touched);
  assert.deepEqual(await listDrafts(touched + DRAFT_OPEN_AGE_MS), []);
}));


test("an empty file initializes like a legacy empty array", () => isolated(async (path) => {
  await writeFile(path, "");
  assert.deepEqual(await listDrafts(now), []);
  assert.equal(draftStoreDiagnostics().corrupt, false);
  await upsertDraft(draft(), now);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, DRAFT_STORE_VERSION);
}));

test("the suite supplies an isolated drafts path without overriding a deliberate one", () => isolated(async (path) => {
  const env = { ...process.env };
  delete env.BASTRA_TEST_RUN_ROOT;
  delete env.BASTRA_DRAFTS_PATH;
  const setup = new URL("../../../scripts/test-env.mjs", import.meta.url).pathname;
  const code = 'import {relative,isAbsolute} from "node:path"; const p=process.env.BASTRA_DRAFTS_PATH; const r=relative(process.env.BASTRA_TEST_RUN_ROOT,p); console.error(JSON.stringify({p,isolated:!r.startsWith("..")&&!isAbsolute(r)}));';
  const first = JSON.parse((await run(process.execPath, ["--import", setup, "--input-type=module", "-e", code], { env })).stderr);
  assert.equal(first.isolated, true);
  assert.notEqual(first.p, join(homedir(), ".bastra", "drafts.json"));
  const override = JSON.parse((await run(process.execPath, ["--import", setup, "--input-type=module", "-e", code], { env: { ...env, BASTRA_TEST_KEEP_ENV: "1", BASTRA_DRAFTS_PATH: path } })).stderr);
  assert.equal(override.p, path);
}));


test("a persisted redacted URL draft remains valid in a second process", () => isolated(async (path) => {
  const d = draft();
  d.quote = "pg://u:p@db1.internal und pg://u:p@db2.internal";
  assert.ok(await upsertDraft(d, now));
  const module = new URL("../src/draft-store.ts", import.meta.url).href;
  const code = `import {listDrafts,draftStoreDiagnostics} from ${JSON.stringify(module)}; const rows=await listDrafts(${now}); console.error(JSON.stringify({rows,diagnostics:draftStoreDiagnostics()}));`;
  const out = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: { ...process.env, BASTRA_DRAFTS_PATH: path } });
  const result = JSON.parse(out.stderr.trim().split("\n").at(-1)!);
  assert.equal(result.rows.length, 1);
  assert.equal(result.diagnostics.skippedRows, 0);
  assert.equal(result.rows[0].quote, "pg://[REDACTED]@db1.internal und pg://[REDACTED]@db2.internal");
}));

test("draft fields are clipped before redaction without retaining a partial URL credential", () => isolated(async () => {
  const d = draft();
  d.quote = "Useful public instruction. " + "x ".repeat(280) + "password=shortValue ".repeat(10_000);
  const saved = await upsertDraft(d, now);
  assert.ok(saved, "secret text beyond the quote bound cannot cause the retained quote to be discarded");
  assert.ok(saved.quote.length <= 600);
  assert.ok(!saved.quote.includes("shortValue"));
  d.quote = "Useful public instruction. " + "x ".repeat(280) + "pg://user:shortValue@" + "host".repeat(200);
  d.context = "Useful context. " + "x ".repeat(70) + "pg://user:shortValue@" + "host".repeat(200);
  const clipped = await upsertDraft(d, now);
  assert.ok(clipped);
  assert.ok(!clipped.quote.includes("shortValue") && !clipped.context?.includes("shortValue"));
}));

test("clipping keeps spaced Unicode text and never cuts a surrogate pair", () => isolated(async () => {
  const spaced = await upsertDraft({...draft(20),quote:"ü ".repeat(450)},now);
  assert.ok(spaced);
  assert.equal(spaced.quote.length,600);
  const d = draft(21);
  d.quote = "x".repeat(599) + "😀".repeat(100);
  d.context = "x".repeat(159) + "😀".repeat(100);
  d.situation.before = ["x".repeat(199) + "😀".repeat(100)];
  const saved = await upsertDraft(d,now);
  assert.ok(saved);
  assert.equal(saved.quote,"x".repeat(599));
  assert.equal(saved.context,"x".repeat(159));
  assert.equal(saved.situation.before[0],"x".repeat(199));
  for (const text of [saved.quote,saved.context!,...saved.situation.before]) assert.equal(Buffer.from(text).toString("utf8"),text);
}));
