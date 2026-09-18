import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGraph, graphDirOf, GRAPH_FILE_NAME, type LoadedGraph } from "../src/code-graph/reader.js";
import {
  affectedHits,
  affectedResult,
  changedSymbolsOf,
  narrowPackageHits,
  symbolsNamed,
  allSymbolsOf,
  MAX_AFFECTED_FILES,
  PACKAGE_IMPORT,
} from "../src/code-graph/affected.js";
import { workspaceModules } from "../src/code-graph/workspace-packages.js";

/**
 * A node in Graphify's real shape — the same helper the reader test uses,
 * because both are only worth anything if the fixture matches what Graphify
 * actually writes (measured on this repository's own graph).
 */
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

/** An EXTERNAL node: `external: true`, empty `source_file`, id is everything. */
function external(id: string) {
  return { id, label: id, file_type: "concept", source_file: "", external: true, type: "external" };
}

function edge(source: string, target: string, relation: string, confidence = "EXTRACTED") {
  return { source, target, relation, confidence, confidence_score: 0.85, _origin: "ast" };
}

/**
 * Two workspace packages, the shape that broke the file-level query: `@acme/core`
 * exports a barrel and one subpath, and `@acme/daemon` imports both by their
 * bare specifier — so nothing in the graph connects daemon to core directly.
 */
const NODES = [
  node("core_save_fn", "saveMemory()", "packages/core/src/save.ts", 40),
  node("core_save_input", "SaveMemoryInput", "packages/core/src/save.ts", 12),
  node("core_index_file", "index.ts", "packages/core/src/index.ts", 1),
  node("core_topics_fn", "detectProject()", "packages/core/src/topics.ts", 10),
  node("core_audit_fn", "auditSave()", "packages/core/src/audit-save.ts", 5),
  node("daemon_bridge_file", "bridge.ts", "packages/daemon/src/bridge.ts", 1),
  node("daemon_bridge_run", "run()", "packages/daemon/src/bridge.ts", 20),
  node("daemon_lane_file", "write-lane.ts", "packages/daemon/src/write-lane.ts", 1),
  external("ref_acme_core"),
  external("ref_acme_core_topics"),
  external("packages_core_dist_index_savememory"),
];

const LINKS = [
  edge("core_audit_fn", "core_save_fn", "calls"),
  edge("core_index_file", "core_save_fn", "re_exports"),
  edge("core_index_file", "core_topics_fn", "re_exports"),
  // The package boundary: no edge into core at all, only into an external node.
  edge("daemon_bridge_file", "ref_acme_core", "imports_from"),
  edge("daemon_lane_file", "ref_acme_core_topics", "imports_from"),
  // The other external shape: Graphify resolved the specifier to core's build
  // output and kept the symbol name.
  edge("daemon_bridge_run", "packages_core_dist_index_savememory", "imports"),
];

const GRAPH = {
  directed: true,
  multigraph: false,
  graph: {},
  built_at_commit: "5483f5697434bd20071d1b225a72e04db97a93e4",
  nodes: NODES,
  links: LINKS,
  hyperedges: [],
};

const SAVE_TS = "packages/core/src/save.ts";

/** The diff a change to `saveMemory` produces, in `git diff` shape. */
const SAVE_DIFF = [
  `diff --git a/${SAVE_TS} b/${SAVE_TS}`,
  "index 371cda7..00470b6 100644",
  `--- a/${SAVE_TS}`,
  `+++ b/${SAVE_TS}`,
  "@@ -41,1 +41,1 @@",
  "-  return write(input);",
  "+  return write(input, { audited: true });",
].join("\n");

let root: string;
let graph: LoadedGraph;

async function writeTree(): Promise<void> {
  const files: Array<[string, string]> = [
    ["package.json", JSON.stringify({ name: "acme", workspaces: ["packages/*"] })],
    [
      "packages/core/package.json",
      JSON.stringify({
        name: "@acme/core",
        main: "./dist/index.js",
        exports: {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
          "./topics": { import: "./dist/topics.js" },
        },
      }),
    ],
    ["packages/core/src/index.ts", "export {};\n"],
    ["packages/core/src/save.ts", "export function saveMemory() {}\n"],
    ["packages/core/src/topics.ts", "export function detectProject() {}\n"],
    ["packages/core/src/audit-save.ts", "export function auditSave() {}\n"],
    ["packages/daemon/package.json", JSON.stringify({ name: "@acme/daemon" })],
    ["packages/daemon/src/bridge.ts", 'import { saveMemory } from "@acme/core";\n'],
    ["packages/daemon/src/write-lane.ts", 'import { detectProject } from "@acme/core/topics";\n'],
  ];
  for (const [path, body] of files) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body, "utf8");
  }
  await mkdir(graphDirOf(root), { recursive: true });
  await writeFile(join(graphDirOf(root), GRAPH_FILE_NAME), JSON.stringify(GRAPH), "utf8");
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-affected-"));
  await writeTree();
  const loaded = await loadGraph(root);
  assert.equal(loaded.ok, true);
  graph = (loaded as { ok: true; graph: LoadedGraph }).graph;
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workspace packages", () => {
  it("maps a bare specifier and a subpath to their SOURCE files", () => {
    const modules = workspaceModules(root);
    assert.equal(modules.get("@acme/core"), "packages/core/src/index.ts");
    assert.equal(modules.get("@acme/core/topics"), "packages/core/src/topics.ts");
    assert.equal(modules.get("@acme/daemon"), undefined, "no main, no exports, no entry");
  });

  it("is empty rather than throwing outside a workspace", () => {
    assert.equal(workspaceModules(join(root, "packages", "core", "src")).size, 0);
  });
});

