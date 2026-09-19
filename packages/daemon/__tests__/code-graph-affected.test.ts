import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGraph,
  graphDirOf,
  GRAPH_FILE_NAME,
  type LoadedGraph,
} from "../src/code-graph/reader.js";
import {
  affectedHits,
  affectedResult,
  changedLines,
  changedSymbolsOf,
  diffSymbols,
  narrowPackageHits,
  symbolsNamed,
  allSymbolsOf,
  MAX_AFFECTED_FILES,
  PACKAGE_IMPORT,
} from "../src/code-graph/affected.js";
import { diffLines } from "../src/code-graph/diff-lines.js";
import { workspaceModules } from "../src/code-graph/workspace-packages.js";
import { externalRefLines } from "../src/code-graph/external-refs.js";
import { createHash } from "node:crypto";
import { CodeGraphCache } from "../src/code-graph/cache.js";
import { affectedTools, findAffectedFiles } from "../src/code-graph/find-affected-files.js";
import {
  CODE_AWARENESS_CLAUSE,
  SERVER_INSTRUCTIONS,
  serverInstructions,
} from "../src/mcp-instructions.js";

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
  // Two adjacent functions in one file, for the diff-to-line mapping below.
  node("core_pair_first", "first()", "packages/core/src/pair.ts", 1),
  node("core_pair_second", "second()", "packages/core/src/pair.ts", 7),
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
const PAIR_TS = "packages/core/src/pair.ts";

/**
 * Two functions, the second one below three lines the change inserted into the
 * first. This is the shape that made the OLD-side reading of a diff pick the
 * wrong symbol: on the old side `second`'s changed line still had the number a
 * line inside `first` has in the working tree.
 */
const PAIR_SOURCE = [
  "export function first() {", // 1
  "  return 1;", // 2
  "  // inserted x", // 3
  "  // inserted y", // 4
  "  // inserted z", // 5
  "}", // 6
  "export function second() {", // 7
  "  return 22;", // 8
  "}", // 9
  "", // 10
].join("\n");

const PAIR_DIFF = [
  `diff --git a/${PAIR_TS} b/${PAIR_TS}`,
  `--- a/${PAIR_TS}`,
  `+++ b/${PAIR_TS}`,
  "@@ -2,0 +3,3 @@",
  "+  // inserted x",
  "+  // inserted y",
  "+  // inserted z",
  "@@ -5,1 +8,1 @@",
  "-  return 2;",
  "+  return 22;",
].join("\n");

/**
 * `save.ts` with the LINES the graph claims: `SaveMemoryInput` at 12,
 * `saveMemory` at 40. The fixture needs the real line count because a symbol's
 * end is read off the source (`symbol-spans.ts`) — a one-line stand-in would
 * put every hunk outside every symbol.
 */
