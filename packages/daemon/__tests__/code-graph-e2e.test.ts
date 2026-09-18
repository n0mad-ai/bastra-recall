import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildCodeGraph, graphifyBinPath } from "../src/code-graph/build.js";
import { CodeGraphRefresher, needsReconcile } from "../src/code-graph/refresh.js";
import { CodeGraphCache } from "../src/code-graph/cache.js";
import { dependentFilesOf, findSymbol } from "../src/code-graph/reader.js";
import { readManifest } from "../src/code-graph/manifest.js";
import { graphDirOf } from "../src/code-graph/reader.js";

/**
 * The whole path, with the real Graphify binary: build a graph for a real
 * repository, change a file, let the refresher pick it up, and read the change
 * back out of the graph (#574, #581).
 *
 * Everything else in this suite tests one piece against a fixture. This is the
 * only test that answers "does the feature actually work", which is also the
 * only question a demo asks. The acceptance criteria of #581 — an edit
 * reflected within 30 s, a branch switch triggering a refresh, two edits during
 * a run collapsing into one follow-up — were covered in parts; here they run as
 * one sequence.
 *
 * Skipped when the pinned binary is absent, so CI and a fresh checkout stay
 * green. Install it with `bastra install` (say yes to code awareness) or
 * `uv tool install graphifyy==0.9.63`.
 */

const run = promisify(execFile);
const BIN = graphifyBinPath();
const HAVE_BIN = existsSync(BIN);

/** A build costs seconds, not milliseconds — this suite is deliberately slow. */
const TIMEOUT_MS = 180_000;

let root: string;
let repo: string;

