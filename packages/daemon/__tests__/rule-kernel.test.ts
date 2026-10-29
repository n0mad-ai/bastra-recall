/**
 * #1305 — the rule kernel after compact/clear/fork and its re-delivery after
 * 25 tool calls without a prompt.
 *
 * Collector and renderer are tested directly; the session lane runs whole
 * against a stub daemon whose /hook/session-context answers with the REAL
 * collector over an invented index, so the lane's request (active conventions
 * read before the reset) is what decides the kernel. The gate lane and the
 * prompt lane run in-process against an isolated state directory.
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import { after, before, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Memory } from "@bastra-recall/core";
import { memoryRevision } from "@bastra-recall/core";
import {
  collectRuleKernel,
  renderRuleKernel,
  RULE_KERNEL_ASK_LINE,
  RULE_KERNEL_CHAR_BUDGET,
  RULE_KERNEL_LEXICAL_LINE,
  RULE_KERNEL_TOOL_CALLS,
  type KernelCandidates,
  type KernelEntry,
} from "../src/rule-kernel.js";
import { runGateLane, actionReflexPool } from "../src/gate-lane.js";
import { runPromptLane } from "../src/prompt-lane.js";
import { runSessionLane } from "../src/session-lane.js";
import type { WarmupCoordinator } from "../src/embedding-warmup.js";
import {
  bookPendingMustLoad,
  bumpShown,
  clearPendingMustLoad,
  loadSessionState,
  mutateSessionState,
  recordActiveConventions,
} from "../src/session-state.js";

let stateDir = "";
let logDir = "";
let fileDir = "";
const saved: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "bastra-kernel-state-"));
  logDir = await mkdtemp(join(tmpdir(), "bastra-kernel-log-"));
  fileDir = await mkdtemp(join(tmpdir(), "bastra-kernel-files-"));
  setEnv("BASTRA_HOOK_STATE_DIR", stateDir);
  setEnv("BASTRA_LOG_PATH", logDir);
  setEnv("BASTRA_TELEMETRY", "off");
  setEnv("BASTRA_REFLEX", undefined);
});

after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [stateDir, logDir, fileDir]) await rm(dir, { recursive: true, force: true });
});

function memory(id: string, fm: Record<string, unknown>, body = `Body of ${id}.`, filePath?: string): Memory {
  return {
    fm: { id, title: `Title ${id}`, type: "workflow", scope: "all-projects", summary: `Summary ${id}`, updated: "2026-10-01", ...fm },
    body,
    ...(filePath ? { filePath } : {}),
  } as unknown as Memory;
}

const indexOf = (memories: Memory[]) => ({
  list: () => memories,
  get: (id: string) => memories.find((m) => m.fm.id === id),
});

const entry = (id: string, body: string, group: KernelEntry["group"] = "floor"): KernelEntry => ({
  id, title: `Title ${id}`, group, revision: `sha256:${id}`, updated: "2026-10-01", stale_status: "fresh", body,
});

/** The block's lines between the open and the close tag. */
const inner = (text: string) => text.split("\n").slice(1, -1);

