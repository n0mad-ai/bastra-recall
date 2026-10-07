import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { parseTranscriptFile, type TranscriptTurn } from "../src/stop-transcript.js";
import { captureTypedDrafts } from "../src/draft-capture.js";
import { listDrafts } from "../src/draft-store.js";
import { harvestCandidates, noteSessionForHarvest, runSessionHarvest } from "../src/session-harvest.js";

const now = Date.UTC(2026, 9, 7, 9);
const quote = "The fixture host requires the staging VPN before a connection can succeed.";
const meta = { cwd: "/work/fixture-project", gitBranch: "feature/fixture", timestamp: new Date(now).toISOString() };
const user = (content: string) => ({ type: "user", ...meta, message: { role: "user", content } });
const assistant = (commands: string[], reads: string[] = []) => ({ type: "assistant", ...meta, message: { role: "assistant", content: [
  ...commands.map(command => ({ type: "tool_use", name: "Bash", input: { command } })),
  ...reads.map(file_path => ({ type: "tool_use", name: "Read", input: { file_path } })),
] } });
const failed = (value: unknown) => ({ type: "user", ...meta, message: { role: "user", content: [{ type: "tool_result", is_error: value, content: "Synthetic result" }] } });
const parse = (rows: object[]) => parseTranscriptFile(rows.map(row => JSON.stringify(row)).join("\n"));
async function isolated(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-b2-situation-"));
  const env = { BASTRA_DRAFTS_PATH: join(dir, "drafts.json"), BASTRA_VAULT_PATH: join(dir, "vault"), BASTRA_HARVEST_QUEUE_PATH: join(dir, "queue.json"), BASTRA_PENDING_SUGGESTIONS_PATH: join(dir, "pending.json"), BASTRA_LOG_PATH: join(dir, "logs"), BASTRA_TELEMETRY: "1" };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { await fn(dir); } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
}

test("B2 parser reads observed Claude failure, cwd, branch and time; unknown failure/time stays absent", () => {
  const turns = parse([failed(true), failed(false), failed("unknown"), { ...user(quote), timestamp: "invalid" }]);
  assert.equal((turns[0] as TranscriptTurn & { failed?: boolean }).failed, true);
  assert.equal((turns[1] as TranscriptTurn & { failed?: boolean }).failed, false);
  assert.equal((turns[2] as TranscriptTurn & { failed?: boolean }).failed, undefined);
  const first = turns[0] as TranscriptTurn & { cwd?: string; branch?: string; at?: number };
  assert.equal(first.cwd, meta.cwd);
  assert.equal(first.branch, meta.gitBranch);
  assert.equal(first.at, now);
  assert.equal((turns[3] as TranscriptTurn & { at?: number }).at, undefined);
});

test("B2 ssh failure/explanation/success captures one situated draft and rereads without changing store or vault", () => isolated(async dir => {
  const rows = [
    assistant(["ssh fixture-host.invalid"], [join(homedir(), ".config", "fixture-access.md")]),
    failed(true), user(quote),
    assistant(["ssh fixture-host.invalid", "curl https://fixture:alpha@example.invalid/health --silent", `cat ${homedir()}/.config/fixture-access.md`]),
  ];
  await mkdir(join(dir, "vault"));
  await writeFile(join(dir, "vault", "fixture.md"), "Synthetic vault bytes\n");
  const vaultBefore = await readFile(join(dir, "vault", "fixture.md"), "utf8");
  const path = join(dir, "session.jsonl");
  await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n"));
  await noteSessionForHarvest({ session_id: "situation", transcript_path: path, ended: true, now });
  const loadTurns = async (path: string) => parseTranscriptFile(await readFile(path, "utf8"));
  await runSessionHarvest({ loadTurns, now: now + 1 });
  const drafts = await listDrafts(now + 1);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].kind, "after-failure");
  assert.deepEqual(drafts[0].situation.before, ["ssh fixture-host.invalid"]);
  assert.equal(drafts[0].situation.cwd, meta.cwd);
  assert.equal(drafts[0].situation.project, "fixture-project");
  assert.equal(drafts[0].situation.branch, meta.gitBranch);
  for (const token of ["ssh", "fixture-host.invalid", "fixture-access.md", "fixture-project"]) assert.ok(drafts[0].situation.lits.includes(token), token);
  assert.ok(!drafts[0].situation.lits.includes("silent"));
  assert.ok(!drafts[0].situation.lits.includes("REDACTED"));
  assert.match(drafts[0].situation.after[1], /\[REDACTED\]/);
  assert.match(drafts[0].situation.after[2], /cat ~\//);
  assert.doesNotMatch(await readFile(join(dir, "drafts.json"), "utf8"), /fixture:alpha/);
  const before = await readFile(join(dir, "drafts.json"), "utf8");
  const queuePath = join(dir, "queue.json");
  const queue = JSON.parse(await readFile(queuePath, "utf8"));
  queue[0].harvested_upto = 0;
  await writeFile(queuePath, JSON.stringify(queue));
  await noteSessionForHarvest({ session_id: "situation", transcript_path: path, ended: true, now: now + 2 });
  assert.equal((await runSessionHarvest({ loadTurns, now: now + 3 })).harvested, 1);
  assert.equal(await readFile(join(dir, "drafts.json"), "utf8"), before);
  assert.equal(await readFile(join(dir, "vault", "fixture.md"), "utf8"), vaultBefore);
  assert.deepEqual(await readdir(join(dir, "vault")), ["fixture.md"]);
  const logs = (await Promise.all((await readdir(join(dir, "logs"))).map(name => readFile(join(dir, "logs", name), "utf8")))).join("");
  assert.doesNotMatch(logs, /fixture-host|fixture:alpha|staging VPN|feature\/fixture/);
}));

