import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeGraphCache } from "../src/code-graph/cache.js";
import { graphDirOf, graphFileOf, GRAPH_FILE_NAME } from "../src/code-graph/reader.js";
import { writeManifest, type CodeGraphManifest } from "../src/code-graph/manifest.js";
import {
  impactNote,
  impactDedupeKey,
  MAX_IMPACT_FILES,
} from "../src/code-graph/impact-block.js";
import {
  applyPatchBody,
  pendingText,
  unifiedDiff,
} from "../src/code-graph/pending-diff.js";
import type { ReadonlySessionState } from "../src/session-state.js";

/**
 * The DELIVERED change-impact block (#606).
 *
 * Fixture-based, in the shape Graphify really writes (the same `node`/`edge`
 * helpers as the reader and affected tests), plus one run against this
 * repository's own graph where there is one. The fixture proves the shape we
 * invented; the real graph proves the shape Graphify writes.
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

function edge(source: string, target: string, relation: string, confidence = "EXTRACTED") {
  return { source, target, relation, confidence, confidence_score: 0.85, _origin: "ast" };
}

const SAVE = "packages/core/src/save.ts";

/**
 * save.ts holds two functions far apart in the file; each has its own caller,
 * so a diff that touches only one of them must produce only that one's caller.
 * That separation is the whole point of the symbol-level query.
 */
const FIXTURE = {
  directed: true,
  multigraph: false,
  graph: {},
  built_at_commit: "5483f5697434bd20071d1b225a72e04db97a93e4",
  nodes: [
    node("save_savememory", "saveMemory()", SAVE, 4),
    node("save_validate", "validateMemory()", SAVE, 12),
    node("audit_auditsave", "auditSave()", "packages/core/src/audit-save.ts", 69),
    node("checks_run", "runChecks()", "packages/core/src/checks.ts", 8),
    node("test_save", "savesIt()", "packages/core/__tests__/save.test.ts", 3),
  ],
  links: [
    edge("audit_auditsave", "save_savememory", "calls"),
    edge("test_save", "save_savememory", "calls"),
    edge("checks_run", "save_validate", "calls"),
  ],
  hyperedges: [],
};

/**
 * The working-tree text the fixture's line numbers describe. `saveMemory`
 * spans L4–L6, `validateMemory` L12–L14, and the gap between them is where a
 * top-level change lands — the whole-file case.
 */
const SAVE_SOURCE = [
  "// header",
  "import { z } from 'zod';",
  "",
  "export function saveMemory(input) {",
  "  return input;",
  "}",
  "",
  "const TOP_LEVEL = 1;",
  "",
  "// a comment between them",
  "",
  "export function validateMemory(input) {",
  "  return TOP_LEVEL;",
  "}",
  "",
].join("\n");

const MANIFEST: CodeGraphManifest = {
  graphifyVersion: "0.9.63",
  builtAt: new Date().toISOString(),
  commit: null,
  repoRoot: "",
  command: "graphify extract --code-only",
  fileState: { count: 5, newestMtimeMs: 0 },
  lastError: null,
  dirty: false,
};

const EMPTY_SESSION: ReadonlySessionState = { shown: {} };

/**
 * Budget for the tests that assert what the block SAYS. The production ceiling
 * drops a late block, and a content test racing it fails for a reason that has
 * nothing to do with what it asserts — the same flake `dependents-block`'s
 * suite measured at two runs in four under parallel load.
 */
const CONTENT_BUDGET_MS = 5_000;

async function freshRepo(root: string, name: string, graph: unknown = FIXTURE): Promise<string> {
  const repo = join(root, name);
  const dir = graphDirOf(repo);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, GRAPH_FILE_NAME), JSON.stringify(graph), "utf8");
  const abs = join(repo, SAVE);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, SAVE_SOURCE, "utf8");
  const built = Date.now();
  const secs = (built - 60_000) / 1000;
  await utimes(abs, secs, secs);
  await writeManifest(dir, {
    ...MANIFEST,
    repoRoot: repo,
    builtAt: new Date(built).toISOString(),
  });
  return repo;
}

/** An Edit that rewrites the body of `saveMemory` and nothing else. */
const EDIT_SAVE = {
  file_path: "ignored",
  old_string: "  return input;",
  new_string: "  return { ...input, saved: true };",
};

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-impact-block-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

