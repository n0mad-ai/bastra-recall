import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphDirOf, GRAPH_FILE_NAME } from "../src/code-graph/reader.js";
import { CodeGraphCache } from "../src/code-graph/cache.js";
import {
  codeTools,
  findCode,
  MAX_DEPENDENTS,
  MAX_HITS,
  type FindCodeResult,
} from "../src/code-graph/find-code.js";
import { ALL_TOOL_DEFS, isToolAllowed } from "../src/tool-defs.js";

/**
 * `find_code` against a fixture graph in Graphify's real shape (#576).
 *
 * The fixture mirrors what the 17.09.2026 measurement found in the real
 * graph, because both details decide whether the tool answers at all:
 * callables are labelled `saveMemory()` with parentheses, and every file is
 * ALSO a node, labelled with its basename at `L1`. A fixture without the file
 * nodes would have hidden that they otherwise crowd the real callers out of
 * the one-hop budget.
 */

function node(id: string, label: string, file: string, line = 1, fileType = "code") {
  return {
    id,
    label,
    file_type: fileType,
    source_file: file,
    source_location: `L${line}`,
    community: 1,
    _origin: "ast",
  };
}

function edge(source: string, target: string, relation: string, confidence = "EXTRACTED") {
  return { source, target, relation, confidence, confidence_score: 0.85, _origin: "ast" };
}

const SAVE = "packages/core/src/save.ts";
const AUDIT = "packages/core/src/audit-save.ts";
const HANDLER = "packages/daemon/src/tool-handlers.ts";

/**
 * save.ts defines saveMemory(); audit-save.ts calls it; tool-handlers.ts calls
 * audit-save's wrapper, which is the second hop. `noise.ts` is in the graph
 * and depends on nothing.
 */
const FIXTURE = {
  directed: true,
  multigraph: false,
  graph: {},
  built_at_commit: "5483f5697434bd20071d1b225a72e04db97a93e4",
  nodes: [
    node("save_savememory", "saveMemory()", SAVE, 40),
    node("save_commit", "commitMemory()", SAVE, 147),
    node("save_result", "SaveMemoryResult", SAVE, 173),
    node("save_file", "save.ts", SAVE, 1),
    node("audit_auditedsave", "auditedSave()", AUDIT, 41),
    node("audit_file", "audit-save.ts", AUDIT, 1),
    node("handler_savehandler", "saveMemoryHandler()", HANDLER, 372),
    node("noise_helper", "helper()", "packages/core/src/noise.ts", 3),
    node("concept_rfc", "RFC 6761", "packages/core/src/egress.ts", 5, "concept"),
  ],
  links: [
    edge("audit_auditedsave", "save_savememory", "calls"),
    edge("audit_file", "save_savememory", "imports"),
    edge("handler_savehandler", "audit_auditedsave", "calls"),
    edge("noise_helper", "save_savememory", "calls", "INFERRED"),
    edge("save_file", "save_savememory", "contains"),
  ],
  hyperedges: [],
};

async function writeGraph(repoRoot: string, graph: unknown): Promise<void> {
  await mkdir(graphDirOf(repoRoot), { recursive: true });
  await writeFile(join(graphDirOf(repoRoot), GRAPH_FILE_NAME), JSON.stringify(graph), "utf8");
}

let root: string;
let repo: string;
let cache: CodeGraphCache;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-find-code-"));
  repo = join(root, "repo");
  await writeGraph(repo, FIXTURE);
  cache = new CodeGraphCache();
  await cache.ensureLoaded(repo);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const find = (query: string, extra: Record<string, unknown> = {}): FindCodeResult =>
  findCode(cache, { query, repo, ...extra });

