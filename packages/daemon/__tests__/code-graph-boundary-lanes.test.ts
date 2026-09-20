/**
 * #572 end to end: the three REAL lanes, in the order a session runs them —
 * write lane (PreToolUse) → the edit lands on disk → Stop lane → prompt lane.
 *
 * The unit file next door proves each piece. This one proves the pieces are
 * connected: nothing here calls `boundaryImpact`, `recordTouched` or
 * `parkBoundary` directly; if a lane stops calling them, this goes red and
 * that file stays green.
 *
 * REVERT-CHECK, each done once by hand:
 *   - drop the `parkBoundaryNote` call in `stop-lane.ts` → the delivery cases.
 *   - drop the `recordTouched` deltas in `write-lane.ts` → the delivery cases.
 *   - drop the `takeParkedBoundary` branch in the trivial gate of
 *     `prompt-lane.ts` → "delivers on a trivial prompt".
 *   - book on a repository that is not enabled → "books nothing where code
 *     awareness is off".
 *   - drop the `getPromptImpactEnabled` gate at the top of `parkBoundaryNote`
 *     → "parks nothing and leaves the session-state file untouched while the
 *     opt-in is off".
 */
import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME first: `settingsFilePath()` and the pending file resolve under it, and
// this test enables a repository — that must not land in the developer's own
// ~/.bastra. Set before any module that reads it is imported.
const home = await mkdtemp(join(tmpdir(), "bastra-boundary-home-"));
process.env.HOME = home;
process.env.BASTRA_HOOK_STATE_DIR = join(home, "hook-state");
process.env.BASTRA_PENDING_SUGGESTIONS_PATH = join(home, "pending.json");
process.env.BASTRA_TELEMETRY = "off";
// #607: the prompt lane's delivery is opt-in and OFF by default, boundary block
// included. Every case below is about what the lane does once it is switched
// on; the one case about the default switches it back off itself.
process.env.BASTRA_PROMPT_IMPACT = "on";

const { runWriteLane } = await import("../src/write-lane.js");
const { runStopLane } = await import("../src/stop-lane.js");
const { runPromptLane } = await import("../src/prompt-lane.js");
const { loadSessionState } = await import("../src/session-state.js");
const { setRepoEnabled } = await import("../src/code-graph/enabled-repos.js");
const { codeGraphCache } = await import("../src/code-graph/dependents-block.js");
const { graphDirOf, GRAPH_FILE_NAME } = await import("../src/code-graph/reader.js");

function node(id: string, label: string, file: string, line = 1) {
  return {
    id,
    label,
    file_type: "code",
    source_file: file,
    source_location: `L${line}`,
    community: 0,
    _origin: "ast",
  };
}
function edge(source: string, target: string, relation: string) {
  return { source, target, relation, confidence: "EXTRACTED", confidence_score: 0.9, _origin: "ast" };
}
function graphJson(nodes: unknown[], links: unknown[]) {
  return {
    directed: true,
    multigraph: false,
    graph: {},
    built_at_commit: "0000000000000000000000000000000000000000",
    nodes,
    links,
    hyperedges: [],
  };
}

const SAVE_BEFORE = `export function saveMemory(input: string): string {
  return input.trim();
}
`;
const SAVE_AFTER = `export function persist(input: string): string {
  return input.trim();
}
`;

const BEFORE = graphJson(
  [
    node("save_fn", "saveMemory()", "src/save.ts", 1),
    node("audit_fn", "auditSave()", "src/audit.ts", 1),
    node("report_fn", "buildReport()", "src/report.ts", 1),
    node("notify_fn", "notifySave()", "src/notify.ts", 1),
  ],
  // Three callers: the volume gate (MIN_BOUNDARY_MISSED_FILES) renders from
  // three unopened files up, so a two-caller fixture would prove the lanes are
  // connected by going silent for the wrong reason.
  [
    edge("audit_fn", "save_fn", "calls"),
    edge("report_fn", "save_fn", "calls"),
    edge("notify_fn", "save_fn", "calls"),
  ],
);
// What the watcher's reindex leaves: `saveMemory` is gone, and so is every
// edge that pointed at it.
const AFTER = graphJson(
  [
    node("persist_fn", "persist()", "src/save.ts", 1),
    node("audit_fn", "auditSave()", "src/audit.ts", 1),
    node("report_fn", "buildReport()", "src/report.ts", 1),
    node("notify_fn", "notifySave()", "src/notify.ts", 1),
  ],
  [],
);

let daemon: { url: string; close: () => Promise<void> };

before(async () => {
  // Every lane calls back into the daemon for recall; an empty answer is all
  // this test needs from it.
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hits: [], clusters: [], vault_size: 0, latency_ms: 1, recall_id: "t" }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  daemon = {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
});

after(async () => {
  await daemon.close();
  await rm(home, { recursive: true, force: true });
});

