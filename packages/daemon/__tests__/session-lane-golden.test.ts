/**
 * #1512: golden master for the SessionStart lane before and after it was cut
 * into blocks. Every scenario runs `runSessionLane` in-process against a mock
 * loopback daemon and snapshots what leaves the lane: the stdout document, the
 * `session_hook_call` telemetry row, the loopback requests in the order they
 * were observed, and the session state the lane saved. Only clock- and
 * host-derived values and the order of the two parallel requests are normalized.
 *
 * Update (only for an intended behaviour change):
 *   node --import tsx --import ./scripts/test-env.mjs --test --test-update-snapshots \
 *     packages/daemon/__tests__/session-lane-golden.test.ts
 */
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSessionLane, type SessionPayload } from "../src/session-lane.js";
import { budgetShadowWritesSettled } from "../src/session-budget.js";
import { loadSessionState } from "../src/session-state.js";
import { telemetrySession } from "../src/telemetry-session.js";

interface Scenario {
  name: string;
  event?: string;
  /** One lane call per entry, in the same session. */
  sources: Array<SessionPayload["source"]>;
  context?: { status?: number; body: unknown };
  state?: object;
  unreachable?: boolean;
}

const hit = (id: string, score: number, scope: string, extra: object = {}) => ({
  id,
  title: `Title ${id}`,
  type: "lesson",
  scope,
  summary: `Summary of ${id}`,
  score,
  ...extra,
});

const pin = (id: string, extra: object = {}) => ({
  memory_id: id,
  title: `Pinned ${id}`,
  summary: `Pinned summary ${id}`,
  reason: "golden",
  floored_at: "2026-11-01",
  last_affirmed: "2026-11-01",
  ...extra,
});

const context = (data: object) => ({
  body: {
    budget: {},
    aborted: [],
    data: {
      recalls: [],
      floors: [],
      conventions: [],
      care: { open: 0, queued: 0 },
      imports: { open: 0, queued: 0 },
      onboarding: false,
      ...data,
    },
  },
});

const recall = (scope: string, hits: object[], extra: object = {}) => ({
  scope,
  resp: { hits, vault_size: 5, latency_ms: 1, recall_id: `r-${scope}`, score_kind: "rrf", ...extra },
});

const SCENARIOS: Scenario[] = [
  { name: "not a SessionStart event", event: "UserPromptSubmit", sources: ["startup"] },
  { name: "nothing to say", sources: ["startup"], context: context({}) },
  {
    name: "nothing to say, empty rule kernel",
    sources: ["startup"],
    context: context({ kernel: { entries: [], omitted: 0 } }),
  },
  {
    name: "rule kernel with one rule and a hit",
    sources: ["resume"],
    context: context({
      recalls: [recall("user-preference", [hit("pref-a", 150, "user-preference")])],
      kernel: {
        entries: [
          {
            id: "rule-1",
            title: "Rule one",
            group: "user-directed",
            revision: "sha256:abc",
            updated: "2026-11-01",
            stale_status: "fresh",
            body: "Always do the thing.",
            rulebook: "always",
          },
        ],
        omitted: 0,
      },
    }),
  },
  {
    name: "hits from two scopes, pinned overlap, every standing block",
    sources: ["startup"],
    context: context({
      recalls: [
        recall("user-preference", [hit("pref-a", 150, "user-preference"), hit("pinned-1", 120, "user-preference")]),
        recall("all-projects", [hit("rule-b", 90, "all-projects", { weak_result: true }), hit("low", 10, "x")]),
      ],
      floors: [
        pin("pinned-1"),
        pin("scoped-pin", { scope: "other" }),
      ],
      conventions: [{ id: "conv-1", title: "Convention", summary: "naming rule", updated: "2026-11-01" }],
      care: { open: 2, queued: 0 },
      imports: { open: 3, queued: 4 },
      onboarding: true,
    }),
  },
  {
    name: "only pinned entries, no recall hits",
    sources: ["startup"],
    context: context({ floors: [pin("pin-only")] }),
  },
  {
    name: "unfused and degraded recall",
    sources: ["startup"],
    context: context({
      recalls: [
        recall("user-preference", [hit("raw", 40000, "user-preference")], {
          unfused: true,
          degraded: "vector-arm-timeout",
          score_kind: "bm25",
        }),
      ],
    }),
  },
  {
    name: "startup then resume then compact: cadence and released dedup",
    sources: ["startup", "resume", "compact"],
    context: context({
      recalls: [recall("user-preference", [hit("pref-a", 150, "user-preference")])],
      conventions: [{ id: "conv-1", title: "Convention", summary: "naming rule", updated: "2026-11-01" }],
    }),
  },
  {
    name: "session context answers HTTP 500",
    sources: ["startup"],
    context: { status: 500, body: { error: "boom" } },
  },
  { name: "daemon unreachable", sources: ["startup"], unreachable: true },
];

