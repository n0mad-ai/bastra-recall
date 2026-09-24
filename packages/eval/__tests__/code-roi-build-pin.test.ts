/**
 * The runner's build preflight and build pin, on synthetic archives (#582,
 * Codex counter-review 4).
 *
 * Codex found `packages/daemon/dist/.build-revision` reading a commit several
 * revisions behind HEAD while this registration's thresholds were being
 * finalised: the start command documented until now neither built `dist` nor
 * checked it, so an unguarded first arm would have measured a server nobody
 * had reviewed at HEAD. The run is also taken in HELPINGS across
 * subscription-quota windows (`run_conditions.stretched_run`), so the same
 * gap could let two helpings of one archive be served by two different
 * product revisions with nothing to say so.
 *
 * These are synthetic checkouts and synthetic dist directories throughout —
 * never the real repository's `dist` or `HEAD` — so a failing case here is a
 * property of the preflight, not a fact about this branch's current state.
 *
 * Run: npx tsx --test packages/eval/__tests__/code-roi-build-pin.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkBuildPin,
  diffBuildPin,
  distArtifactHashes,
  frozenSurfaceHashesFromDist,
  frozenSurfaceMismatches,
  gitPorcelainStatus,
  parseBuildRevision,
  pinSignature,
  preflightBuild,
  readBuildRevision,
  // @ts-expect-error — plain .mjs script, no declarations (#542).
} from "../code-roi/v2/build-pin.mjs";
// @ts-expect-error — plain .mjs script, no declarations (#542).
import { armMetaRows, mixedBuildsReport } from "../code-roi/v2/evaluate-v4.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WRITE_BUILD_REVISION = join(REPO_ROOT, "scripts", "write-build-revision.mjs");
const RUNNER = join(REPO_ROOT, "packages", "eval", "code-roi", "v2", "run-arms-v3.mjs");

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-build-pin-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** git, isolated from the developer's own config and identity. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

/**
 * A real one-commit checkout with a `packages/daemon/src` and a
 * `packages/eval` — the two paths the preflight's own worktree check names —
 * so a synthetic edit under either is a real, git-visible dirty file.
 */
async function syntheticCheckout(dir: string): Promise<string> {
  const root = join(dir, "checkout");
  await mkdir(join(root, "packages", "daemon", "src"), { recursive: true });
  await mkdir(join(root, "packages", "eval"), { recursive: true });
  await writeFile(join(root, "packages", "daemon", "src", "a.ts"), "export const v = 1;\n", "utf8");
  await writeFile(join(root, "packages", "eval", "a.ts"), "export const v = 1;\n", "utf8");
  // Build output is ignored exactly as in the real repo, or every build would
  // leave the tree "dirty" and no case here could ever be the clean one.
  await writeFile(join(root, ".gitignore"), "dist/\n", "utf8");
  // Copied in, not run from its real location: `write-build-revision.mjs`
  // resolves its repo root from its OWN `import.meta.url`, so running the
  // real repo's copy against this checkout would stamp the REAL repo's HEAD.
  await mkdir(join(root, "scripts"), { recursive: true });
  await cp(WRITE_BUILD_REVISION, join(root, "scripts", "write-build-revision.mjs"));
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "one");
  return root;
}

const MEMORY_PART = "memory part\n";
const CODE_CLAUSE = "\n\ncode clause\n";
const TOOL_DEF = { name: "find_affected_files", description: "x" };

/**
 * A fake `dist` at `<root>/packages/daemon/dist`: the two modules the frozen
 * surface is read from, `tool-defs.js` (read by `distArtifactHashes`), and a
 * REAL `.build-revision` — written by the actual `write-build-revision.mjs`,
 * not hand-rolled, so a test failure here is never "the fixture disagreed
 * with the script" instead of a real finding.
 */
