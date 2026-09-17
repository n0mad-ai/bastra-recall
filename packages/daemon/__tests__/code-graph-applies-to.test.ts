import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGraph, graphDirOf, GRAPH_FILE_NAME, type LoadedGraph } from "../src/code-graph/reader.js";
import {
  AppliesToIndex,
  appliesToCandidates,
  bandOf,
  formatUnresolved,
  parseAppliesTo,
  suggestAffectsFiles,
  unresolvedEntries,
  type AppliesToMemory,
} from "../src/code-graph/applies-to.js";
import { affectsFilesLines, type AffectsFilesIo } from "../src/cli/affects-files-note.js";

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

const SAVE = "packages/core/src/save.ts";
const AUDIT = "packages/core/src/audit-save.ts";
const HELPER = "packages/core/src/helper.ts";

/** audit-save.ts calls saveMemory in save.ts — so AUDIT depends on SAVE. */
const FIXTURE = {
  directed: true,
  multigraph: false,
  graph: {},
  nodes: [
    node("save_savememory", "saveMemory", SAVE, 40),
    node("audit_auditsave", "auditSave", AUDIT, 69),
    node("helper_helper", "helper", HELPER, 3),
  ],
  links: [
    edge("audit_auditsave", "save_savememory", "calls"),
    edge("helper_helper", "save_savememory", "calls", "INFERRED"),
  ],
  hyperedges: [],
};

let dir: string;
let graph: LoadedGraph;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "applies-to-"));
  await mkdir(graphDirOf(dir), { recursive: true });
  await writeFile(join(graphDirOf(dir), GRAPH_FILE_NAME), JSON.stringify(FIXTURE), "utf8");
  const r = await loadGraph(dir);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("fixture graph did not load");
  graph = r.graph;
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseAppliesTo", () => {
  it("splits path#symbol", () => {
    assert.deepEqual(parseAppliesTo(`${SAVE}#saveMemory`), {
      entry: `${SAVE}#saveMemory`,
      file: SAVE,
      symbol: "saveMemory",
    });
  });

  it("keeps a plain path", () => {
    assert.deepEqual(parseAppliesTo(SAVE), { entry: SAVE, file: SAVE, symbol: null });
  });

  it("normalises a leading ./ and backslashes", () => {
    const ref = parseAppliesTo("./packages\\core\\src\\save.ts");
    assert.equal(ref?.file, SAVE);
  });

  it("rejects absolute paths, traversal and empty entries", () => {
    assert.equal(parseAppliesTo("/etc/passwd"), null);
    assert.equal(parseAppliesTo("../../secrets.ts"), null);
    assert.equal(parseAppliesTo("C:/Windows/system32"), null);
    assert.equal(parseAppliesTo("~/Library/LaunchAgents/x.plist"), null);
    assert.equal(parseAppliesTo("   "), null);
  });
});

