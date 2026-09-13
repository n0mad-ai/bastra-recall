import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Telemetry } from "../src/telemetry.js";

// Der Telemetry-Konstruktor liest jetzt join-state.json (Boot-Restore). Jeder
// Test bekommt ein frisches, isoliertes Log-Dir, damit `new Telemetry()` nie
// fremden (echten Daemon-) State lädt und Tests sich nicht gegenseitig sehen.
let testDir: string;
beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "bastra-telemetry-"));
  process.env.BASTRA_LOG_PATH = testDir;
  process.env.BASTRA_TELEMETRY = "on";
});
afterEach(async () => {
  delete process.env.BASTRA_LOG_PATH;
  delete process.env.BASTRA_TELEMETRY;
  await rm(testDir, { recursive: true, force: true });
});

test("recall_episode closes a loaded memory with acted_on=true without logging raw tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-acted-on-"));
  const prevPath = process.env.BASTRA_LOG_PATH;
  const prevTelemetry = process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_LOG_PATH = dir;
  process.env.BASTRA_TELEMETRY = "on";

  try {
    const telemetry = new Telemetry();
    telemetry.rotateTurn("session-a");
    telemetry.recordLoadedMemory({
      memory_id: "mem-a",
      distinctive_tokens: ["secretbanana", "privateraisin", "thirdanchor"],
      hook_hint: { recall_id: "recall-a", score: 125 },
      session_id: "session-a",
    });

    const episodes = telemetry.matchLoadedMemories({
      tool_name: "Write",
      tool_input_excerpt: "Apply the secretbanana migration and preserve privateraisin semantics.",
      session_id: "session-a",
    });

    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].acted_on, true);
    assert.equal(episodes[0].match_strength, 2);
    assert.equal(episodes[0].band, "required");
    assert.equal(episodes[0].surfaced, true, "hint-preceded load must be surfaced (#77)");
    await telemetry.logRecallEpisode(episodes[0]);

    const today = new Date().toISOString().slice(0, 10);
    const raw = await readFile(join(dir, `events-${today}.jsonl`), "utf8");
    assert.match(raw, /"kind":"recall_episode"/);
    assert.doesNotMatch(raw, /secretbanana|privateraisin/);
  } finally {
    if (prevPath === undefined) delete process.env.BASTRA_LOG_PATH;
    else process.env.BASTRA_LOG_PATH = prevPath;
    if (prevTelemetry === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = prevTelemetry;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("recall_episode closes disjoint follow-up edits with acted_on=false", () => {
  const telemetry = new Telemetry();
  telemetry.rotateTurn("session-b");
  telemetry.recordLoadedMemory({
    memory_id: "mem-b",
    distinctive_tokens: ["quartzledger", "violetbridge"],
    hook_hint: { recall_id: "recall-b", score: 70 },
    session_id: "session-b",
  });

  const episodes = telemetry.matchLoadedMemories({
    tool_name: "Edit",
    tool_input_excerpt: "Change the button label and update unrelated copy.",
    session_id: "session-b",
  });

  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].acted_on, false);
  assert.equal(episodes[0].match_strength, 0);
  assert.equal(episodes[0].band, "optional");

  const second = telemetry.matchLoadedMemories({
    tool_name: "Edit",
    tool_input_excerpt: "quartzledger violetbridge",
    session_id: "session-b",
  });
  assert.equal(second.length, 0);
});

test("ensureTurn (#74): MCP loads join the real session turn; parallel sessions stay separate", () => {
  const telemetry = new Telemetry();
  telemetry.ensureTurn("sess-a", 1000);
  telemetry.ensureTurn("sess-b", 2000); // zweite parallele Session rotiert zuletzt

  telemetry.recordLoadedMemory({
    memory_id: "m-a",
    distinctive_tokens: ["alphatoken", "betatoken"],
    hook_hint: null,
    session_id: "sess-a",
  });

  // Die Load-Episode hängt am ECHTEN sess-a-Turn — ein Match aus sess-b darf
  // sie nicht einsammeln (vor #74 hätte latestTurn=sess-b sie geschluckt).
  const epB = telemetry.matchLoadedMemories({
    tool_name: "Edit",
    tool_input_excerpt: "alphatoken betatoken",
    session_id: "sess-b",
  });
  assert.equal(epB.length, 0, "foreign session must not consume the episode");

  const epA = telemetry.matchLoadedMemories({
    tool_name: "Edit",
    tool_input_excerpt: "alphatoken betatoken",
    session_id: "sess-a",
  });
  assert.equal(epA.length, 1);
  assert.equal(epA[0].turn_source, "session", "header-derived session key → real turn, not inferred");
  assert.equal(epA[0].acted_on, true);

  // Gleicher Turn-Key → keine Rotation: nächster Load landet im selben Turn.
  telemetry.ensureTurn("sess-a", 1000);
  telemetry.recordLoadedMemory({
    memory_id: "m-a2",
    distinctive_tokens: ["gammatoken", "deltatoken"],
    hook_hint: null,
    session_id: "sess-a",
  });
  const epA2 = telemetry.matchLoadedMemories({
    tool_name: "Edit",
    tool_input_excerpt: "gammatoken deltatoken",
    session_id: "sess-a",
  });
  assert.equal(epA2.length, 1);
  assert.equal(epA2[0].turn_id, epA[0].turn_id, "same turn key must not rotate the turn");

  // Neuer Turn-Key → frischer Turn.
  telemetry.ensureTurn("sess-a", 1001);
  telemetry.recordLoadedMemory({
    memory_id: "m-a3",
    distinctive_tokens: ["epsilontoken", "zetatoken"],
    hook_hint: null,
    session_id: "sess-a",
  });
  const epA3 = telemetry.matchLoadedMemories({
    tool_name: "Edit",
    tool_input_excerpt: "epsilontoken zetatoken",
    session_id: "sess-a",
  });
  assert.equal(epA3.length, 1);
  assert.notEqual(epA3[0].turn_id, epA[0].turn_id, "new turn key must rotate");
});