async function buildFakeDist(
  root: string,
  opts: { memoryPart?: string; codeClause?: string; toolDef?: unknown } = {},
): Promise<string> {
  const distDir = join(root, "packages", "daemon", "dist");
  await mkdir(join(distDir, "code-graph"), { recursive: true });
  const memoryPart = JSON.stringify(opts.memoryPart ?? MEMORY_PART);
  const codeClause = JSON.stringify(opts.codeClause ?? CODE_CLAUSE);
  await writeFile(
    join(distDir, "mcp-instructions.js"),
    [
      `export const SERVER_INSTRUCTIONS = ${memoryPart};`,
      `export const CODE_AWARENESS_CLAUSE = ${codeClause};`,
      `export function serverInstructions(enabled) { return enabled ? SERVER_INSTRUCTIONS + CODE_AWARENESS_CLAUSE : SERVER_INSTRUCTIONS; }`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(distDir, "code-graph", "find-affected-files.js"),
    `export const affectedTools = [${JSON.stringify(opts.toolDef ?? TOOL_DEF)}];\n`,
    "utf8",
  );
  await writeFile(join(distDir, "tool-defs.js"), "export const ALL_TOOL_DEFS = [];\n", "utf8");
  // The copy inside the checkout, not the real repo's own script — see the
  // comment in `syntheticCheckout` for why that distinction matters here.
  execFileSync(process.execPath, [join(root, "scripts", "write-build-revision.mjs"), "dist"], {
    cwd: join(root, "packages", "daemon"),
    encoding: "utf8",
  });
  return distDir;
}

/** A registration whose `arms.frozen_surface` matches `buildFakeDist`'s defaults exactly. */
function matchingRegistration(opts: { memoryPart?: string; codeClause?: string; toolDef?: unknown } = {}) {
  const sha = (v: string) => createHash("sha256").update(v).digest("hex");
  const memoryPart = opts.memoryPart ?? MEMORY_PART;
  const codeClause = opts.codeClause ?? CODE_CLAUSE;
  const toolDef = opts.toolDef ?? TOOL_DEF;
  return {
    registration_version: 999,
    arms: {
      frozen_surface: {
        tool_definition_sha256: sha(JSON.stringify(toolDef)),
        server_instructions_sha256: sha(memoryPart + codeClause),
        memory_part_sha256: sha(memoryPart),
        code_clause_sha256: sha(codeClause),
      },
    },
  };
}

// ─── parsing dist/.build-revision ─────────────────────────────────────────

describe("dist/.build-revision, the way write-build-revision.mjs writes it", () => {
  test("key=value lines, not a bare SHA", () => {
    const parsed = parseBuildRevision("revision=abc123\ndirty=false\nbuilt_at=2026-09-19T00:00:00.000Z\n");
    assert.deepEqual(parsed, { revision: "abc123", dirty: false, builtAt: "2026-09-19T00:00:00.000Z" });
  });

  test("dirty=true parses to a real boolean, not the string", () => {
    assert.equal(parseBuildRevision("revision=abc\ndirty=true\n")?.dirty, true);
  });

  test("no revision= line is not a stamp at all", () => {
    assert.equal(parseBuildRevision("dirty=false\n"), null);
    assert.equal(parseBuildRevision(""), null);
  });

  test("readBuildRevision is null when the file is simply missing", async () => {
    await withTempDir(async (dir) => {
      assert.equal(readBuildRevision(dir), null);
    });
  });
});

// ─── the worktree check, scoped to the named paths ────────────────────────

describe("gitPorcelainStatus is scoped to the tracked build inputs", () => {
  test("clean after commit, dirty after an edit under a tracked path", async () => {
    await withTempDir(async (dir) => {
      const root = await syntheticCheckout(dir);
      assert.deepEqual(gitPorcelainStatus(root, ["packages/daemon/src", "packages/eval"]), []);
      await writeFile(join(root, "packages", "daemon", "src", "a.ts"), "export const v = 2;\n", "utf8");
      const status = gitPorcelainStatus(root, ["packages/daemon/src", "packages/eval"]);
      assert.equal(status.length, 1);
      assert.match(status[0], /a\.ts/);
    });
  });

  test("a dirty file OUTSIDE the tracked paths does not count", async () => {
    await withTempDir(async (dir) => {
      const root = await syntheticCheckout(dir);
      await mkdir(join(root, "packages", "core"), { recursive: true });
      await writeFile(join(root, "packages", "core", "b.ts"), "export const v = 1;\n", "utf8");
      assert.deepEqual(gitPorcelainStatus(root, ["packages/daemon/src", "packages/eval"]), []);
    });
  });
});

// ─── the frozen-surface comparison, as a pure function ────────────────────

describe("frozenSurfaceMismatches", () => {
  test("no mismatches when the built hashes equal the registered ones", () => {
    const reg = matchingRegistration();
    assert.deepEqual(frozenSurfaceMismatches(reg.arms.frozen_surface, reg), []);
  });

  test("names every field that differs, not just the first", () => {
    const reg = matchingRegistration();
    const built = { ...reg.arms.frozen_surface, tool_definition_sha256: "x", code_clause_sha256: "y" };
    const mismatches = frozenSurfaceMismatches(built, reg);
    assert.deepEqual(
      mismatches.map((m: any) => m.field).sort(),
      ["code_clause_sha256", "tool_definition_sha256"],
    );
  });
});

// ─── distArtifactHashes reacts to real content changes ────────────────────

describe("distArtifactHashes", () => {
  test("changes when the built content changes, keyed by relative path", async () => {
    await withTempDir(async (dir) => {
      const root = await syntheticCheckout(dir);
      const distDir = await buildFakeDist(root);
      const before = distArtifactHashes(distDir);
      assert.ok(before["tool-defs.js"]);
      assert.ok(before["mcp-instructions.js"]);
      assert.ok(before["code-graph/find-affected-files.js"]);

      await buildFakeDist(root, { toolDef: { name: "find_affected_files", description: "changed" } });
      const after = distArtifactHashes(distDir);
      assert.notEqual(after["code-graph/find-affected-files.js"], before["code-graph/find-affected-files.js"]);
      assert.equal(after["mcp-instructions.js"], before["mcp-instructions.js"], "an unrelated file's hash is stable");
    });
  });
});

// ─── preflightBuild — each of the four gates, on its own ──────────────────

describe("preflightBuild: the four gates, each on a synthetic checkout", () => {
  test("no dist/.build-revision at all is refused before anything else runs", async () => {
    await withTempDir(async (dir) => {
      const root = await syntheticCheckout(dir);
      await mkdir(join(root, "packages", "daemon", "dist"), { recursive: true });
      const verdict = await preflightBuild({
        repoRoot: root,
        distDaemonDir: join(root, "packages", "daemon", "dist"),
        registration: matchingRegistration(),
      });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, "no_build_revision");
      assert.match(verdict.message, /npm run build/);
    });
  });

  test("dist built from a DIFFERENT commit than HEAD is refused (the Codex finding)", async () => {
    await withTempDir(async (dir) => {
      const root = await syntheticCheckout(dir);
      const distDir = await buildFakeDist(root);
      // A second commit moves HEAD; the stamp still names the first one —
      // exactly the shape Codex found (dist/.build-revision behind HEAD).
      await writeFile(join(root, "README.md"), "two\n", "utf8");
      git(root, "add", "-A");
      git(root, "commit", "-qm", "two");
      const verdict = await preflightBuild({
        repoRoot: root,
        distDaemonDir: distDir,
        registration: matchingRegistration(),
      });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, "stale_build");
      assert.match(verdict.message, /run `npm run build`/);
    });
  });

  test("dist stamped as built from a dirty worktree is refused even when HEAD and the current tree are clean", async () => {
    await withTempDir(async (dir) => {
      const root = await syntheticCheckout(dir);
      const distDir = await buildFakeDist(root);
      const stamp = join(distDir, ".build-revision");
      const clean = await readFile(stamp, "utf8");
      await writeFile(stamp, clean.replace("dirty=false", "dirty=true"), "utf8");

      const verdict = await preflightBuild({
        repoRoot: root,
        distDaemonDir: distDir,
        registration: matchingRegistration(),
      });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, "dirty_build");
      assert.match(verdict.message, /dirty worktree/);
    });
  });

  test("a dirty worktree is refused even when dist matches HEAD", async () => {
    await withTempDir(async (dir) => {
      const root = await syntheticCheckout(dir);
      const distDir = await buildFakeDist(root);
      // Edited AFTER the build and never committed: dist still names HEAD.
      await writeFile(join(root, "packages", "eval", "a.ts"), "export const v = 2;\n", "utf8");
      const verdict = await preflightBuild({
        repoRoot: root,
        distDaemonDir: distDir,
        registration: matchingRegistration(),
      });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, "dirty_worktree");
      assert.match(verdict.message, /packages\/eval/);
    });
  });

  test("a frozen-surface hash that no longer matches the registration is refused", async () => {
    await withTempDir(async (dir) => {
      const root = await syntheticCheckout(dir);
      const distDir = await buildFakeDist(root);
      // The registration pins a DIFFERENT clause than what got built.
      const reg = matchingRegistration({ codeClause: "\n\na different clause\n" });
      const verdict = await preflightBuild({ repoRoot: root, distDaemonDir: distDir, registration: reg });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, "frozen_surface_drift");
      assert.match(verdict.message, /code_clause_sha256/);
      assert.match(verdict.message, /server_instructions_sha256/, "the combined hash moves too");
    });
  });

  test("clean build, clean worktree, matching surface: ok, with a full pin", async () => {
    await withTempDir(async (dir) => {
      const root = await syntheticCheckout(dir);
      const distDir = await buildFakeDist(root);
      const head = git(root, "rev-parse", "HEAD");
      const verdict = await preflightBuild({
        repoRoot: root,
        distDaemonDir: distDir,
        registration: matchingRegistration(),
      });
      assert.equal(verdict.ok, true);
      assert.equal(verdict.pin.headSha, head);
      assert.equal(verdict.pin.distRevision.revision, head);
      assert.equal(verdict.pin.distRevision.dirty, false);
      assert.ok(verdict.pin.artifactHashes["tool-defs.js"]);
    });
  });
});