const SAVE_SOURCE = [
  ...Array<string>(11).fill("// header"),
  "export interface SaveMemoryInput {", // 12
  "  text: string;",
  "}",
  ...Array<string>(25).fill(""),
  "export function saveMemory(input: SaveMemoryInput) {", // 40
  "  return write(input);", // 41
  "}",
  "",
].join("\n");

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
    ["packages/core/src/save.ts", SAVE_SOURCE],
    [PAIR_TS, PAIR_SOURCE],
    ["packages/core/src/topics.ts", "export function detectProject() {}\n"],
    ["packages/core/src/audit-save.ts", "export function auditSave() {}\n"],
    ["packages/daemon/package.json", JSON.stringify({ name: "@acme/daemon" })],
    ["packages/daemon/src/bridge.ts", 'import { saveMemory } from "@acme/core";\n'],
    ["packages/daemon/src/write-lane.ts", 'import { detectProject } from "@acme/core/topics";\n'],
    // A barrel that passes everything on without naming anything, and a file
    // that names nothing at all — the two sides of the narrowing check.
    ["packages/daemon/src/barrel.ts", 'export * from "./bridge.js";\n'],
    ...Array.from({ length: 19 }, (_, i): [string, string] => [
      `packages/daemon/src/plain${i}.ts`,
      "export const value = 1;\n",
    ]),
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

  it("reads a PNPM workspace, where package.json declares nothing", async () => {
    // Measured on a real pnpm monorepo: reading only package.json resolved
    // zero specifiers, so the whole package boundary was silently missing.
    const pnpm = await mkdtemp(join(tmpdir(), "bastra-pnpm-"));
    try {
      await mkdir(join(pnpm, "packages", "db", "src"), { recursive: true });
      await writeFile(join(pnpm, "package.json"), JSON.stringify({ name: "root" }), "utf8");
      await writeFile(
        join(pnpm, "pnpm-workspace.yaml"),
        'packages:\n  - "apps/*"\n  - "packages/*"\n',
        "utf8",
      );
      await writeFile(
        join(pnpm, "packages", "db", "package.json"),
        // Consumed as raw source: `main` points at the .ts, not at a build dir.
        JSON.stringify({ name: "@acme/db", main: "./src/index.ts" }),
        "utf8",
      );
      await writeFile(join(pnpm, "packages", "db", "src", "index.ts"), "export {};\n", "utf8");
      const modules = workspaceModules(pnpm);
      assert.equal(modules.get("@acme/db"), "packages/db/src/index.ts");
    } finally {
      await rm(pnpm, { recursive: true, force: true });
    }
  });

  it("expands a WILDCARD subpath export, and finds a package a deep glob names", async () => {
    // `"./*": "./dist/*.js"` is what a generated `exports` map looks like, and
    // `packages/**` is pnpm's own default. Neither resolved before: the
    // package boundary was then missing for the whole package, silently.
    const wild = await mkdtemp(join(tmpdir(), "bastra-wild-"));
    try {
      const pkg = join(wild, "packages", "group", "ui");
      await mkdir(join(pkg, "src", "forms"), { recursive: true });
      await writeFile(
        join(wild, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["packages/**"] }),
        "utf8",
      );
      await writeFile(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "@acme/ui",
          exports: { ".": "./dist/index.js", "./*": { import: "./dist/*.js" } },
        }),
        "utf8",
      );
      for (const file of ["index.ts", "button.ts", "forms/input.ts"]) {
        await writeFile(join(pkg, "src", file), "export {};\n", "utf8");
      }
      const modules = workspaceModules(wild);
      assert.equal(modules.get("@acme/ui"), "packages/group/ui/src/index.ts");
      assert.equal(modules.get("@acme/ui/button"), "packages/group/ui/src/button.ts");
      assert.equal(
        modules.get("@acme/ui/forms/input"),
        "packages/group/ui/src/forms/input.ts",
        "the star spans a slash, the way Node resolves it",
      );
    } finally {
      await rm(wild, { recursive: true, force: true });
    }
  });

  it("matches a star in the MIDDLE of a workspace pattern", async () => {
    const apps = await mkdtemp(join(tmpdir(), "bastra-apps-"));
    try {
      await mkdir(join(apps, "apps", "web", "server", "src"), { recursive: true });
      await mkdir(join(apps, "apps", "web", "docs"), { recursive: true });
      await writeFile(
        join(apps, "package.json"),
        JSON.stringify({ name: "root", workspaces: ["apps/*/server"] }),
        "utf8",
      );
      await writeFile(
        join(apps, "apps", "web", "server", "package.json"),
        JSON.stringify({ name: "@acme/server", main: "./src/index.ts" }),
        "utf8",
      );
      await writeFile(join(apps, "apps", "web", "server", "src", "index.ts"), "export {};\n", "utf8");
      assert.equal(
        workspaceModules(apps).get("@acme/server"),
        "apps/web/server/src/index.ts",
      );
    } finally {
      await rm(apps, { recursive: true, force: true });
    }
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

describe("an unavailable answer is honest about why", () => {
  it("a repository nobody enabled is told so, with the command that changes it", async () => {
    const off = new CodeGraphCache(undefined, () => false);
    const r = await findAffectedFiles(off, { file: "x.ts", repo: root });
    assert.equal(r.status, "unavailable");
    assert.match(r.note, /not enabled/);
    assert.match(r.note, /bastra code enable/);
    assert.doesNotMatch(r.note, /loading|being read/i, "nothing is loading — saying so sends the agent back for nothing");
  });

  it("an enabled repository without a graph is told to index, not to wait", async () => {
    const empty = await mkdtemp(join(tmpdir(), "bastra-nograph-"));
    try {
      const r = await findAffectedFiles(new CodeGraphCache(), { file: "x.ts", repo: empty });
      assert.match(r.note, /no code graph yet/);
      assert.match(r.note, /bastra code index/);
      assert.match(r.note, /will not have it either/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("the frozen measurement surface is untouched by any of this (#582)", async () => {
    // The registration pins these two hashes; changing a note must not move
    // them, or the run measures something other than what was registered.
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    assert.equal(
      sha(JSON.stringify(affectedTools[0])),
      "e8e51b5e0c80e6d7e18e009d18624265de9a515c26b95c728ec3b0507ed48b96",
      "find_affected_files tool definition changed — arms.frozen_surface in the registration no longer matches",
    );
    assert.equal(
      sha(serverInstructions(true)),
      "63a1bac0f13ff91069ca72dde2a5a8be859922df0c83e85d89c30594220bd07c",
      "server instructions changed — arms.frozen_surface in the registration no longer matches",
    );
    // THE PARTS, SEPARATELY. The combined hash alone let the two come apart:
    // 2f9dc47 rewrote the code clause, updated the combined hash and left
    // `code_clause_sha256` at version 5's value, and nothing said so for a day
    // (#582 review). A hash that is only ever checked as a sum hides which half
    // moved, which is the one thing these fields exist to say.
    assert.equal(
      sha(SERVER_INSTRUCTIONS),
      "0b92d332e295c9ce32d925bfc53d5186afb1c6f2073d8611bacfaea5496ce78b",
      "the memory policy changed — memory_part_sha256 in the registration no longer matches",
    );
    assert.equal(
      sha(CODE_AWARENESS_CLAUSE),
      "df5bea2ca78a20343767657b0165983d8f23b4f9e1b1a34be86a663b7e041348",
      "the code clause changed — code_clause_sha256 in the registration no longer matches",
    );
  });

  it("the registration carries the very hashes this test pins (#582 review)", async () => {
    // The drift above was between the FILE and the code, not inside either, so
    // a test that only pins the code would not have caught it either.
    const reg = JSON.parse(
      await readFile(
        new URL("../../eval/registrations/code-awareness-change-impact.json", import.meta.url),
        "utf8",
      ),
    ) as { arms: { frozen_surface: Record<string, string> } };
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    const frozen = reg.arms.frozen_surface;
    assert.equal(frozen.server_instructions_sha256, sha(serverInstructions(true)));
    assert.equal(frozen.memory_part_sha256, sha(SERVER_INSTRUCTIONS));
    assert.equal(frozen.code_clause_sha256, sha(CODE_AWARENESS_CLAUSE));
    assert.equal(frozen.tool_definition_sha256, sha(JSON.stringify(affectedTools[0])));
  });
});

describe("the doctor counter", () => {
  it("counts the external nodes and how many of them resolved", () => {
    // Three external nodes in the fixture, all three resolve; two specifiers
    // (`@acme/core` and its `/topics` subpath — `@acme/daemon` has no entry).
    assert.deepEqual(graph.externalStats, { total: 3, resolved: 3, workspaceModules: 2 });
  });

  it("reports the count as one line", () => {
    assert.deepEqual(externalRefLines(graph.externalStats), ["3 external nodes, 3 resolved"]);
  });

  it("warns when a workspace resolves NOTHING — the silent break", () => {
    const lines = externalRefLines({ total: 120, resolved: 0, workspaceModules: 4 });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\u26a0 120 external nodes, 0 resolved/);
    assert.match(lines[0], /Graphify id-format change/);
  });

  it("says nothing where there is nothing to break", () => {
    assert.deepEqual(externalRefLines({ total: 0, resolved: 0, workspaceModules: 0 }), []);
  });

  it("does not warn for a repository that is not a workspace", () => {
    const lines = externalRefLines({ total: 40, resolved: 0, workspaceModules: 0 });
    assert.deepEqual(lines, ["40 external nodes, 0 resolved"]);
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

  it("takes the WHOLE file when a changed line is outside every symbol", () => {
    // An import line: it belongs to no symbol, and attributing it to the
    // nearest one above is how a wrong, non-empty selection suppresses the
    // fallback that would have answered correctly.
    const diff = [
      `diff --git a/${SAVE_TS} b/${SAVE_TS}`,
      `--- a/${SAVE_TS}`,
      `+++ b/${SAVE_TS}`,
      "@@ -5,1 +5,1 @@",
      "-// header",
      '+import { write } from "./write.js";',
    ].join("\n");
    const answer = diffSymbols(graph, SAVE_TS, diff);
    assert.equal(answer.wholeFile, true);
    assert.deepEqual(answer.symbols.map((s) => s.name).sort(), ["SaveMemoryInput", "saveMemory"]);
  });

  it("takes the whole file when the source cannot be read at all", () => {
    // The graph knows a file the checkout does not: nothing can place the
    // line, so nothing may be narrowed away.
    const gone = "packages/core/src/topics.ts";
    const diff = [
      `diff --git a/${gone} b/${gone}`,
      `--- a/${gone}`,
      `+++ b/${gone}`,
      "@@ -900,1 +900,1 @@",
      "-  const a = 1;",
      "+  const a = 2;",
    ].join("\n");
    const answer = diffSymbols(graph, gone, diff);
    assert.equal(answer.wholeFile, true, "line 900 is past the end of the file on disk");
  });

  it("reads the diff on its NEW side, so inserted lines do not shift the answer", () => {
    // THE REPRODUCTION (#582 counter-review). The spans come from the working
    // tree; the line numbers came from the diff's OLD side. Three lines
    // inserted into `first` shifted everything below by three, so `second`'s
    // changed line (new 8) was looked up as line 5 — inside `first`. The
    // answer came back non-empty and wrong, which is exactly what suppresses
    // the whole-file fallback.
    const answer = diffSymbols(graph, PAIR_TS, PAIR_DIFF);
    assert.equal(answer.wholeFile, false);
    assert.deepEqual(answer.symbols.map((s) => s.name).sort(), ["first", "second"]);
  });

  it("maps a pure deletion onto the working-tree lines it now sits between", () => {
    // A deleted line has no new-side number of its own. `+6,0` says the text
    // was between new lines 6 and 7 — the boundary between the two functions —
    // so both are named rather than neither.
    const diff = [
      `diff --git a/${PAIR_TS} b/${PAIR_TS}`,
      `--- a/${PAIR_TS}`,
      `+++ b/${PAIR_TS}`,
      "@@ -7,1 +6,0 @@",
      "-const between = 1;",
    ].join("\n");
    const answer = diffSymbols(graph, PAIR_TS, diff);
    assert.equal(answer.wholeFile, false);
    assert.deepEqual(answer.symbols.map((s) => s.name).sort(), ["first", "second"]);
  });

  it("takes the whole file when the new side is /dev/null", () => {
    // The file was deleted in the working tree: there is no line to place, and
    // "no line changed" must not read as a confident narrow answer.
    const diff = [
      `diff --git a/${PAIR_TS} b/${PAIR_TS}`,
      "deleted file mode 100644",
      `--- a/${PAIR_TS}`,
      "+++ /dev/null",
      "@@ -1,10 +0,0 @@",
      "-export function first() {",
    ].join("\n");
    assert.equal(diffSymbols(graph, PAIR_TS, diff).wholeFile, true);
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

/**
 * P1.2 (Codex counter-review 3): `---`/`+++` used to be read as a file header
 * on ANY line that started with them, hunk content included. A source line
 * that itself starts `-- `/`++ ` reads, diff-prefixed, as `--- x`/`+++ x` and
 * was silently skipped — `changedLines` came back confidently empty instead of
 * falling back. `diff-lines.ts` now only reads them as headers outside a hunk.
 */
describe("changedLines: the unified diff parser (P1.2)", () => {
  it("reads a source line that itself looks like a header as a REPLACEMENT, not a skipped pair of headers", () => {
    // THE REPRODUCTION. `-- x` and `++ x`, diff-prefixed, are `--- x` and
    // `+++ x` — indistinguishable from real headers by text alone. Before the
    // fix this diff mapped to `{ lines: [], mappable: true }`: confidently
    // empty, which suppresses the whole-file fallback instead of triggering
    // it.
    const diff = ["@@ -10 +10 @@", "--- x", "+++ x"].join("\n");
    assert.deepEqual(changedLines(diff, "any.ts"), { lines: [10], mappable: true });
  });

  it("treats a multi-line replacement as ONE block: every `-` of the run defers to the `+` run, not just the last one", () => {
    // Before the fix, only the LAST removed line of a run checked whether a
    // `+` followed it; the earlier ones read as bare deletions and widened
    // the selection with their neighbouring (untouched) lines.
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -5,2 +5,2 @@",
      "-old1",
      "-old2",
      "+new1",
      "+new2",
    ].join("\n");
    assert.deepEqual(changedLines(diff, "f.ts"), { lines: [5, 6], mappable: true });
  });

  it("keeps a pure deletion run — nothing `+` follows it — mapped to both neighbours, unchanged", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -5,2 +4,0 @@",
      "-old1",
      "-old2",
    ].join("\n");
    assert.deepEqual(changedLines(diff, "f.ts"), { lines: [4, 5], mappable: true });
  });

  it("accumulates every hunk of a multi-hunk diff", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "@@ -20,1 +20,1 @@",
      "-c",
      "+d",
    ].join("\n");
    assert.deepEqual(changedLines(diff, "f.ts"), { lines: [1, 20], mappable: true });
  });

  it("maps a deletion at the very start of the file without inventing line 0", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,1 +0,0 @@",
      "-first",
    ].join("\n");
    assert.deepEqual(changedLines(diff, "f.ts"), { lines: [1], mappable: true });
  });

  it("maps a deletion at the very end of the file to the line before it and the (absent) line after", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -20,1 +19,0 @@",
      "-last",
    ].join("\n");
    assert.deepEqual(changedLines(diff, "f.ts"), { lines: [19, 20], mappable: true });
  });

  it("a `\\ No newline at end of file` marker between a removal and its replacement does not break the run", () => {
    const diff = [
      "diff --git a/f.ts b/f.ts",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
    ].join("\n");
    assert.deepEqual(changedLines(diff, "f.ts"), { lines: [1], mappable: true });
  });

  it("a header path with a space in it is still matched, not swallowed into the hunk", () => {
    const file = "dir/my file.ts";
    const diff = [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");
    assert.deepEqual(changedLines(diff, file), { lines: [1], mappable: true });
    assert.deepEqual(changedLines(diff, "other.ts"), { lines: [], mappable: true });
  });

  it("a quoted header path is still classified as a header, not read as hunk content", () => {
    // git wraps an unusual path in double quotes; the header must still be
    // recognised as a header by POSITION (before the first `@@`), regardless
    // of what its text looks like.
    const diff = [
      'diff --git "a/weird name.ts" "b/weird name.ts"',
      '--- "a/weird name.ts"',
      '+++ "b/weird name.ts"',
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");
    const kinds = [...diffLines(diff)].map((l) => l.kind);
    assert.deepEqual(kinds, [
      "file-boundary",
      "old-header",
      "new-header",
      "hunk-header",
      "removed",
      "added",
    ]);
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

  it("counts BOTH roads into a file: its own entry and the barrel", () => {
    // A file exported twice is imported both ways, and the earlier rule — the
    // specific entry wins, the barrel is dropped — lost every importer that
    // takes the barrel road. They are narrowed by text further down, not here.
    const topics = symbolsNamed(graph, "packages/core/src/topics.ts", ["detectProject"]).found;
    const files = affectedHits(graph, "packages/core/src/topics.ts", topics).map((h) => h.file);
    assert.ok(files.includes("packages/daemon/src/write-lane.ts"), "the subpath importer");
    assert.ok(files.includes("packages/daemon/src/bridge.ts"), "the barrel importer");
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

  it("drops only the candidates it READ and that name nothing", async () => {
    // 22 candidates: past the point where a person reads them all. bridge.ts
    // names `saveMemory`; the 19 `plain` files were read and name nothing, so
    // they go. The other two are kept, because nothing was established about
    // them: `gone.ts` is not on disk (the stale-graph case) and `barrel.ts`
    // re-exports onward under names of its own.
    const hits = [
      packageHit("packages/daemon/src/bridge.ts"),
      packageHit("packages/daemon/src/gone.ts"),
      packageHit("packages/daemon/src/barrel.ts"),
      ...Array.from({ length: 19 }, (_, i) => packageHit(`packages/daemon/src/plain${i}.ts`)),
    ];
    const kept = await narrowPackageHits(root, hits, ["saveMemory"]);
    assert.deepEqual(kept.map((h) => h.file).sort(), [
      "packages/daemon/src/barrel.ts",
      "packages/daemon/src/bridge.ts",
      "packages/daemon/src/gone.ts",
    ]);
  });

  it("puts the file that NAMES the symbol before the ones kept in doubt", async () => {
    // The answer is capped on files. A candidate that only might use the
    // symbol must not push out one that demonstrably does — measured, that
    // cost three scenarios of the sample their true dependent.
    const hits = [
      packageHit("packages/daemon/src/gone.ts"),
      packageHit("packages/daemon/src/barrel.ts"),
      packageHit("packages/daemon/src/bridge.ts"),
      ...Array.from({ length: 19 }, (_, i) => packageHit(`packages/daemon/src/plain${i}.ts`)),
    ];
    const kept = await narrowPackageHits(root, hits, ["saveMemory"]);
    assert.equal(kept[0].file, "packages/daemon/src/bridge.ts");
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
