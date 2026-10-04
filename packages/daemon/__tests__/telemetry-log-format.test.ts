/**
 * #1039: the event log and the join-state snapshot are byte-identical across
 * the split of `telemetry.ts` into collaborators.
 *
 * The JSONL log is an input (`bastra logs --stats`, `bastra bridges mint`), so
 * the key ORDER of every row is part of its contract, not just the fields. This
 * drives every writer of `Telemetry` once, in a fixed sequence, under a frozen
 * clock, and compares the resulting lines verbatim against the output the
 * unsplit class produced. Only the per-run random ids (boot id, turn ids) are
 * replaced by placeholders before the comparison.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/telemetry-log-format.test.ts
 */
import { test, mock } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Telemetry } from "../src/telemetry.js";

type Arg<K extends keyof Telemetry> = Telemetry[K] extends (p: infer P, ...rest: never[]) => unknown ? P : never;

const NOW = Date.parse("2026-10-04T12:00:00.000Z");

/** The sequence: every event writer once, plus the join paths that write. */
async function drive(t: Telemetry): Promise<string[]> {
  const turnA = t.rotateTurn("sess-a");
  const turnB = t.rotateTurn("sess-b");
  t.ensureTurn("sess-b", 7);
  const turnB2 = t.rotateTurn("sess-b");
  t.recordHookHints("rec-1", [{ id: "m1", score: 120 }, { id: "m2", score: 40 }, { id: "m3" }]);
  t.recordSurfacedHints([{ memory_id: "m4", distinctive_tokens: ["zebra", "quartz"] }], "sess-a");
  t.recordLoadedMemory({
    memory_id: "m1",
    distinctive_tokens: ["alpha", "beta", "gamma"],
    hook_hint: t.findHookHintFor("m1"),
    session_id: "sess-b",
  });

  await t.logRecall({
    recall_id: "rec-2", query: "how to deploy", k: 5, scope: null, type: null,
    vault_size: 10, hit_count: 1, top_score: 88, hits: [{ id: "m1", score: 88, type: "lesson" }],
    latency_ms: 12, session_id: "sess-a", client: "claude-code",
  } as Arg<"logRecall">);
  await t.logLoadMemory({ id: "m1", found: true, follows_recall: "rec-2", from_hook_recall: null, hook_hint_rank: null } as Arg<"logLoadMemory">);
  await t.logReadDocument({ id: "d1", found: true, delivered_chars: 10 } as Arg<"logReadDocument">);
  await t.logSaveMemory({
    id: "m9", type: "lesson", scope: "s", title: "T", tag_count: 1, recall_when_count: 2,
    body_chars: 30, overwrite: false, created: true, follows_recall: null,
  } as Arg<"logSaveMemory">);
  await t.logSaveHold({ reason: "duplicate", id: "m9", type: "lesson", scope: "s", claimed_count: 1, overwrite: false, follows_recall: null } as unknown as Arg<"logSaveHold">);
  await t.logIdScan({ id: "m9", op: "save", ms: 3, files: 4, bytes: 5, dirs: 1, blind_spots: 0, cloud_mount: false } as Arg<"logIdScan">);
  await t.logHookRecall({
    recall_id: "rec-3", query: "fix the build", hits: [{ id: "m2", score: 40 }],
    session_id: "sess-b", hook_source: "prompt", client: "claude-code",
  } as Arg<"logHookRecall">);
  await t.logHookRecall({ recall_id: "rec-4", query: "no session", hits: [] } as unknown as Arg<"logHookRecall">);
  await t.logEvidenceDecision({
    recall_id: "rec-3", shadow: true, degraded: false, decisions: [],
    counts: { required: 0, optional: 1, no_answer: 0 }, session_id: "sess-b", hook_source: "prompt",
  } as Arg<"logEvidenceDecision">);
  await t.logHookReflex({ session_id: "sess-a", reflex: "x" } as unknown as Arg<"logHookReflex">);
  await t.logHookAct({ session_id: "sess-a", tool_name: "Bash", hook_source: "bash-pre" } as unknown as Arg<"logHookAct">);
  await t.logMutationIncident({ operation_id: "op-1", op: "save", status: "failed", phase: "write", memory_id: null, rollback: null, detail: null } as Arg<"logMutationIncident">);
  await t.logCodeToolCall({ tool: "find_code", ms: 4 } as unknown as Arg<"logCodeToolCall">);
  await t.logCodeGraphRefresh({ outcome: "started" } as unknown as Arg<"logCodeGraphRefresh">);
  await t.logOllamaLifecycle({ action: "prewarm" } as unknown as Arg<"logOllamaLifecycle">);
  await t.logWarmupSettle({ session_start_call_id: "c1" } as unknown as Arg<"logWarmupSettle">);
  await t.logVectorLateSettle({ recall_id: "rec-3", session_id: "sess-b", hook_source: "prompt" } as unknown as Arg<"logVectorLateSettle">);
  await t.logVectorLateSettle({ recall_id: "rec-4" } as unknown as Arg<"logVectorLateSettle">);

  // The act path: one recall_episode (load in sess-b) and the shadow row for
  // the injected hint in sess-a.
  const episodes = t.matchLoadedMemories({ tool_name: "Edit", tool_input_excerpt: "alpha beta", session_id: "sess-b" });
  for (const e of episodes) await t.logRecallEpisode(e);
  t.matchLoadedMemories({ tool_name: "Bash", tool_input_excerpt: "zebra quartz", session_id: "sess-a" });
  // The shadow write is fire-and-forget; let it land.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  // Two windows left open, so the snapshot carries its Set → array shape.
  t.recordLoadedMemory({ memory_id: "m2", distinctive_tokens: ["delta", "epsilon"], hook_hint: null, session_id: "sess-a" });
  t.recordSurfacedHints([{ memory_id: "m5", distinctive_tokens: ["omega"] }], "sess-b");

  return [t.runId(), turnA, turnB, turnB2].filter((x): x is string => typeof x === "string");
}