// ─── the pin itself: signature, diff, and the pin/check contract ──────────

describe("pinSignature and diffBuildPin", () => {
  const pinOf = (headSha: string, toolHash = "t") => ({
    headSha,
    distRevision: { revision: headSha, dirty: false, builtAt: null },
    frozenSurface: {
      tool_definition_sha256: toolHash,
      server_instructions_sha256: "s",
      memory_part_sha256: "m",
      code_clause_sha256: "c",
    },
    artifactHashes: { "tool-defs.js": "a" },
    registrationVersion: 6,
    computedAt: new Date().toISOString(),
  });

  test("two computations of the SAME build carry the same signature, timestamp included or not", () => {
    const a = pinOf("a".repeat(40));
    const b = { ...pinOf("a".repeat(40)), computedAt: new Date(Date.now() + 999_999).toISOString() };
    assert.equal(pinSignature(a), pinSignature(b), "computedAt must not affect the signature");
  });

  test("a different build gets a different signature", () => {
    assert.notEqual(pinSignature(pinOf("a".repeat(40))), pinSignature(pinOf("b".repeat(40))));
  });

  test("diffBuildPin names EVERY differing field, not just the first", () => {
    const recorded = pinOf("a".repeat(40));
    const current = { ...pinOf("b".repeat(40), "different-tool-hash") };
    const diff = diffBuildPin(recorded, current);
    const fields = diff.map((d: any) => d.field);
    assert.ok(fields.includes("headSha"));
    assert.ok(fields.includes("distRevision.revision"));
    assert.ok(fields.includes("frozenSurface.tool_definition_sha256"));
  });

  test("checkBuildPin: first run pins, a matching run passes, a moved build is an error that never re-pins", () => {
    const pin = pinOf("a".repeat(40));
    assert.deepEqual(checkBuildPin(null, pin), { ok: true, write: true, diff: [] });
    assert.deepEqual(checkBuildPin(pin, pin), { ok: true, write: false, diff: [] });
    const moved = pinOf("b".repeat(40));
    const verdict = checkBuildPin(pin, moved);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.write, false, "a mismatch is never silently re-pinned");
    assert.ok(verdict.diff.length > 0);
  });
});

