/**
 * #1511: golden master for the UserPromptSubmit lane before and after it was
 * cut into stages. Every scenario runs `runPromptLane` in-process against a
 * mock loopback daemon and snapshots what leaves the lane: the stdout document,
 * the telemetry row, the loopback requests in the order they were sent, and the
 * session state the lane saved. Only clock-derived values are normalized.
 *
 * The snapshot was recorded on the unsplit lane; a structural change that
 * alters any of these four outputs fails here.
 *
 * Update (only for an intended behaviour change):
 *   node --import tsx --import ./scripts/test-env.mjs --test --test-update-snapshots \
 *     packages/daemon/__tests__/prompt-lane-golden.test.ts
 */
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPromptLane } from "../src/prompt-lane.js";
import { loadSessionState } from "../src/session-state.js";
import type { PromptHookTelemetry } from "../src/prompt-lane-telemetry.js";

interface MockReply {
  status?: number;
  body: unknown;
}

interface Scenario {
  name: string;
  prompt?: string;
  event?: string;
  env?: Record<string, string>;
  recall?: MockReply;
  reflex?: MockReply;
  reflexPool?: string[];
  /** Session state written before the first run. */
  state?: object;
  /** How often the same payload runs in the same session (default 1). */
  runs?: number;
  /** Point the lane at a closed port instead of the mock. */
  unreachable?: boolean;
}

const hit = (id: string, score: number, extra: object = {}) => ({
  id,
  title: `Title ${id}`,
  type: "lesson",
  scope: "golden-scope",
  summary: `Summary of ${id}`,
  score,
  ...extra,
});

const recallOk = (hits: object[], extra: object = {}): MockReply => ({
  body: { hits, vault_size: 10, latency_ms: 3, recall_id: "golden-recall", ...extra },
});

const SCENARIOS: Scenario[] = [
  { name: "not a UserPromptSubmit event", event: "PreToolUse", prompt: "where is the lease?" },
  { name: "empty prompt", prompt: "   " },
  { name: "system-injected turn", prompt: "<task-notification><task-id>t1</task-id></task-notification>" },
  { name: "trivial prompt, nothing parked", prompt: "ok" },
  {
    name: "retrieval prompt with a strong hit",
    prompt: "where is the lease agreement?",
    recall: recallOk([hit("lease", 142), hit("weak", 20)]),
  },
  {
    name: "generic prompt, sub-REQUIRED ordinary hit stays out",
    prompt: "please refactor the parser module for clarity",
    recall: recallOk([hit("parser-note", 70)]),
  },
  {
    name: "generic prompt, wired reflex memory keeps the normal floor",
    prompt: "please refactor the parser module for clarity",
    recall: recallOk([hit("wired", 60, { recall_mode: "reflex", type: "convention" })]),
  },
  {
    name: "unfused recall: ordinary hit dropped, wired needs strong anchor",
    prompt: "please refactor the parser module for clarity",
    recall: recallOk(
      [
        hit("raw-ordinary", 40000),
        hit("raw-wired-weak", 30000, { recall_mode: "reflex" }),
        hit("raw-wired-strong", 20000, { recall_mode: "reflex", anchor_strength: "strong" }),
      ],
      { unfused: true, degraded: "vector-arm-timeout", bridges_fired: ["b1"] }
    ),
  },
  {
    name: "reflex hit and recall hit with the same id",
    prompt: "where is the lease agreement?",
    recall: recallOk([hit("lease", 142), hit("deposit", 120)]),
    reflex: {
      body: {
        hits: [{ id: "lease", title: "Lease", type: "convention", scope: "golden-scope", summary: "wired lease rule", matched_phrase: "lease" }],
        recall_id: "golden-reflex",
      },
    },
  },
  {
    name: "repeated prompt in one session: dedup of recall and reflex",
    prompt: "where is the lease agreement?",
    runs: 2,
    recall: recallOk([hit("lease", 142)]),
    reflex: {
      body: {
        hits: [{ id: "wired-lease", title: "Lease", type: "convention", scope: "golden-scope", summary: "wired", matched_phrase: "lease" }],
        recall_id: "golden-reflex",
      },
    },
  },
  {
    name: "unfused hit under a hot backoff window is suppressed",
    prompt: "please refactor the parser module for clarity",
    recall: recallOk([hit("hot-wired", 20000, { recall_mode: "reflex", anchor_strength: "strong" })], {
      unfused: true,
    }),
    state: {
      shown: {},
      sources: { "prompt-lookup": { streak: 6, at: Date.now() - 1000, ids: ["old-hit"], skipped: 0 } },
    },
  },
  {
    name: "mode none with an empty reflex pool skips the recall",
    prompt: "lass uns über das design reden",
    env: { BASTRA_PROMPT_HOOK_MODE: "retrieval-only" },
    reflexPool: [],
    recall: recallOk([hit("never", 150)]),
  },
  {
    name: "mode none with every wired memory already shown skips the recall",
    prompt: "lass uns über das design reden",
    env: { BASTRA_PROMPT_HOOK_MODE: "retrieval-only" },
    reflexPool: ["shown-wired"],
    state: { shown: { "shown-wired": { count: 1, at: 9_999_999_999_999 } } },
    recall: recallOk([hit("never", 150)]),
  },
  {
    name: "mode none recalls when a wired memory is eligible",
    prompt: "lass uns über das design reden",
    env: { BASTRA_PROMPT_HOOK_MODE: "retrieval-only" },
    reflexPool: ["fresh-wired"],
    recall: recallOk([hit("fresh-wired", 90, { recall_mode: "reflex" }), hit("plain", 150)]),
  },
  {
    name: "forced retrieval without a stored rule",
    prompt: "Baue den Ablauf wie beim letzten Mal",
    env: { BASTRA_PROMPT_HOOK_MODE: "retrieval-only" },
    reflexPool: [],
    recall: recallOk([hit("unrelated", 60)]),
  },
  {
    name: "recall answers HTTP 500",
    prompt: "where is the lease agreement?",
    recall: { status: 500, body: { error: "boom" } },
  },
  {
    name: "recall answers invalid JSON",
    prompt: "where is the lease agreement?",
    recall: { body: "not-json" },
  },
  {
    name: "daemon unreachable",
    prompt: "where is the lease agreement?",
    unreachable: true,
  },
];

