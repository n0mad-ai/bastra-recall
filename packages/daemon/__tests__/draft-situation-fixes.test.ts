import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureTypedDrafts } from "../src/draft-capture.js";
import { draftFingerprint, draftId, upsertDraft, expireDrafts, listDrafts, type Draft } from "../src/draft-store.js";
import { parseTranscriptFile } from "../src/stop-transcript.js";
import { noteSessionForHarvest, runSessionHarvest } from "../src/session-harvest.js";
import { isSystemInjectedTurn } from "../src/system-turn.js";

const now = Date.UTC(2026, 9, 7, 9);
const day = 24 * 60 * 60 * 1000;
const quote = "The fixture host needs the staging VPN before any deployment connection can succeed.";
const meta = { cwd: "/work/fixture-project", gitBranch: "feature/fixture", timestamp: new Date(now).toISOString() };
const user = (content = quote) => ({ type: "user", ...meta, message: { role: "user", content } });
const assistant = (commands: string[] = [], text = "") => ({ type: "assistant", ...meta, message: { role: "assistant", content: [
  ...(text ? [{ type: "text", text }] : []), ...commands.map(command => ({ type: "tool_use", name: "Bash", input: { command } })),
] } });
const tool = (is_error: boolean) => ({ type: "user", ...meta, message: { role: "user", content: [{ type: "tool_result", is_error, content: "Synthetic result" }] } });
const parse = (rows: object[]) => parseTranscriptFile(rows.map(row => JSON.stringify(row)).join("\n"));
async function isolated(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-b2-situation-fixes-"));
  const env = { BASTRA_DRAFTS_PATH: join(dir, "drafts.json"), BASTRA_HARVEST_QUEUE_PATH: join(dir, "queue.json"), BASTRA_PENDING_SUGGESTIONS_PATH: join(dir, "pending.json"), BASTRA_VAULT_PATH: join(dir, "vault") };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { await fn(dir); } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
}

test("B2 fixes: before literals win under the cap, newest command first, also after merging", () => isolated(async () => {
  const commands = ["ssh fixture-host.invalid", "docker compose " + Array.from({ length: 25 }, (_, i) => `alpha${i}`).join(" "), "kubectl get " + Array.from({ length: 25 }, (_, i) => `beta${i}`).join(" ")];
  const first = parse([assistant(["older-command", "ssh fixture-host.invalid"]), user(), assistant(commands)]);
  await captureTypedDrafts(first, { session_id: "priority" }, now + 1, []);
  let row = (await listDrafts(now + 1))[0];
  assert.deepEqual(row.situation.lits.slice(0, 2), ["ssh", "fixture-host.invalid"]);
  assert.ok(row.situation.lits.includes("fixture-project"));
  assert.ok(row.situation.lits.length <= 32);
  const second = parse([assistant(["scp second-host.invalid"]), user(), assistant(commands)]);
  await captureTypedDrafts(second, { session_id: "merge" }, now + 2, []);
  row = (await listDrafts(now + 2))[0];
  assert.deepEqual(row.situation.lits.slice(0, 2), ["scp", "second-host.invalid"]);
  assert.ok(row.situation.lits.includes("ssh"));
  assert.ok(row.situation.lits.includes("fixture-host.invalid"));
}));

test("B2 fixes: literal sources are exactly retained command prefixes, with no project placeholder cue", () => isolated(async () => {
  const command = "curl " + " ".repeat(200) + "tail-only-literal";
  const turns = parse([assistant([command]), { ...user(), cwd: "/work/tmp/API_KEY=fixture-value" }]);
  await captureTypedDrafts(turns, { session_id: "prefix" }, now + 1, []);
  const row = (await listDrafts(now + 1))[0];
  assert.ok(row.situation.before[0].length <= 200);
  assert.ok(!row.situation.before[0].includes("tail-only-literal"));
  assert.ok(!row.situation.lits.includes("tail-only-literal"));
  assert.ok(row.situation.project?.includes("[REDACTED]"));
  assert.ok(row.situation.lits.every(token => !token.includes("[REDACTED]")));
}));

test("B2 fixes: the last result in the typed-turn window determines failure despite assistant prose", () => isolated(async () => {
  const failed = parse([assistant(["ssh fixture-host.invalid"]), tool(true), assistant([], "The connection did not complete."), user()]);
  await captureTypedDrafts(failed, { session_id: "failed" }, now + 1, []);
  assert.equal((await listDrafts(now + 1))[0].kind, "after-failure");
  const okQuote = "The alternate fixture deployment is now reachable from the testing network.";
  const recovered = parse([assistant(["ssh alternate.invalid"]), tool(true), tool(false), assistant([], "The last check completed."), user(okQuote)]);
  await captureTypedDrafts(recovered, { session_id: "recovered" }, now + 2, []);
  assert.equal((await listDrafts(now + 2)).find(row => row.quote === okQuote)?.kind, "typed");
}));

