/**
 * #1303 — everything around the gate lane: the two hook clients failing open
 * with a `gate_timeout` row, the registration (catch-all matcher, `fork`), and
 * the prompt and session lanes booking pending ids and the one-time wording
 * for gated ids only.
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import { after, before, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hookDefinitions,
  missingRequiredHookRegistrations,
  planHookEntries,
  stubSubcommandForFile,
  OUR_HOOK_FILES,
  REQUIRED_HOOK_FILES,
} from "../src/cli/adapters/claude-code-hooks.js";
import { isGatedHint } from "../src/hook-recall-response.js";
import { formatHintBlock, formatReflexBlock, MUST_LOAD_MARK } from "../src/prompt-format.js";
import { formatBlock } from "../src/session-format.js";
import { runPromptLane } from "../src/prompt-lane.js";
import { runSessionLane } from "../src/session-lane.js";
import { loadSessionState } from "../src/session-state.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");
const STUB = resolve(HERE, "..", "stub", "bastra-hook.ts");

const saved: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
let stateDir = "";
before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "bastra-gate-wiring-"));
  setEnv("BASTRA_HOOK_STATE_DIR", stateDir);
  setEnv("BASTRA_TELEMETRY", "off");
  setEnv("BASTRA_PROMPT_HOOK_MODE", "all");
});
after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(stateDir, { recursive: true, force: true });
});

async function listen(server: Server): Promise<number> {
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    ok(typeof addr === "object" && addr ? addr.port : 0);
  }));
}

/** Run one gate client; `hangStdin` keeps stdin open so only the kill switch can end it. */
async function runClient(argv: string[], port: number, sessionId: string, hangStdin = false) {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-gate-client-"));
  const started = Date.now();
  const stdout = await new Promise<string>((ok, ko) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...argv], {
      env: {
        ...process.env,
        BASTRA_LOG_PATH: logDir,
        BASTRA_DAEMON_URL: `http://127.0.0.1:${port}`,
        BASTRA_TELEMETRY: "on",
        BASTRA_HOOK_TIMEOUT_MS: "300",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", ko);
    child.on("close", () => ok(out));
    child.stdin.write(JSON.stringify({ session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } }));
    if (!hangStdin) child.stdin.end();
  });
  const rows: Array<Record<string, unknown>> = [];
  for (const name of await readdir(logDir)) {
    for (const line of (await readFile(join(logDir, name), "utf8")).split("\n")) if (line.trim()) rows.push(JSON.parse(line));
  }
  await rm(logDir, { recursive: true, force: true });
  return { stdout, rows, ms: Date.now() - started };
}

describe("#1303 gate clients fail open with a non-conformance row", () => {
  const shapes = [["node", [join(SRC, "gate-hook.ts")]], ["stub", [STUB, "gate"]]] as const;

  it("a daemon that does not answer in budget: `{}` and gate_timeout, on both client shapes", async () => {
    const hung = createServer(() => { /* never answers */ });
    const port = await listen(hung);
    try {
      for (const [shape, argv] of shapes) {
        const r = await runClient([...argv], port, `gate-timeout-${shape}`);
        assert.equal(r.stdout, "{}", shape);
        assert.equal(r.rows.length, 1, `${shape}: one client row`);
        assert.equal(r.rows[0]!.kind, "gate_hook_call", shape);
        assert.equal(r.rows[0]!.session_id, `gate-timeout-${shape}`, shape);
        assert.equal(r.rows[0]!.status, "timeout", shape);
        assert.equal(r.rows[0]!.non_conformance, "gate_timeout", shape);
        assert.equal(r.rows[0]!.outcome, "pass", shape);
      }
    } finally {
      hung.closeAllConnections();
      await new Promise<void>((ok) => hung.close(() => ok()));
    }
  });

  it("an unreachable daemon: `{}` and gate_unavailable", async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise<void>((ok) => probe.close(() => ok()));
    for (const [shape, argv] of shapes) {
      const r = await runClient([...argv], port, `gate-down-${shape}`);
      assert.equal(r.stdout, "{}", shape);
      assert.equal(r.rows.length, 1, shape);
      assert.equal(r.rows[0]!.non_conformance, "gate_unavailable", shape);
    }
  });

  it("the kill switch (stdin never closes) answers `{}` and still writes gate_timeout", async () => {
    for (const [shape, argv] of shapes) {
      const r = await runClient([...argv], 1, `gate-kill-${shape}`, true);
      assert.equal(r.stdout, "{}", shape);
      assert.equal(r.rows.length, 1, `${shape}: one kill-switch row`);
      assert.equal(r.rows[0]!.non_conformance, "gate_timeout", shape);
      assert.equal(r.rows[0]!.error, "kill-switch", shape);
    }
  });
});