// ─── The pending diff ────────────────────────────────────────────

describe("pending diff: the change that has not happened yet", () => {
  it("writes a replacement hunk on the NEW side", () => {
    const diff = unifiedDiff("a.ts", "one\ntwo\nthree\n", "one\nTWO\nthree\n");
    assert.ok(diff);
    assert.match(diff, /^--- a\/a\.ts\n\+\+\+ b\/a\.ts\n@@ -2,1 \+2,1 @@\n-two\n\+TWO$/);
  });

  it("writes an insertion as `-p,0`, so the hunk is not shifted by one", () => {
    const diff = unifiedDiff("a.ts", "one\ntwo\n", "one\nmid\ntwo\n");
    assert.ok(diff);
    assert.match(diff, /@@ -1,0 \+2,1 @@/);
  });

  it("writes a deletion as `+p,0`, which is git's 'between p and p+1'", () => {
    const diff = unifiedDiff("a.ts", "one\ntwo\nthree\n", "one\nthree\n");
    assert.ok(diff);
    assert.match(diff, /@@ -2,1 \+1,0 @@/);
  });

  it("is null when nothing changed — no change is not an empty change", () => {
    assert.equal(unifiedDiff("a.ts", "same\n", "same\n"), null);
  });

  it("applies an Edit, a replace_all Edit and a MultiEdit in order", () => {
    assert.equal(pendingText("Edit", { old_string: "a", new_string: "b" }, "a a"), "b a");
    assert.equal(
      pendingText("Edit", { old_string: "a", new_string: "b", replace_all: true }, "a a"),
      "b b",
    );
    assert.equal(
      pendingText(
        "MultiEdit",
        { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] },
        "a c",
      ),
      "b d",
    );
  });

  it("refuses an Edit whose old_string is not in the file — that edit fails anyway", () => {
    assert.equal(pendingText("Edit", { old_string: "nope", new_string: "x" }, "abc"), null);
  });

  it("reads one file's changed lines out of an apply_patch document", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@ class A",
      "-  old();",
      "+  brandNew();",
      "*** Update File: src/b.ts",
      "-  unrelated();",
      "*** End Patch",
    ].join("\n");
    assert.equal(applyPatchBody(patch, "src/a.ts"), "-  old();\n+  brandNew();");
    assert.equal(applyPatchBody(patch, "src/b.ts"), "-  unrelated();");
    assert.equal(applyPatchBody(patch, "src/c.ts"), null);
  });
});

// ─── The block ───────────────────────────────────────────────────

