/**
 * Integration test for the curator pass (#155/#156): usage sidecar → decision
 * → state/demotions → REPORT.md, against a temp vault root, a fake in-RAM
 * vault, and a floors file injected via BASTRA_FLOORS_PATH.
 *
 * Run: npx tsx --test packages/daemon/__tests__/curator-run.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectConsolidationCandidates,
  collectReflexCandidates,
  formatReflexCandidateBlock,
  collectAdoptionCandidates,
  runCuratorPass,
  sanitizeRunResultForHttp,
  type CuratorRunDeps,
} from "../src/curator-run.js";
import { recordUsage } from "../src/usage-sidecar.js";
import { loadCuratorState } from "../src/curator.js";
import { readEventLog, type TelemetryEvent } from "../src/learned-recall/harvest.js";

const NOW = Date.parse("2026-07-03T12:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

function fakeVault(mems: Array<Record<string, unknown>>): CuratorRunDeps["vault"] {
  const map = new Map(mems.map((fm) => [fm.id as string, { fm }]));
  return {
    list: () => [...map.values()],
    get: (id: string) => map.get(id),
    size: () => map.size,
  };
}

async function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

function memories(): Array<Record<string, unknown>> {
  return [
    // The context-tax archetype: old, surfaced a lot, never engaged.
    { id: "tax", title: "Old unused lesson", created: iso(120), topic_path: ["css", "grid"], related: [] },
    // Floored: same usage profile, must be protected.
    { id: "floored", title: "Floored state", created: iso(120), topic_path: ["ops"], related: [] },
    // User-directed (#158): same context-tax profile, exempt from lifecycle
    // passes by provenance — must never show up as candidate or demotion.
    { id: "dictated", title: "User-dictated preference", created: iso(120), topic_path: ["prefs"], related: [], write_origin: "user-directed" },
    // Young: same usage profile, grace period.
    { id: "young", title: "Fresh lesson", created: iso(3), topic_path: ["css", "grid"], related: [] },
    // Engaged recently.
    { id: "used", title: "Living lesson", created: iso(120), topic_path: ["git"], related: ["gone-target"] },
  ];
}

async function seedUsage(root: string): Promise<void> {
  const surfacedALot = (id: string) =>
    Array.from({ length: 5 }, (_, i) => ({ id, kind: "surfaced" as const, ts: iso(30 - i) }));
  await recordUsage(root, [
    ...surfacedALot("tax"),
    ...surfacedALot("floored"),
    ...surfacedALot("dictated"),
    ...surfacedALot("young"),
    ...surfacedALot("used"),
    { id: "used", kind: "acted_on", ts: iso(2) },
  ]);
}

async function withFixture<T>(
  fn: (root: string, deps: CuratorRunDeps, demotionCalls: string[][]) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "bastra-curator-run-"));
  const floorsPath = join(root, "floors.json");
  await writeFile(
    floorsPath,
    JSON.stringify([
      {
        memory_id: "floored",
        condition: "tok",
        reason: "active incident",
        floored_at: iso(60),
        last_affirmed: iso(60),
      },
    ]),
    "utf8",
  );
  await seedUsage(root);
  const demotionCalls: string[][] = [];
  const deps: CuratorRunDeps = {
    vaultRoot: root,
    vault: fakeVault(memories()),
    setDemotions: (ids) => demotionCalls.push([...ids]),
  };
  try {
    return await withEnv("BASTRA_FLOORS_PATH", floorsPath, () => fn(root, deps, demotionCalls));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// The observation window (30d of sidecar data) gates real demotions — the
// acting timeline therefore jumps 31 days past the first pass.
const T_ACT = NOW + 31 * 86_400_000;

test("dry-run: decides + writes REPORT.md but persists nothing and demotes nothing", async () => {
  await withFixture(async (root, deps, demotionCalls) => {
    const r = await runCuratorPass(deps, { force: true, dryRun: true, nowMs: NOW });
    assert.equal(r.ran, true);
    assert.equal(r.mode, "dry-run");
    // Window immature on a fresh vault → candidate is WATCHED, not demoted.
    assert.deepEqual(r.demoted, []);
    assert.deepEqual(r.pendingObservation, ["tax"], "context-tax memory is watched");
    assert.equal(r.reportWritten, true);
    assert.equal(demotionCalls.length, 0, "dry-run never touches the index");
    const state = await loadCuratorState(root);
    assert.deepEqual(state.stale, {}, "dry-run never persists state");
    assert.equal(state.last_run_at, undefined, "dry-run does not consume the interval");

    const report = await readFile(join(root, "REPORT.md"), "utf8");
    assert.ok(report.includes("[[tax]]"), "watched candidate in the report");
    assert.ok(report.includes("surfaced 5×"));
    assert.ok(report.includes("**Watching**"), "immature-window candidates are marked");
    assert.ok(report.includes("[[floored]]"), "floor review section lists the never-reaffirmed floor");
    assert.ok(report.includes("**never re-affirmed**"));
    assert.ok(report.includes("`css / grid`: [[tax]] · [[young]]"), "same-topic cluster");
    assert.ok(report.includes("[[used]] → `[[gone-target]]` (missing)"), "dangling wikilink");
  });
});

test("full lifecycle: review-first → observation window matures → acting → reactivation", async () => {
  await withFixture(async (root, deps, demotionCalls) => {
    // Pass 1 (non-dry, first ever): review-first — stamps observed_since,
    // demotes nothing.
    const r1 = await runCuratorPass(deps, { force: true, dryRun: false, nowMs: NOW });
    assert.equal(r1.mode, "review-first");
    assert.deepEqual(r1.demoted, []);
    assert.deepEqual(r1.pendingObservation, ["tax"], "candidate visible while watching");
    assert.equal(demotionCalls.length, 0, "first pass never touches the index");
    const state1 = await loadCuratorState(root);
    assert.deepEqual(state1.stale, {}, "first pass persists no demotions");
    assert.equal(state1.last_run_at, new Date(NOW).toISOString(), "but starts the interval clock");
    assert.equal(state1.observed_since, new Date(NOW).toISOString(), "and the observation epoch");

    // Keep "used" and (the no-longer-young) "young" engaged relative to the
    // acting pass so only "tax" demotes.
    await recordUsage(root, [
      { id: "used", kind: "acted_on", ts: new Date(T_ACT - 2 * 86_400_000).toISOString() },
      { id: "young", kind: "loaded", ts: new Date(T_ACT - 86_400_000).toISOString() },
    ]);

    // Pass 2, 31 days later: window mature → acting.
    const r2 = await runCuratorPass(deps, { force: true, dryRun: false, nowMs: T_ACT });
    assert.equal(r2.mode, "acting");
    assert.deepEqual(r2.demoted, ["tax"]);
    assert.deepEqual(demotionCalls.at(-1), ["tax"], "index got the demotion set");
    const state2 = await loadCuratorState(root);
    assert.ok(state2.stale["tax"]);
    const report2 = await readFile(join(root, "REPORT.md"), "utf8");
    assert.ok(!report2.includes("review pass"), "acting report drops the pending marker");

    // Pass 3, same inputs: idempotent.
    const r3 = await runCuratorPass(deps, { force: true, dryRun: false, nowMs: T_ACT + 1000 });
    assert.deepEqual(r3.demoted, []);
    assert.equal(r3.staleTotal, 1);

    // Engagement AFTER the demotion → reactivation on the next pass.
    await recordUsage(root, [{ id: "tax", kind: "loaded", ts: new Date(T_ACT + 2000).toISOString() }]);
    const r4 = await runCuratorPass(deps, { force: true, dryRun: false, nowMs: T_ACT + 3000 });
    assert.deepEqual(r4.reactivated, ["tax"]);
    assert.equal(r4.staleTotal, 0);
    assert.deepEqual(demotionCalls.at(-1), [], "index demotion set cleared");
  });
});

test("empty-files section: 0-byte .md files are reported, dotfolders ignored (real-vault find 2026-07-04)", async () => {
  await withFixture(async (root, deps) => {
    // The Obsidian artifact class: click on an unresolved doc-id wikilink
    // creates an empty note in the vault root.
    await writeFile(join(root, "doc-inbox-photo-x-jpg.md"), "", "utf8");
    await mkdir(join(root, ".obsidian"), { recursive: true });
    await writeFile(join(root, ".obsidian", "workspace.md"), "", "utf8");
    await mkdir(join(root, "memories"), { recursive: true });
    await writeFile(join(root, "memories", "empty-note.md"), "", "utf8");

    const r = await runCuratorPass(deps, { force: true, dryRun: true, nowMs: NOW });
    assert.equal(r.reportWritten, true);
    const report = await readFile(join(root, "REPORT.md"), "utf8");
    assert.ok(report.includes("`doc-inbox-photo-x-jpg.md`"), "root empty file listed");
    assert.ok(report.includes("`memories/empty-note.md`"), "nested empty file listed");
    assert.ok(!report.includes("workspace.md"), "dotfolder contents ignored");
    assert.ok(report.includes("safe to delete"));
  });
});

test("HTTP boundary: exception detail never reaches the response (CodeQL alert #23)", () => {
  const base = {
    ran: false as const,
    mode: "acting" as const,
    dryRun: false,
    demoted: [],
    reactivated: [],
    pendingObservation: [],
    staleTotal: 0,
    reportWritten: false,
  };
  const failed = sanitizeRunResultForHttp({ ...base, error: "ENOSPC: no space left on device, write '/Users/x/.bastra/x'" });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error, "curator run failed — see daemon log");
  assert.ok(!JSON.stringify(failed.body).includes("ENOSPC"), "no exception detail in the payload");
  const ok = sanitizeRunResultForHttp({ ...base, ran: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.error, undefined);
});

test("gate: un-forced run respects the 7d interval (skipped: interval)", async () => {
  await withFixture(async (root, deps) => {
    await runCuratorPass(deps, { force: true, dryRun: false, nowMs: NOW });
    const r = await runCuratorPass(deps, { nowMs: NOW + 86_400_000 }); // 1 day later
    assert.equal(r.ran, false);
    assert.equal(r.skipped, "interval");
  });
});

test("run without any usage data demotes nothing (zero usage ≠ stale)", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-curator-empty-"));
  const floorsPath = join(root, "floors.json");
  await writeFile(floorsPath, "[]", "utf8");
  try {
    await withEnv("BASTRA_FLOORS_PATH", floorsPath, async () => {
      const deps: CuratorRunDeps = { vaultRoot: root, vault: fakeVault(memories()), setDemotions: () => {} };
      const r = await runCuratorPass(deps, { force: true, dryRun: false, nowMs: NOW });
      assert.deepEqual(r.demoted, []);
      await stat(join(root, "REPORT.md")); // report still written (review surface)
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─── #217: Reflex-Promotion + Konsolidierung ────────────────────────────────

test("reflex promotion (#217): repeated acted_on recalls become candidates, cooldown suppresses re-nag", async () => {
  const vault = fakeVault([
    { id: "hot", title: "Hot memory", created: iso(60), topic_path: ["css"], related: [] },
    { id: "already-reflex", title: "Wired", created: iso(60), topic_path: ["css"], related: [], recall_mode: "reflex" },
    { id: "warm", title: "Warm memory", created: iso(60), topic_path: ["css"], related: [] },
  ]);
  const episode = (recallId: string, memoryId: string): TelemetryEvent[] => [
    { kind: "hook_recall", ts: iso(0), recall_id: recallId, query: "tailwind grid layout" },
    { kind: "recall_episode", ts: iso(0), recall_id: recallId, memory_id: memoryId, acted_on: true },
  ];
  const events: TelemetryEvent[] = [
    ...episode("r1", "hot"),
    ...episode("r2", "hot"),
    ...episode("r3", "hot"),
    ...episode("r4", "already-reflex"),
    ...episode("r5", "already-reflex"),
    ...episode("r6", "already-reflex"),
    ...episode("r7", "warm"),
    ...episode("r8", "warm"),
  ];

  const cands = await collectReflexCandidates(vault, { stale: {} }, NOW, events);
  assert.deepEqual(cands, [{ id: "hot", title: "Hot memory", count: 3 }],
    "3× acted_on → Kandidat; reflex-markiert und <3× nie");

  const cooled = await collectReflexCandidates(
    vault, { stale: {}, reflex_suggested: { hot: iso(5) } }, NOW, events,
  );
  assert.equal(cooled.length, 0, "innerhalb 30d nicht erneut vorschlagen");

  const matured = await collectReflexCandidates(
    vault, { stale: {}, reflex_suggested: { hot: iso(45) } }, NOW, events,
  );
  assert.equal(matured.length, 1, "nach Ablauf des Cooldowns wieder vorschlagbar");
});

function frustrationMemory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "frustration", title: "Stop repeating this", created: iso(60), related: [],
    write_origin: "user-directed", salience: 0.8, emotion: "frustration",
    ...overrides,
  };
}

test("reflex promotion (#1308): all frustration criteria are required, without telemetry", async () => {
  for (const salience of [0.8, 0.9, 1]) {
    const vault = fakeVault([frustrationMemory({ salience })]);
    const candidates = await collectReflexCandidates(vault, { stale: {} }, NOW, []);
    assert.deepEqual(candidates, [{
      id: "frustration", title: "Stop repeating this", count: 0, reason: "user-directed-frustration",
    }]);
    const block = formatReflexCandidateBlock(candidates[0]);
    assert.doesNotMatch(block,/Ask the user/);
    assert.ok(block.includes('<reflex-candidate memory-id="frustration" evidence="user-directed-frustration">'));
    assert.ok(block.includes("When authorized by the user's request: load_memory"));
    assert.ok(block.includes("Never promote without user authorization."));
    assert.equal(vault.get("frustration")?.fm.recall_mode, undefined);
  }
  const exclusions: Array<Record<string, unknown>> = [
    { write_origin: undefined }, { write_origin: "agent-inferred" },
    { salience: undefined }, { salience: 0.79 }, { salience: "0.9" }, { salience: NaN },
    { emotion: undefined }, { emotion: "success" }, { emotion: "neutral" }, { emotion: "risk" },
    { recall_mode: "reflex" }, { recall_mode: "deliberate" },
    { superseded_by: "replacement" }, { obsolete: true },
  ];
  for (const overrides of exclusions) {
    const candidates = await collectReflexCandidates(fakeVault([frustrationMemory(overrides)]), { stale: {} }, NOW, []);
    assert.deepEqual(candidates, [], `excluded: ${JSON.stringify(overrides)}`);
  }
});

test("reflex promotion (#1308): overlapping sources retain frustration reason and permanent dedup", async () => {
  const vault = fakeVault([frustrationMemory()]);
  const events: TelemetryEvent[] = [1, 2, 3].flatMap(n => [
    { kind: "hook_recall", ts: iso(0), recall_id: `fr-${n}`, query: "stop repeating" },
    { kind: "recall_episode", ts: iso(0), recall_id: `fr-${n}`, memory_id: "frustration", acted_on: true },
  ]);
  const candidates = await collectReflexCandidates(vault, { stale: {} }, NOW, events);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].reason, "user-directed-frustration");
  const deduped = await collectReflexCandidates(
    vault, { stale: {}, reflex_suggested: { frustration: iso(90) } }, NOW, events,
  );
  assert.deepEqual(deduped, [], "previous proposals never reappear through the telemetry source");
});

test("reflex promotion (#1308): proposals persist across curator passes without setting recall_mode", async () => {
  await withFixture(async (root, deps) => {
    deps.vault = fakeVault([frustrationMemory()]);
    const pendingPath = join(root, "pending.json");
    await withEnv("BASTRA_PENDING_SUGGESTIONS_PATH", pendingPath, async () => {
      await runCuratorPass(deps, { force: true, dryRun: true, nowMs: NOW });
      assert.deepEqual((await loadCuratorState(root)).reflex_suggested, undefined);
      await runCuratorPass(deps, { force: true, nowMs: NOW });
      assert.deepEqual((await loadCuratorState(root)).reflex_suggested, undefined, "review-first does not propose");
      const result = await runCuratorPass(deps, { force: true, nowMs: T_ACT });
      assert.equal(result.error, undefined);
      const rows = JSON.parse(await readFile(pendingPath, "utf8"));
      const blocks = rows.map((row: { blocks: string }) => row.blocks).join("\n");
      assert.equal((blocks.match(/<reflex-candidate /g) ?? []).length, 1);
      assert.ok(blocks.includes('evidence="user-directed-frustration"'));
      assert.ok(blocks.includes("Never promote without user authorization."));
      assert.equal((await loadCuratorState(root)).reflex_suggested?.frustration, new Date(T_ACT).toISOString());
      await rm(pendingPath);
      const again = await runCuratorPass(deps, { force: true, nowMs: T_ACT + 90 * 86_400_000 });
      assert.equal(again.error, undefined);
      await assert.rejects(readFile(pendingPath), { code: "ENOENT" });
      assert.equal(deps.vault.get("frustration")?.fm.recall_mode, undefined);
    });
  });
});

test("reflex promotion (#1308): disabled or failed relay can retry before permanent dedup", async () => {
  for (const failure of ["disabled", "write-error"]) {
    await withFixture(async (root, deps) => {
      deps.vault = fakeVault([frustrationMemory()]);
      const parent = join(root, "relay");
      const pendingPath = join(parent, "pending.json");
      await withEnv("BASTRA_PENDING_SUGGESTIONS_PATH", pendingPath, async () => {
        await runCuratorPass(deps, { force: true, nowMs: NOW });
        if (failure === "write-error") await writeFile(parent, "not a directory");
        await withEnv("BASTRA_PENDING_RELAY", failure === "disabled" ? "off" : "on", async () => {
          const result = await runCuratorPass(deps, { force: true, nowMs: T_ACT });
          assert.equal(result.error, undefined);
        });
        assert.equal((await loadCuratorState(root)).reflex_suggested?.frustration, undefined, failure);
        if (failure === "write-error") await rm(parent);
        await withEnv("BASTRA_PENDING_RELAY", "on", async () => {
          const result = await runCuratorPass(deps, { force: true, nowMs: T_ACT + 1000 });
          assert.equal(result.error, undefined);
          const rows = JSON.parse(await readFile(pendingPath, "utf8"));
          assert.equal(rows.length, 1);
          assert.match(rows[0].blocks, /user-directed-frustration/);
          const suggestedAt = (await loadCuratorState(root)).reflex_suggested?.frustration;
          assert.equal(suggestedAt, new Date(T_ACT + 1000).toISOString());
          await rm(pendingPath);
          await runCuratorPass(deps, { force: true, nowMs: T_ACT + 90 * 86_400_000 });
          assert.equal((await loadCuratorState(root)).reflex_suggested?.frustration, suggestedAt);
          await assert.rejects(readFile(pendingPath), { code: "ENOENT" });
          assert.equal(deps.vault.get("frustration")?.fm.recall_mode, undefined);
        });
      });
    });
  }
});

test("intake adoption (#217): repeatedly used imported memories become candidates, natives and cooldown excluded", async () => {
  const vault = fakeVault([
    { id: "intake-hot", title: "Imported hot", created: iso(60), topic_path: ["imported", "carnexus"], related: [] },
    { id: "native-hot", title: "Native hot", created: iso(60), topic_path: ["css"], related: [] },
  ]);
  const episode = (recallId: string, memoryId: string): TelemetryEvent[] => [
    { kind: "hook_recall", ts: iso(0), recall_id: recallId, query: "workshop module fields" },
    { kind: "recall_episode", ts: iso(0), recall_id: recallId, memory_id: memoryId, acted_on: true },
  ];
  const events: TelemetryEvent[] = [
    ...episode("a1", "intake-hot"),
    ...episode("a2", "intake-hot"),
    ...episode("a3", "native-hot"),
    ...episode("a4", "native-hot"),
    ...episode("a5", "native-hot"),
  ];

  const cands = await collectAdoptionCandidates(vault, { stale: {} }, NOW, events);
  assert.deepEqual(cands, [{ id: "intake-hot", title: "Imported hot", count: 2 }],
    "2× acted_on Intake → Kandidat; natives Memory nie (das ist Reflex-Territorium)");

  const cooled = await collectAdoptionCandidates(
    vault, { stale: {}, adoption_suggested: { "intake-hot": iso(5) } }, NOW, events,
  );
  assert.equal(cooled.length, 0, "innerhalb 30d nicht erneut vorschlagen");

  const matured = await collectAdoptionCandidates(
    vault, { stale: {}, adoption_suggested: { "intake-hot": iso(45) } }, NOW, events,
  );
  assert.equal(matured.length, 1, "nach Ablauf des Cooldowns wieder vorschlagbar");
});

test("consolidation (#217): ≥3 old same-topic project-facts cluster once, protected classes excluded", () => {
  const pf = (id: string, ageDays: number): Record<string, unknown> => ({
    id,
    title: `Episode ${id}`,
    type: "project-fact",
    scope: "bastra",
    topic_path: ["webui", "areas", "deep"],
    created: iso(ageDays),
    related: [],
  });
  const vault = fakeVault([
    pf("e1", 40),
    pf("e2", 50),
    pf("e3", 60),
    pf("young", 5), // zu jung → zählt nicht in den Cluster
    { ...pf("dict", 40), write_origin: "user-directed" }, // Schutzklasse
    { ...pf("other", 40), topic_path: ["cli"] }, // anderer Cluster-Key, allein
    { ...pf("lesson", 40), type: "lesson" }, // kein project-fact
  ]);

  const clusters = collectConsolidationCandidates(vault, { stale: {} }, NOW);
  assert.equal(clusters.length, 1);
  // Key ist "\0"-gejoint (kollisionssicher wie collectConflictsAndDangling),
  // label die menschenlesbare Form; topic_path wird auf 2 Ebenen gekappt.
  assert.equal(clusters[0].key, "bastra\u0000webui\u0000areas");
  assert.equal(clusters[0].label, "bastra / webui / areas");
  assert.deepEqual(clusters[0].ids, ["e1", "e2", "e3"]);

  const cooled = collectConsolidationCandidates(
    vault,
    { stale: {}, consolidation_suggested: { "bastra\u0000webui\u0000areas": iso(5) } },
    NOW,
  );
  assert.equal(cooled.length, 0, "Cluster-Cooldown verhindert Re-Nag");
});

test("demand gaps (#140): repeated empty recalls from the log land in REPORT.md; telemetry off is unavailable, not none", async () => {
  await withFixture(async (root, deps) => {
    const logs = join(root, "logs");
    await mkdir(logs, { recursive: true });
    // readEventLog windows on the wall clock, so the rows are stamped now.
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const rows = [
      { kind: "recall", ts: day(2), recall_id: "g1", query: "where is the boiler manual", hit_count: 0, hits: [] },
      { kind: "recall", ts: day(1), recall_id: "g2", query: "where is the boiler manual", hit_count: 1, weak_result: true, hits: [] },
    ];
    await writeFile(join(logs, `events-${day(0).slice(0, 10)}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    await withEnv("BASTRA_LOG_PATH", logs, async () => {
      await runCuratorPass(deps, { force: true, dryRun: true, nowMs: NOW });
      const report = await readFile(join(root, "REPORT.md"), "utf8");
      assert.ok(report.includes("- `where is the boiler manual` · 2 occasions"), "gap row listed");
      await withEnv("BASTRA_TELEMETRY", "off", async () => {
        await runCuratorPass(deps, { force: true, dryRun: true, nowMs: NOW });
        const off = await readFile(join(root, "REPORT.md"), "utf8");
        assert.ok(off.includes("<!-- bastra-report:demand-gaps -->"));
        assert.ok(off.includes("Not available"), "telemetry off never reads as an empty list");
      });
    });
  });
});

test("demand gaps: unreadable log directories are unavailable; readable empty logs are none", async () => {
  await withFixture(async (root, deps) => {
    const logs = join(root, "log-dir");
    // ENOTDIR is deterministic even when a privileged runner can read chmod(0).
    await writeFile(logs, "not a directory");
    assert.deepEqual(await readEventLog(logs, 30), [], "legacy callers keep their tolerant default");
    await assert.rejects(readEventLog(logs, 30, { strict: true }));
    await withEnv("BASTRA_TELEMETRY", "on", () => withEnv("BASTRA_LOG_PATH", logs, async () => {
      await runCuratorPass(deps, { force: true, dryRun: true, nowMs: NOW });
      let report = await readFile(join(root, "REPORT.md"), "utf8");
      assert.ok(report.includes("Not available"));
      assert.ok(!report.includes("None. No question"));
      await rm(logs);
      await mkdir(logs);
      await runCuratorPass(deps, { force: true, dryRun: true, nowMs: NOW });
      report = await readFile(join(root, "REPORT.md"), "utf8");
      assert.ok(report.includes("None. No question"));
    }));
  });
});