describe("#1303 registration", () => {
  it("registers one catch-all PreToolUse gate on the stub's `gate` subcommand", () => {
    const gates = hookDefinitions().filter((d) => d.stubSubcommand === "gate");
    assert.equal(gates.length, 1);
    assert.equal(gates[0]!.event, "PreToolUse");
    assert.equal(gates[0]!.matcher, "*", "code.claude.com/docs/en/hooks: `*`, \"\" or omitted match all");
    assert.ok(gates[0]!.bin.endsWith("gate-hook.js"));
    assert.ok(OUR_HOOK_FILES.includes("gate-hook.js"));
    assert.ok(REQUIRED_HOOK_FILES.includes("gate-hook.js"));
    assert.equal(stubSubcommandForFile("gate-hook.js"), "gate");
  });

  it("SessionStart matches fork, and an install without it is reported as missing", () => {
    const session = hookDefinitions().find((d) => d.event === "SessionStart")!;
    assert.deepEqual(session.matcher!.split("|").sort(), ["clear", "compact", "fork", "resume", "startup"]);
    const plan = planHookEntries("install", {}, { includeStop: true, stubPresent: true, platform: "darwin" });
    const entry = (plan.after.SessionStart as Array<{ matcher?: string }>)[0]!;
    assert.match(entry.matcher ?? "", /\|fork$/);
    const pre = plan.after.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    assert.ok(pre.some((e) => e.matcher === "*" && / gate$/.test(e.hooks[0]!.command)));
    // An install from before #1303: the old matcher and no gate.
    const old = JSON.parse(JSON.stringify(plan.after)) as Record<string, Array<{ matcher?: string }>>;
    old.SessionStart![0]!.matcher = "startup|resume|clear|compact";
    old.PreToolUse = old.PreToolUse!.filter((e) => e.matcher !== "*");
    assert.deepEqual(missingRequiredHookRegistrations(old).sort(), ["PreToolUse:*", "SessionStart:startup|resume|clear|compact|fork"]);
    assert.deepEqual(missingRequiredHookRegistrations(plan.after as Record<string, unknown>), []);
  });
});

describe("#1303 which hints are gated, and how they read", () => {
  it("rule types with trigger, reflex or user-directed evidence — nothing else", () => {
    assert.equal(isGatedHint({ type: "user-preference", matched_recall_when: true }), true);
    assert.equal(isGatedHint({ type: "meta-working", recall_mode: "reflex" }), true);
    assert.equal(isGatedHint({ type: "workflow", write_origin: "user-directed" }), true);
    assert.equal(isGatedHint({ type: "workflow", write_origin: "agent-session" }), false);
    assert.equal(isGatedHint({ type: "meta-working" }), false);
    assert.equal(isGatedHint({ type: "lesson", matched_recall_when: true }), false);
    assert.equal(isGatedHint({ type: "project-fact", write_origin: "user-directed" }), false);
  });

  it("the must-load wording appears on gated lines only, in all three formatters", () => {
    const hit = (id: string) => ({ id, title: id, type: "workflow", scope: "s", summary: `sum ${id}`, score: 150 });
    const gated = new Set(["a"]);
    const lineOf = (block: string, id: string) => block.split("\n").find((l) => l.startsWith(`- ${id} `)) ?? "";
    const prompt = formatHintBlock([hit("a"), hit("b")], null, "generic", false, false, "claude-code", undefined, undefined, gated);
    const reflex = formatReflexBlock([{ ...hit("a"), matched_phrase: "p" }, { ...hit("b"), matched_phrase: "p" }], null, "claude-code", gated);
    const session = formatBlock([hit("a"), hit("b")], null, "fork", false, false, "claude-code", "off", gated);
    for (const block of [prompt, reflex, session]) {
      assert.ok(lineOf(block, "a").endsWith(MUST_LOAD_MARK), block);
      assert.ok(!lineOf(block, "b").includes("must-load"), block);
    }
    assert.ok(!formatHintBlock([hit("a")], null, "generic").includes("must-load"), "no gate, no claim");
  });
});

/** A loopback daemon serving what the two lanes ask for. */
async function mockDaemon(hits: Array<Record<string, unknown>>) {
  const recall = { hits, vault_size: hits.length, recall_id: "r", latency_ms: 1, score_kind: "rrf", score_arms: ["bm25", "vector"] };
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const url = req.url ?? "";
    const body = url === "/hook/recall" ? recall
      : url === "/hook/reflex" ? { hits: [], recall_id: null }
      : url === "/hook/session-context" ? { data: { recalls: [{ scope: "user-preference", resp: recall }], floors: [], conventions: [], care: { open: 0, queued: 0 }, imports: { open: 0, queued: 0 }, onboarding: false } }
      : url === "/health" ? { ok: true, update_available: null }
      : {};
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  });
  const port = await listen(server);
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

