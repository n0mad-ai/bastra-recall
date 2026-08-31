/**
 * #369: all seven Claude Code lanes on the compiled stub, and both registered
 * forms visible to doctor.
 *
 * Two failures this file pins:
 *
 *  1. Three lanes (session, todo, stop) had no stub subcommand because they had
 *     no daemon-side pipeline — they spawned a full node interpreter on every
 *     call, Stop at the end of every answer (~75ms measured, against ~25ms).
 *  2. `registeredHookBins` only ever recognised `node <bin>`. With four lanes
 *     already on the stub, `bastra doctor` reported `3/7 registered (missing
 *     required: hook.js, prompt-hook.js, bash-pre-hook.js, bash-fail-hook.js)`
 *     and called a healthy install BROKEN — verified against a real
 *     ~/.claude/settings.json. Moving the last three lanes over would have
 *     taken that to 0/7, so the detection is fixed here with them.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/hook-stub-lanes.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkHookPaths,
  missingRequiredHookRegistrations,
  planHookEntries,
  registeredHookBins,
  stubLaneCommandPath,
  stubSubcommandForFile,
} from "../src/cli/adapters/claude-code.js";
import { HOOK_STUB_BIN } from "../src/cli/paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_FILES = [
  "hook.js", "session-hook.js", "prompt-hook.js", "todo-hook.js",
  "bash-pre-hook.js", "bash-fail-hook.js", "stop-hook.js",
];

function commandsOf(entries: unknown[]): string[] {
  return entries.flatMap((e) => {
    const hooks = (e as { hooks?: unknown[] }).hooks ?? [];
    return hooks.map((h) => (h as { command?: string }).command ?? "");
  });
}

/** Every command a full install writes, across all six events. */
function allCommands(stubPresent: boolean): string[] {
  const plan = planHookEntries("install", {}, { includeStop: true, stubPresent });
  return Object.values(plan.after).flatMap((entries) => commandsOf(entries));
}

// ─── every lane is on the stub ───────────────────────────────────────────────

test("all seven lanes register across all eight hook entries when the binary is there", () => {
  const cmds = allCommands(true);
  assert.equal(cmds.length, 8, `expected eight hook entries, got ${cmds.length}`);
  for (const cmd of cmds) {
    assert.ok(cmd.startsWith(`${HOOK_STUB_BIN} `), `still on node: ${cmd}`);
  }
  const subs = cmds.map((c) => c.slice(HOOK_STUB_BIN.length + 1)).sort();
  assert.deepEqual(subs, ["bash-fail", "bash-fail", "bash-pre", "prompt", "session", "stop", "todo", "write"]);
});

test("without the binary every lane falls back to its node client", () => {
  const cmds = allCommands(false);
  assert.equal(cmds.length, 8);
  for (const cmd of cmds) assert.ok(cmd.startsWith("node /"), `not the node client: ${cmd}`);
});

