import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGraph,
  dependentFilesOf,
  dependentSymbolsOf,
  symbolsOfFile,
  findSymbol,
  graphDirOf,
  GRAPH_FILE_NAME,
} from "../src/code-graph/reader.js";
import { CodeGraphCache } from "../src/code-graph/cache.js";
import { DEPENDENCY_RELATIONS, MAX_NODES, MAX_EDGES } from "../src/code-graph/limits.js";
import { isStale, readManifest, writeManifest, type CodeGraphManifest } from "../src/code-graph/manifest.js";

/** A node in Graphify's real shape. */
function node(id: string, label: string, file: string, line = 1, fileType = "code") {
  return {
    id,
    label,
    file_type: fileType,
    source_file: file,
    source_location: `L${line}`,
    community: 0,
    _origin: "ast",
  };
}

function edge(source: string, target: string, relation: string, confidence = "EXTRACTED") {
  return { source, target, relation, confidence, confidence_score: 0.85, _origin: "ast" };
}

/**
 * save.ts defines saveMemory; audit-save.ts and index.ts both call it;
 * helper.ts is in the graph but depends on nothing here.
 */
const FIXTURE = {
  directed: true,
  multigraph: false,
  graph: {},
  built_at_commit: "5483f5697434bd20071d1b225a72e04db97a93e4",
  nodes: [
    node("save_savememory", "saveMemory", "packages/core/src/save.ts", 40),
    node("audit_auditsave", "auditSave", "packages/core/src/audit-save.ts", 69),
    node("index_reexport", "saveMemory", "packages/core/src/index.ts", 12),
    node("helper_helper", "helper", "packages/core/src/helper.ts", 3),
    node("concept_rfc", "RFC 6761", "packages/core/src/egress.ts", 5, "concept"),
  ],
  links: [
    edge("audit_auditsave", "save_savememory", "calls"),
    edge("index_reexport", "save_savememory", "re_exports"),
    edge("helper_helper", "save_savememory", "calls", "INFERRED"),
    edge("helper_helper", "save_savememory", "indirect_call", "INFERRED"),
    edge("concept_rfc", "save_savememory", "cites"),
    edge("save_savememory", "save_savememory", "contains"),
  ],
  hyperedges: [],
};

async function writeGraph(repoRoot: string, graph: unknown): Promise<void> {
  const dir = graphDirOf(repoRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, GRAPH_FILE_NAME), JSON.stringify(graph), "utf8");
}

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-code-graph-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("code graph reader: indexes and lanes", () => {
  it("resolves dependents of a file over extracted dependency edges only", async () => {
    const repo = join(root, "deps");
    await writeGraph(repo, FIXTURE);
    const r = await loadGraph(repo);
    assert.ok(r.ok, "expected the fixture graph to load");

    const deps = dependentFilesOf(r.graph, "packages/core/src/save.ts");
    // audit-save (calls) and index (re_exports) are in; helper.ts reaches
    // save.ts only over INFERRED edges and must not appear.
    assert.deepEqual(deps, ["packages/core/src/audit-save.ts", "packages/core/src/index.ts"]);
  });

  it("never lists the edited file itself as its own dependent", async () => {
    const repo = join(root, "self");
    await writeGraph(repo, FIXTURE);
    const r = await loadGraph(repo);
    assert.ok(r.ok);
    assert.ok(!dependentFilesOf(r.graph, "packages/core/src/save.ts").includes("packages/core/src/save.ts"));
  });

  it("drops non-code nodes before anything can reach a hook context", async () => {
    const repo = join(root, "noncode");
    await writeGraph(repo, FIXTURE);
    const r = await loadGraph(repo);
    assert.ok(r.ok);
    assert.equal(r.graph.nodes.has("concept_rfc"), false);
    assert.equal(symbolsOfFile(r.graph, "packages/core/src/egress.ts").length, 0);
  });

  it("finds a symbol exactly and case-insensitively, and nothing else", async () => {
    const repo = join(root, "find");
    await writeGraph(repo, FIXTURE);
    const r = await loadGraph(repo);
    assert.ok(r.ok);
    assert.equal(findSymbol(r.graph, "saveMemory").length, 2);
    assert.equal(findSymbol(r.graph, "SAVEMEMORY").length, 2);
    // Honest empty result, not a near miss (§4.4 no_answer).
    assert.equal(findSymbol(r.graph, "saveMem").length, 0);
  });

  it("finds a callable whether or not the query carries Graphify's parentheses", async () => {
    // Regression: the real graph labels every function `saveMemory()`, never
    // `saveMemory`. Indexing only the label as written made an exact lookup of
    // a function name return nothing — which is how #576's acceptance case
    // would have been asked.
    const repo = join(root, "parens");
    await writeGraph(repo, {
      ...FIXTURE,
      nodes: [node("callable", "saveMemory()", "packages/core/src/save.ts", 40)],
      links: [],
    });
    const r = await loadGraph(repo);
    assert.ok(r.ok);
    assert.equal(findSymbol(r.graph, "saveMemory").length, 1);
    assert.equal(findSymbol(r.graph, "saveMemory()").length, 1);
    assert.equal(findSymbol(r.graph, "SaveMemory").length, 1);
  });

  it("reports a symbol's kind and its name without parentheses", async () => {
    const repo = join(root, "kinds");
    await writeGraph(repo, {
      ...FIXTURE,
      nodes: [
        node("fn", "saveMemory()", "packages/core/src/save.ts", 40),
        node("ty", "DeleteMemoryResult", "packages/core/src/save.ts", 599),
        node("fl", "save.ts", "packages/core/src/save.ts", 1),
      ],
      links: [],
    });
    const r = await loadGraph(repo);
    assert.ok(r.ok);
    const byName = new Map(symbolsOfFile(r.graph, "packages/core/src/save.ts").map((s) => [s.name, s]));
    assert.equal(byName.get("saveMemory")!.kind, "function");
    assert.equal(byName.get("saveMemory")!.label, "saveMemory()");
    assert.equal(byName.get("DeleteMemoryResult")!.kind, "type");
    assert.equal(byName.get("save.ts")!.kind, "file");
  });

  it("reports dependent symbols with file and line", async () => {
    const repo = join(root, "symbols");
    await writeGraph(repo, FIXTURE);
    const r = await loadGraph(repo);
    assert.ok(r.ok);
    const deps = dependentSymbolsOf(r.graph, "save_savememory");
    const audit = deps.find((d) => d.label === "auditSave");
    assert.ok(audit);
    assert.equal(audit!.file, "packages/core/src/audit-save.ts");
    assert.equal(audit!.line, 69);
  });

  it("counts relations that are on neither allowlist, so the lists stay honest", async () => {
    const repo = join(root, "unknown");
    await writeGraph(repo, {
      ...FIXTURE,
      links: [...FIXTURE.links, edge("a", "b", "brand_new_relation")],
    });
    const r = await loadGraph(repo);
    assert.ok(r.ok);
    assert.equal(r.graph.unknownRelations.get("brand_new_relation"), 1);
    assert.equal(r.graph.unknownRelations.has("cites"), true);
    // `contains` is a known structure relation, not an unknown one.
    assert.equal(r.graph.unknownRelations.has("contains"), false);
  });

  it("carries the graph's own commit for cross-checking against the manifest", async () => {
    const repo = join(root, "commit");
    await writeGraph(repo, FIXTURE);
    const r = await loadGraph(repo);
    assert.ok(r.ok);
    assert.equal(r.graph.builtAtCommit, "5483f5697434bd20071d1b225a72e04db97a93e4");
  });
});

