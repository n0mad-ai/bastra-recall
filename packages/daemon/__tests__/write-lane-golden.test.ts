/**
 * #1525: golden master for the Write/Edit lane before and after `runWriteLane`
 * was cut into steps. Every scenario runs the lane in-process against a mock
 * loopback daemon and snapshots what leaves it: the stdout document, the
 * `hook_call` telemetry row, the loopback requests in the order they were
 * sent, and the session state the lane saved. Only clock-derived values and
 * temp paths (including their contribution to token estimates) are normalized.
 *
 * Update (only for an intended behaviour change):
 *   node --import tsx --import ./scripts/test-env.mjs --test --test-update-snapshots \
 *     packages/daemon/__tests__/write-lane-golden.test.ts
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWriteLane } from "../src/write-lane.js";
import { loadSessionState } from "../src/session-state.js";

interface MockReply {
  status?: number;
  body: unknown;
}

interface HookOutput {
  hookSpecificOutput?: { additionalContext: string };
}

interface Scenario {
  name: string;
  event?: string;
  tool?: string;
  /** Tool input; `<cwd>` in a string is replaced by the scenario's project dir. */
  input?: Record<string, unknown>;
  env?: Record<string, string>;
  recall?: MockReply;
  /** A second recall answer for the second run. */
  recall2?: MockReply;
  state?: object;
  runs?: number;
  unreachable?: boolean;
  /** Files written into the project dir before the run. */
  files?: Record<string, string>;
  vaultRoot?: boolean;
}

const hit = (id: string, score: number, extra: object = {}) => ({
  id,
  title: `Title ${id}`,
  type: "lesson",
  scope: "golden-proj",
  summary: `Summary of ${id}`,
  score,
  ...extra,
});

const recallOk = (hits: object[], extra: object = {}): MockReply => ({
  body: { hits, vault_size: 10, latency_ms: 3, recall_id: "golden-recall", project_known: true, ...extra },
});

const EDIT = { file_path: "<cwd>/src/parser.ts", old_string: "a", new_string: "b" };
const LEGACY = { BASTRA_PRETOOL_SHAPE: "legacy" };

const SCENARIOS: Scenario[] = [
  { name: "not a PreToolUse event", event: "PostToolUse", input: EDIT },
  { name: "unsupported tool", tool: "Read", input: EDIT },
  { name: "no file path", input: { content: "x" } },
  { name: "daemon unreachable", input: EDIT, unreachable: true },
  { name: "recall answers HTTP 500", input: EDIT, recall: { status: 500, body: { error: "boom" } } },
  { name: "recall answers invalid JSON", input: EDIT, recall: { body: "not-json" } },
  { name: "no hits", input: EDIT, recall: recallOk([]) },
  { name: "hits below the floor only", input: EDIT, recall: recallOk([hit("noise", 12)]) },
  {
    name: "compact: first touch presents the top hit",
    input: EDIT,
    recall: recallOk([hit("strong", 140), hit("second", 80)]),
  },
  {
    name: "compact: weak result presents nothing",
    input: EDIT,
    recall: recallOk([hit("weakish", 90)], { weak_result: true }),
  },
  {
    name: "compact: repeat area, then binding-anchored",
    input: EDIT,
    runs: 2,
    recall: recallOk([hit("first", 90)]),
    recall2: recallOk([hit("plain", 80), hit("anchored", 130, { matched_recall_when: true, anchor_strength: "strong" })]),
  },
  {
    name: "compact: repeat area without an anchored hit",
    input: EDIT,
    runs: 2,
    recall: recallOk([hit("first", 90)]),
    recall2: recallOk([hit("plain", 80)]),
  },
  {
    name: "legacy: required and optional bands",
    input: EDIT,
    env: LEGACY,
    recall: recallOk([hit("req", 130), hit("opt", 60)]),
  },
  {
    name: "legacy: unfused puts every hit in one list",
    input: EDIT,
    env: LEGACY,
    recall: recallOk([hit("raw-a", 40000), hit("raw-b", 20000)], { unfused: true, degraded: "vector-arm-timeout" }),
  },
  {
    name: "legacy: weak and no-home result",
    input: EDIT,
    env: LEGACY,
    recall: recallOk([hit("w", 70)], { weak_result: true, no_home: true }),
  },
  {
    name: "legacy: the second run drops the shown hit",
    input: EDIT,
    env: LEGACY,
    runs: 2,
    recall: recallOk([hit("again", 70)]),
  },
  {
    name: "legacy: a hot backoff window suppresses optional hints",
    input: EDIT,
    env: LEGACY,
    recall: recallOk([hit("opt-only", 60)]),
    state: {
      shown: {},
      sources: { "write-edit": { streak: 6, at: Date.now() - 1000, ids: ["old-hit"], skipped: 0 } },
    },
  },
  {
    name: "foreign scope is dropped",
    input: EDIT,
    env: LEGACY,
    recall: recallOk([hit("foreign", 90, { scope: "other-proj" }), hit("own", 90)]),
  },
  {
    name: "size note rides along without hits",
    input: { file_path: "<cwd>/src/big.ts", content: "x" },
    files: { "src/big.ts": Array.from({ length: 900 }, (_, i) => `export const v${i} = ${i};`).join("\n") },
    recall: recallOk([]),
  },
  {
    name: "size note rides through suppression",
    input: { file_path: "<cwd>/src/big.ts", old_string: "a", new_string: "b" },
    files: { "src/big.ts": Array.from({ length: 900 }, (_, i) => `export const v${i} = ${i};`).join("\n") },
    env: LEGACY,
    recall: recallOk([hit("opt-only", 60)]),
    state: {
      shown: {},
      sources: { "write-edit": { streak: 6, at: Date.now() - 1000, ids: ["old-hit"], skipped: 0 } },
    },
  },
  {
    name: "memory-shaped markdown outside the vault",
    tool: "Write",
    input: {
      file_path: "<cwd>/notes/lesson.md",
      content: "---\ntype: lesson\ntitle: A lesson\nsummary: x\n---\nbody\n",
    },
    vaultRoot: true,
    recall: recallOk([]),
  },
  {
    name: "apply_patch with several targets",
    tool: "apply_patch",
    input: {
      file_path: "<cwd>/src/a.ts",
      command: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Update File: src/b.ts\n@@\n-a\n+b\n*** End Patch",
    },
    recall: recallOk([hit("patch-hit", 140)]),
  },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function normalize(value: unknown, cwd: string, root: string): unknown {
  if (typeof value === "number") return value > 1e12 ? "<ts>" : value;
  if (typeof value === "string") {
    // The area key is case-folded (pretool-shape.ts), so the paths are matched
    // without regard to case.
    return value
      .replace(new RegExp(escape(cwd), "gi"), "<cwd>")
      .replace(new RegExp(escape(root), "gi"), "<root>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<iso>")
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>");
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, cwd, root));
  if (value instanceof Map) return normalize(Object.fromEntries(value), cwd, root);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "latency_ms_total" || k === "ts") continue;
      out[k.replace(new RegExp(escape(cwd), "gi"), "<cwd>")] = normalize(v, cwd, root);
    }
    return out;
  }
  return value;
}

