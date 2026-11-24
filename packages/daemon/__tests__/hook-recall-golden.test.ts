/**
 * #1513: golden master for `runHookRecall` before its measurement and
 * telemetry projection moved into their own module. Each scenario runs the
 * pipeline in-process over a two-memory vault and snapshots the payload, the
 * `hook_recall` row and the order of the stage events handed to `emitStage`.
 * Wall-clock values (every `*_ms` number, the event-loop probe, ids) are
 * normalized; the event-loop projection has its own unit test.
 *
 * Update (only for an intended behaviour change):
 *   node --import tsx --import ./scripts/test-env.mjs --test --test-update-snapshots \
 *     packages/daemon/__tests__/hook-recall-golden.test.ts
 */
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { runHookRecall } from "../src/http-hook-routes.js";
import { telemetrySession } from "../src/telemetry-session.js";

function memo(id: string, scope: string, body: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: Rule ${id}`,
    "type: lesson",
    `scope: ${scope}`,
    `summary: ${body}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "recall_when:",
    "  - when we deploy",
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

interface Scenario {
  name: string;
  body: Record<string, unknown>;
  dense?: boolean;
  router?: string;
}

const Q = "how do we deploy the release branch after the tag";
const SCENARIOS: Scenario[] = [
  { name: "lexical machine, prompt lane", body: { query: Q, hook_source: "prompt", tool_name: "UserPromptSubmit" } },
  { name: "hybrid machine, ordinary query", body: { query: Q, hook_source: "prompt" }, dense: true },
  { name: "hybrid machine, short query routed live", body: { query: "deploy" }, dense: true },
  { name: "hybrid machine, short query in router shadow", body: { query: "deploy" }, dense: true, router: "shadow" },
  { name: "caller asks lexical only", body: { query: Q, lexical_only: true }, dense: true },
  {
    name: "MCP caller with scope filter and budget",
    body: { query: Q, hook_source: "mcp", apply_scope_filter: true, project: "alpha", max_tokens: 60 },
    dense: true,
  },
  {
    name: "write lane with a tool input excerpt and topics",
    body: { query: Q, hook_source: "pre-tool", tool_name: "Edit", tool_input_excerpt: "deploy()", topics: ["deploy", 3] },
  },
  { name: "nothing matches", body: { query: "zzqx unmatched" } },
];

async function hookRecallRows(logDir: string): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const out: Record<string, unknown>[] = [];
    for (const f of (await readdir(logDir).catch(() => [] as string[])).filter((n) => n.startsWith("events-"))) {
      for (const line of (await readFile(join(logDir, f), "utf8")).split("\n")) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line) as Record<string, unknown>;
        if (ev.kind === "hook_recall") out.push(ev);
      }
    }
    if (out.length > 0) return out;
  }
  return [];
}

/** The conversation of every scenario; its log code (#436) reads as `<session:RAW>`. */
const SESSION = "golden-session";

const DROP = new Set(["ts", "event_loop_block_ms", "event_loop_block_source", "boot_id", "pid"]);

function normalize(value: unknown, key = ""): unknown {
  if (typeof value === "number" && (key.endsWith("_ms") || key.startsWith("latency_ms"))) return "<ms>";
  // The content hash covers the temp vault's file identity, not the content alone.
  if (key === "content_hash") return "<hash>";
  if (typeof value === "string") {
    return value
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
      .split(telemetrySession(SESSION))
      .join(`<session:${SESSION}>`);
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP.has(k)) continue;
      out[k] = normalize(v, k);
    }
    return out;
  }
  return value;
}

async function setup(sc: Scenario) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-1513-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-1513-logs-"));
  await writeFile(join(dir, "a.md"), memo("a", "alpha", "deploy over the release branch with a smoke test"), "utf8");
  await writeFile(join(dir, "b.md"), memo("b", "beta", "deploy only after the tag and the approval"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  if (sc.dense)
    search.useEmbeddings({
      size: () => 2,
      runtimeHealth: () => ({ errorCount: 0 }),
      searchDetailed: async () => ({
        outcome: "hits",
        hits: [
          { id: "a", score: 0.9 },
          { id: "b", score: 0.8 },
        ],
        providerLoadMs: null,
        coldStartObserved: false,
      }),
    } as never);
  const prev = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  if (prev === undefined) delete process.env.BASTRA_LOG_PATH;
  else process.env.BASTRA_LOG_PATH = prev;
  const cleanup = async () => {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  return { deps: { vault, search, telemetry }, logDir, cleanup };
}

for (const sc of SCENARIOS) {
  test(`#1513 golden master — ${sc.name}`, async (t) => {
    const s = await setup(sc);
    t.after(s.cleanup);
    const prevRouter = process.env.BASTRA_QUERY_ROUTER;
    if (sc.router) process.env.BASTRA_QUERY_ROUTER = sc.router;
    else delete process.env.BASTRA_QUERY_ROUTER;
    const stages: string[] = [];
    try {
      const body = { session_id: SESSION, ...sc.body };
      const payload = await runHookRecall(body, String(sc.body.query), Date.now(), s.deps, (st) =>
        stages.push(st.name)
      );
      const rows = await hookRecallRows(s.logDir);
      t.assert.snapshot(normalize({ payload, rows, stages }));
    } finally {
      if (prevRouter === undefined) delete process.env.BASTRA_QUERY_ROUTER;
      else process.env.BASTRA_QUERY_ROUTER = prevRouter;
    }
  });
}