test("B2 fixes: a resumed harvest fills after without a new row/evidence, replay remains unchanged", () => isolated(async dir => {
  const path = join(dir, "resume.jsonl");
  const rows = [assistant(["ssh fixture-host.invalid"]), tool(true), user()];
  await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n"));
  const loadTurns = async (path: string) => parseTranscriptFile(await readFile(path, "utf8"));
  await noteSessionForHarvest({ session_id: "resume", transcript_path: path, ended: true, now });
  await runSessionHarvest({ loadTurns, now: now + 1 });
  const initial = (await listDrafts(now + 1))[0];
  assert.deepEqual(initial.situation.after, []);
  rows.push(assistant(["ssh fixture-host.invalid"]));
  await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n"));
  await noteSessionForHarvest({ session_id: "resume", transcript_path: path, ended: true, now: now + 2 });
  await runSessionHarvest({ loadTurns, now: now + 3 });
  const kept = await listDrafts(now + 3);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, initial.id);
  assert.equal(kept[0].evidence.length, 1);
  assert.deepEqual(kept[0].situation.after, ["ssh fixture-host.invalid"]);
  const before = await readFile(join(dir, "drafts.json"), "utf8");
  await noteSessionForHarvest({ session_id: "resume", transcript_path: path, ended: true, now: now + 4 });
  await runSessionHarvest({ loadTurns, now: now + 5 });
  assert.equal(await readFile(join(dir, "drafts.json"), "utf8"), before);
}));

test("B2 fixes: late evidence retains turn time but refreshes capture time and survives cleanup", () => isolated(async () => {
  const fp = draftFingerprint(quote);
  const seed: Draft = { id: draftId("seed", 0, fp), fp, quote, kind: "typed", state: "open", created: now - 20 * day, last_touched: now - 20 * day, evidence: [{ session_id: "seed", turn: 0, ts: now - 20 * day }, { session_id: "proof", turn: 0, ts: now - 20 * day }], surfaced: [], situation: { before: [], after: [], reads: [], lits: [] } };
  await upsertDraft(seed, now);
  const turns = parse([{ ...user(), timestamp: new Date(now - 10 * day).toISOString() }]);
  await captureTypedDrafts(turns, { session_id: "late" }, now, []);
  const repeated = (await listDrafts(now))[0];
  assert.equal(repeated.created, seed.created);
  assert.equal(repeated.last_touched, now);
  assert.equal(repeated.evidence.at(-1)?.ts, now - 10 * day);
  const freshQuote = "A different synthetic fixture requires an isolated database for each release.";
  await captureTypedDrafts(parse([{ ...user(freshQuote), timestamp: new Date(now - 10 * day).toISOString() }]), { session_id: "late-first" }, now, []);
  const fresh = (await listDrafts(now)).find(row => row.quote === freshQuote)!;
  assert.equal(fresh.created, now);
  assert.equal(fresh.last_touched, now);
  assert.equal(fresh.evidence[0].ts, now - 10 * day);
  await expireDrafts({ now: now + 1 });
  assert.equal((await listDrafts(now + 1)).length, 2);
  await expireDrafts({ now: now + 20 * day });
  assert.ok((await listDrafts(now + 20 * day)).some(row => row.id === seed.id));
}));

test("B2 fixes: new cwd without a branch removes previous-project branch, including prior assistant context", () => isolated(async () => {
  await captureTypedDrafts(parse([user()]), { session_id: "alpha" }, now + 1, []);
  const next = { type: "user", cwd: "/work/beta", timestamp: new Date(now + 2).toISOString(), message: { role: "user", content: quote } };
  await captureTypedDrafts(parse([assistant([], "Prior project context."), next]), { session_id: "beta" }, now + 2, []);
  const row = (await listDrafts(now + 2))[0];
  assert.equal(row.situation.cwd, "/work/beta");
  assert.equal(row.situation.project, "beta");
  assert.equal(row.situation.branch, undefined);
}));

test("B2 fixes: complete harness headers accept Windows and tilde paths, typed mentions stay user", () => {
  for (const path of ["C:\\work\\fixture", "C:/work/fixture", "~/work/fixture", "/work/fixture"]) {
    const text = `# AGENTS.md instructions for ${path}\n\nKeep generated files separate.`;
    assert.equal(isSystemInjectedTurn(text), true, path);
  }
  assert.equal(isSystemInjectedTurn("# AGENTS.md instructions are outdated, please rewrite them"), false);
  assert.equal(isSystemInjectedTurn("<turn_aborted> shows up in my logs"), false);
  assert.equal(isSystemInjectedTurn("# AGENTS.md instructions for     \n\nSome body."), false);
});
