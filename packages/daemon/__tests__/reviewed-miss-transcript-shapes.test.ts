/**
 * Transcript and input shapes the reviewed-miss harvester has to read right
 * (#454 review): a batch recall, several recalls for one intent, harness-written
 * user turns, a secret in the prompt, a non-record JSONL line, a wrong path.
 *
 * Runner: node --import tsx --import ../../scripts/test-env.mjs --test __tests__/reviewed-miss-transcript-shapes.test.ts
 */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { extractReviewedMissChains, type RecallCallStats } from "../src/learned-recall/reviewed-miss-harvest.js";
import { loadTelemetry, parseReviewerLabels, snapshotVault, type ObservationEngines } from "../src/learned-recall/reviewed-miss-engines.js";
import { observeLanes } from "../src/learned-recall/reviewed-miss-evidence.js";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "harvest-reviewed-misses.ts");
const RECALL = "mcp__bastra-recall__recall";
const LOAD = "mcp__bastra-recall__load_memory";
/** Shaped like no vendor's token, so no scanner reads this file as a leak. */
const SECRET = "q7Zk2mW9xT4vB8nR1cL6pD3sH5jF0gYa";

const line = (value: unknown): string => JSON.stringify(value);
const memory = (id: string): string => ["---", `id: ${id}`, `title: ${id}`, "type: lesson", "scope: test", `summary: lesson ${id}`, "---", "", "body", ""].join("\n");
const later = (min: number): string => new Date(Date.now() + 3_600_000 + min * 60_000).toISOString();

function recallEvent(recallId: string, hits: string[], pool: string[]): string {
  return line({
    kind: "recall", ts: later(0), recall_id: recallId, vault_size: 3, k: 4, session_id: "run-1",
    hits: hits.map((id) => ({ id, score: 10 })),
    candidate_pool: pool.map((id) => ({ id, score: 5 })),
    candidate_pool_score_kind: "bm25", candidate_pool_score_arms: ["bm25"],
  });
}

const user = (content: unknown, extra: Record<string, unknown> = {}): string => line({ type: "user", ...extra, message: { content } });
const uses = (...tools: Array<{ id: string; name: string; input: Record<string, unknown> }>): string =>
  line({ type: "assistant", message: { content: tools.map((tool) => ({ type: "tool_use", ...tool })) } });
const results = (...parts: Array<{ id: string; envelope: unknown }>): string =>
  line({ type: "user", timestamp: later(0), message: { content: parts.map((part) => ({ type: "tool_result", tool_use_id: part.id, content: JSON.stringify(part.envelope) })) } });
const envelope = (hits: string[], ids: { recall_id: string; recall_ids?: string[] }): unknown => ({ query: "rail", hits: hits.map((id) => ({ id })), ...ids });
const load = (id: string): string => uses({ id: "load-" + id, name: LOAD, input: { id } });

const PROMPT = "where is the deployment rail owner";

/** One recall for PROMPT, its result, then `rest`. */
function single(recallId: string, hits: string[], ...rest: string[]): string {
  return [user(PROMPT), uses({ id: "t1", name: RECALL, input: { query: "rail" } }), results({ id: "t1", envelope: envelope(hits, { recall_id: recallId }) }), ...rest].join("\n") + "\n";
}

async function world(events: string[]): Promise<{ dir: string; vault: string; eventsDir: string; engines: ObservationEngines }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-reviewed-miss-shapes-"));
  const vault = join(dir, "vault");
  const eventsDir = join(dir, "events");
  await mkdir(join(vault, "memories"), { recursive: true });
  await mkdir(eventsDir);
  for (const id of ["served-one", "deep-two", "third"]) await writeFile(join(vault, "memories", id + ".md"), memory(id));
  await writeFile(join(eventsDir, "events-2026-10-07.jsonl"), events.join("\n") + "\n");
  const telemetry = await loadTelemetry(eventsDir);
  return { dir, vault, eventsDir, engines: { pools: telemetry.pools, vaultRoot: vault, snapshot: await snapshotVault(vault), labels: new Map() } };
}