// ─── the full CLI: pin written on first run, honoured on resume, refused on drift ──
//
// Exercises `run-arms-v3.mjs` itself, not just the exported functions —
// against the REAL repository's `dist`/HEAD (this is what `npm run build`
// before the test run makes trustworthy), with an EMPTY scenario list so the
// loop that would spawn `claude` never runs. This is the same
// `--preflight-only` dry run the runner's own usage line documents.
//
// UNLIKE every other describe block here, this one depends on ambient state
// this file does not control: a clean, committed, freshly built checkout. A
// developer running the suite mid-edit has neither, and that is not a
// regression in the preflight — it is the preflight correctly refusing a
// dirty worktree, which is precisely what `preflightBuild` is FOR. So each
// test checks the real repository's own preflight first and skips with the
// reason when it is not clean, the same way the hybrid-arm test above skips
// when Ollama is not reachable: an environmental precondition, not a pass.

describe("the runner's own CLI: build-pin.json across a synthetic archive", () => {
  function spawnRunner(outDir: string, args: string[] = []) {
    return spawnSync(process.execPath, [RUNNER, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, CODE_ROI_OUT: outDir },
      timeout: 60_000,
    });
  }

  /** Null when the real checkout is clean and built; otherwise why it is not. */
  async function whyNotReady(): Promise<string | null> {
    const verdict = await preflightBuild();
    return verdict.ok ? null : `real checkout is not clean/built (${verdict.reason}): ${verdict.message}`;
  }

  test("--preflight-only checks and exits without starting an arm or writing a pin", async (t) => {
    const why = await whyNotReady();
    if (why !== null) {
      t.skip(why);
      return;
    }
    await withTempDir(async (dir) => {
      const out = join(dir, "archive");
      await mkdir(out, { recursive: true });
      const r = spawnRunner(out, ["--preflight-only"]);
      assert.equal(r.status, 0, `preflight-only failed:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /preflight ok/);
      assert.match(r.stdout, /would be pinned/, "a dry run must not write the pin");
      await assert.rejects(readFile(join(out, "build-pin.json"), "utf8"), "--preflight-only writes nothing");
    });
  });

  test("first run pins the archive; resume with the same build passes silently", async (t) => {
    const why = await whyNotReady();
    if (why !== null) {
      t.skip(why);
      return;
    }
    await withTempDir(async (dir) => {
      const out = join(dir, "archive");
      await mkdir(out, { recursive: true });
      writeFileSync(join(out, "scenarios.json"), JSON.stringify({ scenarios: [] }));

      const first = spawnRunner(out);
      assert.equal(first.status, 0, `first run failed:\n${first.stdout}\n${first.stderr}`);
      assert.match(first.stdout, / pinned /);
      const pinText = await readFile(join(out, "build-pin.json"), "utf8");
      const pin = JSON.parse(pinText);
      assert.match(pin.headSha, /^[0-9a-f]{40}$/);

      const resumed = spawnRunner(out);
      assert.equal(resumed.status, 0, `resume failed:\n${resumed.stdout}\n${resumed.stderr}`);
      assert.match(resumed.stdout, /matches the archive's pin/);
      assert.equal(await readFile(join(out, "build-pin.json"), "utf8"), pinText, "resume must not rewrite the pin");
    });
  });

  test("resume with a build-pin.json pointing at a different build aborts and names the fields", async (t) => {
    const why = await whyNotReady();
    if (why !== null) {
      t.skip(why);
      return;
    }
    await withTempDir(async (dir) => {
      const out = join(dir, "archive");
      await mkdir(out, { recursive: true });
      writeFileSync(join(out, "scenarios.json"), JSON.stringify({ scenarios: [] }));

      spawnRunner(out); // pins the real archive to the real build
      const before = await readFile(join(out, "build-pin.json"), "utf8");
      const tampered = { ...JSON.parse(before), headSha: "f".repeat(40) };
      await writeFile(join(out, "build-pin.json"), JSON.stringify(tampered, null, 2));

      const r = spawnRunner(out);
      assert.notEqual(r.status, 0, "a moved pin must abort the run");
      assert.match(r.stdout, /build_pin_mismatch/);
      assert.match(r.stdout, /headSha/);
      assert.equal(
        await readFile(join(out, "build-pin.json"), "utf8"),
        JSON.stringify(tampered, null, 2),
        "the mismatched pin is never silently overwritten",
      );
    });
  });
});

// ─── evaluate-v4.mjs: mixed_builds, from synthetic transcript metas ───────

describe("evaluate-v4's mixed_builds report", () => {
  test("armMetaRows reads finished AND aborted metas alike", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "runs", "S01"), { recursive: true });
      await writeFile(
        join(dir, "runs", "S01", "A.meta.json"),
        JSON.stringify({ arm: "A", finished: true, buildPin: "sig-1" }),
      );
      await writeFile(
        join(dir, "runs", "S01", "B.failed-123.meta.json"),
        JSON.stringify({ arm: "B", finished: false, buildPin: "sig-1" }),
      );
      const rows = armMetaRows(join(dir, "runs"));
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r: any) => r.buildPin === "sig-1"));
    });
  });

  test("mixedBuildsReport: no pin recorded yet — reported, not silently ignored", () => {
    const rows = [{ scenario: "S01", file: "A.meta.json", arm: "A", buildPin: "sig-1" }];
    assert.equal(mixedBuildsReport(rows, null).mixed_builds, true);
    assert.equal(mixedBuildsReport([], null).mixed_builds, false, "no transcripts yet is not a mismatch");
  });

  test("mixedBuildsReport: every row matching the pin — clean", () => {
    const rows = [
      { scenario: "S01", file: "A.meta.json", arm: "A", buildPin: "sig-1" },
      { scenario: "S02", file: "B.meta.json", arm: "B", buildPin: "sig-1" },
    ];
    const report = mixedBuildsReport(rows, "sig-1");
    assert.equal(report.mixed_builds, false);
    assert.deepEqual(report.offending, []);
  });

  test("mixedBuildsReport: a helping run under a different build is named, not averaged in", () => {
    const rows = [
      { scenario: "S01", file: "A.meta.json", arm: "A", buildPin: "sig-1" },
      { scenario: "S17", file: "A.meta.json", arm: "A", buildPin: "sig-2" },
      { scenario: "S17", file: "B.meta.json", arm: "B", buildPin: null },
    ];
    const report = mixedBuildsReport(rows, "sig-1");
    assert.equal(report.mixed_builds, true);
    assert.deepEqual(
      report.offending.map((o: { scenario: string }) => o.scenario).sort(),
      ["S17", "S17"],
    );
  });
});

// ─── frozenSurfaceHashesFromDist — the dynamic import path itself ─────────

describe("frozenSurfaceHashesFromDist reads the BUILT module, not source", () => {
  test("the frozen hashes match what the registration's own formula computes", async () => {
    await withTempDir(async (dir) => {
      const root = await syntheticCheckout(dir);
      const distDir = await buildFakeDist(root);
      const hashes = await frozenSurfaceHashesFromDist(distDir);
      const expected = matchingRegistration().arms.frozen_surface;
      assert.deepEqual(hashes, expected);
    });
  });
});
