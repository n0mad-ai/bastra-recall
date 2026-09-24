import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionRef } from "../src/learned-recall/reviewed-miss-harvest.js";
import { loadTelemetry, snapshotVault, type ObservationEngines, type Telemetry } from "../src/learned-recall/reviewed-miss-engines.js";
import { observeLanes, type TranscriptInput } from "../src/learned-recall/reviewed-miss-evidence.js";
import { pseudonymousSession } from "../src/telemetry-dimensions.js";

const line = (value: unknown): string => JSON.stringify(value);
const memory = (id: string): string => ["---", `id: ${id}`, `title: ${id}`, "type: lesson", "scope: test", `summary: lesson ${id}`, "---", "", "body", ""].join("\n");
const later = (min: number): string => new Date(Date.now() + 3_600_000 + min * 60_000).toISOString();

/** A client session as every lane must spell it once hashed. */
const refOf = (rawSession: string): string => sessionRef(pseudonymousSession(rawSession)!);

/**
 * Telemetry in the daemon's own shapes: an MCP `recall` stamps `session_id`
 * with the daemon run and the client session only as its pseudonym; a
 * `hook_recall` carries both; a `load_memory` carries only the run.
 */
function recallEvent(kind: "recall" | "hook_recall", recallId: string, ts: string, rawSession: string): string {
  return line({
    kind, ts, recall_id: recallId, vault_size: 2, k: 4,
    session_id: kind === "hook_recall" ? rawSession : "run-1",
    hits: [{ id: "served-one", score: 10 }],
    candidate_pool: [{ id: "served-one", score: 5 }, { id: "deep-two", score: 4 }],
    candidate_pool_score_kind: "bm25", candidate_pool_score_arms: ["bm25"],
    dimensions: { experiment_session: pseudonymousSession(rawSession) },
  });
}

function loadEvent(id: string, ts: string, link: { from_hook_recall?: string; follows_recall?: string }): string {
  return line({ kind: "load_memory", ts, session_id: "run-1", id, found: true, ...link });
}

/** A transcript whose MCP recall `recallId` is followed by `evidence`. */
function transcript(recallId: string, evidence: { name: string; input: Record<string, unknown> }, meta: { sessionId?: string } = {}): string {
  const envelope = JSON.stringify({ query: "rail", hits: [{ id: "served-one" }], recall_id: recallId });
  return [
    line({ type: "user", ...meta, message: { content: "where is the deployment rail owner" } }),
    line({ type: "assistant", ...meta, message: { content: [{ type: "tool_use", id: "t-" + recallId, name: "mcp__bastra-recall__recall", input: { query: "rail" } }] } }),
    line({ type: "user", ...meta, timestamp: later(0), message: { content: [{ type: "tool_result", tool_use_id: "t-" + recallId, content: envelope }] } }),
    line({ type: "assistant", ...meta, message: { content: [{ type: "tool_use", id: "e-" + recallId, ...evidence }] } }),
  ].join("\n") + "\n";
}

async function world(events: string[]): Promise<{ dir: string; vault: string; telemetry: Telemetry; engines: ObservationEngines }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-reviewed-miss-lanes-"));
  const vault = join(dir, "vault");
  await mkdir(join(vault, "memories"), { recursive: true });
  await mkdir(join(dir, "events"));
  await writeFile(join(vault, "memories", "served-one.md"), memory("served-one"));
  await writeFile(join(vault, "memories", "deep-two.md"), memory("deep-two"));
  await writeFile(join(dir, "events", "events-2026-09-24.jsonl"), events.join("\n") + "\n");
  const telemetry = await loadTelemetry(join(dir, "events"));
  const engines: ObservationEngines = { pools: telemetry.pools, vaultRoot: vault, snapshot: await snapshotVault(vault), labels: new Map() };
  return { dir, vault, telemetry, engines };
}

interface Scenario {
  name: string;
  events: string[];
  transcripts: (vault: string) => TranscriptInput[];
  /** Raw client sessions that really took part. */
  sessions: string[];
  episodes: number;
}

const readDeepTwo = (vault: string) => ({ name: "Read", input: { file_path: join(vault, "memories", "deep-two.md") } });
const loadDeepTwo = { name: "mcp__bastra-recall__load_memory", input: { id: "deep-two" } };

