/**
 * #1468 — a memory past its own `valid_until` is not shown automatically by
 * the hooks; MCP recall still finds it, marked `expired_on`. Calendar aging
 * (`expires_after_days`, type defaults) and supersession chains are untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, pastValidUntil, type Memory } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { runHookRecall } from "../src/http-hook-routes.js";
import { isReflexPoolMember } from "../src/reflex.js";
import { assembleSessionSections, type SessionContextDeps } from "../src/session-assembler.js";

function memo(o: { id: string; extra?: string[] }): string {
  return [
    "---",
    `id: ${o.id}`,
    `title: Decision ${o.id}`,
    "type: decision",
    "summary: freeze deploys during the migration window",
    "topic_path:",
    "  - ops",
    "tags:",
    "  - ops",
    "scope: ops",
    "recall_when:",
    "  - freeze deploys migration window",
    ...(o.extra ?? []),
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "---",
    "",
    "Freeze deploys during the migration window.",
    "",
  ].join("\n");
}

async function makeDeps(t: { after: (fn: () => unknown) => void }): Promise<ToolDeps> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-1468-"));
  await writeFile(join(dir, "expired.md"), memo({ id: "expired", extra: ["valid_until: 2026-02-01"] }), "utf8");
  await writeFile(join(dir, "current.md"), memo({ id: "current", extra: ["valid_until: 2999-01-01"] }), "utf8");
  await writeFile(join(dir, "aged.md"), memo({ id: "aged", extra: ["expires_after_days: 1"] }), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { vault, search, telemetry: new Telemetry(), vaultPath: dir };
}

const QUERY = "freeze deploys migration window";
const ids = (hits: unknown): string[] => (hits as { id: string }[]).map((h) => h.id);

test("#1468 pastValidUntil: only the explicit end date counts", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  assert.equal(pastValidUntil({ valid_until: "2026-05-31" }, now), true);
  assert.equal(pastValidUntil({ valid_until: "2026-06-01" }, now), true, "same boundary as computeStaleness");
  assert.equal(pastValidUntil({ valid_until: "2026-06-02" }, now), false);
  assert.equal(pastValidUntil({ valid_until: new Date("2026-01-01") }, now), true);
  assert.equal(pastValidUntil({ expires_after_days: 1, updated: "2020-01-01" }, now), false);
  assert.equal(pastValidUntil({ valid_until: "not a date" }, now), false);
  assert.equal(pastValidUntil({}, now), false);
});

test("#1468 hook delivery leaves out a memory past valid_until", async (t) => {
  const deps = await makeDeps(t);
  const res = await runHookRecall({ query: QUERY, k: 5, expand_hops: 0 }, QUERY, Date.now(), deps);
  const got = ids(res.hits);
  assert.ok(!got.includes("expired"), JSON.stringify(got));
  assert.ok(got.includes("current"), "a valid_until in the future is delivered");
  assert.ok(got.includes("aged"), "calendar aging only demotes, it does not hide");
});

test("#1468 MCP recall still finds it, marked expired_on", async (t) => {
  const deps = await makeDeps(t);
  const direct = await recallHandler(deps, { query: QUERY, k: 5, min_score: 0 });
  const hit = (direct.hits as { id: string; expired_on?: string }[]).find((h) => h.id === "expired");
  assert.ok(hit, JSON.stringify(direct.hits));
  assert.equal(hit.expired_on, "2026-02-01");
  const current = (direct.hits as { id: string; expired_on?: string }[]).find((h) => h.id === "current");
  assert.equal(current?.expired_on, undefined);

  // The forwarder's MCP recall runs through the hook endpoint, marked as MCP.
  const viaForwarder = await runHookRecall(
    { query: QUERY, k: 5, expand_hops: 0, hook_source: "mcp" },
    QUERY,
    Date.now(),
    deps
  );
  assert.ok(ids(viaForwarder.hits).includes("expired"));
});

test("#1468 a reflex rule past valid_until no longer fires automatically", () => {
  const rule = (extra: Record<string, unknown>) =>
    ({ fm: { id: "r", recall_mode: "reflex", ...extra } }) as unknown as Memory;
  assert.equal(isReflexPoolMember(rule({})), true);
  assert.equal(isReflexPoolMember(rule({ valid_until: "2026-01-01" })), false);
  assert.equal(isReflexPoolMember(rule({ valid_until: "2999-01-01" })), true);
});

test("#1468 session assembly omits expired memories from hints and pinned floors", async (t) => {
  const deps = await makeDeps(t);
  const hits = ["expired", "current", "aged"].map((id) => ({ id, score: 100, type: "decision", summary: id }));
  const floors = hits.map(({ id }) => ({
    memory_id: id,
    condition: "fixture",
    reason: "fixture floor",
    floored_at: "2026-01-01",
    last_affirmed: "2026-01-01",
  }));
  const response = { query: QUERY, vault_size: hits.length, hits, recall_id: "fixture-recall", latency_ms: 0 };
  const stubs: SessionContextDeps = {
    recallFn: async () => response,
    listFloorsFn: async () => floors,
    listConventionsFn: () => [],
  };
  const assembled = await assembleSessionSections(deps, deps.vault, {}, stubs);
  assert.deepEqual(assembled.data.recalls[0]?.resp, { ...response, hits: hits.slice(1) });
  assert.deepEqual(assembled.data.floors, floors.slice(1));
  const lines = assembled.sections.flatMap(({ lines }) => lines);
  assert.ok(lines.some((line) => /current/.test(line)));
  assert.ok(lines.some((line) => /aged/.test(line)));
  assert.ok(lines.every((line) => !/expired/.test(line)));
});