test("B2 uses bounded before/after windows between typed turns and merges later situations without losing limits", () => isolated(async (dir) => {
  const first = parse([
    assistant(["ignored-old-command"]), user("start"),
    assistant(["cmd-zero", "cmd-one", "cmd-two", "cmd-three"], ["/work/zero.md", "/work/one.md", "/work/two.md", "/work/three.md"]),
    user(quote), assistant(["next-one", "next-two", "next-three", "next-four"]), user("done"), assistant(["ignored-next-command"]),
  ]);
  await captureTypedDrafts(first, { session_id: "window" }, now + 1, harvestCandidates(first, 0, Infinity));
  let draft = (await listDrafts(now + 1))[0];
  assert.deepEqual(draft.situation.before, ["cmd-one", "cmd-two", "cmd-three"]);
  assert.deepEqual(draft.situation.after, ["next-one", "next-two", "next-three"]);
  assert.deepEqual(draft.situation.reads, ["/work/one.md", "/work/two.md", "/work/three.md"]);
  const second = parse([assistant(["new-one", "new-two"], ["/work/new.md"]), user(quote), assistant(["new-after"])]);
  await captureTypedDrafts(second, { session_id: "later" }, now + 2, []);
  draft = (await listDrafts(now + 2))[0];
  assert.equal((await listDrafts(now + 2)).length, 1);
  assert.equal(draft.evidence.length, 2);
  assert.deepEqual(draft.situation.before, ["cmd-three", "new-one", "new-two"]);
  assert.deepEqual(draft.situation.after, ["next-one", "next-two", "next-three"]);
  assert.ok(draft.situation.reads.includes("/work/new.md"));
  assert.ok(draft.situation.reads.length <= 3);
  assert.ok(draft.situation.lits.includes("new.md"));
  assert.ok(draft.situation.lits.length <= 32);
  const beforeReplay = await readFile(join(dir, "drafts.json"), "utf8");
  await captureTypedDrafts(first, { session_id: "window" }, now + 3, []);
  assert.equal(await readFile(join(dir, "drafts.json"), "utf8"), beforeReplay, "old evidence must not reorder newer situation cues");
}));

test("B2 keeps Codex parser output unchanged and captures without situation when Claude fields are absent", () => isolated(async () => {
  const message = (role: string, text: string) => ({ type: "response_item", timestamp: new Date(now).toISOString(), payload: { type: "message", role, content: [{ type: "input_text", text }] } });
  const turns = parse([
    message("assistant", "Working on the fixture."),
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: "ssh fixture-host.invalid" }) } },
    message("user", quote),
  ]);
  assert.deepEqual(turns, [{ role: "assistant", content: "Working on the fixture.", commands: ["ssh fixture-host.invalid"], tools: ["shell"] }, { role: "user", content: quote }]);
  await captureTypedDrafts(turns, { session_id: "codex", client: "codex" }, now, []);
  const drafts = await listDrafts(now);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].kind, "typed");
  assert.deepEqual(JSON.parse(JSON.stringify(drafts[0].situation)), { before: [], after: [], reads: [], lits: [] });
}));

test("B2 keeps a shape label even when a later save suppresses that turn in the relay", () => isolated(async dir => {
  const turns = parse([
    { type: "assistant", ...meta, message: { role: "assistant", content: [{ type: "text", text: "Which database should staging use?" }] } },
    user("Staging always uses its own isolated database for fixture deployments."),
    { type: "assistant", ...meta, message: { role: "assistant", content: [{ type: "tool_use", name: "mcp__bastra_recall__save_memory", input: {} }] } },
  ]);
  assert.deepEqual(harvestCandidates(turns), []);
  const path = join(dir, "label.jsonl");
  await writeFile(path, "synthetic transcript placeholder");
  await noteSessionForHarvest({ session_id: "label", transcript_path: path, ended: true, now });
  const result = await runSessionHarvest({ loadTurns: async () => turns, now: now + 1 });
  assert.equal(result.candidates, 0);
  assert.equal((await listDrafts(now + 1))[0].kind, "answer");
}));

test("B2 later evidence from a new cwd can clear a formerly recorded branch", () => isolated(async () => {
  await captureTypedDrafts(parse([user(quote)]), { session_id: "old-project" }, now + 1, []);
  const next = { ...user(quote), cwd: "/work/next-project", gitBranch: "" };
  await captureTypedDrafts(parse([next]), { session_id: "new-project" }, now + 2, []);
  const draft = (await listDrafts(now + 2))[0];
  assert.equal(draft.situation.cwd, "/work/next-project");
  assert.equal(draft.situation.project, "next-project");
  assert.equal(draft.situation.branch, "");
}));