describe("#1305 rule kernel: collection order", () => {
  for (const project of [null, "bastra-recall", "carnexus"]) {
    it(`keeps active conventions in the current scope (${project})`, async () => {
      const kernel = await collectRuleKernel(indexOf([
        memory("global-active", {}),
        memory("project-active", { scope: "carnexus" }),
      ]), {
        project,
        active: [
          { id: "global-active", revision: null, setAt: 1 },
          { id: "project-active", revision: null, setAt: 2 },
        ],
        floors: async () => [],
      });
      assert.deepEqual(kernel.entries.map((e) => e.id), project === "carnexus"
        ? ["project-active", "global-active"]
        : ["global-active"]);
    });
  }

  it("orders active conventions, floors, reflex, then user-directed preferences by salience, once each", async () => {
    const memories = [
      memory("pref-low", { type: "user-preference", write_origin: "user-directed", salience: 0.2 }),
      memory("pref-high", { type: "meta-working", write_origin: "user-directed", salience: 0.9 }),
      memory("pref-agent", { type: "user-preference", write_origin: "agent-session", salience: 1 }),
      memory("reflex-a", { recall_mode: "reflex", salience: 0.5 }),
      memory("reflex-b", { recall_mode: "reflex", salience: 0.7 }),
      memory("floored", {}),
      memory("active-old", {}),
      memory("active-new", { recall_mode: "reflex", salience: 0.99 }),
      memory("private-rule", { recall_mode: "reflex", sensitivity: "private" }),
      memory("old-rule", { recall_mode: "reflex", superseded_by: "reflex-a" }),
      memory("other-project", { recall_mode: "reflex", scope: "carnexus" }),
    ];
    const kernel = await collectRuleKernel(indexOf(memories), {
      project: null,
      active: [
        { id: "active-old", revision: null, setAt: 1 },
        { id: "active-new", revision: null, setAt: 2 },
      ],
      floors: async () => [{ memory_id: "floored", condition: "c", reason: "r", floored_at: "", last_affirmed: "" }],
    });
    assert.deepEqual(kernel.entries.map((e) => `${e.group}:${e.id}`), [
      "active-convention:active-new",
      "active-convention:active-old",
      "floor:floored",
      "reflex:reflex-b",
      "reflex:reflex-a",
      "user-directed:pref-high",
      "user-directed:pref-low",
    ]);
    assert.equal(kernel.omitted, 0);
  });

  it("keeps an active convention that no global cut would select, and reads its revision from disk", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-29T00:00:00Z") });
    const file = join(fileDir, "task-rule.md");
    const raw = "---\nid: task-rule\n---\nReply only in the approved format.\n";
    await writeFile(file, raw);
    const memories = [
      ...Array.from({ length: 30 }, (_, i) => memory(`pref-${i}`, { type: "user-preference", write_origin: "user-directed", salience: 0.9 })),
      memory("task-rule", { type: "project-fact", expires_after_days: 35 }, "Reply only in the approved format.", file),
    ];
    const kernel = await collectRuleKernel(indexOf(memories), {
      project: null,
      active: [{ id: "task-rule", revision: "sha256:old", setAt: 5 }],
      floors: async () => [],
    });
    const head = kernel.entries[0]!;
    assert.equal(head.id, "task-rule");
    assert.equal(head.revision, memoryRevision(raw), "the current revision of the file, via memoryRevision");
    assert.equal(head.stale_status, "aging");
    const text = renderRuleKernel(kernel, { trigger: "after compact" }).text;
    assert.match(text, new RegExp(`- \\[active-convention\\] task-rule "Title task-rule" revision=${memoryRevision(raw)} updated=2026-10-01 stale_status=aging\\nReply only in the approved format\\.`));
  });

  for (const persisted of [undefined, "fresh"]) {
    it(`computes expired rules live with persisted stale_status=${persisted}`, async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-29T00:00:00Z") });
      const kernel = await collectRuleKernel(indexOf([
        memory("expired-rule", { recall_mode: "reflex", valid_until: "2020-01-01", ...(persisted ? { stale_status: persisted } : {}) }),
      ]), { project: null, active: [], floors: async () => [] });
      assert.equal(kernel.entries[0]!.stale_status, "expired");
      assert.match(renderRuleKernel(kernel, { trigger: "after compact" }).text, /stale_status=expired\nBody of expired-rule\./);
    });
  }
});

