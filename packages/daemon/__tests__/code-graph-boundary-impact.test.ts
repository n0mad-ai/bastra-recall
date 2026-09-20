import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGraph,
  graphDirOf,
  GRAPH_FILE_NAME,
  type LoadedGraph,
} from "../src/code-graph/reader.js";
import { boundaryImpact, type BoundaryTouch } from "../src/code-graph/boundary-impact.js";

/**
 * REVERT-CHECK, so this file is a guard and not a receipt:
 *   - drop `|| selected.symbols.length === 0` in `changedSymbolsFor` and the
 *     rename case goes red — an empty selection reads as "nothing changed".
 *   - drop `if (opened.has(hit.file)) continue;` and both opened-file cases
 *     go red — a file the agent edited or read comes back as "forgotten".
 *   - make the stale-name branch return `found` instead of `whole` and the
 *     stale-record case goes red — a name the graph lost narrows to nothing.
 *   - drop `slot.whole = true` in `mergedTouches` and the merge case goes red —
 *     nine placeable edits outvote the one that could not be placed.
 * These are the lines that carry the meaning, not the plumbing around them.
 */

/** Graphify's real node shape, same helper the affected test uses. */
function node(id: string, label: string, file: string, line = 1) {
  return {
    id,
    label,
    file_type: "code",
    source_file: file,
    source_location: `L${line}`,
    community: 0,
    _origin: "ast",
  };
}

function edge(source: string, target: string, relation: string) {
  return {
    source,
    target,
    relation,
    confidence: "EXTRACTED",
    confidence_score: 0.9,
    _origin: "ast",
  };
}

const SAVE_SOURCE = `export function saveMemory(input: string): string {
  const trimmed = input.trim();
  return trimmed;
}
`;

const NODES = [
  node("save_fn", "saveMemory()", "src/save.ts", 1),
  node("audit_fn", "auditSave()", "src/audit.ts", 1),
  node("report_fn", "buildReport()", "src/report.ts", 1),
  node("lonely_fn", "lonely()", "src/lonely.ts", 1),
];

// `calls` points from the caller to the callee, so `saveMemory` is depended on
// by both `auditSave` and `buildReport` — two dependents in two files, which is
// the smallest fixture that can tell "reported" from "suppressed".
const LINKS = [edge("audit_fn", "save_fn", "calls"), edge("report_fn", "save_fn", "calls")];

const GRAPH = {
  directed: true,
  multigraph: false,
  graph: {},
  built_at_commit: "0000000000000000000000000000000000000000",
  nodes: NODES,
  links: LINKS,
  hyperedges: [],
};

/** A hunk inside `saveMemory`'s body — the narrow, symbol-level basis. */
const BODY_DIFF = `--- a/src/save.ts
+++ b/src/save.ts
@@ -2,1 +2,1 @@
-  const trimmed = input.trim();
+  const trimmed = input.trimStart();
`;

/**
 * The #603 shape: a pure rename carries no `---`/`+++` headers and no hunks, so
 * `changedLines` reports `{ lines: [], mappable: true }` and `diffSymbols`
 * narrows to nothing. A file whose every importer just went stale must not come
 * out of that as silence.
 */
const RENAME_DIFF = `diff --git a/src/save.ts b/src/store.ts
similarity index 100%
rename from src/save.ts
rename to src/store.ts
`;

let root: string;
let graph: LoadedGraph;

async function writeTree(): Promise<void> {
  const files: Array<[string, string]> = [
    ["package.json", JSON.stringify({ name: "acme" })],
    ["src/save.ts", SAVE_SOURCE],
    [
      "src/audit.ts",
      'import { saveMemory } from "./save.js";\nexport function auditSave() { saveMemory(""); }\n',
    ],
    [
      "src/report.ts",
      'import { saveMemory } from "./save.js";\nexport function buildReport() { saveMemory(""); }\n',
    ],
    ["src/lonely.ts", "export function lonely() {}\n"],
  ];
  for (const [path, body] of files) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body, "utf8");
  }
  await mkdir(graphDirOf(root), { recursive: true });
  await writeFile(join(graphDirOf(root), GRAPH_FILE_NAME), JSON.stringify(GRAPH), "utf8");
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-boundary-"));
  await writeTree();
  const loaded = await loadGraph(root);
  assert.equal(loaded.ok, true);
  graph = (loaded as { ok: true; graph: LoadedGraph }).graph;
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const touch = (file: string, diff: string | null = null): BoundaryTouch => ({ file, diff });
const named = (file: string, ...symbols: string[]): BoundaryTouch => ({ file, symbols });