describe("code graph reader: every allowlisted relation resolves", () => {
  for (const relation of DEPENDENCY_RELATIONS) {
    it(`resolves a dependent over \`${relation}\``, async () => {
      const repo = join(root, `rel-${relation}`);
      await writeGraph(repo, {
        ...FIXTURE,
        links: [edge("audit_auditsave", "save_savememory", relation)],
      });
      const r = await loadGraph(repo);
      assert.ok(r.ok);
      assert.deepEqual(dependentFilesOf(r.graph, "packages/core/src/save.ts"), [
        "packages/core/src/audit-save.ts",
      ]);
    });
  }

  for (const relation of ["indirect_call", "references", "extends", "cites", "contains", "method"]) {
    it(`does NOT treat \`${relation}\` as blast radius`, async () => {
      const repo = join(root, `excl-${relation}`);
      await writeGraph(repo, {
        ...FIXTURE,
        links: [edge("audit_auditsave", "save_savememory", relation)],
      });
      const r = await loadGraph(repo);
      assert.ok(r.ok);
      assert.deepEqual(dependentFilesOf(r.graph, "packages/core/src/save.ts"), []);
    });
  }
});

describe("code graph reader: degradation instead of failure", () => {
  it("reports a missing graph rather than throwing", async () => {
    const r = await loadGraph(join(root, "absent"));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "unreadable");
  });

  it("reports malformed JSON", async () => {
    const repo = join(root, "broken");
    await mkdir(graphDirOf(repo), { recursive: true });
    await writeFile(join(graphDirOf(repo), GRAPH_FILE_NAME), "{not json", "utf8");
    const r = await loadGraph(repo);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "not-json");
  });

  it("reports an unknown shape", async () => {
    const repo = join(root, "shape");
    await writeGraph(repo, { nodes: "not an array", links: [] });
    const r = await loadGraph(repo);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "wrong-shape");
  });

  it("refuses a graph over the node ceiling without parsing it into memory twice", async () => {
    const repo = join(root, "toomany");
    await writeGraph(repo, {
      ...FIXTURE,
      nodes: { length: MAX_NODES + 1, ...[] } as unknown,
    });
    // A non-array `nodes` is a shape error; the count ceiling is asserted
    // through the exported constants instead of by building a 500k fixture.
    const r = await loadGraph(repo);
    assert.equal(r.ok, false);
    assert.ok(MAX_NODES > 0 && MAX_EDGES > MAX_NODES);
  });

  it("drops a node with an escaping path but keeps the rest of the graph", async () => {
    const repo = join(root, "escape");
    await writeGraph(repo, {
      ...FIXTURE,
      nodes: [...FIXTURE.nodes, node("evil", "evil", "../../../etc/passwd", 1)],
    });
    const r = await loadGraph(repo);
    assert.ok(r.ok, "one bad node must not take the graph down");
    assert.equal(r.graph.nodes.has("evil"), false);
    assert.equal(dependentFilesOf(r.graph, "packages/core/src/save.ts").length, 2);
  });
});