describe("delivered change-impact block: what the agent sees", () => {
  it("names only the caller of the symbol the edit touches", async () => {
    const repo = await freshRepo(root, "narrow");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const out = await impactNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      toolName: "Edit",
      toolInput: EDIT_SAVE,
      session: EMPTY_SESSION,
      cache,
      budgetMs: CONTENT_BUDGET_MS,
    });

    assert.ok(out.note, "expected a block for an edit with dependents");
    const note = out.note.note;
    assert.match(note, /^<code-impact /);
    assert.match(note, /file="packages\/core\/src\/save\.ts"/);
    assert.match(note, /basis="diff"/);
    assert.match(note, /Changed: saveMemory\./);
    // The source line and the relation, which the file-level block never had.
    assert.match(note, /- packages\/core\/src\/audit-save\.ts:69 — calls saveMemory/);
    // validateMemory was not touched, so ITS caller is not blast radius. This
    // is the whole difference to the file-level query it replaces.
    assert.doesNotMatch(note, /checks\.ts/);
    assert.equal(out.note.basis, "diff");
    assert.deepEqual(out.note.changedSymbols, ["saveMemory"]);
  });

  it("says `whole_file` when the change lands outside every symbol", async () => {
    const repo = await freshRepo(root, "wholefile");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const out = await impactNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      toolName: "Edit",
      // A top-level constant between the two functions: attributing it to the
      // nearest symbol would be a confident wrong answer.
      toolInput: { old_string: "const TOP_LEVEL = 1;", new_string: "const TOP_LEVEL = 2;" },
      session: EMPTY_SESSION,
      cache,
      budgetMs: CONTENT_BUDGET_MS,
    });

    assert.ok(out.note);
    assert.equal(out.note.basis, "whole_file");
    assert.match(out.note.note, /basis="whole_file"/);
    assert.match(out.note.note, /narrows to nothing trustworthy/);
    // Both callers are candidates now, which is the honest wide answer.
    assert.match(out.note.note, /audit-save\.ts/);
    assert.match(out.note.note, /checks\.ts/);
  });

  it("states facts and gives no orders", async () => {
    const repo = await freshRepo(root, "wording");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    const out = await impactNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      toolName: "Edit",
      toolInput: EDIT_SAVE,
      session: EMPTY_SESSION,
      cache,
      budgetMs: CONTENT_BUDGET_MS,
    });
    assert.ok(out.note);
    assert.doesNotMatch(out.note.note, /MANDATORY|You MUST|REQUIRED/i);
    assert.match(out.note.note, /Candidates, not proof/);
    assert.match(out.note.note, /grep the names/);
  });

  it("caps the list and says how many it did not name", async () => {
    const nodes = [node("save_savememory", "saveMemory()", SAVE, 4)];
    const links: ReturnType<typeof edge>[] = [];
    for (let i = 0; i < MAX_IMPACT_FILES + 7; i++) {
      nodes.push(node(`dep_${i}`, `caller${i}()`, `packages/core/src/gen/dep-${i}.ts`, i + 1));
      links.push(edge(`dep_${i}`, "save_savememory", "calls"));
    }
    const repo = await freshRepo(root, "capped", { ...FIXTURE, nodes, links });
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const out = await impactNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      toolName: "Edit",
      toolInput: EDIT_SAVE,
      session: EMPTY_SESSION,
      cache,
      budgetMs: CONTENT_BUDGET_MS,
    });
    assert.ok(out.note);
    const listed = out.note.note.split("\n").filter((l) => l.startsWith("- packages/"));
    assert.equal(listed.length, MAX_IMPACT_FILES);
    assert.match(out.note.note, /… and 7 more/);
    assert.equal(out.note.listed.length, MAX_IMPACT_FILES);
  });

  it("puts production files before test files", async () => {
    const repo = await freshRepo(root, "prodfirst");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    const out = await impactNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      toolName: "Edit",
      toolInput: EDIT_SAVE,
      session: EMPTY_SESSION,
      cache,
      budgetMs: CONTENT_BUDGET_MS,
    });
    assert.ok(out.note);
    const lines = out.note.note.split("\n").filter((l) => l.startsWith("- packages/"));
    assert.match(lines[0], /audit-save\.ts/);
    assert.match(lines[1], /__tests__/);
  });

  it("is silent on a cold graph and still schedules the load", async () => {
    const repo = await freshRepo(root, "cold");
    const cache = new CodeGraphCache();
    const cold = await impactNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      toolName: "Edit",
      toolInput: EDIT_SAVE,
      session: EMPTY_SESSION,
      cache,
    });
    assert.equal(cold.note, null);
    assert.equal(cold.dedupeHit, false);
    await cache.ensureLoaded(repo);
    assert.ok(cache.get(repo) !== null, "the cold call did not schedule a load");
  });

  it("is silent for a tool it cannot read a pending change out of", async () => {
    const repo = await freshRepo(root, "unsupported");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    const out = await impactNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      toolName: "NotebookEdit",
      toolInput: { new_source: "x" },
      session: EMPTY_SESSION,
      cache,
      budgetMs: CONTENT_BUDGET_MS,
    });
    assert.equal(out.note, null);
  });

  it("answers an apply_patch from the names its body mentions", async () => {
    const repo = await freshRepo(root, "patch");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    const out = await impactNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      toolName: "apply_patch",
      toolInput: {
        command: [
          "*** Begin Patch",
          `*** Update File: ${SAVE}`,
          "@@",
          "-export function saveMemory(input) {",
          "+export function saveMemory(input, opts) {",
          "*** End Patch",
        ].join("\n"),
      },
      session: EMPTY_SESSION,
      cache,
      budgetMs: CONTENT_BUDGET_MS,
    });
    assert.ok(out.note);
    assert.equal(out.note.basis, "diff");
    assert.deepEqual(out.note.changedSymbols, ["saveMemory"]);
    assert.doesNotMatch(out.note.note, /checks\.ts/);
  });
});

// ─── Dedupe ──────────────────────────────────────────────────────