describe("external references", () => {
  it("indexes the package importers the graph itself has no edge for", () => {
    assert.deepEqual(graph.importersByEntry.get("packages/core/src/index.ts"), [
      "packages/daemon/src/bridge.ts",
    ]);
    assert.deepEqual(graph.importersByEntry.get("packages/core/src/topics.ts"), [
      "packages/daemon/src/write-lane.ts",
    ]);
  });

  it("folds a resolved-path external node back onto the real symbol", () => {
    const dependents = graph.dependentsBySymbol.get("core_save_fn") ?? [];
    assert.ok(
      dependents.some((d) => d.id === "daemon_bridge_run" && d.relation === "imports"),
      "the import through packages_core_dist_index_savememory reaches saveMemory",
    );
  });
});

describe("changed symbols from a diff", () => {
  it("attributes a changed line to the symbol it falls inside", () => {
    const changed = changedSymbolsOf(graph, SAVE_TS, SAVE_DIFF).map((s) => s.name);
    assert.deepEqual(changed, ["saveMemory"]);
  });

  it("also takes a symbol the diff only NAMES", () => {
    const diff = SAVE_DIFF.replace("+  return write(input, { audited: true });", "+  const x: SaveMemoryInput = input;");
    const changed = changedSymbolsOf(graph, SAVE_TS, diff).map((s) => s.name).sort();
    assert.deepEqual(changed, ["SaveMemoryInput", "saveMemory"]);
  });

  it("finds nothing in a diff that belongs to another file", () => {
    const other = SAVE_DIFF.replaceAll(SAVE_TS, "packages/core/src/topics.ts");
    assert.deepEqual(changedSymbolsOf(graph, SAVE_TS, other), []);
  });

  it("follows the re-export of a barrel whose diff names a symbol from elsewhere", () => {
    const barrel = "packages/core/src/index.ts";
    const diff = [
      `diff --git a/${barrel} b/${barrel}`,
      `--- a/${barrel}`,
      `+++ b/${barrel}`,
      "@@ -1,0 +2,1 @@",
      '+export { saveMemory } from "./save.js";',
    ].join("\n");
    const changed = changedSymbolsOf(graph, barrel, diff).map((s) => s.name);
    assert.ok(
      changed.includes("saveMemory"),
      "the barrel holds no symbols of its own, so the re-exported one is followed",
    );
  });
});

describe("affected files", () => {
  const changedSave = () => symbolsNamed(graph, SAVE_TS, ["saveMemory"]).found;

  it("reports the relation and the line of the depending site", () => {
    const hits = affectedHits(graph, SAVE_TS, changedSave());
    const call = hits.find((h) => h.file === "packages/core/src/audit-save.ts");
    assert.deepEqual(call, {
      file: "packages/core/src/audit-save.ts",
      location: "packages/core/src/audit-save.ts:5",
      via: "saveMemory",
      relation: "calls",
      depth: 1,
    });
  });

  it("crosses the package boundary the graph has no edge for", () => {
    const hits = affectedHits(graph, SAVE_TS, changedSave());
    const bridge = hits.filter((h) => h.file === "packages/daemon/src/bridge.ts");
    assert.ok(bridge.length > 0, "the daemon file that imports @acme/core is affected");
    assert.ok(
      bridge.some((h) => h.relation === PACKAGE_IMPORT),
      "and it is marked as the file-level, package-import kind of hit",
    );
  });

  it("does not drag in importers of an unrelated subpath", () => {
    const files = affectedHits(graph, SAVE_TS, changedSave()).map((h) => h.file);
    assert.ok(
      !files.includes("packages/daemon/src/write-lane.ts"),
      "@acme/core/topics does not re-export save.ts",
    );
  });

  it("prefers the specific entry over the barrel", () => {
    const topics = symbolsNamed(graph, "packages/core/src/topics.ts", ["detectProject"]).found;
    const files = affectedHits(graph, "packages/core/src/topics.ts", topics).map((h) => h.file);
    assert.ok(files.includes("packages/daemon/src/write-lane.ts"));
    assert.ok(
      !files.includes("packages/daemon/src/bridge.ts"),
      "topics.ts is its own export entry, so the barrel's importers stay out",
    );
  });

  it("never lists the changed file itself", () => {
    const hits = affectedHits(graph, SAVE_TS, allSymbolsOf(graph, SAVE_TS));
    assert.ok(hits.every((h) => h.file !== SAVE_TS));
  });

  it("reports an unknown symbol name instead of an empty blast radius", () => {
    const named = symbolsNamed(graph, SAVE_TS, ["saveMemory", "nosuchthing"]);
    assert.deepEqual(named.unknown, ["nosuchthing"]);
    assert.deepEqual(named.found.map((s) => s.name), ["saveMemory"]);
  });
});