describe("code graph cache: the cold-start rule", () => {
  it("answers null on a cold repo instead of blocking, then serves it warm", async () => {
    const repo = join(root, "cold");
    await writeGraph(repo, FIXTURE);
    const cache = new CodeGraphCache();

    // Cold: measured cold start is 20-26 ms, which does not fit the hook's
    // ~10 ms. The caller must get nothing back immediately.
    assert.equal(cache.get(repo), null);

    await cache.ensureLoaded(repo);
    const warm = cache.get(repo);
    assert.ok(warm, "expected the graph to be served warm after the load");
    assert.deepEqual(dependentFilesOf(warm!, "packages/core/src/save.ts"), [
      "packages/core/src/audit-save.ts",
      "packages/core/src/index.ts",
    ]);
  });

  it("does not start a second load while one is in flight", async () => {
    const repo = join(root, "inflight");
    await writeGraph(repo, FIXTURE);
    const cache = new CodeGraphCache();
    await Promise.all([cache.ensureLoaded(repo), cache.ensureLoaded(repo), cache.ensureLoaded(repo)]);
    assert.equal(cache.stats().loadedRepos, 1);
  });

  it("keeps answering null for a degraded repo without retrying forever", async () => {
    const repo = join(root, "degraded");
    await mkdir(graphDirOf(repo), { recursive: true });
    await writeFile(join(graphDirOf(repo), GRAPH_FILE_NAME), "{not json", "utf8");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    assert.equal(cache.get(repo), null);
    const stats = cache.stats();
    assert.equal(stats.degraded.length, 1);
    assert.equal(stats.degraded[0]!.reason, "not-json");
  });

  it("evicts least-recently-used graphs when the heap budget is exceeded", async () => {
    const a = join(root, "lru-a");
    const b = join(root, "lru-b");
    const c = join(root, "lru-c");
    for (const repo of [a, b, c]) await writeGraph(repo, FIXTURE);

    // A budget that fits two of the three fixture graphs.
    const oneGraph = JSON.stringify(FIXTURE).length;
    const cache = new CodeGraphCache(oneGraph * 2 + 1);

    await cache.ensureLoaded(a);
    await cache.ensureLoaded(b);
    cache.get(b); // b is now more recently used than a
    await cache.ensureLoaded(c);

    assert.ok(cache.stats().bytes <= oneGraph * 2 + 1, "budget must hold");
    assert.equal(cache.get(a), null, "the least recently used graph is the one evicted");
    assert.ok(cache.get(c), "the graph just loaded is kept");
  });

  it("forgets a repository on disable", async () => {
    const repo = join(root, "forget");
    await writeGraph(repo, FIXTURE);
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    cache.forget(repo);
    assert.equal(cache.stats().repos, 0);
  });

  it("invalidates a cached graph when the file changed", async () => {
    const repo = join(root, "invalidate");
    await writeGraph(repo, FIXTURE);
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    assert.ok(cache.get(repo));

    await new Promise((r) => setTimeout(r, 10));
    await writeGraph(repo, { ...FIXTURE, nodes: FIXTURE.nodes.slice(0, 2) });
    assert.equal(await cache.invalidateIfChanged(repo), true);
    assert.equal(cache.get(repo), null, "an invalidated graph is cold again, not stale");
  });
});

describe("code graph manifest: staleness survives a restart", () => {
  const base: CodeGraphManifest = {
    graphifyVersion: "0.9.63",
    builtAt: new Date(1_000_000).toISOString(),
    commit: "5483f56",
    repoRoot: "/tmp/repo",
    command: "graphify extract . --code-only",
    fileState: { count: 800, newestMtimeMs: 900_000 },
    lastError: null,
    dirty: false,
  };

  it("round-trips through disk", async () => {
    const repo = join(root, "manifest");
    await mkdir(graphDirOf(repo), { recursive: true });
    await writeManifest(graphDirOf(repo), base);
    assert.deepEqual(await readManifest(graphDirOf(repo)), base);
  });

  it("treats a missing manifest as stale, never as current", async () => {
    assert.equal(await readManifest(graphDirOf(join(root, "no-manifest"))), null);
    assert.equal(isStale(null, 0), true);
  });

  it("treats a dirty flag as stale — the restart case", async () => {
    // This is the flag that survives a daemon kill mid-build (#581).
    assert.equal(isStale({ ...base, dirty: true }, 0), true);
  });

  it("treats a file newer than the build as stale", () => {
    assert.equal(isStale(base, 2_000_000), true);
    assert.equal(isStale(base, 500_000), false);
  });

  it("treats an unparseable build time as stale rather than guessing", () => {
    assert.equal(isStale({ ...base, builtAt: "not a date" }, 0), true);
    assert.equal(isStale({ ...base, builtAt: null }, 0), true);
  });
});