function normalize(text: string, ids: string[]): string {
  const [run, ...turns] = ids;
  let out = text.split(run!).join("<run>");
  turns.forEach((id, i) => {
    out = out.split(id).join(`<turn-${i + 1}>`);
  });
  return out;
}

test("event log and join-state snapshot keep their byte format (#1039)", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-telemetry-format-"));
  mock.timers.enable({ apis: ["Date"], now: NOW });
  try {
    const t = new Telemetry({ logDir });
    assert.ok(t.isEnabled());
    const ids = await drive(t);
    await t.flushNow();
    const files = (await readdir(logDir)).sort();
    assert.deepEqual(files, ["events-2026-10-04.jsonl", "join-state.json"]);
    const log = normalize(await readFile(join(logDir, files[0]!), "utf8"), ids);
    const joinState = normalize(await readFile(join(logDir, files[1]!), "utf8"), ids);
    assert.deepEqual(log.split("\n"), EXPECTED_LOG);
    assert.equal(joinState, EXPECTED_JOIN_STATE);
  } finally {
    mock.timers.reset();
    await rm(logDir, { recursive: true, force: true });
  }
});

const EXPECTED_LOG: string[] = [
  '{"kind":"recall","ts":"2026-10-04T12:00:00.000Z","session_id":"<run>","recall_id":"rec-2","query":"how to deploy","k":5,"scope":null,"type":null,"vault_size":10,"hit_count":1,"top_score":88,"hits":[{"id":"m1","score":88,"type":"lesson"}],"latency_ms":12,"origin":"agent","dimensions":{"client":"claude-code","hook_source":"unknown","experiment_session":"e808f6286c95f856","arm":"unassigned"}}',
  '{"kind":"load_memory","ts":"2026-10-04T12:00:00.000Z","session_id":"<run>","id":"m1","found":true,"follows_recall":"rec-2","from_hook_recall":null,"hook_hint_rank":null}',
  '{"kind":"read_document","ts":"2026-10-04T12:00:00.000Z","session_id":"<run>","id":"d1","found":true,"delivered_chars":10}',
  '{"kind":"save_memory","ts":"2026-10-04T12:00:00.000Z","session_id":"<run>","id":"m9","type":"lesson","scope":"s","title":"T","tag_count":1,"recall_when_count":2,"body_chars":30,"overwrite":false,"created":true,"follows_recall":null}',
  '{"kind":"save_hold","ts":"2026-10-04T12:00:00.000Z","session_id":"<run>","reason":"duplicate","id":"m9","type":"lesson","scope":"s","claimed_count":1,"overwrite":false,"follows_recall":null}',
  '{"kind":"id_scan","ts":"2026-10-04T12:00:00.000Z","session_id":"<run>","id":"m9","op":"save","ms":3,"files":4,"bytes":5,"dirs":1,"blind_spots":0,"cloud_mount":false}',
  '{"kind":"hook_recall","ts":"2026-10-04T12:00:00.000Z","session_id":"sess-b","recall_id":"rec-3","query":"fix the build","hits":[{"id":"m2","score":40}],"origin":"owner","turn_id":"<turn-3>","turn_source":"session","dimensions":{"client":"claude-code","hook_source":"prompt","experiment_session":"5168f725717aee47","arm":"unassigned"}}',
  '{"kind":"hook_recall","ts":"2026-10-04T12:00:00.000Z","session_id":"<run>","recall_id":"rec-4","query":"no session","hits":[],"turn_id":"<turn-3>","turn_source":"inferred","dimensions":{"client":"unknown","hook_source":"unknown","experiment_session":null,"arm":"unassigned"}}',
  '{"kind":"evidence_decision","ts":"2026-10-04T12:00:00.000Z","session_id":"sess-b","recall_id":"rec-3","shadow":true,"degraded":false,"decisions":[],"counts":{"required":0,"optional":1,"no_answer":0},"dimensions":{"client":"unknown","hook_source":"prompt","experiment_session":"5168f725717aee47","arm":"unassigned"}}',
  '{"kind":"hook_reflex","ts":"2026-10-04T12:00:00.000Z","session_id":"sess-a","reflex":"x"}',
  '{"kind":"hook_act","ts":"2026-10-04T12:00:00.000Z","session_id":"sess-a","tool_name":"Bash","dimensions":{"client":"unknown","hook_source":"bash-pre","experiment_session":"e808f6286c95f856","arm":"unassigned"}}',
  '{"kind":"mutation_incident","ts":"2026-10-04T12:00:00.000Z","session_id":"<run>","operation_id":"op-1","op":"save","status":"failed","phase":"write","memory_id":null,"rollback":null,"detail":null}',
  '{"kind":"code_tool_call","ts":"2026-10-04T12:00:00.000Z","session_id":"<run>","tool":"find_code","ms":4}',
  '{"kind":"code_graph_refresh","ts":"2026-10-04T12:00:00.000Z","session_id":"<run>","outcome":"started"}',
  '{"kind":"ollama_lifecycle","ts":"2026-10-04T12:00:00.000Z","session_id":null,"run_id":"<run>","action":"prewarm"}',
  '{"kind":"warmup_settle","ts":"2026-10-04T12:00:00.000Z","session_id":null,"run_id":"<run>","session_start_call_id":"c1"}',
  '{"kind":"vector_late_settle","ts":"2026-10-04T12:00:00.000Z","session_id":"sess-b","late":true,"recall_id":"rec-3","dimensions":{"client":"unknown","hook_source":"prompt","experiment_session":"5168f725717aee47","arm":"unassigned"}}',
  '{"kind":"vector_late_settle","ts":"2026-10-04T12:00:00.000Z","session_id":"<run>","late":true,"recall_id":"rec-4","dimensions":{"client":"unknown","hook_source":"unknown","experiment_session":null,"arm":"unassigned"}}',
  '{"kind":"recall_episode","ts":"2026-10-04T12:00:00.000Z","session_id":"<run>","turn_id":"<turn-3>","turn_source":"session","recall_id":"rec-1","memory_id":"m1","surfaced_score":120,"band":"required","surfaced":true,"acted_on":true,"match_strength":2,"tool_name":"Edit"}',
  '{"kind":"hint_followed_shadow","ts":"2026-10-04T12:00:00.000Z","session_id":"<run>","memory_id":"m4","turn_id":"<turn-1>","turn_source":"session","followed":true,"match_strength":2,"tool_name":"Bash","age_ms":0}',
  '',
];