describe("the answer", () => {
  it("keeps one line of evidence per file and caps on FILES", () => {
    const many = Array.from({ length: MAX_AFFECTED_FILES + 5 }, (_, i) => ({
      file: `packages/daemon/src/f${String(i).padStart(3, "0")}.ts`,
      location: `packages/daemon/src/f${String(i).padStart(3, "0")}.ts:1`,
      via: "saveMemory",
      relation: "calls",
      depth: 1,
    }));
    // The same file twice: two changed symbols reaching the same dependent.
    const result = affectedResult([], [...many, { ...many[0], via: "other" }]);
    assert.equal(result.files.length, MAX_AFFECTED_FILES);
    assert.equal(result.hits.length, MAX_AFFECTED_FILES);
    assert.equal(result.truncated, true);
    assert.equal(new Set(result.files).size, result.files.length);
  });
});

describe("narrowing package-level hits", () => {
  const packageHit = (file: string) => ({
    file,
    location: file,
    via: "packages/core/src/index.ts",
    relation: PACKAGE_IMPORT,
    depth: 1,
  });

  it("leaves a short candidate list untouched", async () => {
    const hits = [packageHit("packages/daemon/src/write-lane.ts")];
    assert.deepEqual(await narrowPackageHits(root, hits, ["saveMemory"]), hits);
  });

  it("drops long-list candidates whose text never names a changed symbol", async () => {
    // 21 candidates: past the point where a person reads them all. Only
    // bridge.ts mentions `saveMemory`; the rest do not exist on disk at all,
    // which is the stale-graph case and counts as no evidence.
    const hits = [
      packageHit("packages/daemon/src/bridge.ts"),
      packageHit("packages/daemon/src/write-lane.ts"),
      ...Array.from({ length: 19 }, (_, i) => packageHit(`packages/daemon/src/gone${i}.ts`)),
    ];
    const kept = await narrowPackageHits(root, hits, ["saveMemory"]);
    assert.deepEqual(kept.map((h) => h.file), ["packages/daemon/src/bridge.ts"]);
  });

  it("keeps everything when there is no symbol name to check against", async () => {
    const hits = Array.from({ length: 25 }, (_, i) => packageHit(`packages/daemon/src/g${i}.ts`));
    assert.equal((await narrowPackageHits(root, hits, [])).length, 25);
  });
});

/**
 * The fixture above is only worth anything if Graphify really writes what it
 * imitates. This runs against the graph of THIS repository when one has been
 * built, and skips otherwise — a checkout without `graphify-out/` is normal.
 */
describe("against the real graph of this repository", () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

  it("crosses the core/daemon package boundary", async (t) => {
    if (!existsSync(join(graphDirOf(repoRoot), GRAPH_FILE_NAME))) {
      t.skip("no graph built for this checkout");
      return;
    }
    const loaded = await loadGraph(repoRoot);
    assert.equal(loaded.ok, true);
    const real = (loaded as { ok: true; graph: LoadedGraph }).graph;
    // Which of the two external shapes carries it depends on whether core's
    // build output exists in the checkout Graphify saw: with `dist/` present
    // it resolves the specifier to a path and keeps the symbol name, without
    // it the specifier stays bare. Either way the boundary must be crossed.
    const save = (real.idsByLabel.get("savememory") ?? []).find(
      (id) => real.nodes.get(id)?.file === "packages/core/src/save.ts",
    );
    assert.ok(save !== undefined, "saveMemory is in the graph");
    const viaSymbol = (real.dependentsBySymbol.get(save) ?? []).some((d) =>
      real.nodes.get(d.id)?.file.startsWith("packages/daemon/"),
    );
    const viaPackage = (real.importersByEntry.get("packages/core/src/index.ts") ?? []).some((f) =>
      f.startsWith("packages/daemon/"),
    );
    assert.ok(
      viaSymbol || viaPackage,
      "daemon depends on core through @bastra-recall/core, for which the graph itself has no edge",
    );
  });
});