describe("#1305 rule kernel: rendering", () => {
  it("delivers bodies whole, ends with the ask line and carries id, revision and updated", () => {
    const text = renderRuleKernel({ entries: [entry("a", "Rule A body."), entry("b", "Rule B\nsecond line.")], omitted: 0 }, { trigger: "after clear" }).text;
    const lines = text.split("\n");
    assert.equal(lines[0], '<rule-kernel trigger="after clear">');
    assert.equal(lines.at(-1), "</rule-kernel>");
    assert.equal(lines.at(-2), RULE_KERNEL_ASK_LINE, "the ask line is the block's last line");
    assert.match(text, /- \[floor\] a "Title a" revision=sha256:a updated=2026-10-01 stale_status=fresh\nRule A body\./);
    assert.match(text, /Rule B\nsecond line\./);
    assert.doesNotMatch(text, /lexical-only/);
  });

  it("marks a missing status from an older payload as unknown", () => {
    const legacy = entry("legacy", "Legacy rule.");
    Reflect.deleteProperty(legacy, "stale_status");
    const text = renderRuleKernel({ entries: [legacy], omitted: 0 }, { trigger: "after clear" }).text;
    assert.match(text, /updated=2026-10-01 stale_status=unknown\nLegacy rule\./);
  });

  it("replaces a body that does not fit with a degraded line and never emits part of it", () => {
    const big = "X".repeat(RULE_KERNEL_CHAR_BUDGET - 500) + "TAIL";
    const rendered = renderRuleKernel(
      { entries: [entry("short", "Short rule."), entry("huge", big), entry("after", "After rule.")], omitted: 0 },
      { trigger: "after compact" },
    );
    assert.ok(rendered.text.length <= RULE_KERNEL_CHAR_BUDGET, `block ${rendered.text.length} chars`);
    assert.deepEqual(rendered.degraded, ["huge"]);
    assert.deepEqual(rendered.full, ["short", "after"]);
    assert.match(rendered.text, /degraded: load_memory\(huge\)/);
    assert.doesNotMatch(rendered.text, /XXXX/, "no partial body");
  });

  it("holds the total bound with many entries and says how many were not listed", () => {
    const entries = Array.from({ length: 80 }, (_, i) => entry(`rule-${i}`, `Body ${i} `.repeat(30)));
    const rendered = renderRuleKernel({ entries, omitted: 3 }, { trigger: "after compact" });
    assert.ok(rendered.text.length <= RULE_KERNEL_CHAR_BUDGET, `block ${rendered.text.length} chars`);
    assert.ok(rendered.omitted > 3, "entries past the bound are counted with the collector's");
    assert.match(rendered.text, new RegExp(`\\+${rendered.omitted} more rule\\(s\\) not listed`));
    assert.equal(rendered.text.split("\n").at(-2), RULE_KERNEL_ASK_LINE);
    for (const e of entries.slice(0, rendered.full.length + rendered.degraded.length)) {
      const full = rendered.full.includes(e.id);
      assert.equal(rendered.text.includes(e.body), full, `${e.id}: whole body exactly when delivered in full`);
    }
  });

  it("gives an active convention its long body before short later rules, and shorter bodies before longer ones", () => {
    const long = "L".repeat(2500);
    const rendered = renderRuleKernel({
      entries: [
        entry("active-long", long, "active-convention"),
        entry("floor-long", "F".repeat(2500)),
        entry("reflex-short", "Short.", "reflex"),
        entry("pref-mid", "M".repeat(1400), "user-directed"),
      ],
      omitted: 0,
    }, { trigger: "after compact" });
    assert.deepEqual(rendered.full, ["active-long", "reflex-short", "pref-mid"]);
    assert.deepEqual(rendered.degraded, ["floor-long"]);
    const order = inner(rendered.text).filter((l) => l.startsWith("- [")).map((l) => l.split(" ")[2]);
    assert.deepEqual(order, ["active-long", "floor-long", "reflex-short", "pref-mid"], "printed in kernel order");
  });

  it("marks a one-armed start explicitly", () => {
    const text = renderRuleKernel({ entries: [entry("a", "A.")], omitted: 0 }, { trigger: "after compact", lexicalOnly: true }).text;
    assert.equal(text.split("\n")[2], RULE_KERNEL_LEXICAL_LINE);
  });

  it("renders nothing without candidates", () => {
    assert.equal(renderRuleKernel({ entries: [], omitted: 0 }, { trigger: "after compact" }).text, "");
  });
});