describe("applies_to candidates (#578 acceptance)", () => {
  const memories: AppliesToMemory[] = [
    { id: "m-save", affects_files: [SAVE] },
    { id: "m-audit", affects_files: [AUDIT] },
    { id: "m-symbol", affects_files: [`${SAVE}#saveMemory`] },
    { id: "m-unrelated", affects_files: ["docs/readme.md"] },
  ];

  it("surfaces a memory whose affects_files names the edited file", () => {
    const index = new AppliesToIndex(memories);
    const got = appliesToCandidates(index, SAVE, graph);
    const direct = got.filter((c) => c.hop === "direct").map((c) => c.memoryId).sort();
    assert.deepEqual(direct, ["m-save", "m-symbol"]);
  });

  it("surfaces a memory on a dependent file as one hop, never as required", () => {
    const index = new AppliesToIndex(memories);
    const got = appliesToCandidates(index, SAVE, graph);
    const hop = got.find((c) => c.memoryId === "m-audit");
    assert.ok(hop, "the memory on the dependent file is a candidate");
    assert.equal(hop.hop, "1-hop");
    assert.equal(hop.via, AUDIT);
    // Even if the evidence gate says required on its own merits, the hop caps it.
    assert.equal(bandOf(hop, "required"), "optional");
    assert.equal(bandOf(hop, "optional"), "optional");
  });

  it("never lifts a direct candidate to required on the strength of the edge", () => {
    const index = new AppliesToIndex(memories);
    const direct = appliesToCandidates(index, SAVE, graph).find((c) => c.memoryId === "m-save");
    assert.ok(direct);
    assert.equal(bandOf(direct, undefined), "optional");
    assert.equal(bandOf(direct, "optional"), "optional");
    // Only an independent gate decision reaches required.
    assert.equal(bandOf(direct, "required"), "required");
  });

  it("leaves unrelated memories out", () => {
    const index = new AppliesToIndex(memories);
    const ids = appliesToCandidates(index, SAVE, graph).map((c) => c.memoryId);
    assert.equal(ids.includes("m-unrelated"), false);
  });

  it("drops the one-hop half without a graph, keeps the direct half", () => {
    const index = new AppliesToIndex(memories);
    const got = appliesToCandidates(index, SAVE, null);
    assert.deepEqual(got.map((c) => c.hop), ["direct", "direct"]);
  });

  it("does not follow INFERRED edges", () => {
    const index = new AppliesToIndex([{ id: "m-helper", affects_files: [HELPER] }]);
    assert.deepEqual(appliesToCandidates(index, SAVE, graph), []);
  });

  it("prefers the direct hop when a memory is declared on both ends", () => {
    const index = new AppliesToIndex([{ id: "m-both", affects_files: [SAVE, AUDIT] }]);
    const got = appliesToCandidates(index, SAVE, graph);
    assert.equal(got.length, 1);
    assert.equal(got[0]?.hop, "direct");
  });
});

describe("unresolved entries for bastra doctor", () => {
  const exists = (f: string) => f === SAVE || f === AUDIT;

  it("reports a path that is no longer in the repository", () => {
    const got = unresolvedEntries([{ id: "m-old", affects_files: ["packages/core/src/gone.ts"] }], {
      exists,
      graph,
    });
    assert.equal(got.length, 1);
    assert.equal(got[0]?.reason, "file-missing");
    assert.match(formatUnresolved(got)[0] ?? "", /no such file/);
  });

  it("reports a symbol the graph does not know in a file it does know", () => {
    const got = unresolvedEntries([{ id: "m-sym", affects_files: [`${SAVE}#goneMemory`] }], {
      exists,
      graph,
    });
    assert.equal(got.length, 1);
    assert.equal(got[0]?.reason, "symbol-missing");
  });

  it("accepts a symbol the graph knows, case-insensitively", () => {
    const got = unresolvedEntries([{ id: "m-sym", affects_files: [`${SAVE}#savememory`] }], {
      exists,
      graph,
    });
    assert.deepEqual(got, []);
  });

  it("does not judge a symbol without a graph, or in a file the graph misses", () => {
    const entry = `${SAVE}#whatever`;
    assert.deepEqual(unresolvedEntries([{ id: "m", affects_files: [entry] }], { exists }), []);
    assert.deepEqual(
      unresolvedEntries([{ id: "m", affects_files: ["packages/core/src/untracked.ts#x"] }], {
        exists: () => true,
        graph,
      }),
      [],
    );
  });

  it("reports an absolute path as its own category, not as a missing file", () => {
    const got = unresolvedEntries([{ id: "m-bad", affects_files: ["/etc/passwd"] }], { exists, graph });
    assert.equal(got[0]?.reason, "not-repo-relative");
  });

  it("does not break retrieval: a stale entry costs only itself", () => {
    const memories: AppliesToMemory[] = [
      { id: "m-mixed", affects_files: ["packages/core/src/gone.ts", SAVE] },
    ];
    assert.equal(unresolvedEntries(memories, { exists, graph }).length, 1);
    const ids = appliesToCandidates(new AppliesToIndex(memories), SAVE, graph).map((c) => c.memoryId);
    assert.deepEqual(ids, ["m-mixed"]);
  });
});