// The debounced join-state snapshot, flushed by `flushNow`.
const EXPECTED_JOIN_STATE = "{\"version\":1,\"lastRecall\":null,\"hookHints\":[[\"m1\",{\"recall_id\":\"rec-1\",\"rank\":1,\"score\":120,\"ts\":1791115200000}],[\"m2\",{\"recall_id\":\"rec-1\",\"rank\":2,\"score\":40,\"ts\":1791115200000}],[\"m3\",{\"recall_id\":\"rec-1\",\"rank\":3,\"score\":null,\"ts\":1791115200000}]],\"turns\":[[\"sess-a\",{\"turn_id\":\"<turn-1>\",\"session_id\":\"sess-a\",\"started_at\":1791115200000}],[\"sess-b\",{\"turn_id\":\"<turn-3>\",\"session_id\":\"sess-b\",\"started_at\":1791115200000}]],\"latestTurn\":{\"turn_id\":\"<turn-3>\",\"session_id\":\"sess-b\",\"started_at\":1791115200000},\"adoptedTurnKeys\":[[\"sess-b\",7]],\"loadedMemories\":[{\"memory_id\":\"m2\",\"distinctive_tokens\":[\"delta\",\"epsilon\"],\"turn_id\":\"<turn-1>\",\"turn_source\":\"session\",\"recall_id\":null,\"surfaced_score\":null,\"band\":\"not_hinted\",\"surfaced\":false,\"ts\":1791115200000,\"closed\":false},{\"memory_id\":\"m5\",\"distinctive_tokens\":[\"omega\"],\"turn_id\":\"<turn-3>\",\"turn_source\":\"session\",\"recall_id\":null,\"surfaced_score\":null,\"band\":\"not_hinted\",\"surfaced\":true,\"ts\":1791115200000,\"closed\":false,\"hint_only\":true,\"hint_session_id\":\"sess-b\"}]}";