async function freshRepo(name: string, enabled: boolean): Promise<string> {
  const repo = join(home, "repos", name);
  const files: Array<[string, string]> = [
    ["package.json", JSON.stringify({ name })],
    ["src/save.ts", SAVE_BEFORE],
    ["src/audit.ts", 'import { saveMemory } from "./save.js";\nexport function auditSave() { saveMemory(""); }\n'],
    ["src/report.ts", 'import { saveMemory } from "./save.js";\nexport function buildReport() { saveMemory(""); }\n'],
    ["src/notify.ts", 'import { saveMemory } from "./save.js";\nexport function notifySave() { saveMemory(""); }\n'],
  ];
  for (const [path, body] of files) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), body, "utf8");
  }
  // Source files predate the session by a wide margin, so "never written" is
  // unambiguous against the disk-confirmation slack.
  const past = new Date(Date.now() - 3_600_000);
  for (const [path] of files) await utimes(join(repo, path), past, past);
  await mkdir(graphDirOf(repo), { recursive: true });
  await writeFile(join(graphDirOf(repo), GRAPH_FILE_NAME), JSON.stringify(BEFORE), "utf8");
  if (enabled) {
    await setRepoEnabled(repo, true);
    await codeGraphCache().ensureLoaded(repo);
    assert.notEqual(codeGraphCache().get(repo), null, "fixture graph did not load");
  }
  return repo;
}

/** The PreToolUse call for the edit that removes `saveMemory`. */
async function announceEdit(repo: string, sessionId: string): Promise<void> {
  await runWriteLane(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      session_id: sessionId,
      cwd: repo,
      tool_input: {
        file_path: join(repo, "src/save.ts"),
        old_string: "export function saveMemory(",
        new_string: "export function persist(",
      },
    },
    daemon.url,
  );
}

/** The tool runs, and then the watcher reindexes — the graph forgets. */
async function landEditAndReindex(repo: string): Promise<void> {
  await writeFile(join(repo, "src/save.ts"), SAVE_AFTER, "utf8");
  await writeFile(join(graphDirOf(repo), GRAPH_FILE_NAME), JSON.stringify(AFTER), "utf8");
  await codeGraphCache().reloadIfChanged(repo);
}

async function stop(repo: string, sessionId: string, transcript: unknown[] = []): Promise<string> {
  return runStopLane(
    { hook_event_name: "Stop", session_id: sessionId, cwd: repo, transcript },
    daemon.url,
  );
}

async function prompt(repo: string, sessionId: string, text: string): Promise<string> {
  const stdout = await runPromptLane(
    { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: repo, prompt: text },
    null,
    daemon.url,
  );
  return (
    (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext ?? ""
  );
}

test("delivers on a trivial prompt, names the callers the reindexed graph forgot, and only once", async () => {
  const repo = await freshRepo("deliver", true);
  const id = "lanes-deliver";

  await announceEdit(repo, id);
  await landEditAndReindex(repo);
  // Invariant: the Stop lane's stdout stays `{}` (#48) — the block is parked.
  assert.equal(await stop(repo, id), "{}");

  const first = await prompt(repo, id, "ok");
  assert.match(first, /task boundary/);
  assert.match(first, /src\/audit\.ts:1 — calls saveMemory \(src\/save\.ts\)/);
  assert.match(first, /src\/report\.ts:1 — calls saveMemory/);
  assert.match(first, /src\/notify\.ts:1 — calls saveMemory/);

  // Same session, nothing new: a second Stop re-computes the same answer and
  // the dedupe holds it back.
  assert.equal(await stop(repo, id), "{}");
  assert.doesNotMatch(await prompt(repo, id, "ok"), /task boundary/);
});

test("stays silent for an edit the tool never carried out", async () => {
  const repo = await freshRepo("denied", true);
  const id = "lanes-denied";

  await announceEdit(repo, id);
  // Permission denied: nothing lands on disk, the file keeps its old mtime.
  await stop(repo, id);

  assert.doesNotMatch(await prompt(repo, id, "ok"), /task boundary/);
});

test("withdraws the parked block once the task opened what it had missed", async () => {
  const repo = await freshRepo("withdraw", true);
  const id = "lanes-withdraw";

  await announceEdit(repo, id);
  await landEditAndReindex(repo);
  await stop(repo, id);
  assert.notEqual((await loadSessionState(id)).boundary, undefined, "nothing was parked");

  // The agent goes on WITHOUT a user prompt in between: writes one dependent,
  // reads the other. The next Stop must take the stale block back.
  await runWriteLane(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      session_id: id,
      cwd: repo,
      tool_input: { file_path: join(repo, "src/audit.ts"), content: "export function auditSave() {}\n" },
    },
    daemon.url,
  );
  await writeFile(join(repo, "src/audit.ts"), "export function auditSave() {}\n", "utf8");
  const readRow = {
    timestamp: new Date(Date.now() + 1_000).toISOString(),
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Read", input: { file_path: join(repo, "src/report.ts") } },
        { type: "tool_use", name: "Read", input: { file_path: join(repo, "src/notify.ts") } },
      ],
    },
  };
  await stop(repo, id, [readRow]);

  assert.equal((await loadSessionState(id)).boundary, undefined);
  assert.doesNotMatch(await prompt(repo, id, "ok"), /task boundary/);
});