const SCENARIOS: Scenario[] = [
  {
    name: "one session, seen by both lanes through two recalls",
    events: [recallEvent("recall", "r-mcp", later(0), "sess-A"), recallEvent("hook_recall", "h-A", later(1), "sess-A"), loadEvent("deep-two", later(2), { from_hook_recall: "h-A" })],
    transcripts: (vault) => [{ fileName: "sess-A.jsonl", jsonl: transcript("r-mcp", readDeepTwo(vault), { sessionId: "sess-A" }) }],
    sessions: ["sess-A"],
    episodes: 2,
  },
  {
    name: "one load, observed by the transcript and linked back by follows_recall",
    events: [recallEvent("recall", "r-mcp", later(0), "sess-A"), loadEvent("deep-two", later(1), { follows_recall: "r-mcp" })],
    transcripts: () => [{ fileName: "sess-A.jsonl", jsonl: transcript("r-mcp", loadDeepTwo) }],
    sessions: ["sess-A"],
    episodes: 1,
  },
  {
    name: "a transcript named after its session, records without a sessionId",
    events: [recallEvent("recall", "r-mcp", later(0), "sess-A"), recallEvent("hook_recall", "h-A", later(1), "sess-A"), loadEvent("deep-two", later(2), { from_hook_recall: "h-A" })],
    transcripts: (vault) => [{ fileName: "sess-A.jsonl", jsonl: transcript("r-mcp", readDeepTwo(vault)) }],
    sessions: ["sess-A"],
    episodes: 2,
  },
  {
    name: "an archived transcript under another file name keeps the session its records name",
    events: [recallEvent("recall", "r-mcp", later(0), "sess-A"), recallEvent("hook_recall", "h-A", later(1), "sess-A"), loadEvent("deep-two", later(2), { from_hook_recall: "h-A" })],
    transcripts: (vault) => [{ fileName: "archive-copy.jsonl", jsonl: transcript("r-mcp", readDeepTwo(vault), { sessionId: "sess-A" }) }],
    sessions: ["sess-A"],
    episodes: 2,
  },
  {
    name: "two sessions, one per lane",
    events: [recallEvent("recall", "r-mcp", later(0), "sess-A"), recallEvent("hook_recall", "h-B", later(1), "sess-B"), loadEvent("deep-two", later(2), { from_hook_recall: "h-B" })],
    transcripts: (vault) => [{ fileName: "sess-A.jsonl", jsonl: transcript("r-mcp", readDeepTwo(vault), { sessionId: "sess-A" }) }],
    sessions: ["sess-A", "sess-B"],
    episodes: 2,
  },
];

test("invariant: both lanes spell a client session the same way — one proposal, support once per session", async () => {
  for (const scenario of SCENARIOS) {
    const { dir, vault, telemetry, engines } = await world(scenario.events);
    try {
      const { proposals, transcript: pairs, hook } = observeLanes(scenario.transcripts(vault), telemetry, engines, { hookLane: true, hubSessions: 3 });
      // precondition: the lanes really observed something, so an empty proposal list cannot pass
      assert.ok(pairs.length > 0, scenario.name + ": transcript lane observed the episode");
      assert.deepEqual(proposals.map((p) => p.targetId), ["deep-two"], scenario.name);
      const [proposal] = proposals;
      assert.equal(proposal.episodes.length, scenario.episodes, scenario.name + ": episodes");
      assert.equal(pairs.length + hook.records.length, scenario.episodes, scenario.name + ": each episode observed by exactly one lane");
      const expected = scenario.sessions.map(refOf).sort();
      assert.deepEqual([...new Set(proposal.episodes.map((e) => e.sessionRef))].sort(), expected, scenario.name + ": every lane writes the client session's ref");
      assert.equal(proposal.support, scenario.sessions.length, scenario.name + ": support");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("hot paths and the heatmap count client sessions, not daemon runs", async () => {
  // Every load below shares one daemon run; two client sessions took the path.
  const events = [
    recallEvent("hook_recall", "h-A", later(0), "sess-A"),
    recallEvent("hook_recall", "h-B", later(0), "sess-B"),
    loadEvent("served-one", later(1), { from_hook_recall: "h-A" }),
    loadEvent("deep-two", later(2), { follows_recall: "h-A" }),
    loadEvent("served-one", later(1), { from_hook_recall: "h-B" }),
    loadEvent("deep-two", later(2), { follows_recall: "h-B" }),
  ];
  const { dir, telemetry, engines } = await world(events);
  try {
    const { paths, heat } = observeLanes([], telemetry, engines, { hookLane: true, hubSessions: 2 });
    const edge = paths.find((p) => p.fromId === "served-one" && p.toId === "deep-two");
    assert.ok(edge, "the edge is observed");
    assert.equal(edge.support, 2);
    assert.deepEqual(edge.sessionRefs, ["sess-A", "sess-B"].map(refOf).sort());
    assert.equal(heat.find((r) => r.memoryId === "deep-two")?.loadedSessions, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
