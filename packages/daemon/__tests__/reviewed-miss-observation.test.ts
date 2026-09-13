import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { extractReviewedMissChains, hash } from "../src/learned-recall/reviewed-miss-harvest.js";
import {
  assembleObservation,
  loadTelemetryPools,
  observeChain,
  parseReviewerLabels,
  snapshotVault,
  type ObservationEngines,
} from "../src/learned-recall/reviewed-miss-engines.js";
import { deriveCueProposals, intentTerms } from "../src/learned-recall/reviewed-miss-cues.js";
import {
  classifyReviewedMissObservation,
  type FrozenCandidatePool,
  type FrozenObservationIds,
  type ReviewedMissObservation,
} from "../src/learned-recall/reviewed-miss-observation.js";

const id = (value: string): string => hash("id:" + value);

const frozen: FrozenObservationIds = {
  indexSnapshotId: hash("index:test"),
  indexIdentityBasis: "telemetry-derived",
  vaultSnapshotId: hash("vault:test"),
  profileSnapshotId: hash("profile:test"),
};

function pool(ordered: string[], served: string[]): FrozenCandidatePool {
  return {
    recallRef: hash("recall_id:r1"),
    observedAt: "2026-09-13T20:00:00.000Z",
    orderedCandidateIds: ordered.map(id),
    depth: ordered.length,
    servedCandidateIds: served.map(id),
    scoreSpace: { kind: "bm25", formulaVersion: null, arms: ["bm25"] },
    vaultSize: 3,
  };
}

function vaultObject(
  target: string,
  vault: "present" | "absent",
  index: "present" | "absent",
  indexReason: "present" | "no-such-object" | "created-after-observation" | "not-a-memory" | "no-observation-time" = index === "present" ? "present" : "no-such-object",
): ReviewedMissObservation["target"] {
  return {
    kind: "vault-object",
    candidateId: id(target),
    vaultMembership: { snapshotId: frozen.vaultSnapshotId, candidateId: id(target), membership: vault, reason: vault === "present" ? "present" : "no-such-object" },
    indexMembership: { snapshotId: frozen.indexSnapshotId, candidateId: id(target), membership: index, reason: indexReason },
  };
}

function observation(target: ReviewedMissObservation["target"], withPool: FrozenCandidatePool | null = pool(["a", "b", "c"], ["a"])): ReviewedMissObservation {
  return { kind: "reviewed-miss-observation/v1", frozen: withPool ? frozen : null, pool: withPool, target };
}

test("classifier: each proof pattern lands in exactly one class", () => {
  const classify = classifyReviewedMissObservation;
  // the same pool served the object: Recall answered, not a miss
  assert.equal(classify(observation(vaultObject("a", "present", "present"))), "served-hit");
  assert.equal(classify(observation(vaultObject("b", "present", "present"))), "in-pool-not-selected");
  assert.equal(classify(observation(vaultObject("z", "present", "present"))), "genuine-out-of-pool");
  assert.equal(classify(observation(vaultObject("z", "present", "absent", "created-after-observation"))), "unindexed-vault-object");
  assert.equal(classify(observation(vaultObject("z", "present", "absent", "not-a-memory"))), "unindexed-vault-object");
  assert.equal(classify(observation({ kind: "external-read", sourceRef: hash("file_path:/x"), vaultChecked: null, reviewerDurable: null })), "external-source");
  assert.equal(classify(observation({ kind: "external-read", sourceRef: hash("file_path:/x"), vaultChecked: { snapshotId: frozen.vaultSnapshotId, idCount: 3 }, reviewerDurable: true })), "vault-gap");
});

test("classifier: contradictions and missing proofs fail closed", () => {
  const classify = classifyReviewedMissObservation;
  // in the pool but index says absent
  assert.equal(classify(observation(vaultObject("b", "present", "absent"))), "unknown");
  // indexed but not in the vault snapshot
  assert.equal(classify(observation(vaultObject("z", "absent", "present"))), "unknown");
  // vault object without any telemetry pool
  assert.equal(classify(observation(vaultObject("z", "present", "present"), null)), "unknown");
  // no observation time: existence at observation cannot be proven
  assert.equal(classify(observation(vaultObject("z", "present", "absent", "no-observation-time"))), "unknown");
  // a durable claim without a checked snapshot is not a vault gap
  assert.equal(classify(observation({ kind: "external-read", sourceRef: hash("file_path:/x"), vaultChecked: null, reviewerDurable: true })), "unknown");
  assert.equal(classify(observation({ kind: "unresolved", sourceRef: null })), "unknown");
  assert.equal(classify({ kind: "something-else" }), "unknown");
  // a proof for another snapshot cannot be borrowed
  const borrowed = vaultObject("z", "present", "present");
  if (borrowed.kind === "vault-object") borrowed.vaultMembership.snapshotId = hash("vault:other");
  assert.equal(classify(observation(borrowed)), "unknown");
});