test("join-state persists across a daemon boot (Audit 26.6.)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-join-"));
  const prevPath = process.env.BASTRA_LOG_PATH;
  const prevTelemetry = process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_LOG_PATH = dir;
  process.env.BASTRA_TELEMETRY = "on";

  try {
    // Boot A: ein recall + ein Hook-Hint + ein geladenes Memory.
    const a = new Telemetry();
    const recallId = a.newRecallId();
    a.recordHookHints(recallId, [{ id: "mem-x", score: 140 }]);
    a.rotateTurn("sess-x");
    a.recordLoadedMemory({
      memory_id: "mem-x",
      distinctive_tokens: ["persistedalpha", "persistedbeta"],
      hook_hint: { recall_id: recallId, score: 140 },
      session_id: "sess-x",
    });
    await a.flushNow();

    // Boot B: frische Instanz, gleicher Log-Pfad = simulierter Idle-Respawn.
    const b = new Telemetry();
    assert.equal(b.recentRecallId(), recallId, "follows_recall must survive the boot");
    assert.equal(
      b.findHookHintFor("mem-x")?.recall_id,
      recallId,
      "from_hook_recall must survive the boot",
    );

    // recall_episode entsteht jetzt boot-übergreifend — das war der Wurzeldefekt.
    const episodes = b.matchLoadedMemories({
      tool_name: "Edit",
      tool_input_excerpt: "edit touching persistedalpha and persistedbeta",
      session_id: "sess-x",
    });
    assert.equal(episodes.length, 1, "loaded memory must survive the boot and still close");
    assert.equal(episodes[0].memory_id, "mem-x");
    assert.equal(episodes[0].acted_on, true);
  } finally {
    if (prevPath === undefined) delete process.env.BASTRA_LOG_PATH;
    else process.env.BASTRA_LOG_PATH = prevPath;
    if (prevTelemetry === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = prevTelemetry;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("join-state restore drops entries past their follow-up window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-join-ttl-"));
  const prevPath = process.env.BASTRA_LOG_PATH;
  const prevTelemetry = process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_LOG_PATH = dir;
  process.env.BASTRA_TELEMETRY = "on";

  try {
    const old = Date.now() - 60 * 60 * 1000; // 1h alt — weit jenseits aller Fenster
    await writeFile(
      join(dir, "join-state.json"),
      JSON.stringify({
        version: 1,
        lastRecall: { id: "stale-recall", ts: old },
        hookHints: [["mem-old", { recall_id: "stale", rank: 1, score: 100, ts: old }]],
        turns: [],
        latestTurn: null,
        adoptedTurnKeys: [],
        loadedMemories: [],
      }),
      "utf8",
    );

    const t = new Telemetry();
    assert.equal(t.recentRecallId(), null, "stale lastRecall must be dropped on restore");
    assert.equal(t.findHookHintFor("mem-old"), null, "stale hook hint must be dropped on restore");
  } finally {
    if (prevPath === undefined) delete process.env.BASTRA_LOG_PATH;
    else process.env.BASTRA_LOG_PATH = prevPath;
    if (prevTelemetry === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = prevTelemetry;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("recall_episode (#77): direct load without a hint is marked surfaced=false", () => {
  const telemetry = new Telemetry();
  telemetry.rotateTurn("session-c");
  telemetry.recordLoadedMemory({
    memory_id: "mem-c",
    distinctive_tokens: ["ambergranite", "copperthistle"],
    hook_hint: null, // direct load_memory, no preceding hook hint
    session_id: "session-c",
  });

  const episodes = telemetry.matchLoadedMemories({
    tool_name: "Edit",
    tool_input_excerpt: "ambergranite copperthistle refactor",
    session_id: "session-c",
  });

  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].surfaced, false, "no hint → must not count into any band quota");
  assert.equal(episodes[0].band, "not_hinted", "#469: no score, so no floor to be below");
  assert.equal(episodes[0].acted_on, true, "acted_on stays measurable for direct loads");
});
