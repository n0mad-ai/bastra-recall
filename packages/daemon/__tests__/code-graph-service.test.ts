import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detailCode, isIgnored, startCodeAwareness } from "../src/code-graph/service.js";
import { findAffectedFilesEvent } from "../src/code-graph/tool-telemetry.js";
import { CodeGraphCache } from "../src/code-graph/cache.js";
import { GRAPH_DIR_NAME } from "../src/code-graph/reader.js";

/**
 * The wiring around the refresher (#581): what triggers a refresh, what must
 * never trigger one, and the rule that a daemon boots even when code awareness
 * cannot start.
 */

describe("code awareness service: what the watcher ignores", () => {
  it("ignores the graph directory — the build writes there", () => {
    // Watching it would make every build trigger the next one.
    assert.equal(isIgnored(`${GRAPH_DIR_NAME}/graph.json`), true);
    assert.equal(isIgnored(`${GRAPH_DIR_NAME}/.bastra-manifest.json`), true);
    assert.equal(isIgnored(`${GRAPH_DIR_NAME}/cache/x`), true);
  });

  it("ignores git internals, dependencies and build output", () => {
    assert.equal(isIgnored(".git/HEAD"), true);
    assert.equal(isIgnored("node_modules/foo/index.js"), true);
    assert.equal(isIgnored("packages/daemon/dist/cli.js"), true);
    assert.equal(isIgnored("build/output.o"), true);
  });

  it("ignores dot-directories at any depth", () => {
    assert.equal(isIgnored(".obsidian/workspace.json"), true);
    assert.equal(isIgnored("packages/.cache/thing"), true);
  });

  it("does NOT ignore ordinary source files", () => {
    assert.equal(isIgnored("packages/core/src/save.ts"), false);
    assert.equal(isIgnored("README.md"), false);
    // A dotfile is not a dot-directory: .gitignore changing is a real change.
    assert.equal(isIgnored(".gitignore"), false);
  });

  it("handles both separator styles", () => {
    assert.equal(isIgnored("packages\\daemon\\dist\\cli.js"), true);
    assert.equal(isIgnored("packages\\core\\src\\save.ts"), false);
  });
});

describe("code awareness service: starting", () => {
  it("does nothing when no repository is enabled", async () => {
    // The default state. Recall never indexes a directory nobody asked about,
    // so with an empty list there is no watcher, no preload and no refresh.
    const handle = await startCodeAwareness(undefined, async () => []);
    assert.deepEqual(handle.repos, []);
    assert.doesNotThrow(() => handle.stop());
  });

  it("stop() is idempotent", async () => {
    const handle = await startCodeAwareness(undefined, async () => []);
    handle.stop();
    assert.doesNotThrow(() => handle.stop());
  });

  it("does not throw when a graph directory is unreadable", async () => {
    // A corrupt or missing graph must not keep the daemon from booting: code
    // awareness is optional at runtime (C-090 is a release obligation).
    const dir = await mkdtemp(join(tmpdir(), "bastra-service-"));
    try {
      await mkdir(join(dir, GRAPH_DIR_NAME), { recursive: true });
      await writeFile(join(dir, GRAPH_DIR_NAME, "graph.json"), "{not json", "utf8");
      const handle = await startCodeAwareness(undefined, async () => [dir]);
      handle.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("what a refresh row is allowed to say (#582 review)", () => {
  /**
   * The event type promised "never a path or a command line" from the day it
   * was written; the observer forwarded `RefreshEvent.detail` verbatim, which
   * is Graphify's stderr and the absolute path of the binary, the lock and the
   * checkout. The classifier is what makes the promise true, and these are the
   * strings the build and refresh paths actually assemble.
   */
  const REAL_DETAILS: Array<[string, string]> = [
    ["not enabled", "not_enabled"],
    ["given up", "given_up"],
    ["unsupported-platform: win32", "unsupported_platform"],
    ["graphify-missing: /Users/someone/.bastra/bin/graphify", "binary_missing"],
    ["locked: /Users/someone/Projekte/secret-client/.bastra-code", "locked"],
    ["timeout: no result after 300000 ms", "timeout"],
    // A child that survives SIGKILL: the build lock is left in place on
    // purpose (build.ts), and that has to stay distinguishable from an
    // ordinary timeout or "other" — both of which it used to fall into,
    // because the precursor reason (here, a timeout) is folded into the same
    // detail string (P2, #582 review).
    [
      "stuck: no result after 600000 ms: child still running 2000 ms after SIGKILL — build lock left in place until it goes stale",
      "stuck",
    ],
    ["failed: aborted", "aborted"],
    ["failed: killed by SIGKILL", "graphify_killed_sigkill"],
    [
      "failed: exit code 1: thread 'main' panicked at src/lib.rs:42: cannot read /Users/someone/Projekte/secret-client/src/x.ts",
      "graphify_exit_1",
    ],
    ["failed: something nobody anticipated", "other"],
  ];

  it("maps every detail the build path produces to a bounded code", () => {
    for (const [raw, code] of REAL_DETAILS) assert.equal(detailCode(raw), code);
    assert.equal(detailCode(undefined), undefined, "no detail stays no detail");
  });

  it("lets no path fragment and no stderr through, whatever the input", () => {
    const leaky = [
      ...REAL_DETAILS.map(([raw]) => raw),
      "failed: ENOENT: no such file or directory, open '/Users/someone/vault/secret.md'",
      "failed: exit code 2: error TS2345 in /Users/someone/Projekte/client/src/a.ts",
    ];
    for (const raw of leaky) {
      const code = detailCode(raw);
      assert.ok(code !== undefined);
      assert.doesNotMatch(code, /\//, `"${raw}" leaked a path fragment as "${code}"`);
      assert.doesNotMatch(code, /Users|panicked|ENOENT|TS\d/, `"${raw}" leaked stderr as "${code}"`);
      assert.ok(code.length <= 40, `"${code}" is long enough to be carrying text`);
    }
  });

  it("the code-tool row carries counts, enums and a two-segment repo — nothing else", () => {
    // The same check on `code_tool_call`, which was reviewed alongside it.
    // `tool-telemetry.ts` builds it, and every field here is a shape.
    const row = findAffectedFilesEvent(
      new CodeGraphCache(undefined, () => false),
      { file: "packages/daemon/src/secret-feature.ts", repo: "/Users/someone/Projekte/client" },
      {
        status: "unavailable",
        hits: [],
        files: [],
        truncated: false,
        took_ms: 1,
        note: "no code graph yet for /Users/someone/Projekte/client — run bastra code index",
      } as never,
      { surface: "mcp" },
    );
    const text = JSON.stringify(row);
    assert.doesNotMatch(text, /secret-feature/, "the changed file is not in the row");
    assert.doesNotMatch(text, /\/Users\//, "no absolute path is in the row");
    assert.doesNotMatch(text, /run bastra code index/, "the agent-facing note is not in the row");
    assert.equal(row.repo, "Projekte/client");
  });
});