test("the stub declares exactly the lanes registration hands it", async () => {
  // Drift guard: a subcommand written into settings.json that the binary does
  // not know answers `{}` forever — silently, on every call of that lane.
  const src = await readFile(join(HERE, "..", "stub", "bastra-hook.ts"), "utf8");
  const decl = /const LANES = new Set<Lane>\(\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(decl, "could not find the LANES declaration in stub/bastra-hook.ts");
  const declared = [...decl[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort();
  const registered = [...new Set(allCommands(true).map((c) => c.slice(HOOK_STUB_BIN.length + 1)))].sort();
  assert.deepEqual(declared, registered);
});

test("doctor-level registration check requires PostToolUseFailure:Bash", () => {
  const current = stubSettings();
  assert.deepEqual(missingRequiredHookRegistrations(current), []);

  const legacy = { ...current };
  delete legacy.PostToolUseFailure;
  assert.deepEqual(missingRequiredHookRegistrations(legacy), ["PostToolUseFailure:Bash"]);
  assert.equal(
    registeredHookBins(legacy).size,
    7,
    "the old binary-only 7/7 count cannot detect the missing event registration",
  );
});

test("stubSubcommandForFile maps every hook file to its lane", () => {
  assert.deepEqual(
    HOOK_FILES.map((f) => stubSubcommandForFile(f)),
    ["write", "session", "prompt", "todo", "bash-pre", "bash-fail", "stop"],
  );
  assert.equal(stubSubcommandForFile("not-ours.js"), null);
});

// ─── doctor sees both registered forms ───────────────────────────────────────

/** settings.json as `bastra install` writes it on a host WITH the stub. */
function stubSettings(): Record<string, unknown> {
  const plan = planHookEntries("install", {}, { includeStop: true, stubPresent: true });
  return JSON.parse(JSON.stringify(plan.after)) as Record<string, unknown>;
}

test("registeredHookBins counts stub-registered lanes (the 3/7 doctor bug)", () => {
  const found = registeredHookBins(stubSettings());
  assert.equal(found.size, 7, `expected 7/7, got ${found.size}: ${[...found.keys()].join(", ")}`);
  for (const f of HOOK_FILES) assert.ok(found.has(f), `not detected: ${f}`);
});

test("a mixed install — some lanes on the stub, some on node — counts all of them", () => {
  const entry = (cmd: string) => ({ hooks: [{ type: "command", command: cmd, __bastraRecall: true }] });
  const dist = "/opt/homebrew/lib/node_modules/@bastra-recall/daemon/dist";
  const found = registeredHookBins({
    SessionStart: [entry(`node ${dist}/session-hook.js`)],
    UserPromptSubmit: [entry(`${HOOK_STUB_BIN} prompt`)],
    PreToolUse: [
      entry(`${HOOK_STUB_BIN} write`),
      entry(`node ${dist}/todo-hook.js`),
      entry(`${HOOK_STUB_BIN} bash-pre`),
    ],
    PostToolUse: [entry(`${HOOK_STUB_BIN} bash-fail`)],
    PostToolUseFailure: [entry(`${HOOK_STUB_BIN} bash-fail`)],
    Stop: [entry(`${HOOK_STUB_BIN} stop`)],
  });
  assert.equal(found.size, 7);
});

test("checkHookPaths validates the stub binary, not a node path that is not there", async () => {
  const found = registeredHookBins(stubSettings());

  const clean = await checkHookPaths(found, { exists: async () => true, running: "0.9.1" });
  assert.deepEqual(clean, [], `a present stub must be clean, got: ${clean.join(" | ")}`);

  const missing = await checkHookPaths(found, { exists: async () => false, running: "0.9.1" });
  assert.equal(missing.length, 7, "a deleted stub binary must be reported for every lane");
  for (const problem of missing) {
    assert.match(problem, /MISSING/);
    assert.ok(problem.includes(HOOK_STUB_BIN), `the stub path belongs in the report: ${problem}`);
  }
});

// ─── the command parser ──────────────────────────────────────────────────────

test("stubLaneCommandPath accepts the forms a settings.json can carry", () => {
  assert.equal(stubLaneCommandPath("/a/b/stub/bastra-hook stop", "stop"), "/a/b/stub/bastra-hook");
  assert.equal(
    stubLaneCommandPath('"/a b/stub/bastra-hook" bash-pre', "bash-pre"),
    "/a b/stub/bastra-hook",
    "a quoted path with spaces",
  );
  assert.equal(
    stubLaneCommandPath("~/.bastra/stub/bastra-hook prompt", "prompt", "/Users/tester"),
    "/Users/tester/.bastra/stub/bastra-hook",
    "~ is expanded like hookCommandPath does",
  );
  assert.equal(
    stubLaneCommandPath("/a/b/stub/bastra-hook statusline --style=powerline", "prompt"),
    null,
    "the statusline entry is not a lane",
  );
  assert.equal(stubLaneCommandPath("/a/b/stub/bastra-hook stop", "session"), null, "wrong lane");
  assert.equal(stubLaneCommandPath("node /a/b/dist/stop-hook.js", "stop"), null, "the node client");
  assert.equal(stubLaneCommandPath("", "stop"), null);
});