const line = (value: unknown): string => JSON.stringify(value);

function session(recallId: string, envelopeHits: string[], evidence: { name: string; input: Record<string, unknown> }): string {
  const envelope = JSON.stringify({ query: "rail", hits: envelopeHits.map((hit) => ({ id: hit, score: 1 })), recall_id: recallId }, null, 2);
  return [
    line({ type: "user", message: { content: "where is the deployment rail owner" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t-" + recallId, name: "mcp__bastra-recall__recall", input: { query: "rail" } }] } }),
    line({ type: "user", timestamp: "2026-09-13T20:00:00.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t-" + recallId, content: [{ type: "text", text: envelope }] }] } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "e-" + recallId, ...evidence }] } }),
  ].join("\n");
}

function event(recallId: string, ts: string, poolIds: string[], hits: string[]): string {
  return line({
    kind: "hook_recall",
    ts,
    recall_id: recallId,
    vault_size: 2,
    k: 4,
    hits: hits.map((h) => ({ id: h, score: 10, type: "lesson" })),
    candidate_pool: poolIds.map((p) => ({ id: p, score: 5 })),
    score_kind: "bm25",
    score_arms: ["bm25"],
    candidate_pool_score_kind: "bm25",
    candidate_pool_score_arms: ["bm25"],
  });
}

const memory = (memoryId: string): string =>
  ["---", `id: ${memoryId}`, `title: ${memoryId}`, "type: lesson", "scope: test", `summary: lesson ${memoryId}`, "---", "", "body", ""].join("\n");

async function fixture(): Promise<{ dir: string; vault: string; events: string; engines: ObservationEngines }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-reviewed-miss-obs-"));
  const vault = join(dir, "vault");
  const events = join(dir, "events");
  await mkdir(join(vault, "memories"), { recursive: true });
  await mkdir(events);
  await writeFile(join(vault, "memories", "served-one.md"), memory("served-one"));
  await writeFile(join(vault, "memories", "deep-two.md"), memory("deep-two"));
  await writeFile(join(vault, "memories", "far-three.md"), memory("far-three"));
  await writeFile(join(vault, "memories", "plain-note.md"), "# not a memory\n");
  const later = new Date(Date.now() + 3_600_000).toISOString();
  await writeFile(join(events, "events-2026-09-13.jsonl"), [
    event("r-inpool", later, ["served-one", "deep-two"], ["served-one"]),
    event("r-outpool", later, ["served-one"], ["served-one"]),
    event("r-before", "2000-01-01T00:00:00.000Z", ["served-one"], ["served-one"]),
    event("r-served", later, ["served-one", "deep-two"], ["served-one"]),
  ].join("\n") + "\n");
  const engines: ObservationEngines = {
    pools: await loadTelemetryPools(events),
    vaultRoot: vault,
    snapshot: await snapshotVault(vault),
    labels: new Map(),
  };
  return { dir, vault, events, engines };
}