describe("save-time suggestion", () => {
  it("proposes the session's touched files and nothing else", () => {
    assert.deepEqual(suggestAffectsFiles([SAVE, `./${AUDIT}`]), [SAVE, AUDIT]);
  });

  it("leaves out what the memory already declares", () => {
    assert.deepEqual(suggestAffectsFiles([SAVE, AUDIT], [`${SAVE}#saveMemory`]), [AUDIT]);
  });

  it("deduplicates, drops unusable paths and honours the limit", () => {
    assert.deepEqual(suggestAffectsFiles([SAVE, SAVE, "/abs.ts", AUDIT], [], 1), [SAVE]);
  });
});

describe("the bastra doctor note", () => {
  const io = (over: Partial<AffectsFilesIo> = {}): AffectsFilesIo => ({
    memories: async () => [
      { id: "m-old", scope: "bastra-recall", affects_files: ["packages/core/src/gone.ts"] },
    ],
    repoRoot: async () => "/nowhere",
    exists: () => false,
    project: () => "bastra-recall",
    ...over,
  });

  it("lists an unresolved entry", async () => {
    const lines = await affectsFilesLines(io());
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /m-old: packages\/core\/src\/gone\.ts — no such file/);
  });

  it("stays silent when every entry resolves", async () => {
    assert.deepEqual(await affectsFilesLines(io({ exists: () => true })), []);
  });

  it("stays silent when no memory declares a file at all", async () => {
    assert.deepEqual(await affectsFilesLines(io({ memories: async () => [{ id: "m" }] })), []);
  });

  it("leaves another project's memory alone — its paths are relative to ITS repo", async () => {
    const other = io({
      memories: async () => [
        { id: "m-other", scope: "downloader-ui", affects_files: ["server/routen-kern.js"] },
        { id: "m-global", scope: "all-projects", affects_files: ["app/scripts/x.mjs"] },
        { id: "m-scopeless", affects_files: ["app/scripts/y.mjs"] },
      ],
    });
    assert.deepEqual(await affectsFilesLines(other), []);
  });

  it("checks a memory in a scope family of this project", async () => {
    const lines = await affectsFilesLines(
      io({
        memories: async () => [
          { id: "m-sub", scope: "bastra-recall-daemon", affects_files: ["src/gone.ts"] },
        ],
      }),
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /m-sub/);
  });

  it("checks nothing when the project cannot be established with confidence", async () => {
    assert.deepEqual(await affectsFilesLines(io({ project: () => null })), []);
  });

  it("lists at most five findings and counts the rest", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `m${i}`,
      scope: "bastra-recall",
      affects_files: [`packages/core/src/gone${i}.ts`],
    }));
    const lines = await affectsFilesLines(io({ memories: async () => many }));
    assert.equal(lines.length, 6);
    assert.equal(lines[5], "… and 4 more");
  });

  it("counts absolute and home paths instead of listing them", async () => {
    const lines = await affectsFilesLines(
      io({
        memories: async () => [
          {
            id: "m-sys",
            scope: "bastra-recall",
            affects_files: [
              "~/Library/LaunchAgents/ai.n0mad.bastra-recall.plist",
              "/Users/n0mad/.bastra/qwen3-recall.Modelfile",
              "packages/core/src/gone.ts",
            ],
          },
        ],
      }),
    );
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /gone\.ts — no such file/);
    assert.equal(lines[1], "2 further entries name absolute or home paths — not repository paths, nothing to resolve");
    assert.equal(lines.some((l) => l.includes("LaunchAgents")), false);
  });

  it("says nothing when the only entries were never repository paths", async () => {
    const lines = await affectsFilesLines(
      io({
        memories: async () => [
          { id: "m-sys", scope: "bastra-recall", affects_files: ["~/Library/x.plist"] },
        ],
      }),
    );
    assert.deepEqual(lines, []);
  });

  it("says it could not look when there is no repository, instead of reporting clean", async () => {
    const lines = await affectsFilesLines(io({ repoRoot: async () => null }));
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /not checked here \(no git repository/);
  });
});