describe("find_code: the exact lane", () => {
  it("resolves the acceptance case: a bare symbol name to file:line", () => {
    const r = find("saveMemory");
    assert.equal(r.status, "ok");
    assert.equal(r.lane, "symbol");
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0]?.location, `${SAVE}:40`);
    assert.equal(r.hits[0]?.symbol, "saveMemory");
    assert.equal(r.hits[0]?.kind, "function");
  });

  it("returns the direct callers, one hop, with their own file:line", () => {
    // `affected` is the mode that asks for dependents; `find` answers where
    // something IS and no longer ships the list (#579).
    const r = findCode(cache, { query: "saveMemory", mode: "affected", repo });
    const callers = r.hits[0]?.dependents ?? [];
    assert.ok(
      callers.some((d) => d.location === `${AUDIT}:41` && d.symbol === "auditedSave"),
      `expected auditedSave among ${JSON.stringify(callers)}`,
    );
    for (const d of callers) assert.equal(d.depth, 1, "one hop is the budget");
  });

  it("does not hop twice unless asked", () => {
    const r = findCode(cache, { query: "saveMemory", mode: "affected", repo });
    const callers = r.hits[0]?.dependents ?? [];
    assert.ok(
      !callers.some((d) => d.symbol === "saveMemoryHandler"),
      "the second hop must not appear at depth 1",
    );
  });

  it("matches a callable with or without Graphify's parentheses", () => {
    assert.equal(find("saveMemory()").hits[0]?.location, `${SAVE}:40`);
    assert.equal(find("SAVEMEMORY").hits[0]?.location, `${SAVE}:40`, "case-insensitive");
  });

  it("ranks real callers above the file nodes that import the same symbol", () => {
    const callers = find("saveMemory").hits[0]?.dependents ?? [];
    const firstFile = callers.findIndex((d) => d.kind === "file");
    const lastSymbol = callers.map((d) => d.kind !== "file").lastIndexOf(true);
    assert.ok(firstFile === -1 || firstFile > lastSymbol, "file nodes come last");
  });

  it("resolves a repo-relative path to the file's symbols and its dependents", () => {
    const r = find(SAVE);
    assert.equal(r.status, "ok");
    assert.equal(r.lane, "path");
    assert.ok(r.hits.some((h) => h.symbol === "commitMemory"));
    assert.deepEqual(r.files, [AUDIT], "the blast radius of the file, one hop");
    // The hop is spent on `files`; repeating it per symbol would say the same
    // thing once per symbol of the file.
    // `find` no longer ships a dependents list at all (#579) — absent, not empty.
    for (const h of r.hits) assert.equal(h.dependents, undefined);
  });

  it("never emits a non-code node", () => {
    assert.equal(find("RFC 6761").status, "no_answer");
  });
});

describe("find_code: honest empty results (§4.4 no_answer)", () => {
  it("says no_answer instead of returning a near-miss", () => {
    const r = find("saveMemoryToDisk");
    assert.equal(r.status, "no_answer");
    assert.deepEqual(r.hits, []);
    assert.ok(r.note && r.note.length > 0, "an empty result explains itself");
    assert.equal(r.lane, undefined);
  });

  it("refuses a query too short to mean anything", () => {
    assert.equal(find("sa").status, "no_answer");
  });

  it("does not treat an absolute path or a `..` escape as a path query", () => {
    assert.equal(find(`/${SAVE}`).status, "no_answer");
    assert.equal(find(`../${SAVE}`).status, "no_answer");
  });
});

describe("find_code: the lexical fallback", () => {
  it("runs only when the exact lane is empty, and labels itself", () => {
    const r = find("audit-sav");
    assert.equal(r.status, "ok");
    assert.equal(r.lane, "lexical");
    assert.ok(r.note?.includes("substring"), "the agent is told it is a substring match");
    assert.ok(r.hits.some((h) => h.location.startsWith(AUDIT)));
  });

  it("matches on paths as well as on symbol names", () => {
    const r = find("daemon/src/tool-hand");
    assert.equal(r.lane, "lexical");
    assert.ok(r.hits.some((h) => h.location.startsWith(HANDLER)));
  });
});

describe("find_code: affected mode", () => {
  it("answers 'what depends on this' for a symbol, one hop", () => {
    const r = find("saveMemory", { mode: "affected" });
    assert.equal(r.status, "ok");
    assert.equal(r.mode, "affected");
    assert.ok((r.hits[0]?.dependents ?? []).some((d) => d.symbol === "auditedSave"));
  });

  it("walks a second hop only when asked, and marks its depth", () => {
    const r = find("saveMemory", { mode: "affected", depth: 2 });
    const second = (r.hits[0]?.dependents ?? []).filter((d) => d.depth === 2);
    assert.ok(
      second.some((d) => d.symbol === "saveMemoryHandler"),
      `expected the second hop, got ${JSON.stringify(second)}`,
    );
  });

  it("matches exactly only — a blast radius from a substring guess is worse than none", () => {
    const exact = find("audit-sav");
    assert.equal(exact.lane, "lexical", "the same query DOES match lexically in find mode");
    const r = find("audit-sav", { mode: "affected" });
    assert.equal(r.status, "no_answer");
    assert.deepEqual(r.hits, []);
  });
});

describe("find_code: budgets", () => {
  let wideRepo: string;
  let wideCache: CodeGraphCache;

  before(async () => {
    // One symbol with 30 callers, and 30 symbols sharing a substring.
    const nodes = [node("hub_hub", "hub()", "src/hub.ts", 1)];
    const links = [];
    for (let i = 0; i < 30; i++) {
      nodes.push(node(`caller_${i}`, `hubCaller${i}()`, `src/caller-${i}.ts`, i + 1));
      links.push(edge(`caller_${i}`, "hub_hub", "calls"));
    }
    wideRepo = join(root, "wide");
    await writeGraph(wideRepo, { ...FIXTURE, nodes, links });
    wideCache = new CodeGraphCache();
    await wideCache.ensureLoaded(wideRepo);
  });

  it("caps the hop and says that it did", () => {
    const r = findCode(wideCache, { query: "hub", mode: "affected", repo: wideRepo });
    assert.equal(r.hits[0]?.dependents?.length, MAX_DEPENDENTS);
    assert.equal(r.hits[0]?.dependents_truncated, true);
  });

  it("caps the anchors and says that it did", () => {
    const r = findCode(wideCache, { query: "hubCaller", repo: wideRepo });
    assert.equal(r.lane, "lexical");
    assert.equal(r.hits.length, MAX_HITS);
    assert.equal(r.truncated, true);
  });
});

