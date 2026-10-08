import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { extractReviewedMissChains, harvestReviewedMisses, hash, toCandidate } from "../src/learned-recall/reviewed-miss-harvest.js";

function line(value: unknown): string { return JSON.stringify(value); }

test("harvest keeps an explicit Recall miss separate from its later source", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall", input: { query: "rail" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: '{"weak_result":true,"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
  ].join("\n");
  const [candidate] = harvestReviewedMisses(session, "session.jsonl");
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.query, "where is the deployment rail");
  assert.match(candidate.sourceRef ?? "", /^sha256:/);
  assert.doesNotMatch(JSON.stringify(candidate), /private|rail\.md/);
  assert.deepEqual(candidate.evidence, { recall: "explicit-miss", sourceReadAfterRecall: true });
});

test("nonempty Recall chains remain unreviewed rather than becoming false misses", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall", input: { query: "rail" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: '{"hits":[{"id":"wrong-memory"}]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
  ].join("\n");
  assert.equal(harvestReviewedMisses(session, "session.jsonl")[0].status, "needs-relevance-label");
});

test("evidence before the matching Recall result cannot form a candidate", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: '{"hits":[]}' }] } }),
  ].join("\n");
  assert.deepEqual(harvestReviewedMisses(session, "session.jsonl"), []);
});

test("a source read without an inspectable identity still records the review boundary", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: '{"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }),
  ].join("\n");
  const [candidate] = harvestReviewedMisses(session, "session.jsonl");
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.sourceRef, null);
});

test("an unrelated empty tool result cannot taint a nonempty Recall", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [
      { type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall" },
      { type: "tool_use", id: "grep-1", name: "Grep" },
    ] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "grep-1", content: '{"hits":[]}' }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: '{"hits":[{"id":"wrong-memory"}]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
  ].join("\n");
  assert.equal(harvestReviewedMisses(session, "session.jsonl")[0].status, "needs-relevance-label");
});

test("a miss is what the envelope states, never a sentence inside a hit", () => {
  const run = (content: string): string => {
    const session = [
      line({ type: "user", message: { content: "where is the deployment rail" } }),
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall" }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content }] } }),
      line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
    ].join("\n");
    return harvestReviewedMisses(session, "session.jsonl")[0]?.status ?? "missing";
  };
  // envelope-level signals
  assert.equal(run('{"weak_result":true,"hits":[{"id":"memory-1"}]}'), "candidate");
  assert.equal(run('{"no_home":true,"hits":[{"id":"memory-1"}]}'), "candidate");
  assert.equal(run('{"hits":[]}'), "candidate");
  // the reported defect: a nonempty recall whose hit text names a miss
  assert.equal(run('{"hits":[{"id":"lesson-about-recall","summary":"no relevant memory was found — lesson"}]}'), "needs-relevance-label");
  // a nested empty hits array is payload, not envelope
  assert.equal(run('{"hits":[{"id":"memory-1","hits":[]}]}'), "needs-relevance-label");
  // text that is not an envelope carries no miss signal
  assert.equal(run("no relevant memory found"), "needs-relevance-label");
  assert.equal(run("Error: query is required"), "needs-relevance-label");
});

test("the served envelope may arrive as text parts, and its recall_id is read", () => {
  const envelope = JSON.stringify({ query: "rail", hits: [], recall_id: "11111111-2222-3333-4444-555555555555" }, null, 2);
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", timestamp: "2026-09-13T20:00:00.000Z", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: [{ type: "text", text: envelope }] }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__bastra-recall__load_memory", input: { id: "memory-1" } }] } }),
  ].join("\n");
  const [chain] = extractReviewedMissChains(session, "session.jsonl");
  assert.equal(chain.explicitMiss, true);
  assert.equal(chain.recallId, "11111111-2222-3333-4444-555555555555");
  assert.equal(chain.resultTs, "2026-09-13T20:00:00.000Z");
  assert.deepEqual(chain.evidence, { kind: "load-memory", memoryId: "memory-1" });
  assert.doesNotMatch(JSON.stringify(toCandidate(chain)), /memory-1|1111/);
});

test("a session-context block after the envelope does not hide the envelope", () => {
  const text = JSON.stringify({ query: "rail", hits: [], recall_id: "11111111-2222-3333-4444-555555555555" }, null, 2) +
    "<bastra-session-context>\nRecalled context — {\"hits\":[{\"id\":\"x\"}]} not the envelope\n</bastra-session-context>";
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: [{ type: "text", text }] }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
  ].join("\n");
  const stats = { recalls: 0, withRecallId: 0 };
  const [chain] = extractReviewedMissChains(session, "session.jsonl", stats);
  assert.equal(chain.explicitMiss, true);
  assert.equal(chain.recallId, "11111111-2222-3333-4444-555555555555");
  assert.deepEqual(stats, { recalls: 1, withRecallId: 1 });
});

