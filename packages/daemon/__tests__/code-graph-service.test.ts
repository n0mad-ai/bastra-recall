import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIgnored, startCodeAwareness } from "../src/code-graph/service.js";
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
    const handle = await startCodeAwareness();
    assert.deepEqual(handle.repos, []);
    assert.doesNotThrow(() => handle.stop());
  });

  it("stop() is idempotent", async () => {
    const handle = await startCodeAwareness();
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
      const handle = await startCodeAwareness();
      handle.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