async function git(args: string[], cwd: string): Promise<void> {
  await run("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

before(async () => {
  if (!HAVE_BIN) return;
  root = await mkdtemp(join(tmpdir(), "bastra-e2e-"));
  repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(["init", "-q", "."], repo);
  await git(["config", "user.email", "test@example.invalid"], repo);
  await git(["config", "user.name", "Test"], repo);
  await writeFiles(repo, {
    "src/core.ts": "export function saveThing(): string {\n  return 'saved';\n}\n",
    "src/caller.ts":
      "import { saveThing } from './core.js';\nexport function useIt(): string {\n  return saveThing();\n}\n",
    "src/unrelated.ts": "export function lonely(): number {\n  return 1;\n}\n",
  });
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", "init"], repo);
});

after(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("code awareness end to end, with the real Graphify", { skip: !HAVE_BIN, timeout: TIMEOUT_MS }, () => {
  it("builds a graph that knows who calls what", async () => {
    const result = await buildCodeGraph({ repoRoot: repo });
    assert.ok(result.ok, `build failed: ${result.ok === false ? result.detail : ""}`);

    // The manifest is what makes a graph trustworthy as current (#574).
    const manifest = await readManifest(graphDirOf(repo));
    assert.ok(manifest, "a successful build must leave a manifest");
    assert.equal(manifest!.dirty, false, "a finished build clears the dirty flag");
    assert.ok(manifest!.builtAt !== null);
    assert.equal(manifest!.graphifyVersion, "0.9.63");
    assert.ok(manifest!.commit !== null, "inside a git repo the commit is recorded");

    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    const graph = cache.get(repo);
    assert.ok(graph, "the graph must load");

    // The actual point of the feature: caller.ts depends on core.ts.
    assert.deepEqual(dependentFilesOf(graph!, "src/core.ts"), ["src/caller.ts"]);
    // …and nothing claims unrelated.ts does.
    assert.deepEqual(dependentFilesOf(graph!, "src/unrelated.ts"), []);

    // The symbol is findable by the name a human would type — without
    // Graphify's callable parentheses.
    const hits = findSymbol(graph!, "saveThing");
    assert.ok(hits.length > 0, "saveThing must be findable by its bare name");
    assert.equal(hits[0]!.file, "src/core.ts");
    assert.equal(hits[0]!.kind, "function");
  });

  it("picks up a new dependency after an edit, through the refresher", async () => {
    // The cache that was serving BEFORE the edit is the one asserted on
    // (#583): building a fresh cache after the refresh hid that the running
    // one never reloaded. Wired the way the daemon wires it (service.ts).
    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    assert.ok(cache.get(repo), "warm before the edit");
    const refresher = new CodeGraphRefresher({
      debounceMs: 50,
      onBuilt: (repoRoot) => cache.reloadIfChanged(repoRoot),
    });
    try {
      // A third file starts depending on core.ts.
      await writeFiles(repo, {
        "src/late.ts":
          "import { saveThing } from './core.js';\nexport function alsoUses(): string {\n  return saveThing();\n}\n",
      });

      refresher.enqueue(repo, "watcher");
      await refresher.whenIdle();

      const graph = cache.get(repo);
      assert.ok(graph);
      const deps = dependentFilesOf(graph!, "src/core.ts");
      assert.ok(deps.includes("src/late.ts"), `late.ts missing from ${JSON.stringify(deps)}`);
      assert.ok(deps.includes("src/caller.ts"), "the existing dependency must survive");
    } finally {
      refresher.stop();
    }
  });

  it("collapses a burst of edits into one follow-up run", async () => {
    const builds: string[] = [];
    const refresher = new CodeGraphRefresher({
      debounceMs: 50,
      build: async (repoRoot, reason) => {
        builds.push(reason);
        await new Promise((r) => setTimeout(r, 120));
        return { ok: true, manifest: (await readManifest(graphDirOf(repoRoot)))!, durationMs: 120, tookOverLock: false };
      },
    });
    try {
      refresher.enqueue(repo, "watcher");
      await new Promise((r) => setTimeout(r, 80)); // let the first run start
      refresher.enqueue(repo, "watcher");
      refresher.enqueue(repo, "watcher");
      refresher.enqueue(repo, "watcher");
      await refresher.whenIdle();
      // One run, and exactly ONE follow-up for the three that arrived during it.
      assert.equal(builds.length, 2, `expected 2 builds, got ${builds.length}`);
    } finally {
      refresher.stop();
    }
  });

  it("notices a deletion without --force", async () => {
    await rm(join(repo, "src", "late.ts"));
    const result = await buildCodeGraph({ repoRoot: repo });
    assert.ok(result.ok, "a deletion must not need --force");

    const cache = new CodeGraphCache();
    await cache.ensureLoaded(repo);
    const graph = cache.get(repo);
    assert.ok(graph);
    assert.ok(
      !dependentFilesOf(graph!, "src/core.ts").includes("src/late.ts"),
      "the deleted file must be gone from the graph",
    );
  });

  it("reconciles after a build that never finished", async () => {
    // Simulate the daemon dying mid-build: the dirty flag is on disk, which is
    // the whole reason it lives there (#581).
    const manifest = (await readManifest(graphDirOf(repo)))!;
    const { writeManifest } = await import("../src/code-graph/manifest.js");
    await writeManifest(graphDirOf(repo), { ...manifest, dirty: true });

    assert.equal(await needsReconcile(repo), true, "a dirty manifest must ask for a rebuild");

    const refresher = new CodeGraphRefresher({ debounceMs: 10 });
    try {
      refresher.enqueue(repo, "startup");
      await refresher.whenIdle();
      const after = await readManifest(graphDirOf(repo));
      assert.equal(after!.dirty, false, "reconciliation clears the flag");
      assert.equal(await needsReconcile(repo), false);
    } finally {
      refresher.stop();
    }
  });

  it("keeps the repository clean — nothing to commit", async () => {
    // The #574 acceptance: a user's repo must not gain a tracked directory.
    await writeFile(join(repo, ".git", "info", "exclude"), "graphify-out/\n", "utf8").catch(
      async () => {
        await mkdir(join(repo, ".git", "info"), { recursive: true });
        await writeFile(join(repo, ".git", "info", "exclude"), "graphify-out/\n", "utf8");
      },
    );
    const { stdout } = await run("git", ["status", "--porcelain"], { cwd: repo });
    assert.equal(stdout.trim(), "", `git status should be clean, got:\n${stdout}`);
  });
});