const VOLATILE = new Set(["ts", "latency_ms_total", "session_start_call_id", "host_profile_id"]);
/** Remaining-time budgets the lane sends: present, but clock-derived. */
const REMAINING = new Set(["time_ms"]);

/** `session`: the conversation of the scenario; its log code (#436) reads as `<session:RAW>`. */
function normalize(value: unknown, session: string): unknown {
  if (typeof value === "number") return value > 1e12 ? "<ts>" : value;
  if (typeof value === "string") {
    return value
      .replace(/session:[0-9a-z]+/g, "session:<id>")
      .replace(/@\d{13}\b/g, "@<ts>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<iso>")
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
      .split(telemetrySession(session))
      .join(`<session:${session}>`);
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, session));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE.has(k)) continue;
      out[k] = REMAINING.has(k) && typeof v === "number" ? "<remaining-ms>" : normalize(v, session);
    }
    return out;
  }
  return value;
}

async function sessionRows(logDir: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const f of (await readdir(logDir)).filter((n) => n.startsWith("events-")).sort()) {
    for (const line of (await readFile(join(logDir, f), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { kind?: string };
      if (row.kind === "session_hook_call") rows.push(row);
    }
  }
  return rows;
}

for (const sc of SCENARIOS) {
  test(`#1512 golden master — ${sc.name}`, async (t) => {
    const requests: Array<{ url: string; body: unknown }> = [];
    let currentSource: SessionPayload["source"];
    let contextArrived: () => void = () => {};
    const resumeContextArrived = new Promise<void>((resolve) => {
      contextArrived = resolve;
    });
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", async () => {
        let parsed: unknown = body;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch {
          // keep raw
        }
        const path = (req.url ?? "").split("?")[0];
        // The two independent requests can be observed in either order.
        // Force the inverted order on resume, without a timing-dependent sleep.
        if (path === "/health" && currentSource === "resume") await resumeContextArrived;
        requests.push({ url: path, body: parsed });
        if (path === "/hook/session-context" && currentSource === "resume") contextArrived();
        const reply: { status?: number; body: unknown } =
          path === "/hook/session-context"
            ? (sc.context ?? context({}))
            : path === "/health"
              ? { body: { ok: true } }
              : { body: {} };
        res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const stateDir = await mkdtemp(join(tmpdir(), "bastra-1512-state-"));
    const logDir = await mkdtemp(join(tmpdir(), "bastra-1512-logs-"));
    const cwd = await mkdtemp(join(tmpdir(), "bastra-1512-cwd-"));
    const sessionId = `golden-${sc.name.replace(/[^a-z0-9]+/gi, "-")}`;
    if (sc.state) await writeFile(join(stateDir, `${sessionId}.json`), JSON.stringify(sc.state), "utf8");
    const env: Record<string, string> = {
      BASTRA_TELEMETRY: "on",
      BASTRA_LOG_PATH: logDir,
      BASTRA_HOOK_STATE_DIR: stateDir,
    };
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const outputs: unknown[] = [];
      for (const source of sc.sources) {
        currentSource = source;
        const firstRequest = requests.length;
        const stdout = await runSessionLane(
          { hook_event_name: sc.event ?? "SessionStart", source, cwd, session_id: sessionId },
          sc.unreachable ? "http://127.0.0.1:1" : `http://127.0.0.1:${port}`,
          undefined,
          async () => null
        );
        // Compare both complete requests in a stable order, without changing
        // the ordering of later requests or the grouping by lane call.
        const [first, second] = requests.slice(firstRequest, firstRequest + 2);
        if (first?.url === "/hook/session-context" && second?.url === "/health") {
          requests.splice(firstRequest, 2, second, first);
        }
        outputs.push(JSON.parse(stdout) as unknown);
      }
      await budgetShadowWritesSettled();
      const state = await loadSessionState(sessionId);
      t.assert.snapshot(normalize({ outputs, telemetry: await sessionRows(logDir), requests, state }, sessionId));
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      await rm(stateDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
