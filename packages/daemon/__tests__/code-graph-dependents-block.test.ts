import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeGraphCache } from "../src/code-graph/cache.js";
import { graphDirOf, GRAPH_FILE_NAME } from "../src/code-graph/reader.js";
import { writeManifest, type CodeGraphManifest } from "../src/code-graph/manifest.js";
import {
  dependentsNote,
  codeDedupeKey,
  repoRelative,
} from "../src/code-graph/dependents-block.js";
import type { ReadonlySessionState } from "../src/session-state.js";

/** A node in Graphify's real shape (same fixture shape as the reader test). */
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

/** save.ts defines saveMemory; audit-save.ts calls it, index.ts re-exports it;
 *  helper.ts reaches it only over INFERRED edges. */
const FIXTURE = {
  directed: true,
  multigraph: false,
  graph: {},
  built_at_commit: "5483f5697434bd20071d1b225a72e04db97a93e4",
  nodes: [
    node("save_savememory", "saveMemory()", SAVE, 40),
    node("save_validate", "validateMemory()", SAVE, 88),
    node("audit_auditsave", "auditSave()", "packages/core/src/audit-save.ts", 69),
    node("index_reexport", "saveMemory", "packages/core/src/index.ts", 12),
    node("helper_helper", "helper", "packages/core/src/helper.ts", 3),
    node("lonely_lonely", "lonely", "packages/core/src/lonely.ts", 1),
  ],
  links: [
    edge("audit_auditsave", "save_savememory", "calls"),
    edge("index_reexport", "save_savememory", "re_exports"),
    edge("helper_helper", "save_savememory", "calls", "INFERRED"),
  ],
  hyperedges: [],
};

/** A fixture with a wide fan-in, to exercise the list and token caps. */
function wideFixture(dependentCount: number): typeof FIXTURE {
  const nodes = [node("save_savememory", "saveMemory()", SAVE, 40)];
  const links: ReturnType<typeof edge>[] = [];
  for (let i = 0; i < dependentCount; i++) {
    const id = `dep_${i}`;
    nodes.push(node(id, `caller${i}()`, `packages/core/src/generated/dep-${i}.ts`, i + 1));
    links.push(edge(id, "save_savememory", "calls"));
  }
  return { ...FIXTURE, nodes, links };
}

const MANIFEST: CodeGraphManifest = {
  graphifyVersion: "0.9.63",
  builtAt: new Date().toISOString(),
  commit: null,
  repoRoot: "",
  command: "graphify extract --code-only",
  fileState: { count: 6, newestMtimeMs: 0 },
  lastError: null,
  dirty: false,
};

async function writeGraph(repoRoot: string, graph: unknown): Promise<void> {
  const dir = graphDirOf(repoRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, GRAPH_FILE_NAME), JSON.stringify(graph), "utf8");
}

/** Create the edited file itself, older than the manifest's build time. */
async function writeSource(repoRoot: string, rel: string, mtimeMs: number): Promise<string> {
  const abs = join(repoRoot, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, "export const saveMemory = () => {};\n", "utf8");
  const secs = mtimeMs / 1000;
  await utimes(abs, secs, secs);
  return abs;
}

/** Wait for the cache's background load to land, without blocking the hook. */
/**
 * Wait for the background load the cold call started.
 *
 * Deterministic on purpose: this used to poll `cache.get()` against a 2 s
 * budget and failed about one run in four under parallel load — a wall-clock
 * race, not a defect in what it was testing. `ensureLoaded` resolves when the
 * in-flight load is done, so the wait cannot expire early on a busy machine.
 *
 * This does not weaken the test. The assertion that matters — that the COLD
 * call returns immediately without blocking — has already been made by the
 * caller before this runs; what is left is only "and the load does finish",
 * which is worth awaiting properly rather than guessing at.
 */
async function waitWarm(cache: CodeGraphCache, repo: string): Promise<void> {
  await cache.ensureLoaded(repo);
  assert.ok(cache.get(repo) !== null, "the background load did not produce a usable graph");
}

const EMPTY_SESSION: ReadonlySessionState = { shown: {} };