/** Replace clock-derived values; everything else must stay byte-identical. */
function normalize(value: unknown): unknown {
  if (typeof value === "number") return value > 1e12 ? "<ts>" : value;
  if (typeof value === "string") {
    return value
      .replace(/prompt:[0-9a-z]+/g, "prompt:<id>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<iso>")
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>");
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "latency_ms_total") continue;
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

for (const sc of SCENARIOS) {
  test(`#1511 golden master — ${sc.name}`, async (t) => {
    const requests: Array<{ url: string; body: unknown }> = [];
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
        const reply =
          req.url === "/hook/recall"
            ? (sc.recall ?? recallOk([]))
            : req.url === "/hook/reflex"
              ? (sc.reflex ?? { body: { hits: [], recall_id: null } })
              : { body: { ok: true } };
        res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
        res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const stateDir = await mkdtemp(join(tmpdir(), "bastra-1511-state-"));
    const cwd = await mkdtemp(join(tmpdir(), "bastra-1511-cwd-"));
    const sessionId = `golden-${sc.name.replace(/[^a-z0-9]+/gi, "-")}`;
    if (sc.state) await writeFile(join(stateDir, `${sessionId}.json`), JSON.stringify(sc.state), "utf8");
    const env: Record<string, string> = {
      BASTRA_TELEMETRY: "off",
      BASTRA_HOOK_STATE_DIR: stateDir,
      ...sc.env,
    };
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const runs: unknown[] = [];
      for (let i = 0; i < (sc.runs ?? 1); i++) {
        const rows: PromptHookTelemetry[] = [];
        const stdout = await runPromptLane(
          {
            hook_event_name: sc.event ?? "UserPromptSubmit",
            prompt: sc.prompt,
            session_id: sessionId,
            cwd,
          },
          null,
          sc.unreachable ? "http://127.0.0.1:1" : `http://127.0.0.1:${port}`,
          undefined,
          sc.reflexPool ? () => sc.reflexPool as string[] : undefined,
          { onTelemetry: (row) => rows.push(row) }
        );
        runs.push({ stdout: JSON.parse(stdout) as unknown, telemetry: rows });
      }
      const state = await loadSessionState(sessionId);
      t.assert.snapshot(normalize({ runs, requests, state }));
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      await rm(stateDir, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