describe("find_code: a cold or degraded graph is not an error", () => {
  it("answers unavailable immediately instead of waiting for a cold load", () => {
    const cold = new CodeGraphCache();
    const started = performance.now();
    const r = findCode(cold, { query: "saveMemory", repo });
    const tookMs = performance.now() - started;
    assert.equal(r.status, "unavailable");
    assert.deepEqual(r.hits, []);
    assert.ok(r.note?.includes("Grep"), "the agent is told what to do instead");
    // A cold load of a real graph costs 20-26 ms; this must not have waited.
    assert.ok(tookMs < 15, `expected an immediate answer, took ${tookMs.toFixed(1)} ms`);
  });

  it("names the refusal when the graph was rejected, not just 'loading'", async () => {
    const brokenRepo = join(root, "broken");
    await mkdir(graphDirOf(brokenRepo), { recursive: true });
    await writeFile(join(graphDirOf(brokenRepo), GRAPH_FILE_NAME), "{ not json", "utf8");
    const broken = new CodeGraphCache();
    await broken.ensureLoaded(brokenRepo);
    const r = findCode(broken, { query: "saveMemory", repo: brokenRepo });
    assert.equal(r.status, "unavailable");
    assert.ok(r.note?.includes("not-json"), `expected the reason, got: ${r.note}`);
  });

  it("reports a repository with no graph at all as unavailable, not empty", async () => {
    const bare = join(root, "bare");
    await mkdir(bare, { recursive: true });
    const c = new CodeGraphCache();
    await c.ensureLoaded(bare);
    assert.equal(findCode(c, { query: "saveMemory", repo: bare }).status, "unavailable");
  });
});

describe("find_code: registration", () => {
  it("is in the canonical tool list exactly once", () => {
    const names = ALL_TOOL_DEFS.map((d) => d.name).filter((n) => n === "find_code");
    assert.deepEqual(names, ["find_code"]);
  });

  it("is annotated read-only, so clients can bulk-approve it", () => {
    const def = codeTools.find((t) => t.name === "find_code");
    assert.equal(def?.annotations.readOnlyHint, true);
    assert.equal(def?.annotations.destructiveHint, false);
  });

  it("is reachable on the read-only tool surface", () => {
    assert.equal(isToolAllowed("find_code", "search"), true);
    assert.equal(isToolAllowed("find_code", "write"), true);
  });
});

/**
 * #576 acceptance: "the forwarder and REST paths return the same result as
 * MCP". The forwarder is a pure pass-through to `POST /api/v1/<tool>`, so the
 * seam that can actually diverge is the REST dispatcher — and the one thing
 * that would make it diverge silently is a second cache instance, which would
 * leave one door permanently cold. Hence `setSharedCodeGraphCache`, and hence
 * this test.
 */
describe("find_code: the REST door answers like the in-process one", () => {
  it("returns the same payload over POST /api/v1/find_code", async () => {
    const { startHttpServer } = await import("../src/http.js");
    const { Vault, SearchIndex } = await import("@bastra-recall/core");
    const { Telemetry } = await import("../src/telemetry.js");
    const { setSharedCodeGraphCache } = await import("../src/code-graph/find-code.js");

    // The dispatcher reaches for the shared cache; hand it the warm one this
    // suite already built instead of letting it create a cold second.
    setSharedCodeGraphCache(cache);

    const dir = join(root, "vault");
    await mkdir(dir, { recursive: true });
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
      version: "test-version",
      toolDeps: { vault, search, telemetry, vaultPath: dir },
      documentWriteEnabled: false,
      embedding: { on: false, providerId: null, source: "none" },
    });

    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/v1/find_code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "saveMemory", repo }),
      });
      assert.equal(res.status, 200);
      const overRest = (await res.json()) as FindCodeResult;
      const inProcess = find("saveMemory");
      // `took_ms` is measured per call and legitimately differs.
      assert.deepEqual({ ...overRest, took_ms: 0 }, { ...inProcess, took_ms: 0 });
      assert.equal(overRest.hits[0]?.location, `${SAVE}:40`);
    } finally {
      search.stop();
      await vault.stop?.();
      await handle.close();
    }
  });
});