describe("boundary impact", () => {
  it("names the dependents a task changed but never opened", () => {
    const result = boundaryImpact(graph, [touch("src/save.ts", BODY_DIFF)]);

    assert.deepEqual(result.changedSymbols, ["saveMemory"]);
    assert.deepEqual(
      result.missed.map((m) => m.file),
      ["src/audit.ts", "src/report.ts"],
    );
    // A body hunk places inside one symbol, so the basis is the narrow one.
    assert.equal(result.missed[0]?.basis, "symbol");
    assert.equal(result.missed[0]?.relation, "calls");
    assert.equal(result.truncated, false);
  });

  it("drops a dependent the task did open — that is the whole point", () => {
    const result = boundaryImpact(graph, [
      touch("src/save.ts", BODY_DIFF),
      touch("src/audit.ts", null),
    ]);

    // `src/audit.ts` was written to, so it is not something the agent forgot.
    assert.deepEqual(
      result.missed.map((m) => m.file),
      ["src/report.ts"],
    );
  });

  it("stays silent when nothing depends on what changed", () => {
    const result = boundaryImpact(graph, [touch("src/lonely.ts", null)]);

    assert.deepEqual(result.missed, []);
    assert.equal(result.truncated, false);
  });

  it("reports a pure rename on the whole-file basis instead of silently (#603)", () => {
    const narrow = boundaryImpact(graph, [touch("src/save.ts", RENAME_DIFF)]);

    // The lie this guards: a diff that narrows to nothing being read as
    // "nothing changed" rather than "I could not narrow this".
    assert.notDeepEqual(narrow.missed, []);
    assert.deepEqual(
      narrow.missed.map((m) => m.file),
      ["src/audit.ts", "src/report.ts"],
    );
    for (const m of narrow.missed) {
      assert.equal(m.basis, "whole_file");
    }
  });

  it("orders by path so the same session renders the same block twice", () => {
    const forward = boundaryImpact(graph, [
      touch("src/save.ts", BODY_DIFF),
      touch("src/lonely.ts", null),
    ]);
    const reversed = boundaryImpact(graph, [
      touch("src/lonely.ts", null),
      touch("src/save.ts", BODY_DIFF),
    ]);

    assert.deepEqual(forward.missed, reversed.missed);
    assert.deepEqual(forward.touchedFiles, reversed.touchedFiles);
  });

  it("caps the list and says so", () => {
    const result = boundaryImpact(graph, [touch("src/save.ts", BODY_DIFF)], { maxMissed: 1 });

    assert.equal(result.missed.length, 1);
    assert.equal(result.truncated, true);
  });

  it("takes the names the edit lane recorded, without a diff", () => {
    const result = boundaryImpact(graph, [named("src/save.ts", "saveMemory")]);

    assert.deepEqual(result.changedSymbols, ["saveMemory"]);
    assert.deepEqual(
      result.missed.map((m) => [m.file, m.basis, m.changedFile]),
      [
        ["src/audit.ts", "symbol", "src/save.ts"],
        ["src/report.ts", "symbol", "src/save.ts"],
      ],
    );
  });

  it("reads a recorded name the graph no longer has as whole file, not as nothing", () => {
    // The record is older than the graph: `persist` was renamed and reindexed
    // mid-session. Narrowing to the names that still resolve would be empty.
    const result = boundaryImpact(graph, [named("src/save.ts", "persist")]);

    assert.deepEqual(
      result.missed.map((m) => [m.file, m.basis]),
      [
        ["src/audit.ts", "whole_file"],
        ["src/report.ts", "whole_file"],
      ],
    );
  });

  it("drops a dependent the task provably read", () => {
    const result = boundaryImpact(graph, [named("src/save.ts", "saveMemory")], {
      opened: ["src/report.ts"],
    });

    assert.deepEqual(
      result.missed.map((m) => m.file),
      ["src/audit.ts"],
    );
  });

  it("lets one unplaceable edit of a file outvote the placeable ones", () => {
    const result = boundaryImpact(graph, [
      named("src/save.ts", "saveMemory"),
      touch("src/save.ts", null),
    ]);

    assert.deepEqual(result.touchedFiles, ["src/save.ts"]);
    for (const m of result.missed) {
      assert.equal(m.basis, "whole_file");
    }
    assert.equal(result.missed.length, 2);
  });
});