test("engines: telemetry pool + vault snapshot prove the four vault-side classes", async () => {
  const { dir, vault, engines } = await fixture();
  try {
    const observe = (recallId: string, evidence: { name: string; input: Record<string, unknown> }, served: string[] = ["served-one"]) => {
      const [chain] = extractReviewedMissChains(session(recallId, served, evidence), "s.jsonl");
      return observeChain(chain, engines);
    };
    const load = (memoryId: string) => ({ name: "mcp__bastra-recall__load_memory", input: { id: memoryId } });
    const read = (path: string) => ({ name: "Read", input: { file_path: path } });

    assert.equal(observe("r-inpool", load("deep-two")).classification, "in-pool-not-selected");
    assert.equal(observe("r-outpool", load("far-three")).classification, "genuine-out-of-pool");
    assert.equal(observe("r-outpool", read(join(vault, "memories", "far-three.md"))).classification, "genuine-out-of-pool");
    assert.equal(observe("r-before", load("far-three")).classification, "unindexed-vault-object");
    assert.equal(observe("r-outpool", read(join(vault, "memories", "plain-note.md"))).classification, "unindexed-vault-object");
    assert.equal(observe("r-outpool", read(join(dir, "elsewhere.md"))).classification, "external-source");
    // served by the same pool and then loaded: a hit, not a miss
    assert.equal(observe("r-served", load("served-one")).classification, "served-hit");
    // no telemetry event for this recall_id
    assert.equal(observe("r-missing", load("deep-two")).classification, "unknown");
    // a vault object the snapshot does not hold
    assert.equal(observe("r-inpool", load("vanished")).classification, "unknown");

    const record = observe("r-inpool", load("deep-two"));
    const rendered = JSON.stringify(record);
    assert.doesNotMatch(rendered, /deep-two|served-one|r-inpool|vault\/memories/);
    assert.equal(record.recallRef, hash("recall_id:r-inpool"));
    assert.equal(record.observation.pool?.depth, 2);
    assert.equal(record.observation.frozen?.indexIdentityBasis, "telemetry-derived");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("engines: without --events or --vault nothing can be claimed", async () => {
  const [chain] = extractReviewedMissChains(session("r-inpool", ["served-one"], { name: "mcp__bastra-recall__load_memory", input: { id: "deep-two" } }), "s.jsonl");
  const bare: ObservationEngines = { pools: null, vaultRoot: null, snapshot: null, labels: new Map() };
  const built = assembleObservation(chain, bare);
  assert.equal(built.pool, null);
  assert.equal(built.target.kind, "unresolved");
  assert.equal(classifyReviewedMissObservation(built), "unknown");
});

test("engines: a reviewer label turns an external read into a vault gap only against a checked snapshot", async () => {
  const { dir, engines } = await fixture();
  try {
    const [chain] = extractReviewedMissChains(session("r-outpool", ["served-one"], { name: "Read", input: { file_path: join(dir, "repo", "README.md") } }), "s.jsonl");
    assert.equal(observeChain(chain, engines).classification, "external-source");
    const labelled = { ...engines, labels: parseReviewerLabels(line({ ref: hash("recall_id:r-outpool"), durable: true }) + "\n") };
    assert.equal(observeChain(chain, labelled).classification, "vault-gap");
    const unsnapshotted = { ...labelled, vaultRoot: null, snapshot: null };
    assert.equal(observeChain(chain, unsnapshotted).classification, "unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cues: proposals carry the clear target, the intent terms and distinct-session support", async () => {
  const { dir, engines } = await fixture();
  try {
    const load = { name: "mcp__bastra-recall__load_memory", input: { id: "deep-two" } };
    const pairs = ["one.jsonl", "two.jsonl", "one.jsonl"].map((name) => {
      const [chain] = extractReviewedMissChains(session("r-inpool", ["served-one"], load), name);
      return { chain, record: observeChain(chain, engines) };
    });
    const [proposal, ...rest] = deriveCueProposals(pairs, engines, new Date("2026-09-13T21:00:00.000Z"));
    assert.equal(rest.length, 0);
    assert.equal(proposal.targetId, "deep-two");
    assert.equal(proposal.support, 2);
    assert.equal(proposal.episodes.length, 3);
    assert.deepEqual(proposal.episodes[0].terms, intentTerms("where is the deployment rail owner"));
    assert.ok(proposal.episodes[0].terms.includes("deployment"));
    assert.equal(proposal.episodes[0].poolDepth, 2);
    assert.equal(proposal.confidence, null);
    // an external read proposes nothing
    const [external] = extractReviewedMissChains(session("r-outpool", ["served-one"], { name: "Read", input: { file_path: join(dir, "x.md") } }), "s.jsonl");
    assert.deepEqual(deriveCueProposals([{ chain: external, record: observeChain(external, engines) }], engines), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cli: the accounting line names absent engines, and proposals are written only where named", async () => {
  const { dir, vault, events } = await fixture();
  const script = resolve(import.meta.dirname, "..", "scripts", "harvest-reviewed-misses.ts");
  try {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, session("r-inpool", ["served-one"], { name: "mcp__bastra-recall__load_memory", input: { id: "deep-two" } }) + "\n");
    const bare = spawnSync(process.execPath, ["--import", "tsx", script, sessionFile], { encoding: "utf8" });
    assert.equal(bare.status, 0, bare.stderr);
    const bareReport = JSON.parse(bare.stderr.trim().split("\n").pop() ?? "{}") as { observed: { by_class: { transcript: Record<string, number> } }; engines: Record<string, string> };
    assert.equal(bareReport.observed.by_class.transcript.unknown, 1);
    assert.equal(bareReport.engines.pool_join, "absent");
    assert.equal(bareReport.engines.vault_snapshot, "absent");

    const proposals = join(dir, "proposals.json");
    const queue = join(dir, "queue.json");
    const full = spawnSync(process.execPath, ["--import", "tsx", script, "--events", events, "--vault", vault, "--out", queue, "--proposals", proposals, sessionFile], { encoding: "utf8" });
    assert.equal(full.status, 0, full.stderr);
    assert.equal(full.stdout, "");
    const report = JSON.parse(full.stderr.trim().split("\n").pop() ?? "{}") as { observed: { by_class: { transcript: Record<string, number> }; proposals: { targets: number } } };
    assert.equal(report.observed.by_class.transcript["in-pool-not-selected"], 1);
    assert.equal(report.observed.proposals.targets, 1);
    const written = JSON.parse(await readFile(queue, "utf8")) as Array<{ classification: string }>;
    assert.equal(written[0].classification, "in-pool-not-selected");
    assert.doesNotMatch(await readFile(queue, "utf8"), /deep-two/);
    assert.match(await readFile(proposals, "utf8"), /"targetId": "deep-two"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── evidence provision: hook lane, heatmap, hot paths, dens ─────

import { loadTelemetry } from "../src/learned-recall/reviewed-miss-engines.js";
import { dens, heatmap, hotPaths, observeHookLane } from "../src/learned-recall/reviewed-miss-evidence.js";

function loadEvent(id: string, ts: string, session: string, link: { from_hook_recall?: string; follows_recall?: string; hook_hint_rank?: number } = {}, found = true): string {
  return line({ kind: "load_memory", ts, session_id: session, id, found, ...link });
}

function eventIn(recallId: string, ts: string, session: string, poolIds: string[], hits: string[]): string {
  return JSON.stringify({ ...JSON.parse(event(recallId, ts, poolIds, hits)), session_id: session });
}

async function hookFixture(): Promise<{ dir: string; engines: ObservationEngines; telemetry: Awaited<ReturnType<typeof loadTelemetry>> }> {
  const { dir, vault, events } = await fixture();
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const t = (min: number) => new Date(Date.now() + 3_600_000 + min * 60_000).toISOString();
  await writeFile(join(events, "events-2026-09-14.jsonl"), [
    eventIn("h-1", later, "s1", ["served-one", "deep-two"], ["served-one"]),
    eventIn("h-2", later, "s2", ["served-one", "deep-two"], ["served-one"]),
    eventIn("h-3", later, "s3", ["served-one", "deep-two", "far-three"], ["served-one"]),
    loadEvent("served-one", t(1), "s1", { from_hook_recall: "h-1", hook_hint_rank: 1 }),
    loadEvent("deep-two", t(2), "s1", { follows_recall: "h-1" }),
    loadEvent("far-three", t(1), "s2", { from_hook_recall: "h-2" }),
    loadEvent("served-one", t(1), "s3", { from_hook_recall: "h-3", hook_hint_rank: 1 }),
    loadEvent("deep-two", t(2), "s3", { follows_recall: "h-3" }),
    loadEvent("deep-two", t(5), "s4"),
    loadEvent("deep-two", t(5), "s5", { from_hook_recall: "h-nope" }),
    loadEvent("gone", t(6), "s5", { from_hook_recall: "h-1" }, false),
  ].join("\n") + "\n");
  const telemetry = await loadTelemetry(events);
  const engines: ObservationEngines = { pools: telemetry.pools, vaultRoot: vault, snapshot: await snapshotVault(vault), labels: new Map() };
  return { dir, engines, telemetry };
}

test("hook lane: telemetry alone classifies daemon-joined loads with the same classifier", async () => {
  const { dir, engines, telemetry } = await hookFixture();
  try {
    const { records, gaps } = observeHookLane(telemetry, engines);
    const byClass = records.map((r) => r.classification).sort();
    assert.deepEqual(byClass, ["genuine-out-of-pool", "in-pool-not-selected", "in-pool-not-selected", "served-hit", "served-hit"]);
    assert.ok(records.every((r) => r.lane === "hook" && r.intentSource === "hook-query"));
    assert.doesNotMatch(JSON.stringify(records), /deep-two|far-three|served-one|h-1|"s1"/);
    // the join ceiling is visible: every gap kind is counted, none classified
    assert.deepEqual(gaps.map((g) => g.kind).sort(), ["link-without-pool", "load-not-found", "load-without-recall-link"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hook lane bite: a renamed join field turns classified loads into a den, not into zero misses", async () => {
  const { dir, engines, telemetry } = await hookFixture();
  try {
    const broken = { ...telemetry, loads: telemetry.loads.map((l) => ({ ...l, fromHookRecall: null, followsRecall: null })) };
    const { records, gaps } = observeHookLane(broken, engines);
    assert.equal(records.length, 0);
    const den = dens(gaps).find((d) => d.kind === "load-without-recall-link");
    assert.equal(den?.verdict, "den");
    assert.ok(den && den.sessions >= 2 && den.exit.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("heatmap and hot paths: hubs and never-loaded are densities, edges need distinct-session support", async () => {
  const { dir, telemetry } = await hookFixture();
  try {
    const rows = heatmap(telemetry, { hubSessions: 3 });
    const served = rows.find((r) => r.memoryId === "served-one");
    assert.ok(served && served.hub && served.surfacedSessions === 3 && served.servedHit === 2 && !served.surfacedNeverLoaded);
    assert.deepEqual(served?.loadedAtRank, [1, 1]);
    const deep = rows.find((r) => r.memoryId === "deep-two");
    assert.ok(deep && !deep.hub && deep.inPoolBelowServed >= 2 && deep.loaded === 4, JSON.stringify(deep));
    const paths = hotPaths(telemetry.loads, { maxGapMs: 30 * 60_000, establishSessions: 2 });
    const edge = paths.find((p) => p.fromId === "served-one" && p.toId === "deep-two");
    assert.ok(edge && edge.support === 2 && edge.established);
    assert.doesNotMatch(JSON.stringify(edge?.sessionRefs), /"s1"|"s3"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dens: one occurrence is noise, two sessions is a den, absence is none", () => {
  const rows = dens([
    { kind: "envelope-without-recall-id", sessionRef: hash("a") },
    { kind: "link-without-pool", sessionRef: hash("a") },
    { kind: "link-without-pool", sessionRef: hash("b") },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.kind, r.verdict]));
  assert.equal(by["envelope-without-recall-id"], "noise");
  assert.equal(by["link-without-pool"], "den");
  assert.equal(by["no-vault-snapshot"], "none");
});

test("cli: --hook-lane needs no sessions and the report keeps coverage, observed and gaps apart", async () => {
  const { dir, engines } = await hookFixture();
  const script = resolve(import.meta.dirname, "..", "scripts", "harvest-reviewed-misses.ts");
  try {
    const evidence = join(dir, "evidence.json");
    const run = spawnSync(process.execPath, ["--import", "tsx", script, "--hook-lane", "--events", join(dir, "events"), "--vault", engines.vaultRoot ?? "", "--out", join(dir, "q.json"), "--evidence", evidence], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stderr.trim().split("\n").pop() ?? "{}") as { coverage: Record<string, number>; observed: { by_class: { hook: Record<string, number> }; live_classes: string[]; hubs: number }; gaps: Array<{ kind: string; verdict: string }>; engines: Record<string, string> };
    assert.equal(report.coverage.sessions_scanned, 0);
    assert.equal(report.coverage.telemetry_loads, 8);
    assert.equal(report.observed.by_class.hook["in-pool-not-selected"], 2);
    assert.ok(report.observed.live_classes.includes("genuine-out-of-pool"));
    assert.equal(report.observed.hubs, 1);
    assert.ok(report.gaps.some((g) => g.kind === "load-without-recall-link" && g.verdict === "noise"));
    assert.match(report.engines.hook_lane, /telemetry-only/);
    assert.match(await readFile(evidence, "utf8"), /"memoryId": "served-one"/);
    assert.doesNotMatch(await readFile(join(dir, "q.json"), "utf8"), /served-one/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