/** A repo with the fixture graph, a fresh manifest and save.ts on disk. */
async function freshRepo(root: string, name: string, graph: unknown = FIXTURE): Promise<string> {
  const repo = join(root, name);
  await writeGraph(repo, graph);
  const built = Date.now();
  await writeSource(repo, SAVE, built - 60_000);
  await writeManifest(graphDirOf(repo), {
    ...MANIFEST,
    repoRoot: repo,
    builtAt: new Date(built).toISOString(),
  });
  return repo;
}

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-dependents-block-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("dependents block: what the agent sees", () => {
  it("lists the dependents of save.ts on the warm path", async () => {
    const repo = await freshRepo(root, "warm");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const out = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });

    assert.ok(out, "expected a block for a file with dependents");
    assert.match(out.note, /^<code-dependents /);
    assert.match(out.note, /file="packages\/core\/src\/save\.ts"/);
    assert.match(out.note, /dependents="2"/);
    assert.match(out.note, /- packages\/core\/src\/audit-save\.ts/);
    assert.match(out.note, /- packages\/core\/src\/index\.ts/);
    // INFERRED edges are not blast radius (§13.1).
    assert.doesNotMatch(out.note, /helper\.ts/);
    // The file's own symbols are structure, listed as such.
    // `name`, not `label`: Graphify's callable parentheses do not reach the
    // agent's context.
    assert.match(out.note, /Defined here: saveMemory \(L40\), validateMemory \(L88\)\./);
    assert.doesNotMatch(out.note, /saveMemory\(\)/);
    assert.equal(out.dedupeKey, codeDedupeKey(SAVE));
  });

  it("states facts and gives no orders", async () => {
    const repo = await freshRepo(root, "wording");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    const out = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    assert.ok(out);
    // The Graphify `hook-guard` pattern this deliberately does not copy.
    assert.doesNotMatch(out.note, /MANDATORY|You MUST|REQUIRED/i);
    assert.match(out.note, /not an instruction/);
  });

  it("lists production dependents before test files", async () => {
    // On the real graph, plain alphabetical order filled every listed slot
    // with `packages/core/__tests__/…` and pushed audit-save.ts out of sight.
    const graph = {
      ...FIXTURE,
      nodes: [
        ...FIXTURE.nodes,
        node("t_a", "savesTest()", "packages/core/__tests__/aaa-save.test.ts", 5),
        node("t_b", "auditTest()", "packages/core/__tests__/bbb-audit.test.ts", 5),
      ],
      links: [
        ...FIXTURE.links,
        edge("t_a", "save_savememory", "calls"),
        edge("t_b", "save_savememory", "calls"),
      ],
    };
    const repo = await freshRepo(root, "ordering", graph);
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const out = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    assert.ok(out);
    const listed = out.note.split("\n").filter((l) => l.startsWith("- packages/"));
    assert.deepEqual(listed, [
      "- packages/core/src/audit-save.ts",
      "- packages/core/src/index.ts",
      "- packages/core/__tests__/aaa-save.test.ts",
      "- packages/core/__tests__/bbb-audit.test.ts",
    ]);
  });

  it("does not list the file's own graph node as one of its symbols", async () => {
    const graph = {
      ...FIXTURE,
      // Graphify emits a node for the file itself, labelled with its basename
      // at L1 — the reader classifies it as kind "file".
      nodes: [...FIXTURE.nodes, node("save_file", "save.ts", SAVE, 1)],
    };
    const repo = await freshRepo(root, "file-node", graph);
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const out = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    assert.ok(out);
    assert.match(out.note, /Defined here: saveMemory \(L40\), validateMemory \(L88\)\./);
  });

  it("emits nothing for a file nothing depends on", async () => {
    const repo = await freshRepo(root, "lonely");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    await writeSource(repo, "packages/core/src/lonely.ts", Date.now() - 60_000);

    const out = await dependentsNote({
      filePath: join(repo, "packages/core/src/lonely.ts"),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    assert.equal(out, null);
  });

  it("caps a wide fan-in by count and by characters", async () => {
    const repo = await freshRepo(root, "wide", wideFixture(200));
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const out = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    assert.ok(out);
    assert.match(out.note, /dependents="200"/);
    const listed = out.note.split("\n").filter((l) => l.startsWith("- packages/"));
    assert.equal(listed.length, 12, "the listed files are capped");
    assert.match(out.note, /and 188 more/);
    // ~4 chars per token is the lane's own estimator: a hard token ceiling.
    assert.ok(out.note.length < 1400, `block is ${out.note.length} chars`);
  });
});