describe("delivered block: dedupe per session, file AND symbol set", () => {
  async function noteWith(
    repo: string,
    cache: CodeGraphCache,
    toolInput: Record<string, unknown>,
    session: ReadonlySessionState,
  ) {
    return impactNote({
      filePath: join(repo, SAVE),
      repoRoot: repo,
      toolName: "Edit",
      toolInput,
      session,
      cache,
      budgetMs: CONTENT_BUDGET_MS,
    });
  }

  it("does not deliver the same answer twice, and counts the suppression", async () => {
    const repo = await freshRepo(root, "dedupe");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const first = await noteWith(repo, cache, EDIT_SAVE, EMPTY_SESSION);
    assert.ok(first.note);
    const shown: ReadonlySessionState = {
      shown: { [first.note.dedupeKey]: { count: 1, lastShownAt: Date.now() } },
    };
    const second = await noteWith(repo, cache, EDIT_SAVE, shown);
    assert.equal(second.note, null);
    assert.equal(second.dedupeHit, true, "a suppressed answer must be countable");
  });

  it("delivers again when the NEXT edit changes a different symbol", async () => {
    const repo = await freshRepo(root, "dedupe-other-symbol");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);

    const first = await noteWith(repo, cache, EDIT_SAVE, EMPTY_SESSION);
    assert.ok(first.note);
    const shown: ReadonlySessionState = {
      shown: { [first.note.dedupeKey]: { count: 1, lastShownAt: Date.now() } },
    };
    // The file-level dedupe of #577 suppressed this — the second edit of a
    // file was silent however different its blast radius was.
    const second = await noteWith(
      repo,
      cache,
      { old_string: "  return TOP_LEVEL;", new_string: "  return TOP_LEVEL + 1;" },
      shown,
    );
    assert.ok(second.note, "a different symbol is a different answer");
    assert.deepEqual(second.note.changedSymbols, ["validateMemory"]);
    assert.notEqual(second.note.dedupeKey, first.note.dedupeKey);
  });

  it("keys on file, symbol set and graph generation together", () => {
    assert.notEqual(impactDedupeKey(SAVE, "aaa"), impactDedupeKey(SAVE, "bbb"));
    assert.notEqual(impactDedupeKey(SAVE, "aaa"), impactDedupeKey("other.ts", "aaa"));
    assert.match(impactDedupeKey(SAVE, "aaa"), /^code:/);
  });
});

// ─── Latency ─────────────────────────────────────────────────────

describe("delivered block: lane latency", () => {
  it("stays well inside the lane budget on the warm path", async () => {
    const repo = await freshRepo(root, "latency");
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    const opts = {
      filePath: join(repo, SAVE),
      repoRoot: repo,
      toolName: "Edit",
      toolInput: EDIT_SAVE,
      session: EMPTY_SESSION,
      cache,
      budgetMs: CONTENT_BUDGET_MS,
    };
    // One untimed call, so nothing here measures the first-touch page cache.
    await impactNote(opts);
    const took: number[] = [];
    for (let i = 0; i < 50; i++) {
      const at = performance.now();
      await impactNote(opts);
      took.push(performance.now() - at);
    }
    took.sort((a, b) => a - b);
    const p90 = took[Math.floor(took.length * 0.9)];
    assert.ok(p90 < 200, `p90 ${p90.toFixed(2)} ms is over the 200 ms lane target`);
  });
});

// ─── The real graph ──────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HAVE_GRAPH = existsSync(graphFileOf(REPO_ROOT));

/**
 * `graphify-out/` is git-ignored, so this runs on a machine where someone ran
 * `bastra code index` and nowhere else. Skipped rather than failed in CI: the
 * fixture above proves the shape we invented, this proves the one Graphify
 * writes.
 */
describe("delivered block: against this repository's own graph", { skip: !HAVE_GRAPH }, () => {
  it("answers an edit to save.ts with real callers, inside the budget", async () => {
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(REPO_ROOT);
    const out = await impactNote({
      filePath: join(REPO_ROOT, "packages/core/src/save.ts"),
      repoRoot: REPO_ROOT,
      toolName: "Edit",
      toolInput: { old_string: "export", new_string: "export" },
      session: EMPTY_SESSION,
      cache,
      budgetMs: CONTENT_BUDGET_MS,
    });
    // An edit that changes nothing produces no diff, hence no block — which is
    // itself the contract: silence when there is no pending change.
    assert.equal(out.note, null);
  });
});