test("books nothing where code awareness is off", async () => {
  const repo = await freshRepo("off", false);
  const id = "lanes-off";

  await announceEdit(repo, id);
  await landEditAndReindex(repo);
  await stop(repo, id);

  assert.equal((await loadSessionState(id)).touched, undefined);
  assert.doesNotMatch(await prompt(repo, id, "ok"), /task boundary/);
});

test("hands nothing over while the prompt lane's opt-in is off", async () => {
  // #607: same lane, same switch (`promptImpact.enabled` / BASTRA_PROMPT_IMPACT,
  // default off). Revert-check: drop the gate in `prompt-lane.ts` and this goes
  // red on the first assertion.
  const repo = await freshRepo("optin", true);
  const id = "lanes-optin";

  await announceEdit(repo, id);
  await landEditAndReindex(repo);
  await stop(repo, id);

  process.env.BASTRA_PROMPT_IMPACT = "off";
  try {
    assert.doesNotMatch(await prompt(repo, id, "ok"), /task boundary/);
    assert.doesNotMatch(await prompt(repo, id, "what changed in the save path?"), /task boundary/);
    // Not consumed either: the block is still parked for a session that turns
    // the lane on.
    assert.notEqual((await loadSessionState(id)).boundary, undefined);
  } finally {
    process.env.BASTRA_PROMPT_IMPACT = "on";
  }

  assert.match(await prompt(repo, id, "ok"), /task boundary/);
});

test("parks nothing and leaves the session-state file untouched while the opt-in is off", async () => {
  // #607: `parkBoundaryNote` (stop-lane.ts) is gated behind the SAME switch as
  // delivery now, checked BEFORE `loadSessionState` — computing the block
  // means a `stat` per booked file on every Stop, work with nobody left to
  // read it while the lane cannot deliver it either. Revert-check: drop the
  // gate at the top of `parkBoundaryNote` and this goes red — the state file
  // the write lane already wrote gets a new mtime it should not have.
  const repo = await freshRepo("parkoff", true);
  const id = "lanes-parkoff";

  await announceEdit(repo, id);
  await landEditAndReindex(repo);
  const stateFile = join(home, "hook-state", `${id}.json`);
  const before = await stat(stateFile);

  process.env.BASTRA_PROMPT_IMPACT = "off";
  try {
    assert.equal(await stop(repo, id), "{}");
  } finally {
    process.env.BASTRA_PROMPT_IMPACT = "on";
  }

  const after = await stat(stateFile);
  assert.equal(after.mtimeMs, before.mtimeMs, "Stop rewrote the state file although the opt-in is off");
  assert.equal((await loadSessionState(id)).boundary, undefined);
});

test("books with the opt-in off, parks at the next Stop once it is switched on", async () => {
  // The booking (`recordTouched`, write-lane.ts) is deliberately NOT gated —
  // only the Stop-side computation is (`parkBoundaryNote`'s own comment says
  // why). A switch flipped ON mid-session must still find something to park.
  const repo = await freshRepo("parklate", true);
  const id = "lanes-parklate";

  process.env.BASTRA_PROMPT_IMPACT = "off";
  try {
    await announceEdit(repo, id);
    await landEditAndReindex(repo);
    assert.equal(await stop(repo, id), "{}");
    assert.equal((await loadSessionState(id)).boundary, undefined);
  } finally {
    process.env.BASTRA_PROMPT_IMPACT = "on";
  }

  assert.equal(await stop(repo, id), "{}");
  assert.notEqual((await loadSessionState(id)).boundary, undefined, "the surviving booking never got parked");
  assert.match(await prompt(repo, id, "ok"), /task boundary/);
});

test("writes one delivered-block row for the block it hands over", async () => {
  // #579 measures this delivery the same way it measures the other two: one
  // `code_tool_call` row with `surface: "delivered"`. Revert-check: drop the
  // `logBoundaryDelivery` call and this goes red.
  const repo = await freshRepo("telemetry", true);
  const id = "lanes-telemetry";
  const logDir = join(home, "telemetry-rows");
  process.env.BASTRA_LOG_PATH = logDir;
  process.env.BASTRA_TELEMETRY = "on";
  try {
    await announceEdit(repo, id);
    await landEditAndReindex(repo);
    await stop(repo, id);
    assert.match(await prompt(repo, id, "ok"), /task boundary/);
    // The row is fire-and-forget; give the append a turn of the loop.
    await new Promise((done) => setTimeout(done, 50));

    const day = new Date().toISOString().slice(0, 10);
    const rows = (await readFile(join(logDir, `events-${day}.jsonl`), "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.surface === "delivered" && r.delivered_lane === "boundary");

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "code_tool_call");
    assert.equal(rows[0]!.status, "ok");
    assert.equal(rows[0]!.files, 3);
    assert.equal(rows[0]!.session_id, id);
    assert.ok((rows[0]!.tokens_est as number) > 0);
  } finally {
    process.env.BASTRA_TELEMETRY = "off";
    delete process.env.BASTRA_LOG_PATH;
  }
});
