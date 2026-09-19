import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadGraph,
  dependentFilesOf,
  findSymbol,
  symbolsOfFile,
  graphFileOf,
  type LoadedGraph,
} from "../src/code-graph/reader.js";
import { CodeGraphCache } from "../src/code-graph/cache.js";

/**
 * The acceptance criteria of #575 against the REAL graph, not a fixture.
 *
 * `graphify-out/` is git-ignored, so this graph exists on a machine where
 * someone ran `bastra code index` and nowhere else — in CI there is nothing to
 * read. These tests therefore skip when the file is absent rather than fail:
 * a fixture-only suite proves the shape we invented, and this one proves the
 * shape Graphify actually writes. Both are needed; only one can be checked in.
 *
 * Rebuild it with:
 *   GRAPHIFY_QUERY_LOG_DISABLE=1 PYTHONHASHSEED=0 \
 *     ~/.bastra/tools/bin/graphify extract . --code-only
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HAVE_GRAPH = existsSync(graphFileOf(REPO_ROOT));

/** Loaded once: a cold load is ~20 ms and every test here wants it warm. */
let graph: LoadedGraph | null = null;

async function real(): Promise<LoadedGraph> {
  if (graph === null) {
    const r = await loadGraph(REPO_ROOT);
    assert.ok(r.ok, `expected the real graph to load, got ${r.ok === false ? r.reason : ""}`);
    graph = r.graph;
  }
  return graph;
}

describe("code graph: the real graph of this repository", { skip: !HAVE_GRAPH }, () => {
  it("loads a multi-megabyte graph within the file-size limit", async () => {
    const g = await real();
    const sizeMB = g.sizeBytes / 1024 / 1024;
    assert.ok(sizeMB > 1, `expected a real graph, got ${sizeMB.toFixed(1)} MB`);
    assert.ok(g.nodes.size > 1000, `expected thousands of nodes, got ${g.nodes.size}`);
  });

  it("resolves the known reference case: saveMemory is called from audit-save", async () => {
    // The spot-check from the 17.09.2026 evaluation, which found
    // `packages/core/src/audit-save.ts:69` by hand.
    const g = await real();
    const deps = dependentFilesOf(g, "packages/core/src/save.ts");
    assert.ok(
      deps.includes("packages/core/src/audit-save.ts"),
      `audit-save.ts missing from ${deps.length} dependents`,
    );
  });

  it("finds saveMemory at its real location", async () => {
    const g = await real();
    const hits = findSymbol(g, "saveMemory");
    assert.ok(hits.length > 0, "expected saveMemory in the graph");
    const inSave = hits.find((h) => h.file === "packages/core/src/save.ts");
    assert.ok(inSave, `saveMemory not found in save.ts; got ${hits.map((h) => h.file).join(", ")}`);
    assert.ok(inSave!.line !== null && inSave!.line > 0, "expected a usable line number");
  });

  it("lists the symbols of a real file", async () => {
    const g = await real();
    const symbols = symbolsOfFile(g, "packages/core/src/save.ts");
    assert.ok(symbols.length > 0, "expected save.ts to define symbols");
    assert.ok(symbols.every((s) => s.file === "packages/core/src/save.ts"));
  });

  it("holds the warm budget with room to spare (#575 acceptance)", async () => {
    const g = await real();
    const file = "packages/core/src/save.ts";
    dependentFilesOf(g, file); // one untimed call, so nothing here measures first-touch

    const runs: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      dependentFilesOf(g, file);
      runs.push(performance.now() - t);
    }
    runs.sort((a, b) => a - b);
    const p90 = runs[Math.floor(runs.length * 0.9)]!;
    // The acceptance figure is 10 ms; measured p90 is ~0.005 ms, so this
    // asserts the contract, not the measurement.
    assert.ok(p90 < 10, `warm p90 was ${p90.toFixed(3)} ms, budget is 10 ms`);
  });

  it("emits only repo-relative paths, never an escape", async () => {
    const g = await real();
    for (const n of g.nodes.values()) {
      assert.ok(!n.file.startsWith("/"), `absolute path survived: ${n.file}`);
      assert.ok(!n.file.includes(".."), `traversal survived: ${n.file}`);
    }
  });

  it("reports which relations of the real graph are on neither allowlist", async () => {
    const g = await real();
    // Not an assertion about WHICH ones — that is what `bastra doctor` shows.
    // The assertion is that we noticed them instead of silently ignoring them,
    // which was the counter-review's P2 finding.
    assert.ok(g.unknownRelations.size > 0, "the real graph has relations outside both lists");
  });

  it("serves the real graph through the cache after one async load", async () => {
    const cache = new CodeGraphCache();
    assert.equal(cache.get(REPO_ROOT), null, "a cold repo must not block the caller");
    await cache.ensureLoaded(REPO_ROOT);
    const warm = cache.get(REPO_ROOT);
    assert.ok(warm, "expected the real graph warm after the load");
    assert.ok(cache.stats().bytes > 0);
  });

  it("charges the real graph against the heap budget", async () => {
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(REPO_ROOT);
    const stats = cache.stats();
    assert.ok(stats.bytes <= stats.budgetBytes, "one repo must fit the daemon budget");
    assert.equal(stats.loadedRepos, 1);
  });
});