describe("dependents block: the cold-start rule", () => {
  it("emits nothing on the first edit, schedules the load, and shows the block later", async () => {
    const repo = await freshRepo(root, "cold");
    const cache = new CodeGraphCache();

    // Cold start is 20-26 ms (#575) and does not fit the lane's budget.
    const startedAt = Date.now();
    const first = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(first, null, "a cold graph emits no block at all");
    // A smoke check against blocking, not the lane budget — that one is
    // asserted on the warm path. The ceiling is deliberately well above the
    // 20-26 ms a synchronous load would cost: on a loaded machine even a call
    // that does nothing can lose several milliseconds to scheduling, and a
    // wall-clock assertion tight enough to be exact is one that fails for
    // reasons that have nothing to do with the code under test.
    assert.ok(elapsed < 100, `the cold call must not block on the load (took ${elapsed} ms)`);

    // …but it did schedule the load, so a later edit in the same session has it.
    await waitWarm(cache, repo);
    const second = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    assert.ok(second, "the next edit in the same session sees the block");
    assert.match(second.note, /audit-save\.ts/);
  });

  it("stays silent and cheap in a repository without a graph", async () => {
    const repo = join(root, "no-graph");
    await writeSource(repo, SAVE, Date.now());
    const cache = new CodeGraphCache();

    assert.equal(
      await dependentsNote({
        filePath: join(repo, SAVE),
        repoRoot: repo,
        session: EMPTY_SESSION,
        cache,
      }),
      null,
    );

    // The miss is remembered as degraded, so the second call costs nothing.
    await cache.ensureLoaded(repo);
    const startedAt = Date.now();
    const second = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(second, null);
    assert.ok(elapsed < 10, `a repo without a graph must add no latency (took ${elapsed} ms)`);
    assert.equal(cache.stats().degraded[0]?.reason, "unreadable");
  });

  it("emits nothing for a file outside the anchor", async () => {
    const repo = await freshRepo(root, "outside");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    const out = await dependentsNote({
      filePath: join(root, "elsewhere", "save.ts"),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    assert.equal(out, null);
    assert.equal(repoRelative(repo, join(root, "elsewhere", "save.ts")), null);
  });
});

describe("dependents block: session dedupe (§16.2)", () => {
  it("does not repeat the block for the same file in one session", async () => {
    const repo = await freshRepo(root, "dedupe");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const first = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    assert.ok(first);

    // What the lane books after an emit.
    const after: ReadonlySessionState = {
      shown: { [first.dedupeKey]: { count: 1, at: Date.now() } },
    };
    const second = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: after,
      cache,
    });
    assert.equal(second, null, "the same file is not repeated on the next edit");

    // A different file in the same session is unaffected.
    await writeSource(repo, "packages/core/src/audit-save.ts", Date.now() - 60_000);
    const other = await dependentsNote({
      filePath: join(repo, "packages/core/src/index.ts"),
      repoRoot: repo,
      session: after,
      cache,
    });
    assert.equal(other, null, "index.ts has no dependents in this fixture");
  });
});

describe("dependents block: staleness wording (#574)", () => {
  it("marks a graph whose build never finished", async () => {
    const repo = await freshRepo(root, "dirty");
    await writeManifest(graphDirOf(repo), { ...MANIFEST, repoRoot: repo, dirty: true });
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const out = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    assert.ok(out);
    assert.match(out.note, /stale="true"/);
    assert.match(out.note, /built before the current state of this file|build did not finish/);
  });

  it("marks a graph older than the file being edited", async () => {
    const repo = await freshRepo(root, "older");
    const built = Date.now() - 3_600_000;
    await writeManifest(graphDirOf(repo), {
      ...MANIFEST,
      repoRoot: repo,
      builtAt: new Date(built).toISOString(),
    });
    await writeSource(repo, SAVE, Date.now());
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const out = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    assert.ok(out);
    assert.match(out.note, /stale="true"/);
  });

  it("marks a graph with no manifest at all", async () => {
    const repo = join(root, "no-manifest");
    await writeGraph(repo, FIXTURE);
    await writeSource(repo, SAVE, Date.now() - 60_000);
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const out = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    assert.ok(out);
    assert.match(out.note, /stale="true"/);
  });

  it("says nothing about staleness for a current graph", async () => {
    const repo = await freshRepo(root, "current");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const out = await dependentsNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      session: EMPTY_SESSION,
      cache,
    });
    assert.ok(out);
    assert.doesNotMatch(out.note, /stale=/);
    assert.doesNotMatch(out.note, /out of date/);
  });
});

describe("dependents block: kill switch", () => {
  it("emits nothing when BASTRA_CODE_AWARENESS=off", async () => {
    const repo = await freshRepo(root, "killswitch");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    process.env.BASTRA_CODE_AWARENESS = "off";
    try {
      const out = await dependentsNote({
        filePath: join(repo, SAVE),
        repoRoot: repo,
        session: EMPTY_SESSION,
        cache,
      });
      assert.equal(out, null);
    } finally {
      delete process.env.BASTRA_CODE_AWARENESS;
    }
  });
});