describe("#1305 rule kernel: session lane", () => {
  const RULES = [
    memory("rule-reflex", { recall_mode: "reflex", salience: 0.8 }, "Reflex rule body."),
    memory("rule-pref", { type: "user-preference", write_origin: "user-directed", salience: 0.9 }, "Preference body."),
    memory("rule-task", { type: "workflow" }, "Task convention body."),
  ];

  async function startWith(source: string, sessionId: string, warmup?: WarmupCoordinator) {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const path = (req.url ?? "").split("?")[0];
        res.writeHead(200, { "content-type": "application/json" });
        if (path !== "/hook/session-context") {
          res.end(path === "/health" ? '{"ok":true}' : "{}");
          return;
        }
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        requests.push(body);
        const ask = body.kernel as { active: Array<{ id: string; revision: string | null; setAt: number }> } | undefined;
        const kernel: KernelCandidates | undefined = ask
          ? await collectRuleKernel(indexOf(RULES), { project: null, active: ask.active, floors: async () => [] })
          : undefined;
        res.end(JSON.stringify({ data: {
          recalls: [], floors: [], conventions: [], care: { open: 0, queued: 0 }, imports: { open: 0, queued: 0 }, onboarding: false,
          ...(kernel ? { kernel } : {}),
        } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const out = await runSessionLane(
        { hook_event_name: "SessionStart", source: source as "compact", cwd: "/tmp", session_id: sessionId },
        `http://127.0.0.1:${port}`, warmup, async () => null,
      );
      const ctx = out === "{}" ? "" : String((JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext);
      return { ctx, requests };
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it("restores active conventions read before the compact reset, ahead of the global rules", async () => {
    const sid = "kernel-compact";
    await mutateSessionState(sid, (s) => {
      bumpShown(s, "something-shown");
      recordActiveConventions(s, [{ id: "rule-task", revision: "sha256:task" }]);
    });
    const { ctx, requests } = await startWith("compact", sid);
    assert.deepEqual((requests[0]!.kernel as { active: Array<{ id: string }> }).active.map((a) => a.id), ["rule-task"]);
    assert.ok(ctx.startsWith('<rule-kernel trigger="after compact">'), ctx.slice(0, 80));
    const heads = inner(ctx.slice(0, ctx.indexOf("</rule-kernel>") + 14)).filter((l) => l.startsWith("- ["));
    assert.deepEqual(heads.map((l) => l.split(" ")[2]), ["rule-task", "rule-reflex", "rule-pref"]);
    assert.match(ctx, /Task convention body\./);
    assert.match(ctx, new RegExp(`${RULE_KERNEL_ASK_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n</rule-kernel>`));
    const state = await loadSessionState(sid);
    assert.deepEqual(Object.keys(state.shown), [], "compact still releases the dedup");
    assert.deepEqual(state.activeConventions?.map((a) => a.id), ["rule-task"], "the conventions survive the reset");
  });

  it("delivers the kernel on fork", async () => {
    const { ctx } = await startWith("fork", "kernel-fork");
    assert.match(ctx, /<rule-kernel trigger="after fork">/);
    assert.match(ctx, /Reflex rule body\./);
  });

  it("delivers no kernel on resume and does not ask for one", async () => {
    const sid = "kernel-resume";
    await mutateSessionState(sid, (s) => recordActiveConventions(s, [{ id: "rule-task", revision: null }]));
    const { ctx, requests } = await startWith("resume", sid);
    assert.doesNotMatch(ctx, /rule-kernel/);
    assert.equal(requests[0]!.kernel, undefined);
  });

  it("says lexical-only when the dense arm is cold", async () => {
    const cold = { onSessionContact: () => "cold", residencyDetail: () => null } as unknown as WarmupCoordinator;
    const { ctx } = await startWith("clear", "kernel-cold", cold);
    assert.match(ctx, new RegExp(`<rule-kernel trigger="after clear">\\n[^\\n]+\\n${RULE_KERNEL_LEXICAL_LINE}\\n`));
  });
});

describe("#1305 rule kernel: re-delivery by the gate lane", () => {
  const RULE = memory("gate-rule", { recall_mode: "reflex", write_origin: "user-directed", salience: 0.9, recall_when: ["fixture_send_message"] },
    "Never call fixture_send_message without an approved copy.");
  const deps = {
    reflexPool: () => actionReflexPool([RULE]),
    kernel: (active: readonly { id: string; revision: string | null; setAt: number }[], project: string | null) =>
      collectRuleKernel(indexOf([RULE, memory("task-rule", {}, "Task rule body.")]), { project, active, floors: async () => [] }),
  };
  const call = (session_id: string, tool_name = "Bash", tool_input: Record<string, unknown> = { command: "printf ok" }) => ({
    hook_event_name: "PreToolUse", session_id, tool_name, tool_input, bastra_client: "claude-code", cwd: "/tmp",
  });
  type Out = { hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string } };
  const parse = (out: string) => JSON.parse(out) as Out;

  it(`re-delivers the kernel as a hint on call ${RULE_KERNEL_TOOL_CALLS}, never as a deny, then counts again`, async () => {
    const sid = "kernel-gate-cadence";
    const outs: Out[] = [];
    for (let i = 0; i < RULE_KERNEL_TOOL_CALLS * 2; i++) outs.push(parse(await runGateLane(call(sid), deps)));
    const delivered = outs.map((o, i) => (o.hookSpecificOutput?.additionalContext?.includes("<rule-kernel") ? i + 1 : 0)).filter(Boolean);
    assert.deepEqual(delivered, [RULE_KERNEL_TOOL_CALLS, RULE_KERNEL_TOOL_CALLS * 2]);
    assert.ok(outs.every((o) => o.hookSpecificOutput?.permissionDecision === undefined), "never a permission decision");
    const kernel = outs[RULE_KERNEL_TOOL_CALLS - 1]!.hookSpecificOutput!.additionalContext!;
    assert.match(kernel, /Never call fixture_send_message without an approved copy\./);
    assert.equal(kernel.split("\n").at(-2), RULE_KERNEL_ASK_LINE);
    assert.equal((await loadSessionState(sid)).toolCalls, 0);
  });

  it("a user prompt resets the count", async () => {
    const sid = "kernel-gate-prompt";
    for (let i = 0; i < RULE_KERNEL_TOOL_CALLS - 1; i++) await runGateLane(call(sid), deps);
    assert.equal((await loadSessionState(sid)).toolCalls, RULE_KERNEL_TOOL_CALLS - 1);
    await runPromptLane({ hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "ok", cwd: "/tmp" } as never, null, "http://127.0.0.1:9");
    assert.equal((await loadSessionState(sid)).toolCalls, undefined);
    const next = parse(await runGateLane(call(sid), deps));
    assert.equal(next.hookSpecificOutput, undefined, "call 1 after the prompt carries nothing");
  });

  it("a due kernel waits behind a deny; the delivered reflex rule and the answered must-load head it", async () => {
    const sid = "kernel-gate-active";
    for (let i = 0; i < RULE_KERNEL_TOOL_CALLS - 1; i++) await runGateLane(call(sid), deps);
    // Call 25 matches the reflex rule: a deny, and the kernel waits.
    const reflexDeny = parse(await runGateLane(call(sid, "ToolSearch", { query: "select:fixture_send_message" }), deps));
    assert.equal(reflexDeny.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(reflexDeny.hookSpecificOutput?.additionalContext, undefined);
    // Call 26 is denied for a must-load; the load that answers it activates it.
    await mutateSessionState(sid, (s) => bookPendingMustLoad(s, ["task-rule"], "prompt:test"));
    assert.equal(parse(await runGateLane(call(sid), deps)).hookSpecificOutput?.permissionDecision, "deny");
    await clearPendingMustLoad("task-rule", { revision: "sha256:task-1" });
    const state = await loadSessionState(sid);
    assert.deepEqual(state.activeConventions?.map((a) => [a.id, a.revision]), [["gate-rule", null], ["task-rule", "sha256:task-1"]]);
    // Call 27 delivers the kernel with both active conventions first, newest first.
    const kernel = parse(await runGateLane(call(sid), deps)).hookSpecificOutput?.additionalContext ?? "";
    const heads = inner(kernel).filter((l) => l.startsWith("- ["));
    assert.deepEqual(heads.map((l) => l.split(" ").slice(1, 3).join(" ")), ["[active-convention] task-rule", "[active-convention] gate-rule"]);
  });

  it("a lean dismissal does not put a rule in force", async () => {
    const sid = "kernel-gate-dismiss";
    await mutateSessionState(sid, (s) => bookPendingMustLoad(s, ["task-rule"], "prompt:test"));
    await clearPendingMustLoad("task-rule");
    assert.equal((await loadSessionState(sid)).activeConventions, undefined);
  });
});
