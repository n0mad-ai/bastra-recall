/**
 * #1299 follow-up: the `recall` tool an assistant really calls goes through the
 * stdio forwarder, which streams `/hook/recall` (`callRecallStreaming`), not
 * the REST handler. Every hit on that path carries its `updated` day too —
 * single query, `queries` batch, both verbosities and the pool reflexes. The
 * hook lanes share the route and must not grow: their payload stays dateless.
 *
 * A real daemon HTTP server over a temporary vault; the forwarder module is
 * imported after `BASTRA_DAEMON_URL` points at it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";

function memo(id: string, body: string, updated: string, reflex = false): string {
  return [
    "---",
    `id: ${id}`,
    `title: Rule ${id}`,
    "type: lesson",
    `summary: ${body}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: fixture",
    ...(reflex ? ["recall_mode: reflex"] : []),
    "created: 2026-01-01",
    ...(updated ? [`updated: ${updated}`] : []),
    "---",
    "",
    body,
    "",
  ].join("\n");
}

type Hit = { id: string; updated?: string };

test("#1299: the forwarder's recall dates every hit, the hook lanes stay dateless", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-fwd-updated-"));
  await writeFile(join(dir, "deploy-a.md"), memo("deploy-a", "deploy release branch smoke test tag", "2026-03-04"));
  await writeFile(join(dir, "deploy-b.md"), memo("deploy-b", "deploy release checklist", "2026-05-06T10:00:00Z"));
  // No valid `updated`: falls back to the file's day, as on the REST path.
  await writeFile(join(dir, "deploy-c.md"), memo("deploy-c", "deploy release rollback notes", "someday"));
  await utimes(join(dir, "deploy-c.md"), new Date("2026-07-08T12:00:00Z"), new Date("2026-07-08T12:00:00Z"));
  // Wired but weakly matching: below the top-k cut, served as a pool reflex.
  await writeFile(join(dir, "reflex.md"), memo("reflex", "unrelated coffee words and one deploy", "2026-02-03", true));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  process.env.BASTRA_DAEMON_URL = `http://127.0.0.1:${handle.port}`;
  const { callRecallStreaming } = await import("../src/mcp-forwarder-calls.js");
  const expected: Record<string, string> = {
    "deploy-a": "2026-03-04",
    "deploy-b": "2026-05-06",
    "deploy-c": "2026-07-08",
    reflex: "2026-02-03",
  };
  const assertDated = (label: string, result: unknown) => {
    const r = result as { hits?: Hit[]; reflex_hits?: Hit[] };
    const all = [...(r.hits ?? []), ...(r.reflex_hits ?? [])];
    assert.ok((r.hits ?? []).length > 0, `${label}: fixture must produce hits`);
    for (const hit of all) assert.equal(hit.updated, expected[hit.id], `${label}: ${hit.id}`);
    return r;
  };

  const single = assertDated("single", await callRecallStreaming({ query: "deploy release", k: 3 }, () => undefined));
  assert.deepEqual(
    single.hits!.map((h) => h.id).sort(),
    ["deploy-a", "deploy-b", "deploy-c"],
    "all three dated variants are served"
  );
  const withReflex = assertDated(
    "reflex",
    await callRecallStreaming({ query: "deploy release branch smoke", k: 1 }, () => undefined)
  );
  assert.deepEqual(
    withReflex.reflex_hits?.map((h) => h.id),
    ["reflex"],
    "fixture: the wired memory rides as a pool reflex"
  );
  assertDated("full", await callRecallStreaming({ query: "deploy release", verbosity: "full" }, () => undefined));
  assertDated(
    "batch",
    await callRecallStreaming({ queries: ["deploy release branch", "rollback notes"], k: 4 }, () => undefined)
  );

  // The hook lanes call the same route without `hook_source: "mcp"`: no date,
  // so the injected hints and their budget are byte-for-byte what they were.
  const lane = (await (
    await fetch(`http://127.0.0.1:${handle.port}/hook/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "deploy release branch smoke", k: 1, hook_source: "prompt" }),
    })
  ).json()) as { hits: Hit[]; reflex_hits?: Hit[] };
  assert.ok(lane.hits.length > 0);
  for (const hit of [...lane.hits, ...(lane.reflex_hits ?? [])]) assert.equal("updated" in hit, false, hit.id);
});