const HITS = [
  { id: "pref-trigger", title: "t", type: "user-preference", scope: "all-projects", summary: "s1", score: 150, matched_recall_when: true, anchor_strength: "strong" },
  { id: "work-user", title: "t", type: "meta-working", scope: "all-projects", summary: "s2", score: 150, matched_recall_when: false, write_origin: "user-directed" },
  { id: "work-agent", title: "t", type: "meta-working", scope: "all-projects", summary: "s3", score: 150, matched_recall_when: false, write_origin: "agent-session" },
  { id: "fact", title: "t", type: "project-fact", scope: "all-projects", summary: "s4", score: 150, matched_recall_when: true },
];
const GATED = ["pref-trigger", "work-user"];

describe("#1303 the prompt and session lanes book pending ids beside the shown-state", () => {
  it("prompt lane: gated ids pending and marked; ungated ones neither", async () => {
    const d = await mockDaemon(HITS);
    try {
      const sid = "gate-prompt-book";
      const out = JSON.parse(await runPromptLane(
        { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "Bitte kurz weiterarbeiten", cwd: stateDir } as never,
        null, d.base, undefined, () => [],
      )) as { hookSpecificOutput?: { additionalContext?: string } };
      const text = out.hookSpecificOutput?.additionalContext ?? "";
      for (const h of HITS) assert.ok(text.includes(h.id), `setup: ${h.id} must be emitted`);
      const marked = text.split("\n").filter((l) => l.endsWith(MUST_LOAD_MARK)).map((l) => l.slice(2).split(" ")[0]);
      assert.deepEqual(marked.sort(), [...GATED].sort());
      const state = await loadSessionState(sid);
      assert.deepEqual(state.pendingMustLoad?.map((e) => e.id).sort(), [...GATED].sort());
      assert.ok(Object.keys(state.shown).includes("fact"), "shown-state booked as before");
    } finally {
      await d.close();
    }
  });

  it("prompt lane: a Codex payload books nothing and promises nothing", async () => {
    const d = await mockDaemon(HITS);
    try {
      const sid = "gate-prompt-codex";
      const out = await runPromptLane(
        { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "Bitte kurz weiterarbeiten", cwd: stateDir, bastra_client: "codex" } as never,
        null, d.base, undefined, () => [],
      );
      assert.ok(!out.includes("must-load"));
      assert.equal((await loadSessionState(sid)).pendingMustLoad, undefined);
    } finally {
      await d.close();
    }
  });

  for (const version of ["0.162.0", "0.162.1", "0.162.2"]) {
    for (const lane of ["prompt", "session"]) {
      it(`#1304 Codex ${version} ${lane}: wording and pending follow verified registration evidence`, async () => {
        const d = await mockDaemon(HITS);
        try {
          const sid = `codex-${lane}-${version}`;
          const payload = {session_id: sid, cwd: stateDir, bastra_client: "codex", bastra_codex_version: version};
          const out = lane === "prompt"
            ? await runPromptLane({...payload, hook_event_name: "UserPromptSubmit", prompt: "Bitte kurz weiterarbeiten"} as never, null, d.base, undefined, () => [])
            : await runSessionLane({...payload, hook_event_name: "SessionStart", source: "fork"} as never, d.base, undefined, async () => null);
          const state = await loadSessionState(sid);
          if (version === "0.162.1") {
            assert.match(out, /must-load/);
            assert.deepEqual(state.pendingMustLoad?.map(e => e.id).sort(), [...GATED].sort());
          } else {
            assert.ok(!out.includes("must-load"));
            assert.equal(state.pendingMustLoad, undefined);
          }
        } finally { await d.close(); }
      });
    }
  }

  it("session lane: a fork start books and marks the gated ids, and releases nothing", async () => {
    const d = await mockDaemon(HITS);
    try {
      const sid = "gate-session-fork";
      const out = await runSessionLane(
        { hook_event_name: "SessionStart", session_id: sid, source: "fork", cwd: stateDir },
        d.base, undefined, async () => null,
      );
      const text = (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
      assert.match(text, /source="fork"/);
      const marked = text.split("\n").filter((l) => l.endsWith(MUST_LOAD_MARK)).map((l) => l.slice(2).split(" ")[0]);
      assert.deepEqual(marked.sort(), [...GATED].sort());
      assert.deepEqual((await loadSessionState(sid)).pendingMustLoad?.map((e) => e.id).sort(), [...GATED].sort());
    } finally {
      await d.close();
    }
  });
});