function fill(input: Record<string, unknown>, cwd: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input).split("<cwd>").join(cwd)) as Record<string, unknown>;
}

/** The mock loopback daemon: answers /hook/recall per scenario, everything else `{ok:true}`. */
async function mockDaemon(sc: Scenario) {
  const requests: Array<{ url: string; body: unknown }> = [];
  let recallCalls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      let parsed: unknown = body;
      try {
        parsed = JSON.parse(body);
      } catch {
        // keep raw
      }
      requests.push({ url: req.url ?? "", body: parsed });
      let reply: MockReply = { body: { ok: true } };
      if (req.url === "/hook/recall") {
        recallCalls++;
        reply = (recallCalls > 1 ? sc.recall2 : undefined) ?? sc.recall ?? recallOk([]);
      }
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  };
  return { requests, url: sc.unreachable ? "http://127.0.0.1:1" : `http://127.0.0.1:${port}`, close };
}

/** A git-rooted project dir with the scenario's files, its state dir and log dir. */
async function workspace(sc: Scenario, sessionId: string) {
  const root = await mkdtemp(join(tmpdir(), "bastra-1525-"));
  const cwd = join(root, "golden-proj");
  const stateDir = join(root, "state");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  for (const [rel, content] of Object.entries(sc.files ?? {})) {
    await mkdir(join(cwd, rel, ".."), { recursive: true });
    await writeFile(join(cwd, rel), content, "utf8");
  }
  const vaultRoot = sc.vaultRoot ? join(root, "vault") : null;
  if (vaultRoot) await mkdir(vaultRoot, { recursive: true });
  if (sc.state) await writeFile(join(stateDir, `${sessionId}.json`), JSON.stringify(sc.state), "utf8");
  return { root, cwd, stateDir, logDir: join(root, "logs"), vaultRoot };
}

async function hookCallRows(logDir: string): Promise<Array<Record<string, unknown>>> {
  let rows: Array<Record<string, unknown>> = [];
  try {
    for (const f of (await readdir(logDir)).filter((n) => n.startsWith("events-")).sort()) {
      rows = rows.concat(
        (await readFile(join(logDir, f), "utf8"))
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((r) => r.kind === "hook_call")
      );
    }
  } catch {
    // no telemetry written
  }
  return rows;
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

for (const sc of SCENARIOS) {
  test(`#1525 golden master — ${sc.name}`, async (t) => {
    const daemon = await mockDaemon(sc);
    const sessionId = `golden-${sc.name.replace(/[^a-z0-9]+/gi, "-")}`;
    const ws = await workspace(sc, sessionId);
    t.after(async () => {
      await daemon.close();
      await rm(ws.root, { recursive: true, force: true });
    });
    const env = { BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: ws.logDir, BASTRA_HOOK_STATE_DIR: ws.stateDir, ...sc.env };
    const snapshot = await withEnv(env, async () => {
      const runs: Array<{ stdout: HookOutput }> = [];
      for (let i = 0; i < (sc.runs ?? 1); i++) {
        const stdout = await runWriteLane(
          {
            hook_event_name: sc.event ?? "PreToolUse",
            tool_name: sc.tool ?? "Edit",
            tool_input: sc.input ? fill(sc.input, ws.cwd) : undefined,
            session_id: sessionId,
            cwd: ws.cwd,
          },
          daemon.url,
          ws.vaultRoot
        );
        runs.push({ stdout: JSON.parse(stdout) as HookOutput });
      }
      const state = await loadSessionState(sessionId);
      const rows = await hookCallRows(ws.logDir);
      if (rows.length > 0) t.assert.equal(rows.length, runs.length);
      const telemetry = rows.map((row, i) => {
        const context = runs[i].stdout.hookSpecificOutput?.additionalContext ?? "";
        // Check the real emitted size before replacing temp paths. The snapshot
        // then records the estimate of its canonical, platform-independent text.
        t.assert.equal(row.hint_tokens_est, Math.ceil(context.length / 4));
        return { ...row, hint_tokens_est: Math.ceil((normalize(context, ws.cwd, ws.root) as string).length / 4) };
      });
      return { runs, telemetry, requests: daemon.requests, state };
    });
    t.assert.snapshot(normalize(snapshot, ws.cwd, ws.root));
  });
}