/** Class and proposal targets of the one chain `jsonl` holds. */
function observed(jsonl: string, engines: ObservationEngines): { classes: string[]; targets: string[]; recalls: number } {
  const lanes = observeLanes([{ jsonl, fileName: "sess-A.jsonl" }], null, engines, { hookLane: false, hubSessions: 3 });
  return { classes: lanes.transcript.map((pair) => pair.record.classification), targets: lanes.proposals.map((p) => p.targetId), recalls: lanes.stats.recalls };
}

const TWO_POOLS = [recallEvent("r1", ["served-one"], ["served-one"]), recallEvent("r2", ["deep-two"], ["deep-two", "third"])];

test("batch recall: a hit served by the second phrasing is a served hit, not a cue proposal", async () => {
  const { dir, engines } = await world(TWO_POOLS);
  try {
    const batch = (loaded: string): string => [
      user(PROMPT),
      uses({ id: "t1", name: RECALL, input: { queries: ["rail", "deployment owner"] } }),
      results({ id: "t1", envelope: envelope(["served-one", "deep-two"], { recall_id: "r1", recall_ids: ["r1", "r2"] }) }),
      load(loaded),
    ].join("\n") + "\n";
    const [chain] = extractReviewedMissChains(batch("deep-two"), "sess-A");
    assert.deepEqual(chain.recallIds, ["r1", "r2"]);
    assert.equal(chain.recallId, "r1");
    assert.deepEqual(observed(batch("deep-two"), engines), { classes: ["served-hit"], targets: [], recalls: 1 });
    // In the second phrasing's pool, never served: the pool it is judged against is both pools.
    assert.deepEqual(observed(batch("third"), engines).classes, ["in-pool-not-selected"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("batch recall: one phrasing without a recorded pool proves nothing about the pool", async () => {
  const { dir, engines } = await world([TWO_POOLS[0]]);
  try {
    const jsonl = [
      user(PROMPT),
      uses({ id: "t1", name: RECALL, input: { queries: ["rail", "deployment owner"] } }),
      results({ id: "t1", envelope: envelope(["served-one"], { recall_id: "r1", recall_ids: ["r1", "r2"] }) }),
      load("third"),
    ].join("\n") + "\n";
    assert.deepEqual(observed(jsonl, engines), { classes: ["unknown"], targets: [], recalls: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hook lane: a load after a batch recall is not judged against the one phrasing it is linked to", async () => {
  // The daemon's own shapes: each phrasing's event carries the batch width, and
  // the load is linked to one of them — here the one that did not serve it.
  const loadEvent = line({ kind: "load_memory", ts: later(1), session_id: "run-1", id: "served-one", found: true, follows_recall: "r2" });
  const hookLane = async (recalls: string[]): Promise<{ classes: string[]; targets: string[]; gaps: string[] }> => {
    const { dir, eventsDir, engines } = await world([...recalls, loadEvent]);
    try {
      const lanes = observeLanes([], await loadTelemetry(eventsDir), engines, { hookLane: true, hubSessions: 3 });
      return { classes: lanes.hook.records.map((record) => record.classification), targets: lanes.proposals.map((p) => p.targetId), gaps: lanes.gaps.map((gap) => gap.kind) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const batch = TWO_POOLS.map((event) => line({ ...JSON.parse(event), query_count: 2 }));
  assert.deepEqual(await hookLane(batch), { classes: [], targets: [], gaps: ["batch-link-without-sibling-pools"] });
  // Control: the same two recalls, not a batch — the linked pool is the pool, and the load is judged.
  assert.deepEqual(await hookLane(TWO_POOLS), { classes: ["genuine-out-of-pool"], targets: ["served-one"], gaps: [] });
});

test("hook lane: only a batch that ran more than one phrasing has sibling pools to miss", async () => {
  // One recall event and the load of the hit it served. What the event says about
  // its batch decides whether its pool is the whole pool.
  const hookLane = async (batch: Record<string, unknown>): Promise<{ classes: string[]; gaps: string[] }> => {
    const { dir, eventsDir, engines } = await world([
      line({ ...JSON.parse(recallEvent("r1", ["served-one"], ["served-one"])), ...batch }),
      line({ kind: "load_memory", ts: later(1), session_id: "run-1", id: "served-one", found: true, follows_recall: "r1" }),
    ]);
    try {
      const lanes = observeLanes([], await loadTelemetry(eventsDir), engines, { hookLane: true, hubSessions: 3 });
      return { classes: lanes.hook.records.map((record) => record.classification), gaps: lanes.gaps.map((gap) => gap.kind) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const judged = { classes: ["served-hit"], gaps: [] };
  const alone: Array<[string, Record<string, unknown>]> = [
    ["a plain recall", {}],
    // The daemon's own event for `queries: [q, q]`: two submitted, one collapsed, one recall run.
    ["two identical queries, collapsed to one", { query_count: 2, batch_overlap: 1, batch_collapsed: 1 }],
    ["four submitted, three collapsed", { query_count: 4, batch_overlap: 0.9, batch_collapsed: 3 }],
    ["a width of one", { query_count: 1 }],
    ["a width of zero", { query_count: 0 }],
  ];
  for (const [name, batch] of alone) assert.deepEqual(await hookLane(batch), judged, name);
  const siblings: Array<[string, Record<string, unknown>]> = [
    ["two phrasings ran", { query_count: 2, batch_overlap: 0.2, batch_collapsed: 0 }],
    ["the forwarder's event: the width alone", { query_count: 2 }],
    ["three submitted, one collapsed, two ran", { query_count: 3, batch_collapsed: 1 }],
    ["a collapsed count that is no number", { query_count: 2, batch_collapsed: "1" }],
  ];
  for (const [name, batch] of siblings) assert.deepEqual(await hookLane(batch), { classes: [], gaps: ["batch-link-without-sibling-pools"] }, name);
});

test("two recalls in one assistant message: both are counted, and a load is judged against both pools", async () => {
  const { dir, engines } = await world(TWO_POOLS);
  try {
    const jsonl = [
      user(PROMPT),
      uses({ id: "tA", name: RECALL, input: { query: "rail" } }, { id: "tB", name: RECALL, input: { query: "deployment owner" } }),
      results({ id: "tA", envelope: envelope(["served-one"], { recall_id: "r1" }) }, { id: "tB", envelope: envelope(["deep-two"], { recall_id: "r2" }) }),
      load("served-one"),
    ].join("\n") + "\n";
    const stats: RecallCallStats = { recalls: 0, withRecallId: 0 };
    const chains = extractReviewedMissChains(jsonl, "sess-A", stats);
    assert.equal(chains.length, 1);
    assert.deepEqual(chains[0].recallIds, ["r1", "r2"]);
    assert.deepEqual(stats, { recalls: 2, withRecallId: 2 });
    assert.deepEqual(observed(jsonl, engines), { classes: ["served-hit"], targets: [], recalls: 2 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a recall asked again before any evidence step joins the chain; one after the evidence starts a new chain", () => {
  const second = [uses({ id: "t2", name: RECALL, input: { query: "owner" } }), results({ id: "t2", envelope: envelope([], { recall_id: "r2" }) })];
  const joined = extractReviewedMissChains(single("r1", ["served-one"], ...second, load("served-one")), "sess-A");
  assert.equal(joined.length, 1);
  assert.deepEqual(joined[0].recallIds, ["r1", "r2"]);
  // One of the two results had hits: the recalls together did not miss.
  assert.equal(joined[0].explicitMiss, false);

  const apart = extractReviewedMissChains(single("r1", ["served-one"], load("served-one"), ...second, load("third")), "sess-A");
  assert.deepEqual(apart.map((chain) => chain.recallIds), [["r1"], ["r2"]]);
  assert.deepEqual(apart.map((chain) => chain.explicitMiss), [false, true]);
});

test("a recall that returned no candidate is an empty pool; a recall with no recorded pool is still none", async () => {
  // The daemon's own shape for an empty result: `hits: []`, no `candidate_pool`,
  // and the score space under the event's own `score_kind` / `score_arms`.
  const noPool = (extra: Record<string, unknown>): string =>
    line({ kind: "recall", ts: later(0), recall_id: "r2", vault_size: 3, k: 4, session_id: "run-1", score_kind: "bm25", score_arms: ["bm25"], ...extra });
  const second = [uses({ id: "t2", name: RECALL, input: { query: "owner" } }), results({ id: "t2", envelope: envelope([], { recall_id: "r2" }) })];
  const lanesOf = async (r2: string[], loaded: string): Promise<{ classes: string[]; targets: string[]; gaps: string[] }> => {
    const { dir, engines } = await world([TWO_POOLS[0], ...r2]);
    try {
      const jsonl = single("r1", ["served-one"], ...second, load(loaded));
      const lanes = observeLanes([{ jsonl, fileName: "sess-A.jsonl" }], null, engines, { hookLane: false, hubSessions: 3 });
      return { classes: lanes.transcript.map((pair) => pair.record.classification), targets: lanes.proposals.map((p) => p.targetId), gaps: lanes.gaps.map((gap) => gap.kind) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const empty = [noPool({ hit_count: 0, hits: [] })];
  assert.deepEqual(await lanesOf(empty, "served-one"), { classes: ["served-hit"], targets: [], gaps: [] });
  // The union of one pool and an empty one is still a whole pool: absence from it is a proof.
  assert.deepEqual(await lanesOf(empty, "third"), { classes: ["genuine-out-of-pool"], targets: ["third"], gaps: [] });
  // No pool to judge against, and the gap says so: the evidence step was a load_memory, not an opaque read.
  const missing: Array<[string, string[]]> = [
    ["no event for the recall", []],
    ["hits served, no pool recorded", [noPool({ hit_count: 1, hits: [{ id: "deep-two", score: 10 }] })]],
    ["neither hits nor pool on the event", [noPool({})]],
    ["no score space on the event", [line({ kind: "recall", ts: later(0), recall_id: "r2", vault_size: 3, k: 4, hits: [] })]],
  ];
  for (const [name, r2] of missing) {
    assert.deepEqual(await lanesOf(r2, "served-one"), { classes: ["unknown"], targets: [], gaps: ["chain-without-pool"] }, name);
  }
});

test("a harness-written user turn neither ends the chain nor becomes the query", () => {
  const harnessTurns: Array<[string, unknown]> = [
    ["task notification", "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>"],
    ["agent mail", 'Another Claude session sent a message:\n<agent-message from="peer">look at the vault</agent-message>'],
    ["reminder only", [{ type: "text", text: "<system-reminder>\nThe task tools have not been used recently.\n</system-reminder>" }]],
  ];
  for (const [name, content] of harnessTurns) {
    const chains = extractReviewedMissChains(single("r1", ["served-one"], user(content), load("deep-two")), "sess-A");
    assert.equal(chains.length, 1, name);
    assert.equal(chains[0].query, PROMPT, name);
    assert.deepEqual(chains[0].evidence, { kind: "load-memory", memoryId: "deep-two" }, name);
  }
});

test("reminder text around the typed prompt stays out of the query", () => {
  const reminder = "<system-reminder>\nrail owner is carol, see memory deployment-rail\n</system-reminder>";
  const prompts: Array<[string, unknown]> = [
    ["a reminder part beside the typed part", [{ type: "text", text: reminder }, { type: "text", text: PROMPT }]],
    ["a reminder in front, one string", reminder + "\n" + PROMPT],
    ["a reminder behind, one string", PROMPT + "\n" + reminder],
  ];
  for (const [name, content] of prompts) {
    const jsonl = [user(content), uses({ id: "t1", name: RECALL, input: { query: "rail" } }), results({ id: "t1", envelope: envelope(["served-one"], { recall_id: "r1" }) }), load("deep-two")].join("\n");
    const [chain] = extractReviewedMissChains(jsonl, "sess-A");
    assert.equal(chain.query, PROMPT, name);
  }
});

test("a slash command is the owner's turn: it ends the chain, and its echo is no query", () => {
  const echoes = [
    "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>",
    // Seen in real transcripts: the output a local command printed, delivered as a user turn.
    "<local-command-stdout>Goal set: keep the rail green</local-command-stdout>",
  ];
  const after = [uses({ id: "t2", name: RECALL, input: { query: "model" } }), results({ id: "t2", envelope: envelope([], { recall_id: "r2" }) }), load("third")];
  for (const echo of echoes) {
    const chains = extractReviewedMissChains(single("r1", ["served-one"], load("deep-two"), user(echo), ...after), "sess-A");
    assert.deepEqual(chains.map((chain) => chain.query), [PROMPT], echo);
    // Without an evidence step before the command, its recall is not carried past the command.
    assert.deepEqual(extractReviewedMissChains(single("r1", ["served-one"], user(echo), load("deep-two")), "sess-A"), [], echo);
  }
});

test("an interrupt marker is the owner's turn: it ends the chain, and its text is no query", () => {
  // What the client writes into the transcript when the owner presses escape.
  const markers: unknown[] = [
    "[Request interrupted by user]",
    "[Request interrupted by user for tool use]",
    [{ type: "text", text: "[Request interrupted by user]" }],
  ];
  const after = [uses({ id: "t2", name: RECALL, input: { query: "rail" } }), results({ id: "t2", envelope: envelope(["served-one"], { recall_id: "r2" }) }), load("third")];
  for (const marker of markers) {
    const name = JSON.stringify(marker);
    const chains = extractReviewedMissChains(single("r1", ["served-one"], load("deep-two"), user(marker), ...after), "sess-A");
    assert.deepEqual(chains.map((chain) => chain.query), [PROMPT], name);
    // Without an evidence step before the interrupt, its recall is not carried past it.
    assert.deepEqual(extractReviewedMissChains(single("r1", ["served-one"], user(marker), load("deep-two")), "sess-A"), [], name);
  }
  // Text typed beside the marker is the next intent; the marker stays out of it.
  const typed = "use the staging rail instead";
  const redirected = extractReviewedMissChains(single("r1", ["served-one"], user([{ type: "text", text: markers[0] }, { type: "text", text: typed }]), ...after), "sess-A");
  assert.deepEqual(redirected.map((chain) => chain.query), [typed]);
});

test("text behind an interrupt marker in the same block is the next intent; a marker anywhere else is text", () => {
  const marker = "[Request interrupted by user]";
  const typed = "Please use the staging rail";
  const second = [uses({ id: "t2", name: RECALL, input: { query: "rail" } }), results({ id: "t2", envelope: envelope(["served-one"], { recall_id: "r2" }) }), load("third")];
  // A first recall without an evidence step, then the turn under test, then a full chain.
  const queries = (content: unknown): string[] =>
    extractReviewedMissChains(single("r1", ["served-one"], user(content), ...second), "sess-A").map((chain) => chain.query);
  const leading: Array<[string, unknown]> = [
    ["marker and text in one string", marker + "\n" + typed],
    ["the tool-use spelling of the marker", "[Request interrupted by user for tool use]\n" + typed],
    ["marker and text in one text block", [{ type: "text", text: marker + " " + typed }]],
    ["marker and text in two text blocks", [{ type: "text", text: marker }, { type: "text", text: typed }]],
  ];
  for (const [name, content] of leading) assert.deepEqual(queries(content), [typed], name);
  // The marker alone still ends the chain and starts none.
  assert.deepEqual(queries(marker), []);
  // Not at the start of a block, the marker is something the owner wrote: the whole turn is the intent.
  for (const text of [`Explain ${marker} for me`, `"${marker}"`, "```\n" + marker + "\n```"]) assert.deepEqual(queries(text), [text], text);
  // Inside a tool result it is payload: the turn is no turn of the owner, and the first chain goes on.
  assert.deepEqual(queries([{ type: "tool_result", tool_use_id: "other", content: marker }]), [PROMPT]);
});

test("cli: a token typed into the prompt reaches neither the queue nor the proposals", async () => {
  const { dir, vault, eventsDir } = await world([recallEvent("r1", ["served-one"], ["served-one", "deep-two"])]);
  try {
    const sessionFile = join(dir, "sess-A.jsonl");
    const prompt = `where is the deployment rail owner, use API_TOKEN=${SECRET} for the api`;
    await writeFile(sessionFile, [user(prompt), uses({ id: "t1", name: RECALL, input: { query: "rail" } }), results({ id: "t1", envelope: envelope(["served-one"], { recall_id: "r1" }) }), load("deep-two")].join("\n") + "\n");
    const queue = join(dir, "queue.json");
    const proposals = join(dir, "proposals.json");
    const run = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--events", eventsDir, "--vault", vault, "--out", queue, "--proposals", proposals, sessionFile], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const queueText = await readFile(queue, "utf8");
    const proposalText = await readFile(proposals, "utf8");
    // The run did produce the record and the proposal the token would have sat in.
    assert.match(queueText, /deployment rail owner/);
    assert.match(proposalText, /"targetId": "deep-two"/);
    for (const [name, text] of [["queue", queueText], ["proposals", proposalText], ["stderr", run.stderr]] as const) {
      assert.ok(!text.includes(SECRET), `${name} carries the token`);
      assert.ok(!text.toLowerCase().includes(SECRET.toLowerCase().slice(4, 20)), `${name} carries part of the token`);
    }
    const [proposal] = JSON.parse(proposalText) as Array<{ episodes: Array<{ terms: string[] }> }>;
    assert.ok(!proposal.episodes[0].terms.includes("redacted"), "the redaction marker became a term");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a JSONL line that is valid JSON and no record is skipped in every reader", async () => {
  const junk = ["null", "42", '"text"', "[1,2]", "true"];
  const { dir, eventsDir, engines } = await world([...junk, recallEvent("r1", ["served-one"], ["served-one", "deep-two"])]);
  try {
    assert.equal((await loadTelemetry(eventsDir)).pools.size, 1);
    const jsonl = [...junk, ...single("r1", ["served-one"], ...junk, load("deep-two")).trimEnd().split("\n")].join("\n") + "\n";
    assert.deepEqual(observed(jsonl, engines).classes, ["in-pool-not-selected"]);
    assert.deepEqual([...parseReviewerLabels([...junk, line({ ref: "sha256:aa", durable: true })].join("\n"))], [["sha256:aa", { durable: true }]]);
    const sessionFile = join(dir, "sess-A.jsonl");
    await writeFile(sessionFile, jsonl);
    const run = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--events", eventsDir, sessionFile], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli: a wrong --events or --vault path is an error, not a run with zero counts", async () => {
  const { dir, vault, eventsDir } = await world([recallEvent("r1", ["served-one"], ["served-one"])]);
  try {
    const sessionFile = join(dir, "sess-A.jsonl");
    await writeFile(sessionFile, single("r1", ["served-one"], load("deep-two")));
    await mkdir(join(dir, "empty"));
    const run = (...flags: string[]) => spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...flags, sessionFile], { encoding: "utf8" });
    const wrong: Array<[string, string[], RegExp]> = [
      ["--events names nothing", ["--events", join(dir, "no-such-dir")], /--events .*not a directory/],
      ["--events names a file", ["--events", sessionFile], /--events .*not a directory/],
      ["--events holds no event file", ["--events", join(dir, "empty")], /--events .*no events-\*\.jsonl/],
      ["--vault names nothing", ["--events", eventsDir, "--vault", join(dir, "no-such-vault")], /--vault .*not a directory/],
      ["--vault holds no memory", ["--events", eventsDir, "--vault", join(dir, "empty")], /--vault .*no memory/],
    ];
    for (const [name, flags, message] of wrong) {
      const result = run(...flags);
      assert.equal(result.status, 1, name);
      assert.match(result.stderr, message, name);
      assert.equal(result.stdout, "", name);
      assert.doesNotMatch(result.stderr, /reviewed-miss-evidence-report/, name);
    }
    // Control: the same call with the right paths runs.
    assert.equal(run("--events", eventsDir, "--vault", vault).status, 0);
    const missingSession = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, join(dir, "no-such-session.jsonl")], { encoding: "utf8" });
    assert.equal(missingSession.status, 1);
    assert.match(missingSession.stderr, /harvest-reviewed-misses: .*no-such-session\.jsonl/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the harvester's modules do not ship in the npm package: their script does not either", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-reviewed-miss-pack-"));
  try {
    await mkdir(join(dir, "dist", "learned-recall"), { recursive: true });
    await writeFile(join(dir, "package.json"), await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const modules = ["reviewed-miss-cues", "reviewed-miss-engines", "reviewed-miss-evidence", "reviewed-miss-harvest", "reviewed-miss-observation"];
    for (const name of [...modules, "mint-job"]) {
      await writeFile(join(dir, "dist", "learned-recall", name + ".js"), "export {};\n");
      await writeFile(join(dir, "dist", "learned-recall", name + ".js.map"), "{}\n");
    }
    const { stdout } = await promisify(execFile)("npm", ["pack", "--ignore-scripts", "--dry-run", "--json"], {
      cwd: dir, env: { ...process.env, npm_config_cache: join(dir, "cache") },
    });
    const paths = (JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>)[0].files.map((f) => f.path);
    assert.ok(paths.includes("dist/learned-recall/mint-job.js"), "the rest of learned-recall must still ship");
    assert.deepEqual(paths.filter((path) => path.includes("reviewed-miss")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