test("transcript control envelopes cannot become a Recall intent", () => {
  const session = [
    line({ type: "user", message: { content: "real human request" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "skill", name: "Skill" }] } }),
    line({ type: "user", isMeta: true, sourceToolUseID: "skill", message: { content: [{ type: "text", text: "Base directory for this skill: /private/skill" }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall", content: '{"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
  ].join("\n");
  const [candidate] = harvestReviewedMisses(session, "session.jsonl");
  assert.equal(candidate.query, "real human request");
});

test("image placeholders cannot become a Recall intent", () => {
  const session = [
    line({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "[Image: source: /private/screenshot.png]" }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall", content: '{"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/rail.md" } }] } }),
  ].join("\n");
  assert.deepEqual(harvestReviewedMisses(session, "session.jsonl"), []);
});

test("seeded raw transcript preserves the expected candidate ledger", async () => {
  const fixture = fileURLToPath(new URL("../__fixtures__/reviewed-miss-harvest/explicit-miss.jsonl", import.meta.url));
  const candidates = harvestReviewedMisses(await readFile(fixture, "utf8"), "seed-explicit-miss");
  assert.deepEqual(candidates.map(({ query, status, evidence }) => ({ query, status, evidence })), [{
    query: "where is the deployment rail",
    status: "candidate",
    evidence: { recall: "explicit-miss", sourceReadAfterRecall: true },
  }]);
});

test("harvest CLI retains its first positional session file when no flags are supplied", () => {
  const fixture = fileURLToPath(new URL("../__fixtures__/reviewed-miss-harvest/explicit-miss.jsonl", import.meta.url));
  const script = resolve(import.meta.dirname, "..", "scripts", "harvest-reviewed-misses.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx", script, fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const records = JSON.parse(result.stdout) as Array<{ status: string }>;
  assert.deepEqual(records.map((record) => record.status), ["candidate"]);
});

// ─── Bash evidence: cat/head/tail/grep of a single file, nothing else ────

function bashChain(command: string): string {
  return [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: '{"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } }),
  ].join("\n");
}

test("a Bash cat/head/tail/grep of a single file resolves to a file-shaped evidence path", () => {
  const cases: Array<[string, string]> = [
    ["cat /home/user/sync/reading/mem-pressure.log", "/home/user/sync/reading/mem-pressure.log"],
    ["tail -60 /home/user/sync/reading/mem-pressure.log", "/home/user/sync/reading/mem-pressure.log"],
    ["head -n40 /home/user/sync/reading/mem-pressure.log", "/home/user/sync/reading/mem-pressure.log"],
    ["tail -f /var/log/syslog", "/var/log/syslog"],
    ['grep -v "OK swap=14%" /home/user/sync/reading/mem-pressure.log', "/home/user/sync/reading/mem-pressure.log"],
    ["grep -c 'Could not resolve hostname' /home/user/sync/reading/chrome-socks5.log", "/home/user/sync/reading/chrome-socks5.log"],
  ];
  for (const [command, path] of cases) {
    const [chain] = extractReviewedMissChains(bashChain(command), "session.jsonl");
    assert.deepEqual(chain.evidence, { kind: "bash-read", path }, command);
    assert.equal(toCandidate(chain).sourceRef, hash("file_path:" + path), command);
  }
});

test("a Bash call outside the closed cat/head/tail/grep shape does not manufacture evidence", () => {
  const rejected = [
    "cat file1.log file2.log", // more than one file
    "cat /proc/pressure/*", // glob — could read several files
    "grep -rl pattern /home/user", // recursive, not a single-file read
    "tail -n 60 /home/user/sync/reading/mem-pressure.log", // split "-n 60": ambiguous positional count
    "cat file.log | head -5", // pipe: more than one command
    "cat file.log; echo done", // semicolon: more than one command
    "echo \"$(cat file.log)\"", // subshell
    "find /home/user -iname '*.log'", // not a read command at all
    "uptime",
    "cat notes.log", // relative — the offline harvester has no session cwd to resolve it against
    "cat ./notes.log", // same, with an explicit leading dot
    "tail -20 ../reading/notes.log", // same, parent-relative
  ];
  for (const command of rejected) {
    // an unrecognized Bash call never consumes the evidence slot (unlike a
    // failed Read/load_memory match, which does): with nothing else to find,
    // the chain never forms at all — the same outcome as no evidence ever.
    assert.deepEqual(extractReviewedMissChains(bashChain(command), "session.jsonl"), [], command);
  }
});

test("an unparseable Bash call does not lock out a later real evidence step", () => {
  const session = [
    line({ type: "user", message: { content: "where is the deployment rail" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "recall-1", name: "mcp__bastra-recall__recall" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "recall-1", content: '{"hits":[]}' }] } }),
    line({ type: "assistant", message: { content: [
      { type: "tool_use", name: "Bash", input: { command: "uptime" } },
      { type: "tool_use", name: "Bash", input: { command: "cat /home/user/sync/reading/mem-pressure.log" } },
    ] } }),
  ].join("\n");
  const [chain] = extractReviewedMissChains(session, "session.jsonl");
  assert.deepEqual(chain.evidence, { kind: "bash-read", path: "/home/user/sync/reading/mem-pressure.log" });
});

test("harvest CLI writes only the explicitly requested queue", async () => {
  const fixture = fileURLToPath(new URL("../__fixtures__/reviewed-miss-harvest/explicit-miss.jsonl", import.meta.url));
  const script = resolve(import.meta.dirname, "..", "scripts", "harvest-reviewed-misses.ts");
  const dir = await mkdtemp(join(tmpdir(), "bastra-reviewed-miss-"));
  const output = join(dir, "queue.json");
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", script, "--out", output, fixture], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readdir(dir), ["queue.json"]);
    const records = JSON.parse(await readFile(output, "utf8")) as Array<{ sourceRef: string | null }>;
    assert.match(records[0]?.sourceRef ?? "", /^sha256:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
